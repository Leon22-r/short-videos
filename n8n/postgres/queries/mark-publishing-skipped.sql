WITH updated AS (
  UPDATE short_videos.publishing_jobs
  SET publish_status = 'SKIPPED',
      destination_id = $3,
      last_error = $4,
      next_retry_at = NULL,
      claimed_at = NULL,
      claimed_by = '',
      lease_expires_at = NULL,
      updated_at = now()
  WHERE publish_id = $1
    AND claimed_by = $2
    AND publish_status = 'UPLOADING'
  RETURNING *
)
SELECT * FROM updated
UNION ALL
SELECT jobs.*
FROM short_videos.publishing_jobs AS jobs
WHERE jobs.publish_id = $1
  AND jobs.publish_status = 'SKIPPED'
  AND jobs.destination_id = $3
  AND jobs.last_error = $4
  AND NOT EXISTS (SELECT 1 FROM updated)
LIMIT 1;
