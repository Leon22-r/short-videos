# Multi-Domain Automation Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restructure the repository so runtime (`hosts/`) is separate from automation content (`domains/`), and a second, internet-facing n8n instance exists that cannot reach the video pipeline's shell access, credentials, or database.

**Architecture:** One big-bang `git mv` commit relocates `n8n/` into `hosts/heavy/` (runtime) and `domains/short-videos/` (content), rewriting the 42 host-side path references that the test suite already covers. Compose is restructured into per-host files composed by `include:`, with the Compose project name pinned to `n8n` so the existing `n8n_n8n_data` and `n8n_publishing_db_data` volumes are reused rather than recreated. A second stock `n8nio/n8n` service (`public-n8n`) is then added with its own encryption key, its own n8n volume, its own Postgres database and role, and n8n's default node blocklist left intact.

**Tech Stack:** Docker Compose (`include:`, `mem_limit`), n8n 2.25.7 (custom ffmpeg/yt-dlp image for `heavy`, stock image for `public`), Postgres 16, Traefik, Node 26 `node --test`, Python 3 + `youtube-transcript-api` (AWS Lambda packaging).

**Spec:** `docs/superpowers/specs/2026-09-30-multi-domain-automation-layout-design.md`

## Global Constraints

- Server is **4 GB RAM** and cannot be scaled. Total `mem_limit` ceiling must stay under 3 GB.
- n8n version pinned at **2.25.7** (`N8N_VERSION` default) for both hosts.
- **Docker volume names must not change**: `n8n_data`, `publishing_db_data`. Pin the Compose project name to `n8n` (`name: n8n`) in every top-level composition file, because the compose file moves out of the `n8n/` directory and the default project name would otherwise change.
- **Never set `N8N_ENCRYPTION_KEY` on `heavy`.** Its existing `n8n_data` volume already holds a generated key in `/home/node/.n8n/config`; a new value makes every stored credential undecryptable.
- **Workflow JSON contents do not change.** Container mount points stay `/data` and `/files`.
- **SQL file contents do not change.** Only their paths move.
- Move with `git mv`, never copy, so `git log --follow` and `git blame` survive.
- `heavy` keeps `NODES_EXCLUDE=["n8n-nodes-base.localFileTrigger"]`. `public` leaves `NODES_EXCLUDE` unset so n8n's default blocklist (`executeCommand` + `localFileTrigger`) applies.
- Drop `N8N_AVAILABLE_BINARY_DATA_MODES` (deprecated in n8n 2.x). Keep `N8N_DEFAULT_BINARY_DATA_MODE=filesystem`.
- `N8N_CONCURRENCY_PRODUCTION_LIMIT`: `heavy` = 2, `public` = 5.
- The directory is renamed to `automations/`; the GitHub remote stays `short-videos`.
- No WhatsApp automation logic. `domains/whatsapp-access/` gets a `domain.json`, an empty migrations directory, and nothing else.
- Baseline is **213 passing tests**. Task 1 must end at 213 again.
- Commit messages must **not** contain a `Co-Authored-By` trailer.

## Review Focus

1. **Compose project name.** The compose file moves from `n8n/` to `hosts/`, so Compose's default project name changes from `n8n` to `hosts` and `hosts_n8n_data` / `hosts_publishing_db_data` are created as fresh empty volumes — every workflow, credential and queue row appears lost. Expected: the stack comes up on the existing data. Pinned by `name: n8n` and asserted in Task 1.
2. **Name collisions between the two included host files.** `include:` merges both files into one project, so a `volumes: n8n_data:` or a service named `n8n` in both gives `public` the same credential store and settings file as `heavy`. Expected: `public` has its own volume (`public_n8n_data`) and its own service name (`public-n8n`). Asserted in Task 3.
3. **`heavy`'s encryption key.** Expected: `heavy` sets no `N8N_ENCRYPTION_KEY` and keeps the key already inside its volume, while `public` sets its own; the two differ. Asserted in Task 3.
4. **Postgres `init/` only runs on an empty data directory.** The `publishing_db_data` volume is already initialised, so nothing under `docker-entrypoint-initdb.d` will ever run again and the `whatsapp_access` database and role would never exist. Expected: an idempotent bootstrap one-shot creates them on an existing volume. Asserted in Task 3.
5. **`.gitignore` is scoped to `n8n/render-data/**`.** After the move, render output under `domains/short-videos/render-data/` becomes trackable and the next `git add -A` commits gigabytes of video. Expected: the ignore rules follow the directory. Asserted in Task 1.

## File Structure

### Moved (via `git mv`, contents unchanged unless noted)

| From | To |
|---|---|
| `n8n/Dockerfile` | `hosts/heavy/Dockerfile` |
| `n8n/runners/` | `hosts/heavy/runners/` |
| `n8n/AWS-DEPLOY.md` | `hosts/AWS-DEPLOY.md` |
| `n8n/.env.example` | `hosts/.env.example` |
| `n8n/postgres/run-migrations.sh` | `hosts/shared/postgres/run-migrations.sh` |
| `n8n/postgres/init/` | `domains/short-videos/postgres/init/` |
| `n8n/postgres/migrations/` | `domains/short-videos/postgres/migrations/` |
| `n8n/postgres/queries/` | `domains/short-videos/postgres/queries/` |
| `n8n/workflows/` | `domains/short-videos/workflows/` |
| `n8n/workflow-code/` | `domains/short-videos/workflow-code/` |
| `n8n/provider-uploader/` | `domains/short-videos/services/provider-uploader/` |
| `n8n/render-data/` | `domains/short-videos/render-data/` |
| `lamba-function/handler.py` | `domains/short-videos/services/transcript/handler.py` |
| `lamba-function/build.sh` | `domains/short-videos/services/transcript/build.sh` (edited, Task 2) |
| `lamba-function/requirements.txt` | `domains/short-videos/services/transcript/requirements.txt` |
| `local-transcript-server.py` | `domains/short-videos/services/transcript/local-server.py` (edited) |
| `tests/test_handler.py` | `domains/short-videos/services/transcript/test_handler.py` (edited) |
| `transcript.py` | `domains/short-videos/scratch/transcript.py` |
| `docs/architecture.md`, `credentials-setup.md`, `google-sheets-structure.md`, `postgres-publishing-queue.md`, `postiz-publishing.md` | `domains/short-videos/docs/` |
| `tests/fixtures/` and all `tests/*.test.js` except `runtime-config.test.js` | `domains/short-videos/tests/` |

`docs/superpowers/` stays at the repo root — it is process documentation, not domain content.

### Created

| Path | Responsibility |
|---|---|
| `hosts/compose.local.yaml` | Dev composition: `include`s the host files, adds `jaeger`, pins `name: n8n` |
| `hosts/compose.prod.yaml` | Prod composition: `include`s the host files plus `shared/traefik`, pins `name: n8n` |
| `hosts/heavy/compose.yaml` | `n8n` (custom image), `task-runners`, `provider-uploader` |
| `hosts/public/compose.yaml` | `public-n8n` (stock image), its own volume and Traefik labels |
| `hosts/shared/postgres/compose.yaml` | `postgres`, `postgres-bootstrap`, `short-videos-migrations`, `whatsapp-access-migrations` |
| `hosts/shared/postgres/bootstrap-databases.sh` | Idempotent `CREATE ROLE` / `CREATE DATABASE` / `REVOKE CONNECT` |
| `hosts/shared/traefik/compose.yaml` | `traefik` (from `n8n/compose.prod.yaml`) |
| `domains/short-videos/domain.json` | Manifest: host, database, mounts |
| `domains/whatsapp-access/domain.json` | Same shape, empty pipeline |
| `domains/whatsapp-access/postgres/migrations/.gitkeep` | Empty migrations dir the runner points at |
| `tests/repo-layout.test.js` | Asserts the target tree exists and the old paths are gone |
| `tests/hosts-compose.test.js` | Asserts project name, volume names, mounts, limits, trust boundary |

### Deleted

| Path | Why |
|---|---|
| `n8n/compose.local.yaml`, `n8n/compose.prod.yaml` | Replaced by the `hosts/` files |
| `transcript.txt` | 262 KB of regenerable output, referenced by nothing |
| `requirements.txt` (root) | Folded into the transcript service's own |
| `lamba-function/` vendored deps + `function.zip` | Untracked in Task 2; `build.sh` regenerates them |

---

### Task 1: The big-bang move

One commit. Everything relocates, every host-side reference is rewritten, the test suite returns to 213 passing, and the stack comes up on its existing volumes.

