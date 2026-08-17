UPDATE short_videos.publishing_jobs
SET lease_expires_at = GREATEST(lease_expires_at, now()) + ($3::integer * interval '1 minute'),
    updated_at = now()
WHERE publish_id = $1
  AND claimed_by = $2
  AND publish_status = 'UPLOADING'
  AND lease_expires_at > now()
RETURNING *;
