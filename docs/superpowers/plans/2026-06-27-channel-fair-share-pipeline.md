# Channel Fair-Share Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent one source channel from dominating the short-video pipeline by selecting eligible work in fair round-robin batches by `source_id`.

**Architecture:** Add one shared fair-share helper for source-balanced selection, then replace plain `.slice(0, limit)` selection in WF2, WF4, WF5, WF6, and WF8. Each workflow keeps its existing total limit, adds a per-source limit, and continues to write the same sheet states so downstream contracts stay stable.

**Tech Stack:** Node.js CommonJS helpers, node:test, generated n8n JSON workflows under `n8n/workflows`, Google Sheets as state store.

---

## File Structure

- Create `n8n/workflow-code/fair-share.js`: shared pure helper with deterministic round-robin selection by `source_id`.
- Create `tests/fair-share.test.js`: direct tests for the shared helper.
- Modify `n8n/workflow-code/video-fetch.js`: cap candidate rows per source in pure helper tests.
- Modify `n8n/workflow-code/create-wf2-video-fetch.js`: mirror WF2 per-source candidate cap in generated workflow code.
- Modify `n8n/workflows/02-video-fetch.json`: regenerate from WF2 generator.
- Modify `tests/video-fetch.test.js`: cover per-channel candidate capping.
- Modify `n8n/workflow-code/transcript-fetch.js`: use fair-share selection for WF4 transcript fetch.
- Modify `n8n/workflow-code/create-wf4-transcript-fetch.js`: mirror WF4 fair-share transcript selection in generated workflow code.
- Modify `n8n/workflows/04-transcript-fetch.json`: regenerate from WF4 generator.
- Modify `tests/transcript-fetch.test.js`: cover WF4 per-source transcript fairness.
- Modify `n8n/workflow-code/ai-transcript-analysis.js`: use fair-share selection for WF5 analysis rows.
- Modify `n8n/workflow-code/create-wf5-ai-transcript-analysis.js`: mirror WF5 fair-share selection in generated workflow code.
- Modify `n8n/workflows/05-ai-transcript-analysis.json`: regenerate from WF5 generator.
- Modify `tests/ai-transcript-analysis.test.js`: cover WF5 one-analysis-per-source selection.
- Modify `n8n/workflow-code/ssemble-dispatch.js`: use fair-share selection for WF6 Ssemble requests before spending credits.
- Modify `n8n/workflow-code/create-remaining-workflows.js`: mirror WF6 fair-share dispatch logic in generated workflow code.
- Modify `n8n/workflows/06-ssemble-dispatch.json`: regenerate from remaining-workflows generator.
- Modify `tests/remaining-workflows.test.js`: cover WF6 per-source credit fairness.
- Modify `n8n/workflow-code/drive-storage-transform.js`: use fair-share selection for WF8 awaiting-download clips.
- Modify `n8n/workflows/08-drive-storage-transform.json`: regenerate from remaining-workflows generator.
- Modify `docs/google-sheets-structure.md`: document the fair-share operational rule.

---

### Task 1: Shared Fair-Share Helper

**Files:**
- Create: `n8n/workflow-code/fair-share.js`
- Create: `tests/fair-share.test.js`

- [ ] **Step 1: Write the failing helper tests**

Create `tests/fair-share.test.js`:

```js
const assert = require('node:assert/strict');
const test = require('node:test');
const { pickFairBySource } = require('../n8n/workflow-code/fair-share');

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
```

- [ ] **Step 2: Run the helper tests and verify RED**

Run:

```bash
node --test tests/fair-share.test.js
```

Expected: FAIL with `Cannot find module '../n8n/workflow-code/fair-share'`.

- [ ] **Step 3: Implement the helper**

Create `n8n/workflow-code/fair-share.js`:

