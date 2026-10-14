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
-- Two liveness columns, because they answer different questions:
--   last_activity         the newest row that arrived at this stage
--   consumer_last_output  the newest thing this stage's consumer produced
-- A stage is stalled when work has aged here AND its consumer has produced
-- nothing in that time. Judging stage N by stage N+1's arrivals instead gets
-- the last stage wrong (there is no N+1) and blames the wrong workflow where
-- two workflows write the same table. NULL means the consumer's output cannot
-- be dated from this schema; the UI then judges on the age of the backlog
-- alone. Where a consumer only updates rows in place (WF3), the newest row it
-- has judged stands in for when it last ran.
--
-- Read-only views. SELECT is granted explicitly at the bottom of this file
-- rather than trusted to 011's default privileges; the comment there says why.
--
-- run-migrations.sh replays every file on every boot, so this file is edited
-- in place rather than amended by a later one: a later CREATE OR REPLACE that
-- added a column would make this file's own CREATE OR REPLACE fail on replay.
-- Columns are only ever appended, never reordered, for the same reason.

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
  max(last_checked_at)                                      AS last_activity,
  max(last_checked_at)                                      AS consumer_last_output
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
  max(created_at),
  -- candidate_videos has no updated_at, so WF3's last run is approximated by
  -- the newest candidate it has judged. WF2 rejects music videos and live
  -- streams itself at insert, so those rows say nothing about WF3.
  max(created_at) FILTER (
    WHERE coalesce(validity_status, '') <> ''
      AND coalesce(rejection_reason, '') NOT IN ('MUSIC_VIDEO', 'LIVE_STREAM'))
FROM short_videos.candidate_videos

UNION ALL

-- WF4 reads validity_status = 'VALID' with transcript_available unset
-- (workflow-code/transcript-fetch.js:7). Its filter is
-- String(transcript_available || '') === '', so boolean false counts as "not
-- fetched yet" there; IS NOT TRUE mirrors that rather than narrowing to NULL.
-- FLAGGED is not 'VALID', so a flagged candidate is not counted here at all:
-- it is waiting on a person, and /held is where it shows.
SELECT
  3, 'Awaiting transcript', 'WF4 transcript fetch', true,
  count(*) FILTER (
    WHERE validity_status = 'VALID'
      AND transcript_available IS NOT TRUE),
  min(created_at) FILTER (
    WHERE validity_status = 'VALID'
      AND transcript_available IS NOT TRUE),
  max(created_at) FILTER (WHERE validity_status = 'VALID'),
  -- WF4's output lands in another table.
  (SELECT max(created_at) FROM short_videos.transcript_analysis)
FROM short_videos.candidate_videos

UNION ALL

-- WF5 scores a fetched or truncated transcript (ai-transcript-analysis.js,
-- pickUnanalyzed). Unscored means it has not run on it yet. TRUNCATED dates
-- from the Sheets store and this table's CHECK does not admit it; it stays so
-- the predicate is a copy of WF5's, not a judgement about which half matters.
SELECT
  4, 'Awaiting analysis', 'WF5 AI transcript analysis', true,
  count(*) FILTER (
    WHERE transcript_status IN ('FETCHED', 'TRUNCATED')
      AND ai_episode_score IS NULL),
  min(created_at) FILTER (
    WHERE transcript_status IN ('FETCHED', 'TRUNCATED')
      AND ai_episode_score IS NULL),
  max(created_at),
  -- WF5's output is the moments it proposes.
  (SELECT max(created_at) FROM short_videos.clip_moments)
FROM short_videos.transcript_analysis

UNION ALL

-- WF6 downloads PENDING moments. AWAITING_MANUAL_APPROVAL is deliberately not
-- counted as waiting on a workflow: it is waiting on a person, and it has its
-- own screen.
SELECT
  5, 'Awaiting download', 'WF6 yt-dlp clip download', true,
  count(*) FILTER (WHERE download_status = 'PENDING'),
  min(created_at) FILTER (WHERE download_status = 'PENDING'),
  max(created_at),
  -- A downloaded moment becomes a created clip.
  (SELECT max(created_at) FROM short_videos.created_clips)
FROM short_videos.clip_moments

UNION ALL

SELECT
  6, 'Awaiting render', 'WF8c FFmpeg render', true,
  count(*) FILTER (WHERE render_status IN ('PENDING', 'DOWNLOADING_ASSETS', 'RENDERING', 'UPLOADING')),
  min(created_at) FILTER (WHERE render_status IN ('PENDING', 'DOWNLOADING_ASSETS', 'RENDERING', 'UPLOADING')),
  max(created_at),
  -- Not created_clips: WF6 and WF8 write that table, so new clips there say
  -- nothing about whether the renderer is alive.
  max(completed_at)
FROM short_videos.render_jobs

UNION ALL

-- The one stage whose consumer is a person.
SELECT
  7, 'Awaiting your review', 'you', false,
  count(*) FILTER (WHERE review_status = 'NEEDS_REVIEW'),
  min(created_at) FILTER (WHERE review_status = 'NEEDS_REVIEW'),
  max(created_at),
  NULL::timestamptz
FROM short_videos.created_clips

UNION ALL

-- WF11 turns an approval into one publishing job per platform. It reads
-- APPROVED and READY whose render is complete with a file to post
-- (publishing.js, buildPublishingJobs and renderReady), and never moves the
-- status on afterwards — it de-duplicates against the jobs it already built —
-- so "waiting" is a ready approval with no job yet, not every approval ever
-- made. Not mirrored: WF11 also skips a platform with no active publishing
-- channel. An approval for such a platform waits here, and the alarm it
-- raises is the right prompt to configure the channel.
SELECT
  8, 'Approved, not queued', 'WF11 build publishing jobs', true,
  count(*) FILTER (WHERE a.status IN ('APPROVED', 'READY') AND r.render_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM short_videos.publishing_jobs j WHERE j.approved_id = a.approved_id)),
  min(a.created_at) FILTER (WHERE a.status IN ('APPROVED', 'READY') AND r.render_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM short_videos.publishing_jobs j WHERE j.approved_id = a.approved_id)),
  max(a.created_at),
  (SELECT max(created_at) FROM short_videos.publishing_jobs)
