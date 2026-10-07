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
