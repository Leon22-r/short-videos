# Postgres Schema — Short-Form Video Pipeline

The pipeline's state lives in the `short_videos` schema in Supabase; there is no
Google Sheets workbook.

Three notes before the tables:

- **The DDL is the source of truth, not this document.** Every table here is
  created by a numbered migration in `domains/short-videos/postgres/migrations/`.
  If the two disagree, the migration is right.
- **Migrations are replayed on every container start** by
  `hosts/shared/postgres/run-migrations.sh`, so each one is idempotent. A
  migration that is not replay-safe breaks every future boot.
- **Status values are CHECK constraints, not enums**, so adding a value is one
  `ALTER TABLE` rather than a typed migration.

---

## source_channels

Created by migration `004-pipeline-store-sources.sql`. The root channel registry and health ledger.

### Columns
| Column | Type | Default / Nullability | Description |
|---|---|---|---|
| `source_id` | `text` | `PRIMARY KEY` | Stable channel key (e.g. `ch_mychannel`) |
| `niche` | `text` | `NOT NULL` | Content niche |
| `source_name` | `text` | `NOT NULL` | Human-readable channel name |
| `youtube_channel_url` | `text` | `NOT NULL` | Canonical YouTube channel URL |
| `youtube_channel_id` | `text` | `NULL` | Resolved channel ID (`UC...`), filled by WF1 |
| `uploads_playlist_id` | `text` | `NULL` | Channel uploads playlist ID (`UU...`), filled by WF1 |
| `source_type` | `text` | `NULL` | Channel category (podcast, sermon, interview, etc.) |
| `priority` | `integer` | `NOT NULL DEFAULT 1` | Scheduling priority |
| `risk_level` | `text` | `NULL` | Assessed risk level |
| `permission_risk` | `text` | `NULL` | Copyright / permission risk |
| `monetization_risk` | `text` | `NULL` | Platform monetization risk |
| `notes` | `text` | `NULL` | Operator notes |
| `active_status` | `boolean` | `NOT NULL DEFAULT true` | Active flag; toggle to false to pause ingestion |
| `last_checked_at` | `timestamptz` | `NULL` | Last check timestamp |
| `backfill_next_page_token` | `text` | `NULL` | YouTube pagination token for historical uploads |
| `backfill_status` | `text` | `NOT NULL DEFAULT 'NOT_STARTED'` | Backfill progress status |
| `videos_known_count` | `integer` | `NULL` | Total video count reported by YouTube |
| `videos_fetched_count` | `integer` | `NOT NULL DEFAULT 0` | Videos fetched into candidate_videos so far |
| `backfill_last_run_at` | `timestamptz` | `NULL` | Timestamp of last backfill execution |
| `total_analyzed_count` | `integer` | `NOT NULL DEFAULT 0` | Total videos analyzed across channel history |
| `channel_skip_rate` | `numeric` | `NULL` | Ratio of skipped/rejected videos |
| `auto_paused_at` | `timestamptz` | `NULL` | Timestamp when channel was auto-paused due to high skip rate |
| `auto_paused_reason` | `text` | `NULL` | Reason channel was auto-paused |
| `health_reset_at` | `timestamptz` | `NULL` | Timestamp when health stats were last reset |
| `created_at` | `timestamptz` | `NOT NULL DEFAULT now()` | Row creation timestamp |

### Constraints & Checks
- `source_channels_niche_check`: `niche IN ('CHRISTIAN_CONTENT', 'MOTIVATION_DISCIPLINE', 'FINANCE_BUSINESS', 'LIFE_VALUES_RELATIONSHIPS', 'AFRICAN_KENYAN_SUCCESS')`
- `source_channels_risk_level_check`: `risk_level IS NULL OR risk_level IN ('low', 'medium', 'high')`
- `source_channels_permission_risk_check`: `permission_risk IS NULL OR permission_risk IN ('low', 'medium', 'high')`
- `source_channels_monetization_risk_check`: `monetization_risk IS NULL OR monetization_risk IN ('low', 'medium', 'high')`
- `source_channels_backfill_status_check`: `backfill_status IN ('NOT_STARTED', 'IN_PROGRESS', 'COMPLETE')`

### Workflows
- **Written by**: Human operator / Review UI (channel creation), WF1 (resolves channel URLs to IDs), WF2 (updates backfill state and fetched counts), WF5 (updates health metrics and auto-pause status).
- **Read by**: WF1 (unresolved channels), WF2 (video fetching), WF4/WF5/WF6/WF8 (fair-share rotation), WF9 (inactive niche alerts).

---

## candidate_videos

Created by migration `004-pipeline-store-sources.sql`. Ingested candidate videos evaluated for clipping suitability.

