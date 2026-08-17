# Short Videos Pipeline Architecture

The discovery, review, and render pipeline is Google-Sheets-driven. Publishing uses Google Sheets as the approval/operator mirror and Postgres as the transactional queue and provider-checkpoint source of truth.

## Workflow Chain

1. WF1 `Source Channel Registry`: resolves YouTube channel URLs into channel IDs and uploads playlist IDs.
2. WF2 `Video Fetch`: fetches new and backfill videos from uploads playlists, deduping by `youtube_video_id`.
3. WF3 `Validity Check`: rejects short, live, music, or weak candidates before transcript work.
4. WF4 `Transcript Fetch`: calls the transcript Lambda and writes `Transcript_Analysis`.
5. WF5 `AI Transcript Analysis`: uses OpenAI to score transcripts and write `Clip_Moments`.
6. WF6 `yt-dlp Clip Download`: downloads each pending exact clip range, uploads it to Drive, and creates `Created_Clips`.
7. WF7 is no longer active in the yt-dlp path; there is no provider webhook step.
8. WF8 `Drive Storage Transform`: downloads clips, uploads to Drive, and uses OpenAI to create a transformation plan.
9. WF9 `Review Queue Digest`: emails clips waiting for review.
10. WF10 `Error Handler`: records workflow errors to `Error_Log`.
11. WF11 `Build Publishing Jobs`: converts explicitly approved completed renders into one `Publishing_Jobs` row per explicitly selected destination platform/channel.
12. WF12 `Publish To Platforms`: claims one due Postgres job per run, resumes its persisted provider stage, and records a terminal platform result or structured failure.
13. WF13 `Publishing Credential Health`: records daily configuration/expiry health derived from non-secret channel metadata; it does not make a live provider request.
14. WF14 `Publishing Retry Scheduler`: moves due retryable publish failures back to `PENDING`.

## State Machine

`Candidate_Videos.processing_status`:

- `NEW` -> WF3 marks `validity_status=VALID`, `REJECTED`, or `FLAGGED`.
- `VALID` rows flow through WF4 transcript fetch.
- WF5 marks rows `ANALYZED` or `SKIPPED`.

`Clip_Moments.ssemble_status`:

- `PENDING` -> WF6 starts a local yt-dlp download for the exact clip range.
- `SUBMITTED` -> WF6 has started the download and marks the row `COMPLETED` or `ERROR`.
- `AWAITING_MANUAL_APPROVAL` waits for a manual flip to `PENDING`.
- `ERROR` can be reset manually to `PENDING` when retrying is appropriate.

`Created_Clips.review_status`:

- `AWAITING_DOWNLOAD` -> WF8 stores in Drive and marks `NEEDS_REVIEW`.
- `NEEDS_REVIEW` -> human review sets `APPROVED` or `REJECTED`.

`Render_Jobs.render_status`:

- `PENDING` -> WF8c renders one final clip.
- `COMPLETED` rows carry `final_local_path`, `final_drive_file_id`, and `final_drive_url`.

`Approved_For_Posting.status`:

- Only `APPROVED` or `READY` is explicit human authorization for WF11 to create jobs.
- `PENDING`, blank, or any other status does not authorize publishing.
- At least one explicit supported platform is required. Blank platform selection never expands to all destinations.

`Publishing_Jobs.publish_status`:

- A due `PENDING` job is leased as `CLAIMED` before provider work; a future `scheduled_at` is not eligible.
- `CLAIMED` -> `UPLOADING` -> `PROCESSING` while the worker owns the lease.
- `PUBLISHED` requires a confirmed provider post ID. `DRAFT_UPLOADED` requires a confirmed provider draft/container ID and still needs the documented manual step.
- `RETRY_PENDING` is reset by WF14 when `next_retry_at` is due.
- Retryable failures become `FAILED` deterministically at the configured retry limit; they must not remain stranded as `RETRY_PENDING`.
- `AUTH_REQUIRED`, `REJECTED`, and `FAILED` require manual action. An expired `CLAIMED` lease can be recovered safely.

## Download Controls

WF5 limits provider work before download:

- Skips episodes with score below 7.
- Skips high rights or monetization risk.
- Caps exact clips to the top 5.
- Defaults to exact 45-90 second clips for `yt-dlp`.
- Treats 20-minute windows as optional analysis context only, not the preferred recommendation or a download range.
- Routes high-risk sources to `AWAITING_MANUAL_APPROVAL`.

WF6 is the only workflow that downloads source clips:

- Picks at most 5 pending moments per run.
- Rotates fairly by niche first, then by source channel.
- Downloads with `yt-dlp --download-sections` into `/data/jobs/<created_clip_id>/source.mp4`.
- Requires clip ranges to be 45-90 seconds.
- Uploads the downloaded source clip to Drive before downstream transformation.

## Idempotency

