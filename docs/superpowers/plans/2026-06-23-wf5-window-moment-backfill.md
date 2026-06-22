# WF5 Window Moment Backfill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Guarantee one deterministic `Clip_Moments` row for every accepted single-window analysis and repair historical missing rows without another AI call.

**Architecture:** Add a pure `buildMissingWindowMoments()` helper beside the existing WF5 parser. The generated workflow reads `Clip_Moments` once, then runs an independent idempotent backfill branch alongside the normal analysis loop. Structured-output and runtime validation constrain all scores to `0–10`.

**Tech Stack:** Node.js, `node:test`, n8n 2.25.7 workflow JSON, Google Sheets append-or-update.

---

### Task 1: Window Row Contract and Backfill Helper

**Files:**
- Modify: `tests/ai-transcript-analysis.test.js`
- Modify: `n8n/workflow-code/ai-transcript-analysis.js`

- [ ] **Step 1: Write failing normal-window completeness test**

Build a valid `USE_20_MIN_WINDOW` response with `exact_clips: []`. Assert that `momentRows` contains exactly one object and that its keys equal the documented `Clip_Moments` columns:

```js
[
  'clip_moment_id', 'video_id', 'niche', 'rank', 'start_sec', 'end_sec',
  'clip_length_seconds', 'hook_first_2_seconds', 'core_idea', 'why_valuable',
  'target_audience', 'suggested_title', 'suggested_caption', 'on_screen_text',
  'suggested_broll', 'commentary_angle', 'kenyan_african_application',
  'bible_verse_if_relevant', 'needs_extra_context', 'originality_score',
  'clip_score', 'rights_risk', 'final_recommendation', 'ssemble_status',
  'ssemble_job_id', 'strategy', 'source_video_url', 'created_at',
]
```

- [ ] **Step 2: Write failing backfill tests**

Import `buildMissingWindowMoments` and test these inputs:

```js
const analysisRows = [{
  video_id: 'VID-1', niche: 'FINANCE_BUSINESS', video_url: 'https://youtube.test/1',
  ai_episode_score: 75, recommended_strategy: 'USE_20_MIN_WINDOW',
  recommended_start_sec: 0, recommended_end_sec: 1200,
  reason_for_strategy: 'Useful window', rights_risk: 'medium',
  ai_json_output: JSON.stringify({
    best_20_min_window: {
      why_this_window: 'Dense founder section', estimated_number_of_good_clips: 5,
    },
  }),
}];
```

Assert one `CM-VID-1-W0` row, rank `0`, score clamped to `10`, stored risk, and `PENDING`. Add separate assertions that an existing ID is skipped, invalid window/strategy rows are ignored, malformed `ai_json_output` uses `reason_for_strategy`, and a high-risk joined source produces `AWAITING_MANUAL_APPROVAL`.

- [ ] **Step 3: Run focused tests and verify RED**

Run: `node tests/ai-transcript-analysis.test.js`

Expected: failure because `buildMissingWindowMoments` is not exported.

- [ ] **Step 4: Implement shared window-row construction**

Extract `buildWindowMoment(row, window, options)` from the current `parseAndGate()` window branch. It must populate every documented column and accept explicit `clipScore`, `rightsRisk`, `estimatedClips`, `highRiskSource`, and timestamp values.

Implement:

```js
function buildMissingWindowMoments(analysisRows, sourceRows, candidateRows, momentRows, now) {
  // Join video -> source -> risk, build existing ID set, select valid missing window rows,
  // parse ai_json_output only for optional window metadata, and return deterministic rows.
}
```

Use `buildWindowMoment()` from both normal analysis and repair paths. Export `buildMissingWindowMoments`.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run: `node tests/ai-transcript-analysis.test.js`

Expected: all focused tests pass.

### Task 2: Score Bounds

**Files:**
- Modify: `tests/ai-transcript-analysis.test.js`
- Modify: `n8n/workflow-code/ai-transcript-analysis.js`

