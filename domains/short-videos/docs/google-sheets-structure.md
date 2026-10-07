# Google Sheets Structure — Short-Form Video Pipeline

Create ONE Google Sheets workbook (the control center). Copy its document ID from the URL
(`https://docs.google.com/spreadsheets/d/<DOCUMENT_ID>/edit`) — this is the
`GOOGLE_SHEETS_DOCUMENT_ID` placeholder used in every workflow.

Create 13 tabs with EXACT names below. Paste each header row into cell A1 of the matching tab
(values are tab-separated — paste directly, Sheets splits them into columns).

---

## Tab 1: `Source_Channels`

```
source_id	niche	source_name	youtube_channel_url	youtube_channel_id	uploads_playlist_id	source_type	priority	risk_level	permission_risk	monetization_risk	notes	active_status	last_checked_at	backfill_next_page_token	backfill_status	videos_known_count	videos_fetched_count	backfill_last_run_at	total_analyzed_count	channel_skip_rate	auto_paused_at	auto_paused_reason	health_reset_at
```

Notes:
- `niche`: one of `CHRISTIAN_CONTENT`, `MOTIVATION_DISCIPLINE`, `FINANCE_BUSINESS`, `LIFE_VALUES_RELATIONSHIPS`, `AFRICAN_KENYAN_SUCCESS`
- `uploads_playlist_id` is an extra helper column (filled by WF1) — the channel's uploads playlist (`UU...`), used by WF2 to fetch videos cheaply (1 API unit instead of 100 for search)
- `risk_level` / `permission_risk` / `monetization_risk`: `low | medium | high`
- `active_status`: `TRUE` / `FALSE`
- `backfill_status`: `NOT_STARTED` / `IN_PROGRESS` / `COMPLETE`; WF2 uses this plus `backfill_next_page_token` to resume older upload pages until the channel is fully fetched
- `videos_known_count` is YouTube's uploads playlist total; `videos_fetched_count` is how many candidate rows currently exist for that source
- `source_type`: e.g. `podcast`, `sermon_channel`, `interview_show`, `business_channel`
- This tab is human-maintained. You add rows; WF1 fills in `youtube_channel_id` + `uploads_playlist_id`.
- WF5 fills the health columns. If every channel in a niche becomes inactive, WF9 flags that niche so you know to add or re-enable sources.

## Tab 2: `Candidate_Videos`

```
video_id	niche	source_id	source_name	video_title	video_url	youtube_video_id	duration_seconds	published_at	view_count	like_count	comment_count	like_percentage	comment_percentage	engagement_percentage	transcript_available	language	validity_status	validity_score	rejection_reason	duplicate_status	processing_status	created_at
```

Status values:
- `validity_status`: empty → `VALID` | `REJECTED` | `FLAGGED`
- `processing_status`: `NEW` → `ANALYZED` | `SKIPPED` | `CLIPPING` | `DONE`
- `duplicate_status`: `UNIQUE` | `DUPLICATE` (duplicates are never appended; column exists for manual entries)
- `like_percentage`, `comment_percentage`, and `engagement_percentage` are decimal percentages for sheet `%` formatting: `likes/views`, `comments/views`, and `(likes+comments)/views`; WF3 writes `0` when views are empty or zero.
- `rejection_reason=LOW_ENGAGEMENT`: WF3 requires `view_count >= 10000`, `like_percentage >= 0.02`, `engagement_percentage >= 0.02`, and `comment_percentage >= 0.0005`.
- `rejection_reason=STATIC_NARRATION_VISUALS`: WF3 hard-rejects likely narration-over-still-image videos before transcript fetch or clipping spend.

## Tab 3: `Transcript_Analysis`

```
analysis_id	video_id	niche	source_id	video_title	video_url	transcript_status	transcript_text	transcript_full_url	transcript_full_file_id	transcript_length_words	ai_episode_score	recommended_strategy	recommended_start_sec	recommended_end_sec	reason_for_strategy	rights_risk	permission_risk	monetization_risk	originality_potential	kenya_relevance	ai_json_output	created_at
```

