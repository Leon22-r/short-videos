const assert = require('node:assert/strict');
const test = require('node:test');
const {
  detectReEnable,
  evaluateChannelHealth,
} = require('../workflow-code/channel-health-check');

// ============================================================================
// detectReEnable tests
// ============================================================================

test('detectReEnable: returns true when active_status=TRUE and auto_paused_at is non-empty', () => {
  const result = detectReEnable({
    active_status: 'TRUE',
    auto_paused_at: '2026-06-20T10:00:00.000Z',
  });
  assert.equal(result, true);
});

test('detectReEnable: returns false when auto_paused_at is empty string', () => {
  const result = detectReEnable({
    active_status: 'TRUE',
    auto_paused_at: '',
  });
  assert.equal(result, false);
});

test('detectReEnable: returns false when auto_paused_at is null', () => {
  const result = detectReEnable({
    active_status: 'TRUE',
    auto_paused_at: null,
  });
  assert.equal(result, false);
});

test('detectReEnable: returns false when auto_paused_at is undefined', () => {
  const result = detectReEnable({
    active_status: 'TRUE',
  });
  assert.equal(result, false);
});

test('detectReEnable: returns false when active_status=FALSE (paused, not yet re-enabled)', () => {
  const result = detectReEnable({
    active_status: 'FALSE',
    auto_paused_at: '2026-06-20T10:00:00.000Z',
  });
  assert.equal(result, false);
});

// ============================================================================
// evaluateChannelHealth - basic tests
// ============================================================================

test('evaluateChannelHealth: returns shouldPause=false when total < 10', () => {
  const rows = [
    { source_id: 'SRC-1', ai_episode_score: 8, recommended_strategy: 'SKIP_THIS_VIDEO', created_at: '2026-06-23T10:00:00.000Z' },
    { source_id: 'SRC-1', ai_episode_score: 7, recommended_strategy: 'USE_20_MIN_WINDOW', created_at: '2026-06-23T10:00:00.000Z' },
    { source_id: 'SRC-1', ai_episode_score: 5, recommended_strategy: 'SKIP_THIS_VIDEO', created_at: '2026-06-23T10:00:00.000Z' },
    { source_id: 'SRC-1', ai_episode_score: 9, recommended_strategy: 'USE_EXACT_CLIPS_ONLY', created_at: '2026-06-23T10:00:00.000Z' },
    { source_id: 'SRC-1', ai_episode_score: 6, recommended_strategy: 'SKIP_THIS_VIDEO', created_at: '2026-06-23T10:00:00.000Z' },
  ];

  const result = evaluateChannelHealth('SRC-1', rows, null);

  assert.equal(result.shouldPause, false);
  assert.equal(result.total, 5);
  assert.equal(result.skipRate, null);
});

test('evaluateChannelHealth: returns shouldPause=false when skip_rate < 0.70', () => {
  const rows = Array.from({ length: 10 }, (_, i) => ({
    source_id: 'SRC-1',
    ai_episode_score: 5 + i,
    recommended_strategy: i < 6 ? 'USE_20_MIN_WINDOW' : 'SKIP_THIS_VIDEO',
    created_at: '2026-06-23T10:00:00.000Z',
  }));

  const result = evaluateChannelHealth('SRC-1', rows, null);

  assert.equal(result.shouldPause, false);
  assert.equal(result.total, 10);
  assert.equal(result.skipCount, 4);
  assert.equal(result.skipRate, 0.4);
});

test('evaluateChannelHealth: returns shouldPause=true when skip_rate >= 0.70', () => {
  const rows = Array.from({ length: 10 }, (_, i) => ({
    source_id: 'SRC-1',
    ai_episode_score: 5 + i,
    recommended_strategy: i < 7 ? 'SKIP_THIS_VIDEO' : 'USE_20_MIN_WINDOW',
    created_at: '2026-06-23T10:00:00.000Z',
  }));

  const result = evaluateChannelHealth('SRC-1', rows, null);

  assert.equal(result.shouldPause, true);
  assert.equal(result.total, 10);
  assert.equal(result.skipCount, 7);
  assert.equal(result.skipRate, 0.7);
});

