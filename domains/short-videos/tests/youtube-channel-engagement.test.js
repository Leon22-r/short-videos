const assert = require('node:assert/strict');
const test = require('node:test');
const {
  computeVideoMetrics,
  formatPercent,
} = require('../../../scripts/youtube-channel-engagement');

test('computes video engagement metrics from YouTube statistics', () => {
  assert.deepEqual(computeVideoMetrics({
    id: 'abc123',
    snippet: { title: 'Example video', publishedAt: '2026-07-01T00:00:00Z' },
    statistics: { viewCount: '10000', likeCount: '200', commentCount: '5' },
  }), {
    video_id: 'abc123',
    title: 'Example video',
    published_at: '2026-07-01T00:00:00Z',
    views: 10000,
    likes: 200,
    comments: 5,
    like_percentage: 0.02,
    comment_percentage: 0.0005,
    engagement_percentage: 0.0205,
    passes_engagement_gate: true,
  });
});

test('uses the same two-percent engagement floor as WF3', () => {
  const row = computeVideoMetrics({
    id: 'below-wf3-floor',
    snippet: {},
    statistics: { viewCount: '10000', likeCount: '199', commentCount: '5' },
  });

  assert.equal(row.like_percentage, 0.0199);
  assert.equal(row.passes_engagement_gate, false);
});

test('formats decimals as readable percentages', () => {
  assert.equal(formatPercent(0.02), '2.00%');
  assert.equal(formatPercent(0.0005), '0.05%');
});
