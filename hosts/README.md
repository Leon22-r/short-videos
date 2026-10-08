# Hosts

Two n8n instances, split by trust level. n8n Community Edition has no
credential scoping and no per-workflow node denial, so two instances are the
only boundary available.

| Host | Image | Shell access | Credentials | Reachable from |
|---|---|---|---|---|
| `heavy` | custom, with ffmpeg + yt-dlp | `executeCommand` enabled | every pipeline credential | Tailscale only, no Traefik router |
| `public` | stock `n8nio/n8n` | default blocklist intact | its own, scoped to one domain | the internet, via Traefik |

`heavy` runs the short-videos pipeline: self-triggered work that needs a shell
(yt-dlp in WF6, ffmpeg in WF8c). Because `executeCommand` runs arbitrary shell in
a container that holds every credential, it is single-tenant and its editor must
not be reachable from the internet. `public` serves untrusted webhooks and has no
route to `heavy`.

## Networks

- `heavy-net`: `n8n`, `task-runners`, `provider-uploader`, `postgres`
- `public-net`: `public-n8n`, `postgres`, `traefik`

`postgres` is on both, because it is the one resource the two trust levels
share. The boundary there is a separate database and role per domain plus a
per-role connection limit, not reachability.

Nothing else crosses. In particular `public-n8n` cannot resolve `n8n`, which
matters because the heavy task-runner broker listens on all interfaces inside
its container: a workflow that could reach `http://n8n:5679` with the broker
token would execute arbitrary code inside the credential-holding instance.
`N8N_RUNNERS_AUTH_TOKEN` is therefore required with no default.

## Files

```
hosts/
  compose.local.yaml      # name: n8n, includes shared/postgres + heavy + public + review (+ jaeger)
  compose.prod.yaml       # name: n8n, includes shared/postgres + shared/traefik + heavy + review
  .env.example            # copy to hosts/.env, which is never committed
  heavy/                  # Dockerfile, runners/, compose.yaml
  public/                 # compose.yaml
  review/                 # tailnet-private review UI (PostgREST-backed, zero dependencies)
  shared/postgres/        # one server, one database and role per domain
  shared/traefik/         # public ingress
```

An included file's relative paths resolve against **that file's own directory**,
not against the composition including it — hence `../../domains/...` inside
`heavy/`, and `../../../domains/...` inside `shared/postgres/`.

## The encryption key, and how not to lose it

Each instance encrypts stored credentials at rest with its own
`N8N_ENCRYPTION_KEY`. `heavy` **sets none**: its key was generated on first boot
and lives inside the `n8n_n8n_data` volume at `/home/node/.n8n/config`. Pinning
any value in compose would make every stored credential undecryptable, and there
is no recovery — the credentials would have to be re-entered by hand.

Before migrating the volume, moving to another machine, or rebuilding from
scratch, read the key out and store it somewhere safe:

```bash
docker compose -f hosts/compose.local.yaml exec n8n sh -c 'cat /home/node/.n8n/config'
```

`public` is the opposite case: it has no credentials to lose, so it pins
`PUBLIC_N8N_ENCRYPTION_KEY`, required with no default, and must differ from
heavy's.

## Volume names are pinned

Compose derives the project name from the compose file's directory unless told
otherwise, and volumes are named `<project>_<volume>`. Moving these files out of
`n8n/` would therefore have renamed `n8n_n8n_data` to `hosts_n8n_data` — a new,
empty volume, which looks exactly like losing every workflow and credential.

Both compositions pin `name: n8n`. That is still not enough: Compose precedence
is `-p` > `COMPOSE_PROJECT_NAME` > in-file `name:` > directory basename, so a
stray environment variable or a direct `docker compose -f hosts/heavy/compose.yaml`
beats it. The volumes that hold real state therefore pin their own resource
names — `n8n_n8n_data` and `n8n_publishing_db_data` — which removes the project
prefix from the question entirely.