### Columns
| Column | Type | Default / Nullability | Description |
|---|---|---|---|
| `video_id` | `text` | `PRIMARY KEY` | Stable unique video identifier |
| `niche` | `text` | `NOT NULL` | Content niche |
| `source_id` | `text` | `REFERENCES short_videos.source_channels(source_id) ON DELETE SET NULL` | Parent channel |
| `source_name` | `text` | `NULL` | Cached channel name |
| `video_title` | `text` | `NULL` | YouTube video title |
| `video_url` | `text` | `NULL` | Watch URL |
| `youtube_video_id` | `text` | `NOT NULL` | 11-char YouTube video ID |
| `duration_seconds` | `integer` | `NULL` | Video length in seconds |
| `published_at` | `timestamptz` | `NULL` | YouTube publication timestamp |
| `view_count` | `bigint` | `NULL` | View count |
| `like_count` | `bigint` | `NULL` | Like count |
| `comment_count` | `bigint` | `NULL` | Comment count |
| `like_percentage` | `numeric` | `NULL` | likes / views |
| `comment_percentage` | `numeric` | `NULL` | comments / views |
| `engagement_percentage` | `numeric` | `NULL` | (likes + comments) / views |
| `transcript_available` | `boolean` | `NULL` | True when transcript is verified |
| `language` | `text` | `NULL` | Language code |
| `validity_status` | `text` | `NULL` | Ingestion filter outcome |
| `validity_score` | `numeric` | `NULL` | Quality score |
| `rejection_reason` | `text` | `NULL` | Reason rejected by WF3 |
| `duplicate_status` | `text` | `NULL` | Duplicate evaluation |
| `processing_status` | `text` | `NOT NULL DEFAULT 'NEW'` | Pipeline progression status |
| `created_at` | `timestamptz` | `NOT NULL DEFAULT now()` | Ingestion timestamp |

### Constraints & Checks
- `candidate_videos_niche_check`: `niche IN ('CHRISTIAN_CONTENT', 'MOTIVATION_DISCIPLINE', 'FINANCE_BUSINESS', 'LIFE_VALUES_RELATIONSHIPS', 'AFRICAN_KENYAN_SUCCESS')`
- `candidate_videos_validity_status_check`: `validity_status IS NULL OR validity_status IN ('VALID', 'REJECTED', 'FLAGGED')`
- `candidate_videos_duplicate_status_check`: `duplicate_status IS NULL OR duplicate_status IN ('UNIQUE', 'DUPLICATE')`
- `candidate_videos_processing_status_check`: `processing_status IN ('NEW', 'ANALYZED', 'SKIPPED', 'CLIPPING', 'DONE')`

### Indexes
- `candidate_videos_pending_idx`: `(processing_status, source_id) WHERE processing_status = 'NEW'`
- `candidate_videos_youtube_video_id_idx`: `(youtube_video_id)`

### Workflows
- **Written by**: WF2 (inserts new candidates), WF3 (evaluates validity and engagement metrics), WF4 (flags transcript availability), WF5 (advances `processing_status` to `ANALYZED` or `SKIPPED`).
- **Read by**: WF3 (selects `NEW` candidates), WF4 (selects valid candidates), WF5.

---

## transcript_analysis

Created by migration `005-pipeline-store-analysis.sql`. Transcripts fetched by Lambda and analyzed by OpenAI.

### Columns
| Column | Type | Default / Nullability | Description |
|---|---|---|---|
| `analysis_id` | `text` | `PRIMARY KEY` | Deterministic analysis identifier |
| `video_id` | `text` | `REFERENCES short_videos.candidate_videos(video_id) ON DELETE CASCADE` | Source video |
| `niche` | `text` | `NOT NULL` | Content niche |
| `source_id` | `text` | `REFERENCES short_videos.source_channels(source_id) ON DELETE SET NULL` | Source channel |
| `video_title` | `text` | `NULL` | Video title |
| `video_url` | `text` | `NULL` | Video URL |
| `transcript_status` | `text` | `NULL` | Status of transcript fetch (`FETCHED`, `FAILED`) |
| `transcript_text` | `text` | `NULL` | Full transcript text (unbounded text, no truncation) |
| `transcript_length_words` | `integer` | `NULL` | Word count |
| `ai_episode_score` | `numeric` | `NULL` | Overall AI score (1-10) |
| `recommended_strategy` | `text` | `NULL` | Recommended clipping strategy |
| `recommended_start_sec` | `integer` | `NULL` | Optional recommended window start second |
| `recommended_end_sec` | `integer` | `NULL` | Optional recommended window end second |
| `reason_for_strategy` | `text` | `NULL` | AI justification for strategy |
| `rights_risk` | `text` | `NULL` | Risk assessment |
| `permission_risk` | `text` | `NULL` | Permission assessment |
| `monetization_risk` | `text` | `NULL` | Monetization risk assessment |
| `originality_potential` | `text` | `NULL` | Originality rating |
| `kenya_relevance` | `text` | `NULL` | Localization rating |
| `ai_json_output` | `jsonb` | `NULL` | Full structured JSON output from OpenAI |
| `created_at` | `timestamptz` | `NOT NULL DEFAULT now()` | Creation timestamp |

### Constraints & Checks
- `transcript_analysis_status_check`: `transcript_status IS NULL OR transcript_status IN ('FETCHED', 'FAILED')`
- `transcript_analysis_strategy_check`: `recommended_strategy IS NULL OR recommended_strategy IN ('USE_20_MIN_WINDOW', 'USE_EXACT_CLIPS_ONLY', 'SKIP_THIS_VIDEO')`

### Workflows
- **Written by**: WF4 (inserts transcript fetch result), WF5 (updates AI analysis scores and strategies).
- **Read by**: WF5.

---

## clip_moments

Created by migration `005-pipeline-store-analysis.sql`. Potential short-form video moments identified from transcript analysis.

