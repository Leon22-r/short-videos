UPDATE short_videos.publishing_jobs
SET publish_status = CASE
      WHEN publishing_backend = 'POSTIZ' AND postiz_submitted_at IS NOT NULL AND $3 = 'RETRY_PENDING' THEN 'FAILED'
      ELSE $3
    END,
    retry_count = $4::integer,
    next_retry_at = CASE WHEN publishing_backend = 'POSTIZ' AND postiz_submitted_at IS NOT NULL THEN NULL ELSE NULLIF($5, '')::timestamptz END,
    last_error = CASE
      WHEN publishing_backend = 'POSTIZ' AND postiz_submitted_at IS NOT NULL AND $3 = 'RETRY_PENDING' THEN 'POSTIZ_RECONCILIATION_REQUIRED: ' || $6
      ELSE $6
    END,
    provider_response = CASE WHEN NULLIF(btrim($7), '') IS NULL THEN provider_response ELSE $7::jsonb END,
    poll_after = NULL,
    provider_poll_deadline = NULL,
    claimed_at = NULL,
    claimed_by = NULL,
    lease_expires_at = NULL,
    updated_at = now()
WHERE publish_id = $1
  AND claimed_by = $2
  AND publish_status = 'UPLOADING'
  AND (publishing_backend = 'DIRECT' OR lease_expires_at > now())
  AND $3 IN ('RETRY_PENDING', 'AUTH_REQUIRED', 'REJECTED', 'FAILED', 'SKIPPED')
RETURNING *;
