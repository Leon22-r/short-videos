# Moment Discovery Test Harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Standalone CLI harness that scores YouTube videos for clip-worthy moments using pre-transcript signals (Most Replayed heatmap, timestamped comments, chapters), so signal quality can be judged against known videos before n8n integration.

**Architecture:** Pure scoring logic in `n8n/workflow-code/moment-discovery.js` (no I/O, n8n-portable), CLI runner in `scripts/discover-moments.js` (yt-dlp subprocess + YouTube Data API fetch + console/markdown output), fixture-based unit tests in `tests/moment-discovery.test.js`.

**Tech Stack:** Node 18+ (CommonJS, `node:test`, `node:assert/strict`, global `fetch`, `child_process.execFile`), yt-dlp CLI (external prerequisite), YouTube Data API v3 `commentThreads.list`.

**Spec:** `docs/superpowers/specs/2026-07-06-moment-discovery-design.md`

## Global Constraints

- All work on branch `feat/n8n-video-pipeline-phase1` in worktree `/home/leon/projects/short-videos/.worktrees/n8n-video-pipeline-phase1` (all paths below relative to it; run all commands from this directory).
- CommonJS modules (`require`/`module.exports`) — match every existing file in `n8n/workflow-code/`.
- Tests use `node:test` + `node:assert/strict`, run via `npm test` (`node --test tests/*.test.js`). Existing suite (152+ tests) must stay green.
- Pure-logic module does zero I/O: no `fs`, no network, no subprocess.
- Scoring defaults exactly per spec: `minIntensity: 0.7`, `ignoreFirstSec: 90`, `mergeGapSec: 30`, `windowSec: 120`, `minMentions: 3`, comment score `min(1, mentions / 6)`, overlap score `0.5 + 0.5 × (heat + comment) / 2`, chapter bonus `+0.1` capped at `1.0`, padding `±90s` clamped to `[0, durationSec]`.
- Signals degrade independently — a single-signal failure never aborts the run.
- No new npm dependencies.

---

### Task 1: Heatmap parsing and peak merging

**Files:**
- Create: `n8n/workflow-code/moment-discovery.js`
- Create: `tests/moment-discovery.test.js`

**Interfaces:**
- Consumes: nothing (first task).
- Produces:
  - `parseHeatmap(infoJson) → [{startSec: number, endSec: number, intensity: number}]` — reads yt-dlp info JSON `heatmap` array (`start_time`, `end_time`, `value` keys).
  - `pickHeatmapPeaks(segments, opts) → [{startSec, endSec, intensity}]` — `opts = {minIntensity = 0.7, ignoreFirstSec = 90, mergeGapSec = 30}`; returns merged peaks sorted by `startSec`, `intensity` = max of merged members.

- [ ] **Step 1: Write the failing tests**

Create `tests/moment-discovery.test.js`:

```js
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- 2>&1 | tail -20` (or directly: `node --test tests/moment-discovery.test.js`)
Expected: FAIL — `Cannot find module '../n8n/workflow-code/moment-discovery'`

- [ ] **Step 3: Write minimal implementation**

Create `n8n/workflow-code/moment-discovery.js`:

