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
