# Deploying n8n to AWS (Production)

This guide covers going live with `compose.prod.yaml` on an AWS EC2 instance. The setup runs two containers: n8n itself and Traefik, a reverse proxy that handles HTTPS routing and automatically issues/renews Let's Encrypt TLS certificates.

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

Result: `n8n.yourdomain.com` points at the server. Wait for propagation before starting the stack — Let's Encrypt needs the record to resolve to issue the certificate.

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
cd ~/n8n-compose
cp .env.example .env
```

Edit `.env` with your real values:

```bash
DOMAIN_NAME=yourdomain.com
SUBDOMAIN=n8n
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
docker compose -f compose.prod.yaml up -d
```

Traefik will obtain the TLS certificate automatically on first start (can take a minute). Then open:

```
https://n8n.yourdomain.com
```

Set up your owner account immediately — the first visitor to the URL gets to create it.

Useful commands:

```bash
docker compose -f compose.prod.yaml logs -f n8n     # tail n8n logs
docker compose -f compose.prod.yaml logs -f traefik # tail traefik logs (cert issues show here)
docker compose -f compose.prod.yaml stop            # stop
docker compose -f compose.prod.yaml pull && \
docker compose -f compose.prod.yaml up -d           # upgrade n8n to latest
```

## 7. Backups — critical

The `n8n_data` Docker volume holds:

- The SQLite database (workflows, executions, users)
- The **encryption key** used to encrypt stored credentials

**If you lose the encryption key, all stored credentials are unrecoverable.** Back it up now:

```bash
# One-off backup of the data volume to a tarball
docker run --rm -v n8n-compose_n8n_data:/data -v $(pwd):/backup \
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
- [ ] Restrict the Traefik dashboard: `--api.insecure=true` in `compose.prod.yaml` exposes the dashboard on port 8080 inside the Docker network. The security group blocks it externally, but consider removing that flag entirely in production.
- [ ] Set up monitoring: at minimum a CloudWatch alarm on instance status checks; n8n exposes `/healthz` for HTTP health checks
- [ ] Watch disk usage: execution history grows the SQLite DB. This compose file enables `EXECUTIONS_DATA_PRUNE=true`, sets `EXECUTIONS_DATA_MAX_AGE`, and caps retained executions with `EXECUTIONS_DATA_PRUNE_MAX_COUNT`.
- [ ] Verify webhooks work end-to-end after going live: external services must be able to reach `https://n8n.yourdomain.com/webhook/...`

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
