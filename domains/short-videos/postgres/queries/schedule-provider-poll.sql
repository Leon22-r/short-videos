UPDATE short_videos.publishing_jobs
SET publish_status = CASE
      WHEN provider_poll_count + 1 >= 180
        OR COALESCE(provider_poll_deadline, now() + interval '24 hours') <= now()
      THEN 'FAILED'
      ELSE 'PROCESSING'
    END,
    provider_stage = $3,
    provider_ref = CASE WHEN NULLIF(btrim($4), '') IS NULL THEN provider_ref ELSE $4 END,
    provider_response = CASE WHEN NULLIF(btrim($5), '') IS NULL THEN provider_response ELSE $5::jsonb END,
    poll_after = CASE
      WHEN provider_poll_count + 1 >= 180
        OR COALESCE(provider_poll_deadline, now() + interval '24 hours') <= now()
      THEN NULL
      ELSE now() + ($6::integer * interval '1 minute')
    END,
    provider_poll_count = provider_poll_count + 1,
    provider_poll_deadline = COALESCE(provider_poll_deadline, now() + interval '24 hours'),
    last_error = CASE
      WHEN provider_poll_count + 1 >= 180
        OR COALESCE(provider_poll_deadline, now() + interval '24 hours') <= now()
      THEN 'PROVIDER_POLL_LIMIT_EXCEEDED: manual reconciliation required'
      ELSE last_error
    END,
    claimed_at = NULL,
    claimed_by = NULL,
    lease_expires_at = NULL,
    updated_at = now()
WHERE publish_id = $1
  AND claimed_by = $2
  AND publish_status = 'UPLOADING'
  AND (publishing_backend = 'DIRECT' OR (
    lease_expires_at > now()
    AND provider_stage = 'POSTIZ_SUBMITTED'
    AND $3 = 'POSTIZ_SUBMITTED'
    AND postiz_post_id IS NOT NULL
    AND $4 = postiz_post_id
  ))
RETURNING *;
