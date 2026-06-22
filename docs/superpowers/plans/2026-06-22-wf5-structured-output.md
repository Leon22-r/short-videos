# WF5 Structured Output Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enforce one bare WF5 analysis JSON object at the OpenAI boundary and parse n8n transport envelopes without Markdown or wrapper failures.

**Architecture:** `ai-transcript-analysis.js` owns the canonical bare JSON schema, request fields, extraction, validation, and business gates. The workflow generator configures the OpenAI Responses node with that schema, and generated JSON embeds the same helper. Regression fixtures cover the supplied successful and failing transport shapes before the workflow is regenerated and imported into n8n 2.25.7.

**Tech Stack:** Node.js, `node:test`, n8n 2.25.7, OpenAI Responses structured outputs, Google Sheets.

---

### Task 1: Canonical Schema and Prompt

**Files:**
- Modify: `tests/ai-transcript-analysis.test.js`
- Modify: `n8n/workflow-code/ai-transcript-analysis.js`

- [ ] **Step 1: Write failing canonical-contract tests**

Assert that `ANALYSIS_SCHEMA` directly exposes `overall_episode_score` rather than an `output` property. Assert `buildAnalysisRequest()` returns `analysis_schema: JSON.stringify(ANALYSIS_SCHEMA)` and its prompt contains both `Return the bare analysis object` and `Do not use Markdown code fences`, without requesting a top-level `output` wrapper.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node tests/ai-transcript-analysis.test.js`

Expected: schema and prompt assertions fail because the current schema requires `{ "output": analysis }` and requests a fenced block.

- [ ] **Step 3: Make the bare schema canonical**

Move the current `ANALYSIS_SCHEMA.properties.output` object to become `ANALYSIS_SCHEMA` itself without changing its window or clip property definitions. Change `recommended_strategy` to enum `SKIP_THIS_VIDEO | USE_EXACT_CLIPS_ONLY | USE_20_MIN_WINDOW`; change `final_recommendation` to enum `clip | use_as_idea_only | skip`; and change both risk properties to enum `low | medium | high`. Remove `ANALYSIS_OUTPUT_SCHEMA`. Return `analysis_schema: JSON.stringify(ANALYSIS_SCHEMA)` from `buildAnalysisRequest()` and replace fence/wrapper instructions with bare-object instructions. Require complete zero-valued window fields for skip responses.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `node tests/ai-transcript-analysis.test.js`

Expected: canonical-contract tests pass.

### Task 2: Envelope Extraction and Full Validation

**Files:**
- Create: `tests/fixtures/wf5-ai-responses.js`
- Modify: `tests/ai-transcript-analysis.test.js`
- Modify: `n8n/workflow-code/ai-transcript-analysis.js`

- [ ] **Step 1: Add regression fixtures for supplied payload classes**

Export fixture builders producing the n8n envelope:

```js
function responseEnvelope(text) {
  return [{
    output: [{
      id: 'msg_fixture',
      type: 'message',
      status: 'completed',
      content: [{ type: 'output_text', annotations: [], logprobs: [], text }],
      role: 'assistant',
    }],
  }];
}
```

Include fixtures for misplaced `risk_notes`, a missing closing fence, a valid fenced exact-clip response, a valid fenced window response, an empty-window SKIP response, and canonical unfenced JSON.

- [ ] **Step 2: Write failing parser and validator tests**

Assert:

- misplaced `risk_notes` retries with `missing required fields: risk_notes`;
- a missing closing fence retries with a JSON/fence diagnostic;
- valid legacy exact and window responses succeed;
- successful `ai_json_output` contains the bare object and no message ID, fence, or outer wrapper;
- empty `best_20_min_window` retries with a missing-window-fields diagnostic;
- canonical unfenced JSON succeeds;
- invalid enum values, non-finite numbers, and incomplete clips retry.

- [ ] **Step 3: Run focused tests and verify RED**

Run: `node tests/ai-transcript-analysis.test.js`

Expected: empty-window and deep-validation assertions fail.

- [ ] **Step 4: Separate extraction from validation**

Implement `extractAiPayload(response)` to unwrap only transport arrays, n8n `output` message arrays, content arrays, and complete legacy fenced blocks. After JSON parsing, unwrap a legacy model-level `output` only when it is the analysis wrapper. Keep malformed JSON unchanged so it becomes a retry result.

Expand `validateAiResponse()` to check all required window and clip fields, enums, arrays, objects, and finite numeric values. Return the validated bare object to `parseAndGate()` so successful persistence remains `JSON.stringify(ai)`.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run: `node tests/ai-transcript-analysis.test.js`

Expected: all fixture and validation tests pass.

### Task 3: OpenAI Structured Output and Generated Workflow

**Files:**
- Modify: `tests/ai-transcript-analysis.test.js`
- Modify: `n8n/workflow-code/create-wf5-ai-transcript-analysis.js`
- Regenerate: `n8n/workflows/05-ai-transcript-analysis.json`

- [ ] **Step 1: Write failing workflow-configuration tests**

Assert the `Call OpenAI` node contains:

```js
options: {
  textFormat: {
    textOptions: {
      type: 'json_schema',
      name: 'transcript_analysis',
      schema: '={{ $json.analysis_schema }}',
    },
  },
}
```

Also assert two complete messages, `continueRegularOutput`, no prompt override in the generator, and embedded helper prompt/schema parity.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `node tests/ai-transcript-analysis.test.js`

Expected: structured-output option assertions fail because `options` is empty.

- [ ] **Step 3: Configure structured output and regenerate**

Set the generator's OpenAI `options.textFormat.textOptions` exactly as tested and run:

```bash
node n8n/workflow-code/create-wf5-ai-transcript-analysis.js
```

- [ ] **Step 4: Verify generator idempotence and focused GREEN**

Run the generator twice, compare the workflow SHA-256 before and after the second run, parse the JSON with Node, then run `node tests/ai-transcript-analysis.test.js`.

Expected: identical hashes, valid JSON, and all focused tests pass.

### Task 4: Full Verification and Local n8n Deployment

**Files:**
- Verify: `n8n/workflows/05-ai-transcript-analysis.json`
- Verify: `tests/*.test.js`

- [ ] **Step 1: Run repository verification**

Run:

```bash
node --test tests/*.test.js
git diff --check
```

Expected: all test files pass and no whitespace errors are reported.

- [ ] **Step 2: Import and reactivate WF5**

Use the existing n8n container path:

```bash
docker compose -f n8n/docker-compose.local.yml exec -T n8n \
  n8n import:workflow --input=/workflows/05-ai-transcript-analysis.json
docker compose -f n8n/docker-compose.local.yml exec -T n8n \
  n8n update:workflow --id=<imported-wf5-id> --active=true
```

Resolve the workflow ID from the import/export output; do not guess it.

- [ ] **Step 3: Export and compare the live workflow**

Export WF5 from n8n and verify the live `Call OpenAI` node has JSON-schema output, the live parser contains deep validation, and exactly two messages are configured.

- [ ] **Step 4: Execute one known pending transcript**

Run WF5 once through n8n with an existing eligible Transcript_Analysis row. Confirm the updated row has a numeric AI score, no retry diagnostic, and `ai_json_output` parses as the bare analysis object without `id`, `content`, Markdown fences, or a top-level `output` key.

- [ ] **Step 5: Report external-state limits precisely**

If credentials, eligible rows, or OpenAI quota prevent the live run, report repository verification and deployment separately from the blocked live-data check. Do not mark the live check complete without observed sheet evidence.