**Files:**
- Create: `tests/repo-layout.test.js`, `hosts/compose.local.yaml`, `hosts/compose.prod.yaml`, `hosts/heavy/compose.yaml`, `hosts/shared/traefik/compose.yaml`, `hosts/shared/postgres/compose.yaml`, `domains/short-videos/domain.json`
- Move: the whole "Moved" table above
- Modify: `package.json`, `.gitignore`, `scripts/discover-moments.js:21`, `tests/runtime-config.test.js`, and the 20 requires + 21 string literals listed in the steps
- Delete: `n8n/compose.local.yaml`, `n8n/compose.prod.yaml`, `transcript.txt`, root `requirements.txt`

**Interfaces:**
- Consumes: nothing. First task.
- Produces:
  - `hosts/compose.local.yaml` and `hosts/compose.prod.yaml`, both declaring `name: n8n`, both using `include:` with paths relative to `hosts/`.
  - Compose service names `n8n`, `task-runners`, `provider-uploader`, `postgres`, `postgres-bootstrap`, `short-videos-migrations`, `traefik`, `jaeger`.
  - Compose volume names `n8n_data`, `publishing_db_data`, `jaeger_data`, `traefik_data`.
  - Env var names `HEAVY_BIND_ADDRESS`, `HEAVY_PORT`, `HEAVY_CONCURRENCY`, `POSTGRES_BIND_ADDRESS`, `PUBLISHING_DB_NAME`, `PUBLISHING_DB_USER`, `PUBLISHING_DB_PASSWORD`, `PUBLISHING_DB_PORT`, `N8N_VERSION`, `SUBDOMAIN`, `DOMAIN_NAME`, `SSL_EMAIL`, `GENERIC_TIMEZONE`.
  - `npm test` script: `node --test "tests/*.test.js" "domains/*/tests/*.test.js"`.
  - In moved domain tests, the path base constant is named `domainRoot` and resolves to `domains/short-videos`.

- [ ] **Step 1: Write the failing layout test**

Create `tests/repo-layout.test.js`:

```js
'use strict';

const assert = require('node:assert/strict');
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
  assert.doesNotMatch(ignore, /n8n\/render-data/);
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npm test -- --test-name-pattern="runtime lives under hosts"`
Expected: FAIL — `missing hosts/compose.local.yaml`.

- [ ] **Step 3: Move the runtime into `hosts/`**

```bash
cd /home/leon/projects/short-videos
mkdir -p hosts/heavy hosts/public hosts/shared/postgres hosts/shared/traefik
git mv n8n/Dockerfile hosts/heavy/Dockerfile
git mv n8n/runners hosts/heavy/runners
git mv n8n/AWS-DEPLOY.md hosts/AWS-DEPLOY.md
git mv n8n/.env.example hosts/.env.example
git mv n8n/postgres/run-migrations.sh hosts/shared/postgres/run-migrations.sh
```

- [ ] **Step 4: Move the short-videos domain content**

```bash
cd /home/leon/projects/short-videos
mkdir -p domains/short-videos/services domains/short-videos/scratch domains/short-videos/docs
git mv n8n/postgres domains/short-videos/postgres
git mv n8n/workflows domains/short-videos/workflows
git mv n8n/workflow-code domains/short-videos/workflow-code
git mv n8n/provider-uploader domains/short-videos/services/provider-uploader
git mv n8n/render-data domains/short-videos/render-data
git mv docs/architecture.md docs/credentials-setup.md docs/google-sheets-structure.md \
       docs/postgres-publishing-queue.md docs/postiz-publishing.md \
       domains/short-videos/docs/
mkdir -p domains/short-videos/tests
git mv tests/fixtures domains/short-videos/tests/fixtures
for t in ai-transcript-analysis channel-health-check fair-share moment-discovery \
         postiz-postgres-integration postiz-publishing provider-uploader-sidecar \
         publishing-postgres remaining-workflows transcript-fetch validity-check \
         video-fetch workflow-generator-hardening workflow-sheets-execute-once \
         youtube-channel-engagement youtube-url-resolver; do
  git mv "tests/$t.test.js" "domains/short-videos/tests/$t.test.js"
done
```

`tests/runtime-config.test.js` deliberately stays at the repo root: it asserts host runtime configuration, not domain content.

- [ ] **Step 5: Move the Python files and delete the dead ones**

```bash
cd /home/leon/projects/short-videos
mkdir -p domains/short-videos/services/transcript
git mv lamba-function/handler.py domains/short-videos/services/transcript/handler.py
git mv lamba-function/build.sh domains/short-videos/services/transcript/build.sh
git mv lamba-function/requirements.txt domains/short-videos/services/transcript/requirements.txt
git mv local-transcript-server.py domains/short-videos/services/transcript/local-server.py
git mv tests/test_handler.py domains/short-videos/services/transcript/test_handler.py
git mv transcript.py domains/short-videos/scratch/transcript.py
git rm -q transcript.txt requirements.txt
# the vendored deps and the built zip move as-is here; Task 2 untracks them
git mv lamba-function domains/short-videos/services/transcript/vendor-staging
```

The root `requirements.txt` held only `youtube-transcript-api`, which the service's own `requirements.txt` already lists, so nothing is lost.

- [ ] **Step 6: Flatten the staged vendor directory**

```bash
cd /home/leon/projects/short-videos/domains/short-videos/services/transcript
git mv vendor-staging/* . 2>/dev/null || true
for hidden in vendor-staging/.*; do
  case "$(basename "$hidden")" in .|..) continue;; esac
  git mv "$hidden" . 2>/dev/null || true
done
rmdir vendor-staging 2>/dev/null || true
cd /home/leon/projects/short-videos
git status --short | head -5
```

Expected: `lamba-function/` no longer exists and `git ls-files domains/short-videos/services/transcript | wc -l` reports 289.

- [ ] **Step 7: Point `local-server.py` and `test_handler.py` at the new `handler.py`**

`local-server.py` currently resolves `handler.py` through `Path("lamba-function")`, relative to the process working directory. `handler.py` now sits beside it, so resolve it from the file instead.

In `domains/short-videos/services/transcript/local-server.py`, replace:

```python
parser = argparse.ArgumentParser(description="Local transcript service (wraps lamba-function/handler.py)")
```

with:

```python
parser = argparse.ArgumentParser(description="Local transcript service (wraps handler.py beside this file)")
```

and replace:

```python
sys.path.insert(0, str(Path("lamba-function").resolve()))
```

with:

```python
# handler.py and its vendored deps sit in this same directory, so the server runs
# from any working directory.
sys.path.insert(0, str(Path(__file__).resolve().parent))
```

In `domains/short-videos/services/transcript/test_handler.py`, replace:

```python
# handler.py lives in lamba-function/ next to the vendored deps
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "lamba-function"))
```

with:

```python
# handler.py sits in this same directory, next to the vendored deps
sys.path.insert(0, str(Path(__file__).resolve().parent))
```

- [ ] **Step 8: Rewrite the 20 `require('../n8n/...')` paths**

Every moved domain test is now one level under `domains/short-videos/`, so `../n8n/workflow-code/x` becomes `../workflow-code/x` and `../n8n/workflows/x.json` becomes `../workflows/x.json`.

```bash
cd /home/leon/projects/short-videos
sed -i "s#\.\./n8n/workflow-code/#../workflow-code/#g; s#\.\./n8n/workflows/#../workflows/#g; s#\.\./n8n/provider-uploader/#../services/provider-uploader/#g" domains/short-videos/tests/*.test.js
grep -rn "\.\./n8n/" domains/short-videos/tests/ && echo "LEFTOVERS" || echo "clean"
```

Expected: `clean`.

Then fix `scripts/discover-moments.js:21`, which sits at the repo root in `scripts/`:

```bash
sed -i "s#require('\.\./n8n/workflow-code/moment-discovery')#require('../domains/short-videos/workflow-code/moment-discovery')#" scripts/discover-moments.js
```

- [ ] **Step 9: Rewrite the 21 `'n8n/...'` string literals**

These resolve against a `repoRoot` constant (`path.resolve(__dirname, '..')`). From the new test location that constant now points at `domains/short-videos`, so rename it to `domainRoot` and drop the `n8n/` prefix from the literals.