Status values:
- `transcript_status`: `FETCHED` | `FAILED`
- `recommended_strategy`: `USE_20_MIN_WINDOW` | `USE_EXACT_CLIPS_ONLY` | `SKIP_THIS_VIDEO`
- Sheet cells max 50,000 chars — `transcript_text` is a human preview truncated to ~45,000 with marker `...[TRUNCATED]`
- `transcript_full_url` / `transcript_full_file_id`: Drive location of the full timestamped transcript text file. WF5 uses this file when present and falls back to `transcript_text` for old rows.
- `source_id` is copied from `Candidate_Videos`; WF5 uses it for channel health checks and downstream fair-share lineage.

## Tab 4: `Clip_Moments`

```
clip_moment_id	video_id	niche	source_id	rank	start_sec	end_sec	clip_length_seconds	hook_first_2_seconds	core_idea	why_valuable	target_audience	suggested_title	suggested_caption	on_screen_text	suggested_broll	commentary_angle	kenyan_african_application	bible_verse_if_relevant	needs_extra_context	originality_score	clip_score	rights_risk	final_recommendation	ssemble_status	ssemble_job_id	strategy	source_video_url	created_at
```

Notes:
- `source_id`, `strategy`, and `source_video_url` are helper columns so WF6 can fairly download yt-dlp clips without re-reading other tabs
- `ssemble_status` is a legacy column name now used as provider/download status: `PENDING` → `SUBMITTED` → `COMPLETED` | `ERROR` | `AWAITING_MANUAL_APPROVAL`
- `final_recommendation`: `clip` | `use_as_idea_only` | `skip`
- WF5 defaults to `USE_EXACT_CLIPS_ONLY` for `yt-dlp`. If AI returns useful window context, WF5 still writes exact 45-90 second clip rows rather than downloading a whole window.

## Tab 5: `Ssemble_Jobs`

```
ssemble_job_id	video_id	clip_moment_id	niche	source_id	source_video_url	start_sec	end_sec	request_payload	response_payload	job_status	webhook_received	error_message	created_at	completed_at
```

- Legacy tab retained for older Ssemble rows only. The active yt-dlp WF6 path does not write this tab.
- `job_status`: `SUBMITTED` → `COMPLETED` | `FAILED` for historical Ssemble jobs.
- `source_id` preserves channel lineage for downstream fair-share processing; WF8 also resolves yt-dlp lineage directly from `Clip_Moments`.

## Tab 6: `Created_Clips`

```
created_clip_id	ssemble_job_id	video_id	niche	clip_title	clip_url	local_file_name	google_drive_file_id	google_drive_url	duration_seconds	transcript_excerpt	suggested_title	suggested_caption	content_thesis	hook	narration_script	commentary_angle	kenyan_african_localization	bible_verse_if_relevant	alternative_titles	on_screen_text_beats	broll_plan	editing_style	hashtags	cta	risk_warning	originality_checklist	transformation_plan	review_status	reviewer_notes	created_at
```

- `review_status`: `AWAITING_DOWNLOAD` → `NEEDS_REVIEW` → `APPROVED` | `REJECTED` (you set the last two manually)
- `ssemble_job_id` is a legacy column name. New yt-dlp rows use `YTDLP-<clip_moment_id>` here for downstream compatibility.
- `suggested_title`, `suggested_caption`, `hashtags`, `hook`, `narration_script`, and related planning fields are readable columns for manual review and future posting workflows.
- `alternative_titles`, `on_screen_text_beats`, `broll_plan`, and `originality_checklist` are newline-separated text lists.
- `transformation_plan`: raw JSON from the WF8 transformation planner, kept as an audit/debug record.
- Existing rows that only have `transformation_plan` JSON can be backfilled once with WF8b `Created Clips Transform Backfill`.

## Tab 7: `Render_Jobs`

```
render_id	created_clip_id	niche	source_drive_file_id	source_drive_url	source_file_name	final_drive_folder_id	hook_text	cta_text	cta_start_second	cta_end_second	music_mood	music_energy_level	music_id	music_drive_file_id	music_file_name	music_volume	watermark_drive_file_id	watermark_file_name	progress_bar_color	use_blurred_background	ffmpeg_command	render_status	final_local_path	final_drive_file_id	final_drive_url	warning_message	error_message	created_at	started_at	completed_at
```