```js
// Pre-transcript moment discovery: heatmap peaks, timestamped-comment clusters,
// chapters → ranked candidate clip windows. Pure logic, no I/O — portable into
// an n8n Code node. Spec: docs/superpowers/specs/2026-07-06-moment-discovery-design.md

function parseHeatmap(infoJson) {
  const heatmap = infoJson && Array.isArray(infoJson.heatmap) ? infoJson.heatmap : [];
  return heatmap
    .map((seg) => ({
      startSec: Number(seg.start_time || 0),
      endSec: Number(seg.end_time || 0),
      intensity: Number(seg.value || 0),
    }))
    .filter((seg) => Number.isFinite(seg.startSec) && Number.isFinite(seg.endSec) && seg.endSec > seg.startSec);
}

function pickHeatmapPeaks(segments, options = {}) {
  const minIntensity = options.minIntensity ?? 0.7;
  const ignoreFirstSec = options.ignoreFirstSec ?? 90;
  const mergeGapSec = options.mergeGapSec ?? 30;

  const eligible = (segments || [])
    .filter((seg) => seg.intensity >= minIntensity && seg.startSec >= ignoreFirstSec)
    .sort((a, b) => a.startSec - b.startSec);

  const peaks = [];
  for (const seg of eligible) {
    const last = peaks[peaks.length - 1];
    if (last && seg.startSec - last.endSec <= mergeGapSec) {
      last.endSec = Math.max(last.endSec, seg.endSec);
      last.intensity = Math.max(last.intensity, seg.intensity);
    } else {
      peaks.push({ startSec: seg.startSec, endSec: seg.endSec, intensity: seg.intensity });
    }
  }
  return peaks;
}

module.exports = {
  parseHeatmap,
  pickHeatmapPeaks,
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/moment-discovery.test.js`
Expected: PASS — 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add n8n/workflow-code/moment-discovery.js tests/moment-discovery.test.js
git commit -m "feat(moment-discovery): parse yt-dlp heatmap and merge peak windows"
```

---

### Task 2: Comment timestamp extraction and clustering

**Files:**
- Modify: `n8n/workflow-code/moment-discovery.js` (add two functions + exports)
- Modify: `tests/moment-discovery.test.js` (append tests, extend require)

**Interfaces:**
- Consumes: nothing from Task 1 (independent functions in same module).
- Produces:
  - `extractTimestampsFromComments(comments) → [{sec: number, text: string, author: string}]` — `comments = [{text, author}]`; finds all `h:mm:ss` / `mm:ss` tokens per comment, one hit per token; invalid times (minutes/seconds ≥ 60) skipped.
  - `clusterCommentTimestamps(hits, opts) → [{startSec, endSec, mentions, sampleComments, introFlag}]` — `opts = {windowSec = 120, minMentions = 3, ignoreFirstSec = 90}`; greedy clustering on sorted hits; `sampleComments` = up to 3 distinct texts; `introFlag` = cluster `startSec < ignoreFirstSec`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/moment-discovery.test.js` and extend the require at the top:

```js
// top-of-file require becomes:
const {
  parseHeatmap,
  pickHeatmapPeaks,
  extractTimestampsFromComments,
  clusterCommentTimestamps,
} = require('../n8n/workflow-code/moment-discovery');
```

```js
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/moment-discovery.test.js`
Expected: FAIL — `extractTimestampsFromComments is not a function` (5 new tests fail, 4 old pass).

- [ ] **Step 3: Write implementation**

Add to `n8n/workflow-code/moment-discovery.js` (before `module.exports`):

```js
const TIMESTAMP_RE = /\b(?:(\d{1,2}):)?(\d{1,2}):(\d{2})\b/g;

function extractTimestampsFromComments(comments) {
  const hits = [];
  for (const comment of comments || []) {
    const text = String((comment && comment.text) || '');
    const author = String((comment && comment.author) || '');
    if (!text) continue;
    for (const match of text.matchAll(TIMESTAMP_RE)) {
      const hours = match[1] ? Number(match[1]) : 0;
      const minutes = Number(match[2]);
      const seconds = Number(match[3]);
      if (minutes >= 60 || seconds >= 60) continue;
      hits.push({ sec: hours * 3600 + minutes * 60 + seconds, text, author });
    }
  }
  return hits;
}

function clusterCommentTimestamps(hits, options = {}) {
  const windowSec = options.windowSec ?? 120;
  const minMentions = options.minMentions ?? 3;
  const ignoreFirstSec = options.ignoreFirstSec ?? 90;

  const sorted = [...(hits || [])].sort((a, b) => a.sec - b.sec);
  const clusters = [];
  for (const hit of sorted) {
    const last = clusters[clusters.length - 1];
    if (last && hit.sec - last.startSec <= windowSec) {
      last.endSec = Math.max(last.endSec, hit.sec);
      last.mentions += 1;
      if (last.sampleComments.length < 3 && !last.sampleComments.includes(hit.text)) {
        last.sampleComments.push(hit.text);
      }
    } else {
      clusters.push({
        startSec: hit.sec,
        endSec: hit.sec,
        mentions: 1,
        sampleComments: [hit.text],
        introFlag: hit.sec < ignoreFirstSec,
      });
    }
  }
  return clusters.filter((cluster) => cluster.mentions >= minMentions);
}
```

