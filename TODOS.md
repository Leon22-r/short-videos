# TODOS

Organized by component, then priority (P0 highest). Completed items move to the
bottom.

## hosts/ — trust boundary

### Close heavy's published-host-port path from public-net

**Priority:** P1

`heavy` publishes `${HEAVY_BIND_ADDRESS}:${HEAVY_PORT}:5678`. Locally that is
`127.0.0.1` and no container can reach it. In production it is the server's
Tailscale address so the editor is reachable over the tailnet — and a port
published on a host IP is reachable from any container that can route to that
IP, `public-n8n` included. The Docker network partition stops `public-n8n`
resolving `n8n`; it does not stop it dialling the host.

What that reaches is heavy's `/webhook/*` endpoints, which carry no
authentication unless each webhook node is configured with a credential. The
editor still requires login.

Structural fix: stop publishing the port and front it with a Tailscale sidecar
inside the Docker network, or block container-to-host traffic to the tailnet
address with a `DOCKER-USER` iptables rule.

Interim: keep `HEAVY_BIND_ADDRESS=127.0.0.1` and use an SSH tunnel, or put a
header credential on every webhook node in `heavy`.

Not reproduced locally — WSL does not route the host IP from containers — so it
is derived from how Docker publishes ports rather than measured. Documented in
`hosts/README.md`. Found by the security specialist during `/ship` review of
PR #2.

### Replace the Traefik Docker socket mount with a socket proxy

**Priority:** P2

`/var/run/docker.sock:/var/run/docker.sock:ro` is mounted into Traefik, which
sits on `public-net`. `:ro` applies to the socket *file*, not the API behind it:
anything that can make Traefik issue requests there can `POST /containers/create`
with a host bind mount and obtain host root, and can read every container's
environment via inspect. Traefik is the only internet-facing process in the
stack.

Accepted for now only because `--api=false` leaves no request path into it from
`public-net`. Fix: `tecnativa/docker-socket-proxy` with `CONTAINERS=1` and
everything else `0`, and `--providers.docker.endpoint=tcp://socket-proxy:2375`.

### Separate a Postgres admin role from the application role

**Priority:** P3

`short_videos` is the cluster superuser `initdb` created on the live volume, so
it bypasses `REVOKE CONNECT` and can still reach `whatsapp_access`. The
direction that matters — the untrusted role reaching the video database — is
closed and verified. The mirrored `REVOKE` in `bootstrap-databases.sh` only
takes effect once that role is demoted.

Blocked on there being no second superuser: demoting `short_videos` today would
lock administrative access out of the cluster permanently. Needs a deliberate
migration that creates a dedicated superuser first.

The same role is also reachable from `public-net` via `scram`, so a compromised
`public-n8n` could attempt its password with no rate limit, and a superuser can
run `COPY ... PROGRAM`. A custom `pg_hba.conf` rejecting the superuser from
public-net's subnet would bound that independently of the demotion.

## hosts/ — structure

### Move per-domain migration services out of shared/postgres

**Priority:** P3

`hosts/shared/postgres/compose.yaml` hardcodes `short-videos-migrations` and
`whatsapp-access-migrations` by name, plus per-domain env vars and mount paths,
so adding a third automation means editing a file called "shared". That is the
entanglement the restructure exists to remove.

Fix: per-domain compose fragments (`domains/<name>/compose.migrations.yaml`)
included from `hosts/compose.*.yaml`, leaving only Postgres and a generic
bootstrap in shared. Natural moment to do it is when the third domain arrives.

### Make domain.json load-bearing or delete it

**Priority:** P4

`domains/*/domain.json` states each domain's host, database and mounts, but
nothing reads it except a shape assertion in `tests/repo-layout.test.js`. It
duplicates facts already in the compose files and can drift from them silently.

Either add a test that cross-checks `host` against which host compose references
the domain's paths, `database` against the bootstrap, and `mounts` against the
volumes — or drop the manifests and rely on the directory layout plus
`hosts/README.md`.

