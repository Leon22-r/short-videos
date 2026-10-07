UPDATE short_videos.publishing_jobs
SET publish_status = CASE WHEN retry_count >= 4 OR (publishing_backend = 'POSTIZ' AND (postiz_submitted_at IS NOT NULL OR postiz_post_id <> '')) THEN 'FAILED' ELSE 'PENDING' END,
    next_retry_at = NULL,
    last_error = CASE WHEN publishing_backend = 'POSTIZ' AND (postiz_submitted_at IS NOT NULL OR postiz_post_id <> '') THEN 'POSTIZ_RECONCILIATION_REQUIRED: automatic resubmission blocked' ELSE last_error END,
    claimed_at = NULL,
    claimed_by = '',
    lease_expires_at = NULL,
    updated_at = now()
WHERE publish_status = 'RETRY_PENDING'
  AND (retry_count >= 4 OR next_retry_at IS NULL OR next_retry_at <= now())
RETURNING *;