Extend `module.exports`:

```js
module.exports = {
  parseHeatmap,
  pickHeatmapPeaks,
  extractTimestampsFromComments,
  clusterCommentTimestamps,
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/moment-discovery.test.js`
Expected: PASS — 9 tests pass.

- [ ] **Step 5: Commit**

```bash
git add n8n/workflow-code/moment-discovery.js tests/moment-discovery.test.js
git commit -m "feat(moment-discovery): extract and cluster timestamped comments"
```

---

### Task 3: Chapters and candidate-window scoring

**Files:**
- Modify: `n8n/workflow-code/moment-discovery.js` (add two functions + exports)
- Modify: `tests/moment-discovery.test.js` (append tests, extend require)

**Interfaces:**
- Consumes: peak shape `{startSec, endSec, intensity}` from Task 1; cluster shape `{startSec, endSec, mentions, sampleComments, introFlag}` from Task 2.
- Produces:
  - `extractChapters(infoJson) → [{startSec, endSec, title}]` — from yt-dlp `chapters` array (`start_time`, `end_time`, `title` keys).
  - `scoreCandidateWindows({peaks, clusters, chapters, durationSec}, opts) → [window]` — `opts = {padSec = 90, chapterBonus = 0.1, commentScoreDivisor = 6}`. Window shape (this is the shape the CLI in Task 4 renders):

```js
{
  startSec, endSec,          // padded ±padSec, clamped to [0, durationSec]
  score,                     // 0–1
  signals,                   // subset of ['heatmap', 'comments', 'chapter']
  introFlag,                 // true if built from an intro-flagged cluster
  evidence: {
    heatIntensity,           // number | null
    commentMentions,         // number | null
    sampleComments,          // string[] (empty if no comment signal)
    chapterTitle,            // string | null
  },
}
```

Sorted by `score` descending. Overlap = raw (unpadded) signal ranges intersect.

- [ ] **Step 1: Write the failing tests**

Extend the require to include `extractChapters` and `scoreCandidateWindows`, then append:

