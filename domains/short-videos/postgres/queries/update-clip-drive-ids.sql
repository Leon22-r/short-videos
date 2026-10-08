WITH rows AS (
  SELECT (
    SELECT jsonb_object_agg(field.key, field.value)
    FROM jsonb_each(element) AS field
    WHERE NULLIF(btrim(field.value #>> '{}'), '') IS NOT NULL
  ) AS row
  FROM jsonb_array_elements($1::jsonb) AS element
  WHERE NULLIF(btrim(element->>'created_clip_id'), '') IS NOT NULL
), incoming AS (
  SELECT jsonb_populate_record(NULL::short_videos.created_clips, row) AS record
  FROM rows
  WHERE row IS NOT NULL
)
UPDATE short_videos.created_clips AS target SET
  local_file_name = (incoming.record).local_file_name,
  google_drive_file_id = (incoming.record).google_drive_file_id,
  google_drive_url = (incoming.record).google_drive_url
FROM incoming
WHERE target.created_clip_id = (incoming.record).created_clip_id
RETURNING target.*;
