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

Edit `hosts/.env` with your real values. The four secret lines are commented
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

Make sure the `local-files/` directory exists with correct ownership:

```bash
mkdir -p local-files
```

## 6. Start the stack

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

## 7. Backups — critical

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

## 8. Hardening and operations checklist

- [ ] SSH: key-based auth only, disable password login (`/etc/ssh/sshd_config`)
- [ ] Keep the OS patched: `sudo apt update && sudo apt upgrade` regularly (or enable unattended-upgrades)
- [ ] Replace the Docker socket mount on Traefik with a socket proxy. `:ro` applies to the socket file, not the API behind it, so anything that can make Traefik issue requests there can create a container with a host bind mount. The dashboard is already off (`--api=false`).
- [ ] Set up monitoring: at minimum a CloudWatch alarm on instance status checks; n8n exposes `/healthz` for HTTP health checks
- [ ] Watch disk usage: execution history grows the SQLite DB. This compose file enables `EXECUTIONS_DATA_PRUNE=true`, sets `EXECUTIONS_DATA_MAX_AGE`, and caps retained executions with `EXECUTIONS_DATA_PRUNE_MAX_COUNT`.
- [ ] Verify webhooks work end-to-end after going live: external services must be able to reach `https://automations.yourdomain.com/webhook/...`
- [ ] Rotate the Postgres password if the volume predates this layout. `POSTGRES_PASSWORD` only applies at initdb; see `hosts/README.md`.

## 9. Scaling notes (later, if needed)

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