```js
test('extractChapters maps yt-dlp chapters and handles missing field', () => {
  const infoJson = {
    chapters: [
      { start_time: 0, end_time: 300, title: 'Intro' },
      { start_time: 300, end_time: 1200, title: 'The big story' },
    ],
  };

  assert.deepEqual(extractChapters(infoJson), [
    { startSec: 0, endSec: 300, title: 'Intro' },
    { startSec: 300, endSec: 1200, title: 'The big story' },
  ]);
  assert.deepEqual(extractChapters({}), []);
  assert.deepEqual(extractChapters(null), []);
});

test('scoreCandidateWindows scores standalone heatmap peak by intensity', () => {
  const windows = scoreCandidateWindows({
    peaks: [{ startSec: 600, endSec: 660, intensity: 0.85 }],
    clusters: [],
    chapters: [],
    durationSec: 7200,
  });

  assert.equal(windows.length, 1);
  assert.equal(windows[0].score, 0.85);
  assert.deepEqual(windows[0].signals, ['heatmap']);
  assert.equal(windows[0].startSec, 510); // 600 - 90
  assert.equal(windows[0].endSec, 750); // 660 + 90
  assert.equal(windows[0].evidence.heatIntensity, 0.85);
  assert.equal(windows[0].evidence.commentMentions, null);
});

test('scoreCandidateWindows scores standalone comment cluster as min(1, mentions/6)', () => {
  const windows = scoreCandidateWindows({
    peaks: [],
    clusters: [{ startSec: 2000, endSec: 2100, mentions: 3, sampleComments: ['x'], introFlag: false }],
    chapters: [],
    durationSec: 7200,
  });

  assert.equal(windows.length, 1);
  assert.equal(windows[0].score, 0.5); // 3/6
  assert.deepEqual(windows[0].signals, ['comments']);
  assert.deepEqual(windows[0].evidence.sampleComments, ['x']);
});

test('scoreCandidateWindows merges overlapping heatmap and comment signals with bonus', () => {
  const windows = scoreCandidateWindows({
    peaks: [{ startSec: 2000, endSec: 2060, intensity: 0.8 }],
    clusters: [{ startSec: 2050, endSec: 2150, mentions: 6, sampleComments: ['fire'], introFlag: false }],
    chapters: [],
    durationSec: 7200,
  });

  assert.equal(windows.length, 1);
  // 0.5 + 0.5 * (0.8 + 1.0) / 2 = 0.95
  assert.equal(windows[0].score, 0.95);
  assert.deepEqual(windows[0].signals, ['heatmap', 'comments']);
  assert.equal(windows[0].startSec, 1910); // 2000 - 90
  assert.equal(windows[0].endSec, 2240); // 2150 + 90
  assert.equal(windows[0].evidence.heatIntensity, 0.8);
  assert.equal(windows[0].evidence.commentMentions, 6);
});

test('scoreCandidateWindows adds chapter bonus capped at 1.0 and records title', () => {
  const windows = scoreCandidateWindows({
    peaks: [{ startSec: 600, endSec: 660, intensity: 0.95 }],
    clusters: [],
    chapters: [{ startSec: 500, endSec: 900, title: 'The big story' }],
    durationSec: 7200,
  });

  assert.equal(windows[0].score, 1); // min(1, 0.95 + 0.1)
  assert.deepEqual(windows[0].signals, ['heatmap', 'chapter']);
  assert.equal(windows[0].evidence.chapterTitle, 'The big story');
});

test('scoreCandidateWindows clamps padding to video bounds and sorts by score desc', () => {
  const windows = scoreCandidateWindows({
    peaks: [
      { startSec: 100, endSec: 130, intensity: 0.7 },
      { startSec: 7150, endSec: 7190, intensity: 0.9 },
    ],
    clusters: [],
    chapters: [],
    durationSec: 7200,
  });

  assert.equal(windows.length, 2);
  assert.equal(windows[0].score, 0.9);
  assert.equal(windows[0].endSec, 7200); // clamped to duration
  assert.equal(windows[1].startSec, 10); // 100 - 90
});

test('scoreCandidateWindows propagates introFlag from clusters', () => {
  const windows = scoreCandidateWindows({
    peaks: [],
    clusters: [{ startSec: 30, endSec: 60, mentions: 4, sampleComments: ['intro'], introFlag: true }],
    chapters: [],
    durationSec: 7200,
  });

  assert.equal(windows[0].introFlag, true);
  assert.equal(windows[0].startSec, 0); // 30 - 90 clamped
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/moment-discovery.test.js`
Expected: FAIL — `extractChapters is not a function` (7 new tests fail, 9 old pass).

- [ ] **Step 3: Write implementation**

Add to `n8n/workflow-code/moment-discovery.js`:

