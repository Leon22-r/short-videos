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
  total_analyzed_count = (incoming.record).total_analyzed_count,
  channel_skip_rate = (incoming.record).channel_skip_rate,
  active_status = (incoming.record).active_status,
  auto_paused_at = (incoming.record).auto_paused_at,
  auto_paused_reason = (incoming.record).auto_paused_reason,
  health_reset_at = (incoming.record).health_reset_at
FROM incoming
WHERE target.source_id = (incoming.record).source_id
RETURNING target.*;
