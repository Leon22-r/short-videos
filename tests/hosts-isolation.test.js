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
  // Fail closed. Returning '' here made the service-overlap and network
  // assertions pass on empty input, which is how a green trust-boundary test
  // came to check nothing at all.
  if (!match) throw new Error(`no services block parsed from ${relativePath}`);
  const rest = body.slice(match.index + match[0].length + 1);
  const end = rest.search(/^[a-zA-Z0-9_-]+:/m);
  return end === -1 ? rest : rest.slice(0, end);
};

const serviceNames = (relativePath) =>
  [...servicesBlock(relativePath).matchAll(/^  ([a-zA-Z0-9_-]+):$/gm)].map((m) => m[1]);

// The networks each service actually attaches to, as opposed to the networks
// the file declares.
// How many services declare a networks line at all. Distinct from the names
// below, because one service may list two networks.
const networkLineCount = (relativePath) =>
  (servicesBlock(relativePath).match(/^    networks: \[/gm) || []).length;

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
  assert.doesNotMatch(read('hosts/heavy/compose.yaml'), /N8N_ENCRYPTION_KEY/);
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
  // Postgres does the quoting, not the shell: a password containing a quote
  // used to break the script, and a role name could escape its identifier.
  assert.doesNotMatch(bootstrap, /PASSWORD '\$\{/);
  assert.match(bootstrap, /format\('ALTER ROLE %I LOGIN PASSWORD %L CONNECTION LIMIT 20', :'wuser', :'wpass'\)/);
  // A domain pointed at the admin role would silently reset the superuser password.
  assert.match(bootstrap, /WHATSAPP_DB_USER must differ from VIDEO_DB_USER and ADMIN_USER/);
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
test('every service declares a networks line, so none falls back to the default', () => {
  // A service with no networks key joins the Compose project default network.
  // Counting attachments against services is what makes the Set-based
  // assertions below non-vacuous: one correct line could otherwise mask any
  // number of unattached services.
  for (const file of [
    'hosts/heavy/compose.yaml',
    'hosts/public/compose.yaml',
    'hosts/shared/postgres/compose.yaml',
    'hosts/shared/traefik/compose.yaml',
  ]) {
    const names = serviceNames(file);
    assert.ok(names.length > 0, `${file}: no services parsed`);
    assert.equal(networkLineCount(file), names.length,
      `${file}: a service has no recognised 'networks: [...]' line`);
  }
});

test('public-net and heavy-net do not meet except at postgres', () => {
  // Every service in the public host is on public-net and nothing else.
  assert.deepEqual([...new Set(attachedNetworks('hosts/public/compose.yaml'))], ['public-net']);

  // Every service in the heavy host is on heavy-net and nothing else.
  assert.deepEqual([...new Set(attachedNetworks('hosts/heavy/compose.yaml'))], ['heavy-net']);

  // Traefik reaches public-net only, so a stray label on heavy cannot publish it.
  assert.deepEqual([...new Set(attachedNetworks('hosts/shared/traefik/compose.yaml'))], ['public-net']);

  // postgres is the one service on both, and the only one. Name it, rather than
  // counting how many distinct network names appear in the file.
  const postgresBlock = servicesBlock('hosts/shared/postgres/compose.yaml');
  const onBoth = [...postgresBlock.matchAll(/^  ([a-zA-Z0-9_-]+):$[\s\S]*?^    networks: \[([^\]]+)\]$/gm)]
    .filter((m) => m[2].includes('heavy-net') && m[2].includes('public-net'))
    .map((m) => m[1]);
  assert.deepEqual(onBoth, ['postgres'], 'only postgres may bridge the two networks');
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

  // Count-only matching let an echo or an SQL comment satisfy this. Pin the
  // target database and the FROM PUBLIC clause on each side.
  assert.match(bootstrap, /REVOKE CONNECT ON DATABASE %I FROM PUBLIC', :'vdb'/);
  assert.match(bootstrap, /GRANT CONNECT ON DATABASE %I TO %I', :'vdb', :'vuser'/);
  assert.match(bootstrap, /REVOKE CONNECT ON DATABASE %I FROM PUBLIC', :'wdb'/);
  assert.match(bootstrap, /GRANT CONNECT ON DATABASE %I TO %I', :'wdb', :'wuser'/);

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
  assert.match(rule[1], /&&/, 'the Host() match must be ANDed with a path match');
  // Anchored regex, not PathPrefix: a prefix also matches /webhookfoo.
  assert.ok(rule[1].includes('PathRegexp(`^/(webhook|webhook-waiting|form|form-waiting)(/|$)`)'),
    `rule must anchor the published paths, got: ${rule[1]}`);
  assert.doesNotMatch(rule[1], /PathPrefix/, 'use an anchored PathRegexp, not a loose prefix');
  // The -test endpoints are armed from the editor; they are not internet-facing.
  assert.doesNotMatch(rule[1], /webhook-test|form-test/);
  // Nothing may publish the editor surface.
  for (const forbidden of ['/rest', '/settings']) {
    assert.ok(!rule[1].includes(forbidden), `router must not publish ${forbidden}`);
  }
});