```bash
cd /home/leon/projects/short-videos/domains/short-videos/tests
sed -i "s#const repoRoot = path.resolve(__dirname, '\.\.');#const domainRoot = path.resolve(__dirname, '..');#" publishing-postgres.test.js workflow-generator-hardening.test.js
sed -i "s#path.join(repoRoot, #path.join(domainRoot, #g" publishing-postgres.test.js workflow-generator-hardening.test.js
sed -i "s#\bn8n/postgres/#postgres/#g; s#\bn8n/workflow-code/#workflow-code/#g; s#\bn8n/workflows/#workflows/#g" \
  publishing-postgres.test.js postiz-postgres-integration.test.js postiz-publishing.test.js \
  ai-transcript-analysis.test.js workflow-generator-hardening.test.js
grep -rn "'n8n/\|\"n8n/\|\`n8n/\|repoRoot" . && echo "LEFTOVERS" || echo "clean"
```

Expected: `clean`. Note `postiz-postgres-integration.test.js` names its constant `root`, not `repoRoot`; `root` already resolves to `path.resolve(__dirname, '..')` and so now points at the domain root, which is correct — only its literals change.

`postiz-publishing.test.js:171` reads `n8n/workflows/14-publishing-retry-scheduler.json` with a bare working-directory-relative path and no base constant. Replace that one line explicitly:

```js
  const retry = JSON.parse(fs.readFileSync(require.resolve('../workflows/14-publishing-retry-scheduler.json'), 'utf8'));
```

- [ ] **Step 10: Move the compose assertion out of `publishing-postgres.test.js`**

That test asserted on `n8n/compose.local.yaml`, which no longer exists and is host configuration rather than domain content. Delete the whole `test('compose starts a healthy local publishing database with durable storage', ...)` block from `domains/short-videos/tests/publishing-postgres.test.js` (it is the block asserting `publishing-db:`, `postgres:16-alpine`, `pg_isready`, `publishing_db_data:/var/lib/postgresql/data`, the init mount, `publishing-migrations:` and `provider-uploader:`), and replace the whole of `tests/runtime-config.test.js` with:

```js
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const repoRoot = path.resolve(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');

test('heavy mounts the domain render data at /data for n8n and the task runners', () => {
  const compose = read('hosts/heavy/compose.yaml');
  const section = (name) =>
    compose.split(new RegExp(`\\n  ${name}:\\n`))[1]?.split(/\n  [a-zA-Z0-9_-]+:\n/)[0] || '';

  assert.match(section('task-runners'), /- \.\.\/\.\.\/domains\/short-videos\/render-data:\/data/);
  assert.match(section('n8n'), /- \.\.\/\.\.\/domains\/short-videos\/render-data:\/data/);
  assert.match(section('n8n'), /- \.\.\/\.\.\/domains\/short-videos\/local-files:\/files/);
  assert.match(section('provider-uploader'), /- \.\.\/\.\.\/domains\/short-videos\/render-data:\/data:ro/);
});

test('the publishing database keeps its volume, health check and migration runner', () => {
  const compose = read('hosts/shared/postgres/compose.yaml');

  assert.match(compose, /image: postgres:16-alpine/);
  assert.match(compose, /pg_isready/);
  assert.match(compose, /publishing_db_data:\/var\/lib\/postgresql\/data/);
  assert.match(compose, /\.\.\/\.\.\/\.\.\/domains\/short-videos\/postgres\/init:\/docker-entrypoint-initdb\.d:ro/);
  assert.match(compose, /short-videos-migrations:/);
  assert.match(compose, /condition: service_completed_successfully/);
  assert.match(compose, /condition: service_healthy/);
});

test('both compositions pin the compose project name so the existing volumes are reused', () => {
  for (const file of ['hosts/compose.local.yaml', 'hosts/compose.prod.yaml']) {
    assert.match(read(file), /^name: n8n$/m, `${file} must pin name: n8n`);
  }
});

test('heavy keeps executeCommand, blocks localFileTrigger, and bounds concurrency', () => {
  const compose = read('hosts/heavy/compose.yaml');

  assert.match(compose, /NODES_EXCLUDE=\[\\"n8n-nodes-base\.localFileTrigger\\"\]/);
  assert.doesNotMatch(compose, /n8n-nodes-base\.executeCommand/);
  assert.match(compose, /N8N_CONCURRENCY_PRODUCTION_LIMIT=\$\{HEAVY_CONCURRENCY:-2\}/);
  assert.match(compose, /N8N_RESTRICT_FILE_ACCESS_TO=\/data;\/files/);
  assert.match(compose, /N8N_DEFAULT_BINARY_DATA_MODE=filesystem/);
  assert.doesNotMatch(compose, /N8N_AVAILABLE_BINARY_DATA_MODES/);
});

test('heavy never pins an encryption key, so the key inside its volume keeps working', () => {
  assert.doesNotMatch(read('hosts/heavy/compose.yaml'), /N8N_ENCRYPTION_KEY/);
});
```

- [ ] **Step 11: Write `hosts/shared/postgres/compose.yaml`**

```yaml
# One Postgres server, one database and role per domain. Paths are relative to
# this file's directory: Compose resolves an included file's relative paths
# against that file, not against the composition that includes it.
services:
  postgres:
    image: postgres:16-alpine
    restart: unless-stopped
    mem_limit: 512m
    environment:
      POSTGRES_DB: ${PUBLISHING_DB_NAME:-short_videos}
      POSTGRES_USER: ${PUBLISHING_DB_USER:-short_videos}
      POSTGRES_PASSWORD: ${PUBLISHING_DB_PASSWORD:-local-publishing-password-change-me}
    ports:
      - "${POSTGRES_BIND_ADDRESS:-127.0.0.1}:${PUBLISHING_DB_PORT:-5433}:5432"
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U $${POSTGRES_USER} -d $${POSTGRES_DB}"]
      interval: 5s
      timeout: 5s
      retries: 12
      start_period: 10s
    volumes:
      - publishing_db_data:/var/lib/postgresql/data
      # Only ever runs on a fresh data directory. The bootstrap service below is
      # what reaches an already-initialised volume.
      - ../../../domains/short-videos/postgres/init:/docker-entrypoint-initdb.d:ro

  short-videos-migrations:
    image: postgres:16-alpine
    restart: "no"
    environment:
      DATABASE_URL: postgresql://${PUBLISHING_DB_USER:-short_videos}:${PUBLISHING_DB_PASSWORD:-local-publishing-password-change-me}@postgres:5432/${PUBLISHING_DB_NAME:-short_videos}
    command: ["/run-migrations.sh"]
    volumes:
      - ./run-migrations.sh:/run-migrations.sh:ro
      - ../../../domains/short-videos/postgres/migrations:/migrations:ro
    depends_on:
      postgres:
        condition: service_healthy

volumes:
  publishing_db_data:
```

`postgres-bootstrap` and `whatsapp-access-migrations` are added in Task 3, with the database and role they depend on.

- [ ] **Step 12: Write `hosts/heavy/compose.yaml`**

