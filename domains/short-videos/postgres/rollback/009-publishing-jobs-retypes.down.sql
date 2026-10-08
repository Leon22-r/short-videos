-- Reverses 009-publishing-jobs-retypes.sql. Not run by run-migrations.sh;
-- applied by hand during a rollback, before reverting the commit range.

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
  RETURN 'infinity'::timestamptz;
END;
$$;

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
    EXECUTE format('UPDATE short_videos.publishing_jobs SET %I = '''' WHERE %I IS NULL', target, target);
    EXECUTE format('ALTER TABLE short_videos.publishing_jobs ALTER COLUMN %I SET DEFAULT ''''', target);
    EXECUTE format('ALTER TABLE short_videos.publishing_jobs ALTER COLUMN %I SET NOT NULL', target);
  END LOOP;
END $$;

UPDATE short_videos.publishing_jobs SET approved_id = '' WHERE approved_id IS NULL;
ALTER TABLE short_videos.publishing_jobs ALTER COLUMN approved_id SET NOT NULL;

ALTER TABLE short_videos.publishing_jobs
  DROP CONSTRAINT IF EXISTS publishing_jobs_platform_destination_check;

ALTER TABLE short_videos.publishing_jobs
  ADD CONSTRAINT publishing_jobs_platform_destination_check CHECK (
    (publishing_backend = 'POSTIZ' AND btrim(postiz_integration_id) <> '')
    OR (publishing_backend = 'DIRECT' AND (
      (platform = 'YOUTUBE_SHORTS' AND youtube_channel_id <> '')
      OR (platform = 'FACEBOOK_REELS' AND facebook_page_id <> '')
      OR (platform = 'INSTAGRAM_REELS' AND instagram_user_id <> '')
      OR (platform = 'TIKTOK' AND tiktok_open_id <> '')
    ))
  );
