-- Pipeline store, part 4 of 5: assets and the error log.

CREATE TABLE IF NOT EXISTS short_videos.music_library (
  music_id           text PRIMARY KEY,
  niche              text,
  mood               text,
  energy_level       text,
  track_name         text,
  artist_name        text,
  source             text,
  source_url         text,
  license_notes      text,
  drive_file_id      text,
  duration_seconds   integer,
  recommended_volume numeric,
  loop_allowed       boolean,
  active_status      boolean NOT NULL DEFAULT true,
  times_used         integer NOT NULL DEFAULT 0,
  created_at         timestamptz NOT NULL DEFAULT now(),
  last_used_at       timestamptz,
  notes              text
);

CREATE INDEX IF NOT EXISTS music_library_selection_idx
  ON short_videos.music_library (niche, mood, energy_level)
  WHERE active_status;

-- branding_id is a surrogate key the Sheet did not have. The structure doc
-- keys this tab on niche, but its own notes tell operators to pause a row
-- with active_status=FALSE rather than delete it, which needs more than one
-- row per niche. The partial unique index below is the real invariant, and it
-- moves WF8c's mid-render duplicate check to write time.
CREATE TABLE IF NOT EXISTS short_videos.channel_branding (
  branding_id             text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  niche                   text NOT NULL,
  watermark_drive_file_id text,
  primary_color           text,
  secondary_color         text,
  progress_bar_color      text,
  default_cta             text,
  music_default_id        text REFERENCES short_videos.music_library(music_id) ON DELETE SET NULL,
  active_status           boolean NOT NULL DEFAULT true,
  notes                   text,
  created_at              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT channel_branding_progress_bar_color_check CHECK (
    progress_bar_color IS NULL OR progress_bar_color ~ '^0x[0-9A-Fa-f]{6}$')
);

CREATE UNIQUE INDEX IF NOT EXISTS channel_branding_one_active_per_niche_idx
  ON short_videos.channel_branding (niche)
  WHERE active_status;

CREATE TABLE IF NOT EXISTS short_videos.error_log (
  error_id         text PRIMARY KEY,
  workflow_name    text,
  node_name        text,
  related_video_id text,
  error_type       text,
  error_message    text,
  raw_payload      jsonb,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS error_log_recent_idx ON short_videos.error_log (created_at DESC);