```yaml
# Trusted host: self-triggered work that needs shell access (yt-dlp in WF6,
# ffmpeg in WF8c). Environment differences between local and prod come from
# hosts/.env, never from a second copy of these service definitions.
services:
  provider-uploader:
    build:
      context: ../../domains/short-videos/services/provider-uploader
    image: short-videos/provider-uploader:local
    restart: unless-stopped
    mem_limit: 256m
    environment:
      - PORT=8080
      - PROVIDER_TIMEOUT_MS=1800000
    volumes:
      - ../../domains/short-videos/render-data:/data:ro

  n8n:
    build:
      context: .
      dockerfile: Dockerfile
      args:
        N8N_VERSION: ${N8N_VERSION:-2.25.7}
    image: short-videos/n8n-ffmpeg:${N8N_VERSION:-2.25.7}
    restart: unless-stopped
    # ffmpeg runs in this container. A runaway render dies here instead of
    # leaving the kernel OOM killer to pick a victim on a 4 GB box.
    mem_limit: 1g
    # Locally this is 127.0.0.1. In prod HEAVY_BIND_ADDRESS is the host's
    # Tailscale address: this editor can create an Execute Command node, so it
    # is deliberately not reachable from the internet and has no Traefik router.
    ports:
      - "${HEAVY_BIND_ADDRESS:-127.0.0.1}:${HEAVY_PORT:-5678}:5678"
    environment:
      - N8N_ENFORCE_SETTINGS_FILE_PERMISSIONS=true
      # No N8N_ENCRYPTION_KEY here on purpose. The n8n_data volume already holds
      # a generated key in /home/node/.n8n/config; pinning a different value
      # makes every stored credential undecryptable.
      #
      # n8n 2.0+ blocks executeCommand and localFileTrigger by default. WF6
      # (yt-dlp) and WF8c (FFmpeg) need executeCommand, so narrow the blocklist to
      # keep localFileTrigger blocked rather than clearing it entirely.
      # Single-tenant only — executeCommand runs arbitrary shell in this container,
      # which can read every mounted volume and every env var here.
      - "NODES_EXCLUDE=[\"n8n-nodes-base.localFileTrigger\"]"
      # n8n 2.x defaults N8N_RESTRICT_FILE_ACCESS_TO to "~/.n8n-files", which blocks
      # readWriteFile nodes from writing/reading the /data render volume ("... is not
      # writable"). Scope allowed file access to the mounted work dirs instead.
      - N8N_RESTRICT_FILE_ACCESS_TO=/data;/files
      # Provider uploads can be hundreds of MB. Keep workflow binary payloads
      # on the durable n8n volume instead of retaining them in process memory.
      - N8N_DEFAULT_BINARY_DATA_MODE=filesystem
      # Concurrent ffmpeg renders are the specific thing to avoid on 4 GB.
      - N8N_CONCURRENCY_PRODUCTION_LIMIT=${HEAVY_CONCURRENCY:-2}
      - N8N_RUNNERS_MODE=external
      - N8N_RUNNERS_BROKER_LISTEN_ADDRESS=0.0.0.0
      - N8N_RUNNERS_AUTH_TOKEN=${N8N_RUNNERS_AUTH_TOKEN:-local-dev-task-runner-token-change-me}
      - N8N_NATIVE_PYTHON_RUNNER=true
      - N8N_HOST=${HEAVY_N8N_HOST:-localhost}
      - N8N_PORT=5678
      - N8N_PROTOCOL=${HEAVY_N8N_PROTOCOL:-http}
      - N8N_SECURE_COOKIE=${HEAVY_SECURE_COOKIE:-false}
      - WEBHOOK_URL=${HEAVY_WEBHOOK_URL:-http://localhost:5678/}
      - NODE_ENV=${NODE_ENV:-development}
      - N8N_METRICS=true
      - N8N_DIAGNOSTICS_ENABLE=false
      - N8N_VERSION_NOTIFICATION_ENABLED=false
      - N8N_LOG_LEVEL=${N8N_LOG_LEVEL:-debug}
      - N8N_OTEL_ENABLED=${N8N_OTEL_ENABLED:-false}
      - N8N_OTEL_TRACES_PRODUCTION_ONLY=false
      - N8N_OTEL_EXPORTER_OTLP_ENDPOINT=${N8N_OTEL_EXPORTER_OTLP_ENDPOINT:-http://host.docker.internal:4318/}
      - EXECUTIONS_DATA_PRUNE=true
      - EXECUTIONS_DATA_MAX_AGE=${EXECUTIONS_DATA_MAX_AGE:-336}
      - EXECUTIONS_DATA_PRUNE_MAX_COUNT=${EXECUTIONS_DATA_PRUNE_MAX_COUNT:-10000}
      - GENERIC_TIMEZONE=${GENERIC_TIMEZONE:-Africa/Nairobi}
      - TZ=${GENERIC_TIMEZONE:-Africa/Nairobi}
    volumes:
      - n8n_data:/home/node/.n8n
      - ../../domains/short-videos/local-files:/files
      - ../../domains/short-videos/render-data:/data
    depends_on:
      postgres:
        condition: service_healthy
      short-videos-migrations:
        condition: service_completed_successfully
      provider-uploader:
        condition: service_healthy

  task-runners:
    build:
      context: ./runners
      args:
        N8N_VERSION: ${N8N_VERSION:-2.25.7}
    image: short-videos/n8n-runners:${N8N_VERSION:-2.25.7}
    restart: unless-stopped
    mem_limit: 512m
    environment:
      - N8N_RUNNERS_TASK_BROKER_URI=http://n8n:5679
      - N8N_RUNNERS_AUTH_TOKEN=${N8N_RUNNERS_AUTH_TOKEN:-local-dev-task-runner-token-change-me}
      - N8N_RUNNERS_AUTO_SHUTDOWN_TIMEOUT=0
    volumes:
      - ../../domains/short-videos/render-data:/data
    depends_on:
      - n8n

volumes:
  n8n_data:
```

`depends_on: postgres` and `short-videos-migrations` resolve because both are in the same merged project — `hosts/compose.local.yaml` and `hosts/compose.prod.yaml` always include `shared/postgres/compose.yaml`.

- [ ] **Step 13: Write `hosts/shared/traefik/compose.yaml`**

Lifted from `n8n/compose.prod.yaml`, unchanged except that it no longer carries an n8n service.

```yaml
services:
  traefik:
    image: "traefik"
    restart: always
    command:
      - "--api.insecure=true"
      - "--providers.docker=true"
      - "--providers.docker.exposedbydefault=false"
      - "--entrypoints.web.address=:80"
      - "--entrypoints.web.http.redirections.entryPoint.to=websecure"
      - "--entrypoints.web.http.redirections.entrypoint.scheme=https"
      - "--entrypoints.websecure.address=:443"
      - "--certificatesresolvers.mytlschallenge.acme.tlschallenge=true"
      - "--certificatesresolvers.mytlschallenge.acme.email=${SSL_EMAIL}"
      - "--certificatesresolvers.mytlschallenge.acme.storage=/letsencrypt/acme.json"
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - traefik_data:/letsencrypt
      - /var/run/docker.sock:/var/run/docker.sock:ro

volumes:
  traefik_data:
```

- [ ] **Step 14: Write the two compositions**

`hosts/compose.local.yaml`:

```yaml
# Pinned so the project keeps the name it had when the compose file lived in
# n8n/. Without this the volumes become hosts_n8n_data and
# hosts_publishing_db_data — empty, and every workflow looks lost.
name: n8n

include:
  - path: ./shared/postgres/compose.yaml
  - path: ./heavy/compose.yaml

services:
  jaeger:
    image: jaegertracing/jaeger:latest
    mem_limit: 512m
    ports:
      - "127.0.0.1:16686:16686" # UI
      - "127.0.0.1:4317:4317"   # OTLP gRPC
      - "127.0.0.1:4318:4318"   # OTLP HTTP

volumes:
  jaeger_data:
```

`hosts/compose.prod.yaml`:

```yaml
name: n8n

include:
  - path: ./shared/postgres/compose.yaml
  - path: ./shared/traefik/compose.yaml
  - path: ./heavy/compose.yaml
```

`hosts/public/compose.yaml` is added to both in Task 3, together with the service itself.

- [ ] **Step 15: Write the domain manifests and the whatsapp scaffolding**

`domains/short-videos/domain.json`:

```json
{
  "name": "short-videos",
  "description": "Short-form video pipeline: discovery, transcript, AI moment selection, render, publish.",
  "host": "heavy",
  "database": "short_videos",
  "mounts": [
    { "host": "domains/short-videos/render-data", "container": "/data" },
    { "host": "domains/short-videos/local-files", "container": "/files" }
  ],
  "services": ["provider-uploader", "transcript"],
  "workflows": "domains/short-videos/workflows"
}
```

`domains/whatsapp-access/domain.json`:

```json
{
  "name": "whatsapp-access",
  "description": "Payment-gated WhatsApp group access. Structure only; no automation logic yet.",
  "host": "public",
  "database": "whatsapp_access",
  "mounts": [],
  "services": [],
  "workflows": "domains/whatsapp-access/workflows"
}
```

```bash
cd /home/leon/projects/short-videos
mkdir -p domains/whatsapp-access/postgres/migrations
touch domains/whatsapp-access/postgres/migrations/.gitkeep
```

This manifest is documentation. No tooling reads it beyond `tests/repo-layout.test.js` checking its shape.

- [ ] **Step 16: Update `package.json` and `.gitignore`**

`package.json`:

```json
{
  "name": "automations",
  "version": "0.1.0",
  "private": true,
  "description": "Multi-domain n8n automation monorepo (hosts + domains)",
  "scripts": {
    "channel:engagement": "node scripts/youtube-channel-engagement.js",
    "test": "node --test \"tests/*.test.js\" \"domains/*/tests/*.test.js\""
  }
}
```

The spec's migration step 4 named only `domains/*/tests/*.test.js`. The repo-level `tests/` glob is kept alongside it so host-level and layout tests have a home that is not inside a domain.

`.gitignore` — replace the two stale blocks:

```gitignore
# Render runtime data for the short-videos domain
domains/short-videos/render-data/**
!domains/short-videos/render-data/**/
!domains/short-videos/render-data/**/.gitkeep
!domains/short-videos/render-data/.gitkeep
reports/

# Local host configuration and runtime state
hosts/.env
domains/short-videos/local-files/
hosts/heavy/.n8n/
```

