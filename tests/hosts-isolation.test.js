'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const repoRoot = path.resolve(__dirname, '..');
const readRaw = (relativePath) => fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');

// These compose files carry long comments that name the very things the
// assertions below forbid — "NODES_EXCLUDE is left unset on purpose", "no
// render-data", "no route to heavy-net". The comments are the documentation
// that stops the next person undoing the boundary, so the assertions read
// settings, not prose.
const read = (relativePath) =>
  readRaw(relativePath)
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');

// Everything between `services:` and the next top-level key. The top-level
// `networks:` block is declared in every host file so each one also validates
// under `docker compose -f <file> config` alone, so it must not be mistaken for
// a service.
const servicesBlock = (relativePath) => {
  const body = read(relativePath);
  // Comment-stripped, these files begin with `services:` on line 1, so anchor
  // on the line rather than on a preceding newline.
  const match = /^services:$/m.exec(body);
  if (!match) return '';
  const rest = body.slice(match.index + match[0].length + 1);
  const end = rest.search(/^[a-zA-Z0-9_-]+:/m);
  return end === -1 ? rest : rest.slice(0, end);
};

const serviceNames = (relativePath) =>
  [...servicesBlock(relativePath).matchAll(/^  ([a-zA-Z0-9_-]+):$/gm)].map((m) => m[1]);

// The networks each service actually attaches to, as opposed to the networks
// the file declares.
const attachedNetworks = (relativePath) =>
  [...servicesBlock(relativePath).matchAll(/^    networks: \[([^\]]+)\]$/gm)]
    .flatMap((m) => m[1].split(',').map((name) => name.trim()));

test('public runs the stock image with the default node blocklist intact', () => {
  const compose = read('hosts/public/compose.yaml');

  assert.match(compose, /image: docker\.io\/n8nio\/n8n:\$\{N8N_VERSION:-2\.25\.7\}/);
  assert.doesNotMatch(compose, /build:/);
  // leaving NODES_EXCLUDE unset is what keeps executeCommand and
  // localFileTrigger blocked. Setting it at all, even to [], unblocks them.
  assert.doesNotMatch(compose, /NODES_EXCLUDE/);
  assert.match(compose, /N8N_CONCURRENCY_PRODUCTION_LIMIT=\$\{PUBLIC_CONCURRENCY:-5\}/);
});

test('public has no render mounts, no task runners and no shell tooling', () => {
  const compose = read('hosts/public/compose.yaml');

  assert.doesNotMatch(compose, /render-data/);
  assert.doesNotMatch(compose, /local-files/);
  assert.doesNotMatch(compose, /:\/data/);
  assert.doesNotMatch(compose, /:\/files/);
  assert.doesNotMatch(compose, /N8N_RUNNERS_MODE/);
});

test('the two hosts share no service name and no volume', () => {
  const heavyNames = serviceNames('hosts/heavy/compose.yaml');
  const publicNames = serviceNames('hosts/public/compose.yaml');
  const pub = read('hosts/public/compose.yaml');

  assert.ok(heavyNames.includes('n8n'), 'sanity: heavy must define a service named n8n');
  assert.ok(publicNames.includes('public-n8n'), 'sanity: public must define public-n8n');
  const overlap = heavyNames.filter((name) => publicNames.includes(name));
  assert.deepEqual(overlap, [], `services collide across hosts: ${overlap.join(', ')}`);

  assert.match(pub, /public_n8n_data:\/home\/node\/\.n8n/);
  assert.doesNotMatch(pub, /\bn8n_data:/);
});

