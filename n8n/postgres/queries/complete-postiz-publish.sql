UPDATE short_videos.publishing_jobs
SET publish_status = $3,
    post_id = $4,
    post_url = $5,
    provider_stage = CASE WHEN $3 = 'DRAFT_UPLOADED' THEN 'POSTIZ_DRAFT_UPLOADED' ELSE 'POSTIZ_PUBLISHED' END,
    provider_response = $6::jsonb,
    completed_at = now(),
    next_retry_at = NULL,
    poll_after = NULL,
    provider_poll_count = 0,
    provider_poll_deadline = NULL,
    last_error = '',
    claimed_at = NULL,
    claimed_by = '',
    lease_expires_at = NULL,
    updated_at = now()
WHERE publish_id = $1
  AND claimed_by = $2
  AND publish_status = 'UPLOADING'
  AND lease_expires_at > now()
  AND publishing_backend = 'POSTIZ'
  AND provider_stage = 'POSTIZ_SUBMITTED'
  AND postiz_post_id <> ''
  AND (
    ($3 = 'PUBLISHED' AND platform <> 'TIKTOK' AND $5 ~ '^https://[^[:space:]]+$')
    OR ($3 = 'DRAFT_UPLOADED' AND platform = 'TIKTOK')
  )
RETURNING *;