- [ ] **Step 17: Update the documentation paths**

```bash
cd /home/leon/projects/short-videos/domains/short-videos/docs
sed -i "s#n8n/Dockerfile#hosts/heavy/Dockerfile#g; \
        s#n8n/postgres/#domains/short-videos/postgres/#g; \
        s#n8n/workflow-code/#domains/short-videos/workflow-code/#g; \
        s#n8n/compose.local.yaml#hosts/compose.local.yaml#g; \
        s#n8n/\.env#hosts/.env#g" *.md
cd /home/leon/projects/short-videos/hosts
sed -i "s#The \`n8n/\` directory from this repo (\`compose.prod.yaml\`, \`.env.example\`, \`local-files/\`)#The \`hosts/\` and \`domains/\` directories from this repo (\`hosts/compose.prod.yaml\`, \`hosts/.env.example\`)#; \
        s#scp -r n8n/ ubuntu@<elastic-ip>:~/n8n-compose#scp -r hosts/ domains/ ubuntu@<elastic-ip>:~/automations#; \
        s#docker compose -f compose.prod.yaml exec n8n#docker compose -f hosts/compose.prod.yaml exec n8n#" AWS-DEPLOY.md
cd /home/leon/projects/short-videos
grep -rn "n8n/compose\|n8n/postgres\|n8n/workflow" domains/short-videos/docs hosts/*.md && echo "LEFTOVERS" || echo "clean"
```

Expected: `clean`.

- [ ] **Step 18: Run the full suite**

Run: `npm test`
Expected: `pass 213` from the new layout — the 206 moved domain tests, the 5 in `tests/runtime-config.test.js`, and the compose test relocated from `publishing-postgres.test.js`, plus the 7 in `tests/repo-layout.test.js`. If the total differs from 213 plus the newly written tests, a path rewrite was missed; `npm test` names the failing file.

- [ ] **Step 19: Verify Compose resolves and the volumes are the existing ones**

```bash
cd /home/leon/projects/short-videos
docker compose -f hosts/compose.local.yaml config > /tmp/local.yaml
docker compose -f hosts/compose.prod.yaml config > /tmp/prod.yaml
grep -E "^name:|publishing_db_data|n8n_data" /tmp/local.yaml | sort -u
grep -c "source: /home/leon/projects/short-videos/domains/short-videos/render-data" /tmp/local.yaml
docker volume ls --format '{{.Name}}' | grep -E '^n8n_(n8n_data|publishing_db_data)$'
```

Expected: `name: n8n` in both; `source:` paths under `/home/leon/projects/short-videos/domains/short-videos/render-data` (3 occurrences — n8n, task-runners, provider-uploader), confirming that an included file's relative paths resolve against its own directory; and the two pre-existing volumes listed.

- [ ] **Step 20: Verify history survived the move**

```bash
cd /home/leon/projects/short-videos
git add -A
git log --follow --oneline -- domains/short-videos/workflow-code/postiz-publishing.js | head -5
git log --follow --oneline -- domains/short-videos/services/transcript/handler.py | head -5
```

Expected: commits predating this branch in both listings.

- [ ] **Step 21: Commit**

```bash
cd /home/leon/projects/short-videos
git add -A
git commit -m "$(cat <<'MSG'
refactor: split the repo into hosts/ and domains/

Runtime moves to hosts/heavy/ (custom n8n image, task runners,
provider-uploader) and hosts/shared/ (postgres, traefik). All short-form
video content moves to domains/short-videos/, including the two Python
services that lived at the repo root.

Compose is restructured into per-host files composed with include:. Both
compositions pin `name: n8n` so the existing n8n_n8n_data and
n8n_publishing_db_data volumes are reused — no re-import and no
credential re-entry. heavy sets no N8N_ENCRYPTION_KEY, keeping the key
already inside its volume. compose.prod.yaml now carries the publishing
queue, task runners and provider-uploader, which it never had.

Workflow JSON and SQL contents are unchanged; only their paths move.
transcript.txt (262 KB of regenerable output) and the root
requirements.txt (a subset of the transcript service's own) are deleted.
MSG
)"
```

---

### Task 2: The Lambda build becomes reproducible

**Files:**
- Modify: `domains/short-videos/services/transcript/build.sh`, `.gitignore`
- Create: `domains/short-videos/services/transcript/README.md`
- Delete from the index: the 286 vendored dependency files and `function.zip`

**Interfaces:**
- Consumes: `domains/short-videos/services/transcript/{handler.py,build.sh,requirements.txt}` from Task 1.
- Produces: `build.sh` that installs from `requirements.txt` into its own directory before zipping; `.gitignore` rules that untrack the installed deps and `function.zip`.

- [ ] **Step 1: Write the failing test**

Append to `tests/repo-layout.test.js`:

```js
test('the Lambda build is reproducible from requirements.txt, not from committed deps', () => {
  const service = 'domains/short-videos/services/transcript';
  const build = fs.readFileSync(path.join(repoRoot, service, 'build.sh'), 'utf8');

  assert.match(build, /pip install .*-r requirements\.txt .*-t \./);
  assert.match(build, /rm -f function\.zip/);
  // the zip must not swallow first-party sources that are not part of the Lambda
  for (const excluded of ['build.sh', 'function.zip', 'requirements.txt', 'test_handler.py', 'local-server.py', 'README.md']) {
    assert.ok(build.includes(`-x "${excluded}"`), `build.sh must exclude ${excluded}`);
  }

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
```

Add to the top of `tests/repo-layout.test.js`:

```js
const { execFileSync } = require('node:child_process');
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npm test -- --test-name-pattern="Lambda build is reproducible"`
Expected: FAIL — `build.sh` has no `pip install` line.

- [ ] **Step 3: Rewrite `build.sh`**

Replace `domains/short-videos/services/transcript/build.sh` entirely:

```bash
#!/usr/bin/env bash
# Build function.zip for AWS Lambda from requirements.txt and handler.py.
#
# The dependencies are NOT tracked in git: this script installs them into this
# directory on every build, which is what makes the artifact reproducible from a
# clean checkout. Everything it installs is gitignored.
set -euo pipefail

cd "$(dirname "$0")"

rm -f function.zip
python3 -m pip install --quiet --upgrade --target . -r requirements.txt

zip -qr function.zip . \
  -x "build.sh" \
  -x "function.zip" \
  -x "requirements.txt" \
  -x "README.md" \
  -x "local-server.py" \
  -x "test_handler.py" \
  -x "*.dist-info/*" \
  -x "bin/*" \
  -x "__pycache__/*" \
  -x "*/__pycache__/*"

python3 - <<'CHECK'
import zipfile
names = zipfile.ZipFile("function.zip").namelist()
assert "handler.py" in names, "handler.py missing from function.zip"
assert any(n.startswith("youtube_transcript_api/") for n in names), \
    "youtube_transcript_api missing from function.zip"
print(f"function.zip: {len(names)} entries")
CHECK

echo "Built: $(du -h function.zip | cut -f1)"
```

The self-check at the end is the difference between a zip that exists and a zip that works: a `pip install` that silently resolved nothing still produces a valid archive.

- [ ] **Step 4: Extend `.gitignore` and untrack the deps**

Append to `.gitignore`:

```gitignore
# The transcript Lambda installs its deps at build time (see build.sh), so the
# installed tree and the built artifact are not tracked.
domains/short-videos/services/transcript/function.zip
domains/short-videos/services/transcript/bin/
domains/short-videos/services/transcript/*.dist-info/
domains/short-videos/services/transcript/*.libs/
domains/short-videos/services/transcript/certifi/
domains/short-videos/services/transcript/charset_normalizer/
domains/short-videos/services/transcript/defusedxml/
domains/short-videos/services/transcript/idna/
domains/short-videos/services/transcript/requests/
domains/short-videos/services/transcript/urllib3/
domains/short-videos/services/transcript/youtube_transcript_api/
```

Then untrack everything except the six first-party files:

```bash
cd /home/leon/projects/short-videos
git ls-files domains/short-videos/services/transcript \
  | grep -vE '/(handler\.py|build\.sh|requirements\.txt|local-server\.py|test_handler\.py)$' \
  | xargs git rm -q --cached --
git ls-files domains/short-videos/services/transcript
```

Expected: exactly the five paths above (`README.md` is added next). `--cached` leaves the working-tree files in place; they are now ignored.

- [ ] **Step 5: Write the service README**

`domains/short-videos/services/transcript/README.md`:

