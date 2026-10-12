-- Migration 013: one read that answers "is the pipeline moving?".
--
-- The review UI's /pipeline screen needs three numbers per stage: how much is
-- waiting, how long the oldest waiting item has been there, and when the stage
-- last produced anything. Counting that from PostgREST would be sixteen
-- requests with Prefer: count=exact; this is one.
--
-- Why "last_activity" and not an execution log: whether WF6 ran at 06:00 lives
-- in n8n's own database on the heavy host, not here. The review UI holds one
-- secret (D11) and reaching n8n's API would mean a second. Data freshness is
-- the proxy, and it is the better signal anyway — a workflow that runs hourly
-- and produces nothing is the failure that matters, and an execution log shows
-- that as green.
--
-- Each stage's "waiting" predicate is the *consumer's own input filter*, copied
-- from the workflow that reads it. When a workflow's filter changes, this view
-- is wrong until it changes too. The workflow is named in each branch so the
-- pairing is findable.
--
-- Read-only. No privilege change: migration 011 set ALTER DEFAULT PRIVILEGES
-- GRANT ALL ON TABLES to service_role, which covers views created later.

CREATE OR REPLACE VIEW short_videos.pipeline_status AS

-- WF1/WF2 poll every active channel. Waiting is not a backlog here, it is the
-- size of the fleet; a niche with none is an alarm the UI raises separately.
SELECT
  1                                                        AS position,
  'Source channels'                                        AS stage,
  'WF1 resolve, WF2 fetch'                                 AS consumer,
  -- Waiting here is the size of the fleet, not a backlog, so a high number
  -- never means a workflow stopped.
  false                                                    AS alarm_on_stall,
  count(*) FILTER (WHERE active_status)                     AS waiting,
  min(last_checked_at) FILTER (WHERE active_status)         AS oldest_waiting,
  max(last_checked_at)                                      AS last_activity
FROM short_videos.source_channels

UNION ALL

-- WF3 reads processing_status = 'NEW' with validity_status still unset
-- (03-validity-check.json, the Apply Validity Rules node).
SELECT
  2, 'New candidates', 'WF3 validity check', true,
  count(*) FILTER (
    WHERE processing_status = 'NEW'
      AND coalesce(validity_status, '') = ''),
  min(created_at) FILTER (
    WHERE processing_status = 'NEW'
      AND coalesce(validity_status, '') = ''),
  max(created_at)
FROM short_videos.candidate_videos

UNION ALL

-- WF4 reads validity_status = 'VALID' with transcript_available unset
-- (workflow-code/transcript-fetch.js:7). Its filter is
-- String(transcript_available || '') === '', so boolean false counts as "not
-- fetched yet" there; IS NOT TRUE mirrors that rather than narrowing to NULL. Note FLAGGED is not 'VALID', so a
-- flagged candidate waits here forever until an operator releases it — which
-- is what /held exists for.
SELECT
  3, 'Awaiting transcript', 'WF4 transcript fetch', true,
  count(*) FILTER (
    WHERE validity_status = 'VALID'
      AND transcript_available IS NOT TRUE),
  min(created_at) FILTER (
    WHERE validity_status = 'VALID'
      AND transcript_available IS NOT TRUE),
  -- What WF4 produces lands in another table, so this stage's liveness is the
  -- newest transcript rather than anything in candidate_videos.
  (SELECT max(created_at) FROM short_videos.transcript_analysis)
FROM short_videos.candidate_videos

UNION ALL

-- WF5 scores a fetched transcript. Unscored means it has not run on it yet.
SELECT
  4, 'Awaiting analysis', 'WF5 AI transcript analysis', true,
  count(*) FILTER (
    WHERE transcript_status = 'FETCHED'
      AND ai_episode_score IS NULL),
  min(created_at) FILTER (
    WHERE transcript_status = 'FETCHED'
      AND ai_episode_score IS NULL),
  max(created_at)
FROM short_videos.transcript_analysis

UNION ALL

-- WF6 downloads PENDING moments. AWAITING_MANUAL_APPROVAL is deliberately not
-- counted as waiting on a workflow: it is waiting on a person, and it has its
-- own screen.
SELECT
  5, 'Awaiting download', 'WF6 yt-dlp clip download', true,
  count(*) FILTER (WHERE download_status = 'PENDING'),
  min(created_at) FILTER (WHERE download_status = 'PENDING'),
  max(created_at)
