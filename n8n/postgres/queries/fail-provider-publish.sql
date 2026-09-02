UPDATE short_videos.publishing_jobs
SET publish_status = $3,
    retry_count = $4::integer,
    next_retry_at = NULLIF($5, '')::timestamptz,
    last_error = $6,
    provider_response = COALESCE(NULLIF($7, '')::jsonb, provider_response),
    poll_after = NULL,
    provider_poll_deadline = NULL,
    claimed_at = NULL,
    claimed_by = '',
    lease_expires_at = NULL,
    updated_at = now()
WHERE publish_id = $1
  AND claimed_by = $2
  AND publish_status = 'UPLOADING'
  AND $3 IN ('RETRY_PENDING', 'AUTH_REQUIRED', 'REJECTED', 'FAILED', 'SKIPPED')
RETURNING *;