FROM short_videos.approved_for_posting a
LEFT JOIN short_videos.render_jobs r
  ON r.render_id = a.render_id
 AND r.render_status = 'COMPLETED'
 AND coalesce(r.final_drive_file_id, r.final_drive_url, r.final_local_path, '') <> ''

UNION ALL

-- WF12 claims a job once it is due (claim-next-publishing-job.sql): PENDING,
-- RETRY_PENDING under the retry cap with its backoff elapsed, or PROCESSING
-- whose next poll is due — and never one scheduled for later. A post booked
-- for tomorrow is not a stall, so only due jobs count, and a job's wait is
-- measured from when it fell due. A lease that expired mid-upload is also
-- reclaimable there; the lease alarm on /pipeline reports those instead.
SELECT
  9, 'Awaiting publish', 'WF12 publish to platforms', true,
  count(*) FILTER (
    WHERE (scheduled_at IS NULL OR scheduled_at <= now())
      AND (publish_status = 'PENDING'
        OR (publish_status = 'RETRY_PENDING' AND retry_count < 4
          AND (next_retry_at IS NULL OR next_retry_at <= now()))
        OR (publish_status = 'PROCESSING' AND (poll_after IS NULL OR poll_after <= now())))),
  min(greatest(created_at, scheduled_at, next_retry_at, poll_after)) FILTER (
    WHERE (scheduled_at IS NULL OR scheduled_at <= now())
      AND (publish_status = 'PENDING'
        OR (publish_status = 'RETRY_PENDING' AND retry_count < 4
          AND (next_retry_at IS NULL OR next_retry_at <= now()))
        OR (publish_status = 'PROCESSING' AND (poll_after IS NULL OR poll_after <= now())))),
  max(created_at),
  -- claimed_at is stamped at claim and started_at only at upload, so a run
  -- that claims and then fails early still shows the publisher is alive.
  max(coalesce(completed_at, started_at, claimed_at))
FROM short_videos.publishing_jobs

ORDER BY position;

COMMENT ON VIEW short_videos.pipeline_status IS
  'Per-stage waiting count, age of the oldest waiting row, when work last '
  'arrived, when the consumer last produced anything, and whether a stall '
  'there implicates a workflow. Each waiting predicate mirrors the input '
  'filter of the workflow named in "consumer"; they must change together.';


-- The navigation carries a live count beside every screen, which is what lets
-- the screens drop a stats strip. Counting that from PostgREST would be six
-- requests on every page render; this is one row. Each count must match the
-- predicate of the server.js loader for that screen — the loader is named on
-- each line.
CREATE OR REPLACE VIEW short_videos.review_counts AS
SELECT
  -- loadClipQueue
  (SELECT count(*) FROM short_videos.created_clips
    WHERE review_status = 'NEEDS_REVIEW')                              AS clips,
  -- GET /moments
  (SELECT count(*) FROM short_videos.clip_moments
    WHERE download_status = 'AWAITING_MANUAL_APPROVAL')                AS moments,
  -- loadHeld, flagged only. FLAGGED is held whether or not anyone meant it to
  -- be: nothing downstream accepts it, so it waits on a person. A gate's
  -- REJECTED is the filter doing its job, and counting it would make the
  -- badge grow for ever and stop meaning "needs you".
  (SELECT count(*) FROM short_videos.candidate_videos
    WHERE validity_status = 'FLAGGED')                                 AS held,
  -- loadStuck
  (SELECT count(*) FROM short_videos.clip_moments
    WHERE download_status = 'ERROR')
  + (SELECT count(*) FROM short_videos.render_jobs
    WHERE render_status = 'FAILED')
  + (SELECT count(*) FROM short_videos.publishing_jobs
    WHERE publish_status IN ('FAILED', 'AUTH_REQUIRED'))
  + (SELECT count(*) FROM short_videos.created_clips
    WHERE review_status IN ('AWAITING_DOWNLOAD', 'NEEDS_RETRY'))       AS stuck,
  -- GET /channels, active only
  (SELECT count(*) FROM short_videos.source_channels
    WHERE active_status)                                               AS channels,
  -- GET /published
  (SELECT count(*) FROM short_videos.publishing_jobs
    WHERE publish_status IN ('PUBLISHED', 'DRAFT_UPLOADED'))           AS published;

COMMENT ON VIEW short_videos.review_counts IS
  'One row of queue sizes for the review UI navigation.';


-- Migration 011 granted service_role everything in this schema and set default
-- privileges for objects created later. Those defaults only cover objects
-- created by the role that ran 011, so they are a bet on this file being
-- applied by that same role. Granting explicitly costs one statement and
-- removes the bet. SELECT only: both views are read-only by construction.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT SELECT ON short_videos.pipeline_status TO service_role;
    GRANT SELECT ON short_videos.review_counts TO service_role;
  END IF;
END;
$$;

-- PostgREST answers from a cached schema, so a view it has not seen is "not
-- found in the schema cache" however correct the SQL was. Supabase reloads on
-- a DDL event trigger, but that can lag; this makes the reload part of the
-- migration rather than something to remember afterwards. Harmless where
-- nothing is listening.
NOTIFY pgrst, 'reload schema';
