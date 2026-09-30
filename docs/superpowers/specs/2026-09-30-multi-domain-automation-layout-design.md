# Multi-Domain Automation Layout

**Date:** 2026-09-30
**Status:** Approved design, pending implementation plan

## Purpose

This repository currently holds one automation (the short-form video pipeline) with
n8n treated as a subdirectory of it. A second, unrelated automation is coming:
payment-gated WhatsApp group access. It takes public payment webhooks and handles
money, which is a different risk class from the video pipeline.

The goal is a structure where adding an automation is a known shape rather than a
judgment call about where files go, and where an internet-facing automation cannot
reach the video pipeline's shell access or credentials.

This spec covers **structure and runtime only**. No WhatsApp automation logic.

## Constraints

- **Server is 4 GB RAM and cannot be scaled** for now.
- n8n Community Edition. Folders are free with registration; team Projects are paid
  and, in any case, do not sandbox `executeCommand` or scope credentials.
- The video pipeline works today and must keep working.
- Prod already runs Traefik with automatic TLS and subdomain routing.
- Tailscale (`tailscaled`) is already running on the host.

## Measured evidence

Container memory, idle, measured via `docker stats` on the running stack:

| Container | Measured (idle) |
|---|---|
| n8n | 256 MB |
| publishing-db (Postgres) | 20 MB |
| provider-uploader | 14 MB |
| task-runners | 4.4 MB |
| **Total** | **~294 MB** |

These are idle figures with no executions and a nearly-empty database; both will
grow under load. ffmpeg is unmeasured and remains the largest consumer. Measured on
Docker Desktop under WSL, not on the target server, though the images are identical.

Consequence: a second stock n8n instance costs roughly 250 MB. The two-instance
stack idles near 550 MB, leaving about 3 GB for OS, Docker, and render headroom on a
4 GB box. Instance count is not the memory risk; unbounded execution concurrency and
ffmpeg are.

Path coupling, measured by grep across the repo:

| Coupling | Count |
|---|---|
| `require('../n8n/...')` in tests | 20 |
| String literals `'n8n/...'` in tests | 21 |
| Test files affected | 15 of 17 |
| References in `scripts/` | 1 |
| **Host-side paths inside workflow JSON** | **0** |

Every path inside workflow JSON is container-internal (`/data/jobs`, `/files`),
supplied by compose mounts. All 42 host-side references live in test and script
files, and all are exercised by the 213-test suite.

## Decisions

### D1: Two n8n instances, split by trust level

Not one instance with folders, and not one instance per automation.

- **`heavy`** — trusted, self-triggered work. Keeps `executeCommand` (WF6 needs
  yt-dlp, WF8c needs ffmpeg), the custom image, task runners, and the `/data` and
  `/files` mounts.
- **`public`** — untrusted, webhook-facing work. Stock `n8nio/n8n`, default node
  blocklist left intact so `executeCommand` and `localFileTrigger` stay blocked. No
  render mounts, no task runners.

Rationale: within one n8n instance there is no mechanism on Community Edition to
separate two domains' credentials or to deny one workflow the shell node that
another needs. Two instances is the only available boundary. Splitting by trust
level rather than per automation means future webhook-facing automations have an
obvious home without adding instances.

On a 4 GB server this also bounds failure: with `mem_limit` per container, a runaway
render dies inside `heavy` instead of leaving the kernel OOM killer to choose a
victim that might be the payment webhook.

### D2: `hosts/` answers "where does this run", `domains/` answers "what does this do"

Today `n8n/` holds both the Dockerfile and the workflow JSON. Separating the runtime
from the automation content is what makes a new host and a new domain independently
cheap.

### D3: One Postgres server, two databases, two roles

Not two Postgres containers, and not two schemas in one database.

Schemas share a database, so separation depends on maintaining correct `GRANT`s and
a mistake is silent. Two databases with a role each means `public`'s connection
string cannot address the video database at all. The isolation is structural rather
than a permissions detail. Measured cost is nil: 20 MB was the whole server, not per
database.

### D4: Separate `N8N_ENCRYPTION_KEY` per instance

This is what makes credential separation real rather than nominal. Credentials are
encrypted at rest per instance, so `public` cannot decrypt a video-pipeline
credential even with access to the other volume.

### D5: `heavy`'s editor UI is not reachable from the internet

Prod currently routes n8n through Traefik on a public subdomain. That UI can create
an Execute Command node, which is shell in a container holding every credential,
with n8n's login as the only barrier.

`heavy` binds to the Tailscale interface with no Traefik router. `public` is the only
instance Traefik exposes, and it is the only one that needs to receive webhooks.

### D6: Big-bang migration, single commit

Everything moves at once rather than two layouts coexisting. Justified by the path
sweep: workflow JSON needs no changes, and the 42 host-side references are all
covered by the test suite, so a missed path fails `npm test` rather than surfacing at
render time.

### D7: The new compose files serve both local and prod

`compose.prod.yaml` currently defines only `traefik` and `n8n`. The publishing queue,
task runners, and provider-uploader have never been deployed there, which means the
Postiz work in PR #1 cannot run in prod as it stands.

