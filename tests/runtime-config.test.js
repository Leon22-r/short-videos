'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const repoRoot = path.resolve(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');

// Lines that actually set something, with comments stripped. The compose files
// discuss N8N_ENCRYPTION_KEY at length in comments precisely because it must not
// be set, so a naive match on the whole file would assert the opposite.
const settings = (relativePath) =>
  read(relativePath)
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');

test('local n8n task runner mounts render data at /data', () => {
  const compose = read('hosts/heavy/compose.yaml');
  const taskRunnerSection = compose.split(/\n  task-runners:\n/)[1]?.split(/\n  [a-zA-Z0-9_-]+:\n/)[0] || '';

  assert.match(taskRunnerSection, /- \.\.\/\.\.\/domains\/short-videos\/render-data:\/data/);
});

test('both compositions pin the project name and the volume resource names', () => {
  for (const file of ['hosts/compose.local.yaml', 'hosts/compose.prod.yaml']) {
    assert.match(read(file), /^name: n8n$/m, `${file} must pin the project name`);
  }
  // The project name loses to -p and to COMPOSE_PROJECT_NAME, so the volumes
  // that hold the credentials and the publishing queue pin their real names too.
  assert.match(settings('hosts/heavy/compose.yaml'), /^\s+name: n8n_n8n_data$/m);
  assert.match(settings('hosts/shared/postgres/compose.yaml'), /^\s+name: n8n_publishing_db_data$/m);
});

test('heavy sets no encryption key and keeps the narrowed node blocklist', () => {
  const heavy = settings('hosts/heavy/compose.yaml');
  // The key already in the n8n_data volume is the only one that can decrypt the
  // stored credentials. Setting any value here is unrecoverable.
  assert.doesNotMatch(heavy, /N8N_ENCRYPTION_KEY/);
  // The compose file escapes the inner quotes: "NODES_EXCLUDE=[\"...\"]".
  assert.match(heavy, /NODES_EXCLUDE=\[\\"n8n-nodes-base\.localFileTrigger\\"\]/);
  assert.match(heavy, /N8N_RESTRICT_FILE_ACCESS_TO=\/data;\/files/);
  // Deprecated in n8n 2.x and warned about on startup.
  assert.doesNotMatch(heavy, /N8N_AVAILABLE_BINARY_DATA_MODES/);
});

test('the task runner broker token has no default on either side', () => {
  const heavy = settings('hosts/heavy/compose.yaml');
  const uses = heavy.match(/N8N_RUNNERS_AUTH_TOKEN=\$\{[^}]+\}/g) || [];
  assert.equal(uses.length, 2, 'expected the broker and the runner to both read the token');
  for (const use of uses) {
    assert.match(use, /:\?/, `${use} must be required, not defaulted`);
    assert.doesNotMatch(use, /:-/, `${use} must not carry a committed default`);
  }
});

test('no credential in the host tree carries a committed default', () => {
  // postgres sits on public-net so the untrusted instance can reach 5432, and
  // POSTGRES_USER is a superuser there. A default password in git is a login.
  for (const file of [
    'hosts/heavy/compose.yaml',
    'hosts/shared/postgres/compose.yaml',
    'hosts/shared/traefik/compose.yaml',
  ]) {
    const body = settings(file);
    const defaulted = body.match(/\$\{[A-Z0-9_]*(PASSWORD|TOKEN|SECRET|KEY)[A-Z0-9_]*:-[^}]*\}/g) || [];
    assert.deepEqual(defaulted, [], `${file} defaults a credential: ${defaulted.join(', ')}`);
  }
  assert.match(settings('hosts/shared/postgres/compose.yaml'),
    /POSTGRES_PASSWORD: \$\{PUBLISHING_DB_PASSWORD:\?/);
});

test('heavy is memory-capped, concurrency-capped, and off public-net', () => {
  const heavy = settings('hosts/heavy/compose.yaml');
  assert.match(heavy, /mem_limit: 1g/);
  assert.match(heavy, /N8N_CONCURRENCY_PRODUCTION_LIMIT=\$\{HEAVY_CONCURRENCY:-2\}/);
  assert.match(heavy, /mem_limit: 512m/);
  assert.match(heavy, /mem_limit: 256m/);
  // Nothing in the heavy host may sit on public-net.
  assert.doesNotMatch(heavy, /public-net\]/);
  assert.match(settings('hosts/shared/postgres/compose.yaml'), /mem_limit: 512m/);
});

test('postgres keeps its healthcheck, durable volume and ordered migrations', () => {
  const postgres = settings('hosts/shared/postgres/compose.yaml');
  assert.match(postgres, /image: postgres:16-alpine/);
  assert.match(postgres, /pg_isready/);
  assert.match(postgres, /publishing_db_data:\/var\/lib\/postgresql\/data/);
  assert.match(postgres, /domains\/short-videos\/postgres\/init:\/docker-entrypoint-initdb\.d:ro/);
  assert.match(postgres, /short-videos-migrations:/);
  assert.match(postgres, /condition: service_healthy/);
  // heavy is what waits for the migration one-shot to finish.
  const heavy = settings('hosts/heavy/compose.yaml');
  assert.match(heavy, /condition: service_completed_successfully/);
  assert.match(heavy, /provider-uploader:/);
});

test('traefik is pinned, has no exposed API, and cannot reach heavy-net', () => {
  const traefik = settings('hosts/shared/traefik/compose.yaml');
  assert.match(traefik, /image: "traefik:v3\.\d+"/, 'traefik must be pinned to a v3 tag');
  assert.doesNotMatch(traefik, /--api\.insecure=true/);
  assert.match(traefik, /--providers\.docker\.network=public-net/);
  assert.match(traefik, /networks: \[public-net\]/);
  assert.doesNotMatch(traefik, /heavy-net\]/);
});