```markdown
# Transcript service

`handler.py` is the single implementation of WF-04's transcript contract: it
fetches a YouTube transcript and checks the `x-api-key` header. Two things wrap
it, and neither is a fork of the other.

## AWS Lambda

```bash
./build.sh                  # installs deps from requirements.txt, writes function.zip
```

The dependencies and `function.zip` are gitignored. `build.sh` installs them
into this directory on every build, so the artifact is reproducible from a clean
checkout.

## Local HTTP server

```bash
python3 local-server.py --api-key local-dev --port 8787
```

Serves the same `handler.handler(event, None)` over HTTP for local WF-04
development. It resolves `handler.py` relative to its own file, so it runs from
any working directory — but it needs the dependencies present, which means
running `./build.sh` (or `pip install -r requirements.txt -t .`) first.

## Tests

```bash
python3 -m pytest domains/short-videos/services/transcript/test_handler.py
```

Not part of `npm test`, which runs only the Node suites.
```

- [ ] **Step 6: Verify the build works from a clean checkout**

```bash
cd /home/leon/projects/short-videos
git add -A
rm -rf /tmp/clean-build && git clone --no-hardlinks . /tmp/clean-build 2>/dev/null
cd /tmp/clean-build && git checkout -q "$(cd /home/leon/projects/short-videos && git rev-parse --abbrev-ref HEAD)" 2>/dev/null || true
ls domains/short-videos/services/transcript/
bash domains/short-videos/services/transcript/build.sh
```

Expected: the directory lists only the six first-party files before the build; `build.sh` prints `function.zip: <n> entries` with `n` in the hundreds, then `Built: ...`. This is the gate that proves the deleted deps were not load-bearing.

- [ ] **Step 7: Verify the local server still answers**

```bash
cd /home/leon/projects/short-videos/domains/short-videos/services/transcript
python3 local-server.py --api-key local-dev --port 8787 &
SERVER=$!
sleep 2
curl -s -X POST http://127.0.0.1:8787/ -H 'x-api-key: wrong-key' -d '{"video_id":"Pzfle5WWaTo"}'
echo
curl -s -X POST http://127.0.0.1:8787/ -H 'x-api-key: local-dev' -d '{"video_id":"Pzfle5WWaTo"}' | head -c 200
kill $SERVER
```

Expected: the wrong key returns a 401-shaped JSON body; the correct key returns a transcript payload (or a `youtube-transcript-api` upstream error, which still proves `handler.py` resolved and ran). Run it from a different directory too, to confirm the `sys.path` change made it working-directory independent:

```bash
cd / && python3 /home/leon/projects/short-videos/domains/short-videos/services/transcript/local-server.py --api-key local-dev --port 8788 &
sleep 2 && curl -s -X POST http://127.0.0.1:8788/ -H 'x-api-key: local-dev' -d '{"video_id":"Pzfle5WWaTo"}' | head -c 80; kill %1
```

- [ ] **Step 8: Run the Python tests**

Run: `python3 -m pytest domains/short-videos/services/transcript/test_handler.py -q`
Expected: PASS. If `pytest` is absent, `python3 -m pip install pytest` first.

- [ ] **Step 9: Run the full Node suite**

Run: `npm test`
Expected: PASS, including the two tests added in Step 1.

- [ ] **Step 10: Commit**

```bash
cd /home/leon/projects/short-videos
git add -A
git commit -m "$(cat <<'MSG'
build: make the transcript Lambda reproducible from requirements.txt

build.sh zipped the committed pip output, which made 286 vendored files
and function.zip load-bearing build inputs. It now installs from
requirements.txt into its own directory before zipping, and verifies that
handler.py and youtube_transcript_api made it into the archive.

The installed tree and function.zip are gitignored and untracked: 6.9 MB
and 286 files leave the repo, and the artifact is reproducible from a
clean checkout.
MSG
)"
```

---

### Task 3: The `public` host and its isolation

**Files:**
- Create: `hosts/public/compose.yaml`, `hosts/shared/postgres/bootstrap-databases.sh`, `tests/hosts-isolation.test.js`
- Modify: `hosts/shared/postgres/compose.yaml`, `hosts/compose.local.yaml`, `hosts/compose.prod.yaml`, `hosts/.env.example`

**Interfaces:**
- Consumes: from Task 1 — `hosts/compose.local.yaml` and `hosts/compose.prod.yaml` (both `name: n8n`, both using `include:`), `hosts/shared/postgres/compose.yaml` (service `postgres`, volume `publishing_db_data`), `hosts/heavy/compose.yaml` (service `n8n`, volume `n8n_data`).
- Produces: service `public-n8n`, volume `public_n8n_data`, one-shot services `postgres-bootstrap` and `whatsapp-access-migrations`, env vars `PUBLIC_BIND_ADDRESS`, `PUBLIC_PORT`, `PUBLIC_CONCURRENCY`, `PUBLIC_N8N_ENCRYPTION_KEY`, `PUBLIC_SUBDOMAIN`, `PUBLIC_TRAEFIK_ENABLE`, `WHATSAPP_DB_NAME`, `WHATSAPP_DB_USER`, `WHATSAPP_DB_PASSWORD`.

- [ ] **Step 1: Write the failing isolation test**

Create `tests/hosts-isolation.test.js`:

```js
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const repoRoot = path.resolve(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');

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
  const names = (compose) => [...compose.matchAll(/^  ([a-zA-Z0-9_-]+):$/gm)].map((m) => m[1]);
  const heavy = read('hosts/heavy/compose.yaml');
  const pub = read('hosts/public/compose.yaml');

  const overlap = names(heavy).filter((name) => names(pub).includes(name));
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
  assert.doesNotMatch(read('hosts/heavy/compose.yaml'), /traefik/i);
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
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npm test -- --test-name-pattern="public runs the stock image"`
Expected: FAIL — `ENOENT: hosts/public/compose.yaml`.

- [ ] **Step 3: Write `hosts/public/compose.yaml`**

```yaml
# Untrusted host: webhook-facing work. Stock n8n image, so there is no ffmpeg,
# no yt-dlp and no shell tooling in the container at all. NODES_EXCLUDE is left
# unset on purpose — n8n's default blocklist then blocks executeCommand and
# localFileTrigger. Setting the variable at all, even to [], unblocks them.
services:
  public-n8n:
    image: docker.io/n8nio/n8n:${N8N_VERSION:-2.25.7}
    restart: unless-stopped
    mem_limit: 512m
    ports:
      - "${PUBLIC_BIND_ADDRESS:-127.0.0.1}:${PUBLIC_PORT:-5679}:5678"
    labels:
      # This is the only instance Traefik exposes, and the only one that needs
      # to receive webhooks. heavy's editor has no router at all.
      - traefik.enable=${PUBLIC_TRAEFIK_ENABLE:-false}
      - traefik.http.routers.public-n8n.rule=Host(`${PUBLIC_SUBDOMAIN:-hooks}.${DOMAIN_NAME:-example.com}`)
      - traefik.http.routers.public-n8n.tls=true
      - traefik.http.routers.public-n8n.entrypoints=web,websecure
      - traefik.http.routers.public-n8n.tls.certresolver=mytlschallenge
      - traefik.http.services.public-n8n.loadbalancer.server.port=5678
      - traefik.http.middlewares.public-n8n.headers.SSLRedirect=true
      - traefik.http.middlewares.public-n8n.headers.STSSeconds=315360000
      - traefik.http.middlewares.public-n8n.headers.browserXSSFilter=true
      - traefik.http.middlewares.public-n8n.headers.contentTypeNosniff=true
      - traefik.http.middlewares.public-n8n.headers.forceSTSHeader=true
      - traefik.http.middlewares.public-n8n.headers.SSLHost=${DOMAIN_NAME:-example.com}
      - traefik.http.middlewares.public-n8n.headers.STSIncludeSubdomains=true
      - traefik.http.middlewares.public-n8n.headers.STSPreload=true
      - traefik.http.routers.public-n8n.middlewares=public-n8n@docker
    environment:
      - N8N_ENFORCE_SETTINGS_FILE_PERMISSIONS=true
      # A separate key is what makes credential separation real: public cannot
      # decrypt a video-pipeline credential even given the other volume.
      # Required, not defaulted — a shared default would defeat the point.
      - N8N_ENCRYPTION_KEY=${PUBLIC_N8N_ENCRYPTION_KEY:?set PUBLIC_N8N_ENCRYPTION_KEY in hosts/.env}
      - N8N_DEFAULT_BINARY_DATA_MODE=filesystem
      # Webhook handling is cheap but should not be unbounded on a 4 GB box.
      - N8N_CONCURRENCY_PRODUCTION_LIMIT=${PUBLIC_CONCURRENCY:-5}
      - N8N_HOST=${PUBLIC_N8N_HOST:-localhost}
      - N8N_PORT=5678
      - N8N_PROTOCOL=${PUBLIC_N8N_PROTOCOL:-http}
      - N8N_SECURE_COOKIE=${PUBLIC_SECURE_COOKIE:-false}
      - WEBHOOK_URL=${PUBLIC_WEBHOOK_URL:-http://localhost:5679/}
      - NODE_ENV=${NODE_ENV:-development}
      - N8N_METRICS=true
      - N8N_DIAGNOSTICS_ENABLE=false
      - N8N_VERSION_NOTIFICATION_ENABLED=false
      - N8N_LOG_LEVEL=${N8N_LOG_LEVEL:-debug}
      - EXECUTIONS_DATA_PRUNE=true
      - EXECUTIONS_DATA_MAX_AGE=${EXECUTIONS_DATA_MAX_AGE:-336}
      - EXECUTIONS_DATA_PRUNE_MAX_COUNT=${EXECUTIONS_DATA_PRUNE_MAX_COUNT:-10000}
      # The connection string cannot address the video database at all: this
      # role has no CONNECT privilege on it.
      - WHATSAPP_DATABASE_URL=postgresql://${WHATSAPP_DB_USER:-whatsapp_access}:${WHATSAPP_DB_PASSWORD:-local-whatsapp-password-change-me}@postgres:5432/${WHATSAPP_DB_NAME:-whatsapp_access}
      - GENERIC_TIMEZONE=${GENERIC_TIMEZONE:-Africa/Nairobi}
      - TZ=${GENERIC_TIMEZONE:-Africa/Nairobi}
    volumes:
      - public_n8n_data:/home/node/.n8n
    depends_on:
      postgres:
        condition: service_healthy
      whatsapp-access-migrations:
        condition: service_completed_successfully

volumes:
  public_n8n_data:
```

