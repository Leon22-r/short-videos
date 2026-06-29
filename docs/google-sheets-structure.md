# Google Sheets Structure — Short-Form Video Pipeline

Create ONE Google Sheets workbook (the control center). Copy its document ID from the URL
(`https://docs.google.com/spreadsheets/d/<DOCUMENT_ID>/edit`) — this is the
`GOOGLE_SHEETS_DOCUMENT_ID` placeholder used in every workflow.

Create 11 tabs with EXACT names below. Paste each header row into cell A1 of the matching tab
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
video_id	niche	source_id	source_name	video_title	video_url	youtube_video_id	duration_seconds	published_at	view_count	like_count	comment_count	transcript_available	language	validity_status	validity_score	rejection_reason	duplicate_status	processing_status	created_at
```

Status values:
- `validity_status`: empty → `VALID` | `REJECTED` | `FLAGGED`
- `processing_status`: `NEW` → `ANALYZED` | `SKIPPED` | `CLIPPING` | `DONE`
- `duplicate_status`: `UNIQUE` | `DUPLICATE` (duplicates are never appended; column exists for manual entries)
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
- `source_id`, `strategy`, and `source_video_url` are helper columns so WF6 can fairly dispatch Ssemble requests without re-reading other tabs
- `ssemble_status`: `PENDING` → `SUBMITTED` → `COMPLETED` | `ERROR` | `AWAITING_MANUAL_APPROVAL` | `SKIPPED_BUDGET`
- `final_recommendation`: `clip` | `use_as_idea_only` | `skip`
- For `USE_20_MIN_WINDOW` strategy, up to five rows can be created for one video. IDs use `CM-{video_id}-W0` through `CM-{video_id}-W4`, with rank matching the window index and start/end = window bounds.

## Tab 5: `Ssemble_Jobs`

```
ssemble_job_id	video_id	clip_moment_id	niche	source_id	source_video_url	start_sec	end_sec	request_payload	response_payload	job_status	webhook_received	error_message	created_at	completed_at
```

- `job_status`: `SUBMITTED` → `COMPLETED` | `FAILED` (processing failure reported by webhook); `SUBMIT_FAILED` = API call rejected, NO credit consumed
- One row per accepted Ssemble API call = one credit. Today's credit spend = today's rows excluding `SUBMIT_FAILED` (counted in Nairobi calendar days).
- `source_id` preserves channel lineage for downstream fair-share processing; WF8 falls back to `Clip_Moments` lineage for older rows.

## Tab 6: `Created_Clips`

```
created_clip_id	ssemble_job_id	video_id	niche	clip_title	clip_url	local_file_name	google_drive_file_id	google_drive_url	duration_seconds	transcript_excerpt	suggested_title	suggested_caption	content_thesis	hook	narration_script	commentary_angle	kenyan_african_localization	bible_verse_if_relevant	alternative_titles	on_screen_text_beats	broll_plan	editing_style	hashtags	cta	risk_warning	originality_checklist	transformation_plan	review_status	reviewer_notes	created_at
```

- `review_status`: `AWAITING_DOWNLOAD` → `NEEDS_REVIEW` → `APPROVED` | `REJECTED` (you set the last two manually)
- `suggested_title`, `suggested_caption`, `hashtags`, `hook`, `narration_script`, and related planning fields are readable columns for manual review and future posting workflows.
- `alternative_titles`, `on_screen_text_beats`, `broll_plan`, and `originality_checklist` are newline-separated text lists.
- `transformation_plan`: raw JSON from the WF8 transformation planner, kept as an audit/debug record.
- Existing rows that only have `transformation_plan` JSON can be backfilled once with WF8b `Created Clips Transform Backfill`.

## Tab 7: `Render_Jobs`

```
render_id	created_clip_id	niche	source_drive_file_id	source_drive_url	source_file_name	final_drive_folder_id	hook_text	cta_text	cta_start_second	cta_end_second	music_id	music_drive_file_id	music_file_name	music_volume	watermark_drive_file_id	watermark_file_name	progress_bar_color	use_blurred_background	ffmpeg_command	render_status	final_local_path	final_drive_file_id	final_drive_url	warning_message	error_message	created_at	started_at	completed_at
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
approved_id	created_clip_id	niche	platform	final_title	final_caption	final_description	hashtags	status	scheduled_date	posted_url	performance_notes
```

- Human-curated. You copy approved clips here manually (or via future workflow).
- `platform`: `YOUTUBE_SHORTS` | `TIKTOK` | `INSTAGRAM_REELS` | `FACEBOOK_REELS`

---

## Status-Column State Machine (how workflows chain)

```
Candidate_Videos.processing_status:
  NEW ──(WF3 valid)──> validity_status=VALID
      ──(WF4 transcript ok)──> transcript_available=TRUE
      ──(WF5)──> ANALYZED or SKIPPED
Clip_Moments.ssemble_status:
  PENDING ──(WF6)──> SUBMITTED ──(WF7 webhook)──> COMPLETED or ERROR
  PENDING ──(WF6 submit failure)──> ERROR (Ssemble_Jobs gets SUBMIT_FAILED row; reset to PENDING to retry)
  AWAITING_MANUAL_APPROVAL ──(you set PENDING)──> picked up by WF6
Created_Clips.review_status:
  AWAITING_DOWNLOAD ──(WF8)──> NEEDS_REVIEW ──(you)──> APPROVED/REJECTED
Render_Jobs.render_status:
  PENDING ──(WF8c picked)──> DOWNLOADING_ASSETS
  DOWNLOADING_ASSETS ──(assets ready)──> RENDERING
  RENDERING ──(ffmpeg ok)──> UPLOADING
  UPLOADING ──(Drive upload ok)──> COMPLETED
  any step ──(hard failure)──> FAILED
```

Fair-share processing:
- WF2 limits newly appended candidates to 5 per `source_id` per run.
- WF4 picks at most 2 transcript fetches per `source_id` per run, 10 total.
- WF5 picks at most 1 AI analysis per `source_id` per run, 5 total.
- WF6 spends Ssemble credits niche-first, then rotates channels inside each niche; a niche gets extra credits only after other niches have no eligible pending moments left.
- WF8 processes awaiting downloads niche-first, then rotates channels inside each niche; a niche gets extra downloads only after other niches have no eligible clips left.
- When `source_id` lineage is missing, WF6/WF8 fall back to `niche` so older rows remain eligible without letting one unknown channel dominate.
- WF9 reports niches with no active channels left so you know when to add new sources or re-enable suitable paused channels.

Each workflow only reads rows in its input state and writes the next state. Re-runs are safe:
WF2 dedups on `youtube_video_id`; WF4/WF5/WF7 write via appendOrUpdate on deterministic keys
(`analysis_id`, `clip_moment_id`, `created_clip_id`); WF6 refuses to re-dispatch any
`clip_moment_id` that already has a non-`SUBMIT_FAILED` row in `Ssemble_Jobs`; WF8 reuses
already-uploaded Drive files instead of re-uploading.

## Seeding tips

- Start with 2–3 channels per niche, `priority=1`, `risk_level` honestly assessed
- Set `active_status=FALSE` to pause a channel without deleting it
- High `risk_level` channels require you to manually flip `AWAITING_MANUAL_APPROVAL` → `PENDING` in Clip_Moments before any Ssemble credit is spent