Since this work rewrites the compose files anyway, `hosts/heavy/compose.yaml` and
`hosts/public/compose.yaml` become the single service definitions for both
environments. Environment differences (hostnames, TLS, exposed ports, log level) come
from env files, not from a duplicate set of service definitions.

`hosts/compose.local.yaml` is not a competing definition. It is a thin dev
composition that includes the two host files and adds development-only extras —
`jaeger` for tracing, host port bindings on `127.0.0.1`. Prod includes the same two
host files plus `hosts/shared/traefik/`. Each service is defined exactly once.

This closes the prod gap as a side effect instead of requiring a second migration.

### D8: The directory is renamed, the GitHub repo is not

The working directory becomes `automations/`. The remote stays `short-videos`, since
renaming it changes the remote URL and invalidates existing clones. Revisit
separately.

## Target layout

```
automations/                       # repo root (was short-videos/)
├── hosts/                         # runtime: how n8n is served
│   ├── heavy/                     # trusted, shell + ffmpeg
│   │   ├── compose.yaml
│   │   ├── Dockerfile             # from n8n/Dockerfile
│   │   └── runners/               # from n8n/runners/
│   ├── public/                    # untrusted, webhook-facing
│   │   └── compose.yaml           # stock n8nio/n8n, no build
│   ├── shared/
│   │   ├── postgres/              # one server, one DB per domain
│   │   └── traefik/               # from compose.prod.yaml
│   └── compose.local.yaml         # dev composition
│
├── domains/                       # one directory per automation
│   ├── short-videos/
│   │   ├── workflows/             # 01-…14-*.json, contents unchanged
│   │   ├── workflow-code/
│   │   ├── postgres/              # migrations + queries
│   │   ├── tests/
│   │   ├── docs/
│   │   ├── services/              # sidecars this domain needs
│   │   │   ├── provider-uploader/ # from n8n/provider-uploader/
│   │   │   └── transcript/        # from lamba-function/ (sic) + local server
│   │   ├── scratch/               # throwaway experiments, wired to nothing
│   │   └── domain.json            # host, database, mounts
│   └── whatsapp-access/
│       ├── domain.json
│       └── (otherwise empty)
│
├── shared/
│   └── workflow-code/             # only genuinely cross-domain code
│
└── package.json                   # test glob spans domains/*/tests/
```

There is no top-level `services/`. Both sidecars serve only the video pipeline, so
they live in the domain, and a domain then carries everything it needs. A service that
genuinely becomes cross-domain can be promoted later, on the same reasoning that keeps
`shared/` nearly empty.

`domain.json` is the seam: a small manifest naming each domain's host, database, and
mounts. It starts as documentation. No tooling reads it until that earns its place.

`shared/` starts nearly empty deliberately. `fair-share.js` looks genuinely reusable;
most things will not be. Promoting code there speculatively is how a shared directory
becomes a junk drawer.

## Runtime configuration

Both hosts get, from the start:

- `mem_limit` per container, so failures are contained and predictable. Starting
  values, derived from the measured idle figures with headroom for load, to be
  confirmed against real usage on the server:

  | Container | Measured idle | `mem_limit` |
  |---|---|---|
  | `heavy` n8n | 256 MB | 1 GB |
  | `public` n8n | ~250 MB expected | 512 MB |
  | postgres | 20 MB | 512 MB |
  | task-runners | 4.4 MB | 512 MB |
  | provider-uploader | 14 MB | 256 MB |

  Total ceiling is under 3 GB, leaving room for the OS, Docker, and ffmpeg. ffmpeg
  runs inside `heavy`, so its 1 GB ceiling is the one most likely to need raising
  after a real render is measured.

- `N8N_CONCURRENCY_PRODUCTION_LIMIT` set on both hosts. It is currently unlimited,
  which is the likeliest cause of an OOM on a 4 GB server. `heavy` starts at 2, since
  concurrent ffmpeg renders are the specific thing to avoid. `public` starts at 5,
  since webhook handling is cheap but should not be unbounded.
- `N8N_DEFAULT_BINARY_DATA_MODE=filesystem` retained. Drop
  `N8N_AVAILABLE_BINARY_DATA_MODES`, which n8n 2.x reports as deprecated and no
  longer needed.

`heavy` keeps `NODES_EXCLUDE=["n8n-nodes-base.localFileTrigger"]`. `public` leaves
`NODES_EXCLUDE` unset so n8n's default blocklist applies, which blocks both
`executeCommand` and `localFileTrigger`.

## What does not change

- **Workflow JSON contents.** Container mount points stay `/data` and `/files`, so
  `/data/jobs/...` inside WF6 and WF8c keeps resolving.
- **Docker volumes.** `n8n_data` and `publishing_db_data` keep their names, so
  `heavy` keeps its workflows, credentials, and execution history. No re-import and
  no credential re-entry.
- **SQL migration and query contents.** Only their paths move.

## Migration sequence

1. `git mv` rather than copy, so `git log --follow` and `git blame` survive the move.
2. Move in dependency order: `workflow-code/`, then `postgres/`, `workflows/`, then
   tests split by domain, then `docs/`.
