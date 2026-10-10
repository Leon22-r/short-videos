ALTER TABLE short_videos.publishing_jobs
  ADD COLUMN IF NOT EXISTS publishing_backend text NOT NULL DEFAULT 'DIRECT',
  ADD COLUMN IF NOT EXISTS postiz_integration_id text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS postiz_post_id text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS postiz_media_id text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS postiz_media_path text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS postiz_submit_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS postiz_submitted_at timestamptz;

ALTER TABLE short_videos.publishing_jobs
  DROP CONSTRAINT IF EXISTS publishing_jobs_backend_check,
  DROP CONSTRAINT IF EXISTS publishing_jobs_platform_destination_check;

ALTER TABLE short_videos.publishing_jobs
  ADD CONSTRAINT publishing_jobs_backend_check CHECK (publishing_backend IN ('DIRECT', 'POSTIZ')),
  ADD CONSTRAINT publishing_jobs_platform_destination_check CHECK (
    (publishing_backend = 'POSTIZ' AND btrim(postiz_integration_id) <> '')
    OR (publishing_backend = 'DIRECT' AND (
      (platform = 'YOUTUBE_SHORTS' AND youtube_channel_id <> '')
      OR (platform = 'FACEBOOK_REELS' AND facebook_page_id <> '')
      OR (platform = 'INSTAGRAM_REELS' AND instagram_user_id <> '')
      OR (platform = 'TIKTOK' AND tiktok_open_id <> '')
    ))
  ) NOT VALID;

COMMENT ON COLUMN short_videos.publishing_jobs.postiz_submitted_at IS
  'Time of durable submission intent, not proof that Postiz accepted the request.';
