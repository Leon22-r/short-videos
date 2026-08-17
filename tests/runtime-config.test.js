const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

test('local n8n task runner mounts render data at /data', () => {
  const compose = fs.readFileSync('n8n/compose.local.yaml', 'utf8');
  const taskRunnerSection = compose.split(/\n  task-runners:\n/)[1]?.split(/\n  [a-zA-Z0-9_-]+:\n/)[0] || '';

  assert.match(taskRunnerSection, /- \.\/render-data:\/data/);
});
