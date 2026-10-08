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
  suggested_title = (incoming.record).suggested_title,
  suggested_caption = (incoming.record).suggested_caption,
  content_thesis = (incoming.record).content_thesis,
  hook = (incoming.record).hook,
  narration_script = (incoming.record).narration_script,
  commentary_angle = (incoming.record).commentary_angle,
  kenyan_african_localization = (incoming.record).kenyan_african_localization,
  bible_verse_if_relevant = (incoming.record).bible_verse_if_relevant,
  alternative_titles = (incoming.record).alternative_titles,
  on_screen_text_beats = (incoming.record).on_screen_text_beats,
  broll_plan = (incoming.record).broll_plan,
  editing_style = (incoming.record).editing_style,
  hashtags = (incoming.record).hashtags,
  cta = (incoming.record).cta,
  risk_warning = (incoming.record).risk_warning,
  originality_checklist = (incoming.record).originality_checklist,
  transformation_plan = (incoming.record).transformation_plan,
  review_status = (incoming.record).review_status
FROM incoming
WHERE target.created_clip_id = (incoming.record).created_clip_id
RETURNING target.*;
