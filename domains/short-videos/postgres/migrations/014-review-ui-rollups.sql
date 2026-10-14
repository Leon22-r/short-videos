-- Migration 014: exact roll-ups and supporting indexes for the review UI.
--
-- /held's reason chart and /pipeline's throughput table used to fetch raw rows
-- and group them in JS, capped at 2000. Supabase's max-rows (1000 by default)
-- truncates that silently, so both undercounted once volume passed it — and
-- nothing on the page said so. Grouping in a view sends only the groups.
--
-- New objects only. The views in 013 are edited in place (013 explains why),
-- and nothing here redefines them.

-- Why the gates stopped videos in the last 30 days, most common first.
CREATE OR REPLACE VIEW short_videos.held_reasons_30d AS
SELECT
  coalesce(nullif(rejection_reason, ''), 'unrecorded') AS reason,
  count(*)                                             AS count
FROM short_videos.candidate_videos
WHERE validity_status = 'REJECTED'
  AND created_at >= now() - interval '30 days'
GROUP BY 1
ORDER BY 2 DESC, 1;

COMMENT ON VIEW short_videos.held_reasons_30d IS
  'Gate rejections in the last 30 days grouped by rejection_reason, for /held.';

-- Clips created per UTC day for the last seven whole days including today,
-- with the days that produced nothing present as zeros. Bucketed on day
-- boundaries rather than a rolling 168 hours, so the oldest day is complete.
CREATE OR REPLACE VIEW short_videos.clip_throughput_7d AS
SELECT
  to_char(days.day, 'YYYY-MM-DD')                                         AS day,
  count(c.created_clip_id)                                                AS created,
  count(c.created_clip_id) FILTER (WHERE c.review_status = 'APPROVED')    AS approved,
  count(c.created_clip_id) FILTER (WHERE c.review_status = 'REJECTED')    AS rejected
FROM generate_series(
       date_trunc('day', now() AT TIME ZONE 'UTC') - interval '6 days',
       date_trunc('day', now() AT TIME ZONE 'UTC'),
       interval '1 day') AS days(day)
LEFT JOIN short_videos.created_clips c
  ON c.created_at >= days.day AT TIME ZONE 'UTC'
 AND c.created_at <  (days.day + interval '1 day') AT TIME ZONE 'UTC'
GROUP BY days.day
ORDER BY days.day DESC;

COMMENT ON VIEW short_videos.clip_throughput_7d IS
  'Clips created, approved and rejected per UTC day, last seven days, for /pipeline.';

-- review_counts runs on every page render. Without these, each count over a
-- status that only grows (REJECTED, FAILED, ERROR) is a sequential scan of a
-- table that gains a row per fetched video, so page latency tracks total
-- history instead of queue size. Partial, so each index is the size of the
-- queue it serves. Not CONCURRENTLY: run-migrations.sh wraps each file in a
-- transaction, and these tables are small enough that the lock is brief.
CREATE INDEX IF NOT EXISTS candidate_videos_held_idx
  ON short_videos.candidate_videos (created_at)
  WHERE validity_status IN ('FLAGGED', 'REJECTED');

CREATE INDEX IF NOT EXISTS created_clips_parked_idx
  ON short_videos.created_clips (created_at)
  WHERE review_status IN ('REJECTED', 'AWAITING_DOWNLOAD', 'NEEDS_RETRY');

CREATE INDEX IF NOT EXISTS clip_moments_error_idx
  ON short_videos.clip_moments (created_at)
  WHERE download_status = 'ERROR';

CREATE INDEX IF NOT EXISTS render_jobs_failed_idx
  ON short_videos.render_jobs (created_at)
  WHERE render_status = 'FAILED';

CREATE INDEX IF NOT EXISTS publishing_jobs_failed_idx
  ON short_videos.publishing_jobs (created_at)
  WHERE publish_status IN ('FAILED', 'AUTH_REQUIRED');

-- Same reasoning as the grant block at the end of 013.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT SELECT ON short_videos.held_reasons_30d TO service_role;
    GRANT SELECT ON short_videos.clip_throughput_7d TO service_role;
  END IF;
END;
$$;

NOTIFY pgrst, 'reload schema';
