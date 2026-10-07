const assert = require('node:assert/strict');
const test = require('node:test');
const { pickFairByGroup, pickFairBySource } = require('../workflow-code/fair-share');

test('pickFairBySource round-robins by source until total limit is reached', () => {
  const rows = [
    { id: 'A1', source_id: 'A', created_at: '2026-06-27T00:01:00.000Z' },
    { id: 'A2', source_id: 'A', created_at: '2026-06-27T00:02:00.000Z' },
    { id: 'A3', source_id: 'A', created_at: '2026-06-27T00:03:00.000Z' },
    { id: 'B1', source_id: 'B', created_at: '2026-06-27T00:01:00.000Z' },
    { id: 'B2', source_id: 'B', created_at: '2026-06-27T00:02:00.000Z' },
    { id: 'C1', source_id: 'C', created_at: '2026-06-27T00:01:00.000Z' },
  ];

  const picked = pickFairBySource(rows, {
    limit: 5,
    perSourceLimit: 2,
    sourceKey: 'source_id',
    sortKey: 'created_at',
  });

  assert.deepEqual(picked.map((row) => row.id), ['A1', 'B1', 'C1', 'A2', 'B2']);
});

test('pickFairBySource keeps rows without source_id eligible under an unknown bucket', () => {
  const picked = pickFairBySource(
    [
      { id: 'M1', created_at: '2026-06-27T00:01:00.000Z' },
      { id: 'A1', source_id: 'A', created_at: '2026-06-27T00:01:00.000Z' },
      { id: 'M2', created_at: '2026-06-27T00:02:00.000Z' },
    ],
    { limit: 3, perSourceLimit: 1, sourceKey: 'source_id', sortKey: 'created_at' },
  );

  assert.deepEqual(picked.map((row) => row.id), ['M1', 'A1']);
});

test('pickFairBySource can fall back to niche when source_id is missing', () => {
  const picked = pickFairBySource(
    [
      { id: 'finance-1', niche: 'FINANCE_BUSINESS', created_at: '2026-06-27T00:01:00.000Z' },
      { id: 'finance-2', niche: 'FINANCE_BUSINESS', created_at: '2026-06-27T00:02:00.000Z' },
      { id: 'faith-1', niche: 'CHRISTIAN_CONTENT', created_at: '2026-06-27T00:01:00.000Z' },
    ],
    {
      limit: 3,
      perSourceLimit: 1,
      sourceKey: 'source_id',
      fallbackKeys: ['niche'],
      sortKey: 'created_at',
    },
  );

  assert.deepEqual(picked.map((row) => row.id), ['finance-1', 'faith-1']);
});

test('pickFairBySource supports score-first ordering inside each source', () => {
  const picked = pickFairBySource(
    [
      { id: 'A-low', source_id: 'A', clip_score: 6 },
      { id: 'A-high', source_id: 'A', clip_score: 9 },
      { id: 'B-mid', source_id: 'B', clip_score: 7 },
    ],
    {
      limit: 3,
      perSourceLimit: 2,
      sourceKey: 'source_id',
      compare: (a, b) => Number(b.clip_score || 0) - Number(a.clip_score || 0),
    },
  );

  assert.deepEqual(picked.map((row) => row.id), ['A-high', 'B-mid', 'A-low']);
});

test('pickFairByGroup balances niches before taking extra rows from one niche', () => {
  const picked = pickFairByGroup(
    [
      { id: 'finance-a1', niche: 'FINANCE_BUSINESS', source_id: 'SRC-A', clip_score: 10 },
      { id: 'finance-a2', niche: 'FINANCE_BUSINESS', source_id: 'SRC-A', clip_score: 9 },
      { id: 'finance-b1', niche: 'FINANCE_BUSINESS', source_id: 'SRC-B', clip_score: 8 },
      { id: 'faith-a1', niche: 'CHRISTIAN_CONTENT', source_id: 'SRC-C', clip_score: 7 },
    ],
    {
      limit: 4,
      groupKey: 'niche',
      sourceKey: 'source_id',
      perSourceLimit: 2,
      compare: (a, b) => Number(b.clip_score || 0) - Number(a.clip_score || 0),
    },
  );

  assert.deepEqual(picked.map((row) => row.id), ['finance-a1', 'faith-a1', 'finance-b1', 'finance-a2']);
});

test('pickFairByGroup falls back to niche when source_id is missing', () => {
  const picked = pickFairByGroup(
    [
      { id: 'finance-1', niche: 'FINANCE_BUSINESS', clip_score: 10 },
      { id: 'finance-2', niche: 'FINANCE_BUSINESS', clip_score: 9 },
      { id: 'faith-1', niche: 'CHRISTIAN_CONTENT', clip_score: 8 },
    ],
    {
      limit: 3,
      groupKey: 'niche',
      sourceKey: 'source_id',
      sourceFallbackKeys: ['niche'],
      perSourceLimit: 1,
      compare: (a, b) => Number(b.clip_score || 0) - Number(a.clip_score || 0),
    },
  );

  assert.deepEqual(picked.map((row) => row.id), ['finance-1', 'faith-1']);
});