- [ ] **Step 4: Write `hosts/shared/postgres/bootstrap-databases.sh`**

```sh
#!/bin/sh
# Create each domain's role and database, and fence them off from each other.
#
# postgres/init/ only ever runs on an empty data directory, and
# publishing_db_data was initialised long ago. This runs on every Compose start
# instead, and is idempotent.
set -eu

psql "$ADMIN_URL" -v ON_ERROR_STOP=1 <<SQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${WHATSAPP_DB_USER}') THEN
    CREATE ROLE "${WHATSAPP_DB_USER}" LOGIN PASSWORD '${WHATSAPP_DB_PASSWORD}';
  ELSE
    ALTER ROLE "${WHATSAPP_DB_USER}" LOGIN PASSWORD '${WHATSAPP_DB_PASSWORD}';
  END IF;
END
\$\$;

SELECT 'CREATE DATABASE "${WHATSAPP_DB_NAME}" OWNER "${WHATSAPP_DB_USER}"'
 WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = '${WHATSAPP_DB_NAME}')\gexec

-- Separation is structural, not a GRANT to maintain: public's role has no
-- CONNECT privilege on the video database, so its connection string cannot
-- address it.
REVOKE CONNECT ON DATABASE "${VIDEO_DB_NAME}" FROM PUBLIC;
REVOKE ALL ON DATABASE "${VIDEO_DB_NAME}" FROM "${WHATSAPP_DB_USER}";
SQL

echo "bootstrap: ${VIDEO_DB_NAME} fenced, ${WHATSAPP_DB_NAME} owned by ${WHATSAPP_DB_USER}"
```

```bash
chmod +x /home/leon/projects/short-videos/hosts/shared/postgres/bootstrap-databases.sh
```

- [ ] **Step 5: Add the bootstrap and whatsapp migration services**

Insert into `hosts/shared/postgres/compose.yaml`, after the `postgres` service and before `short-videos-migrations`:

```yaml
  postgres-bootstrap:
    image: postgres:16-alpine
    restart: "no"
    environment:
      PGPASSWORD: ${PUBLISHING_DB_PASSWORD:-local-publishing-password-change-me}
      ADMIN_URL: postgresql://${PUBLISHING_DB_USER:-short_videos}@postgres:5432/${PUBLISHING_DB_NAME:-short_videos}
      VIDEO_DB_NAME: ${PUBLISHING_DB_NAME:-short_videos}
      WHATSAPP_DB_NAME: ${WHATSAPP_DB_NAME:-whatsapp_access}
      WHATSAPP_DB_USER: ${WHATSAPP_DB_USER:-whatsapp_access}
      WHATSAPP_DB_PASSWORD: ${WHATSAPP_DB_PASSWORD:-local-whatsapp-password-change-me}
    command: ["/bootstrap-databases.sh"]
    volumes:
      - ./bootstrap-databases.sh:/bootstrap-databases.sh:ro
    depends_on:
      postgres:
        condition: service_healthy
```

and after `short-videos-migrations`:

```yaml
  whatsapp-access-migrations:
    image: postgres:16-alpine
    restart: "no"
    environment:
      DATABASE_URL: postgresql://${WHATSAPP_DB_USER:-whatsapp_access}:${WHATSAPP_DB_PASSWORD:-local-whatsapp-password-change-me}@postgres:5432/${WHATSAPP_DB_NAME:-whatsapp_access}
    command: ["/run-migrations.sh"]
    volumes:
      - ./run-migrations.sh:/run-migrations.sh:ro
      # Empty today. run-migrations.sh skips a directory with no .sql files, so
      # the runner is wired up and waiting rather than added later.
      - ../../../domains/whatsapp-access/postgres/migrations:/migrations:ro
    depends_on:
      postgres-bootstrap:
        condition: service_completed_successfully
```

Also add the bootstrap dependency to `short-videos-migrations`, replacing its `depends_on` block with:

```yaml
    depends_on:
      postgres-bootstrap:
        condition: service_completed_successfully
```

- [ ] **Step 6: Include `public` in both compositions**

In `hosts/compose.local.yaml` and `hosts/compose.prod.yaml`, add to the `include:` list after the `heavy` entry:

```yaml
  - path: ./public/compose.yaml
```

- [ ] **Step 7: Document the new variables in `hosts/.env.example`**

Append:

```bash
# --- public host (webhook-facing, stock n8n image) ---

# Required. Generate with: openssl rand -hex 32
# Must differ from heavy's key, which lives inside the n8n_data volume at
# /home/node/.n8n/config and is deliberately not set here.
PUBLIC_N8N_ENCRYPTION_KEY=

# Local: 127.0.0.1 and 5679. Prod: leave the bind address at 127.0.0.1 and let
# Traefik reach the container over the Compose network.
PUBLIC_BIND_ADDRESS=127.0.0.1
PUBLIC_PORT=5679
PUBLIC_CONCURRENCY=5

# Prod only: set PUBLIC_TRAEFIK_ENABLE=true and the subdomain to publish
# https://<PUBLIC_SUBDOMAIN>.<DOMAIN_NAME>/
PUBLIC_TRAEFIK_ENABLE=false
PUBLIC_SUBDOMAIN=hooks

# --- heavy host (trusted, shell + ffmpeg) ---

# Prod: set this to the host's Tailscale address so the editor UI — which can
# create an Execute Command node — is not reachable from the internet.
HEAVY_BIND_ADDRESS=127.0.0.1
HEAVY_PORT=5678
HEAVY_CONCURRENCY=2

# --- whatsapp-access database ---

WHATSAPP_DB_NAME=whatsapp_access
WHATSAPP_DB_USER=whatsapp_access
WHATSAPP_DB_PASSWORD=local-whatsapp-password-change-me
```

- [ ] **Step 8: Run the tests**

Run: `npm test`
Expected: PASS, including the 8 tests in `tests/hosts-isolation.test.js`.

- [ ] **Step 9: Verify Compose resolves with both hosts**

```bash
cd /home/leon/projects/short-videos
PUBLIC_N8N_ENCRYPTION_KEY=$(openssl rand -hex 32) \
  docker compose -f hosts/compose.local.yaml config > /tmp/both.yaml && echo OK
grep -E "^  (n8n|public-n8n|postgres|postgres-bootstrap|task-runners|provider-uploader|jaeger|short-videos-migrations|whatsapp-access-migrations):" /tmp/both.yaml
grep -E "^  (n8n_data|public_n8n_data|publishing_db_data|jaeger_data):" /tmp/both.yaml
# the required-variable guard must actually bite
docker compose -f hosts/compose.local.yaml config >/dev/null 2>&1 && echo "BUG: missing key accepted" || echo "guard works"
```