- WF2 dedups videos by `youtube_video_id`.
- WF4 writes transcript rows by deterministic `analysis_id`.
- WF5 writes clip moments by deterministic `clip_moment_id`.
- WF6 writes created clips by deterministic `created_clip_id=CC-<clip_moment_id>`.
- WF6 stores a legacy-compatible provider id as `ssemble_job_id=YTDLP-<clip_moment_id>` so downstream sheet joins remain stable.
- WF8 saves Drive IDs immediately after upload and reuses them on retries.
- WF11 writes deterministic `publish_id=PUB_<render_id>_<platform>_<channel_id>` so reruns do not duplicate platform jobs.
- WF11 syncs the Sheet snapshot into `short_videos.publishing_jobs` without overwriting database-owned queue state.
- WF12 claims with one Postgres `FOR UPDATE SKIP LOCKED` statement, keyed by `$execution.id`; a retry returns the same active claim instead of claiming a second job.
- WF12 records `claimed_at`, `claimed_by`, and `lease_expires_at` before provider work; stale leases become eligible for recovery while retaining the same logical job ID.

## Publishing Safety Contract

- Authorization fails closed: the render must be `COMPLETED`, the approval row must be `APPROVED` or `READY`, and the platform list must be explicit.
- Destination routing fails closed: the destination must be enabled, match the render niche and requested platform, pass the configured audit/manual-mode gate, and provide the platform-specific destination ID.
- Time fails closed: WF12 only selects jobs whose `scheduled_at` is blank or due, and WF14 only releases retries whose `next_retry_at` is due.
- Concurrency is transaction-backed: Postgres is the queue source of truth, and Google Sheets is an operator-facing mirror. WF12 selects and claims one row under `FOR UPDATE SKIP LOCKED`; stale-lease recovery is explicit and all transitions retain the deterministic `publish_id`.
- The schema and parameterized SQL avoid provider-specific extensions, so the local Postgres queue can move to Neon by changing the n8n Postgres credential and applying the same initialization SQL.
- Provider acceptance is not publication proof. A job becomes `PUBLISHED` only after the platform-specific terminal check; initialization, upload, finish acknowledgement, or container creation alone remains `UPLOADING` or `PROCESSING`. TikTok inbox delivery becomes `DRAFT_UPLOADED`, not `PUBLISHED`.
- Unit tests, generated-workflow validation, and local Docker execution do not prove live OAuth scopes, provider entitlements, app-review approval, media-hosting compatibility, asynchronous processing, or public visibility. Each platform stays disabled/private/draft until a controlled live test proves its complete path.

## Provider State Machines

WF12 derives a `*_START` route only when no provider checkpoint exists. Durable provider stages, references, raw responses, polling time, and signed upload/session URLs live in Postgres so a later execution resumes instead of initializing a duplicate provider job.

