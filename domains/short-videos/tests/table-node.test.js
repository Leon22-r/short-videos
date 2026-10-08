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
  assert.match(sql, /niche = EXCLUDED\.niche/);
  // The key must never be overwritten by the conflicting row.
  assert.doesNotMatch(sql, /video_id = EXCLUDED\.video_id/);
  // One statement, so transaction-mode pooling is sufficient (Task 1).
  assert.equal(sql.split(';').filter((part) => part.trim()).length, 1);
  // No n8n expression syntax may leak into SQL.
  assert.doesNotMatch(sql, /\{\{/);
});

test('selectAll targets the short_videos schema explicitly', () => {
  assert.equal(selectAll('source_channels'), 'SELECT * FROM short_videos.source_channels;');
});
