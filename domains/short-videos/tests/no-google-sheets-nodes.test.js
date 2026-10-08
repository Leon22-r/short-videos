const assert = require('node:assert/strict');
const { readdirSync, readFileSync } = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const workflowsDir = path.join(__dirname, '..', 'workflows');
const workflowFiles = () => readdirSync(workflowsDir).filter((file) => file.endsWith('.json')).sort();

// The completion criterion for the Supabase migration is SHEETS_NODE_CEILING
// reaching 0. It is a ratchet rather than a flat assertion so the suite stays
// green at every commit: each task that removes Sheets nodes lowers the
// ceiling in the same commit, and the suite is bisectable throughout.
//
//   Task 11 (here)                          65
//   Task 12  WF1, WF2, WF3        -9        56
//   Task 13  WF4, WF5, WF6       -20        36
//   Task 14  WF8..WF8d, WF9, WF10 -22       14
//   Task 15  WF11..WF14          -14         0
//
// Unlike the test this replaces, it cannot pass vacuously: the ceiling must be
// lowered as nodes go, and a reintroduced node breaks it immediately.
const SHEETS_NODE_CEILING = 65;
const SHEETS_PLACEHOLDER_CEILING = 16;

const sheetsNodes = () => {
  const found = [];
  for (const file of workflowFiles()) {
    const workflow = JSON.parse(readFileSync(path.join(workflowsDir, file), 'utf8'));
    for (const node of workflow.nodes || []) {
      if (node.type === 'n8n-nodes-base.googleSheets') found.push(`${file}: ${node.name}`);
    }
  }
  return found;
};

const placeholderFiles = () => workflowFiles().filter(
  (file) => readFileSync(path.join(workflowsDir, file), 'utf8').includes('GOOGLE_SHEETS_DOCUMENT_ID'),
);

test('no Google Sheets node is reintroduced', () => {
  const found = sheetsNodes();
  assert.ok(
    found.length <= SHEETS_NODE_CEILING,
    `${found.length} Google Sheets nodes, above the ceiling of ${SHEETS_NODE_CEILING}:\n${found.join('\n')}`,
  );
});

test('the Google Sheets node ceiling is not stale', () => {
  const found = sheetsNodes();
  assert.equal(
    found.length,
    SHEETS_NODE_CEILING,
    `${found.length} Google Sheets nodes remain but the ceiling is ${SHEETS_NODE_CEILING}. `
    + 'Lower SHEETS_NODE_CEILING to the new count in this same commit.',
  );
});

// A guard on the guard: if the workflows directory is empty or unreadable the
// tests above would pass for the wrong reason.
test('the workflow set is the expected size', () => {
  assert.equal(workflowFiles().length, 16);
});

// GOOGLE_SHEETS_DOCUMENT_ID was the placeholder every Sheets node carried, so
// it ratchets on the same schedule: 16 -> 13 -> 10 -> 4 -> 0.
test('the Sheets document placeholder is not reintroduced', () => {
  const found = placeholderFiles();
  assert.ok(
    found.length <= SHEETS_PLACEHOLDER_CEILING,
    `${found.length} workflows reference the Sheets document, above the ceiling of `
    + `${SHEETS_PLACEHOLDER_CEILING}:\n${found.join('\n')}`,
  );
});

test('the Sheets document placeholder ceiling is not stale', () => {
  assert.equal(
    placeholderFiles().length,
    SHEETS_PLACEHOLDER_CEILING,
    'Lower SHEETS_PLACEHOLDER_CEILING to the new count in this same commit.',
  );
});
