WITH incoming AS (
  SELECT (
    SELECT jsonb_object_agg(field.key, field.value)
    FROM jsonb_each(element) AS field
    WHERE NULLIF(btrim(field.value #>> '{}'), '') IS NOT NULL
  ) AS row
  FROM jsonb_array_elements($1::jsonb) AS element
  WHERE NULLIF(btrim(element->>'video_id'), '') IS NOT NULL
), typed AS (
  SELECT jsonb_populate_record(NULL::short_videos.candidate_videos, row) AS record
  FROM incoming
  WHERE row IS NOT NULL
)
INSERT INTO short_videos.candidate_videos (video_id, niche, source_id, source_name, video_title, video_url, youtube_video_id, duration_seconds, published_at, view_count, like_count, comment_count, like_percentage, comment_percentage, engagement_percentage, transcript_available, language, validity_status, validity_score, rejection_reason, duplicate_status, processing_status)
SELECT (record).video_id,
       (record).niche,
       (record).source_id,
       (record).source_name,
       (record).video_title,
       (record).video_url,
       (record).youtube_video_id,
       (record).duration_seconds,
       (record).published_at,
       (record).view_count,
       (record).like_count,
       (record).comment_count,
       (record).like_percentage,
       (record).comment_percentage,
       (record).engagement_percentage,
       (record).transcript_available,
       (record).language,
       (record).validity_status,
       (record).validity_score,
       (record).rejection_reason,
       (record).duplicate_status,
       (record).processing_status
FROM typed
ON CONFLICT (video_id) DO UPDATE SET
  niche = COALESCE(EXCLUDED.niche, short_videos.candidate_videos.niche),
  source_id = COALESCE(EXCLUDED.source_id, short_videos.candidate_videos.source_id),
  source_name = COALESCE(EXCLUDED.source_name, short_videos.candidate_videos.source_name),
  video_title = COALESCE(EXCLUDED.video_title, short_videos.candidate_videos.video_title),
  video_url = COALESCE(EXCLUDED.video_url, short_videos.candidate_videos.video_url),
  youtube_video_id = COALESCE(EXCLUDED.youtube_video_id, short_videos.candidate_videos.youtube_video_id),
  duration_seconds = COALESCE(EXCLUDED.duration_seconds, short_videos.candidate_videos.duration_seconds),
  published_at = COALESCE(EXCLUDED.published_at, short_videos.candidate_videos.published_at),
  view_count = COALESCE(EXCLUDED.view_count, short_videos.candidate_videos.view_count),
  like_count = COALESCE(EXCLUDED.like_count, short_videos.candidate_videos.like_count),
  comment_count = COALESCE(EXCLUDED.comment_count, short_videos.candidate_videos.comment_count),
  like_percentage = COALESCE(EXCLUDED.like_percentage, short_videos.candidate_videos.like_percentage),
  comment_percentage = COALESCE(EXCLUDED.comment_percentage, short_videos.candidate_videos.comment_percentage),
  engagement_percentage = COALESCE(EXCLUDED.engagement_percentage, short_videos.candidate_videos.engagement_percentage),
  transcript_available = COALESCE(EXCLUDED.transcript_available, short_videos.candidate_videos.transcript_available),
  language = COALESCE(EXCLUDED.language, short_videos.candidate_videos.language),
  validity_status = COALESCE(EXCLUDED.validity_status, short_videos.candidate_videos.validity_status),
  validity_score = COALESCE(EXCLUDED.validity_score, short_videos.candidate_videos.validity_score),
  rejection_reason = COALESCE(EXCLUDED.rejection_reason, short_videos.candidate_videos.rejection_reason),
  duplicate_status = COALESCE(EXCLUDED.duplicate_status, short_videos.candidate_videos.duplicate_status),
  processing_status = COALESCE(EXCLUDED.processing_status, short_videos.candidate_videos.processing_status)
RETURNING *;