test('evaluateChannelHealth: returns shouldPause=true at 22/30 (73%)', () => {
  const rows = Array.from({ length: 30 }, (_, i) => ({
    source_id: 'SRC-1',
    ai_episode_score: 5 + i,
    recommended_strategy: i < 22 ? 'SKIP_THIS_VIDEO' : 'USE_20_MIN_WINDOW',
    created_at: '2026-06-23T10:00:00.000Z',
  }));

  const result = evaluateChannelHealth('SRC-1', rows, null);

  assert.equal(result.shouldPause, true);
  assert.equal(result.total, 30);
  assert.equal(result.skipCount, 22);
  assert.equal(result.skipRate, 22 / 30);
});

test('evaluateChannelHealth: correctly formats reason string', () => {
  const rows = Array.from({ length: 10 }, (_, i) => ({
    source_id: 'SRC-1',
    ai_episode_score: 5 + i,
    recommended_strategy: i < 7 ? 'SKIP_THIS_VIDEO' : 'USE_20_MIN_WINDOW',
    created_at: '2026-06-23T10:00:00.000Z',
  }));

  const result = evaluateChannelHealth('SRC-1', rows, null);

  assert.equal(result.reason, 'skip_rate=70% (7/10 videos)');
});

test('evaluateChannelHealth: ignores rows with empty ai_episode_score', () => {
  const rows = [
    { source_id: 'SRC-1', ai_episode_score: '', recommended_strategy: 'SKIP_THIS_VIDEO', created_at: '2026-06-23T10:00:00.000Z' },
    { source_id: 'SRC-1', ai_episode_score: 8, recommended_strategy: 'USE_20_MIN_WINDOW', created_at: '2026-06-23T10:00:00.000Z' },
    { source_id: 'SRC-1', ai_episode_score: 7, recommended_strategy: 'USE_20_MIN_WINDOW', created_at: '2026-06-23T10:00:00.000Z' },
  ];

  const result = evaluateChannelHealth('SRC-1', rows, null);

  assert.equal(result.total, 2);
  assert.equal(result.skipRate, null); // Below threshold
});

test('evaluateChannelHealth: ignores rows with null ai_episode_score', () => {
  const rows = [
    { source_id: 'SRC-1', ai_episode_score: null, recommended_strategy: 'SKIP_THIS_VIDEO', created_at: '2026-06-23T10:00:00.000Z' },
    { source_id: 'SRC-1', ai_episode_score: 8, recommended_strategy: 'USE_20_MIN_WINDOW', created_at: '2026-06-23T10:00:00.000Z' },
    { source_id: 'SRC-1', ai_episode_score: 7, recommended_strategy: 'USE_20_MIN_WINDOW', created_at: '2026-06-23T10:00:00.000Z' },
  ];

  const result = evaluateChannelHealth('SRC-1', rows, null);

  assert.equal(result.total, 2);
  assert.equal(result.skipRate, null); // Below threshold
});

test('evaluateChannelHealth: handles empty array (total=0)', () => {
  const result = evaluateChannelHealth('SRC-1', [], null);

  assert.equal(result.shouldPause, false);
  assert.equal(result.total, 0);
  assert.equal(result.skipRate, null);
});

test('evaluateChannelHealth: ignores rows from a different source_id', () => {
  const rows = [
    { source_id: 'SRC-2', ai_episode_score: 8, recommended_strategy: 'SKIP_THIS_VIDEO', created_at: '2026-06-23T10:00:00.000Z' },
    { source_id: 'SRC-2', ai_episode_score: 7, recommended_strategy: 'SKIP_THIS_VIDEO', created_at: '2026-06-23T10:00:00.000Z' },
    { source_id: 'SRC-1', ai_episode_score: 9, recommended_strategy: 'USE_20_MIN_WINDOW', created_at: '2026-06-23T10:00:00.000Z' },
  ];

  const result = evaluateChannelHealth('SRC-1', rows, null);

  assert.equal(result.total, 1);
  assert.equal(result.skipRate, null); // Below threshold
});

// ============================================================================
// evaluateChannelHealth - healthResetAt filter tests
// ============================================================================