```js
function defaultCompare(sortKey) {
  return (a, b) => {
    const av = String(a[sortKey] || '');
    const bv = String(b[sortKey] || '');
    if (av && bv && av !== bv) return av.localeCompare(bv);
    if (av && !bv) return -1;
    if (!av && bv) return 1;
    return 0;
  };
}

function pickFairBySource(rows, options = {}) {
  const limit = Number(options.limit || rows.length || 0);
  const perSourceLimit = Number(options.perSourceLimit || limit || 1);
  const sourceKey = options.sourceKey || 'source_id';
  const compare = options.compare || defaultCompare(options.sortKey || 'created_at');

  if (limit <= 0 || perSourceLimit <= 0) return [];

  const buckets = new Map();
  for (const row of rows || []) {
    const source = String(row[sourceKey] || '__unknown__');
    if (!buckets.has(source)) buckets.set(source, []);
    buckets.get(source).push(row);
  }

  const sourceOrder = [...buckets.keys()].sort();
  for (const source of sourceOrder) {
    buckets.get(source).sort(compare);
  }

  const picked = [];
  const pickedBySource = {};
  let madeProgress = true;

  while (picked.length < limit && madeProgress) {
    madeProgress = false;
    for (const source of sourceOrder) {
      if (picked.length >= limit) break;
      pickedBySource[source] = pickedBySource[source] || 0;
      if (pickedBySource[source] >= perSourceLimit) continue;

      const bucket = buckets.get(source);
      if (!bucket || bucket.length === 0) continue;

      picked.push(bucket.shift());
      pickedBySource[source] += 1;
      madeProgress = true;
    }
  }

  return picked;
}

module.exports = {
  pickFairBySource,
};
```

- [ ] **Step 4: Run helper tests and verify GREEN**

Run:

