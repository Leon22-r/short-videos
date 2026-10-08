-- Pipeline store, part 5 of 5: the approval and destination tables.

CREATE TABLE IF NOT EXISTS short_videos.approved_for_posting (
  approved_id       text PRIMARY KEY,
  created_clip_id   text NOT NULL REFERENCES short_videos.created_clips(created_clip_id) ON DELETE CASCADE,
  render_id         text REFERENCES short_videos.render_jobs(render_id) ON DELETE SET NULL,
  niche             text NOT NULL,
  platforms         text[] NOT NULL,
  final_title       text NOT NULL,
  final_caption     text,
  final_description text,
  hashtags          text[],
  status            text NOT NULL DEFAULT 'PENDING',
  scheduled_at      timestamptz,
  public_video_url  text,
  posted_url        text,
  performance_notes text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT approved_for_posting_status_check CHECK (status IN ('PENDING', 'APPROVED', 'READY', 'REJECTED')),
  -- Blank does not mean all platforms. An empty array is rejected outright.
  CONSTRAINT approved_for_posting_platforms_present_check CHECK (cardinality(platforms) > 0),
  CONSTRAINT approved_for_posting_platforms_supported_check CHECK (
    platforms <@ ARRAY['YOUTUBE_SHORTS', 'TIKTOK', 'INSTAGRAM_REELS', 'FACEBOOK_REELS'])
);

-- One approval row per clip. Review Focus 5: this is what makes a second
-- approve_clip() call unable to create a duplicate.
CREATE UNIQUE INDEX IF NOT EXISTS approved_for_posting_one_per_clip_idx
  ON short_videos.approved_for_posting (created_clip_id);

CREATE TABLE IF NOT EXISTS short_videos.publishing_channels (
  channel_id                text PRIMARY KEY,
  niche                     text NOT NULL,
  platform                  text NOT NULL,
  enabled_status            boolean NOT NULL DEFAULT false,
  publishing_backend        text NOT NULL DEFAULT 'DIRECT',
  postiz_integration_id     text,
  credential_name           text,
  credential_slot           text,
  youtube_channel_id        text,
  facebook_page_id          text,
  instagram_user_id         text,
  tiktok_open_id            text,
  meta_graph_version        text,
  instagram_graph_host      text DEFAULT 'graph.facebook.com',
  tiktok_domain_verified    boolean NOT NULL DEFAULT false,
  tiktok_verified_url_prefix text,
  default_privacy           text NOT NULL DEFAULT 'private',
  requires_manual_publish   boolean NOT NULL DEFAULT false,
  audit_status              text,
  token_expires_at          timestamptz,
  last_expiry_audit_at      timestamptz,
  last_health_status        text,
  notes                     text,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT publishing_channels_platform_check CHECK (platform IN (
    'YOUTUBE_SHORTS', 'FACEBOOK_REELS', 'INSTAGRAM_REELS', 'TIKTOK')),
  CONSTRAINT publishing_channels_backend_check CHECK (publishing_backend IN ('DIRECT', 'POSTIZ')),
  CONSTRAINT publishing_channels_credential_slot_check CHECK (credential_slot IS NULL OR credential_slot IN (
    'YOUTUBE_PRIMARY', 'FACEBOOK_PRIMARY', 'INSTAGRAM_PRIMARY', 'TIKTOK_PRIMARY', 'POSTIZ_PRIMARY')),
  CONSTRAINT publishing_channels_audit_status_check CHECK (audit_status IS NULL OR audit_status IN (
    'DEV_PRIVATE_ONLY', 'APPROVED_PUBLIC', 'NEEDS_REVIEW')),
  CONSTRAINT publishing_channels_graph_host_check CHECK (instagram_graph_host IS NULL OR instagram_graph_host IN (
    'graph.facebook.com', 'graph.instagram.com')),
  CONSTRAINT publishing_channels_meta_version_check CHECK (meta_graph_version IS NULL OR meta_graph_version ~ '^v[0-9]+\.[0-9]+$'),
  -- The structure doc: requires_manual_publish must be TRUE for TikTok,
  -- because WF12 supports draft/inbox upload only.
  CONSTRAINT publishing_channels_tiktok_manual_check CHECK (
    platform <> 'TIKTOK' OR requires_manual_publish),
  CONSTRAINT publishing_channels_postiz_identity_check CHECK (
    publishing_backend <> 'POSTIZ' OR (postiz_integration_id IS NOT NULL AND btrim(postiz_integration_id) <> ''))
);

CREATE INDEX IF NOT EXISTS publishing_channels_enabled_idx
  ON short_videos.publishing_channels (niche, platform)
  WHERE enabled_status;
