const assert = require('node:assert/strict');
const { readdirSync } = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const workflowsDir = path.join(__dirname, '..', 'workflows');

function workflowFiles() {
  return readdirSync(workflowsDir)
    .filter((file) => file.endsWith('.json'))
    .sort();
}

test('Google Sheets read nodes execute once per workflow run', () => {
  const missing = [];

  for (const file of workflowFiles()) {
    const workflow = require(path.join(workflowsDir, file));
    for (const node of workflow.nodes || []) {
      if (
        node.type === 'n8n-nodes-base.googleSheets'
        && node.parameters?.operation === 'read'
        && node.executeOnce !== true
      ) {
        missing.push(`${file}: ${node.name}`);
      }
    }
  }

  assert.deepEqual(missing, []);
});