```js
function extractChapters(infoJson) {
  const chapters = infoJson && Array.isArray(infoJson.chapters) ? infoJson.chapters : [];
  return chapters.map((chapter) => ({
    startSec: Number(chapter.start_time || 0),
    endSec: Number(chapter.end_time || 0),
    title: String(chapter.title || ''),
  }));
}

function rangesOverlap(aStart, aEnd, bStart, bEnd) {
  return aStart <= bEnd && bStart <= aEnd;
}

function scoreCandidateWindows({ peaks = [], clusters = [], chapters = [], durationSec = 0 } = {}, options = {}) {
  const padSec = options.padSec ?? 90;
  const chapterBonus = options.chapterBonus ?? 0.1;
  const commentScoreDivisor = options.commentScoreDivisor ?? 6;

  const usedClusters = new Set();
  const raw = [];

  for (const peak of peaks) {
    const overlapping = clusters.filter(
      (cluster) => rangesOverlap(peak.startSec, peak.endSec, cluster.startSec, cluster.endSec),
    );
    overlapping.forEach((cluster) => usedClusters.add(cluster));

    if (overlapping.length > 0) {
      const mentions = overlapping.reduce((sum, cluster) => sum + cluster.mentions, 0);
      const commentScore = Math.min(1, mentions / commentScoreDivisor);
      raw.push({
        startSec: Math.min(peak.startSec, ...overlapping.map((c) => c.startSec)),
        endSec: Math.max(peak.endSec, ...overlapping.map((c) => c.endSec)),
        score: 0.5 + 0.5 * ((peak.intensity + commentScore) / 2),
        signals: ['heatmap', 'comments'],
        introFlag: overlapping.some((c) => c.introFlag),
        heatIntensity: peak.intensity,
        commentMentions: mentions,
        sampleComments: overlapping.flatMap((c) => c.sampleComments).slice(0, 3),
      });
    } else {
      raw.push({
        startSec: peak.startSec,
        endSec: peak.endSec,
        score: peak.intensity,
        signals: ['heatmap'],
        introFlag: false,
        heatIntensity: peak.intensity,
        commentMentions: null,
        sampleComments: [],
      });
    }
  }

  for (const cluster of clusters) {
    if (usedClusters.has(cluster)) continue;
    raw.push({
      startSec: cluster.startSec,
      endSec: cluster.endSec,
      score: Math.min(1, cluster.mentions / commentScoreDivisor),
      signals: ['comments'],
      introFlag: Boolean(cluster.introFlag),
      heatIntensity: null,
      commentMentions: cluster.mentions,
      sampleComments: cluster.sampleComments.slice(0, 3),
    });
  }

  const windows = raw.map((win) => {
    const chapter = chapters.find((ch) => rangesOverlap(win.startSec, win.endSec, ch.startSec, ch.endSec));
    const score = chapter ? Math.min(1, win.score + chapterBonus) : win.score;
    const signals = chapter ? [...win.signals, 'chapter'] : win.signals;
    return {
      startSec: Math.max(0, win.startSec - padSec),
      endSec: durationSec > 0 ? Math.min(durationSec, win.endSec + padSec) : win.endSec + padSec,
      score,
      signals,
      introFlag: win.introFlag,
      evidence: {
        heatIntensity: win.heatIntensity,
        commentMentions: win.commentMentions,
        sampleComments: win.sampleComments,
        chapterTitle: chapter ? chapter.title : null,
      },
    };
  });

  return windows.sort((a, b) => b.score - a.score);
}
```

Extend `module.exports` to its final form:

```js
module.exports = {
  parseHeatmap,
  pickHeatmapPeaks,
  extractTimestampsFromComments,
  clusterCommentTimestamps,
  extractChapters,
  scoreCandidateWindows,
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/moment-discovery.test.js`
Expected: PASS — 16 tests pass.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS — all existing tests plus 16 new; zero failures.

- [ ] **Step 6: Commit**

```bash
git add n8n/workflow-code/moment-discovery.js tests/moment-discovery.test.js
git commit -m "feat(moment-discovery): chapter extraction and candidate window scoring"
```

---

### Task 4: CLI runner with yt-dlp, comments API, and markdown report

**Files:**
- Create: `scripts/discover-moments.js`

**Interfaces:**
- Consumes (from `n8n/workflow-code/moment-discovery.js`): `parseHeatmap(infoJson)`, `pickHeatmapPeaks(segments)`, `extractTimestampsFromComments(comments)`, `clusterCommentTimestamps(hits)`, `extractChapters(infoJson)`, `scoreCandidateWindows({peaks, clusters, chapters, durationSec})` — all with default options.
- Produces: CLI `node scripts/discover-moments.js <url> [<url> ...]`; markdown report at `n8n/local-files/moment-discovery-report-<YYYY-MM-DD>.md`. No later task consumes this.

