# Postgres Publishing Queue

Postgres is the source of truth for publishing job state. Google Sheets remains the human-readable mirror used for approvals, routing metadata, and operations.

## Local startup

The `publishing-db` service starts automatically with `n8n/compose.local.yaml`. On its first start, the official Postgres entrypoint applies `n8n/postgres/init/001-publishing-queue.sql`. On every Compose start, the one-shot `publishing-migrations` service applies the idempotent files under `n8n/postgres/migrations/` before n8n starts, so existing volumes receive schema upgrades too.

```bash
docker compose -f n8n/compose.local.yaml up -d
docker compose -f n8n/compose.local.yaml ps
```

Local host access defaults to `127.0.0.1:5433`. Containers use `publishing-db:5432`. Change the local-only defaults through `PUBLISHING_DB_NAME`, `PUBLISHING_DB_USER`, `PUBLISHING_DB_PASSWORD`, and `PUBLISHING_DB_PORT`.

## n8n credential

Create a credential of type `Postgres` named `Publishing Queue Postgres`. For local Compose, use host `publishing-db`, port `5432`, database/user `short_videos`, the configured password, and no SSL. Bind it to the Postgres nodes in WF11, WF12, and WF14.

Credential creation and binding remain deployment actions. Secrets and credential IDs are intentionally absent from committed workflow JSON.

WF12 also contains four fixed provider credential bindings: `YouTube Publishing OAuth2`, `Facebook Reels Page Token`, `Instagram Reels Token`, and `TikTok Content Posting Bearer`. Queue rows select these through `YOUTUBE_PRIMARY`, `FACEBOOK_PRIMARY`, `INSTAGRAM_PRIMARY`, and `TIKTOK_PRIMARY`; there is currently one credential/account per platform. `credential_slot` is an allowlisted routing assertion, not a secret or dynamic credential lookup.

## Queue behavior

- WF11 upserts the full Sheet snapshot plus newly approved jobs. Conflict updates refresh metadata but do not overwrite database-owned status, retry, claim, or provider-result fields.
- WF12 atomically selects and claims one due row using `FOR UPDATE SKIP LOCKED`.
- A retried claim with the same n8n execution ID returns that worker's existing live claim, preventing an ambiguous connection failure from claiming a second job.
- `CLAIMED` and `UPLOADING` rows become recoverable after their lease expires.
- Provider checkpoints are stored in `provider_stage`, `provider_ref`, `provider_response`, and `poll_after`. This allows later WF12 executions to resume YouTube sessions or poll asynchronous provider work without reinitializing it.
- Provider reconciliation is bounded by `provider_poll_count` and `provider_poll_deadline`; an exhausted job becomes `FAILED` with a manual-reconciliation reason instead of starving newer work forever.
- `provider_upload_url` stores YouTube resumable session URIs and Meta upload URLs. These URLs may be signed or bearer-like and remain Postgres-only. Do not mirror them to Google Sheets or application logs.
- Safe provider stages visible in the Sheet mirror are `YOUTUBE_SESSION`, `YOUTUBE_PROCESSING`, `FACEBOOK_VIDEO_CREATED`, `FACEBOOK_PROCESSING`, `INSTAGRAM_CONTAINER`, `INSTAGRAM_PUBLISH_REQUESTED`, `INSTAGRAM_MEDIA_PUBLISHED`, `INSTAGRAM_PUBLISHED`, and `TIKTOK_PROCESSING`.
- WF14 atomically resets due retries and terminalizes rows whose retry count reached four.
- Database transitions are mirrored to Sheets after the transaction commits.

## Provider media and terminal boundaries

- YouTube reads `local_file_path` and stores its resumable session URI before transferring bytes. A `308` resume checkpoint is not completion; WF12 polls YouTube processing after receiving the video ID.
- Facebook and Instagram require `meta_graph_version` plus `public_video_url`; Instagram also requires an allowlisted `instagram_graph_host`.
- TikTok requires `tiktok_domain_verified=true`, a `public_video_url` under the same normalized origin and path boundary as `tiktok_verified_url_prefix`, and draft mode. Inbox delivery is `DRAFT_UPLOADED` and still requires the creator to finish posting. TikTok's tracking `publish_id` remains `provider_ref`; it is never mislabeled as `post_id`.
- `video_url`/Drive links are operator references. Google Drive share URLs are not proven to satisfy provider pull requirements.
- No live provider credentials were used in repository verification, so the queue's local tests do not prove provider acceptance, asynchronous completion, or public visibility.

## Move to Neon

1. Create a Neon database and run `n8n/postgres/init/001-publishing-queue.sql` against it.
2. Create or update the n8n `Postgres` credential with Neon host, database, user, password, and required SSL.
3. Bind that credential to every publishing Postgres node.
4. Run WF11 once to seed the Neon queue from the current Sheet snapshot.
5. Verify row counts and statuses, then test two concurrent private/draft claims before enabling provider work.

The SQL uses standard PostgreSQL features and no local-only extensions, so the workflow files do not change when switching to Neon.