```bash
node --test tests/fair-share.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit shared helper**

```bash
git add n8n/workflow-code/fair-share.js tests/fair-share.test.js
git commit -m "feat(n8n): add fair-share source picker"
```

---

### Task 2: WF2 Candidate Fetch Per-Channel Cap

**Files:**
- Modify: `n8n/workflow-code/video-fetch.js`
- Modify: `n8n/workflow-code/create-wf2-video-fetch.js`
- Modify: `n8n/workflows/02-video-fetch.json`
- Modify: `tests/video-fetch.test.js`

- [ ] **Step 1: Write the failing WF2 helper test**

Append to `tests/video-fetch.test.js`:

```js
test('limits newly built candidate rows per channel', () => {
  const meta = { source_id: 'SRC-1', source_name: 'Source', niche: 'FINANCE_BUSINESS' };
  const api = {
    items: Array.from({ length: 8 }, (_, index) => ({
      id: `video${index}`,
      snippet: {
        title: `Useful interview ${index}`,
        publishedAt: `2026-06-27T00:0${index}:00.000Z`,
        defaultAudioLanguage: 'en',
        categoryId: '22',
        liveBroadcastContent: 'none',
      },
      statistics: { viewCount: '1000', likeCount: '10', commentCount: '2' },
      contentDetails: { duration: 'PT20M' },
    })),
  };

  const rows = buildCandidateRows(meta, api, {}, '2026-06-27T01:00:00.000Z', { perSourceLimit: 5 });

  assert.equal(rows.length, 5);
  assert.deepEqual(rows.map((row) => row.youtube_video_id), ['video0', 'video1', 'video2', 'video3', 'video4']);
});
```

- [ ] **Step 2: Run WF2 test and verify RED**

Run:

```bash
node --test tests/video-fetch.test.js
```

Expected: FAIL because `buildCandidateRows` currently ignores the fifth argument and returns 8 rows.

- [ ] **Step 3: Update WF2 helper**

In `n8n/workflow-code/video-fetch.js`, change the function signature and add the cap:

```js
function buildCandidateRows(meta, videoApi, existingIds, now = new Date().toISOString(), options = {}) {
  if (meta.__empty) return [{ __noop: true }];

  const perSourceLimit = Number(options.perSourceLimit || 5);
  const out = [];
  for (const video of videoApi.items || []) {
    if (out.length >= perSourceLimit) break;
    if (!video.id || existingIds[video.id]) continue;
    existingIds[video.id] = true;

    const snippet = video.snippet || {};
    const statistics = video.statistics || {};
    out.push({
      video_id: `VID-${video.id}`,
      niche: meta.niche,
      source_id: meta.source_id,
      source_name: meta.source_name,
      video_title: snippet.title,
      video_url: `https://www.youtube.com/watch?v=${video.id}`,
      youtube_video_id: video.id,
      duration_seconds: isoDurationToSeconds(video.contentDetails && video.contentDetails.duration),
      published_at: snippet.publishedAt,
      view_count: Number(statistics.viewCount || 0),
      like_count: Number(statistics.likeCount || 0),
      comment_count: Number(statistics.commentCount || 0),
      transcript_available: '',
      language: snippet.defaultAudioLanguage || snippet.defaultLanguage || '',
      validity_status: '',
      validity_score: '',
      rejection_reason: '',
      duplicate_status: 'UNIQUE',
      processing_status: 'NEW',
      created_at: now,
      __category_id: snippet.categoryId || '',
      __is_live: snippet.liveBroadcastContent || 'none',
      __title_lower: (snippet.title || '').toLowerCase(),
    });
  }

  if (out.length === 0) return [{ __noop: true }];
  return out;
}
```

- [ ] **Step 4: Mirror the cap in WF2 generator**

In `n8n/workflow-code/create-wf2-video-fetch.js`, inside the `Build Candidate Rows` Code node string:

1. Add before `const out = [];`:

```js
const MAX_NEW_VIDEOS_PER_SOURCE = 5;
const newThisSource = {};
```

2. Add after `if (!v.id || sd.existingIds[v.id]) continue;`:

```js
newThisSource[meta.source_id] = newThisSource[meta.source_id] || 0;
if (newThisSource[meta.source_id] >= MAX_NEW_VIDEOS_PER_SOURCE) continue;
newThisSource[meta.source_id] += 1;
```

- [ ] **Step 5: Regenerate WF2**

Run:

```bash
node n8n/workflow-code/create-wf2-video-fetch.js
```

Expected: `n8n/workflows/02-video-fetch.json` changes and contains `MAX_NEW_VIDEOS_PER_SOURCE`.

- [ ] **Step 6: Run WF2 tests**

Run:

```bash
node --test tests/video-fetch.test.js
```

Expected: PASS.

- [ ] **Step 7: Commit WF2 fair cap**

```bash
git add tests/video-fetch.test.js n8n/workflow-code/video-fetch.js n8n/workflow-code/create-wf2-video-fetch.js n8n/workflows/02-video-fetch.json
git commit -m "feat(n8n): cap WF2 candidates per source"
```

---

### Task 3: WF4 Fair Transcript Fetch

**Files:**
- Modify: `n8n/workflow-code/transcript-fetch.js`
- Modify: `n8n/workflow-code/create-wf4-transcript-fetch.js`
- Modify: `n8n/workflows/04-transcript-fetch.json`
- Modify: `tests/transcript-fetch.test.js`

- [ ] **Step 1: Write the failing WF4 test**

Replace the existing `picks at most 10 valid candidates without transcript state` test in `tests/transcript-fetch.test.js` with:

```js
test('picks pending transcripts fairly by source', () => {
  const rows = [
    ...Array.from({ length: 8 }, (_, index) => ({
      video_id: `A-${index}`,
      source_id: 'SRC-A',
      validity_status: 'VALID',
      transcript_available: '',
      created_at: `2026-06-27T00:0${index}:00.000Z`,
    })),
    ...Array.from({ length: 3 }, (_, index) => ({
      video_id: `B-${index}`,
      source_id: 'SRC-B',
      validity_status: 'VALID',
      transcript_available: '',
      created_at: `2026-06-27T00:0${index}:00.000Z`,
    })),
    { video_id: 'SKIP-1', source_id: 'SRC-C', validity_status: 'FLAGGED', transcript_available: '' },
    { video_id: 'SKIP-2', source_id: 'SRC-C', validity_status: 'VALID', transcript_available: 'TRUE' },
  ];

  const picked = pickPendingTranscripts(rows, { limit: 10, perSourceLimit: 2 });

  assert.deepEqual(picked.map((row) => row.video_id), ['A-0', 'B-0', 'A-1', 'B-1']);
});
```

- [ ] **Step 2: Run WF4 test and verify RED**

Run:

```bash
node --test tests/transcript-fetch.test.js
```

Expected: FAIL because `pickPendingTranscripts` currently accepts a numeric limit and slices the first rows.

- [ ] **Step 3: Update WF4 helper**

In `n8n/workflow-code/transcript-fetch.js`, require the helper and replace `pickPendingTranscripts`:

```js
const { pickFairBySource } = require('./fair-share');