Behavior requirements (spec "Error handling / degradation" table):
- yt-dlp missing/failing → warn, continue with comments-only (video id parsed from URL).
- No heatmap in info JSON → note in report, comment-only scoring.
- `YOUTUBE_API_KEY` missing or API error → warn, heatmap+chapters only. Key read from env, falling back to `.env` then `n8n/.env` files (simple `KEY=value` parsing, no dependency).
- Zero signals → stated explicitly per video.
- One video's total failure must not abort remaining URLs.

- [ ] **Step 1: Write the CLI**

Create `scripts/discover-moments.js`:

```js
#!/usr/bin/env node
// Moment-discovery test harness: score YouTube videos for clip-worthy moments
// using pre-transcript signals (heatmap, timestamped comments, chapters).
//
// Usage: node scripts/discover-moments.js <youtube-url> [<youtube-url> ...]
// Requires: yt-dlp on PATH (heatmap+chapters), YOUTUBE_API_KEY env (comments).
// Spec: docs/superpowers/specs/2026-07-06-moment-discovery-design.md

const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const fs = require('node:fs');
const path = require('node:path');

const {
  parseHeatmap,
  pickHeatmapPeaks,
  extractTimestampsFromComments,
  clusterCommentTimestamps,
  extractChapters,
  scoreCandidateWindows,
} = require('../n8n/workflow-code/moment-discovery');

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.join(__dirname, '..');

function loadApiKey() {
  if (process.env.YOUTUBE_API_KEY) return process.env.YOUTUBE_API_KEY;
  for (const envPath of [path.join(REPO_ROOT, '.env'), path.join(REPO_ROOT, 'n8n', '.env')]) {
    if (!fs.existsSync(envPath)) continue;
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
      const match = line.match(/^\s*YOUTUBE_API_KEY\s*=\s*"?([^"\s#]+)"?/);
      if (match) return match[1];
    }
  }
  return null;
}

function parseVideoId(url) {
  const match = String(url).match(/(?:v=|youtu\.be\/|\/shorts\/|\/live\/)([A-Za-z0-9_-]{11})/);
  return match ? match[1] : null;
}

async function fetchInfoJson(url) {
  const { stdout } = await execFileAsync('yt-dlp', ['-J', '--skip-download', url], {
    maxBuffer: 256 * 1024 * 1024,
  });
  return JSON.parse(stdout);
}

async function fetchComments(videoId, apiKey) {
  const endpoint = new URL('https://www.googleapis.com/youtube/v3/commentThreads');
  endpoint.searchParams.set('part', 'snippet');
  endpoint.searchParams.set('videoId', videoId);
  endpoint.searchParams.set('maxResults', '100');
  endpoint.searchParams.set('order', 'relevance');
  endpoint.searchParams.set('textFormat', 'plainText');
  endpoint.searchParams.set('key', apiKey);

  const response = await fetch(endpoint);
  if (!response.ok) {
    throw new Error(`commentThreads.list failed: HTTP ${response.status} ${await response.text()}`);
  }
  const body = await response.json();
  return (body.items || []).map((item) => {
    const snippet = item.snippet.topLevelComment.snippet;
    return { text: snippet.textDisplay || '', author: snippet.authorDisplayName || '' };
  });
}

function formatTime(totalSec) {
  const sec = Math.floor(totalSec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
}

async function processVideo(url, apiKey) {
  const result = {
    url,
    videoId: parseVideoId(url),
    title: null,
    durationSec: 0,
    windows: [],
    chapters: [],
    notes: [],
  };

  let infoJson = null;
  try {
    infoJson = await fetchInfoJson(url);
    result.videoId = infoJson.id || result.videoId;
    result.title = infoJson.title || null;
    result.durationSec = Number(infoJson.duration || 0);
  } catch (error) {
    result.notes.push(`yt-dlp failed (${error.message.split('\n')[0]}) — heatmap and chapters unavailable`);
  }

  const heatSegments = parseHeatmap(infoJson);
  if (infoJson && heatSegments.length === 0) {
    result.notes.push('no heatmap on this video (likely too few views) — comment/chapter signals only');
  }
  const peaks = pickHeatmapPeaks(heatSegments);
  result.chapters = extractChapters(infoJson);

  let clusters = [];
  if (!apiKey) {
    result.notes.push('YOUTUBE_API_KEY not set — comment signal skipped');
  } else if (!result.videoId) {
    result.notes.push('could not determine video id — comment signal skipped');
  } else {
    try {
      const comments = await fetchComments(result.videoId, apiKey);
      clusters = clusterCommentTimestamps(extractTimestampsFromComments(comments));
    } catch (error) {
      result.notes.push(`comments fetch failed (${error.message.split('\n')[0]}) — comment signal skipped`);
    }
  }

  result.windows = scoreCandidateWindows({
    peaks,
    clusters,
    chapters: result.chapters,
    durationSec: result.durationSec,
  });
  if (result.windows.length === 0) {
    result.notes.push('zero signals found — no candidate windows for this video');
  }
  return result;
}

function renderConsole(result) {
  console.log(`\n=== ${result.title || result.url} ===`);
  for (const note of result.notes) console.log(`  ! ${note}`);
  if (result.windows.length === 0) return;
  console.log('  rank  score  window                signals');
  result.windows.forEach((win, index) => {
    const range = `${formatTime(win.startSec)} - ${formatTime(win.endSec)}`;
    const flags = win.introFlag ? ' [intro]' : '';
    console.log(
      `  ${String(index + 1).padStart(4)}  ${win.score.toFixed(2)}   ${range.padEnd(20)} ${win.signals.join('+')}${flags}`,
    );
  });
}

function renderMarkdown(results) {
  const lines = [`# Moment Discovery Report — ${new Date().toISOString().slice(0, 10)}`, ''];
  for (const result of results) {
    lines.push(`## ${result.title || result.url}`, '');
    lines.push(`- URL: ${result.url}`);
    if (result.durationSec) lines.push(`- Duration: ${formatTime(result.durationSec)}`);
    for (const note of result.notes) lines.push(`- ⚠ ${note}`);
    lines.push('');
    if (result.windows.length > 0) {
      lines.push('| # | Score | Window | Signals | Evidence |');
      lines.push('|---|-------|--------|---------|----------|');
      result.windows.forEach((win, index) => {
        const link = result.videoId
          ? `[${formatTime(win.startSec)}](https://youtu.be/${result.videoId}?t=${Math.floor(win.startSec)})`
          : formatTime(win.startSec);
        const evidence = [];
        if (win.evidence.heatIntensity != null) evidence.push(`heat ${win.evidence.heatIntensity.toFixed(2)}`);
        if (win.evidence.commentMentions != null) evidence.push(`${win.evidence.commentMentions} comment mentions`);
        if (win.evidence.sampleComments.length > 0) {
          evidence.push(`"${win.evidence.sampleComments[0].replace(/\|/g, '\\|').slice(0, 80)}"`);
        }
        if (win.evidence.chapterTitle) evidence.push(`chapter: ${win.evidence.chapterTitle.replace(/\|/g, '\\|')}`);
        if (win.introFlag) evidence.push('intro-flagged');
        lines.push(
          `| ${index + 1} | ${win.score.toFixed(2)} | ${link} → ${formatTime(win.endSec)} | ${win.signals.join('+')} | ${evidence.join('; ')} |`,
        );
      });
      lines.push('');
    }
    if (result.chapters.length > 0) {
      lines.push('<details><summary>Chapters</summary>', '');
      for (const chapter of result.chapters) {
        lines.push(`- ${formatTime(chapter.startSec)} — ${chapter.title}`);
      }
      lines.push('', '</details>', '');
    }
  }
  return lines.join('\n');
}

