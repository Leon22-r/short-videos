# Postiz publishing backend

WF12 supports an opt-in Postiz backend alongside the existing direct platform paths. n8n keeps approvals, due-time selection, job identity and reconciliation; Postiz handles platform delivery. Existing jobs default to `DIRECT` and do not migrate when a channel's Sheet row changes.

## Configure an installation

1. Apply `domains/short-videos/postgres/migrations/003-postiz-publishing.sql` after the existing queue migrations (Compose's migration service does this). Back up the queue before deployment.
2. Confirm the deployed Postiz version provides `GET /integrations`, `POST /upload-from-url`, `POST /posts`, and `GET /posts?startDate=...&endDate=...`. Verify Temporal workers are running; an HTTP health response alone does not establish worker readiness.
3. The generated HTTP nodes default to `http://postiz:5000/api/public/v1`, requiring the Postiz and n8n containers to share a private Docker network. This repository does not change your Postiz Compose/network configuration. For another installation, regenerate with a trusted HTTPS endpoint:

   ```bash
   POSTIZ_PUBLIC_API_BASE_URL=https://postiz.example.com/api/public/v1 node domains/short-videos/workflow-code/create-remaining-workflows.js
   ```

   This is a generator setting, not a secret or per-job URL. Do not include a trailing slash. Postiz Cloud uses `https://api.postiz.com/public/v1`. Redirects are disabled so credentials cannot be forwarded to a new destination.
4. Create an n8n **Header Auth** credential named `Postiz Public API`, header name `Authorization`, value the Postiz API key (without a `Bearer ` prefix). Bind it to all four Postiz HTTP nodes. Bind `Publishing Queue Postgres` to every new SQL node. Keep secrets out of Sheets and workflow JSON.
5. Import the regenerated WF11–WF14 exports inactive; retain the existing direct branches for old jobs. Bind Sheet IDs, credentials and the real WF10 error-workflow ID in WF12 settings (`WF10_ERROR_HANDLER_WORKFLOW_ID` is a placeholder). Inspect imported connections and validate/test against the installed n8n runtime before activation.

## Destination configuration

Add `publishing_backend` and `postiz_integration_id` to `Publishing_Channels`. Use `POSTIZ` and an exact ID from the integrations API; blank backend means `DIRECT`. Set `enabled_status=TRUE` only for intended destinations. WF11 sets `credential_slot=POSTIZ_PRIMARY` and snapshots the integration. Native platform IDs are optional on Postiz jobs. WF12 checks the integration ID, provider type and disabled flag before handoff.

| Platform | Postiz provider | Required intent |
| --- | --- | --- |
| YOUTUBE_SHORTS | youtube | `default_privacy` private/unlisted/public; DEV_PRIVATE_ONLY permits private only; title 2–100 characters |
| FACEBOOK_REELS | facebook | `audit_status=APPROVED_PUBLIC`, `default_privacy=public` |
| INSTAGRAM_REELS | instagram | `audit_status=APPROVED_PUBLIC`, `default_privacy=public`; one video becomes a Reel using `post_type=post` |
| TIKTOK | tiktok | `requires_manual_publish=TRUE`; inbox UPLOAD only, manual creator completion |

Instagram Standalone integrations are not enabled by this adapter; they fail the provider check. Each job needs a provider-fetchable `public_video_url` from approval/render metadata. Local filesystem and Drive share URLs are not automatically uploaded by this path. Verify the URL serves the actual MP4 with compatible MIME type; the imported Postiz media path must end in `.mp4`, because its Meta providers use the extension to select video handling. Importing media into Postiz alone does not publish it. No music is added by this adapter.

## Submission and status

One deterministic queue key creates one Postiz post for one integration. n8n waits until `scheduled_at` is due, imports the media, saves `POSTIZ_MEDIA_READY`, and atomically snapshots the request as `POSTIZ_SUBMIT_REQUESTED`. Only that winning transition can call `POST /posts`; automatic HTTP/intent retries are disabled. `postiz_submitted_at` is the intent timestamp, **not** proof of acceptance.

A validated response saves `postiz_post_id` and `POSTIZ_SUBMITTED`. Future runs only poll that ID. `QUEUE` and missing list results remain processing; unknown states, errors and unexpected drafts require review. Polling stops after the existing queue's 180-poll/24-hour bound. HTTP read failures count toward the same bound.

Public-platform completion requires Postiz's `PUBLISHED` state, matching post/integration/provider and a valid platform release URL. This is Postiz-reported delivery, not an independent anonymous visibility probe; YouTube retains its configured private/unlisted/public visibility. Store the platform `releaseId` as `post_id` when available, otherwise leave it blank. Never substitute the Postiz ID. TikTok UPLOAD success becomes `DRAFT_UPLOADED` even though Postiz calls it PUBLISHED; the creator must finish in TikTok.

Database-owned fields, including backend and integration, cannot be changed by Sheet synchronization. All Postiz content/media/schedule metadata freezes on first dispatch. Snapshots, media paths and provider responses stay out of Sheet mirrors. WF13 reports `NOT_CHECKED` for Postiz; it does not test credentials.

## Recovery and rollback

An uncertain create (timeout, malformed response, database failure before saving its ID) must not be retried blindly. A recovered `POSTIZ_SUBMIT_REQUESTED` row without a confirmed ID is terminalized for manual reconciliation. Inspect the saved request, intent time and exact integration against Postiz execution/post records. Matching captions alone are not evidence. If a matching post is positively identified, record its ID through a supervised database recovery and resume reconciliation. If none is visible, do not assume the create failed: establish that no delayed Postiz task can still publish before authorizing any new submission.

`AUTH_REQUIRED`, rejected jobs and exhausted failures require operator intervention. Fixing a credential does not automatically reset them. Pre-submission transient failures use the normal bounded retry schedule; an imported but uncheckpointed media upload may leave an orphan asset, but cannot create a duplicate post. Post-submission delivery failures are handled/reviewed in Postiz; our queue never creates a replacement automatically.

To stop new Postiz intake, disable the channel. Already queued/submitted jobs still require explicit handling; disabling a channel does not cancel them. Leave reconciliation running for accepted posts. Do not change old queue keys, switch in-flight jobs to DIRECT, or downgrade the SQL schema during rollback. A separate operator-approved cutover is needed after all outstanding intents/posts are accounted for.

## Verification and deployment gates

`npm test` includes helper/graph regressions and real temporary-Postgres tests when PostgreSQL 16 binaries are available. The latter create a private temporary Unix socket and clean up their own database; set `POSTIZ_TEST_PG_BIN` if binaries are elsewhere. A sandbox that forbids sockets needs permission to run this test. These tests never use production credentials or post externally.

Local tests do not establish live n8n import compatibility, Postiz worker health, OAuth entitlements, media acceptance or platform visibility. Before switching a destination, validate imported workflows and run one explicitly authorized controlled end-to-end test on that actual deployment. The committed WF12 remains inactive.

Contract references: [create](https://docs.postiz.com/public-api/posts/create), [list](https://docs.postiz.com/public-api/posts/list), [media](https://docs.postiz.com/public-api/uploads/upload-from-url), [TikTok inbox semantics](https://docs.postiz.com/public-api/providers/tiktok).
