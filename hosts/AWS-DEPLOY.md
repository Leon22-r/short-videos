# Deploying n8n to AWS (Production)

This guide covers going live with `hosts/compose.prod.yaml` on an AWS EC2 instance.

It brings up the whole stack, not just n8n and a proxy: the `heavy` host (n8n with
ffmpeg and yt-dlp, plus its task runners and the provider uploader), the `public`
host (stock n8n for webhook-facing automations), one Postgres with a database per
domain, and Traefik for HTTPS with automatic Let's Encrypt certificates.

Read `hosts/README.md` first. It explains which host holds credentials, why
`heavy` has no Traefik router, and what must not be set.

## Prerequisites

- An AWS account
- A domain name you control (for DNS + TLS)
- The `hosts/` and `domains/` directories from this repo (`hosts/compose.prod.yaml`, `hosts/.env.example`)

## 1. Launch an EC2 instance

- **Instance type:** `t3.small` or larger. n8n needs roughly 1 GB of RAM; `t3.micro` will struggle under real workflow load.
- **AMI:** Ubuntu 22.04/24.04 LTS (or Amazon Linux 2023).
- **Storage:** 20 GB+ gp3 EBS volume.
- **Elastic IP:** Allocate one and associate it with the instance. Without it, the public IP changes on stop/start and breaks your DNS record.

## 2. Configure the security group

Allow inbound traffic only on:

| Port | Protocol | Source | Purpose |
|------|----------|--------|---------|
| 22   | TCP      | Your IP only | SSH |
| 80   | TCP      | 0.0.0.0/0 | HTTP (Traefik redirects to HTTPS, needed for cert challenge) |
| 443  | TCP      | 0.0.0.0/0 | HTTPS |

Do **not** open port 5678. n8n publishes `5678` only on the server's loopback interface; Traefik proxies all external traffic to it.

## 3. Set up DNS

In Route 53 (or your DNS provider), create an A record:

| Record type | Name | Value |
|-------------|------|-------|
| A | `n8n` (subdomain) | Your Elastic IP |

Result: `automations.yourdomain.com` points at the server. Wait for propagation
before starting the stack — Let's Encrypt needs the record to resolve to issue
the certificate.

This subdomain serves the **public** host's webhook paths. The `heavy` editor is
deliberately not published; see "Reaching the heavy editor" below.

## 4. Install Docker on the server

SSH in, then:

```bash
# Install Docker Engine + Compose plugin (Ubuntu)
curl -fsSL https://get.docker.com | sudo sh

# Optional: run docker without sudo
sudo usermod -aG docker ${USER}
exec sg docker newgrp

# Verify
docker --version
docker compose version
```

## 5. Copy the project files to the server

From your local machine:

```bash
scp -r hosts/ domains/ ubuntu@<elastic-ip>:~/automations
```

On the server:

```bash
cd ~/automations
cp hosts/.env.example hosts/.env
```

Edit `hosts/.env` with your real values. The five secret lines are commented
out in the template on purpose — Compose refuses to start until you set them,
which is what stops a copied template booting with a password that is readable
in this repo:

```bash
DOMAIN_NAME=yourdomain.com
PUBLIC_SUBDOMAIN=automations
PUBLIC_TRAEFIK_ENABLE=true   # publishing the public host is a deliberate act
HEAVY_BIND_ADDRESS=100.x.y.z  # this host's Tailscale address, never 0.0.0.0
GENERIC_TIMEZONE=Africa/Nairobi
EXECUTIONS_DATA_MAX_AGE=336
EXECUTIONS_DATA_PRUNE_MAX_COUNT=10000
SSL_EMAIL=you@example.com
```

The short-videos pipeline store lives in Supabase, so that domain needs five
more variables. Two of them are connection strings and they are deliberately
different:

