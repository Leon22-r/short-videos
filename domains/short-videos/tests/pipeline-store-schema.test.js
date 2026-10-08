const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

test('source and candidate tables are typed, constrained and replay-safe', () => {
  const schema = read('postgres/migrations/004-pipeline-store-sources.sql');

  assert.match(schema, /CREATE TABLE IF NOT EXISTS short_videos\.source_channels/);
  assert.match(schema, /source_id\s+text PRIMARY KEY/);
  assert.match(schema, /active_status\s+boolean/);
  assert.match(schema, /last_checked_at\s+timestamptz/);
  assert.match(schema, /videos_known_count\s+integer/);
  assert.match(schema, /CHECK\s*\(\s*niche\s+IN\s*\(\s*'CHRISTIAN_CONTENT'/);
  assert.match(schema, /CHECK\s*\(\s*risk_level IS NULL OR risk_level IN \('low', 'medium', 'high'\)\)/);
  assert.match(schema, /CHECK\s*\(\s*backfill_status IN \('NOT_STARTED', 'IN_PROGRESS', 'COMPLETE'\)\)/);

  assert.match(schema, /CREATE TABLE IF NOT EXISTS short_videos\.candidate_videos/);
  assert.match(schema, /video_id\s+text PRIMARY KEY/);
  assert.match(schema, /REFERENCES short_videos\.source_channels/);
  assert.match(schema, /youtube_video_id\s+text NOT NULL/);
  assert.match(schema, /like_percentage\s+numeric/);
  assert.match(schema, /CHECK\s*\(\s*processing_status IN \('NEW', 'ANALYZED', 'SKIPPED', 'CLIPPING', 'DONE'\)\)/);
  assert.match(schema, /CHECK\s*\(\s*validity_status IS NULL OR validity_status IN \('VALID', 'REJECTED', 'FLAGGED'\)\)/);
  assert.match(schema, /CHECK\s*\(\s*duplicate_status IS NULL OR duplicate_status IN \('UNIQUE', 'DUPLICATE'\)\)/);

  // D6: the Sheets-era convention must not come back.
  assert.doesNotMatch(schema, /text NOT NULL DEFAULT ''/);
  // Status values live in CHECK constraints, not enum types.
  assert.doesNotMatch(schema, /CREATE TYPE/i);
});

test('analysis tables drop the truncation columns and apply the D7 rename', () => {
  const schema = read('postgres/migrations/005-pipeline-store-analysis.sql');

  assert.match(schema, /transcript_text\s+text/);
  assert.match(schema, /ai_json_output\s+jsonb/);
  assert.match(schema, /CHECK\s*\(\s*transcript_status IS NULL OR transcript_status IN \('FETCHED', 'FAILED'\)\)/);
  assert.match(schema, /CHECK\s*\(\s*recommended_strategy IS NULL OR recommended_strategy IN \(\s*'USE_20_MIN_WINDOW', 'USE_EXACT_CLIPS_ONLY', 'SKIP_THIS_VIDEO'\)\)/);

  // Section 1 item 1: Postgres text is unbounded, so the Drive stash is deleted.
  assert.doesNotMatch(schema, /transcript_full_url/);
  assert.doesNotMatch(schema, /transcript_full_file_id/);

  // D7: the legacy ssemble_* names do not survive.
  assert.match(schema, /download_status\s+text/);
  assert.match(schema, /download_job_id\s+text/);
  assert.match(schema, /error_message\s+text/);
  assert.doesNotMatch(schema, /ssemble_status/);
  assert.doesNotMatch(schema, /ssemble_job_id/);
  assert.match(schema, /CHECK\s*\(\s*download_status IN \(\s*'PENDING', 'SUBMITTED', 'COMPLETED', 'ERROR', 'AWAITING_MANUAL_APPROVAL'\)\)/);
  assert.match(schema, /CHECK\s*\(\s*final_recommendation IS NULL OR final_recommendation IN\s*\(\s*'clip', 'use_as_idea_only', 'skip'\)\)/);

  assert.doesNotMatch(schema, /text NOT NULL DEFAULT ''/);
});

test('clip and render tables use arrays, jsonb and real timestamps', () => {
  const schema = read('postgres/migrations/006-pipeline-store-clips.sql');

  // Section 1 item 3: the newline-separated lists become real arrays.
  assert.match(schema, /alternative_titles\s+text\[\]/);
  assert.match(schema, /on_screen_text_beats\s+text\[\]/);
  assert.match(schema, /broll_plan\s+text\[\]/);
  assert.match(schema, /originality_checklist\s+text\[\]/);
  assert.match(schema, /transformation_plan\s+jsonb/);

  assert.match(schema, /CHECK\s*\(\s*review_status IN\s*\(\s*'AWAITING_DOWNLOAD', 'NEEDS_RETRY', 'NEEDS_REVIEW', 'APPROVED', 'REJECTED'\)\)/);
  assert.match(schema, /download_job_id\s+text/);
  assert.doesNotMatch(schema, /ssemble_job_id/);

  assert.match(schema, /CHECK\s*\(\s*render_status IN\s*\(\s*'PENDING', 'DOWNLOADING_ASSETS', 'RENDERING', 'UPLOADING', 'COMPLETED', 'FAILED', 'SKIPPED'\)\)/);
  assert.match(schema, /use_blurred_background\s+boolean/);
  assert.match(schema, /started_at\s+timestamptz/);
  assert.match(schema, /completed_at\s+timestamptz/);

  assert.doesNotMatch(schema, /text NOT NULL DEFAULT ''/);
});

test('asset tables move the branding uniqueness check to write time', () => {
  const schema = read('postgres/migrations/007-pipeline-store-assets.sql');

  assert.match(schema, /CREATE TABLE IF NOT EXISTS short_videos\.music_library/);
  assert.match(schema, /loop_allowed\s+boolean/);
  assert.match(schema, /times_used\s+integer/);
  assert.match(schema, /last_used_at\s+timestamptz/);

  assert.match(schema, /CREATE TABLE IF NOT EXISTS short_videos\.channel_branding/);
  // Spec Section 1: a unique partial index turns a mid-render failure into a write-time one.
  assert.match(schema, /CREATE UNIQUE INDEX IF NOT EXISTS channel_branding_one_active_per_niche_idx/);
  assert.match(schema, /WHERE active_status/);

  assert.match(schema, /CREATE TABLE IF NOT EXISTS short_videos\.error_log/);
  assert.match(schema, /raw_payload\s+jsonb/);

  assert.doesNotMatch(schema, /text NOT NULL DEFAULT ''/);
});

test('publishing tables fail closed on status and platform', () => {
  const schema = read('postgres/migrations/008-pipeline-store-publishing.sql');

  // The structure doc: only APPROVED or READY authorizes WF11; blank fails closed.
  assert.match(schema, /CHECK\s*\(\s*status IN\s*\(\s*'PENDING', 'APPROVED', 'READY', 'REJECTED'\)\)/);
  // The structure doc: "platform must contain at least one explicit supported
  // value. Blank does not mean all platforms." A text[] with a length check
  // makes that structural instead of conventional.
  assert.match(schema, /platforms\s+text\[\]/);
  assert.match(schema, /cardinality\(platforms\) > 0/);
  assert.match(schema, /platforms <@ ARRAY\['YOUTUBE_SHORTS', 'TIKTOK', 'INSTAGRAM_REELS', 'FACEBOOK_REELS'\]/);
  assert.match(schema, /scheduled_at\s+timestamptz/);

  assert.match(schema, /CREATE TABLE IF NOT EXISTS short_videos\.publishing_channels/);
  assert.match(schema, /enabled_status\s+boolean/);
  assert.match(schema, /tiktok_domain_verified\s+boolean/);
  assert.match(schema, /token_expires_at\s+timestamptz/);
  assert.match(schema, /CHECK\s*\(\s*credential_slot IS NULL OR credential_slot IN\s*\(\s*'YOUTUBE_PRIMARY', 'FACEBOOK_PRIMARY', 'INSTAGRAM_PRIMARY', 'TIKTOK_PRIMARY', 'POSTIZ_PRIMARY'\)\)/);
  assert.match(schema, /CHECK\s*\(\s*audit_status IS NULL OR audit_status IN\s*\(\s*'DEV_PRIVATE_ONLY', 'APPROVED_PUBLIC', 'NEEDS_REVIEW'\)\)/);
  assert.match(schema, /CHECK\s*\(\s*instagram_graph_host IS NULL OR instagram_graph_host IN\s*\(\s*'graph\.facebook\.com', 'graph\.instagram\.com'\)\)/);

  assert.doesNotMatch(schema, /text NOT NULL DEFAULT ''/);
});

test('publishing_jobs retyping removes the empty-string convention and safe_schedule_at', () => {
  const migration = read('postgres/migrations/009-publishing-jobs-retypes.sql');

  // Every column that defaulted to '' loses both the default and the NOT NULL.
  assert.match(migration, /ALTER COLUMN approved_id DROP NOT NULL/);
  assert.match(migration, /ALTER COLUMN approved_id DROP DEFAULT/);
  assert.match(migration, /ALTER COLUMN provider_stage DROP NOT NULL/);
  assert.match(migration, /ALTER COLUMN claimed_by DROP NOT NULL/);
  // Existing '' values become NULL, or the queries in Task 9 would still see ''.
  assert.match(migration, /SET approved_id = NULL WHERE approved_id = ''/);
  // safe_schedule_at exists only to turn a bad date string into infinity.
  // timestamptz cannot hold a bad date string, so it goes.
  assert.match(migration, /DROP FUNCTION IF EXISTS short_videos\.safe_schedule_at/);
  // Replay safety: this must survive a second application.
  assert.match(migration, /DO \$\$/);

  const down = read('postgres/rollback/009-publishing-jobs-retypes.down.sql');
  assert.match(down, /SET approved_id = '' WHERE approved_id IS NULL/);
  assert.match(down, /ALTER COLUMN approved_id SET NOT NULL/);
  assert.match(down, /CREATE OR REPLACE FUNCTION short_videos\.safe_schedule_at/);
});