### Columns
| Column | Type | Default / Nullability | Description |
|---|---|---|---|
| `clip_moment_id` | `text` | `PRIMARY KEY` | Deterministic moment identifier |
| `video_id` | `text` | `REFERENCES short_videos.candidate_videos(video_id) ON DELETE CASCADE` | Source video |
| `niche` | `text` | `NOT NULL` | Content niche |
| `source_id` | `text` | `REFERENCES short_videos.source_channels(source_id) ON DELETE SET NULL` | Source channel |
| `rank` | `integer` | `NULL` | Rank within episode |
| `start_sec` | `integer` | `NULL` | Start timestamp in seconds |
| `end_sec` | `integer` | `NULL` | End timestamp in seconds |
| `clip_length_seconds` | `integer` | `NULL` | Calculated duration |
| `hook_first_2_seconds` | `text` | `NULL` | Hook script / opening beat |
| `core_idea` | `text` | `NULL` | Core premise |
| `why_valuable` | `text` | `NULL` | Value proposition |
| `target_audience` | `text` | `NULL` | Target audience description |
| `suggested_title` | `text` | `NULL` | Initial title idea |
| `suggested_caption` | `text` | `NULL` | Initial caption idea |
| `on_screen_text` | `text` | `NULL` | On-screen text plan |
| `suggested_broll` | `text` | `NULL` | Suggested B-roll |
| `commentary_angle` | `text` | `NULL` | Commentary perspective |
| `kenyan_african_application` | `text` | `NULL` | African/Kenyan localization angle |
| `bible_verse_if_relevant` | `text` | `NULL` | Bible reference if relevant |
| `needs_extra_context` | `boolean` | `NULL` | Context requirement flag |
| `originality_score` | `numeric` | `NULL` | Originality score |
| `clip_score` | `numeric` | `NULL` | Composite clip score |
| `rights_risk` | `text` | `NULL` | Rights risk |
| `final_recommendation` | `text` | `NULL` | Final AI recommendation |
| `download_status` | `text` | `NOT NULL DEFAULT 'PENDING'` | Ingestion download status |
| `download_job_id` | `text` | `NULL` | Identifier for downloader execution |
| `error_message` | `text` | `NULL` | Error details from yt-dlp stderr if download fails |
| `strategy` | `text` | `NULL` | Selection strategy |
| `source_video_url` | `text` | `NULL` | Video URL for direct yt-dlp download |
| `created_at` | `timestamptz` | `NOT NULL DEFAULT now()` | Creation timestamp |

### Constraints & Checks
- `clip_moments_download_status_check`: `download_status IN ('PENDING', 'SUBMITTED', 'COMPLETED', 'ERROR', 'AWAITING_MANUAL_APPROVAL')`
- `clip_moments_recommendation_check`: `final_recommendation IS NULL OR final_recommendation IN ('clip', 'use_as_idea_only', 'skip')`

### Indexes
- `clip_moments_awaiting_approval_idx`: `(niche) WHERE download_status = 'AWAITING_MANUAL_APPROVAL'`

### Workflows
- **Written by**: WF5 (inserts extracted clip moments), WF6 (updates `download_status` to `SUBMITTED`, then `COMPLETED` or `ERROR`, records `error_message`), Review UI (promotes `AWAITING_MANUAL_APPROVAL` to `PENDING`).
- **Read by**: WF6 (selects eligible clips for yt-dlp download), Review UI (Screen 3: Awaiting Approval).

---

## created_clips

Created by migration `006-pipeline-store-clips.sql`. Downloaded source clips transformed and prepared for operator review.

### Columns
| Column | Type | Default / Nullability | Description |
|---|---|---|---|
| `created_clip_id` | `text` | `PRIMARY KEY` | Clip ID (`CC-<clip_moment_id>`) |
| `download_job_id` | `text` | `NULL` | Download job identifier (`YTDLP-<clip_moment_id>`) |
| `video_id` | `text` | `REFERENCES short_videos.candidate_videos(video_id) ON DELETE SET NULL` | Source video |
| `clip_moment_id` | `text` | `REFERENCES short_videos.clip_moments(clip_moment_id) ON DELETE SET NULL` | Parent clip moment |
| `niche` | `text` | `NOT NULL` | Content niche |
| `clip_title` | `text` | `NULL` | Working clip title |
| `clip_url` | `text` | `NULL` | Operator link |
| `local_file_name` | `text` | `NULL` | Temporary local filename |
| `google_drive_file_id` | `text` | `NULL` | Source clip Google Drive file ID |
| `google_drive_url` | `text` | `NULL` | Source clip Google Drive view URL |
| `duration_seconds` | `integer` | `NULL` | Actual duration |
| `transcript_excerpt` | `text` | `NULL` | Transcript snippet for this segment |
| `suggested_title` | `text` | `NULL` | Refined suggested title |
| `suggested_caption` | `text` | `NULL` | Refined suggested caption |
| `content_thesis` | `text` | `NULL` | Core editorial thesis |
| `hook` | `text` | `NULL` | Spoken hook / caption hook |
| `narration_script` | `text` | `NULL` | Script text |
| `commentary_angle` | `text` | `NULL` | Angle of added commentary |
| `kenyan_african_localization` | `text` | `NULL` | Localization guidance |
| `bible_verse_if_relevant` | `text` | `NULL` | Scriptural reference |
| `alternative_titles` | `text[]` | `NULL` | List of alternative title options |
| `on_screen_text_beats` | `text[]` | `NULL` | Timed on-screen text beats |
| `broll_plan` | `text[]` | `NULL` | B-roll insertion instructions |
| `editing_style` | `text` | `NULL` | Editing aesthetic notes |
| `hashtags` | `text[]` | `NULL` | Recommended hashtag list |
| `cta` | `text` | `NULL` | Call to action |
| `risk_warning` | `text` | `NULL` | Editorial risk notice |
| `originality_checklist` | `text[]` | `NULL` | Checklist items for originality compliance |
| `transformation_plan` | `jsonb` | `NULL` | Full parsed transformation plan JSON |
| `review_status` | `text` | `NOT NULL DEFAULT 'AWAITING_DOWNLOAD'` | Review workflow state |
| `reviewer_notes` | `text` | `NULL` | Notes added during human review |
| `created_at` | `timestamptz` | `NOT NULL DEFAULT now()` | Row creation timestamp |

