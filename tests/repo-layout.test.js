'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const repoRoot = path.resolve(__dirname, '..');
const exists = (relativePath) => fs.existsSync(path.join(repoRoot, relativePath));

test('runtime lives under hosts/ and is split by trust level', () => {
  for (const file of [
    'hosts/compose.local.yaml',
    'hosts/compose.prod.yaml',
    'hosts/heavy/compose.yaml',
    'hosts/heavy/Dockerfile',
    'hosts/heavy/runners/Dockerfile',
    'hosts/heavy/runners/n8n-task-runners.json',
    'hosts/shared/postgres/compose.yaml',
    'hosts/shared/postgres/run-migrations.sh',
    'hosts/shared/traefik/compose.yaml',
    'hosts/.env.example',
    'hosts/AWS-DEPLOY.md',
  ]) {
    assert.equal(exists(file), true, `missing ${file}`);
  }
});

test('the short-videos domain carries everything it needs', () => {
  for (const file of [
    'domains/short-videos/domain.json',
    'domains/short-videos/workflows/06-yt-dlp-clip-download.json',
    'domains/short-videos/workflows/08c-ffmpeg-render-final-clip.json',
    'domains/short-videos/workflow-code/fair-share.js',
    'domains/short-videos/workflow-code/postiz-publishing.js',
    'domains/short-videos/postgres/init/001-publishing-queue.sql',
    'domains/short-videos/postgres/migrations/003-postiz-publishing.sql',
    'domains/short-videos/postgres/queries/claim-next-publishing-job.sql',
    'domains/short-videos/services/provider-uploader/server.js',
    'domains/short-videos/services/transcript/handler.py',
    'domains/short-videos/services/transcript/build.sh',
    'domains/short-videos/services/transcript/requirements.txt',
    'domains/short-videos/services/transcript/local-server.py',
    'domains/short-videos/services/transcript/test_handler.py',
    'domains/short-videos/scratch/transcript.py',
    'domains/short-videos/docs/architecture.md',
    'domains/short-videos/tests/postiz-publishing.test.js',
    'domains/short-videos/tests/fixtures/wf5-ai-responses.js',
    'domains/short-videos/render-data/.gitkeep',
  ]) {
    assert.equal(exists(file), true, `missing ${file}`);
  }
  assert.equal(fs.readdirSync(path.join(repoRoot, 'domains/short-videos/workflows')).length, 16);
});

test('the whatsapp-access domain is scaffolded and empty', () => {
  assert.equal(exists('domains/whatsapp-access/domain.json'), true);
  assert.equal(exists('domains/whatsapp-access/postgres/migrations'), true);
  assert.deepEqual(
    fs.readdirSync(path.join(repoRoot, 'domains/whatsapp-access/postgres/migrations'))
      .filter((name) => name.endsWith('.sql')),
    [],
  );
});

test('every domain manifest names a host and a database', () => {
  for (const domain of fs.readdirSync(path.join(repoRoot, 'domains'))) {
    const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, 'domains', domain, 'domain.json'), 'utf8'));
    assert.equal(manifest.name, domain);
    assert.ok(['heavy', 'public'].includes(manifest.host), `${domain}: bad host ${manifest.host}`);
    assert.equal(typeof manifest.database, 'string');
    assert.ok(Array.isArray(manifest.mounts));
  }
});

test('the old layout is gone', () => {
  for (const stale of ['n8n', 'lamba-function', 'transcript.txt', 'transcript.py', 'local-transcript-server.py', 'requirements.txt', 'tests/fixtures']) {
    assert.equal(exists(stale), false, `${stale} should no longer exist`);
  }
});

test('every workflow file is parseable JSON with nodes', () => {
  const dir = path.join(repoRoot, 'domains/short-videos/workflows');
  for (const file of fs.readdirSync(dir).filter((name) => name.endsWith('.json'))) {
    const workflow = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    assert.ok(Array.isArray(workflow.nodes) && workflow.nodes.length > 0, `${file} has no nodes`);
  }
});

test('render output under the domain is ignored, not trackable', () => {
  const ignore = fs.readFileSync(path.join(repoRoot, '.gitignore'), 'utf8');
  assert.match(ignore, /^domains\/short-videos\/render-data\/\*\*$/m);
  assert.match(ignore, /^!domains\/short-videos\/render-data\/\*\*\/$/m);
  assert.match(ignore, /^!domains\/short-videos\/render-data\/\*\*\/\.gitkeep$/m);
  assert.match(ignore, /^domains\/short-videos\/local-files\/$/m);
  assert.match(ignore, /^hosts\/\.env$/m);
  assert.match(ignore, /^hosts\/\*\/\.n8n\/$/m);
  assert.doesNotMatch(ignore, /n8n\/render-data/);
});

