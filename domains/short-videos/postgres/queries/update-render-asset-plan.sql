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
  final_drive_folder_id = (incoming.record).final_drive_folder_id,
  hook_text = (incoming.record).hook_text,
  cta_text = (incoming.record).cta_text,
  cta_start_second = (incoming.record).cta_start_second,
  cta_end_second = (incoming.record).cta_end_second,
  music_mood = (incoming.record).music_mood,
  music_energy_level = (incoming.record).music_energy_level,
  music_id = (incoming.record).music_id,
  music_drive_file_id = (incoming.record).music_drive_file_id,
  music_file_name = (incoming.record).music_file_name,
  music_volume = (incoming.record).music_volume,
  watermark_drive_file_id = (incoming.record).watermark_drive_file_id,
  watermark_file_name = (incoming.record).watermark_file_name,
  progress_bar_color = (incoming.record).progress_bar_color,
  use_blurred_background = (incoming.record).use_blurred_background,
  ffmpeg_command = (incoming.record).ffmpeg_command,
  render_status = (incoming.record).render_status,
  warning_message = (incoming.record).warning_message,
  error_message = (incoming.record).error_message,
  started_at = (incoming.record).started_at,
  completed_at = (incoming.record).completed_at
FROM incoming
WHERE target.render_id = (incoming.record).render_id
RETURNING target.*;
