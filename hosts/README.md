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
  compose.local.yaml      # name: n8n, includes shared/postgres + heavy (+ jaeger)
  compose.prod.yaml       # name: n8n, includes shared/postgres + shared/traefik + heavy
  .env.example            # copy to hosts/.env, which is never committed
  heavy/                  # Dockerfile, runners/, compose.yaml
  public/                 # compose.yaml
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

## Bringing an existing volume onto this layout

`PUBLISHING_DB_PASSWORD` is required with no default, but `POSTGRES_PASSWORD`
only takes effect when the Postgres entrypoint initialises an **empty** data
directory. On a volume that was initialised earlier, the stored password is
whatever it was created with, so putting a fresh value in `hosts/.env` starts
Postgres happily and then fails every client authentication.

Rotate the stored password to match `hosts/.env` once, while the old stack is
still up:

```bash
docker exec -i <old-postgres-container> \
  psql -U short_videos -d short_videos -v ON_ERROR_STOP=1 \
  -c "ALTER ROLE short_videos PASSWORD '<the value from hosts/.env>';"
```

Verify it from **another container**, not from inside the Postgres one. This
image's `pg_hba.conf` has `trust` for `local` and `127.0.0.1`, so any password
appears to work from inside and such a test proves nothing:

```bash
docker run --rm --network n8n_heavy-net -e PGPASSWORD='<new>' postgres:16-alpine \
  psql -h postgres -U short_videos -d short_videos -tAc 'select 1'
```

## What the two-host split does and does not fence

Verified against a live stack:

- `public-n8n` cannot resolve `n8n` at all, so neither the editor on 5678 nor
  the task-runner broker on 5679 is reachable from it. `postgres` resolves from
  both, which is the one intended bridge.
- `whatsapp_access` connecting to `short_videos` fails with
  `permission denied for database "short_videos"`, and is capped at 20
  connections.
- The reverse direction is **not** fenced. `short_videos` is the cluster
  superuser that `initdb` created on this volume, and superusers bypass
  `REVOKE CONNECT`, so it can still connect to `whatsapp_access`. The mirrored
  `REVOKE` is there for the day that role is demoted; it has no effect today.
  This is the lesser direction — the trusted host reaching the untrusted
  database — but it is not a boundary, and should not be described as one.