## domains/short-videos — pipeline

### Import the workflows and run one real clip through WF6 + WF8c

**Priority:** P1

The heavy n8n instance holds **zero** workflows and zero credentials. The 16
workflow JSON files exist only in this repo and have never been imported, so the
render path has never run end to end against any layout, let alone this one.

Needs: import the workflows, bind credentials, Supabase connection details,
and runtime-only Drive folder IDs, then push one video through the yt-dlp download
(WF6) and the FFmpeg render (WF8c).

This was the one verification gate in the multi-domain plan that could not be
run. Pre-existing work, not caused by the restructure — but it is the only thing
that would catch a render-time path mistake, and 0 host-side paths appear in the
workflow JSON, so a miss fails `npm test` rather than failing at render time.

### Fix the Facebook release-URL gap

**Priority:** P3

`domains/short-videos/workflow-code/postiz-publishing.js:124` — needs a live
Meta test to confirm the release URL shape. Documented in the Postiz work,
carried forward.

### Tune execution retention per host

**Priority:** P4

Both instances share `EXECUTIONS_DATA_MAX_AGE=336` (14 days) and
`EXECUTIONS_DATA_PRUNE_MAX_COUNT=10000`. On `heavy`,
`N8N_DEFAULT_BINARY_DATA_MODE=filesystem` means render binaries live in the
volume until their executions are pruned, so hundreds-of-MB artifacts can
accumulate for two weeks. On `public`, retained webhook payloads grow its
volume. Consider ~72 h for both, and
`EXECUTIONS_DATA_SAVE_ON_SUCCESS=none` for the render and upload workflows.

### Delete or rename scratch/transcript.py

**Priority:** P4

`domains/short-videos/scratch/transcript.py` is a 6-line throwaway with a
hardcoded video ID that writes `transcript.txt` into the working directory. It
was moved rather than deleted, while `tests/repo-layout.test.js` asserts the
root `transcript.py` and `transcript.txt` must not exist. The real transcript
code lives in `services/transcript/`. Either delete it or rename it to say what
it is.

## tooling

### Speed up the provider-uploader healthcheck

**Priority:** P4

`domains/short-videos/services/provider-uploader/Dockerfile` sets
`HEALTHCHECK --interval=30s`, and heavy's n8n waits on
`condition: service_healthy`. Docker runs the first probe only after a full
interval, so the whole heavy chain is delayed roughly 30s on every `up` even
though the server is ready in about a second. Lower the interval, add
`start_interval`, or depend on `service_started` since n8n only needs the
uploader at workflow run time.

### Cover the build.sh in-zip self-check

**Priority:** P4

`build.sh` asserts `handler.py` and `youtube_transcript_api/` are present in
`function.zip`, but nothing tests that the assertion fires when they are not.
Needs network access to run `pip`, so it is an integration test rather than a
unit test.

## Deferred items (Supabase pipeline store migration)

These are named so they are not mistaken for oversights:

- **Moving media off Google Drive** (spec D8, out of scope). The 7 or 8 remaining
  `googleDrive` nodes — 8 today, 7 if Task 13 removed the transcript-stash node
  — and the unresolved `public_video_url` fetchability question for TikTok,
  Instagram and Facebook.
- **Publishing the OAuth consent screen** (spec D8, out of scope). A console
  setting, not a code change, and the thing that actually addresses the stated
  motivation. Do it immediately in Google Cloud Console.
- **Fair-share as SQL window functions** (spec Section 2). The `pickFairBySource` /
  `pickFairByGroup` Code nodes stay, with their existing tests.
- **Authentication for the review UI** (spec D5). The tailnet is the authentication.
- **`Ssemble_Jobs`** (spec Section 1). Dead tab from the Sheets era, never created
  in Postgres.

## Completed

### Split the repo into hosts/ and domains/

**Completed:** PR #2 (2026-10-07)

Two n8n instances by trust level, one Postgres with a database and role per
domain, split Docker networks, reproducible Lambda build, 213 → 251 tests.
