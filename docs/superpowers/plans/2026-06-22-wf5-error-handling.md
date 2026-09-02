# WF5 Error Handling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make WF5 accept valid Ssemble window responses, surface malformed AI output, retry transient failures, and write semantically correct analysis fields.

**Architecture:** Keep `ai-transcript-analysis.js` as the tested behavior source and `create-wf5-ai-transcript-analysis.js` as the workflow generator. Represent AI failures as normal retryable gate results so the n8n loop continues, then regenerate the checked-in workflow JSON from the generator.

**Tech Stack:** Node.js, `node:test`, n8n 2.25.7 workflow JSON, Google Sheets nodes, OpenAI Responses node.

---

### Task 1: Prompt and Gate Contract

**Files:**
- Modify: `tests/ai-transcript-analysis.test.js`
- Modify: `n8n/workflow-code/ai-transcript-analysis.js`

- [ ] **Step 1: Write failing prompt and window tests**

Add assertions that `user_message` explains raw seconds and the strategy/clip relationship. Add a gate test with score 8, `use_this: true`, a 1200-second window, `estimated_number_of_good_clips: 3`, and empty `exact_clips`; expect `USE_20_MIN_WINDOW` and one moment. Add rejection tests for a sub-60-second window and an estimate below 3.

- [ ] **Step 2: Run focused tests and verify failure**

Run: `node --test tests/ai-transcript-analysis.test.js`

Expected: failures for missing prompt text and empty-clip window acceptance.

- [ ] **Step 3: Implement the prompt and gate**

Extend `buildSchemaInstructions()` with explicit raw-second examples and strategy rules. Replace `strongInWindow` validation with:

```js
const validWindow = window.use_this === true
  && windowLength >= 60
  && windowLength <= 1200
  && Number(window.estimated_number_of_good_clips) >= 3;
```

Downgrade invalid windows using the existing exact-clip fallback.

- [ ] **Step 4: Run focused tests and verify pass**

Run: `node --test tests/ai-transcript-analysis.test.js`

Expected: all focused tests pass.

### Task 2: Retryable Errors and Sheet Mappings

**Files:**
- Modify: `tests/ai-transcript-analysis.test.js`
- Modify: `n8n/workflow-code/ai-transcript-analysis.js`

- [ ] **Step 1: Write failing retry and mapping tests**

Add tests showing that an `{ error: ... }` response and an unknown response shape return:

```js
{
  analysisUpdate: { ai_episode_score: '', recommended_strategy: '' },
  candidateUpdate: { processing_status: originalStatus },
  momentRows: [],
  retryable: true,
}
```

Add a successful exact-clip test proving `permission_risk` derives from copyright risk and `kenya_relevance` derives from `kenyan_african_application`.

- [ ] **Step 2: Run focused tests and verify failure**

Run: `node --test tests/ai-transcript-analysis.test.js`

Expected: retryable and mapping assertions fail against current behavior.

- [ ] **Step 3: Implement validation and retry results**

Add required-field validation after `parseAiResponse()`. Add a helper that builds bounded retry analysis data while leaving the score and strategy empty, preserving `row.processing_status`, and emitting no moments. Catch parse/validation errors at the gate boundary and return that retry result. Aggregate copyright risk into `permission_risk`; join non-empty clip `kenyan_african_application` values into bounded `kenya_relevance`.

- [ ] **Step 4: Preserve candidate status in selection**

Change `pickUnanalyzed()` to retain the matched candidate's `processing_status` on each selected row, defaulting to `NEW` only when absent.

- [ ] **Step 5: Run focused tests and verify pass**

Run: `node --test tests/ai-transcript-analysis.test.js`

Expected: all focused tests pass.

### Task 3: Generator and Workflow Parity

**Files:**
- Modify: `tests/ai-transcript-analysis.test.js`
- Modify: `n8n/workflow-code/create-wf5-ai-transcript-analysis.js`
- Regenerate: `n8n/workflows/05-ai-transcript-analysis.json`

- [ ] **Step 1: Write failing workflow configuration tests**

Assert exactly two complete message entries, `onError === 'continueRegularOutput'`, embedded/helper prompt equality, and absence of the ghost object. Assert the generated workflow equals the checked-in workflow after normal JSON parsing.

- [ ] **Step 2: Run focused tests and verify failure**

Run: `node --test tests/ai-transcript-analysis.test.js`

Expected: message-count, `onError`, and prompt-parity assertions fail.

- [ ] **Step 3: Fix and regenerate the workflow**

Remove the generator's prompt replacement so it embeds the helper source unchanged. Remove `{}` from `responses.values`, add `onError: 'continueRegularOutput'`, and run:

```bash
node n8n/workflow-code/create-wf5-ai-transcript-analysis.js
```

- [ ] **Step 4: Verify focused and full suites**

Run:

```bash
node --test tests/ai-transcript-analysis.test.js
node --test tests/*.test.js
git diff --check
```

Expected: all tests pass and `git diff --check` exits successfully.
