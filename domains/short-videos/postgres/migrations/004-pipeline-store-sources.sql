-- Pipeline store, part 1 of 5: the chain head.
-- Replayed on every container start; every statement must be idempotent.

CREATE TABLE IF NOT EXISTS short_videos.source_channels (
  source_id                text PRIMARY KEY,
  niche                    text NOT NULL,
  source_name              text NOT NULL,
  youtube_channel_url      text NOT NULL,
  youtube_channel_id       text,
  uploads_playlist_id      text,
  source_type              text,
  priority                 integer NOT NULL DEFAULT 1,
  risk_level               text,
  permission_risk          text,
  monetization_risk        text,
  notes                    text,
  active_status            boolean NOT NULL DEFAULT true,
  last_checked_at          timestamptz,
  backfill_next_page_token text,
  backfill_status          text NOT NULL DEFAULT 'NOT_STARTED',
  videos_known_count       integer,
  videos_fetched_count     integer NOT NULL DEFAULT 0,
  backfill_last_run_at     timestamptz,
  total_analyzed_count     integer NOT NULL DEFAULT 0,
  channel_skip_rate        numeric,
  auto_paused_at           timestamptz,
  auto_paused_reason       text,
  health_reset_at          timestamptz,
  created_at               timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT source_channels_niche_check CHECK (niche IN (
    'CHRISTIAN_CONTENT', 'MOTIVATION_DISCIPLINE', 'FINANCE_BUSINESS',
    'LIFE_VALUES_RELATIONSHIPS', 'AFRICAN_KENYAN_SUCCESS')),
  CONSTRAINT source_channels_risk_level_check CHECK (risk_level IS NULL OR risk_level IN ('low', 'medium', 'high')),
  CONSTRAINT source_channels_permission_risk_check CHECK (permission_risk IS NULL OR permission_risk IN ('low', 'medium', 'high')),
  CONSTRAINT source_channels_monetization_risk_check CHECK (monetization_risk IS NULL OR monetization_risk IN ('low', 'medium', 'high')),
  CONSTRAINT source_channels_backfill_status_check CHECK (backfill_status IN ('NOT_STARTED', 'IN_PROGRESS', 'COMPLETE'))
);

CREATE TABLE IF NOT EXISTS short_videos.candidate_videos (
  video_id              text PRIMARY KEY,
  niche                 text NOT NULL,
  source_id             text REFERENCES short_videos.source_channels(source_id) ON DELETE SET NULL,
  source_name           text,
  video_title           text,
  video_url             text,
  youtube_video_id      text NOT NULL,
  duration_seconds      integer,
  published_at          timestamptz,
  view_count            bigint,
  like_count            bigint,
  comment_count         bigint,
  like_percentage       numeric,
  comment_percentage    numeric,
  engagement_percentage numeric,
  transcript_available  boolean,
  language              text,
  validity_status       text,
  validity_score        numeric,
  rejection_reason      text,
  duplicate_status      text,
  processing_status     text NOT NULL DEFAULT 'NEW',
  created_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT candidate_videos_niche_check CHECK (niche IN (
    'CHRISTIAN_CONTENT', 'MOTIVATION_DISCIPLINE', 'FINANCE_BUSINESS',
    'LIFE_VALUES_RELATIONSHIPS', 'AFRICAN_KENYAN_SUCCESS')),
  CONSTRAINT candidate_videos_validity_status_check CHECK (validity_status IS NULL OR validity_status IN ('VALID', 'REJECTED', 'FLAGGED')),
  CONSTRAINT candidate_videos_duplicate_status_check CHECK (duplicate_status IS NULL OR duplicate_status IN ('UNIQUE', 'DUPLICATE')),
  CONSTRAINT candidate_videos_processing_status_check CHECK (processing_status IN ('NEW', 'ANALYZED', 'SKIPPED', 'CLIPPING', 'DONE'))
);

CREATE INDEX IF NOT EXISTS candidate_videos_pending_idx
  ON short_videos.candidate_videos (processing_status, source_id)
  WHERE processing_status = 'NEW';

CREATE INDEX IF NOT EXISTS candidate_videos_youtube_video_id_idx
  ON short_videos.candidate_videos (youtube_video_id);
