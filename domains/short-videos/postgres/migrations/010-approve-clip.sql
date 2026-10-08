-- The review UI's approve button. PostgREST cannot do a multi-table
-- transaction, and a clip marked APPROVED with no approved_for_posting row
-- vanishes from both queues and is never published, so both writes happen
-- here or neither does.

CREATE OR REPLACE FUNCTION short_videos.approve_clip(
  p_created_clip_id text,
  p_final_title     text,
  p_final_caption   text,
  p_platforms       text[],
  p_hashtags        text[] DEFAULT NULL,
  p_scheduled_at    timestamptz DEFAULT NULL,
  p_reviewer_notes  text DEFAULT NULL
)
RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  v_clip        short_videos.created_clips;
  v_approved_id text := 'APPROVE-' || p_created_clip_id;
  v_existing    text;
  v_supported   text[] := ARRAY['YOUTUBE_SHORTS', 'TIKTOK', 'INSTAGRAM_REELS', 'FACEBOOK_REELS'];
BEGIN
  -- Blank does not mean all platforms.
  IF p_platforms IS NULL OR cardinality(p_platforms) = 0 THEN
    RAISE EXCEPTION 'approve_clip requires at least one platform';
  END IF;
  IF NOT (p_platforms <@ v_supported) THEN
    RAISE EXCEPTION 'approve_clip got an unsupported platform: %',
      array_to_string(ARRAY(SELECT unnest(p_platforms) EXCEPT SELECT unnest(v_supported)), ', ');
  END IF;
  IF p_final_title IS NULL OR btrim(p_final_title) = '' THEN
    RAISE EXCEPTION 'approve_clip requires a non-blank final title';
  END IF;

  -- Review Focus 5: a repeat call returns the first result instead of
  -- inserting a second approval.
  SELECT approved_id INTO v_existing
  FROM short_videos.approved_for_posting
  WHERE created_clip_id = p_created_clip_id;
  IF v_existing IS NOT NULL THEN
    RETURN v_existing;
  END IF;

  SELECT * INTO v_clip
  FROM short_videos.created_clips
  WHERE created_clip_id = p_created_clip_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'approve_clip got an unknown created_clip_id: %', p_created_clip_id;
  END IF;
  IF v_clip.review_status <> 'NEEDS_REVIEW' THEN
    RAISE EXCEPTION 'approve_clip requires review_status NEEDS_REVIEW, found %', v_clip.review_status;
  END IF;

  INSERT INTO short_videos.approved_for_posting (
    approved_id, created_clip_id, render_id, niche, platforms,
    final_title, final_caption, hashtags, status, scheduled_at
  )
  SELECT
    v_approved_id, v_clip.created_clip_id,
    (SELECT render_id FROM short_videos.render_jobs
      WHERE created_clip_id = v_clip.created_clip_id AND render_status = 'COMPLETED'
      ORDER BY completed_at DESC NULLS LAST LIMIT 1),
    v_clip.niche,
    ARRAY(SELECT DISTINCT unnest(p_platforms) ORDER BY 1),
    btrim(p_final_title), NULLIF(btrim(p_final_caption), ''),
    p_hashtags, 'APPROVED', p_scheduled_at;

  UPDATE short_videos.created_clips
  SET review_status = 'APPROVED',
      reviewer_notes = COALESCE(NULLIF(btrim(p_reviewer_notes), ''), reviewer_notes)
  WHERE created_clip_id = p_created_clip_id;

  RETURN v_approved_id;
END;
$$;

-- Rejecting is a single-table write, but it belongs next to its sibling so
-- the UI has one calling convention for both buttons.
CREATE OR REPLACE FUNCTION short_videos.reject_clip(
  p_created_clip_id text,
  p_reviewer_notes  text DEFAULT NULL
)
RETURNS void
LANGUAGE sql
AS $$
  UPDATE short_videos.created_clips
  SET review_status = 'REJECTED',
      reviewer_notes = COALESCE(NULLIF(btrim(p_reviewer_notes), ''), reviewer_notes)
  WHERE created_clip_id = p_created_clip_id
    AND review_status = 'NEEDS_REVIEW';
$$;