### Constraints & Checks
- `created_clips_review_status_check`: `review_status IN ('AWAITING_DOWNLOAD', 'NEEDS_RETRY', 'NEEDS_REVIEW', 'APPROVED', 'REJECTED')`

### Indexes
- `created_clips_needs_review_idx`: `(created_at) WHERE review_status = 'NEEDS_REVIEW'`

### Workflows
- **Written by**: WF6 (inserts row upon clip download), WF8 (uploads to Drive, generates transformation plan, sets `NEEDS_REVIEW` or `NEEDS_RETRY`), Review UI via `approve_clip()` or `reject_clip()` RPCs.
- **Read by**: WF8 (selects `AWAITING_DOWNLOAD`), WF9 (reads `NEEDS_REVIEW` for digest email), Review UI (Screen 1: Review Queue).

---

## render_jobs

Created by migration `006-pipeline-store-clips.sql`. Final video render jobs dispatched to FFmpeg.

### Columns
| Column | Type | Default / Nullability | Description |
|---|---|---|---|
| `render_id` | `text` | `PRIMARY KEY` | Render job identifier |
| `created_clip_id` | `text` | `REFERENCES short_videos.created_clips(created_clip_id) ON DELETE CASCADE` | Source clip |
| `niche` | `text` | `NOT NULL` | Content niche |
| `source_drive_file_id` | `text` | `NULL` | Source clip Drive file ID |
| `source_drive_url` | `text` | `NULL` | Source clip Drive URL |
| `source_file_name` | `text` | `NULL` | Source filename |
| `final_drive_folder_id` | `text` | `NULL` | Destination folder on Drive |
| `hook_text` | `text` | `NULL` | Opening text overlay |
| `cta_text` | `text` | `NULL` | Closing CTA text overlay |
| `cta_start_second` | `numeric` | `NULL` | CTA overlay start time |
| `cta_end_second` | `numeric` | `NULL` | CTA overlay end time |
| `music_mood` | `text` | `NULL` | Matched music mood |
| `music_energy_level` | `text` | `NULL` | Matched music energy level |
| `music_id` | `text` | `NULL` | Selected music library track ID |
| `music_drive_file_id` | `text` | `NULL` | Background music Drive file ID |
| `music_file_name` | `text` | `NULL` | Background music filename |
| `music_volume` | `numeric` | `NULL` | Background music mix volume (clamped 0.04-0.14) |
| `watermark_drive_file_id` | `text` | `NULL` | Watermark image Drive file ID |
| `watermark_file_name` | `text` | `NULL` | Watermark filename |
| `progress_bar_color` | `text` | `NULL` | Progress bar hex color in `0xRRGGBB` format |
| `use_blurred_background` | `boolean` | `NULL` | Whether to apply 9:16 blurred background |
| `ffmpeg_command` | `text` | `NULL` | Generated FFmpeg command string |
| `render_status` | `text` | `NOT NULL DEFAULT 'PENDING'` | Render execution state |
| `final_local_path` | `text` | `NULL` | Rendered output local path on heavy host |
| `final_drive_file_id` | `text` | `NULL` | Rendered MP4 Google Drive file ID |
| `final_drive_url` | `text` | `NULL` | Rendered MP4 Google Drive view URL |
| `warning_message` | `text` | `NULL` | Non-fatal warnings (e.g. music omitted) |
| `error_message` | `text` | `NULL` | Fatal error details |
| `created_at` | `timestamptz` | `NOT NULL DEFAULT now()` | Creation timestamp |
| `started_at` | `timestamptz` | `NULL` | Execution start timestamp |
| `completed_at` | `timestamptz` | `NULL` | Completion timestamp |

### Constraints & Checks
- `render_jobs_render_status_check`: `render_status IN ('PENDING', 'DOWNLOADING_ASSETS', 'RENDERING', 'UPLOADING', 'COMPLETED', 'FAILED', 'SKIPPED')`

### Workflows
- **Written by**: WF8 (creates pending render job), WF8c (executes asset download, FFmpeg render, Drive upload, and status progression).
- **Read by**: WF8c (picks pending jobs), WF11 (matches completed renders), Review UI (previews final renders).

---

## music_library

Created by migration `007-pipeline-store-assets.sql`. Background music catalog indexed by niche, mood, and energy level.