## Upgrading an existing deployment

Four one-way steps, in this order. None of them happen on their own, and each
one fails in a way that is slow to diagnose if it is skipped. If you are
deploying onto an empty machine, skip all of it — `docker compose up` is enough.

### 1. Set the four now-required secrets

`hosts/.env.example` ships these commented out, and Compose refuses to start
until each is set:

```
N8N_RUNNERS_AUTH_TOKEN
PUBLISHING_DB_PASSWORD
PUBLIC_N8N_ENCRYPTION_KEY
WHATSAPP_DB_PASSWORD
```

Generate each with `openssl rand -hex 32`. Three of them previously had
committed defaults; the fourth is new. `PUBLIC_N8N_ENCRYPTION_KEY` must differ
from heavy's, which is not set here at all — see *The encryption key* above.

If this step is skipped: `docker compose config` fails with
`required variable <NAME> is missing a value`. Loud, which is the point.

### 2. Rotate the stored Postgres password, while the old stack is still up

`PUBLISHING_DB_PASSWORD` is required with no default, but `POSTGRES_PASSWORD`
only takes effect when the Postgres entrypoint initialises an **empty** data
directory. On a volume initialised earlier, the stored password is whatever it
was created with, so a fresh value in `hosts/.env` starts Postgres happily and
then fails every client authentication.

Do this before stopping the old stack — it needs the old container:

```bash
docker exec -i <old-postgres-container> \
  psql -U short_videos -d short_videos -v ON_ERROR_STOP=1 \
  -c "ALTER ROLE short_videos PASSWORD '<the value from hosts/.env>';"
```

Verify from **another container**, never from inside the Postgres one. This
image's `pg_hba.conf` has `trust` for `local` and `127.0.0.1`, so every password
appears to work from inside and such a test proves nothing:

```bash
docker run --rm --network n8n_heavy-net -e PGPASSWORD='<new>' postgres:16-alpine \
  psql -h postgres -U short_videos -d short_videos -tAc 'select 1'
```

If this step is skipped: Postgres comes up healthy (the healthcheck connects
over `trust`), then `short-videos-migrations` and `postgres-bootstrap` fail
authentication, and because `public-n8n` waits on the bootstrap it never starts.
The failure is loud and nothing is corrupted, but the cause is two layers away
from the symptom.

### 3. Remove the old project's containers, not just stop them

The old stack used the service name `publishing-db`; this one uses `postgres`.
Both bind `127.0.0.1:5433` and both mount `publishing_db_data`. Compose will not
stop the old containers for you — they are orphans to it — so two postmasters
can end up contending for one data directory.

```bash
docker rm -f n8n-n8n-1 n8n-task-runners-1 n8n-provider-uploader-1 \
             n8n-publishing-db-1 n8n-publishing-migrations-1 n8n-jaeger-1
```

Removal, not `stop`: the old containers carry `restart: unless-stopped`, so
Docker starts them again on boot. When they start they also recreate the deleted
`n8n/` directory as root-owned empty bind-mount stubs, which fails
`tests/repo-layout.test.js` and reappears every reboot until the containers are
gone.

The volumes are untouched by this. Confirm before continuing:

```bash
docker volume ls --format '{{.Name}}' | grep -E 'n8n_n8n_data|n8n_publishing_db_data'
```

### 4. Bring the stack up and read the one-shots

```bash
docker compose -f hosts/compose.local.yaml up -d      # or compose.prod.yaml
docker compose -f hosts/compose.local.yaml ps -a
```

All three one-shots must show `Exited (0)`:
`short-videos-migrations`, `postgres-bootstrap`, `whatsapp-access-migrations`.

`postgres-bootstrap` is the one that matters on an existing volume, because
`docker-entrypoint-initdb.d` only runs on an empty data directory and will never
create the `whatsapp_access` role or database again. Its log should read:

