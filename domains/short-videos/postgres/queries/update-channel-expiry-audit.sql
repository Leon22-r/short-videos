WITH rows AS (
  SELECT (
    SELECT jsonb_object_agg(field.key, field.value)
    FROM jsonb_each(element) AS field
    WHERE NULLIF(btrim(field.value #>> '{}'), '') IS NOT NULL
  ) AS row
  FROM jsonb_array_elements($1::jsonb) AS element
  WHERE NULLIF(btrim(element->>'channel_id'), '') IS NOT NULL
), incoming AS (
  SELECT jsonb_populate_record(NULL::short_videos.publishing_channels, row) AS record
  FROM rows
  WHERE row IS NOT NULL
)
UPDATE short_videos.publishing_channels AS target SET
  platform = (incoming.record).platform,
  last_health_status = (incoming.record).last_health_status,
  last_expiry_audit_at = (incoming.record).last_expiry_audit_at,
  updated_at = (incoming.record).updated_at
FROM incoming
WHERE target.channel_id = (incoming.record).channel_id
RETURNING target.*;
