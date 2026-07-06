const assert = require('node:assert/strict');
const test = require('node:test');
const {
  parseHeatmap,
  pickHeatmapPeaks,
  extractTimestampsFromComments,
  clusterCommentTimestamps,
} = require('../n8n/workflow-code/moment-discovery');

test('parseHeatmap maps yt-dlp heatmap entries to seconds and intensity', () => {
  const infoJson = {
    heatmap: [
      { start_time: 0, end_time: 43.2, value: 1 },
      { start_time: 43.2, end_time: 86.4, value: 0.35 },
      { start_time: 86.4, end_time: 129.6, value: 0.82 },
    ],
  };

  assert.deepEqual(parseHeatmap(infoJson), [
    { startSec: 0, endSec: 43.2, intensity: 1 },
    { startSec: 43.2, endSec: 86.4, intensity: 0.35 },
    { startSec: 86.4, endSec: 129.6, intensity: 0.82 },
  ]);
});

test('parseHeatmap returns empty array when heatmap missing or malformed', () => {
  assert.deepEqual(parseHeatmap({}), []);
  assert.deepEqual(parseHeatmap(null), []);
  assert.deepEqual(parseHeatmap({ heatmap: 'nope' }), []);
  // zero-length segment dropped
  assert.deepEqual(parseHeatmap({ heatmap: [{ start_time: 5, end_time: 5, value: 0.9 }] }), []);
});

test('pickHeatmapPeaks filters by intensity, ignores intro, merges close segments', () => {
  const segments = [
    { startSec: 0, endSec: 40, intensity: 1 }, // intro noise — ignored
    { startSec: 40, endSec: 80, intensity: 0.95 }, // starts before ignoreFirstSec — ignored
    { startSec: 100, endSec: 140, intensity: 0.75 },
    { startSec: 160, endSec: 200, intensity: 0.8 }, // gap 20s <= 30s → merges with previous
    { startSec: 400, endSec: 440, intensity: 0.5 }, // below threshold — dropped
    { startSec: 600, endSec: 640, intensity: 0.9 }, // standalone peak
  ];

  assert.deepEqual(pickHeatmapPeaks(segments), [
    { startSec: 100, endSec: 200, intensity: 0.8 },
    { startSec: 600, endSec: 640, intensity: 0.9 },
  ]);
});

test('pickHeatmapPeaks respects custom options', () => {
  const segments = [
    { startSec: 10, endSec: 20, intensity: 0.6 },
    { startSec: 100, endSec: 110, intensity: 0.6 },
  ];

  const peaks = pickHeatmapPeaks(segments, {
    minIntensity: 0.5,
    ignoreFirstSec: 0,
    mergeGapSec: 100,
  });

  assert.deepEqual(peaks, [{ startSec: 10, endSec: 110, intensity: 0.6 }]);
});

test('extractTimestampsFromComments parses mm:ss and h:mm:ss, skips invalid times', () => {
  const comments = [
    { text: '34:20 had me in tears', author: 'a' },
    { text: 'the story at 1:12:00 and again at 1:15:30 🔥', author: 'b' },
    { text: 'no timestamp here', author: 'c' },
    { text: 'fake time 99:99', author: 'd' },
  ];

  assert.deepEqual(extractTimestampsFromComments(comments), [
    { sec: 2060, text: '34:20 had me in tears', author: 'a' },
    { sec: 4320, text: 'the story at 1:12:00 and again at 1:15:30 🔥', author: 'b' },
    { sec: 4530, text: 'the story at 1:12:00 and again at 1:15:30 🔥', author: 'b' },
  ]);
});

test('extractTimestampsFromComments handles empty/missing input', () => {
  assert.deepEqual(extractTimestampsFromComments([]), []);
  assert.deepEqual(extractTimestampsFromComments(null), []);
  assert.deepEqual(extractTimestampsFromComments([{ author: 'x' }]), []);
});

test('clusterCommentTimestamps groups hits within window and enforces minMentions', () => {
  const hits = [
    { sec: 2000, text: 'first', author: 'a' },
    { sec: 2060, text: 'second', author: 'b' },
    { sec: 2100, text: 'third', author: 'c' },
    { sec: 2110, text: 'fourth', author: 'd' },
    { sec: 5000, text: 'lonely', author: 'e' }, // only 1 mention — dropped
  ];

  const clusters = clusterCommentTimestamps(hits);

  assert.equal(clusters.length, 1);
  assert.equal(clusters[0].startSec, 2000);
  assert.equal(clusters[0].endSec, 2110);
  assert.equal(clusters[0].mentions, 4);
  assert.deepEqual(clusters[0].sampleComments, ['first', 'second', 'third']);
  assert.equal(clusters[0].introFlag, false);
});

test('clusterCommentTimestamps flags intro clusters instead of dropping them', () => {
  const hits = [
    { sec: 10, text: 'intro a', author: 'a' },
    { sec: 20, text: 'intro b', author: 'b' },
    { sec: 30, text: 'intro c', author: 'c' },
  ];

  const clusters = clusterCommentTimestamps(hits);

  assert.equal(clusters.length, 1);
  assert.equal(clusters[0].introFlag, true);
});

test('clusterCommentTimestamps respects custom windowSec and minMentions', () => {
  const hits = [
    { sec: 100, text: 'a', author: 'a' },
    { sec: 500, text: 'b', author: 'b' },
  ];

  const clusters = clusterCommentTimestamps(hits, { windowSec: 600, minMentions: 2, ignoreFirstSec: 0 });

  assert.equal(clusters.length, 1);
  assert.equal(clusters[0].mentions, 2);
});