```
bootstrap: ensuring role whatsapp_access
ALTER ROLE
bootstrap: ensuring database whatsapp_access
bootstrap: fencing both databases
REVOKE / GRANT / REVOKE / GRANT
bootstrap: done
```

On a first run you also see `CREATE ROLE` and `CREATE DATABASE`; on every run
after that their absence is correct, not a failure. Every statement is
idempotent, so the one-shot runs again on each `up`.

Then confirm the volume was reused rather than silently replaced by an empty one
— this is the failure that looks like total data loss:

```bash
docker compose -f hosts/compose.local.yaml exec n8n node -e "
const {DatabaseSync} = require('node:sqlite');
const db = new DatabaseSync('/home/node/.n8n/database.sqlite', {readOnly: true});
for (const t of ['migrations','user','workflow_entity','credentials_entity'])
  console.log(t, db.prepare('SELECT COUNT(*) c FROM '+t).get().c);
"
```

A migration count in the hundreds and a non-zero `user` count mean the existing
volume is attached. All zeros across every table mean a new empty volume was
created, and you should stop and check the pinned volume names before doing
anything else.

## What the two-host split does and does not fence

Verified against a live stack:

- `public-n8n` cannot resolve `n8n` at all, so neither the editor on 5678 nor
  the task-runner broker on 5679 is reachable from it. `postgres` resolves from
  both, which is the one intended bridge.
- `whatsapp_access` connecting to `short_videos` fails with
  `permission denied for database "short_videos"`, and is capped at 20
  connections.
- **The published host port is a way around the partition in production.** Not
  fixed in this branch; it is the known gap to close next.
  heavy publishes `${HEAVY_BIND_ADDRESS}:${HEAVY_PORT}:5678`. Locally that is
  `127.0.0.1`, which no container can reach. In production you set it to the
  host's Tailscale address so the editor is reachable over the tailnet — and a
  port published on a host IP is reachable from any container that can route to
  that IP, including `public-n8n`. The network partition stops `public-n8n`
  resolving `n8n`; it does not stop it dialling the host.
  What that reaches is heavy's `/webhook/*` endpoints, which carry no
  authentication unless each webhook node is configured with a credential. The
  editor itself still requires login.
  Until this is closed, either keep `HEAVY_BIND_ADDRESS=127.0.0.1` and reach the
  editor by SSH tunnel, or put a header credential on every webhook node in
  heavy. The structural fix is to stop publishing the port and front it with a
  Tailscale sidecar inside the Docker network, or to block container-to-host
  traffic to the tailnet address with a DOCKER-USER iptables rule.
  (Not reproduced locally: WSL does not route the host IP from containers, so
  this is derived from how Docker publishes ports, not measured here.)

- The reverse direction is **not** fenced. `short_videos` is the cluster
  superuser that `initdb` created on this volume, and superusers bypass
  `REVOKE CONNECT`, so it can still connect to `whatsapp_access`. The mirrored
  `REVOKE` is there for the day that role is demoted; it has no effect today.
  This is the lesser direction — the trusted host reaching the untrusted
  database — but it is not a boundary, and should not be described as one.

## Supabase and PostgREST Configuration

When deploying the Review UI or connecting workflows to managed Supabase:

1. **Exposed Schemas in PostgREST:** PostgREST only exposes schemas configured in its search path.
   In the Supabase dashboard, go to **Project Settings** → **API** → **Data API Settings** and add `short_videos`
   to **Exposed schemas** (or run in SQL Editor:
   `ALTER ROLE authenticator SET pgrst.db_schemas = 'public, storage, graphql_public, short_videos'; NOTIFY pgrst, 'reload config';`).
   Without this setting, queries to `/rest/v1/...` for pipeline tables return 404.
2. **Schema and Table Grants:** Migration `011-postgrest-grants.sql` automatically grants `USAGE` on schema
   `short_videos` and table/routine access to `service_role` (used by the Review UI via `SUPABASE_SERVICE_KEY`)
   and configures default privileges for newly created objects.

