ALTER TABLE short_videos.publishing_jobs
  ADD COLUMN IF NOT EXISTS credential_slot text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS meta_graph_version text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS instagram_graph_host text NOT NULL DEFAULT 'graph.facebook.com',
  ADD COLUMN IF NOT EXISTS tiktok_domain_verified boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS tiktok_verified_url_prefix text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS public_video_url text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS provider_stage text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS provider_ref text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS provider_upload_url text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS provider_response jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS poll_after timestamptz,
  ADD COLUMN IF NOT EXISTS provider_poll_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS provider_poll_deadline timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'short_videos.publishing_jobs'::regclass
      AND conname = 'publishing_jobs_platform_destination_check'
  ) THEN
    ALTER TABLE short_videos.publishing_jobs
      ADD CONSTRAINT publishing_jobs_platform_destination_check CHECK (
        (platform = 'YOUTUBE_SHORTS' AND youtube_channel_id <> '')
        OR (platform = 'FACEBOOK_REELS' AND facebook_page_id <> '')
        OR (platform = 'INSTAGRAM_REELS' AND instagram_user_id <> '')
        OR (platform = 'TIKTOK' AND tiktok_open_id <> '')
      ) NOT VALID;
  END IF;
END;
$$;

CREATE INDEX IF NOT EXISTS publishing_jobs_provider_poll_idx
  ON short_videos.publishing_jobs (poll_after)
  WHERE publish_status = 'PROCESSING';
