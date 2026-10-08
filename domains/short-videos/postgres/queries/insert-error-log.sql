-- WF10 appends and never updates, so this is an INSERT rather than an upsert.
-- A repeated error_id is the same error being retried, which must not create
-- a second row.
INSERT INTO short_videos.error_log (
  error_id, workflow_name, node_name, related_video_id, error_type, error_message, raw_payload
)
SELECT
  (record).error_id, (record).workflow_name, (record).node_name,
  (record).related_video_id, (record).error_type, (record).error_message, (record).raw_payload
FROM (
  SELECT jsonb_populate_record(NULL::short_videos.error_log, row) AS record
  FROM (
    SELECT (
      SELECT jsonb_object_agg(field.key, field.value)
      FROM jsonb_each(element) AS field
      WHERE NULLIF(btrim(field.value #>> '{}'), '') IS NOT NULL
    ) AS row
    FROM jsonb_array_elements($1::jsonb) AS element
    WHERE NULLIF(btrim(element->>'error_id'), '') IS NOT NULL
  ) rows
  WHERE row IS NOT NULL
) typed
ON CONFLICT (error_id) DO NOTHING
RETURNING *;