```bash
# Pooler, port 5432 (session mode). The migration runner wraps each migration
# and its schema_migrations write in one transaction, which transaction-mode
# pooling cannot hold.
SUPABASE_MIGRATION_URL=postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres
# Pooler, port 6543 (transaction mode). What the 79 workflow Postgres nodes
# use; every statement they send is a single statement.
SUPABASE_DATABASE_URL=postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:6543/postgres
# PostgREST API credentials from Project Settings -> API. Not the strings above.
SUPABASE_URL=https://<ref>.supabase.co
# SUPABASE_SERVICE_KEY=        # <- the service_role key; bypasses row level security
```

Do not use the direct host `db.<ref>.supabase.co`. Without the IPv4 add-on it
resolves to an AAAA record only, and a host with no working IPv6 route fails
with `Network is unreachable` from the shell and `Name does not resolve` from
inside a container.

And the review UI needs three:

```bash
REVIEW_BIND_ADDRESS=100.x.y.z   # this host's Tailscale address, never 0.0.0.0
REVIEW_PORT=5680
# The hostnames the UI answers to. Defaults to loopback, so a tailnet
# deployment MUST list its own name or every request gets 403.
REVIEW_ALLOWED_HOSTS=100.x.y.z,<host>.<tailnet>.ts.net
```

Make sure the `local-files/` directory exists with correct ownership:

```bash
mkdir -p local-files
```

## 6. Apply the Supabase migrations

**The stack does not do this for you.** `short-videos-migrations` in
`hosts/shared/postgres/compose.yaml` applies `domains/short-videos/postgres/migrations`
to the *local* Postgres, which is where the publishing queue used to live. The
pipeline store is in Supabase now, and nothing in Compose reaches it — so on a
fresh project the tables do not exist and every workflow fails on its first
node.

Run the same runner against the project, from the repo root on the server:

```bash
set -a; . hosts/.env; set +a
sh hosts/shared/postgres/run-migrations.sh "$SUPABASE_MIGRATION_URL" \
  "$PWD/domains/short-videos/postgres/migrations"
```

Every migration is idempotent, so re-running it is safe and is how you apply
new ones later. Verify afterwards:

```bash
psql "$SUPABASE_MIGRATION_URL" -Atc \
  "SELECT count(*) FROM short_videos.schema_migrations;"   # expect 14
psql "$SUPABASE_MIGRATION_URL" -Atc \
  "SELECT table_type, count(*) FROM information_schema.tables
   WHERE table_schema='short_videos' GROUP BY 1 ORDER BY 1;"
# expect: BASE TABLE|13  (12 from the migrations, plus schema_migrations)
#         VIEW|4         (pipeline_status, review_counts, held_reasons_30d, clip_throughput_7d)
```

PostgREST also needs `short_videos` added as an exposed schema in the Supabase
dashboard, which is the one step that cannot be scripted. See **Supabase and
PostgREST Configuration** in `hosts/README.md`.

## 7. Start the stack

```bash
docker compose -f hosts/compose.prod.yaml up -d
```

Traefik will obtain the TLS certificate automatically on first start (can take a minute). Then open:

```
https://automations.yourdomain.com/webhook/...
```

Only the webhook and form paths are published. There is no editor on that
hostname, by design: an n8n editor can create an Execute Command node, so
publishing one would hand the internet a shell in a container holding every
credential.

### Reaching the heavy editor

`heavy` binds to `HEAVY_BIND_ADDRESS`, which in production is the server's
Tailscale address. Open it over the tailnet:

```
http://<tailscale-address>:5678
```

