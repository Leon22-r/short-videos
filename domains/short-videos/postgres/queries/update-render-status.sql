WITH rows AS (
  SELECT (
    SELECT jsonb_object_agg(field.key, field.value)
    FROM jsonb_each(element) AS field
    WHERE NULLIF(btrim(field.value #>> '{}'), '') IS NOT NULL
  ) AS row
  FROM jsonb_array_elements($1::jsonb) AS element
  WHERE NULLIF(btrim(element->>'render_id'), '') IS NOT NULL
), incoming AS (
  SELECT jsonb_populate_record(NULL::short_videos.render_jobs, row) AS record
  FROM rows
  WHERE row IS NOT NULL
)
UPDATE short_videos.render_jobs AS target SET
  render_status = (incoming.record).render_status,
  started_at = (incoming.record).started_at,
  completed_at = (incoming.record).completed_at
FROM incoming
WHERE target.render_id = (incoming.record).render_id
RETURNING target.*;
