WITH rows AS (
  SELECT (
    SELECT jsonb_object_agg(field.key, field.value)
    FROM jsonb_each(element) AS field
    WHERE NULLIF(btrim(field.value #>> '{}'), '') IS NOT NULL
  ) AS row
  FROM jsonb_array_elements($1::jsonb) AS element
  WHERE NULLIF(btrim(element->>'video_id'), '') IS NOT NULL
), incoming AS (
  SELECT jsonb_populate_record(NULL::short_videos.candidate_videos, row) AS record
  FROM rows
  WHERE row IS NOT NULL
)
UPDATE short_videos.candidate_videos AS target SET
  like_percentage = (incoming.record).like_percentage,
  comment_percentage = (incoming.record).comment_percentage,
  engagement_percentage = (incoming.record).engagement_percentage,
  validity_status = (incoming.record).validity_status,
  validity_score = (incoming.record).validity_score,
  rejection_reason = (incoming.record).rejection_reason,
  processing_status = (incoming.record).processing_status
FROM incoming
WHERE target.video_id = (incoming.record).video_id
RETURNING target.*;
