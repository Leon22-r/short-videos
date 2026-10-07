UPDATE short_videos.publishing_jobs
SET postiz_media_id = $3,
    postiz_media_path = $4,
    provider_stage = 'POSTIZ_MEDIA_READY',
    updated_at = now()
WHERE publish_id = $1
  AND claimed_by = $2
  AND publish_status = 'UPLOADING'
  AND lease_expires_at > now()
  AND publishing_backend = 'POSTIZ'
  AND provider_stage IN ('', 'POSTIZ_MEDIA_READY')
  AND postiz_post_id = ''
  AND postiz_submitted_at IS NULL
  AND btrim($3) <> '' AND btrim($4) <> ''
  AND (postiz_media_id = '' OR (postiz_media_id = $3 AND postiz_media_path = $4))
RETURNING *;
