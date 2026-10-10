WITH incoming AS (
  SELECT (
    SELECT jsonb_object_agg(field.key, field.value)
    FROM jsonb_each(element) AS field
    WHERE NULLIF(btrim(field.value #>> '{}'), '') IS NOT NULL
  ) AS row
  FROM jsonb_array_elements($1::jsonb) AS element
  WHERE NULLIF(btrim(element->>'render_id'), '') IS NOT NULL
), typed AS (
  SELECT jsonb_populate_record(NULL::short_videos.render_jobs, row) AS record
  FROM incoming
  WHERE row IS NOT NULL
)
INSERT INTO short_videos.render_jobs (render_id, created_clip_id, niche, source_drive_file_id, source_drive_url, source_file_name, final_drive_folder_id, hook_text, cta_text, cta_start_second, cta_end_second, music_mood, music_energy_level, music_id, music_drive_file_id, music_file_name, music_volume, watermark_drive_file_id, watermark_file_name, progress_bar_color, use_blurred_background, ffmpeg_command, render_status, final_local_path, final_drive_file_id, final_drive_url, warning_message, error_message, created_at, started_at, completed_at)
SELECT (record).render_id,
       (record).created_clip_id,
       (record).niche,
       (record).source_drive_file_id,
       (record).source_drive_url,
       (record).source_file_name,
       (record).final_drive_folder_id,
       (record).hook_text,
       (record).cta_text,
       (record).cta_start_second,
       (record).cta_end_second,
       (record).music_mood,
       (record).music_energy_level,
       (record).music_id,
       (record).music_drive_file_id,
       (record).music_file_name,
       (record).music_volume,
       (record).watermark_drive_file_id,
       (record).watermark_file_name,
       (record).progress_bar_color,
       (record).use_blurred_background,
       (record).ffmpeg_command,
       (record).render_status,
       (record).final_local_path,
       (record).final_drive_file_id,
       (record).final_drive_url,
       (record).warning_message,
       (record).error_message,
       (record).created_at,
       (record).started_at,
       (record).completed_at
FROM typed
ON CONFLICT (render_id) DO UPDATE SET
  created_clip_id = EXCLUDED.created_clip_id,
  niche = EXCLUDED.niche,
  source_drive_file_id = EXCLUDED.source_drive_file_id,
  source_drive_url = EXCLUDED.source_drive_url,
  source_file_name = EXCLUDED.source_file_name,
  final_drive_folder_id = EXCLUDED.final_drive_folder_id,
  hook_text = EXCLUDED.hook_text,
  cta_text = EXCLUDED.cta_text,
  cta_start_second = EXCLUDED.cta_start_second,
  cta_end_second = EXCLUDED.cta_end_second,
  music_mood = EXCLUDED.music_mood,
  music_energy_level = EXCLUDED.music_energy_level,
  music_id = EXCLUDED.music_id,
  music_drive_file_id = EXCLUDED.music_drive_file_id,
  music_file_name = EXCLUDED.music_file_name,
  music_volume = EXCLUDED.music_volume,
  watermark_drive_file_id = EXCLUDED.watermark_drive_file_id,
  watermark_file_name = EXCLUDED.watermark_file_name,
  progress_bar_color = EXCLUDED.progress_bar_color,
  use_blurred_background = EXCLUDED.use_blurred_background,
  ffmpeg_command = EXCLUDED.ffmpeg_command,
  render_status = EXCLUDED.render_status,
  final_local_path = EXCLUDED.final_local_path,
  final_drive_file_id = EXCLUDED.final_drive_file_id,
  final_drive_url = EXCLUDED.final_drive_url,
  warning_message = EXCLUDED.warning_message,
  error_message = EXCLUDED.error_message,
  created_at = EXCLUDED.created_at,
  started_at = EXCLUDED.started_at,
  completed_at = EXCLUDED.completed_at
RETURNING *;