test('evaluateChannelHealth: with healthResetAt set, ignores rows created BEFORE the cutoff', () => {
  const now = '2026-06-23T10:00:00.000Z';
  const old = '2026-06-20T10:00:00.000Z';

  const rows = [
    // 8 old rows (before reset)
    ...Array.from({ length: 8 }, (_, i) => ({
      source_id: 'SRC-1',
      ai_episode_score: 5 + i,
      recommended_strategy: 'SKIP_THIS_VIDEO',
      created_at: old,
    })),
    // 2 new rows (after reset)
    ...Array.from({ length: 2 }, (_, i) => ({
      source_id: 'SRC-1',
      ai_episode_score: 8 + i,
      recommended_strategy: 'USE_20_MIN_WINDOW',
      created_at: now,
    })),
  ];

  const result = evaluateChannelHealth('SRC-1', rows, old);

  assert.equal(result.total, 2);
  assert.equal(result.skipRate, null); // Below threshold
});

test('evaluateChannelHealth: channel with 30 old skips + healthResetAt=NOW + 3 new analyses', () => {
  const resetTime = '2026-06-23T10:00:00.000Z';
  const old = '2026-06-20T10:00:00.000Z';
  const new1 = '2026-06-23T10:00:00.001Z'; // After reset

  const rows = [
    // 30 old skip rows (before reset)
    ...Array.from({ length: 30 }, (_, i) => ({
      source_id: 'SRC-1',
      ai_episode_score: 5 + (i % 10),
      recommended_strategy: 'SKIP_THIS_VIDEO',
      created_at: old,
    })),
    // 3 new non-skip analyses (after reset)
    ...Array.from({ length: 3 }, (_, i) => ({
      source_id: 'SRC-1',
      ai_episode_score: 8 + i,
      recommended_strategy: 'USE_20_MIN_WINDOW',
      created_at: new1,
    })),
  ];

  const result = evaluateChannelHealth('SRC-1', rows, resetTime);

  assert.equal(result.total, 3);
  assert.equal(result.skipRate, null); // Below threshold
  assert.equal(result.shouldPause, false);
});

test('evaluateChannelHealth: channel with 30 old skips + healthResetAt + 10 new non-skip analyses', () => {
  const now = '2026-06-23T10:00:00.000Z';
  const old = '2026-06-20T10:00:00.000Z';

  const rows = [
    // 30 old skip rows
    ...Array.from({ length: 30 }, (_, i) => ({
      source_id: 'SRC-1',
      ai_episode_score: 5 + (i % 10),
      recommended_strategy: 'SKIP_THIS_VIDEO',
      created_at: old,
    })),
    // 10 new non-skip analyses
    ...Array.from({ length: 10 }, (_, i) => ({
      source_id: 'SRC-1',
      ai_episode_score: 8 + i,
      recommended_strategy: 'USE_20_MIN_WINDOW',
      created_at: now,
    })),
  ];

  const result = evaluateChannelHealth('SRC-1', rows, old);

  assert.equal(result.total, 10);
  assert.equal(result.skipCount, 0);
  assert.equal(result.skipRate, 0);
  assert.equal(result.shouldPause, false);
});

test('evaluateChannelHealth: with healthResetAt, row AT cutoff timestamp is excluded (boundary test)', () => {
  const cutoff = '2026-06-23T10:00:00.000Z';
  const before = '2026-06-23T09:59:59.999Z';
  const after = '2026-06-23T10:00:00.001Z';

  const rows = [
    // Row AT the cutoff should be excluded (not strictly greater)
    { source_id: 'SRC-1', ai_episode_score: 5, recommended_strategy: 'SKIP_THIS_VIDEO', created_at: cutoff },
    // Row before should be excluded
    { source_id: 'SRC-1', ai_episode_score: 6, recommended_strategy: 'SKIP_THIS_VIDEO', created_at: before },
    // Rows after should be included (10 rows: 7 skips + 3 non-skips = 70% skip rate)
    ...Array.from({ length: 10 }, (_, i) => ({
      source_id: 'SRC-1',
      ai_episode_score: 7 + i,
      recommended_strategy: i < 7 ? 'SKIP_THIS_VIDEO' : 'USE_20_MIN_WINDOW',
      created_at: after,
    })),
  ];

  const result = evaluateChannelHealth('SRC-1', rows, cutoff);

  assert.equal(result.total, 10);
  assert.equal(result.skipCount, 7);
  assert.equal(result.skipRate, 0.7);
  assert.equal(result.shouldPause, true);
});