// Amendment 12: scripts/discover-moments.js:28 looked for n8n/.env and no test
// called loadApiKey(), so the suite would have stayed green while the script
// silently lost its API key. Nothing outside hosts/ may name the old env path.
test('no tracked source file still points at the old n8n/ paths', () => {
  const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: repoRoot, encoding: 'utf8' })
    .split('\0')
    .filter(Boolean)
    .filter((file) => /\.(js|mjs|cjs|py|sh|json|ya?ml)$/.test(file))
    // Plans and specs quote the old paths by design, in prose this scanner does
    // not strip, so they stay excluded wholesale.
    .filter((file) => !file.startsWith('docs/superpowers/'))
    // Tests are excluded for the same reason, and one more: a test that asserts
    // the old path is gone has to name it, in its title and its failure message.
    // Tests are verified by running them, not by scanning them.
    .filter((file) => !/(^|\/)tests\//.test(file));

  const offenders = [];
  for (const file of tracked) {
    // Strip line comments first. Comments legitimately discuss the old layout —
    // explaining why a path moved is documentation, not a stale reference — and
    // a scanner that reads prose flags its own explanation.
    const body = fs.readFileSync(path.join(repoRoot, file), 'utf8')
      .split('\n')
      .filter((line) => !/^\s*(\/\/|#)/.test(line))
      .join('\n');
    for (const pattern of [/\bn8n\/\.env\b/, /['"`]n8n\/(workflows|workflow-code|postgres|provider-uploader|render-data)\//, /\.\.\/n8n\//]) {
      if (pattern.test(body)) offenders.push(`${file} :: ${pattern}`);
    }
  }
  assert.deepEqual(offenders, [], `stale n8n/ references:\n${offenders.join('\n')}`);
});

test('the Lambda build is reproducible from requirements.txt, not from committed deps', () => {
  const service = 'domains/short-videos/services/transcript';
  const build = fs.readFileSync(path.join(repoRoot, service, 'build.sh'), 'utf8');

  // The pip invocation spans continuation lines, so match its parts.
  assert.match(build, /pip install/);
  assert.match(build, /-r requirements\.txt/);
  assert.match(build, /--target \.|-t \./);
  // Pinned to the Lambda runtime rather than the build host: one dependency
  // ships a compiled binary, so a host-resolved install can produce a zip that
  // only fails once it is running in AWS.
  assert.match(build, /--platform manylinux2014_x86_64/);
  assert.match(build, /--python-version 3\.12/);
  assert.match(build, /--only-binary=:all:/);
  // Comment-stripped: the script explains why --upgrade is absent, and a
  // scanner that reads prose flags its own explanation. Fourth time in this
  // branch, hence the helper.
  const buildSettings = build.split('\n').filter((line) => !/^\s*#/.test(line)).join('\n');
  assert.doesNotMatch(buildSettings, /--upgrade/);
  assert.match(build, /rm -f function\.zip/);
  // the zip must not swallow first-party sources that are not part of the Lambda
  for (const excluded of ['build.sh', 'function.zip', 'requirements.txt', 'test_handler.py', 'local-server.py', 'README.md']) {
    assert.ok(build.includes(`-x "${excluded}"`), `build.sh must exclude ${excluded}`);
  }
  // amendment 16: a local pytest run must not leak into the artifact
  assert.ok(build.includes('-x ".pytest_cache/*"'), 'build.sh must exclude .pytest_cache');

  const ignore = fs.readFileSync(path.join(repoRoot, '.gitignore'), 'utf8');
  assert.match(ignore, /^domains\/short-videos\/services\/transcript\/function\.zip$/m);
  assert.match(ignore, /^domains\/short-videos\/services\/transcript\/\*\.dist-info\/$/m);
  assert.match(ignore, /^domains\/short-videos\/services\/transcript\/youtube_transcript_api\/$/m);
});

test('only first-party files in the transcript service are tracked', () => {
  const tracked = execFileSync('git', ['ls-files', 'domains/short-videos/services/transcript'], {
    cwd: repoRoot, encoding: 'utf8',
  }).trim().split('\n').map((p) => path.basename(p)).sort();

  assert.deepEqual(tracked, [
    'README.md', 'build.sh', 'handler.py', 'local-server.py', 'requirements.txt', 'test_handler.py',
  ]);
});