- `render_status`: `PENDING` → `DOWNLOADING_ASSETS` → `RENDERING` → `UPLOADING` → `COMPLETED`; terminal failures use `FAILED`; intentional non-work rows can use `SKIPPED`.
- WF8 creates one `PENDING` row after it successfully parses the transformation plan.
- WF8c processes one pending render per run. It stores the generated FFmpeg command and final Drive URL here.
- `warning_message` is used for recoverable issues such as missing music. Missing source clip, branding, watermark, FFmpeg failure, and final Drive upload failure use `FAILED`.

## Tab 8: `Music_Library`

```
music_id	niche	mood	energy_level	track_name	artist_name	source	source_url	license_notes	drive_file_id	duration_seconds	recommended_volume	loop_allowed	active_status	times_used	created_at	last_used_at	notes
```

- WF8c selects active tracks in this order: `niche + mood + energy_level`, `niche + mood`, `niche + energy_level`, `Channel_Branding.music_default_id`, then no music with a warning.
- `recommended_volume` is clamped by WF8c to `0.04-0.14`.
- Music files are downloaded from Google Drive into the per-render `/data/jobs/<render_id>/` workspace.

## Tab 9: `Channel_Branding`

```
niche	watermark_drive_file_id	primary_color	secondary_color	progress_bar_color	default_cta	music_default_id	active_status	notes
```

- Branding is niche-level in this phase.
- WF8c requires exactly one active branding row for the render job's niche.
- Missing branding or missing watermark is a hard render failure.
- `progress_bar_color` must use FFmpeg-safe `0xRRGGBB` format.

## Tab 10: `Error_Log`

```
error_id	workflow_name	node_name	related_video_id	error_type	error_message	raw_payload	created_at
```

## Tab 11: `Approved_For_Posting`

```
approved_id	created_clip_id	niche	platform	final_title	final_caption	final_description	hashtags	status	scheduled_date	public_video_url	posted_url	performance_notes
```

- Human-curated. You copy approved clips here manually (or via future workflow).
- `platform`: `YOUTUBE_SHORTS` | `TIKTOK` | `INSTAGRAM_REELS` | `FACEBOOK_REELS`; comma-separate values to publish one approved render to multiple platforms.
- `status`: only `APPROVED` or `READY` authorizes WF11 to create publish jobs. `PENDING`, blank, and all other values fail closed.
- `platform` must contain at least one explicit supported value. Blank does not mean all platforms.
- `scheduled_date` is copied to each job's `scheduled_at`; a future value prevents WF12 from selecting the job early.
- `public_video_url` is optional for YouTube but required for Facebook, Instagram, and TikTok. It must be a stable provider-fetchable HTTPS object-storage/CDN URL. Google Drive share URLs are not proven provider-fetchable and should not be used here without a controlled live test.

## Tab 12: `Publishing_Channels`

```
channel_id	niche	platform	enabled_status	publishing_backend	postiz_integration_id	credential_name	credential_slot	youtube_channel_id	facebook_page_id	instagram_user_id	tiktok_open_id	meta_graph_version	instagram_graph_host	tiktok_domain_verified	tiktok_verified_url_prefix	default_privacy	requires_manual_publish	audit_status	token_expires_at	last_expiry_audit_at	last_health_status	notes	created_at	updated_at
```

- One active row per destination account you want the publishing workflows to target.
- `publishing_backend`: blank/`DIRECT` for existing provider branches, or opt-in `POSTIZ` with an exact `postiz_integration_id`. Postiz jobs use `POSTIZ_PRIMARY`; native platform IDs and direct credential fields below apply only to DIRECT. See [Postiz configuration](postiz-publishing.md).
- `platform`: `YOUTUBE_SHORTS` | `FACEBOOK_REELS` | `INSTAGRAM_REELS` | `TIKTOK`
- `enabled_status`: `TRUE` / `FALSE`
- `credential_name` is a human reminder only. Real OAuth tokens and API secrets stay in n8n credentials, not Sheets.
- `credential_slot` must be `YOUTUBE_PRIMARY`, `FACEBOOK_PRIMARY`, `INSTAGRAM_PRIMARY`, or `TIKTOK_PRIMARY` for the matching platform. Current WF12 supports one statically bound credential/account per platform; the destination ID must belong to that credential.
- `meta_graph_version` is required for Facebook and Instagram and must use the `vNN.N` form supported by the deployed Meta app.
- `instagram_graph_host` must be `graph.facebook.com` or `graph.instagram.com` and must match the credential/login flow. It defaults to `graph.facebook.com` when omitted.
- `tiktok_domain_verified` is `TRUE` only after TikTok verifies the source, and `tiktok_verified_url_prefix` must contain that exact HTTPS prefix. WF12 rejects a media URL outside it.
- `audit_status`: `DEV_PRIVATE_ONLY` | `APPROVED_PUBLIC` | `NEEDS_REVIEW`; use this to track YouTube/TikTok/Meta approval state.
- `requires_manual_publish`: must be `TRUE` for TikTok. WF12 supports draft/inbox upload only; the creator must finish the post in TikTok.
- WF13 updates `last_health_status`, `last_expiry_audit_at`, and `updated_at` from configuration and expiry metadata only. This is not proof of a successful provider API request.

