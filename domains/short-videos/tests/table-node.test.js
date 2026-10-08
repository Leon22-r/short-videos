const assert = require('node:assert/strict');
const test = require('node:test');
const { postgresNode, selectAll, upsertFromJsonb } = require('../workflow-code/table-node');

test('postgresNode emits the same node shape the publishing workflows use', () => {
  const node = postgresNode('id-1', 'Read Candidates', [0, 0], 'SELECT 1;');
  assert.equal(node.type, 'n8n-nodes-base.postgres');
  assert.equal(node.typeVersion, 2.6);
  assert.equal(node.parameters.operation, 'executeQuery');
  assert.equal(node.parameters.options.queryBatching, 'single');
  assert.equal(node.retryOnFail, true);
  // executeOnce was a Sheets-read concern; a SELECT runs once by nature.
  assert.equal(node.executeOnce, undefined);
});

test('upsertFromJsonb is one atomic statement keyed on the deterministic id', () => {
  const sql = upsertFromJsonb({
    table: 'candidate_videos',
    key: 'video_id',
    columns: ['video_id', 'niche', 'processing_status'],
  });
  assert.match(sql, /jsonb_array_elements\(\$1::jsonb\)/);
  assert.match(sql, /ON CONFLICT \(video_id\) DO UPDATE SET/);
  // One statement, so transaction-mode pooling is sufficient (Task 1).
  assert.equal(sql.split(';').filter((part) => part.trim()).length, 1);
  // No n8n expression syntax may leak into SQL.
  assert.doesNotMatch(sql, /\{\{/);
});

// The projection `row->>'column'` works in upsert-publishing-jobs.sql only
// because publishing_jobs is entirely text. These tables are not, and Postgres
// does not implicitly cast text to integer/timestamptz in an INSERT.
test('upsertFromJsonb types the row through the table, not through text', () => {
  const sql = upsertFromJsonb({
    table: 'candidate_videos',
    key: 'video_id',
    columns: ['video_id', 'duration_seconds'],
  });
  assert.match(sql, /jsonb_populate_record\(NULL::short_videos\.candidate_videos, row\)/);
  assert.match(sql, /\(record\)\.duration_seconds/);
  assert.doesNotMatch(sql, /row->>'duration_seconds'/);
});

// A blank cell was how Sheets spelled "no value". '' is a valid text value but
// not a valid integer, so it has to be stripped before the row is typed.
test('upsertFromJsonb strips empty strings before typing the row', () => {
  const sql = upsertFromJsonb({ table: 'render_jobs', key: 'render_id', columns: ['render_id'] });
  assert.match(sql, /NULLIF\(btrim\(field\.value #>> '\{\}'\), ''\) IS NOT NULL/);
});

// Sheets' appendOrUpdate wrote only the columns it was given. `SET col =
// EXCLUDED.col` would blank every column absent from an incoming row.
test('a partial row updates what it carries and leaves the rest', () => {
  const sql = upsertFromJsonb({
    table: 'candidate_videos',
    key: 'video_id',
    columns: ['video_id', 'niche'],
  });
  assert.match(sql, /niche = COALESCE\(EXCLUDED\.niche, short_videos\.candidate_videos\.niche\)/);
  // The key must never be overwritten by the conflicting row.
  assert.doesNotMatch(sql, /video_id = (COALESCE\()?EXCLUDED\.video_id/);
});

test('selectAll targets the short_videos schema explicitly', () => {
  assert.equal(selectAll('source_channels'), 'SELECT * FROM short_videos.source_channels;');
});
