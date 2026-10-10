-- Intentionally returns no row on replay: only the winning transition may POST.
UPDATE short_videos.publishing_jobs
SET provider_stage = 'POSTIZ_SUBMIT_REQUESTED',
    postiz_submit_payload = $3::jsonb,
    postiz_submitted_at = now(),
    updated_at = now()
WHERE publish_id = $1
  AND claimed_by = $2
  AND publish_status = 'UPLOADING'
  AND lease_expires_at > now()
  AND publishing_backend = 'POSTIZ'
  AND provider_stage = 'POSTIZ_MEDIA_READY'
  AND postiz_post_id IS NULL
  AND postiz_submitted_at IS NULL
  AND postiz_media_id IS NOT NULL AND postiz_media_path IS NOT NULL
  AND jsonb_typeof($3::jsonb) = 'object'
  AND $3::jsonb <> '{}'::jsonb
  AND $3::jsonb->>'type' = 'now'
  AND jsonb_typeof($3::jsonb->'posts') = 'array'
  AND jsonb_array_length($3::jsonb->'posts') = 1
  AND $3::jsonb #>> '{posts,0,integration,id}' = postiz_integration_id
  AND $3::jsonb #>> '{posts,0,value,0,image,0,id}' = postiz_media_id
  AND $3::jsonb #>> '{posts,0,value,0,image,0,path}' = postiz_media_path
RETURNING *;
