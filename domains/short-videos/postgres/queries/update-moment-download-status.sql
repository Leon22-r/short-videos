WITH rows AS (
  SELECT (
    SELECT jsonb_object_agg(field.key, field.value)
    FROM jsonb_each(element) AS field
    WHERE NULLIF(btrim(field.value #>> '{}'), '') IS NOT NULL
  ) AS row
  FROM jsonb_array_elements($1::jsonb) AS element
  WHERE NULLIF(btrim(element->>'clip_moment_id'), '') IS NOT NULL
), incoming AS (
  SELECT jsonb_populate_record(NULL::short_videos.clip_moments, row) AS record
  FROM rows
  WHERE row IS NOT NULL
)
UPDATE short_videos.clip_moments AS target SET
  download_status = (incoming.record).download_status,
  download_job_id = (incoming.record).download_job_id
FROM incoming
WHERE target.clip_moment_id = (incoming.record).clip_moment_id
RETURNING target.*;
