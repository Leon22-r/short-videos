-- Pipeline store, part 3 of 5: created clips and render jobs.

-- Converts a Sheets-era newline-joined list into a text[], dropping blank
-- lines so an empty cell becomes NULL rather than a one-element array
-- holding the empty string.
CREATE OR REPLACE FUNCTION short_videos.split_lines(value text)
RETURNS text[]
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE WHEN cardinality(lines) = 0 THEN NULL ELSE lines END
  FROM (
    SELECT array_agg(btrim(line) ORDER BY ordinality) AS lines
    FROM unnest(string_to_array(coalesce(value, ''), E'\n')) WITH ORDINALITY AS t(line, ordinality)
    WHERE btrim(line) <> ''
  ) collected;
$$;

CREATE TABLE IF NOT EXISTS short_videos.created_clips (
  created_clip_id            text PRIMARY KEY,
  download_job_id            text,
  video_id                   text REFERENCES short_videos.candidate_videos(video_id) ON DELETE SET NULL,
  clip_moment_id             text REFERENCES short_videos.clip_moments(clip_moment_id) ON DELETE SET NULL,
  niche                      text NOT NULL,
  clip_title                 text,
  clip_url                   text,
  local_file_name            text,
  google_drive_file_id       text,
  google_drive_url           text,
  duration_seconds           integer,
  transcript_excerpt         text,
  suggested_title            text,
  suggested_caption          text,
  content_thesis             text,
  hook                       text,
  narration_script           text,
  commentary_angle           text,
  kenyan_african_localization text,
  bible_verse_if_relevant    text,
  alternative_titles         text[],
  on_screen_text_beats       text[],
  broll_plan                 text[],
  editing_style              text,
  hashtags                   text[],
  cta                        text,
  risk_warning               text,
  originality_checklist      text[],
  transformation_plan        jsonb,
  review_status              text NOT NULL DEFAULT 'AWAITING_DOWNLOAD',
  reviewer_notes             text,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  -- NEEDS_RETRY is what WF8 writes when the transformation plan fails to parse
  -- or comes back without a title: the clip exists, the plan does not, and the
  -- operator must not see it in the review queue. Leaving it out of this list
  -- made every such write fail the constraint.
  CONSTRAINT created_clips_review_status_check CHECK (review_status IN (
    'AWAITING_DOWNLOAD', 'NEEDS_RETRY', 'NEEDS_REVIEW', 'APPROVED', 'REJECTED'))
);

-- The review UI's first screen reads exactly this set.
CREATE INDEX IF NOT EXISTS created_clips_needs_review_idx
  ON short_videos.created_clips (created_at)
  WHERE review_status = 'NEEDS_REVIEW';

CREATE TABLE IF NOT EXISTS short_videos.render_jobs (
  render_id              text PRIMARY KEY,
  created_clip_id        text REFERENCES short_videos.created_clips(created_clip_id) ON DELETE CASCADE,
  niche                  text NOT NULL,
  source_drive_file_id   text,
  source_drive_url       text,
  source_file_name       text,
  final_drive_folder_id  text,
  hook_text              text,
  cta_text               text,
  cta_start_second       numeric,
  cta_end_second         numeric,
  music_mood             text,
  music_energy_level     text,
  music_id               text,
  music_drive_file_id    text,
  music_file_name        text,
  music_volume           numeric,
  watermark_drive_file_id text,
  watermark_file_name    text,
  progress_bar_color     text,
  use_blurred_background boolean,
  ffmpeg_command         text,
  render_status          text NOT NULL DEFAULT 'PENDING',
  final_local_path       text,
  final_drive_file_id    text,
  final_drive_url        text,
  warning_message        text,
  error_message          text,
  created_at             timestamptz NOT NULL DEFAULT now(),
  started_at             timestamptz,
  completed_at           timestamptz,
  CONSTRAINT render_jobs_render_status_check CHECK (render_status IN (
    'PENDING', 'DOWNLOADING_ASSETS', 'RENDERING', 'UPLOADING', 'COMPLETED', 'FAILED', 'SKIPPED'))
);

CREATE INDEX IF NOT EXISTS render_jobs_pending_idx
  ON short_videos.render_jobs (created_at)
  WHERE render_status = 'PENDING';