### Columns
| Column | Type | Default / Nullability | Description |
|---|---|---|---|
| `music_id` | `text` | `PRIMARY KEY` | Unique track ID |
| `niche` | `text` | `NULL` | Associated niche |
| `mood` | `text` | `NULL` | Track mood |
| `energy_level` | `text` | `NULL` | Track energy level |
| `track_name` | `text` | `NULL` | Track title |
| `artist_name` | `text` | `NULL` | Artist name |
| `source` | `text` | `NULL` | Source library |
| `source_url` | `text` | `NULL` | Source URL |
| `license_notes` | `text` | `NULL` | License details |
| `drive_file_id` | `text` | `NULL` | Google Drive file ID of audio file |
| `duration_seconds` | `integer` | `NULL` | Track length |
| `recommended_volume` | `numeric` | `NULL` | Suggested volume |
| `loop_allowed` | `boolean` | `NULL` | Whether track can be looped |
| `active_status` | `boolean` | `NOT NULL DEFAULT true` | Availability flag |
| `times_used` | `integer` | `NOT NULL DEFAULT 0` | Usage counter |
| `created_at` | `timestamptz` | `NOT NULL DEFAULT now()` | Creation timestamp |
| `last_used_at` | `timestamptz` | `NULL` | Last usage timestamp |
| `notes` | `text` | `NULL` | Catalog notes |

### Indexes
- `music_library_selection_idx`: `(niche, mood, energy_level) WHERE active_status`

### Workflows
- **Written by**: Human operator / asset seed scripts.
- **Read by**: WF8c (queries active tracks matching clip criteria).

---

## channel_branding

Created by migration `007-pipeline-store-assets.sql`. Visual and audio branding configuration per niche.

### Columns
| Column | Type | Default / Nullability | Description |
|---|---|---|---|
| `branding_id` | `text` | `PRIMARY KEY DEFAULT gen_random_uuid()::text` | Surrogate branding key |
| `niche` | `text` | `NOT NULL` | Associated niche |
| `watermark_drive_file_id` | `text` | `NULL` | Google Drive file ID of watermark PNG |
| `primary_color` | `text` | `NULL` | Primary brand color |
| `secondary_color` | `text` | `NULL` | Secondary brand color |
| `progress_bar_color` | `text` | `NULL` | Progress bar color formatted as `0xRRGGBB` |
| `default_cta` | `text` | `NULL` | Default call to action text |
| `music_default_id` | `text` | `REFERENCES short_videos.music_library(music_id) ON DELETE SET NULL` | Fallback music track ID |
| `active_status` | `boolean` | `NOT NULL DEFAULT true` | Active flag |
| `notes` | `text` | `NULL` | Operator notes |
| `created_at` | `timestamptz` | `NOT NULL DEFAULT now()` | Creation timestamp |

### Constraints & Checks
- `channel_branding_progress_bar_color_check`: `progress_bar_color IS NULL OR progress_bar_color ~ '^0x[0-9A-Fa-f]{6}$'`

### Indexes
- `channel_branding_one_active_per_niche_idx`: UNIQUE `(niche) WHERE active_status`

### Workflows
- **Written by**: Human operator / asset configuration.
- **Read by**: WF8c (fetches watermark, progress bar color, and default music for render).

---

## error_log

Created by migration `007-pipeline-store-assets.sql`. Central error ledger for workflow failures.

### Columns
| Column | Type | Default / Nullability | Description |
|---|---|---|---|
| `error_id` | `text` | `PRIMARY KEY` | Unique error identifier |
| `workflow_name` | `text` | `NULL` | Name of workflow where error occurred |
| `node_name` | `text` | `NULL` | Name of node that failed |
| `related_video_id` | `text` | `NULL` | Video ID involved in failure, if applicable |
| `error_type` | `text` | `NULL` | Error classification |
| `error_message` | `text` | `NULL` | Error description / stack trace |
| `raw_payload` | `jsonb` | `NULL` | Raw error payload / node context |
| `created_at` | `timestamptz` | `NOT NULL DEFAULT now()` | Error timestamp |

### Indexes
- `error_log_recent_idx`: `(created_at DESC)`

### Workflows
- **Written by**: WF10 (`Error Handler`).
- **Read by**: Human operator, debugging scripts, monitoring alerts.

---

## approved_for_posting

Created by migration `008-pipeline-store-publishing.sql`. Curated approvals authorizing publishing jobs.

### Columns
| Column | Type | Default / Nullability | Description |
|---|---|---|---|
| `approved_id` | `text` | `PRIMARY KEY` | Approval ID (`APPROVE-<created_clip_id>`) |
| `created_clip_id` | `text` | `NOT NULL REFERENCES short_videos.created_clips(created_clip_id) ON DELETE CASCADE` | Source clip |
| `render_id` | `text` | `REFERENCES short_videos.render_jobs(render_id) ON DELETE SET NULL` | Rendered output ID |
| `niche` | `text` | `NOT NULL` | Content niche |
| `platforms` | `text[]` | `NOT NULL` | Target publishing platforms |
| `final_title` | `text` | `NOT NULL` | Final approved title |
| `final_caption` | `text` | `NULL` | Final approved caption |
| `final_description` | `text` | `NULL` | Final approved description |
| `hashtags` | `text[]` | `NULL` | Final approved hashtags |
| `status` | `text` | `NOT NULL DEFAULT 'PENDING'` | Approval state |
| `scheduled_at` | `timestamptz` | `NULL` | Optional future publishing schedule |
| `public_video_url` | `text` | `NULL` | Provider-fetchable HTTPS URL for Meta / TikTok |
| `posted_url` | `text` | `NULL` | Public post URL once published |
| `performance_notes` | `text` | `NULL` | Post-publication analytics notes |
| `created_at` | `timestamptz` | `NOT NULL DEFAULT now()` | Approval timestamp |