test('the two hosts have different encryption keys', () => {
  // heavy keeps the key already inside its volume (so it sets none);
  // public pins its own, and Compose refuses to start without it.
  const heavySettings = read('hosts/heavy/compose.yaml')
    .split('\n').filter((line) => !/^\s*#/.test(line)).join('\n');
  assert.doesNotMatch(heavySettings, /N8N_ENCRYPTION_KEY/);
  assert.match(read('hosts/public/compose.yaml'), /N8N_ENCRYPTION_KEY=\$\{PUBLIC_N8N_ENCRYPTION_KEY:\?/);
});

test('public talks to its own database and cannot name the video one', () => {
  const compose = read('hosts/public/compose.yaml');

  assert.match(compose, /\$\{WHATSAPP_DB_NAME:-whatsapp_access\}/);
  assert.match(compose, /\$\{WHATSAPP_DB_USER:-whatsapp_access\}/);
  assert.doesNotMatch(compose, /PUBLISHING_DB_NAME|PUBLISHING_DB_USER|PUBLISHING_DB_PASSWORD/);
});

test('only public is routed through Traefik', () => {
  // heavy carries no Traefik label of any kind, so there is nothing for Traefik
  // to pick up even before the network partition is considered.
  assert.doesNotMatch(servicesBlock('hosts/heavy/compose.yaml'), /traefik\./);
  assert.match(read('hosts/public/compose.yaml'), /traefik\.enable=\$\{PUBLIC_TRAEFIK_ENABLE:-false\}/);
});

test('the whatsapp database and role are created idempotently on an existing volume', () => {
  const compose = read('hosts/shared/postgres/compose.yaml');
  assert.match(compose, /postgres-bootstrap:/);
  assert.match(compose, /whatsapp-access-migrations:/);
  assert.match(compose, /\.\.\/\.\.\/\.\.\/domains\/whatsapp-access\/postgres\/migrations:\/migrations:ro/);

  const bootstrap = read('hosts/shared/postgres/bootstrap-databases.sh');
  assert.match(bootstrap, /NOT EXISTS \(SELECT 1 FROM pg_roles WHERE rolname/);
  assert.match(bootstrap, /NOT EXISTS \(SELECT 1 FROM pg_database WHERE datname/);
  assert.match(bootstrap, /\\gexec/);
  // the point of two databases: public's role must not be able to connect to the video one
  assert.match(bootstrap, /REVOKE CONNECT ON DATABASE/);
});

test('both compositions include both hosts', () => {
  for (const file of ['hosts/compose.local.yaml', 'hosts/compose.prod.yaml']) {
    const compose = read(file);
    assert.match(compose, /- path: \.\/heavy\/compose\.yaml/, file);
    assert.match(compose, /- path: \.\/public\/compose\.yaml/, file);
    assert.match(compose, /- path: \.\/shared\/postgres\/compose\.yaml/, file);
  }
  assert.match(read('hosts/compose.prod.yaml'), /- path: \.\/shared\/traefik\/compose\.yaml/);
  assert.doesNotMatch(read('hosts/compose.local.yaml'), /traefik/);
});

// Amendment 1. Under Compose include: every service would otherwise share the
// project default bridge, and heavy's task-runner broker listens on all
// interfaces: a workflow on the webhook-facing instance could register as a
// runner and execute arbitrary code beside every credential.
test('public-net and heavy-net do not meet except at postgres', () => {
  // Every service in the public host is on public-net and nothing else.
  assert.deepEqual([...new Set(attachedNetworks('hosts/public/compose.yaml'))], ['public-net']);

  // Every service in the heavy host is on heavy-net and nothing else.
  assert.deepEqual([...new Set(attachedNetworks('hosts/heavy/compose.yaml'))], ['heavy-net']);

  // Traefik reaches public-net only, so a stray label on heavy cannot publish it.
  assert.deepEqual([...new Set(attachedNetworks('hosts/shared/traefik/compose.yaml'))], ['public-net']);

  // postgres is the one service on both, and the only one.
  const shared = attachedNetworks('hosts/shared/postgres/compose.yaml');
  const onBoth = [...new Set(shared)].length === 2 ? 1 : 0;
  assert.equal(onBoth, 1, 'postgres must be the bridge between the two networks');
  const postgresBlock = servicesBlock('hosts/shared/postgres/compose.yaml');
  assert.equal((postgresBlock.match(/networks: \[heavy-net, public-net\]/g) || []).length, 1,
    'exactly one service may sit on both networks');
});

// Amendment 10. n8n defaults to 16 MB; five concurrent 16 MB JSON bodies parsed
// into V8 exceed public's 512 MB mem_limit. Payment and WhatsApp webhooks are
// under 50 KB.
test('public bounds its webhook payload at both layers', () => {
  const pub = read('hosts/public/compose.yaml');
  assert.match(pub, /N8N_PAYLOAD_SIZE_MAX=\$\{PUBLIC_PAYLOAD_SIZE_MAX:-4\}/);
  assert.match(pub, /buffering\.maxRequestBodyBytes=2097152/);
  assert.match(pub, /mem_limit: 512m/);
});

// Amendments 7 and 8. CONNECT is granted to PUBLIC on every new database, so
// fencing only the video database would have left the WhatsApp one open to the
// publishing role — and the planned gate only tested one direction.
test('both databases are fenced from PUBLIC and public is connection-capped', () => {
  const bootstrap = read('hosts/shared/postgres/bootstrap-databases.sh');

  const revokes = bootstrap.match(/REVOKE CONNECT ON DATABASE/g) || [];
  assert.equal(revokes.length, 2, 'both databases must be fenced, not just the video one');
  const grants = bootstrap.match(/GRANT CONNECT ON DATABASE/g) || [];
  assert.equal(grants.length, 2, 'each database must grant CONNECT back to its own role');

  assert.match(bootstrap, /CONNECTION LIMIT 20/);
});

// Found in the whole-branch review. Neither of these can be caught by reading
// the YAML for the thing it configures: one is a property of the base image,
// the other is the absence of a matcher.
test('the bootstrap one-shot runs under the shell its image actually has', () => {
  const bootstrap = readRaw('hosts/shared/postgres/bootstrap-databases.sh');
  const migrations = readRaw('hosts/shared/postgres/run-migrations.sh');

  // Both run in postgres:16-alpine, which is not guaranteed to carry bash.
  // A bash shebang there fails at exec time with "no such file or directory",
  // and the container exits before any SQL runs.
  assert.match(bootstrap, /^#!\/bin\/sh$/m);
  assert.match(migrations, /^#!\/bin\/sh$/m);
  assert.doesNotMatch(bootstrap, /#!.*bash/);

  // Shell comments explain why bash and pipefail are avoided, so the rest of
  // the assertion reads the executable lines only. Third time this file has
  // needed that distinction.
  const executable = bootstrap
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
  // pipefail is not POSIX, so it would fail under the shell above.
  assert.doesNotMatch(executable, /pipefail/);
  assert.match(executable, /^set -eu$/m);
});

test('only public n8n webhook paths are published, never the editor', () => {
  const rule = /traefik\.http\.routers\.public-n8n\.rule=(.+)/.exec(
    read('hosts/public/compose.yaml'),
  );
  assert.ok(rule, 'public-n8n must have a router rule');

  // A Host() rule on its own publishes "/" — the editor, /rest and /settings —
  // for an instance that holds credentials. The rule must narrow by path.
  assert.match(rule[1], /PathPrefix\(`\/webhook`\)/);
  assert.match(rule[1], /PathPrefix\(`\/form`\)/);
  assert.match(rule[1], /&&/, 'the Host() match must be ANDed with a path match');

  // Nothing may publish the editor surface.
  for (const forbidden of ['PathPrefix(`/`)', 'PathPrefix(`/rest`)', 'PathPrefix(`/settings`)']) {
    assert.ok(!rule[1].includes(forbidden), `router must not publish ${forbidden}`);
  }
});