function pickPendingTranscripts(candidateRows, options = {}) {
  const limit = typeof options === 'number' ? options : Number(options.limit || 10);
  const perSourceLimit = typeof options === 'number' ? limit : Number(options.perSourceLimit || 2);
  const eligible = candidateRows
    .filter((row) => String(row.validity_status) === 'VALID')
    .filter((row) => String(row.transcript_available || '') === '');

  return pickFairBySource(eligible, {
    limit,
    perSourceLimit,
    sourceKey: 'source_id',
    sortKey: 'created_at',
  });
}
```

- [ ] **Step 4: Mirror WF4 fair selection in generator**

In `n8n/workflow-code/create-wf4-transcript-fetch.js`, update the `Pick Pending Transcripts` Code node string to include inline `pickFairBySource` and call it with `{ limit: 10, perSourceLimit: 2, sourceKey: 'source_id', sortKey: 'created_at' }`.

Use this exact inline helper inside the Code node:

```js
function pickFairBySource(rows, options) {
  const buckets = new Map();
  for (const row of rows) {
    const source = String(row[options.sourceKey] || '__unknown__');
    if (!buckets.has(source)) buckets.set(source, []);
    buckets.get(source).push(row);
  }
  const sourceOrder = [...buckets.keys()].sort();
  for (const source of sourceOrder) {
    buckets.get(source).sort((a, b) => String(a[options.sortKey] || '').localeCompare(String(b[options.sortKey] || '')));
  }
  const picked = [];
  const pickedBySource = {};
  while (picked.length < options.limit) {
    let moved = false;
    for (const source of sourceOrder) {
      if (picked.length >= options.limit) break;
      pickedBySource[source] = pickedBySource[source] || 0;
      if (pickedBySource[source] >= options.perSourceLimit) continue;
      const row = buckets.get(source).shift();
      if (!row) continue;
      picked.push(row);
      pickedBySource[source] += 1;
      moved = true;
    }
    if (!moved) break;
  }
  return picked;
}
```

- [ ] **Step 5: Regenerate WF4**

Run:

```bash
node n8n/workflow-code/create-wf4-transcript-fetch.js
```

Expected: `n8n/workflows/04-transcript-fetch.json` changes and contains `pickFairBySource`.

- [ ] **Step 6: Run WF4 tests**

Run:

```bash
node --test tests/transcript-fetch.test.js
```

Expected: PASS.

- [ ] **Step 7: Commit WF4 fair selection**

```bash
git add tests/transcript-fetch.test.js n8n/workflow-code/transcript-fetch.js n8n/workflow-code/create-wf4-transcript-fetch.js n8n/workflows/04-transcript-fetch.json
git commit -m "feat(n8n): select WF4 transcripts fairly by source"
```

---

### Task 4: WF5 Fair AI Analysis

**Files:**
- Modify: `n8n/workflow-code/ai-transcript-analysis.js`
- Modify: `n8n/workflow-code/create-wf5-ai-transcript-analysis.js`
- Modify: `n8n/workflows/05-ai-transcript-analysis.json`
- Modify: `tests/ai-transcript-analysis.test.js`

- [ ] **Step 1: Write the failing WF5 test**

Append to `tests/ai-transcript-analysis.test.js`:

```js
test('pickUnanalyzed selects AI analysis rows fairly by source', () => {
  const analysisRows = [
    ...Array.from({ length: 4 }, (_, index) => ({
      analysis_id: `AN-A-${index}`,
      video_id: `VID-A-${index}`,
      transcript_status: 'FETCHED',
      ai_episode_score: '',
      created_at: `2026-06-27T00:0${index}:00.000Z`,
    })),
    ...Array.from({ length: 2 }, (_, index) => ({
      analysis_id: `AN-B-${index}`,
      video_id: `VID-B-${index}`,
      transcript_status: 'FETCHED',
      ai_episode_score: '',
      created_at: `2026-06-27T00:0${index}:00.000Z`,
    })),
  ];
  const candidates = [
    ...Array.from({ length: 4 }, (_, index) => ({ video_id: `VID-A-${index}`, source_id: 'SRC-A' })),
    ...Array.from({ length: 2 }, (_, index) => ({ video_id: `VID-B-${index}`, source_id: 'SRC-B' })),
  ];

  const picked = pickUnanalyzed(analysisRows, [], candidates, { limit: 5, perSourceLimit: 1 });

  assert.deepEqual(picked.map((row) => row.video_id), ['VID-A-0', 'VID-B-0']);
});
```

- [ ] **Step 2: Run WF5 test and verify RED**

Run:

```bash
node --test tests/ai-transcript-analysis.test.js
```

Expected: FAIL because `pickUnanalyzed` currently expects a numeric limit and slices.

- [ ] **Step 3: Update WF5 helper**

In `n8n/workflow-code/ai-transcript-analysis.js`, require `pickFairBySource` and replace the final selection in `pickUnanalyzed`:

```js
const { pickFairBySource } = require('./fair-share');

