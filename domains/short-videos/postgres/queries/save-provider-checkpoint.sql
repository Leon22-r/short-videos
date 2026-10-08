UPDATE short_videos.publishing_jobs
SET provider_stage = $3,
    provider_ref = CASE WHEN NULLIF(btrim($4), '') IS NULL THEN provider_ref ELSE $4 END,
    provider_upload_url = CASE WHEN NULLIF(btrim($5), '') IS NULL THEN provider_upload_url ELSE $5 END,
    provider_response = CASE WHEN NULLIF(btrim($6), '') IS NULL THEN provider_response ELSE $6::jsonb END,
    updated_at = now()
WHERE publish_id = $1
  AND claimed_by = $2
  AND publish_status = 'UPLOADING'
  AND publishing_backend = 'DIRECT'
  AND lease_expires_at > now()
RETURNING *;
