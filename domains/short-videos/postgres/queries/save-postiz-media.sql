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
  AND (provider_stage IS NULL OR provider_stage = 'POSTIZ_MEDIA_READY')
  AND postiz_post_id IS NULL
  AND postiz_submitted_at IS NULL
  AND NULLIF(btrim($3), '') IS NOT NULL AND NULLIF(btrim($4), '') IS NOT NULL
  AND (postiz_media_id IS NULL OR (postiz_media_id = $3 AND postiz_media_path = $4))
RETURNING *;