### Constraints & Checks
- `approved_for_posting_status_check`: `status IN ('PENDING', 'APPROVED', 'READY', 'REJECTED')`
- `approved_for_posting_platforms_present_check`: `cardinality(platforms) > 0`
- `approved_for_posting_platforms_supported_check`: `platforms <@ ARRAY['YOUTUBE_SHORTS', 'TIKTOK', 'INSTAGRAM_REELS', 'FACEBOOK_REELS']`

### Indexes
- `approved_for_posting_one_per_clip_idx`: UNIQUE `(created_clip_id)`

### Workflows
- **Written by**: Review UI via `short_videos.approve_clip()` RPC (or manual operator entry).
- **Read by**: WF11 (reads `APPROVED` or `READY` approvals to generate publishing jobs).

---

## publishing_channels

Created by migration `008-pipeline-store-publishing.sql`. Destination channel and account configurations for publishing.

### Columns
| Column | Type | Default / Nullability | Description |
|---|---|---|---|
| `channel_id` | `text` | `PRIMARY KEY` | Destination channel key |
| `niche` | `text` | `NOT NULL` | Content niche |
| `platform` | `text` | `NOT NULL` | Platform name |
| `enabled_status` | `boolean` | `NOT NULL DEFAULT false` | Enablement flag |
| `publishing_backend` | `text` | `NOT NULL DEFAULT 'DIRECT'` | Backend (`DIRECT` or `POSTIZ`) |
| `postiz_integration_id` | `text` | `NULL` | Postiz integration identifier |
| `credential_name` | `text` | `NULL` | Human reminder label |
| `credential_slot` | `text` | `NULL` | Slot binding (`*_PRIMARY`) |
| `youtube_channel_id` | `text` | `NULL` | YouTube destination channel ID |
| `facebook_page_id` | `text` | `NULL` | Facebook page ID |
| `instagram_user_id` | `text` | `NULL` | Instagram professional account user ID |
| `tiktok_open_id` | `text` | `NULL` | TikTok open ID |
| `meta_graph_version` | `text` | `NULL` | Graph API version (`vNN.N`) |
| `instagram_graph_host` | `text` | `DEFAULT 'graph.facebook.com'` | Instagram Graph host |
| `tiktok_domain_verified` | `boolean` | `NOT NULL DEFAULT false` | Domain verification confirmation |
| `tiktok_verified_url_prefix` | `text` | `NULL` | Non-redirecting verified HTTPS prefix |
| `default_privacy` | `text` | `NOT NULL DEFAULT 'private'` | Default post visibility |
| `requires_manual_publish` | `boolean` | `NOT NULL DEFAULT false` | True for TikTok draft upload |
| `audit_status` | `text` | `NULL` | Destination review status |
| `token_expires_at` | `timestamptz` | `NULL` | Token expiration timestamp |
| `last_expiry_audit_at` | `timestamptz` | `NULL` | Timestamp of last health check |
| `last_health_status` | `text` | `NULL` | Health assessment string |
| `notes` | `text` | `NULL` | Channel notes |
| `created_at` | `timestamptz` | `NOT NULL DEFAULT now()` | Creation timestamp |
| `updated_at` | `timestamptz` | `NOT NULL DEFAULT now()` | Update timestamp |

### Constraints & Checks
- `publishing_channels_platform_check`: `platform IN ('YOUTUBE_SHORTS', 'FACEBOOK_REELS', 'INSTAGRAM_REELS', 'TIKTOK')`
- `publishing_channels_backend_check`: `publishing_backend IN ('DIRECT', 'POSTIZ')`
- `publishing_channels_credential_slot_check`: `credential_slot IS NULL OR credential_slot IN ('YOUTUBE_PRIMARY', 'FACEBOOK_PRIMARY', 'INSTAGRAM_PRIMARY', 'TIKTOK_PRIMARY', 'POSTIZ_PRIMARY')`
- `publishing_channels_audit_status_check`: `audit_status IS NULL OR audit_status IN ('DEV_PRIVATE_ONLY', 'APPROVED_PUBLIC', 'NEEDS_REVIEW')`
- `publishing_channels_graph_host_check`: `instagram_graph_host IS NULL OR instagram_graph_host IN ('graph.facebook.com', 'graph.instagram.com')`
- `publishing_channels_meta_version_check`: `meta_graph_version IS NULL OR meta_graph_version ~ '^v[0-9]+\.[0-9]+$'`
- `publishing_channels_tiktok_manual_check`: `platform <> 'TIKTOK' OR requires_manual_publish`
- `publishing_channels_postiz_identity_check`: `publishing_backend <> 'POSTIZ' OR (postiz_integration_id IS NOT NULL AND btrim(postiz_integration_id) <> '')`

### Indexes
- `publishing_channels_enabled_idx`: `(niche, platform) WHERE enabled_status`

### Workflows
- **Written by**: Human operator (channel configuration), WF13 (records daily expiry audits).
- **Read by**: WF11 (matches approved clips to destinations), WF13.

---

## publishing_jobs

