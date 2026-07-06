const assert = require('node:assert/strict');
const test = require('node:test');
const {
  parseHeatmap,
  pickHeatmapPeaks,
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