FROM short_videos.clip_moments

UNION ALL

SELECT
  6, 'Awaiting render', 'WF8c FFmpeg render', true,
  count(*) FILTER (WHERE render_status IN ('PENDING', 'DOWNLOADING_ASSETS', 'RENDERING', 'UPLOADING')),
  min(created_at) FILTER (WHERE render_status IN ('PENDING', 'DOWNLOADING_ASSETS', 'RENDERING', 'UPLOADING')),
  max(created_at)
FROM short_videos.render_jobs

UNION ALL

-- The one stage whose consumer is a person.
SELECT
  7, 'Awaiting your review', 'you', false,
  count(*) FILTER (WHERE review_status = 'NEEDS_REVIEW'),
  min(created_at) FILTER (WHERE review_status = 'NEEDS_REVIEW'),
  max(created_at)
FROM short_videos.created_clips

UNION ALL

-- WF11 turns an approval into one publishing job per platform.
SELECT
  8, 'Approved, not queued', 'WF11 build publishing jobs', true,
  count(*) FILTER (WHERE status IN ('PENDING', 'APPROVED')),
  min(created_at) FILTER (WHERE status IN ('PENDING', 'APPROVED')),
  max(created_at)
FROM short_videos.approved_for_posting

UNION ALL

-- WF12 claims PENDING jobs; WF14 moves a failed one to RETRY_PENDING and back.
SELECT
  9, 'Awaiting publish', 'WF12 publish to platforms', true,
  count(*) FILTER (WHERE publish_status IN ('PENDING', 'RETRY_PENDING')),
  min(created_at) FILTER (WHERE publish_status IN ('PENDING', 'RETRY_PENDING')),
  max(coalesce(completed_at, started_at, created_at))
FROM short_videos.publishing_jobs

ORDER BY position;

COMMENT ON VIEW short_videos.pipeline_status IS
  'Per-stage waiting count, age of the oldest waiting row, and when the stage '
  'last produced anything, plus whether a stall there implicates a workflow. '
  'last produced anything. Each waiting predicate mirrors the input filter of '
  'the workflow named in "consumer"; they must change together.';


-- The navigation carries a live count beside every screen, which is what lets
-- the screens drop a stats strip. Counting that from PostgREST would be six
-- requests on every page render; this is one row.
CREATE OR REPLACE VIEW short_videos.review_counts AS
SELECT
  (SELECT count(*) FROM short_videos.created_clips
    WHERE review_status = 'NEEDS_REVIEW')                              AS clips,
  (SELECT count(*) FROM short_videos.clip_moments
    WHERE download_status = 'AWAITING_MANUAL_APPROVAL')                AS moments,
  -- Everything a person could push through: gate-stopped videos plus clips
  -- this operator rejected. FLAGGED is counted because nothing downstream
  -- accepts it, so it is held whether or not anyone meant it to be.
  (SELECT count(*) FROM short_videos.candidate_videos
    WHERE validity_status IN ('FLAGGED', 'REJECTED'))
  + (SELECT count(*) FROM short_videos.created_clips
    WHERE review_status = 'REJECTED')                                  AS held,
  (SELECT count(*) FROM short_videos.clip_moments
    WHERE download_status = 'ERROR')
  + (SELECT count(*) FROM short_videos.render_jobs
    WHERE render_status = 'FAILED')
  + (SELECT count(*) FROM short_videos.publishing_jobs
    WHERE publish_status IN ('FAILED', 'AUTH_REQUIRED'))
  + (SELECT count(*) FROM short_videos.created_clips
    WHERE review_status IN ('AWAITING_DOWNLOAD', 'NEEDS_RETRY'))       AS stuck,
  (SELECT count(*) FROM short_videos.source_channels
    WHERE active_status)                                               AS channels,
  (SELECT count(*) FROM short_videos.publishing_jobs
    WHERE publish_status = 'PUBLISHED')                                AS published;

COMMENT ON VIEW short_videos.review_counts IS
  'One row of queue sizes for the review UI navigation.';
