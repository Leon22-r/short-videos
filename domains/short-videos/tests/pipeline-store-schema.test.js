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
  assert.match(schema, /youtube_video_id\s+text NOT NULL UNIQUE/);
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

  assert.match(schema, /CHECK\s*\(\s*review_status IN\s*\(\s*'AWAITING_DOWNLOAD', 'NEEDS_REVIEW', 'APPROVED', 'REJECTED'\)\)/);
  assert.match(schema, /download_job_id\s+text/);
  assert.doesNotMatch(schema, /ssemble_job_id/);

  assert.match(schema, /CHECK\s*\(\s*render_status IN\s*\(\s*'PENDING', 'DOWNLOADING_ASSETS', 'RENDERING', 'UPLOADING', 'COMPLETED', 'FAILED', 'SKIPPED'\)\)/);
  assert.match(schema, /use_blurred_background\s+boolean/);
  assert.match(schema, /started_at\s+timestamptz/);
  assert.match(schema, /completed_at\s+timestamptz/);

  assert.doesNotMatch(schema, /text NOT NULL DEFAULT ''/);
});
