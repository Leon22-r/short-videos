WITH rows AS (
  SELECT (
    SELECT jsonb_object_agg(field.key, field.value)
    FROM jsonb_each(element) AS field
    WHERE NULLIF(btrim(field.value #>> '{}'), '') IS NOT NULL
  ) AS row
  FROM jsonb_array_elements($1::jsonb) AS element
  WHERE NULLIF(btrim(element->>'analysis_id'), '') IS NOT NULL
), incoming AS (
  SELECT jsonb_populate_record(NULL::short_videos.transcript_analysis, row) AS record
  FROM rows
  WHERE row IS NOT NULL
)
UPDATE short_videos.transcript_analysis AS target SET
  ai_episode_score = (incoming.record).ai_episode_score,
  recommended_strategy = (incoming.record).recommended_strategy,
  recommended_start_sec = (incoming.record).recommended_start_sec,
  recommended_end_sec = (incoming.record).recommended_end_sec,
  reason_for_strategy = (incoming.record).reason_for_strategy,
  rights_risk = (incoming.record).rights_risk,
  permission_risk = (incoming.record).permission_risk,
  monetization_risk = (incoming.record).monetization_risk,
  originality_potential = (incoming.record).originality_potential,
  kenya_relevance = (incoming.record).kenya_relevance,
  ai_json_output = (incoming.record).ai_json_output
FROM incoming
WHERE target.analysis_id = (incoming.record).analysis_id
RETURNING target.*;
