WITH rows AS (
  SELECT (
    SELECT jsonb_object_agg(field.key, field.value)
    FROM jsonb_each(element) AS field
    WHERE NULLIF(btrim(field.value #>> '{}'), '') IS NOT NULL
  ) AS row
  FROM jsonb_array_elements($1::jsonb) AS element
  WHERE NULLIF(btrim(element->>'source_id'), '') IS NOT NULL
), incoming AS (
  SELECT jsonb_populate_record(NULL::short_videos.source_channels, row) AS record
  FROM rows
  WHERE row IS NOT NULL
)
UPDATE short_videos.source_channels AS target SET
  youtube_channel_id = (incoming.record).youtube_channel_id,
  uploads_playlist_id = (incoming.record).uploads_playlist_id,
  last_checked_at = (incoming.record).last_checked_at,
  notes = (incoming.record).notes
FROM incoming
WHERE target.source_id = (incoming.record).source_id
RETURNING target.*;