## Tab 13: `Publishing_Jobs`

```
publish_id	publishing_backend	postiz_integration_id	postiz_post_id	postiz_media_id	postiz_submitted_at	approved_id	render_id	created_clip_id	niche	platform	channel_id	destination_id	youtube_channel_id	facebook_page_id	instagram_user_id	tiktok_open_id	credential_slot	meta_graph_version	instagram_graph_host	tiktok_domain_verified	tiktok_verified_url_prefix	default_privacy	requires_manual_publish	audit_status	video_source	video_file_id	video_url	public_video_url	local_file_path	title	caption	description	hashtags	scheduled_at	publish_status	retry_count	next_retry_at	last_error	post_id	post_url	provider_stage	provider_ref	poll_after	provider_poll_count	provider_poll_deadline	created_at	updated_at	started_at	completed_at	claimed_at	claimed_by	lease_expires_at
```

- WF11 creates one row per completed render + explicitly authorized approval + explicitly selected platform + enabled matching destination channel.
- For POSTIZ, `destination_id` is the immutable `postiz_integration_id`; `postiz_post_id` tracks the accepted Postiz record separately from platform `post_id`. Media paths and `postiz_submit_payload` are database-only and must not be added to Sheets. Metadata freezes on first dispatch.
- For DIRECT, `destination_id` is copied from the matching platform-specific channel field (`youtube_channel_id`, `facebook_page_id`, `instagram_user_id`, or `tiktok_open_id`). WF11 also preserves those source fields plus `default_privacy`, `requires_manual_publish`, and `audit_status` on the job for an inspectable routing decision. Missing or mismatched destination identity fails closed.
- `credential_slot`, `meta_graph_version`, `instagram_graph_host`, `tiktok_domain_verified`, and `tiktok_verified_url_prefix` are copied from `Publishing_Channels`; `public_video_url` is copied from the approval/render metadata.
- `provider_stage`, `provider_ref`, and `poll_after` provide safe operator visibility into asynchronous work. Signed `provider_upload_url` values and raw `provider_response` payloads stay in Postgres only and must not be added to the Sheet.
- Google Sheets is the operator-facing mirror; `short_videos.publishing_jobs` in Postgres is the publishing queue source of truth.
- WF11 seeds and refreshes queue metadata from the Sheet without overwriting database-owned status, retry, lease, or provider-result fields.
- WF12 only selects a `PENDING` job when `scheduled_at` is blank or due. It atomically leases the row under `FOR UPDATE SKIP LOCKED` as `CLAIMED` with `claimed_at`, `claimed_by`, and `lease_expires_at`; an expired lease is recoverable.
- Sheet updates happen after database transitions. If a Sheet mirror write fails, Postgres remains authoritative and the workflow-level error path should alert the operator.
- `publish_status`: `PENDING` → `CLAIMED` → `UPLOADING` → `PROCESSING` → `PUBLISHED`; retryable failures use `RETRY_PENDING`; auth failures use `AUTH_REQUIRED`; permanent platform/content failures use `REJECTED` or `FAILED`.
- A retryable failure becomes `FAILED` at the configured maximum attempt count. WF14 must never leave an exhausted row stranded as `RETRY_PENDING`.
- `PUBLISHED` requires the platform's terminal processing check; an initialization response, upload receipt, or processing container is not sufficient. DIRECT YouTube and Meta also require a durable media `post_id`. POSTIZ requires its PUBLISHED state, exact saved identity and platform release URL; a missing platform `releaseId` leaves `post_id` blank. TikTok keeps its tracking `publish_id` only in `provider_ref`; `post_id` stays blank unless TikTok returns `publicaly_available_post_id`. TikTok inbox delivery uses `DRAFT_UPLOADED` and is not a public post.
- `video_source`: `LOCAL_FILE` when WF8c still has `/data/jobs/<render_id>/output.mp4`; otherwise `DRIVE`.
- `video_url` is the Google Drive/operator reference. `public_video_url` is the separate provider-fetchable HTTPS URL required by Facebook, Instagram, and TikTok. A Drive share URL does not become provider-fetchable merely because it opens in a browser.