Note the gap documented in `hosts/README.md`: a port published on a host IP is
also reachable from containers that can route to that IP, including the public
n8n instance. Until that is closed, either keep `HEAVY_BIND_ADDRESS=127.0.0.1`
and use an SSH tunnel, or put a header credential on every webhook node in
`heavy`.
```

Set up your owner account immediately — the first visitor to the URL gets to create it.

### Reaching the review UI

The clip approval UI publishes on `REVIEW_BIND_ADDRESS:REVIEW_PORT`, so over
the tailnet:

```
http://<tailscale-address>:5680
```

It is deliberately **not** behind Traefik and not on `public-net`: it holds the
Supabase service key, which bypasses row level security, and it has no login
because the tailnet is the authentication. Publishing it would hand the
internet an unauthenticated writer to the whole pipeline.

Two things make that boundary real, and both fail closed:

- `REVIEW_BIND_ADDRESS` is required with no default, so a missing value stops
  the whole stack rather than publishing the UI on every interface.
- `REVIEW_ALLOWED_HOSTS` must list the hostname you actually use. A request
  whose `Host` is not on the list gets 403, for reads as well as writes — that
  is what stops DNS rebinding, where an attacker's domain pointed at this
  address would otherwise arrive with its own name in both `Host` and `Origin`
  and so look same-origin with the UI.

If every page returns 403 after a move, that second variable is why: the
default covers loopback only.

### Binding the workflow credentials

Nothing in Compose can do this; credential IDs in committed workflow JSON are
placeholders by design, so secrets never enter source control. After importing
the workflows, open n8n and bind:

- the **Postgres** credential, pointing at `SUPABASE_DATABASE_URL` (the pooler
  on 6543), to the Postgres nodes
- a **Query Auth** credential with parameter name `key` and a YouTube Data API
  key, to WF1 `Resolve Channel` and WF2 `Fetch Uploads` / `Fetch Video Details`
- the remaining provider credentials for WF4, WF5, WF8 and WF12

`domains/short-videos/docs/credentials-setup.md` has the full list and maps
each YouTube key failure to its cause.

Useful commands:

```bash
docker compose -f hosts/compose.prod.yaml logs -f n8n        # heavy n8n
docker compose -f hosts/compose.prod.yaml logs -f public-n8n # public n8n
docker compose -f hosts/compose.prod.yaml logs -f traefik    # cert issues show here
docker compose -f hosts/compose.prod.yaml logs postgres-bootstrap # database provisioning
docker compose -f hosts/compose.prod.yaml stop               # stop
docker compose -f hosts/compose.prod.yaml pull && \
docker compose -f hosts/compose.prod.yaml up -d              # upgrade
```

## 8. Backups — critical

The `n8n_data` Docker volume holds:

- The SQLite database (workflows, executions, users)
- The **encryption key** used to encrypt stored credentials

**If you lose the encryption key, all stored credentials are unrecoverable.** Back it up now:

```bash
# One-off backup of the data volume to a tarball
docker run --rm -v n8n_n8n_data:/data -v $(pwd):/backup \
  alpine tar czf /backup/n8n-data-backup.tar.gz -C /data .
```

Recommended ongoing strategy (pick at least one):

- **EBS snapshots:** Enable automated snapshots of the instance volume via AWS Backup or Data Lifecycle Manager (daily, retain 7–30 days).
- **Cron + S3:** Run the tar command above on a cron schedule and `aws s3 cp` the tarball to an S3 bucket.

At minimum, copy the encryption key off the server once:

```bash
docker compose -f hosts/compose.prod.yaml exec n8n cat /home/node/.n8n/config
```

Store the output somewhere safe (password manager).

### What is *not* in that volume any more

The short-videos pipeline state — source channels, candidates, transcripts,
clip moments, created clips, render jobs and the publishing queue — lives in
Supabase, not in `n8n_data` and not in the local Postgres volume. A tarball of
either volume no longer backs up any of it.

Supabase runs its own backups on a schedule that depends on your plan; check
what yours actually retains rather than assuming. For a copy you hold yourself:

```bash
set -a; . hosts/.env; set +a
pg_dump "$SUPABASE_MIGRATION_URL" --schema=short_videos --no-owner \
  -f short-videos-$(date +%F).sql