Created by migration `001-publishing-queue.sql`, extended by `002`, `003`, and `009`. The transactional multi-worker publishing queue.

### Columns
| Column | Type | Default / Nullability | Description |
|---|---|---|---|
| `publish_id` | `text` | `PRIMARY KEY` | Deterministic job ID (`PUB_<render_id>_<platform>_<channel_id>`) |
| `approved_id` | `text` | `NULL` | Source approval ID |
| `render_id` | `text` | `NULL` | Source render ID |
| `created_clip_id` | `text` | `NULL` | Source clip ID |
| `niche` | `text` | `NULL` | Content niche |
| `platform` | `text` | `NOT NULL` | Publishing platform |
| `channel_id` | `text` | `NULL` | Target publishing channel |
| `destination_id` | `text` | `NULL` | Provider account or Postiz integration ID |
| `youtube_channel_id` | `text` | `NULL` | YouTube channel ID |
| `facebook_page_id` | `text` | `NULL` | Facebook Page ID |
| `instagram_user_id` | `text` | `NULL` | Instagram user ID |
| `tiktok_open_id` | `text` | `NULL` | TikTok open ID |
| `credential_slot` | `text` | `NULL` | Bound credential slot |
| `meta_graph_version` | `text` | `NULL` | Graph API version |
| `instagram_graph_host` | `text` | `DEFAULT 'graph.facebook.com'` | Instagram Graph host |
| `tiktok_domain_verified` | `boolean` | `NOT NULL DEFAULT false` | Domain verification confirmation |
| `tiktok_verified_url_prefix` | `text` | `NULL` | Verified URL prefix |
| `default_privacy` | `text` | `NOT NULL DEFAULT 'private'` | Post privacy |
| `requires_manual_publish` | `boolean` | `NOT NULL DEFAULT false` | Manual publish flag |
| `audit_status` | `text` | `NULL` | Audit status |
| `tiktok_mode` | `text` | `NOT NULL DEFAULT 'DIRECT'` | TikTok integration mode |
| `publishing_backend` | `text` | `NOT NULL DEFAULT 'DIRECT'` | Publishing backend (`DIRECT` or `POSTIZ`) |
| `postiz_integration_id` | `text` | `NULL` | Postiz integration identifier |
| `postiz_post_id` | `text` | `NULL` | Postiz post identifier |
| `postiz_media_id` | `text` | `NULL` | Postiz media identifier |
| `postiz_media_path` | `text` | `NULL` | Local path to media uploaded to Postiz |
| `postiz_submit_payload` | `jsonb` | `NOT NULL DEFAULT '{}'::jsonb` | Full payload submitted to Postiz |
| `postiz_submitted_at` | `timestamptz` | `NULL` | Intent timestamp of Postiz submission |
| `video_source` | `text` | `NULL` | Video source (`LOCAL_FILE` or `DRIVE`) |
| `video_file_id` | `text` | `NULL` | Drive file ID of video |
| `video_url` | `text` | `NULL` | Drive view URL of video |
| `public_video_url` | `text` | `NULL` | Public HTTPS URL for remote provider pull |
| `local_file_path` | `text` | `NULL` | Host filesystem path to local MP4 |
| `title` | `text` | `NULL` | Final post title |
| `caption` | `text` | `NULL` | Final post caption |
| `description` | `text` | `NULL` | Final post description |
| `hashtags` | `text` | `NULL` | Final post hashtags |
| `scheduled_at` | `timestamptz` | `NULL` | Target publication schedule |
| `publish_status` | `text` | `NOT NULL DEFAULT 'PENDING'` | State in publishing lifecycle |
| `retry_count` | `integer` | `NOT NULL DEFAULT 0` | Retry attempts counter |
| `next_retry_at` | `timestamptz` | `NULL` | Earliest time for next retry |
| `last_error` | `text` | `NULL` | Last error message encountered |
| `post_id` | `text` | `NULL` | Durable platform post ID once published |
| `post_url` | `text` | `NULL` | Public post URL |
| `provider_stage` | `text` | `NULL` | Provider protocol checkpoint |
| `provider_ref` | `text` | `NULL` | Provider reference / container ID |
| `provider_upload_url` | `text` | `NULL` | Resumable upload session URL (unlogged) |
| `provider_response` | `jsonb` | `NOT NULL DEFAULT '{}'::jsonb` | Last raw provider API response |
| `poll_after` | `timestamptz` | `NULL` | Next polling timestamp |
| `provider_poll_count` | `integer` | `NOT NULL DEFAULT 0` | Poll attempts counter |
| `provider_poll_deadline` | `timestamptz` | `NULL` | Maximum deadline for polling completion |
| `payload` | `jsonb` | `NOT NULL DEFAULT '{}'::jsonb` | Custom job payload |
| `started_at` | `timestamptz` | `NULL` | Lease start timestamp |
| `completed_at` | `timestamptz` | `NULL` | Terminal completion timestamp |
| `claimed_at` | `timestamptz` | `NULL` | Timestamp row was claimed by worker |
| `claimed_by` | `text` | `NULL` | Worker execution identifier ($execution.id) |
| `lease_expires_at` | `timestamptz` | `NULL` | Lease expiration timestamp |
| `created_at` | `timestamptz` | `NOT NULL DEFAULT now()` | Row creation timestamp |
| `updated_at` | `timestamptz` | `NOT NULL DEFAULT now()` | Last update timestamp |