---

## Status-Column State Machine (how workflows chain)

```
Candidate_Videos.processing_status:
  NEW ──(WF3 valid)──> validity_status=VALID
      ──(WF4 transcript ok)──> transcript_available=TRUE
      ──(WF5)──> ANALYZED or SKIPPED
Clip_Moments.ssemble_status:
  PENDING ──(WF6 yt-dlp start)──> SUBMITTED ──(WF6 download result)──> COMPLETED or ERROR
  AWAITING_MANUAL_APPROVAL ──(you set PENDING)──> picked up by WF6
Created_Clips.review_status:
  AWAITING_DOWNLOAD ──(WF8)──> NEEDS_REVIEW ──(you)──> APPROVED/REJECTED
Render_Jobs.render_status:
  PENDING ──(WF8c picked)──> DOWNLOADING_ASSETS
  DOWNLOADING_ASSETS ──(assets ready)──> RENDERING
  RENDERING ──(ffmpeg ok)──> UPLOADING
  UPLOADING ──(Drive upload ok)──> COMPLETED
  any step ──(hard failure)──> FAILED
Approved_For_Posting.status:
  APPROVED/READY + explicit platform ──(WF11)──> Publishing_Jobs rows
  PENDING/blank/unsupported platform ──> no job
Publishing_Jobs.publish_status:
  due PENDING ──(WF12 lease)──> CLAIMED ──> UPLOADING
  future scheduled_at ──> remains PENDING
  UPLOADING/PROCESSING ──(platform accepted)──> PUBLISHED or DRAFT_UPLOADED
  temporary failure ──> RETRY_PENDING ──(WF14 due)──> PENDING
  expired CLAIMED lease ──(recovery)──> PENDING
  auth problem ──> AUTH_REQUIRED
  policy/content rejection ──> REJECTED
  retry budget exhausted ──> FAILED
```

Fair-share processing:
- WF2 limits newly appended candidates to 5 per `source_id` per run.
- WF4 picks at most 2 transcript fetches per `source_id` per run, 10 total.
- WF5 picks at most 1 AI analysis per `source_id` per run, 5 total.
- WF6 downloads yt-dlp clips niche-first, then rotates channels inside each niche; a niche gets extra downloads only after other niches have no eligible pending moments left.
- WF8 processes awaiting downloads niche-first, then rotates channels inside each niche; a niche gets extra downloads only after other niches have no eligible clips left.
- When `source_id` lineage is missing, WF6/WF8 fall back to `niche` so older rows remain eligible without letting one unknown channel dominate.
- WF9 reports niches with no active channels left so you know when to add new sources or re-enable suitable paused channels.

Each workflow only reads rows in its input state and writes the next state. Re-runs are safe:
WF2 dedups on `youtube_video_id`; WF4/WF5/WF6 write via appendOrUpdate on deterministic keys
(`analysis_id`, `clip_moment_id`, `created_clip_id`); WF6 refuses to re-download any
`clip_moment_id` that already has `CC-<clip_moment_id>` or `YTDLP-<clip_moment_id>` in
`Created_Clips`; WF8 reuses already-uploaded Drive files instead of re-uploading; WF11 dedups
publishing jobs by deterministic `publish_id`.

## Seeding tips

- Start with 2–3 channels per niche, `priority=1`, `risk_level` honestly assessed
- Set `active_status=FALSE` to pause a channel without deleting it
- High `risk_level` channels require you to manually flip `AWAITING_MANUAL_APPROVAL` → `PENDING` in Clip_Moments before any provider download runs