function pickUnanalyzed(analysisRows, sourceRows, candidateRows, options = 5) {
  const limit = typeof options === 'number' ? options : Number(options.limit || 5);
  const perSourceLimit = typeof options === 'number' ? limit : Number(options.perSourceLimit || 1);
  const riskBySource = {};
  for (const source of sourceRows) {
    riskBySource[source.source_id] = String(source.risk_level || 'low').toLowerCase();
  }

  const candidateByVideo = {};
  for (const candidate of candidateRows) {
    candidateByVideo[candidate.video_id] = candidate;
  }

  const eligible = analysisRows
    .filter((row) => ['FETCHED', 'TRUNCATED'].includes(String(row.transcript_status)))
    .filter((row) => String(row.ai_episode_score || '') === '')
    .map((row) => {
      const candidate = candidateByVideo[row.video_id] || {};
      return {
        ...row,
        processing_status: candidate.processing_status || row.processing_status || 'NEW',
        source_risk: riskBySource[candidate.source_id] || 'low',
        source_id: candidate.source_id || '',
      };
    });

  return pickFairBySource(eligible, {
    limit,
    perSourceLimit,
    sourceKey: 'source_id',
    sortKey: 'created_at',
  });
}
```

- [ ] **Step 4: Mirror WF5 fair selection in generator**

In `n8n/workflow-code/create-wf5-ai-transcript-analysis.js`, update the `Pick Unanalyzed` Code node call:

```js
const rows = pickUnanalyzed(
  $('Read Transcript_Analysis').all().map(i => i.json),
  $('Read Source_Channels').all().map(i => i.json),
  $('Read Candidate_Videos').all().map(i => i.json),
  { limit: 5, perSourceLimit: 1 },
);
```

If the generated Code node embeds helper source, ensure `fair-share.js` source is included or inline `pickFairBySource` before `pickUnanalyzed`.

- [ ] **Step 5: Regenerate WF5**

Run:

```bash
node n8n/workflow-code/create-wf5-ai-transcript-analysis.js
```

Expected: `n8n/workflows/05-ai-transcript-analysis.json` changes and contains `perSourceLimit`.

- [ ] **Step 6: Run WF5 tests**

Run:

```bash
node --test tests/ai-transcript-analysis.test.js
```

Expected: PASS.

- [ ] **Step 7: Commit WF5 fair selection**

```bash
git add tests/ai-transcript-analysis.test.js n8n/workflow-code/ai-transcript-analysis.js n8n/workflow-code/create-wf5-ai-transcript-analysis.js n8n/workflows/05-ai-transcript-analysis.json
git commit -m "feat(n8n): select WF5 analyses fairly by source"
```

---

### Task 5: WF6 Fair Ssemble Credit Dispatch

**Files:**
- Modify: `n8n/workflow-code/ssemble-dispatch.js`
- Modify: `n8n/workflow-code/create-remaining-workflows.js`
- Modify: `n8n/workflows/06-ssemble-dispatch.json`
- Modify: `tests/remaining-workflows.test.js`

- [ ] **Step 1: Write the failing WF6 test**

Append to `tests/remaining-workflows.test.js`:

```js
test('WF6 dispatches Ssemble requests fairly by source before spending credits', () => {
  const moments = [
    { clip_moment_id: 'A-1', video_id: 'VID-A1', source_id: 'SRC-A', niche: 'FINANCE_BUSINESS', source_video_url: 'https://youtu.be/a1', start_sec: 0, end_sec: 90, clip_score: 10, strategy: 'USE_EXACT_CLIPS_ONLY', ssemble_status: 'PENDING', created_at: '2026-06-27T00:01:00.000Z' },
    { clip_moment_id: 'A-2', video_id: 'VID-A2', source_id: 'SRC-A', niche: 'FINANCE_BUSINESS', source_video_url: 'https://youtu.be/a2', start_sec: 0, end_sec: 90, clip_score: 9, strategy: 'USE_EXACT_CLIPS_ONLY', ssemble_status: 'PENDING', created_at: '2026-06-27T00:02:00.000Z' },
    { clip_moment_id: 'B-1', video_id: 'VID-B1', source_id: 'SRC-B', niche: 'FINANCE_BUSINESS', source_video_url: 'https://youtu.be/b1', start_sec: 0, end_sec: 90, clip_score: 8, strategy: 'USE_EXACT_CLIPS_ONLY', ssemble_status: 'PENDING', created_at: '2026-06-27T00:01:00.000Z' },
  ];

  const requests = planSsembleRequests(moments, [], {
    dailyBudget: 3,
    now: '2026-06-27T10:00:00.000Z',
    perSourceLimit: 1,
  });

  assert.deepEqual(requests.map((request) => request.clip_moment_id), ['A-1', 'B-1']);
});
```

- [ ] **Step 2: Run remaining workflow tests and verify RED**

Run:

```bash
node --test tests/remaining-workflows.test.js
```

Expected: FAIL because WF6 currently can select multiple moments from the same source/video group before another source.

- [ ] **Step 3: Update WF6 helper**

In `n8n/workflow-code/ssemble-dispatch.js`:

1. Require the helper:

```js
const { pickFairBySource } = require('./fair-share');
```

2. Replace the `byVideo` loop selection with fair selection:

```js
  const pending = moments
    .filter((moment) => String(moment.ssemble_status) === 'PENDING')
    .filter((moment) => !dispatched[moment.clip_moment_id]);

  const selected = pickFairBySource(pending, {
    limit: remaining,
    perSourceLimit: Number(options.perSourceLimit || 1),
    sourceKey: 'source_id',
    compare: (a, b) => {
      const scoreDelta = Number(b.clip_score || 0) - Number(a.clip_score || 0);
      if (scoreDelta !== 0) return scoreDelta;
      return String(a.created_at || '').localeCompare(String(b.created_at || ''));
    },
  });

  const requests = [];
  for (const moment of selected) {
    if (remaining === 0) break;
    let start = Math.max(0, Math.floor(Number(moment.start_sec)));
```

Keep the existing request body construction unchanged and include `source_id: moment.source_id || ''` in the pushed request object.

- [ ] **Step 4: Mirror WF6 fair dispatch in generator**

In `n8n/workflow-code/create-remaining-workflows.js`, update the WF6 embedded `Plan Requests` code so it contains `pickFairBySource` and passes:

```js
{ dailyBudget: 10, webhookUrl: 'https://YOUR_N8N_DOMAIN/webhook/ssemble-callback?secret=SSEMBLE_WEBHOOK_SECRET', perSourceLimit: 1 }
```

Ensure the generated request row includes `source_id`.

- [ ] **Step 5: Regenerate remaining workflows**

Run:

```bash
node n8n/workflow-code/create-remaining-workflows.js
```

Expected: `n8n/workflows/06-ssemble-dispatch.json` and possibly other generated remaining workflow files update. Review the diff and keep only generator-consistent changes.

- [ ] **Step 6: Run remaining workflow tests**

Run:

```bash
node --test tests/remaining-workflows.test.js
```

Expected: PASS.

- [ ] **Step 7: Commit WF6 fair dispatch**

```bash
git add tests/remaining-workflows.test.js n8n/workflow-code/ssemble-dispatch.js n8n/workflow-code/create-remaining-workflows.js n8n/workflows/06-ssemble-dispatch.json
git commit -m "feat(n8n): dispatch Ssemble credits fairly by source"
```

---

### Task 6: WF8 Fair Drive/Planner Processing

**Files:**
- Modify: `n8n/workflow-code/drive-storage-transform.js`
- Modify: `n8n/workflow-code/create-remaining-workflows.js`
- Modify: `n8n/workflows/08-drive-storage-transform.json`
- Modify: `tests/remaining-workflows.test.js`

- [ ] **Step 1: Write the failing WF8 test**

Append to `tests/remaining-workflows.test.js`:

```js
test('WF8 picks awaiting downloads fairly by source lineage', () => {
  const clips = [
    { created_clip_id: 'CC-A1', ssemble_job_id: 'REQ-A1', review_status: 'AWAITING_DOWNLOAD', created_at: '2026-06-27T00:01:00.000Z' },
    { created_clip_id: 'CC-A2', ssemble_job_id: 'REQ-A2', review_status: 'AWAITING_DOWNLOAD', created_at: '2026-06-27T00:02:00.000Z' },
    { created_clip_id: 'CC-B1', ssemble_job_id: 'REQ-B1', review_status: 'AWAITING_DOWNLOAD', created_at: '2026-06-27T00:01:00.000Z' },
  ];
  const jobs = [
    { ssemble_job_id: 'REQ-A1', clip_moment_id: 'CM-A1', video_id: 'VID-A1', niche: 'FINANCE_BUSINESS' },
    { ssemble_job_id: 'REQ-A2', clip_moment_id: 'CM-A2', video_id: 'VID-A2', niche: 'FINANCE_BUSINESS' },
    { ssemble_job_id: 'REQ-B1', clip_moment_id: 'CM-B1', video_id: 'VID-B1', niche: 'FINANCE_BUSINESS' },
  ];
  const moments = [
    { clip_moment_id: 'CM-A1', source_id: 'SRC-A' },
    { clip_moment_id: 'CM-A2', source_id: 'SRC-A' },
    { clip_moment_id: 'CM-B1', source_id: 'SRC-B' },
  ];

  const selected = pickAwaitingDownloads(clips, jobs, moments, { FINANCE_BUSINESS: 'FOLDER-1' }, { limit: 5, perSourceLimit: 1 });

  assert.deepEqual(selected.map((clip) => clip.created_clip_id), ['CC-A1', 'CC-B1']);
});
```

- [ ] **Step 2: Run remaining workflow tests and verify RED**

Run:

```bash
node --test tests/remaining-workflows.test.js
```

Expected: FAIL because `pickAwaitingDownloads` currently takes numeric `limit` and slices before lineage mapping.

- [ ] **Step 3: Update WF8 helper**

In `n8n/workflow-code/drive-storage-transform.js`, require the helper and change `pickAwaitingDownloads` to accept numeric or object options:

```js
const { pickFairBySource } = require('./fair-share');

function pickAwaitingDownloads(clips, jobs, moments, folders, options = 5) {
  const limit = typeof options === 'number' ? options : Number(options.limit || 5);
  const perSourceLimit = typeof options === 'number' ? limit : Number(options.perSourceLimit || 1);
  const jobsById = Object.fromEntries(jobs.map((job) => [job.ssemble_job_id, job]));
  const momentsById = Object.fromEntries(moments.map((moment) => [moment.clip_moment_id, moment]));

  const enriched = clips
    .filter((clip) => String(clip.review_status) === 'AWAITING_DOWNLOAD')
    .map((clip) => {
      const job = jobsById[clip.ssemble_job_id] || {};
      const moment = momentsById[job.clip_moment_id] || {};
      const niche = clip.niche || job.niche || 'AFRICAN_KENYAN_SUCCESS';
      return {
        ...clip,
        niche,
        video_id: clip.video_id || job.video_id || '',
        source_id: moment.source_id || job.source_id || clip.source_id || '',
        drive_folder_id: folders[niche],
        file_name: `${niche}_${clip.created_clip_id}.mp4`,
        moment_core_idea: moment.core_idea || '',
        moment_commentary_angle: moment.commentary_angle || '',
        moment_kenyan_application: moment.kenyan_african_application || '',
        moment_bible_verse: moment.bible_verse_if_relevant || '',
        moment_hook: moment.hook_first_2_seconds || '',
        moment_suggested_title: moment.suggested_title || '',
      };
    });

  return pickFairBySource(enriched, {
    limit,
    perSourceLimit,
    sourceKey: 'source_id',
    sortKey: 'created_at',
  });
}
```

- [ ] **Step 4: Mirror WF8 fair selection in generator**

In `n8n/workflow-code/create-remaining-workflows.js`, update the WF8 `Pick Awaiting Download` Code node to call:

```js
const rows = pickAwaitingDownloads(
  $('Read Created_Clips').all().map(i => i.json),
  $('Read Ssemble_Jobs').all().map(i => i.json),
  $('Read Clip_Moments').all().map(i => i.json),
  folders,
  { limit: 5, perSourceLimit: 1 },
);
```

Ensure the generated code includes `pickFairBySource`.

- [ ] **Step 5: Regenerate remaining workflows**

Run:

```bash
node n8n/workflow-code/create-remaining-workflows.js
```

Expected: `n8n/workflows/08-drive-storage-transform.json` changes and contains `perSourceLimit`.

- [ ] **Step 6: Run remaining workflow tests**

Run:

```bash
node --test tests/remaining-workflows.test.js
```

Expected: PASS.

- [ ] **Step 7: Commit WF8 fair selection**

```bash
git add tests/remaining-workflows.test.js n8n/workflow-code/drive-storage-transform.js n8n/workflow-code/create-remaining-workflows.js n8n/workflows/08-drive-storage-transform.json
git commit -m "feat(n8n): process WF8 downloads fairly by source"
```

---

### Task 7: Docs and Full Verification

**Files:**
- Modify: `docs/google-sheets-structure.md`

- [ ] **Step 1: Document fair-share behavior**

In `docs/google-sheets-structure.md`, under `Status-Column State Machine`, add:

```md
Fair-share processing:
- WF2 limits newly appended candidates to 5 per `source_id` per run.
- WF4 picks at most 2 transcript fetches per `source_id` per run, 10 total.
- WF5 picks at most 1 AI analysis per `source_id` per run, 5 total.
- WF6 spends at most 1 Ssemble credit per `source_id` per run, still bounded by the daily budget.
- WF8 picks at most 1 awaiting-download clip per `source_id` per run, 5 total.
```

- [ ] **Step 2: Run all Node tests**

Run:

```bash
node --test tests/*.test.js
```

Expected: all tests pass.

- [ ] **Step 3: Run whitespace check**

Run:

```bash
git diff --check
```

Expected: no output and exit code 0.

- [ ] **Step 4: Inspect generated workflow parity**

Run:

```bash
rg -n "pickFairBySource|perSourceLimit|MAX_NEW_VIDEOS_PER_SOURCE" n8n/workflow-code n8n/workflows tests docs/google-sheets-structure.md
```

Expected: matches in helper, tests, relevant generators, and generated WF2/WF4/WF5/WF6/WF8 JSON.

- [ ] **Step 5: Review git status for unrelated dirt**

Run:

```bash
git status --short
```

Expected: fair-share files are modified/committed; any pre-existing WF4/WF5 transcript changes or `__pycache__` files are not included unless intentionally handled in a separate task.

- [ ] **Step 6: Commit docs and verification**

```bash
git add docs/google-sheets-structure.md
git commit -m "docs: document channel fair-share processing"
```

---

## Self-Review

- Spec coverage: This plan covers fair-share channel handling from WF2 candidate ingestion through WF4 transcript fetch, WF5 AI analysis, WF6 Ssemble credit spend, and WF8 post-render processing.
- Placeholder scan: No TBD/TODO/fill-in placeholders remain. Each task names exact files, commands, and expected outcomes.
- Type consistency: The shared function is consistently named `pickFairBySource(rows, options)`. Options consistently use `limit`, `perSourceLimit`, `sourceKey`, `sortKey`, and optional `compare`.
- Known risk: WF6/WF8 fairness depends on `source_id` being present or recoverable from lineage. WF6 moment rows should already carry enough lineage from WF5; if not, the implementation should add `source_id` to generated `Clip_Moments` rows and docs in the same WF6 task before relying on it.
