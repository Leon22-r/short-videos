WITH incoming AS (
  SELECT (
    SELECT jsonb_object_agg(field.key, field.value)
    FROM jsonb_each(element) AS field
    WHERE NULLIF(btrim(field.value #>> '{}'), '') IS NOT NULL
  ) AS row
  FROM jsonb_array_elements($1::jsonb) AS element
  WHERE NULLIF(btrim(element->>'clip_moment_id'), '') IS NOT NULL
), typed AS (
  SELECT jsonb_populate_record(NULL::short_videos.clip_moments, row) AS record
  FROM incoming
  WHERE row IS NOT NULL
)
INSERT INTO short_videos.clip_moments (clip_moment_id, video_id, niche, source_id, rank, start_sec, end_sec, clip_length_seconds, hook_first_2_seconds, core_idea, why_valuable, target_audience, suggested_title, suggested_caption, on_screen_text, suggested_broll, commentary_angle, kenyan_african_application, bible_verse_if_relevant, needs_extra_context, originality_score, clip_score, rights_risk, final_recommendation, download_status, download_job_id, strategy, source_video_url, created_at)
SELECT (record).clip_moment_id,
       (record).video_id,
       (record).niche,
       (record).source_id,
       (record).rank,
       (record).start_sec,
       (record).end_sec,
       (record).clip_length_seconds,
       (record).hook_first_2_seconds,
       (record).core_idea,
       (record).why_valuable,
       (record).target_audience,
       (record).suggested_title,
       (record).suggested_caption,
       (record).on_screen_text,
       (record).suggested_broll,
       (record).commentary_angle,
       (record).kenyan_african_application,
       (record).bible_verse_if_relevant,
       (record).needs_extra_context,
       (record).originality_score,
       (record).clip_score,
       (record).rights_risk,
       (record).final_recommendation,
       (record).download_status,
       (record).download_job_id,
       (record).strategy,
       (record).source_video_url,
       (record).created_at
FROM typed
ON CONFLICT (clip_moment_id) DO UPDATE SET
  video_id = EXCLUDED.video_id,
  niche = EXCLUDED.niche,
  source_id = EXCLUDED.source_id,
  rank = EXCLUDED.rank,
  start_sec = EXCLUDED.start_sec,
  end_sec = EXCLUDED.end_sec,
  clip_length_seconds = EXCLUDED.clip_length_seconds,
  hook_first_2_seconds = EXCLUDED.hook_first_2_seconds,
  core_idea = EXCLUDED.core_idea,
  why_valuable = EXCLUDED.why_valuable,
  target_audience = EXCLUDED.target_audience,
  suggested_title = EXCLUDED.suggested_title,
  suggested_caption = EXCLUDED.suggested_caption,
  on_screen_text = EXCLUDED.on_screen_text,
  suggested_broll = EXCLUDED.suggested_broll,
  commentary_angle = EXCLUDED.commentary_angle,
  kenyan_african_application = EXCLUDED.kenyan_african_application,
  bible_verse_if_relevant = EXCLUDED.bible_verse_if_relevant,
  needs_extra_context = EXCLUDED.needs_extra_context,
  originality_score = EXCLUDED.originality_score,
  clip_score = EXCLUDED.clip_score,
  rights_risk = EXCLUDED.rights_risk,
  final_recommendation = EXCLUDED.final_recommendation,
  download_status = EXCLUDED.download_status,
  download_job_id = EXCLUDED.download_job_id,
  strategy = EXCLUDED.strategy,
  source_video_url = EXCLUDED.source_video_url,
  created_at = EXCLUDED.created_at
RETURNING *;