Expected: all nine services and all four volumes listed; `guard works`.

- [ ] **Step 10: Commit**

```bash
cd /home/leon/projects/short-videos
git add -A
git commit -m "$(cat <<'MSG'
feat(hosts): add the public n8n host and fence it off from the video pipeline

public-n8n runs the stock n8nio/n8n image with NODES_EXCLUDE left unset,
so n8n's default blocklist keeps executeCommand and localFileTrigger
blocked. It has no render mounts, no task runners, its own n8n volume,
its own required N8N_ENCRYPTION_KEY, and a connection string for its own
database.

postgres-bootstrap creates the whatsapp_access role and database
idempotently and revokes CONNECT on the video database from PUBLIC.
postgres/init/ only runs on an empty data directory and the publishing
volume was initialised long ago, so the bootstrap is what reaches it.

whatsapp-access-migrations is wired up against an empty migrations
directory, so the domain's first migration needs no plumbing.
MSG
)"
```

---

### Task 4: Live verification gates

No code. These are the gates the spec names as the ones that would actually catch a broken migration, and they cannot be faked by a test file. Record the output of each in the branch's PR description.

**Files:** none.

**Interfaces:**
- Consumes: everything from Tasks 1–3.
- Produces: nothing. A pass/fail record.

- [ ] **Step 1: Bring both instances up**

```bash
cd /home/leon/projects/short-videos
# PUBLIC_N8N_ENCRYPTION_KEY must be in hosts/.env first
docker compose -f hosts/compose.local.yaml up -d
docker compose -f hosts/compose.local.yaml ps
```

Expected: `postgres` healthy, `postgres-bootstrap` and both migration services exited 0, `n8n`, `public-n8n`, `task-runners`, `provider-uploader` running.

- [ ] **Step 2: Both answer `/healthz`**

```bash
curl -s http://127.0.0.1:5678/healthz; echo
curl -s http://127.0.0.1:5679/healthz; echo
```

Expected: `{"status":"ok"}` from both. This is also the proof that the separate encryption keys work — a key mismatch against an existing volume shows up as a startup failure.

- [ ] **Step 3: `heavy` kept its workflows and credentials**

```bash
cd /home/leon/projects/short-videos
docker compose -f hosts/compose.local.yaml exec -T n8n \
  node -e "const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync('/home/node/.n8n/database.sqlite',{readOnly:true});for(const t of ['workflow_entity','credentials_entity'])console.log(t, db.prepare('SELECT COUNT(*) AS n FROM '+t).get().n);"
```

Expected: non-zero counts matching what was there before the migration. A zero here means the project name was not pinned and a fresh volume was created — Review Focus 1.

- [ ] **Step 4: `public` cannot load `executeCommand`**

The node types endpoint needs an authed session, so create the `public` owner account in the browser at `http://127.0.0.1:5679/` first, then:

```bash
curl -s -c /tmp/pub.jar -X POST http://127.0.0.1:5679/rest/login \
  -H 'content-type: application/json' \
  -d '{"emailOrLdapLoginId":"<owner-email>","password":"<owner-password>"}' >/dev/null
curl -s -b /tmp/pub.jar http://127.0.0.1:5679/types/nodes.json \
  | grep -c '"n8n-nodes-base.executeCommand"'

# Same check on heavy, as the positive control: the node must be loadable there.
curl -s -c /tmp/heavy.jar -X POST http://127.0.0.1:5678/rest/login \
  -H 'content-type: application/json' \
  -d '{"emailOrLdapLoginId":"<heavy-owner-email>","password":"<heavy-owner-password>"}' >/dev/null
curl -s -b /tmp/heavy.jar http://127.0.0.1:5678/types/nodes.json \
  | grep -c '"n8n-nodes-base.executeCommand"'
```

Expected: `0` for `public`, `1` for `heavy`. Without the positive control a `0` proves nothing — a broken endpoint also returns `0`. Without credentials the endpoint returns `{"status":"error","message":"Unauthorized"}`, which is not a pass.

- [ ] **Step 5: `public`'s DB role cannot read the video database**

```bash
cd /home/leon/projects/short-videos
docker compose -f hosts/compose.local.yaml exec -T -e PGPASSWORD=local-whatsapp-password-change-me postgres \
  psql -U whatsapp_access -d short_videos -c 'SELECT 1' ; echo "exit=$?"
docker compose -f hosts/compose.local.yaml exec -T -e PGPASSWORD=local-whatsapp-password-change-me postgres \
  psql -U whatsapp_access -d whatsapp_access -c 'SELECT current_database()'
```

Expected: the first fails with `permission denied for database "short_videos"` and a non-zero exit; the second prints `whatsapp_access`.

- [ ] **Step 6: One real clip through WF6 and WF8c**

In the `heavy` editor at `http://127.0.0.1:5678/`, run workflow `06-yt-dlp-clip-download` and then `08c-ffmpeg-render-final-clip` on one source row.

```bash
ls -la /home/leon/projects/short-videos/domains/short-videos/render-data/jobs/ | tail -5
ls -la /home/leon/projects/short-videos/domains/short-videos/render-data/output/final/ | tail -5
```

Expected: a new job directory and a rendered mp4. This is the only gate the test suite cannot fake: it proves `/data` still resolves to the moved host directory and that yt-dlp and ffmpeg are still in the image.

- [ ] **Step 7: Confirm the memory ceilings are in force**

```bash
docker stats --no-stream --format '{{.Name}}\t{{.MemUsage}}\t{{.MemPerc}}'
```

Expected limits: `n8n` 1 GiB, `public-n8n` 512 MiB, `postgres` 512 MiB, `task-runners` 512 MiB, `provider-uploader` 256 MiB. Note the real usage under the render from Step 6 — `heavy`'s 1 GB is the ceiling most likely to need raising.

- [ ] **Step 8: Rename the working directory**

Last, because it invalidates every absolute path above.

```bash
cd /home/leon/projects
docker compose -f short-videos/hosts/compose.local.yaml down
mv short-videos automations
cd automations && npm test && git remote -v
```

Expected: 213-plus tests pass; the remote still points at `short-videos`, which is deliberate — renaming it would change the remote URL and invalidate existing clones. Bring the stack back up with `docker compose -f hosts/compose.local.yaml up -d`; the volumes are unaffected because the project name is pinned rather than derived from the directory.

---

## Self-Review

**Spec coverage.** D1 → Tasks 1 and 3. D2 → Task 1 Steps 3–4. D3 → Task 3 Steps 4–5, gated in Task 4 Step 5. D4 → Task 3 Step 3, gated in Task 4 Step 2. D5 → `HEAVY_BIND_ADDRESS` in Task 1 Step 12 and `hosts/.env.example` in Task 3 Step 7; `heavy` has no Traefik labels, asserted in Task 3 Step 1. D6 → Task 1 is one commit. D7 → Task 1 Steps 11–14 (`compose.prod.yaml` now includes postgres, migrations, task runners and provider-uploader, which it never had). D8 → Task 4 Step 8. Root Python files → Task 1 Steps 5–7 and Task 2. Reproducible Lambda build → Task 2. All ten verification gates in the spec's table are covered: `npm test` (1.18), JSON parse (1.1, in the layout test), `docker compose config` (1.19, 3.9), boot + healthz (4.1–4.2), `executeCommand` denied (4.4), DB role denied (4.5), real clip (4.6), `build.sh` from a clean checkout (2.6), `local-server.py` (2.7), `git log --follow` (1.20).

**Deviations from the spec, deliberate.** (a) The spec's migration step 4 gives the test glob as `domains/*/tests/*.test.js`; the plan uses `"tests/*.test.js" "domains/*/tests/*.test.js"` so host-level and layout tests are not forced into a domain. (b) The spec says single commit; the plan uses three — the move (D6, the one the rollback argument is about), then the Lambda build change, which the spec itself singles out as the one part that changes behavior rather than moving files, then the `public` host, which is additive. Reverting the layout means reverting commits 1–3 rather than one. (c) `heavy` sets no `N8N_ENCRYPTION_KEY`; the spec's D4 asks for a separate key per instance, and not setting one on `heavy` is how that is achieved without destroying the credentials already encrypted under the key in its volume.

**Open risk the plan does not resolve.** `REVOKE CONNECT ... FROM PUBLIC` on the video database is cluster-wide for that database; if anything else connects to `short_videos` as a role other than its owner, it will start failing. Task 4 Step 5 is where that surfaces.