async function main() {
  const urls = process.argv.slice(2);
  if (urls.length === 0) {
    console.error('Usage: node scripts/discover-moments.js <youtube-url> [<youtube-url> ...]');
    process.exit(1);
  }

  const apiKey = loadApiKey();
  const results = [];
  for (const url of urls) {
    try {
      const result = await processVideo(url, apiKey);
      results.push(result);
      renderConsole(result);
    } catch (error) {
      console.error(`\n=== ${url} ===\n  ! unexpected failure: ${error.message}`);
      results.push({ url, videoId: parseVideoId(url), title: null, durationSec: 0, windows: [], chapters: [], notes: [`unexpected failure: ${error.message}`] });
    }
  }

  const reportDir = path.join(REPO_ROOT, 'n8n', 'local-files');
  fs.mkdirSync(reportDir, { recursive: true });
  const reportPath = path.join(reportDir, `moment-discovery-report-${new Date().toISOString().slice(0, 10)}.md`);
  fs.writeFileSync(reportPath, renderMarkdown(results));
  console.log(`\nReport written: ${reportPath}`);
}

main();
```

- [ ] **Step 2: Verify usage error path**

Run: `node scripts/discover-moments.js`
Expected: prints `Usage: node scripts/discover-moments.js <youtube-url> [<youtube-url> ...]`, exit code 1.

- [ ] **Step 3: Verify degradation path without yt-dlp/API key**

Run (only if `yt-dlp` is NOT yet installed — otherwise skip to Step 4):
`node scripts/discover-moments.js "https://www.youtube.com/watch?v=dQw4w9WgXcQ"`
Expected: console shows `! yt-dlp failed ...` note and (if no key) `! YOUTUBE_API_KEY not set ...`, then `zero signals found` note; report file still written to `n8n/local-files/`; exit code 0.

- [ ] **Step 4: Install yt-dlp and smoke-test the real path**

```bash
pipx install yt-dlp || pip install --user yt-dlp
yt-dlp --version
node scripts/discover-moments.js "https://www.youtube.com/watch?v=<a-popular-long-video-the-user-knows>"
```

Expected: console table with ranked windows (heatmap signal at minimum on any 100k+-view video); markdown report contains clickable `youtu.be/<id>?t=` links, evidence column, chapters block. If `YOUTUBE_API_KEY` resolves, windows may show `heatmap+comments`.

Note: pick the actual test URL with the user at execution time — the point of the harness is videos they know.

- [ ] **Step 5: Run full test suite (regression check)**

Run: `npm test`
Expected: PASS — CLI has no tests of its own (network/subprocess), pure logic already covered; existing suite stays green.

- [ ] **Step 6: Commit**

```bash
git add scripts/discover-moments.js
git commit -m "feat(moment-discovery): CLI harness with yt-dlp, comments API, markdown report"
```

---

### Task 5: Final verification and wrap-up

**Files:**
- None created; verification only.

**Interfaces:**
- Consumes: everything from Tasks 1–4.
- Produces: verified, committed harness ready for the user's tuning runs.

- [ ] **Step 1: Full suite**

Run: `npm test`
Expected: all tests pass (existing 152+ plus 16 new), zero failures.

- [ ] **Step 2: End-to-end run on 2–3 user-chosen known videos**

```bash
node scripts/discover-moments.js "<url-1>" "<url-2>" "<url-3>"
```

Expected: report at `n8n/local-files/moment-discovery-report-<date>.md`. Hand the report to the user — success criterion is that ranked windows match moments they recognize as good. Their judgment here drives threshold tuning (`minIntensity`, `minMentions`, `windowSec`), which is follow-up work, not this plan.

- [ ] **Step 3: Confirm clean tree**

Run: `git status`
Expected: clean (reports in `n8n/local-files/` are untracked/ignored — leave them).