- YouTube: initialize `videos.insert?uploadType=resumable` -> save `YOUTUBE_SESSION` and the `Location` session URI -> upload the local MP4. After an ambiguous interruption, probe the saved session with an empty `PUT` and `Content-Range: bytes */TOTAL`; HTTP `308` plus `Range` identifies the resume offset. Once YouTube returns the video ID, save `YOUTUBE_PROCESSING` and poll `videos.list?part=processingDetails,status` until processing succeeds/`uploadStatus=processed` or a terminal failure is reported. See [YouTube's resumable protocol](https://developers.google.com/youtube/v3/guides/using_resumable_upload_protocol) and [processing-status guide](https://developers.google.com/youtube/v3/guides/implementation/videos).
- Facebook Reels: start `/PAGE_ID/video_reels?upload_phase=start` -> save `FACEBOOK_VIDEO_CREATED` with `video_id` and the provider upload URL -> send `public_video_url` through the hosted-upload `file_url` header -> call `upload_phase=finish` -> save `FACEBOOK_PROCESSING` and poll `/{video_id}?fields=status`. Only `publishing_phase.status=complete` is terminal; upload/finish acknowledgement is not. See Meta's [official Facebook Reels Publishing collection](https://www.postman.com/meta/facebook/folder/simabyk/reels-publishing).
- Instagram Reels: create a `REELS` container from `public_video_url` -> save/poll `INSTAGRAM_CONTAINER` until `status_code=FINISHED` -> durably save `INSTAGRAM_PUBLISH_REQUESTED` before `/media_publish` -> save the returned media ID as `INSTAGRAM_MEDIA_PUBLISHED` -> fetch its permalink and media type -> complete as `INSTAGRAM_PUBLISHED`. `ERROR` and `EXPIRED` container states are terminal failures. See Meta's [official Instagram Reels Publishing collection](https://www.postman.com/meta/instagram/folder/23987686-8cdc2637-eebc-4770-aa59-7b0a0bba5a64).
- TikTok: call the `video.upload` draft/inbox `PULL_FROM_URL` init endpoint -> save `TIKTOK_PROCESSING` with TikTok's `publish_id` -> poll status. `SEND_TO_USER_INBOX` becomes `DRAFT_UPLOADED`; the creator must open TikTok and complete posting. Direct Post is deliberately rejected because it requires creator-info-driven UI, preview, manual privacy/interaction selection, and explicit per-post consent, and TikTok's guidelines reject internal team-account upload utilities as a Direct Post use case. See [TikTok draft upload](https://developers.tiktok.com/doc/content-posting-api-reference-upload-video), [post status](https://developers.tiktok.com/doc/content-posting-api-reference-get-video-status), and [sharing guidelines](https://developers.tiktok.com/doc/content-sharing-guidelines).

YouTube streams the local MP4 through the Docker-internal `provider-uploader` service. The sidecar is not host-published, confines paths to the read-only `/data` mount, accepts only Google resumable-session URLs, and never buffers the whole video or stores OAuth tokens. Facebook, Instagram, and TikTok fetch `public_video_url`; this must be stable public HTTPS storage, and TikTok additionally requires a verified, non-redirecting prefix recorded in `tiktok_verified_url_prefix`. Google Drive share links are retained as operator references but are not proven provider-fetchable.

The generated WF12 binds one credential/account per platform through `YOUTUBE_PRIMARY`, `FACEBOOK_PRIMARY`, `INSTAGRAM_PRIMARY`, and `TIKTOK_PRIMARY`. A job whose `credential_slot` differs is safely skipped; adding another account requires another explicit slot and credential-bound branch.

No live provider claim is made for this implementation: the workflows and tests ran without real YouTube, Meta, Instagram, or TikTok credentials. Live scopes, upload sessions, remote pulls, processing outcomes, app review, and final visibility remain deployment tests.

## Channel Health

WF5 tracks channel quality after every analysis and auto-pauses poor-performing channels to stop wasting AI credits.

**Trigger:** after each WF5 analysis completes.

**Rule:** if a channel has ≥ 10 analyzed videos and its all-time `SKIP_THIS_VIDEO` rate ≥ 70%, it is auto-paused.

**Pause action:**
- `Source_Channels.active_status` → `FALSE` (stops WF2 from fetching new videos)
- `Source_Channels.auto_paused_at` and `auto_paused_reason` set for audit trail
- All `Candidate_Videos` rows for the channel with `processing_status` not in `[DONE, ANALYZED, SKIPPED]` are bulk-set to `processing_status=SKIPPED`, `validity_status=REJECTED`, `rejection_reason="Channel auto-paused: ..."`.

**Re-enable:** Set `active_status=TRUE` in Source_Channels (one cell). WF5 detects this on the next analysis from that channel and automatically resets the health window (`health_reset_at=NOW`, counters cleared). The channel then needs to accumulate 10 new videos before it can be judged again — preventing an immediate re-pause from stale historical data.

**Notification:** WF9 daily digest includes a "Channels Auto-Paused Today" section listing any channels paused in the last 24 hours. It also flags any niche where no active channels remain, so you know when to add new sources or re-enable suitable paused channels.

### New Google Sheet Columns Required

**Source_Channels** (add 5 columns):

| Column | Type | Notes |
|--------|------|-------|
| `total_analyzed_count` | integer | Analyzed videos since last `health_reset_at` |
| `channel_skip_rate` | decimal (0.0–1.0) | All-time skip rate since last reset; empty until ≥ 10 analyzed |
| `auto_paused_at` | ISO timestamp | Set on auto-pause; cleared by WF5 on re-enable |
| `auto_paused_reason` | string | e.g. `"skip_rate=73% (22/30 videos)"` |
| `health_reset_at` | ISO timestamp | Set by WF5 on re-enable; health check ignores TA rows older than this |

**Transcript_Analysis** (add 1 column):

| Column | Type | Notes |
|--------|------|-------|
| `source_id` | string | Denormalized from Candidate_Videos so health check can filter by channel without a join |

> These columns must be added to the actual Google Sheet before deploying the updated WF5.

## Human Boundary

Automated:

- discovery
- validation
- transcript fetch
- AI analysis
- yt-dlp source clip download
- Drive storage
- transformation planning
- review digest
- publishing job creation
- due-time, lease-protected, checkpointed provider attempts for explicitly approved renders
- retry scheduling for transient publish failures

Manual:

- source channel selection
- resolving `FLAGGED` candidates
- approving `AWAITING_MANUAL_APPROVAL` moments
- final clip review
- copying approved clips to `Approved_For_Posting`
- creating and reconnecting platform credentials
- completing YouTube, Meta, and TikTok app/audit approvals
- reviewing `AUTH_REQUIRED`, `REJECTED`, and exhausted `FAILED` publishing jobs

Publishing starts from approved completed renders only. YouTube reads the local `/data` MP4. Meta and TikTok require a separate provider-fetchable `public_video_url`; the Drive operator link is not treated as that handoff.
