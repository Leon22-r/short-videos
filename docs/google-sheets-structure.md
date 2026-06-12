# Google Sheets Structure — Short-Form Video Pipeline

Create ONE Google Sheets workbook (the control center). Copy its document ID from the URL
(`https://docs.google.com/spreadsheets/d/<DOCUMENT_ID>/edit`) — this is the
`GOOGLE_SHEETS_DOCUMENT_ID` placeholder used in every workflow.

Create 8 tabs with EXACT names below. Paste each header row into cell A1 of the matching tab
(values are tab-separated — paste directly, Sheets splits them into columns).

---

## Tab 1: `Source_Channels`

```
source_id	niche	source_name	youtube_channel_url	youtube_channel_id	uploads_playlist_id	source_type	priority	risk_level	permission_risk	monetization_risk	notes	active_status	last_checked_at
```

Notes:
- `niche`: one of `CHRISTIAN_CONTENT`, `MOTIVATION_DISCIPLINE`, `FINANCE_BUSINESS`, `LIFE_VALUES_RELATIONSHIPS`, `AFRICAN_KENYAN_SUCCESS`
- `uploads_playlist_id` is an extra helper column (filled by WF1) — the channel's uploads playlist (`UU...`), used by WF2 to fetch videos cheaply (1 API unit instead of 100 for search)
- `risk_level` / `permission_risk` / `monetization_risk`: `low | medium | high`
- `active_status`: `TRUE` / `FALSE`
- `source_type`: e.g. `podcast`, `sermon_channel`, `interview_show`, `business_channel`
- This tab is human-maintained. You add rows; WF1 fills in `youtube_channel_id` + `uploads_playlist_id`.

## Tab 2: `Candidate_Videos`

```
video_id	niche	source_id	source_name	video_title	video_url	youtube_video_id	duration_seconds	published_at	view_count	like_count	comment_count	transcript_available	language	validity_status	validity_score	rejection_reason	duplicate_status	processing_status	created_at
```

Status values:
- `validity_status`: empty → `VALID` | `REJECTED` | `FLAGGED`
- `processing_status`: `NEW` → `ANALYZED` | `SKIPPED` | `CLIPPING` | `DONE`
- `duplicate_status`: `UNIQUE` | `DUPLICATE` (duplicates are never appended; column exists for manual entries)

## Tab 3: `Transcript_Analysis`

```
analysis_id	video_id	niche	video_title	video_url	transcript_status	transcript_text	transcript_length_words	ai_episode_score	recommended_strategy	recommended_start_sec	recommended_end_sec	reason_for_strategy	rights_risk	permission_risk	monetization_risk	originality_potential	kenya_relevance	ai_json_output	created_at
```

Status values:
- `transcript_status`: `FETCHED` | `FAILED` | `TRUNCATED` (transcript longer than sheet cell limit; stored truncated)
- `recommended_strategy`: `USE_20_MIN_WINDOW` | `USE_EXACT_CLIPS_ONLY` | `SKIP_THIS_VIDEO`
- Sheet cells max 50,000 chars — `transcript_text` is truncated to ~45,000 with marker `...[TRUNCATED]`

## Tab 4: `Clip_Moments`

```
clip_moment_id	video_id	niche	rank	start_sec	end_sec	clip_length_seconds	hook_first_2_seconds	core_idea	why_valuable	target_audience	suggested_title	suggested_caption	on_screen_text	suggested_broll	commentary_angle	kenyan_african_application	bible_verse_if_relevant	needs_extra_context	originality_score	clip_score	rights_risk	final_recommendation	ssemble_status	ssemble_job_id	strategy	source_video_url	created_at
```

Notes:
- `strategy` + `source_video_url` are helper columns so WF6 can build Ssemble requests without re-reading other tabs
- `ssemble_status`: `PENDING` → `SUBMITTED` → `COMPLETED` | `ERROR` | `AWAITING_MANUAL_APPROVAL` | `SKIPPED_BUDGET`
- `final_recommendation`: `clip` | `use_as_idea_only` | `skip`
- For `USE_20_MIN_WINDOW` strategy, ONE row is created representing the window (rank 0, start/end = window bounds)

## Tab 5: `Ssemble_Jobs`

```
ssemble_job_id	video_id	clip_moment_id	niche	source_video_url	start_sec	end_sec	request_payload	response_payload	job_status	webhook_received	error_message	created_at	completed_at
```

- `job_status`: `SUBMITTED` → `COMPLETED` | `FAILED` (processing failure reported by webhook); `SUBMIT_FAILED` = API call rejected, NO credit consumed
- One row per accepted Ssemble API call = one credit. Today's credit spend = today's rows excluding `SUBMIT_FAILED` (counted in Nairobi calendar days).

## Tab 6: `Created_Clips`

```
created_clip_id	ssemble_job_id	video_id	niche	clip_title	clip_url	local_file_name	google_drive_file_id	google_drive_url	duration_seconds	transcript_excerpt	suggested_title	suggested_caption	transformation_plan	review_status	reviewer_notes	created_at
```

- `review_status`: `AWAITING_DOWNLOAD` → `NEEDS_REVIEW` → `APPROVED` | `REJECTED` (you set the last two manually)
- `transformation_plan`: JSON from TRANSFORMATION_PLANNER prompt

## Tab 7: `Error_Log`

```
error_id	workflow_name	node_name	related_video_id	error_type	error_message	raw_payload	created_at
```

## Tab 8: `Approved_For_Posting`

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
```

Each workflow only reads rows in its input state and writes the next state. Re-runs are safe:
WF2 dedups on `youtube_video_id`; WF4/WF5/WF7 write via appendOrUpdate on deterministic keys
(`analysis_id`, `clip_moment_id`, `created_clip_id`); WF6 refuses to re-dispatch any
`clip_moment_id` that already has a non-`SUBMIT_FAILED` row in `Ssemble_Jobs`; WF8 reuses
already-uploaded Drive files instead of re-uploading.

## Seeding tips

- Start with 2–3 channels per niche, `priority=1`, `risk_level` honestly assessed
- Set `active_status=FALSE` to pause a channel without deleting it
- High `risk_level` channels require you to manually flip `AWAITING_MANUAL_APPROVAL` → `PENDING` in Clip_Moments before any Ssemble credit is spent