- [ ] **Step 1: Write failing schema-bound tests**

Assert `minimum: 0` and `maximum: 10` on `overall_episode_score`, `exact_clips.items.properties.clip_score`, and `originality_score`. Pass a legacy object with score `75` to `parseAndGate()` and expect a retryable finite-range validation error.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `node tests/ai-transcript-analysis.test.js`

Expected: missing schema bounds and score `75` accepted.

- [ ] **Step 3: Add schema and runtime bounds**

Add `minimum: 0, maximum: 10` to all three score schemas. Extend `validateSchema()` number handling:

```js
if (schema.minimum !== undefined && value < schema.minimum) {
  throw new Error(`${path} must be at least ${schema.minimum}`);
}
if (schema.maximum !== undefined && value > schema.maximum) {
  throw new Error(`${path} must be at most ${schema.maximum}`);
}
```

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `node tests/ai-transcript-analysis.test.js`

Expected: all focused tests pass.

### Task 3: Workflow Repair Branch

**Files:**
- Modify: `tests/ai-transcript-analysis.test.js`
- Modify: `tests/workflow-sheets-execute-once.test.js`
- Modify: `n8n/workflow-code/create-wf5-ai-transcript-analysis.js`
- Regenerate: `n8n/workflows/05-ai-transcript-analysis.json`

- [ ] **Step 1: Write failing workflow tests**

Assert WF5 contains execute-once `Read Clip_Moments`, `Build Missing Window Moments`, and `Backfill Clip_Moments`. Assert the read follows `Read Candidate_Videos`, then branches to both `Pick Unanalyzed` and `Build Missing Window Moments`; assert the build node connects to a Sheets `appendOrUpdate` on `Clip_Moments` matching `clip_moment_id`.

- [ ] **Step 2: Run focused workflow tests and verify RED**

Run:

```bash
node tests/ai-transcript-analysis.test.js
node tests/workflow-sheets-execute-once.test.js
```

Expected: repair nodes and connections are absent.

- [ ] **Step 3: Generate the repair branch**

Add `Read Clip_Moments` using the existing execute-once Sheets helper. Embed `buildMissingWindowMoments()` in a code node that reads all four sheet datasets and returns one item per repair row. Add `Backfill Clip_Moments` with `appendOrUpdate`, auto-map input, and `matchingColumns: ['clip_moment_id']`. Wire the independent branch exactly as tested.

- [ ] **Step 4: Regenerate and verify GREEN**

Run:

```bash
node n8n/workflow-code/create-wf5-ai-transcript-analysis.js
node tests/ai-transcript-analysis.test.js
node tests/workflow-sheets-execute-once.test.js
```

Expected: focused tests pass.

### Task 4: Full Verification and Deployment

**Files:**
- Verify: `n8n/workflows/05-ai-transcript-analysis.json`
- Verify: `tests/*.test.js`

- [ ] **Step 1: Verify generated artifact and full suite**

Run the generator twice and verify the SHA-256 is unchanged on the second run. Then run:

```bash
node --test tests/*.test.js
git diff --check
```

- [ ] **Step 2: Import without losing credentials**

Export live WF5, attach its existing Google Sheets and OpenAI credential references to a temporary copy of the generated 18-node workflow, retain workflow ID `lYQ9n0IKLnewcTSK`, import, publish, and restart only the local n8n service.

- [ ] **Step 3: Verify live workflow structure**

Export live WF5 and assert it is active, has no duplicate node names, includes the three repair nodes, uses structured output, retains credentials, and contains `buildMissingWindowMoments` in the deployed code.

- [ ] **Step 4: Verify backfill behavior**

Run WF5 once or allow its next scheduled run. Confirm that at least one previously missing `CM-<video_id>-W0` row appears in `Clip_Moments` without a new OpenAI request for that analyzed transcript. If runtime access prevents direct sheet confirmation, report deployment separately from the outstanding live-data proof.
