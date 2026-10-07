CREATE SCHEMA IF NOT EXISTS short_videos;

CREATE OR REPLACE FUNCTION short_videos.safe_schedule_at(value text)
RETURNS timestamptz
LANGUAGE plpgsql
IMMUTABLE
AS $$
BEGIN
  IF value IS NULL OR btrim(value) = '' THEN
    RETURN NULL;
  END IF;
  RETURN value::timestamptz;
EXCEPTION WHEN OTHERS THEN
  -- Invalid schedules fail closed: they never become due until an operator fixes them.
  RETURN 'infinity'::timestamptz;
END;
$$;

CREATE TABLE IF NOT EXISTS short_videos.publishing_jobs (
  publish_id text PRIMARY KEY,
  approved_id text NOT NULL DEFAULT '',
  render_id text NOT NULL DEFAULT '',
  created_clip_id text NOT NULL DEFAULT '',
  niche text NOT NULL DEFAULT '',
  platform text NOT NULL,
  channel_id text NOT NULL DEFAULT '',
  destination_id text NOT NULL DEFAULT '',
  youtube_channel_id text NOT NULL DEFAULT '',
  facebook_page_id text NOT NULL DEFAULT '',
  instagram_user_id text NOT NULL DEFAULT '',
  tiktok_open_id text NOT NULL DEFAULT '',
  credential_slot text NOT NULL DEFAULT '',
  meta_graph_version text NOT NULL DEFAULT '',
  instagram_graph_host text NOT NULL DEFAULT 'graph.facebook.com',
  tiktok_domain_verified boolean NOT NULL DEFAULT false,
  tiktok_verified_url_prefix text NOT NULL DEFAULT '',
  default_privacy text NOT NULL DEFAULT 'private',
  requires_manual_publish boolean NOT NULL DEFAULT false,
  audit_status text NOT NULL DEFAULT '',
  tiktok_mode text NOT NULL DEFAULT 'DIRECT',
  video_source text NOT NULL DEFAULT '',
  video_file_id text NOT NULL DEFAULT '',
  video_url text NOT NULL DEFAULT '',
  public_video_url text NOT NULL DEFAULT '',
  local_file_path text NOT NULL DEFAULT '',
  title text NOT NULL DEFAULT '',
  caption text NOT NULL DEFAULT '',
  description text NOT NULL DEFAULT '',
  hashtags text NOT NULL DEFAULT '',
  scheduled_at timestamptz,
  publish_status text NOT NULL DEFAULT 'PENDING',
  retry_count integer NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
  next_retry_at timestamptz,
  last_error text NOT NULL DEFAULT '',
  post_id text NOT NULL DEFAULT '',
  post_url text NOT NULL DEFAULT '',
  started_at timestamptz,
  completed_at timestamptz,
  claimed_at timestamptz,
  claimed_by text NOT NULL DEFAULT '',
  lease_expires_at timestamptz,
  provider_stage text NOT NULL DEFAULT '',
  provider_ref text NOT NULL DEFAULT '',
  provider_upload_url text NOT NULL DEFAULT '',
  provider_response jsonb NOT NULL DEFAULT '{}'::jsonb,
  poll_after timestamptz,
  provider_poll_count integer NOT NULL DEFAULT 0 CHECK (provider_poll_count >= 0),
  provider_poll_deadline timestamptz,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT publishing_jobs_platform_check CHECK (
    platform IN ('YOUTUBE_SHORTS', 'FACEBOOK_REELS', 'INSTAGRAM_REELS', 'TIKTOK')
  ),
  CONSTRAINT publishing_jobs_platform_destination_check CHECK (
    (platform = 'YOUTUBE_SHORTS' AND youtube_channel_id <> '')
    OR (platform = 'FACEBOOK_REELS' AND facebook_page_id <> '')
    OR (platform = 'INSTAGRAM_REELS' AND instagram_user_id <> '')
    OR (platform = 'TIKTOK' AND tiktok_open_id <> '')
  ),
  CONSTRAINT publishing_jobs_status_check CHECK (
    publish_status IN (
      'PENDING', 'CLAIMED', 'UPLOADING', 'PROCESSING', 'PUBLISHED',
      'DRAFT_UPLOADED', 'RETRY_PENDING', 'AUTH_REQUIRED', 'REJECTED',
      'FAILED', 'SKIPPED'
    )
  )
);

-- Existing local volumes do not replay docker-entrypoint init files. Keep this
-- migration idempotent so the same SQL can upgrade local Postgres and Neon.
ALTER TABLE short_videos.publishing_jobs ADD COLUMN IF NOT EXISTS credential_slot text NOT NULL DEFAULT '';
ALTER TABLE short_videos.publishing_jobs ADD COLUMN IF NOT EXISTS meta_graph_version text NOT NULL DEFAULT '';
ALTER TABLE short_videos.publishing_jobs ADD COLUMN IF NOT EXISTS instagram_graph_host text NOT NULL DEFAULT 'graph.facebook.com';
ALTER TABLE short_videos.publishing_jobs ADD COLUMN IF NOT EXISTS tiktok_domain_verified boolean NOT NULL DEFAULT false;
ALTER TABLE short_videos.publishing_jobs ADD COLUMN IF NOT EXISTS tiktok_verified_url_prefix text NOT NULL DEFAULT '';
ALTER TABLE short_videos.publishing_jobs ADD COLUMN IF NOT EXISTS public_video_url text NOT NULL DEFAULT '';
ALTER TABLE short_videos.publishing_jobs ADD COLUMN IF NOT EXISTS provider_stage text NOT NULL DEFAULT '';
ALTER TABLE short_videos.publishing_jobs ADD COLUMN IF NOT EXISTS provider_ref text NOT NULL DEFAULT '';
ALTER TABLE short_videos.publishing_jobs ADD COLUMN IF NOT EXISTS provider_upload_url text NOT NULL DEFAULT '';
ALTER TABLE short_videos.publishing_jobs ADD COLUMN IF NOT EXISTS provider_response jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE short_videos.publishing_jobs ADD COLUMN IF NOT EXISTS poll_after timestamptz;
ALTER TABLE short_videos.publishing_jobs ADD COLUMN IF NOT EXISTS provider_poll_count integer NOT NULL DEFAULT 0;
ALTER TABLE short_videos.publishing_jobs ADD COLUMN IF NOT EXISTS provider_poll_deadline timestamptz;

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

CREATE INDEX IF NOT EXISTS publishing_jobs_due_idx
  ON short_videos.publishing_jobs (publish_status, scheduled_at, next_retry_at, created_at);

CREATE INDEX IF NOT EXISTS publishing_jobs_lease_idx
  ON short_videos.publishing_jobs (lease_expires_at)
  WHERE publish_status IN ('CLAIMED', 'UPLOADING');

CREATE INDEX IF NOT EXISTS publishing_jobs_worker_idx
  ON short_videos.publishing_jobs (claimed_by)
  WHERE claimed_by <> '';

CREATE INDEX IF NOT EXISTS publishing_jobs_provider_poll_idx
  ON short_videos.publishing_jobs (poll_after)
  WHERE publish_status = 'PROCESSING';

-- Postiz backend additions also apply on fresh database initialization.
BEGIN;

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

COMMIT;
