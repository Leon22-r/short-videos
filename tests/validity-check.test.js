const assert = require('node:assert/strict');
const test = require('node:test');
const {
  applyValidityRules,
  buildRiskBySource,
  scoreCandidate,
} = require('../n8n/workflow-code/validity-check');

test('builds source risk lookup with low default', () => {
  assert.deepEqual(buildRiskBySource([
    { source_id: 'SRC-1', risk_level: 'HIGH' },
    { source_id: 'SRC-2' },
  ]), {
    'SRC-1': 'high',
    'SRC-2': 'low',
  });
});

test('scores preferred long-form candidates higher', () => {
  assert.equal(scoreCandidate({
    video_title: 'Deep podcast interview about discipline',
    duration_seconds: 3600,
    view_count: 15000,
  }), 10);

  assert.equal(scoreCandidate({
    video_title: 'Regular talk',
    duration_seconds: 400,
    view_count: 100,
  }), 6);
});

test('marks long-form low-risk candidates valid', () => {
  const [row] = applyValidityRules([
    {
      video_id: 'VID-1',
      source_id: 'SRC-1',
      video_title: 'Faith podcast interview',
      duration_seconds: 1800,
      view_count: 12000,
      language: 'en',
      processing_status: 'NEW',
      validity_status: '',
    },
  ], { 'SRC-1': 'low' });

  assert.equal(row.video_id, 'VID-1');
  assert.equal(row.validity_status, 'VALID');
  assert.equal(row.validity_score, 10);
  assert.equal(row.rejection_reason, '');
  assert.equal(row.processing_status, 'NEW');
});

test('rejects shorts and too-short videos', () => {
  const rows = applyValidityRules([
    {
      video_id: 'VID-1',
      video_title: 'Quick short',
      duration_seconds: 60,
      processing_status: 'NEW',
      validity_status: '',
    },
    {
      video_id: 'VID-2',
      video_title: 'Short talk',
      duration_seconds: 120,
      processing_status: 'NEW',
      validity_status: '',
    },
  ], {});

  assert.equal(rows[0].validity_status, 'REJECTED');
  assert.equal(rows[0].rejection_reason, 'SHORTS_UPLOAD');
  assert.equal(rows[0].processing_status, 'SKIPPED');
  assert.equal(rows[1].rejection_reason, 'TOO_SHORT');
});

test('rejects known low-value title patterns', () => {
  const rows = applyValidityRules([
    { video_id: 'VID-1', video_title: 'Official trailer', duration_seconds: 400, processing_status: 'NEW', validity_status: '' },
    { video_id: 'VID-2', video_title: 'Official music video', duration_seconds: 400, processing_status: 'NEW', validity_status: '' },
    { video_id: 'VID-3', video_title: 'Best of top 10 moments', duration_seconds: 400, processing_status: 'NEW', validity_status: '' },
    { video_id: 'VID-4', video_title: 'Breaking news update', duration_seconds: 400, processing_status: 'NEW', validity_status: '' },
    { video_id: 'VID-5', video_title: 'Wisdom clip #shorts', duration_seconds: 400, processing_status: 'NEW', validity_status: '' },
  ], {});

  assert.deepEqual(rows.map((row) => row.rejection_reason), [
    'TRAILER_OR_PROMO',
    'MUSIC_VIDEO',
    'COMPILATION',
    'NEWS_CLIP',
    'SHORTS_UPLOAD',
  ]);
  assert(rows.every((row) => row.processing_status === 'SKIPPED'));
});

test('flags non-English or non-Swahili language for review', () => {
  const [row] = applyValidityRules([
    {
      video_id: 'VID-1',
      video_title: 'Long interview',
      duration_seconds: 1800,
      language: 'fr',
      processing_status: 'NEW',
      validity_status: '',
    },
  ], {});

  assert.equal(row.validity_status, 'FLAGGED');
  assert.equal(row.rejection_reason, 'LANGUAGE_CHECK');
  assert.equal(row.processing_status, 'NEW');
});

test('flags valid high-risk source candidates for manual approval', () => {
  const [row] = applyValidityRules([
    {
      video_id: 'VID-1',
      source_id: 'SRC-HIGH',
      video_title: 'Long interview',
      duration_seconds: 1800,
      language: 'en',
      processing_status: 'NEW',
      validity_status: '',
    },
  ], { 'SRC-HIGH': 'high' });

  assert.equal(row.validity_status, 'FLAGGED');
  assert.equal(row.rejection_reason, 'MANUAL_APPROVAL_REQUIRED');
});

test('skips already processed or already classified rows', () => {
  const rows = applyValidityRules([
    { video_id: 'VID-1', processing_status: 'ANALYZED', validity_status: '', duration_seconds: 500 },
    { video_id: 'VID-2', processing_status: 'NEW', validity_status: 'VALID', duration_seconds: 500 },
  ], {});

  assert.deepEqual(rows, []);
});
