UPDATE short_videos.publishing_jobs
SET provider_stage = $3,
    provider_ref = COALESCE(NULLIF($4, ''), provider_ref),
    provider_upload_url = COALESCE(NULLIF($5, ''), provider_upload_url),
    provider_response = COALESCE(NULLIF($6, '')::jsonb, provider_response),
    updated_at = now()
WHERE publish_id = $1
  AND claimed_by = $2
  AND publish_status = 'UPLOADING'
  AND publishing_backend = 'DIRECT'
  AND lease_expires_at > now()
RETURNING *;
