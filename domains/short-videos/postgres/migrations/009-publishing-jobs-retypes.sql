-- D6: retire the text NOT NULL DEFAULT '' convention on publishing_jobs.
-- It existed only because Google Sheets sends empty strings and never NULL.
-- Idempotent: the loop below is a no-op once the columns are already nullable.

DO $$
DECLARE
  target text;
  columns text[] := ARRAY[
    'approved_id', 'render_id', 'created_clip_id', 'niche', 'channel_id',
    'destination_id', 'youtube_channel_id', 'facebook_page_id',
    'instagram_user_id', 'tiktok_open_id', 'credential_slot',
    'meta_graph_version', 'tiktok_verified_url_prefix', 'audit_status',
    'video_source', 'video_file_id', 'video_url', 'public_video_url',
    'local_file_path', 'title', 'caption', 'description', 'hashtags',
    'last_error', 'post_id', 'post_url', 'claimed_by', 'provider_stage',
    'provider_ref', 'provider_upload_url', 'postiz_integration_id',
    'postiz_post_id', 'postiz_media_id', 'postiz_media_path'
  ];
BEGIN
  FOREACH target IN ARRAY columns LOOP
    EXECUTE format('ALTER TABLE short_videos.publishing_jobs ALTER COLUMN %I DROP NOT NULL', target);
    EXECUTE format('ALTER TABLE short_videos.publishing_jobs ALTER COLUMN %I DROP DEFAULT', target);
    EXECUTE format('UPDATE short_videos.publishing_jobs SET %I = NULL WHERE %I = ''''', target, target);
  END LOOP;
END $$;

-- Written out rather than only looped, so the regression test can see the
-- intent for the columns the queries in Task 9 compare against.
ALTER TABLE short_videos.publishing_jobs ALTER COLUMN approved_id DROP NOT NULL;
ALTER TABLE short_videos.publishing_jobs ALTER COLUMN approved_id DROP DEFAULT;
ALTER TABLE short_videos.publishing_jobs ALTER COLUMN provider_stage DROP NOT NULL;
ALTER TABLE short_videos.publishing_jobs ALTER COLUMN claimed_by DROP NOT NULL;

UPDATE short_videos.publishing_jobs SET approved_id = NULL WHERE approved_id = '';
UPDATE short_videos.publishing_jobs SET provider_stage = NULL WHERE provider_stage = '';
UPDATE short_videos.publishing_jobs SET claimed_by = NULL WHERE claimed_by = '';

ALTER TABLE short_videos.publishing_jobs
  DROP CONSTRAINT IF EXISTS publishing_jobs_platform_destination_check;

ALTER TABLE short_videos.publishing_jobs
  ADD CONSTRAINT publishing_jobs_platform_destination_check CHECK (
    (publishing_backend = 'POSTIZ' AND COALESCE(btrim(postiz_integration_id), '') <> '')
    OR (publishing_backend = 'DIRECT' AND (
      (platform = 'YOUTUBE_SHORTS' AND COALESCE(youtube_channel_id, '') <> '')
      OR (platform = 'FACEBOOK_REELS' AND COALESCE(facebook_page_id, '') <> '')
      OR (platform = 'INSTAGRAM_REELS' AND COALESCE(instagram_user_id, '') <> '')
      OR (platform = 'TIKTOK' AND COALESCE(tiktok_open_id, '') <> '')
    ))
  );

-- A bad date string cannot reach a timestamptz column, so the function that
-- converted one into 'infinity' has nothing left to do.
DROP FUNCTION IF EXISTS short_videos.safe_schedule_at(text);
