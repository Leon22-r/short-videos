'use strict';

const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const repoRoot = path.resolve(__dirname, '..');
const codeDir = path.join(repoRoot, 'domains/short-videos/workflow-code');

// The generators used to need `cd <repo>` first (hardcoded n8n/ paths). They now
// resolve against __dirname, so they must work from an unrelated directory.
test('single-workflow generators run from any working directory', (t) => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-cwd-'));
  t.after(() => fs.rmSync(outDir, { recursive: true, force: true }));
  for (const script of [
    'create-wf2-video-fetch.js',
    'create-wf3-validity-check.js',
    'create-wf4-transcript-fetch.js',
    'create-wf5-ai-transcript-analysis.js',
  ]) {
    const out = path.join(outDir, `${script}.json`);
    execFileSync('node', [path.join(codeDir, script), out], { cwd: os.tmpdir(), stdio: 'pipe' });
    const wf = JSON.parse(fs.readFileSync(out, 'utf8'));
    assert.ok(Array.isArray(wf.nodes) && wf.nodes.length > 0, `${script} produced no nodes`);
  }
});

test('multi-workflow generator runs from any working directory', (t) => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-all-'));
  t.after(() => fs.rmSync(outDir, { recursive: true, force: true }));
  const r = spawnSync('node', ['-e', `require(${JSON.stringify(path.join(codeDir, 'create-remaining-workflows.js'))}).generateAll()`], {
    cwd: os.tmpdir(), env: { ...process.env, N8N_WORKFLOW_OUTPUT_DIR: outDir }, encoding: 'utf8',
  });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(fs.readdirSync(outDir).filter((f) => f.endsWith('.json')).length > 0);
});

test('shell entry points are syntactically valid for their declared interpreter', () => {
  execFileSync('sh', ['-n', path.join(repoRoot, 'hosts/shared/postgres/bootstrap-databases.sh')]);
  execFileSync('bash', ['-n', path.join(repoRoot, 'domains/short-videos/services/transcript/build.sh')]);
});

test('bootstrap script refuses to run without its required environment', () => {
  const env = { PATH: process.env.PATH };
  const r = spawnSync('sh', [path.join(repoRoot, 'hosts/shared/postgres/bootstrap-databases.sh')], { env, encoding: 'utf8' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /POSTGRES_HOST/);
});

// Amendment 12's finding: scripts/discover-moments.js looked for n8n/.env, and
// because loadApiKey() was never exported or called by a test, the move would
// have left it silently returning null instead of failing the suite.
test('discover-moments reads the API key from hosts/.env, not the old n8n/.env', (t) => {
  const { loadApiKey } = require('../scripts/discover-moments');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-env-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const saved = process.env.YOUTUBE_API_KEY;
  delete process.env.YOUTUBE_API_KEY;
  t.after(() => { if (saved === undefined) delete process.env.YOUTUBE_API_KEY; else process.env.YOUTUBE_API_KEY = saved; });

  // Nothing on disk yet.
  assert.equal(loadApiKey(root), null);

  // The old location must NOT satisfy it.
  fs.mkdirSync(path.join(root, 'n8n'), { recursive: true });
  fs.writeFileSync(path.join(root, 'n8n', '.env'), 'YOUTUBE_API_KEY=from-old-path\n');
  assert.equal(loadApiKey(root), null, 'n8n/.env must no longer be consulted');

  // The new location must.
  fs.mkdirSync(path.join(root, 'hosts'), { recursive: true });
  fs.writeFileSync(path.join(root, 'hosts', '.env'), '# comment\nYOUTUBE_API_KEY="from-hosts"\n');
  assert.equal(loadApiKey(root), 'from-hosts');

  // An explicit env var still wins over both files.
  process.env.YOUTUBE_API_KEY = 'from-env';
  assert.equal(loadApiKey(root), 'from-env');
});

// The transcript service resolves handler.py and its vendored deps against its
// own file, so it must import from an unrelated working directory.
//
// The deps are no longer tracked (build.sh installs them), so on a clean clone
// they are absent and this skips rather than failing. The handler-only half of
// the property is asserted unconditionally below, since handler.py IS tracked.
test('the transcript service imports handler and its vendored deps from any CWD', (t) => {
  const service = path.join(repoRoot, 'domains/short-videos/services/transcript');
  const probe = spawnSync('python3', ['-c', `import sys; sys.path.insert(0, ${JSON.stringify(service)}); import youtube_transcript_api`], { encoding: 'utf8' });
  if (probe.status !== 0) {
    t.skip('vendored deps not installed - run domains/short-videos/services/transcript/build.sh');
    return;
  }
  const r = spawnSync('python3', ['-c', [
    'import sys',
    `sys.path.insert(0, ${JSON.stringify(service)})`,
    'import handler, youtube_transcript_api',
    'assert handler.__file__.startswith(sys.path[0]), handler.__file__',
    'assert youtube_transcript_api.__file__.startswith(sys.path[0]), youtube_transcript_api.__file__',
    'print("ok")',
  ].join('\n')], { cwd: os.tmpdir(), encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /ok/);
});

// handler.py is tracked, so this half of the property holds on a clean clone and
// is what actually guards the sys.path change.
test('handler.py resolves from its own directory with no vendored deps present', () => {
  const service = path.join(repoRoot, 'domains/short-videos/services/transcript');
  const src = fs.readFileSync(path.join(service, 'local-server.py'), 'utf8');
  assert.match(src, /sys\.path\.insert\(0, str\(Path\(__file__\)\.resolve\(\)\.parent\)\)/);
  assert.doesNotMatch(src, /lamba-function/);
  const th = fs.readFileSync(path.join(service, 'test_handler.py'), 'utf8');
  assert.match(th, /sys\.path\.insert\(0, str\(Path\(__file__\)\.resolve\(\)\.parent\)\)/);
  assert.doesNotMatch(th, /lamba-function/);
});