### Constraints & Checks
- `publishing_jobs_platform_check`: `platform IN ('YOUTUBE_SHORTS', 'FACEBOOK_REELS', 'INSTAGRAM_REELS', 'TIKTOK')`
- `publishing_jobs_status_check`: `publish_status IN ('PENDING', 'CLAIMED', 'UPLOADING', 'PROCESSING', 'PUBLISHED', 'DRAFT_UPLOADED', 'RETRY_PENDING', 'AUTH_REQUIRED', 'REJECTED', 'FAILED', 'SKIPPED')`
- `publishing_jobs_backend_check`: `publishing_backend IN ('DIRECT', 'POSTIZ')`
- `publishing_jobs_platform_destination_check`:
  `(publishing_backend = 'POSTIZ' AND COALESCE(btrim(postiz_integration_id), '') <> '') OR (publishing_backend = 'DIRECT' AND ((platform = 'YOUTUBE_SHORTS' AND COALESCE(youtube_channel_id, '') <> '') OR (platform = 'FACEBOOK_REELS' AND COALESCE(facebook_page_id, '') <> '') OR (platform = 'INSTAGRAM_REELS' AND COALESCE(instagram_user_id, '') <> '') OR (platform = 'TIKTOK' AND COALESCE(tiktok_open_id, '') <> '')))`

### Indexes
- `publishing_jobs_due_idx`: `(publish_status, scheduled_at, next_retry_at, created_at)`
- `publishing_jobs_lease_idx`: `(lease_expires_at) WHERE publish_status IN ('CLAIMED', 'UPLOADING')`
- `publishing_jobs_worker_idx`: `(claimed_by) WHERE claimed_by IS NOT NULL AND claimed_by <> ''`
- `publishing_jobs_provider_poll_idx`: `(poll_after) WHERE publish_status = 'PROCESSING'`

### Workflows
- **Written by**: WF11 (creates jobs from approvals), WF12 (claims via `FOR UPDATE SKIP LOCKED`, updates progress, leases, and completion), WF14 (resets expired/retryable rows).
- **Read by**: WF12 (claims due jobs), WF14 (retrieves `RETRY_PENDING` jobs).

---

### Status-Column State Machine (how workflows chain)

```
candidate_videos.processing_status:
  NEW ──(WF3 valid)──> validity_status=VALID
      ──(WF4 transcript ok)──> transcript_available=TRUE
      ──(WF5)──> ANALYZED or SKIPPED

clip_moments.download_status:
  PENDING ──(WF6 yt-dlp start)──> SUBMITTED ──(WF6 download result)──> COMPLETED or ERROR
  AWAITING_MANUAL_APPROVAL ──(Review UI approve)──> PENDING

created_clips.review_status:
  AWAITING_DOWNLOAD ──(WF8)──> NEEDS_REVIEW (or NEEDS_RETRY if plan parse fails)
  NEEDS_REVIEW ──(Review UI approve_clip)──> APPROVED
  NEEDS_REVIEW ──(Review UI reject_clip)──> REJECTED

render_jobs.render_status:
  PENDING ──(WF8c picked)──> DOWNLOADING_ASSETS
  DOWNLOADING_ASSETS ──(assets ready)──> RENDERING
  RENDERING ──(ffmpeg ok)──> UPLOADING
  UPLOADING ──(Drive upload ok)──> COMPLETED
  any step ──(hard failure)──> FAILED

approved_for_posting.status:
  APPROVED / READY + explicit platform ──(WF11)──> publishing_jobs rows
  PENDING / REJECTED ──> no job

publishing_jobs.publish_status:
  due PENDING ──(WF12 lease)──> CLAIMED ──> UPLOADING
  future scheduled_at ──> remains PENDING
  UPLOADING / PROCESSING ──(platform accepted)──> PUBLISHED or DRAFT_UPLOADED
  temporary failure ──> RETRY_PENDING ──(WF14 due)──> PENDING
  expired CLAIMED lease ──(recovery)──> PENDING
  auth problem ──> AUTH_REQUIRED
  policy / content rejection ──> REJECTED
  retry budget exhausted ──> FAILED
```

### Fair-Share Processing

- **WF2**: limits newly appended candidates to 5 per `source_id` per run.
- **WF4**: picks at most 2 transcript fetches per `source_id` per run, 10 total.
- **WF5**: picks at most 1 AI analysis per `source_id` per run, 5 total.
- **WF6**: downloads clips niche-first, rotating channels inside each niche.
- **WF8**: processes awaiting downloads niche-first, rotating channels inside each niche.
- **WF9**: reports niches with no active channels left so operators know to add or re-enable sources.

### Idempotency & Seeding Tips

- Start with 2–3 channels per niche, `priority=1`, assessed risk level.
- Pause a channel by setting `active_status=false` without deleting historical lineage.
- High `risk_level` channels route extracted moments to `AWAITING_MANUAL_APPROVAL` in `clip_moments`, requiring human approval in the Review UI before yt-dlp runs.
- Deterministic IDs ensure re-runs are idempotent across all stages: `video_id`, `analysis_id`, `clip_moment_id`, `created_clip_id=CC-<clip_moment_id>`, `render_id`, `approved_id=APPROVE-<created_clip_id>`, `publish_id=PUB_<render_id>_<platform>_<channel_id>`.
