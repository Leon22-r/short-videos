WITH existing_claim AS MATERIALIZED (
  SELECT jobs.*
  FROM short_videos.publishing_jobs AS jobs
  WHERE jobs.claimed_by = $1
    AND jobs.publish_status IN ('CLAIMED', 'UPLOADING')
    AND jobs.lease_expires_at > now()
  ORDER BY jobs.claimed_at, jobs.publish_id
  LIMIT 1
), candidate AS MATERIALIZED (
  SELECT jobs.publish_id
  FROM short_videos.publishing_jobs AS jobs
  WHERE NOT EXISTS (SELECT 1 FROM existing_claim)
    AND (jobs.scheduled_at IS NULL OR jobs.scheduled_at <= now())
    AND (
      jobs.publish_status = 'PENDING'
      OR (
        jobs.publish_status = 'RETRY_PENDING'
        AND jobs.retry_count < 4
        AND (jobs.next_retry_at IS NULL OR jobs.next_retry_at <= now())
      )
      OR (
        jobs.publish_status = 'PROCESSING'
        AND (jobs.poll_after IS NULL OR jobs.poll_after <= now())
      )
      OR (
        jobs.publish_status IN ('CLAIMED', 'UPLOADING')
        AND COALESCE(
          jobs.lease_expires_at,
          jobs.claimed_at + interval '30 minutes',
          jobs.started_at + interval '30 minutes',
          jobs.updated_at + interval '30 minutes'
        ) <= now()
      )
    )
  ORDER BY
    CASE WHEN jobs.publish_status = 'PROCESSING' THEN 1 ELSE 0 END,
    COALESCE(jobs.poll_after, jobs.scheduled_at, jobs.created_at),
    jobs.created_at,
    jobs.publish_id
  FOR UPDATE SKIP LOCKED
  LIMIT 1
), new_claim AS (
  UPDATE short_videos.publishing_jobs AS jobs
  SET publish_status = 'CLAIMED',
      claimed_at = now(),
      claimed_by = $1,
      lease_expires_at = now() + ($2::integer * interval '1 minute'),
      updated_at = now()
  FROM candidate
  WHERE jobs.publish_id = candidate.publish_id
  RETURNING jobs.*
)
SELECT * FROM existing_claim
UNION ALL
SELECT * FROM new_claim
LIMIT 1;
