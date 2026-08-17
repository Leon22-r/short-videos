UPDATE short_videos.publishing_jobs
SET publish_status = 'UPLOADING',
    started_at = COALESCE(started_at, now()),
    updated_at = now()
WHERE publish_id = $1
  AND claimed_by = $2
  AND publish_status IN ('CLAIMED', 'UPLOADING')
  AND lease_expires_at > now()
RETURNING *;
