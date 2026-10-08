WITH incoming AS (
  SELECT (
    SELECT jsonb_object_agg(field.key, field.value)
    FROM jsonb_each(element) AS field
    WHERE NULLIF(btrim(field.value #>> '{}'), '') IS NOT NULL
  ) AS row
  FROM jsonb_array_elements($1::jsonb) AS element
  WHERE NULLIF(btrim(element->>'analysis_id'), '') IS NOT NULL
), typed AS (
  SELECT jsonb_populate_record(NULL::short_videos.transcript_analysis, row) AS record
  FROM incoming
  WHERE row IS NOT NULL
)
INSERT INTO short_videos.transcript_analysis (analysis_id, video_id, niche, source_id, video_title, video_url, transcript_status, transcript_text, transcript_length_words, created_at)
SELECT (record).analysis_id,
       (record).video_id,
       (record).niche,
       (record).source_id,
       (record).video_title,
       (record).video_url,
       (record).transcript_status,
       (record).transcript_text,
       (record).transcript_length_words,
       (record).created_at
FROM typed
ON CONFLICT (analysis_id) DO UPDATE SET
  video_id = EXCLUDED.video_id,
  niche = EXCLUDED.niche,
  source_id = EXCLUDED.source_id,
  video_title = EXCLUDED.video_title,
  video_url = EXCLUDED.video_url,
  transcript_status = EXCLUDED.transcript_status,
  transcript_text = EXCLUDED.transcript_text,
  transcript_length_words = EXCLUDED.transcript_length_words,
  created_at = EXCLUDED.created_at
RETURNING *;
