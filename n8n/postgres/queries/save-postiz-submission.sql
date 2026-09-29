UPDATE short_videos.publishing_jobs
SET postiz_post_id = $3,
    provider_ref = $3,
    provider_stage = 'POSTIZ_SUBMITTED',
    provider_response = $4::jsonb,
    updated_at = now()
WHERE publish_id = $1
  AND claimed_by = $2
  AND publish_status = 'UPLOADING'
  AND lease_expires_at > now()
  AND publishing_backend = 'POSTIZ'
  AND provider_stage IN ('POSTIZ_SUBMIT_REQUESTED', 'POSTIZ_SUBMITTED')
  AND postiz_submitted_at IS NOT NULL
  AND btrim($3) <> ''
  AND (postiz_post_id = '' OR postiz_post_id = $3)
RETURNING *;
