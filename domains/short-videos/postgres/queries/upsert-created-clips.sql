WITH incoming AS (
  SELECT (
    SELECT jsonb_object_agg(field.key, field.value)
    FROM jsonb_each(element) AS field
    WHERE NULLIF(btrim(field.value #>> '{}'), '') IS NOT NULL
  ) AS row
  FROM jsonb_array_elements($1::jsonb) AS element
  WHERE NULLIF(btrim(element->>'created_clip_id'), '') IS NOT NULL
), typed AS (
  SELECT jsonb_populate_record(NULL::short_videos.created_clips, row) AS record
  FROM incoming
  WHERE row IS NOT NULL
)
INSERT INTO short_videos.created_clips (created_clip_id, download_job_id, video_id, clip_moment_id, niche, clip_title, clip_url, local_file_name, google_drive_file_id, google_drive_url, duration_seconds, transcript_excerpt, suggested_title, suggested_caption, transformation_plan, review_status, reviewer_notes, created_at)
SELECT (record).created_clip_id,
       (record).download_job_id,
       (record).video_id,
       (record).clip_moment_id,
       (record).niche,
       (record).clip_title,
       (record).clip_url,
       (record).local_file_name,
       (record).google_drive_file_id,
       (record).google_drive_url,
       (record).duration_seconds,
       (record).transcript_excerpt,
       (record).suggested_title,
       (record).suggested_caption,
       (record).transformation_plan,
       (record).review_status,
       (record).reviewer_notes,
       (record).created_at
FROM typed
ON CONFLICT (created_clip_id) DO UPDATE SET
  download_job_id = EXCLUDED.download_job_id,
  video_id = EXCLUDED.video_id,
  clip_moment_id = EXCLUDED.clip_moment_id,
  niche = EXCLUDED.niche,
  clip_title = EXCLUDED.clip_title,
  clip_url = EXCLUDED.clip_url,
  local_file_name = EXCLUDED.local_file_name,
  google_drive_file_id = EXCLUDED.google_drive_file_id,
  google_drive_url = EXCLUDED.google_drive_url,
  duration_seconds = EXCLUDED.duration_seconds,
  transcript_excerpt = EXCLUDED.transcript_excerpt,
  suggested_title = EXCLUDED.suggested_title,
  suggested_caption = EXCLUDED.suggested_caption,
  transformation_plan = EXCLUDED.transformation_plan,
  review_status = EXCLUDED.review_status,
  reviewer_notes = EXCLUDED.reviewer_notes,
  created_at = EXCLUDED.created_at
RETURNING *;