```

The schema itself needs no backup: `domains/short-videos/postgres/migrations`
reproduces all twelve tables from scratch, which is what the replay test in
`pipeline-store-postgres.test.js` proves on every run. It is the rows that only
exist in the project.

What stays in `n8n_data` and still matters just as much: the workflows, the
execution history, and the encryption key that every bound credential depends
on — including the Supabase connection strings and the service key.

## 9. Hardening and operations checklist

- [ ] SSH: key-based auth only, disable password login (`/etc/ssh/sshd_config`)
- [ ] Keep the OS patched: `sudo apt update && sudo apt upgrade` regularly (or enable unattended-upgrades)
- [ ] `systemctl enable docker`, so `restart: unless-stopped` actually survives a reboot
- [ ] Confirm `review-ui` is **not** reachable from the public IP, only over the tailnet
- [ ] Rotate the Supabase database password and the service key if either was ever pasted into a chat, a terminal transcript or a ticket
- [ ] Check `n8n-task-runners-1` is running after any reboot. It exits **0** on a broker handshake timeout, and `restart: unless-stopped` does not restart a clean exit, so every Code node fails with "task was not matched to a runner" while nothing looks wrong. See `TODOS.md`.
- [ ] Replace the Docker socket mount on Traefik with a socket proxy. `:ro` applies to the socket file, not the API behind it, so anything that can make Traefik issue requests there can create a container with a host bind mount. The dashboard is already off (`--api=false`).
- [ ] Set up monitoring: at minimum a CloudWatch alarm on instance status checks; n8n exposes `/healthz` for HTTP health checks
- [ ] Watch disk usage: execution history grows the SQLite DB. This compose file enables `EXECUTIONS_DATA_PRUNE=true`, sets `EXECUTIONS_DATA_MAX_AGE`, and caps retained executions with `EXECUTIONS_DATA_PRUNE_MAX_COUNT`.
- [ ] Verify webhooks work end-to-end after going live: external services must be able to reach `https://automations.yourdomain.com/webhook/...`
- [ ] Rotate the Postgres password if the volume predates this layout. `POSTGRES_PASSWORD` only applies at initdb; see `hosts/README.md`, 'Upgrading an existing deployment'.

## 10. Scaling notes (later, if needed)

The default setup uses SQLite, which is fine for a single instance with moderate load. If you outgrow it:

- Switch to Postgres (RDS or a container) via `DB_TYPE=postgresdb` environment variables
- Use n8n queue mode with Redis for high-throughput webhook processing

Don't do this preemptively — single-instance SQLite handles most personal/small-team workloads fine.

## Troubleshooting

| Symptom | Likely cause |
|---------|--------------|
| Browser shows certificate error | DNS not propagated yet, or Let's Encrypt challenge failed — check `traefik` logs |
| Site unreachable | Security group missing 80/443, or DNS A record wrong |
| "Secure cookie" login error | You're accessing over plain HTTP — always use the HTTPS URL |
| Webhooks not firing | `WEBHOOK_URL` mismatch — must be `https://<subdomain>.<domain>/` |
| Review UI returns 403 on every page | The hostname you are using is not in `REVIEW_ALLOWED_HOSTS`, which defaults to loopback only |
| Compose refuses to start the whole stack | A required variable is unset — `REVIEW_BIND_ADDRESS`, `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` or one of the four passwords. The error names it |
| Workflow fails on its first Postgres node | The Supabase migrations were never applied (section 6), or the n8n Postgres credential points at the direct host instead of the pooler |
| `Network is unreachable` / `Name does not resolve` for Supabase | Using `db.<ref>.supabase.co`, which is IPv6-only without the IPv4 add-on. Use the pooler host |
| Every Code node times out, "task was not matched to a runner" | `n8n-task-runners-1` is down. It exits 0 on a handshake timeout and is not restarted; `docker compose -f hosts/compose.prod.yaml up -d task-runners` |
| Review UI renders but shows no clips | PostgREST has not been told to expose `short_videos` — a dashboard setting, see `hosts/README.md` |
| `API key not valid` from a YouTube node | The Query Auth value is wrong, usually an OAuth client ID pasted instead of an API key. `credentials-setup.md` maps each variant |
