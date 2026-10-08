-- Pipeline store, part 2 of 5: transcript analysis and clip moments.
-- Full URL / Drive file id columns from the Sheets era are deliberately absent:
-- Postgres text is unbounded, so the ~45k truncation and the Drive stash
-- that recovered the real value are both deleted.

CREATE TABLE IF NOT EXISTS short_videos.transcript_analysis (
  analysis_id             text PRIMARY KEY,
  video_id                text REFERENCES short_videos.candidate_videos(video_id) ON DELETE CASCADE,
  niche                   text NOT NULL,
  source_id               text REFERENCES short_videos.source_channels(source_id) ON DELETE SET NULL,
  video_title             text,
  video_url               text,
  transcript_status       text,
  transcript_text         text,
  transcript_length_words integer,
  ai_episode_score        numeric,
  recommended_strategy    text,
  recommended_start_sec   integer,
  recommended_end_sec     integer,
  reason_for_strategy     text,
  rights_risk             text,
  permission_risk         text,
  monetization_risk       text,
  originality_potential   text,
  kenya_relevance         text,
  ai_json_output          jsonb,
  created_at              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT transcript_analysis_status_check CHECK (transcript_status IS NULL OR transcript_status IN ('FETCHED', 'FAILED')),
  CONSTRAINT transcript_analysis_strategy_check CHECK (recommended_strategy IS NULL OR recommended_strategy IN (
    'USE_20_MIN_WINDOW', 'USE_EXACT_CLIPS_ONLY', 'SKIP_THIS_VIDEO'))
);

CREATE TABLE IF NOT EXISTS short_videos.clip_moments (
  clip_moment_id            text PRIMARY KEY,
  video_id                  text REFERENCES short_videos.candidate_videos(video_id) ON DELETE CASCADE,
  niche                     text NOT NULL,
  source_id                 text REFERENCES short_videos.source_channels(source_id) ON DELETE SET NULL,
  rank                      integer,
  start_sec                 integer,
  end_sec                   integer,
  clip_length_seconds       integer,
  hook_first_2_seconds      text,
  core_idea                 text,
  why_valuable              text,
  target_audience           text,
  suggested_title           text,
  suggested_caption         text,
  on_screen_text            text,
  suggested_broll           text,
  commentary_angle          text,
  kenyan_african_application text,
  bible_verse_if_relevant   text,
  needs_extra_context       boolean,
  originality_score         numeric,
  clip_score                numeric,
  rights_risk               text,
  final_recommendation      text,
  download_status           text NOT NULL DEFAULT 'PENDING',
  download_job_id           text,
  strategy                  text,
  source_video_url          text,
  created_at                timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT clip_moments_download_status_check CHECK (download_status IN (
    'PENDING', 'SUBMITTED', 'COMPLETED', 'ERROR', 'AWAITING_MANUAL_APPROVAL')),
  CONSTRAINT clip_moments_recommendation_check CHECK (final_recommendation IS NULL OR final_recommendation IN (
    'clip', 'use_as_idea_only', 'skip'))
);

-- The review UI's third screen reads exactly this set.
CREATE INDEX IF NOT EXISTS clip_moments_awaiting_approval_idx
  ON short_videos.clip_moments (niche)
  WHERE download_status = 'AWAITING_MANUAL_APPROVAL';