3. Update the 42 host-side references: 20 requires, 21 string literals, 1 in
   `scripts/`.
4. `package.json` test script becomes `node --test "domains/*/tests/*.test.js"`.
   Verified working on Node 26.9.0: a quoted glob collects across domain directories.
5. Compose: update `build.context` and the host side of each volume. The container
   side stays identical.
6. Create `hosts/public/compose.yaml` and `domains/whatsapp-access/` as scaffolding.

## The root Python files

All of them move. What each one actually is decides where it goes.

| File | What it is | Destination |
|---|---|---|
| `local-transcript-server.py` | Dev HTTP wrapper serving WF-04's transcript contract, wraps `handler.py` | `domains/short-videos/services/transcript/local-server.py` |
| `lamba-function/handler.py` | The real Lambda: YouTube transcript fetch with `x-api-key` auth | `domains/short-videos/services/transcript/handler.py` |
| `lamba-function/build.sh` | Packages `function.zip` | same directory, with the change below |
| `lamba-function/requirements.txt` | Dep list | same directory, merged with the root one |
| root `requirements.txt` | Only `youtube-transcript-api` | Folded into the service's own |
| `transcript.py` | 6-line experiment, hardcoded video id `Pzfle5WWaTo` | `domains/short-videos/scratch/` |
| `transcript.txt` | 262 KB of output from that script | **Deleted.** Regenerable, referenced by nothing; git history retains it |
| `lamba-function/` vendored deps | 286 files, 6.9 MB of `pip install -t .` output, plus the built `function.zip` | **No longer tracked.** See below |

The directory misspelling is fixed on the way through: `lamba-function` becomes
`services/transcript`.

### The Lambda build becomes reproducible

`lamba-function/` holds 289 tracked files totalling 6.9 MB, of which three are
first-party: `handler.py`, `build.sh`, `requirements.txt`. The rest is committed
`pip install -t .` output — `certifi`, `urllib3`, `requests`, `defusedxml`, `idna`,
`charset_normalizer`, a compiled `.so` — alongside `function.zip`, the built artifact,
also committed.

`build.sh` currently zips those vendored directories directly, so the committed
dependencies *are* the build input. That makes the deps load-bearing and the build
unreproducible from `requirements.txt`.

The change: `build.sh` gains a `pip install -r requirements.txt -t .` step before
zipping, the vendored directories and `function.zip` are added to `.gitignore`, and
they stop being tracked. The repo loses 286 files and 6.9 MB, and the zip becomes
reproducible from the dep list.

This is the one part of the migration that changes behavior rather than only moving
files, so it carries its own verification gate below.

## Verification

| Gate | What it proves |
|---|---|
| `npm test` → 213 pass | All 42 path references resolve; no workflow-code regression |
| JSON parse over every workflow file | Nothing corrupted in the move |
| `docker compose config` on both hosts | Compose resolves; mounts and contexts valid |
| Both instances boot, `/healthz` ok | Separate encryption keys work |
| `public` cannot load `executeCommand` | The trust boundary is real, not intended |
| `public`'s DB role cannot read the video database | D3 holds |
| One real clip through WF6 + WF8c | `/data` survived; the only gate tests cannot fake |
| `build.sh` produces a working `function.zip` from a clean checkout | The Lambda build is genuinely reproducible from `requirements.txt`, not from the deps that were deleted |
| `local-server.py` answers a transcript request | The moved service still resolves `handler.py` after its `sys.path` insert changed |
| `git log --follow` traces a moved file | History preserved |

The `executeCommand` check requires an authed call to the node types endpoint;
`/types/nodes.json` returns `{"status":"error","message":"Unauthorized"}` without
credentials.

The last two gates in the table are the ones that would actually catch a broken
migration.

## Rollback

A single commit on a feature branch. `git revert` restores the layout. Docker volumes
are never touched, so nothing inside n8n needs restoring. This is the main reason for
one commit despite the size.

## Out of scope

- **WhatsApp automation logic** — payment verification, invite mechanics, single-use
  enforcement. `whatsapp-access/` gets a directory and a `domain.json`, nothing more.
- **`.venv/`** — a local virtualenv, not tracked content. Stays at the repo root.
- **The Facebook release-URL gap** in `postiz-publishing.js:124`, tracked in PR #1.
  It needs a live Meta test to establish the real Reels URL shape.
- **Renaming the GitHub repository.**
- **The absent `jaeger` container**, which is why prod logs an OTLP connection
  failure. Unrelated to layout.

## Open questions

1. Does the WhatsApp domain need its own Postgres database from day one, or does it
   start stateless? D3 provisions one either way; this only affects whether the
   migration runner is wired up for it now.
~~2. Is the Lambda deployment path still used at all?~~ **Resolved 2026-09-30: keep
both.** The Lambda packaging path and the local server both stay, so `build.sh` is
made reproducible rather than deleted. They share `handler.py` as the single
implementation — `build.sh` packages it for Lambda, `local-server.py` wraps it over
HTTP for local WF-04 development. Neither is a fork of the other, which is what makes
keeping both cheap.
