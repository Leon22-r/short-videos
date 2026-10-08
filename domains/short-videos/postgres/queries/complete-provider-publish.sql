UPDATE short_videos.publishing_jobs
SET publish_status = $3,
    post_id = $4,
    post_url = $5,
    provider_stage = $6,
    provider_response = CASE WHEN NULLIF(btrim($7), '') IS NULL THEN provider_response ELSE $7::jsonb END,
    completed_at = now(),
    next_retry_at = NULL,
    poll_after = NULL,
    provider_poll_count = 0,
    provider_poll_deadline = NULL,
    last_error = NULL,
    claimed_at = NULL,
    claimed_by = NULL,
    lease_expires_at = NULL,
    updated_at = now()
WHERE publish_id = $1
  AND claimed_by = $2
  AND publish_status = 'UPLOADING'
  AND publishing_backend = 'DIRECT'
  AND $3 IN ('PUBLISHED', 'DRAFT_UPLOADED')
  AND (
    NULLIF($4, '') IS NOT NULL
    OR (platform = 'TIKTOK' AND NULLIF(provider_ref, '') IS NOT NULL)
  )
RETURNING *;
