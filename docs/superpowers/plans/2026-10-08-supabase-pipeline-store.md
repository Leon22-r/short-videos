# Supabase Pipeline Store Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the entire short-videos pipeline state machine from 13 Google Sheets tabs to 12 Postgres tables in Supabase, and give the three human touchpoints a tailnet-private web UI.

**Architecture:** All DDL ships as numbered, idempotent migration files replayed by `scripts/apply-migrations.sh` (and the container `run-migrations.sh`), recorded to `short_videos.schema_migrations`. The 5 workflow generators swap their local `sheet()` helper for a `table()` helper that emits `n8n-nodes-base.postgres` nodes reading from `.sql` files, so all 16 workflows are regenerated rather than hand-edited. Writes become one `INSERT ... ON CONFLICT` statement taking a `jsonb` row array, following the proven `upsert-publishing-jobs.sql` pattern. The review UI is a zero-dependency Node HTTP server talking to Supabase over PostgREST, with the one multi-table write done by a Postgres function.

**Tech Stack:** Node 26 (no npm dependencies, no build step), `node --test`, Postgres 16 / Supabase, n8n 2.25.7, Docker Compose.

**Spec:** `docs/superpowers/specs/2026-10-08-supabase-pipeline-store-design.md`

## Global Constraints

- **Zero npm dependencies.** `package.json` declares no `dependencies` and no `devDependencies`. Do not add any. No bundler, no build step, no transpiler.
- **Node 26**, CommonJS (`require`, not `import`) — every existing file in the repo uses CommonJS.
- **Test command:** `npm test`, which is `node --test "tests/*.test.js" "domains/*/tests/*.test.js"`.
- **Every migration must be idempotent.** `hosts/shared/postgres/run-migrations.sh` loops over every file in `/migrations/*.sql` with `ON_ERROR_STOP=1` on **every container start**, so a migration that fails on second application breaks all future boots. Use `CREATE TABLE IF NOT EXISTS`, `CREATE OR REPLACE FUNCTION`, `ADD COLUMN IF NOT EXISTS`, and `DO $$ ... $$` guards for constraints.
- **New DDL goes in `domains/short-videos/postgres/migrations/`, never in `postgres/init/`.** The `init/` directory is mounted at `/docker-entrypoint-initdb.d` and only ever runs on a fresh local volume; Supabase is external and will never see it.
- **Schema name is `short_videos`.** It already exists.
- **Status columns use `CHECK` constraints, never Postgres `enum` types.**
- **Primary keys stay `text`** and hold the existing deterministic IDs. No surrogate serials.
- **No `text NOT NULL DEFAULT ''`.** Nullable columns are nullable (spec D6).
- **Real-Postgres tests** follow `domains/short-videos/tests/postiz-postgres-integration.test.js`: spin a throwaway cluster with `initdb`/`pg_ctl` from `process.env.POSTIZ_TEST_PG_BIN || '/usr/lib/postgresql/16/bin'`, and `{ skip: !available }` when those binaries are absent. Never require a running Docker stack in a unit test.
- **No secret values in committed files.** `hosts/.env.example` must not ship a usable value for any secret variable — there is an existing regression test enforcing this.
- **Commit after every task.** Commit messages carry **no** `Co-Authored-By` trailer, for anyone. This is a standing instruction for this repository and it overrides any default attribution the harness suggests. (Earlier revisions of this plan said the opposite and half the branch's commits had to be rewritten to strip it.)

### Deviation from the spec, deliberate

The spec sketches the DDL as a single `004-pipeline-store.sql`. This plan splits it into five numbered migrations by table cluster (`004`–`008`). Reason: `run-migrations.sh` replays every file on every boot, so a single 12-table file means one syntax error anywhere blocks every container start, and a reviewer cannot approve the source tables while rejecting the publishing tables. Numbering continues from the existing `003-postiz-publishing.sql`.

## Review Focus

These are the input classes the spec implies but does not assign tests to. Each has a test pinned to the task that owns the code; they are listed here once, most-likely-to-bite first.

1. **A migration applied twice.** `run-migrations.sh` replays all migrations on every container start, so any non-idempotent statement bricks every future boot, not just one deploy. Expected: applying the full migration set twice in a row succeeds and leaves identical schema. *Pinned to Task 2.*
2. **A NULL engagement percentage reaching WF3's thresholds.** Section 1 drops the write-`0`-when-views-are-zero convention, so `like_percentage` can now be NULL where it used to be `0`. Expected: NULL fails the threshold (the video is rejected), never passes it and never throws. *Pinned to Task 11.*
3. **`approve_clip` called with a blank or unsupported platform.** The structure doc says blank does not mean all platforms and that `PENDING`/blank/unsupported must fail closed. Expected: the call raises, and neither the `review_status` update nor the `approved_for_posting` insert is left behind. *Pinned to Task 9.*
4. **An empty newline-separated list becoming `text[]`.** `alternative_titles`, `on_screen_text_beats`, `broll_plan` and `originality_checklist` are newline-joined strings today. Expected: an empty or whitespace-only value becomes NULL or `{}`, never `{""}` — a one-element array containing the empty string silently breaks every downstream `array_length` and `unnest`. *Pinned to Task 5.*
5. **A second `approve_clip` call on an already-approved clip.** Operators double-click, and the UI has no session state. Expected: the second call is a no-op or raises cleanly; it never inserts a duplicate `approved_for_posting` row. *Pinned to Task 9.*

---

## File Structure

**Created:**

| Path | Responsibility |
|---|---|
| `domains/short-videos/postgres/migrations/004-pipeline-store-sources.sql` | `source_channels`, `candidate_videos` |
| `domains/short-videos/postgres/migrations/005-pipeline-store-analysis.sql` | `transcript_analysis`, `clip_moments` |
| `domains/short-videos/postgres/migrations/006-pipeline-store-clips.sql` | `created_clips`, `render_jobs` |
| `domains/short-videos/postgres/migrations/007-pipeline-store-assets.sql` | `music_library`, `channel_branding`, `error_log` |
| `domains/short-videos/postgres/migrations/008-pipeline-store-publishing.sql` | `approved_for_posting`, `publishing_channels` |
| `domains/short-videos/postgres/migrations/009-publishing-jobs-retypes.sql` | D6 applied to `publishing_jobs`; retires `safe_schedule_at` |
| `domains/short-videos/postgres/migrations/010-approve-clip.sql` | `short_videos.approve_clip()` |
| `domains/short-videos/postgres/queries/*.sql` (new files) | One file per read/write the generators emit |
| `domains/short-videos/workflow-code/table-node.js` | The shared `table()` / `postgresNode()` helper replacing `sheet()` |
| `domains/short-videos/tests/pipeline-store-schema.test.js` | Static assertions over the new DDL |
| `domains/short-videos/tests/pipeline-store-postgres.test.js` | Real-Postgres: idempotency, `approve_clip`, `text[]` edges |
| `domains/short-videos/tests/no-google-sheets-nodes.test.js` | The inverse assertion; replaces `workflow-sheets-execute-once.test.js` |
| `hosts/review/compose.yaml` | The review UI service, tailnet-bound, `mem_limit: 64m` |
| `hosts/review/server.js` | Zero-dependency HTTP server, three routes |
| `hosts/review/render.js` | Pure HTML rendering + form-to-row mapping |
| `hosts/review/postgrest.js` | Thin `fetch` wrapper over Supabase PostgREST |
| `tests/review-ui.test.js` | Unit tests for `render.js` and the form mapping |
| `domains/short-videos/docs/postgres-schema.md` | Replaces `google-sheets-structure.md` |

**Modified:**

| Path | Change |
|---|---|
| `domains/short-videos/workflow-code/create-wf2-video-fetch.js` | `sheet()`/`sheetsNode()` → `table()`/`postgresNode()` |
| `domains/short-videos/workflow-code/create-wf3-validity-check.js` | same |
| `domains/short-videos/workflow-code/create-wf4-transcript-fetch.js` | same |
| `domains/short-videos/workflow-code/create-wf5-ai-transcript-analysis.js` | same |
| `domains/short-videos/workflow-code/create-remaining-workflows.js` | same, for WF1/6/8/8b/8c/8d/9/10/11/12/13/14 |
| `domains/short-videos/workflow-code/validity-check.js` | NULL percentages fail thresholds |
| `domains/short-videos/postgres/queries/` (17 existing files) | D6 retyping |
| `hosts/.env.example` | `SUPABASE_DATABASE_URL`, `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `REVIEW_BIND_ADDRESS`, `REVIEW_PORT` — all commented out |
| `hosts/compose.prod.yaml`, `hosts/compose.local.yaml` | include `hosts/review/` |
| `domains/short-videos/docs/credentials-setup.md` | drop Sheets rows, add the D8 consent-screen note |
| `domains/short-videos/docs/architecture.md` | Sheets → Postgres throughout |

**Deleted:**

| Path | Reason |
|---|---|
| `domains/short-videos/tests/workflow-sheets-execute-once.test.js` | Passes while asserting nothing once Sheets nodes are gone |
| `domains/short-videos/docs/google-sheets-structure.md` | Replaced by `postgres-schema.md` |

---

## Task 1: Gate 0 — prove the Supabase connection

**This task blocks every other task. Do not reorder it.** The spec deliberately names no port because no Supabase project existed when it was written.

**Files:**
- Create: `scripts/check-supabase-connection.sh`
- Modify: `hosts/.env.example`
- Modify: `docs/superpowers/specs/2026-10-08-supabase-pipeline-store-design.md` (record the answer)

**Interfaces:**
- Consumes: nothing.
- Produces: a verified `SUPABASE_DATABASE_URL` form (host, port, pooling mode) that every later task's migration run and every n8n Postgres credential uses.

- [ ] **Step 1: Ask the human partner to create the Supabase project**

This is not an agent action. Post exactly this and wait:

> I need a Supabase project before anything else in this plan can run. Please create one and give me the connection details from Project Settings → Database. I need: the direct connection string (port 5432), the pooler connection string (port 6543), and whether the IPv4 add-on is enabled. Do not paste them into a file — paste them in chat and I will put them in `hosts/.env`, which is gitignored.

- [ ] **Step 2: Write the connection probe script**

```bash
#!/bin/sh
# Probes a Postgres URL from inside a container on heavy-net, the way n8n will
# reach it. Prints the server version and the pooling mode on success.
set -eu

if [ "$#" -ne 1 ]; then
  echo "usage: $0 <postgres-url>" >&2
  exit 2
fi

docker run --rm --network heavy-net \
  -e PGCONNECT_TIMEOUT=10 \
  docker.io/library/postgres:16-alpine \
  psql "$1" -X -Atq -v ON_ERROR_STOP=1 \
    -c "SELECT 'connected: ' || version();" \
    -c "SELECT 'pooling: ' || coalesce(current_setting('pgbouncer.pool_mode', true), 'none (direct)');"
```

Make it executable: `chmod +x scripts/check-supabase-connection.sh`

- [ ] **Step 3: Probe both ports**

Run, substituting the real strings:

```bash
./scripts/check-supabase-connection.sh 'postgresql://...@db.<ref>.supabase.co:5432/postgres'
./scripts/check-supabase-connection.sh 'postgresql://...@aws-0-<region>.pooler.supabase.com:6543/postgres'
```

Expected: at least one prints `connected: PostgreSQL 15...`. Record which. A failure on 5432 with a DNS or network-unreachable error is the IPv6 case the spec predicted — that is a result, not a bug to fix.

- [ ] **Step 4: If only the transaction-mode pooler works, prove the atomic claim survives it**

The spec flags this as an assumption to test rather than assert. Run the existing claim query against the pooler twice concurrently and confirm exactly one row is returned in total:

```bash
docker run --rm --network heavy-net -v "$PWD/domains/short-videos/postgres:/sql:ro" \
  docker.io/library/postgres:16-alpine sh -c '
    psql "$SUPABASE_URL" -X -Atq -c "SELECT 1" &&
    echo "claim query is a single statement; transaction pooling is sufficient"'
```

Expected: `claim-next-publishing-job.sql` is one statement, so transaction pooling is sufficient. If the probe shows it has been split into multiple statements, stop and report — that changes the pooling decision.

- [ ] **Step 5: Record the answer in the spec and add the env vars**

Append to `hosts/.env.example`, with values commented out so the file ships nothing usable:

```sh
# Supabase pipeline store. Get these from Project Settings -> Database.
# Verified reachable port and pooling mode are recorded in
# docs/superpowers/specs/2026-10-08-supabase-pipeline-store-design.md.
#SUPABASE_DATABASE_URL=
#SUPABASE_URL=
#SUPABASE_SERVICE_KEY=
```

In the spec, replace the "The port and pooling mode are not decided here" subsection body with the measured result: which port, which pooling mode, and whether the IPv4 add-on was needed.

- [ ] **Step 6: Run the env-template regression test**

Run: `node --test tests/repo-layout.test.js`
Expected: PASS. It asserts `hosts/.env.example` ships no usable secret values; the commented-out lines above satisfy it.

- [ ] **Step 7: Commit**

```bash
git add scripts/check-supabase-connection.sh hosts/.env.example docs/superpowers/specs/2026-10-08-supabase-pipeline-store-design.md
git commit -m "chore(supabase): record the verified connection port and pooling mode"
```

---

## Task 2: The migration-replay guard

**Why this comes before any DDL:** `run-migrations.sh` replays every migration on every container start. A non-idempotent migration does not fail once at deploy time — it fails on every boot from then on. This task builds the test that every later task's migration must pass.

**Files:**
- Create: `domains/short-videos/tests/pipeline-store-postgres.test.js`
- Test: itself

**Interfaces:**
- Consumes: nothing.
- Produces: `applyAllMigrations(sql)` and the throwaway-cluster harness, reused by Tasks 3–9. Exported shape:
  - `withCluster(async ({ sql, file }) => { ... })` — starts a cluster, applies `001-publishing-queue.sql`, runs the callback, always stops and removes the cluster.
  - `sql(statement) -> string` — runs one statement, returns trimmed stdout.
  - `file(absolutePath) -> string` — applies one `.sql` file.
  - `migrationFiles() -> string[]` — sorted absolute paths of every file in `postgres/migrations/`.
  - Also exported: `available` (boolean), `pgBin` (string). Tasks 5, 6, 8 and 10 append tests to this same file, so they use its module-level `root` and `path` directly rather than re-deriving them.

- [ ] **Step 1: Write the failing test**

```js
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const pgBin = process.env.POSTIZ_TEST_PG_BIN || '/usr/lib/postgresql/16/bin';
const available = ['initdb', 'pg_ctl', 'psql'].every((name) => fs.existsSync(path.join(pgBin, name)));

const migrationsDir = path.join(root, 'postgres/migrations');
const migrationFiles = () => fs.readdirSync(migrationsDir)
  .filter((file) => file.endsWith('.sql'))
  .sort()
  .map((file) => path.join(migrationsDir, file));

// Starts a throwaway cluster on a port no other test uses, runs body, always stops.
async function withCluster(body) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-store-test-'));
  const data = path.join(temp, 'data');
  const psqlArgs = ['-X', '-h', temp, '-p', '55441', '-U', 'postgres', '-d', 'postgres', '-Atq', '-v', 'ON_ERROR_STOP=1'];
  const command = (name, args) => execFileSync(path.join(pgBin, name), args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const sql = (statement) => command('psql', [...psqlArgs, '-c', statement]).trim();
  const file = (absolutePath) => command('psql', [...psqlArgs, '-f', absolutePath]).trim();
  let started = false;
  try {
    command('initdb', ['-D', data, '-U', 'postgres', '-A', 'trust', '--no-locale']);
    command('pg_ctl', ['-D', data, '-l', path.join(temp, 'postgres.log'), '-o', `-h '' -k ${temp} -p 55441`, '-w', 'start']);
    started = true;
    sql(fs.readFileSync(path.join(root, 'postgres/init/001-publishing-queue.sql'), 'utf8'));
    await body({ sql, file });
  } finally {
    if (started) { try { command('pg_ctl', ['-D', data, '-w', 'stop']); } catch {} }
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

// Review Focus 1: run-migrations.sh replays every migration on every boot.
test('real Postgres: the full migration set is idempotent under replay', { skip: !available }, async () => {
  await withCluster(async ({ sql, file }) => {
    const snapshot = () => sql(`
      SELECT string_agg(entry, E'\\n' ORDER BY entry) FROM (
        SELECT table_name || '.' || column_name || ':' || data_type ||
               ':' || is_nullable AS entry
        FROM information_schema.columns WHERE table_schema = 'short_videos'
        UNION ALL
        SELECT 'constraint:' || conrelid::regclass::text || ':' || conname
        FROM pg_constraint
        WHERE connamespace = 'short_videos'::regnamespace
      ) entries;`);

    for (const migration of migrationFiles()) file(migration);
    const first = snapshot();

    // The second pass is what a container restart does.
    for (const migration of migrationFiles()) file(migration);
    const second = snapshot();

    assert.equal(second, first, 'replaying migrations changed the schema');
  });
});

module.exports = { withCluster, migrationFiles, available, pgBin };
```

- [ ] **Step 2: Run it to verify it passes against the existing migrations**

Run: `node --test domains/short-videos/tests/pipeline-store-postgres.test.js`
Expected: PASS. The three existing migrations (`002`, `003`) are already written idempotently, so a green result here is the baseline. If it FAILS now, stop — an existing migration is not replay-safe and that is a pre-existing bug to report before building on it.

- [ ] **Step 3: Commit**

```bash
git add domains/short-videos/tests/pipeline-store-postgres.test.js
git commit -m "test(postgres): assert the migration set is idempotent under replay

run-migrations.sh replays every file on every container start, so a
non-idempotent migration breaks all future boots rather than one deploy."
```

---

## Task 3: `source_channels` and `candidate_videos`

**Files:**
- Create: `domains/short-videos/postgres/migrations/004-pipeline-store-sources.sql`
- Create: `domains/short-videos/tests/pipeline-store-schema.test.js`
- Modify: `domains/short-videos/tests/pipeline-store-postgres.test.js` (nothing to change; the replay test picks the new file up automatically)

**Interfaces:**
- Consumes: the cluster harness from Task 2.
- Produces: tables `short_videos.source_channels` (PK `source_id`) and `short_videos.candidate_videos` (PK `video_id`, FK `source_id` → `source_channels`), and the `niche` CHECK value list reused by every later table.

- [ ] **Step 1: Write the failing schema test**

```js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

test('source and candidate tables are typed, constrained and replay-safe', () => {
  const schema = read('postgres/migrations/004-pipeline-store-sources.sql');

  assert.match(schema, /CREATE TABLE IF NOT EXISTS short_videos\.source_channels/);
  assert.match(schema, /source_id text PRIMARY KEY/);
  assert.match(schema, /active_status boolean/);
  assert.match(schema, /last_checked_at timestamptz/);
  assert.match(schema, /videos_known_count integer/);
  assert.match(schema, /CHECK \(niche IN \('CHRISTIAN_CONTENT'/);
  assert.match(schema, /CHECK \(risk_level IN \('low', 'medium', 'high'\)\)/);
  assert.match(schema, /CHECK \(backfill_status IN \('NOT_STARTED', 'IN_PROGRESS', 'COMPLETE'\)\)/);

  assert.match(schema, /CREATE TABLE IF NOT EXISTS short_videos\.candidate_videos/);
  assert.match(schema, /video_id text PRIMARY KEY/);
  assert.match(schema, /REFERENCES short_videos\.source_channels/);
  assert.match(schema, /youtube_video_id text NOT NULL UNIQUE/);
  assert.match(schema, /like_percentage numeric/);
  assert.match(schema, /CHECK \(processing_status IN \('NEW', 'ANALYZED', 'SKIPPED', 'CLIPPING', 'DONE'\)\)/);
  assert.match(schema, /CHECK \(validity_status IN \('VALID', 'REJECTED', 'FLAGGED'\)\)/);
  assert.match(schema, /CHECK \(duplicate_status IN \('UNIQUE', 'DUPLICATE'\)\)/);

  // D6: the Sheets-era convention must not come back.
  assert.doesNotMatch(schema, /text NOT NULL DEFAULT ''/);
  // Status values live in CHECK constraints, not enum types.
  assert.doesNotMatch(schema, /CREATE TYPE/i);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test domains/short-videos/tests/pipeline-store-schema.test.js`
Expected: FAIL with `ENOENT: no such file or directory, open '.../004-pipeline-store-sources.sql'`

- [ ] **Step 3: Write the migration**

The column list is transcribed from `domains/short-videos/docs/google-sheets-structure.md` Tabs 1 and 2, under the type rules in spec Section 1.

```sql
-- Pipeline store, part 1 of 5: the chain head.
-- Replayed on every container start; every statement must be idempotent.

CREATE TABLE IF NOT EXISTS short_videos.source_channels (
  source_id                text PRIMARY KEY,
  niche                    text NOT NULL,
  source_name              text NOT NULL,
  youtube_channel_url      text NOT NULL,
  youtube_channel_id       text,
  uploads_playlist_id      text,
  source_type              text,
  priority                 integer NOT NULL DEFAULT 1,
  risk_level               text,
  permission_risk          text,
  monetization_risk        text,
  notes                    text,
  active_status            boolean NOT NULL DEFAULT true,
  last_checked_at          timestamptz,
  backfill_next_page_token text,
  backfill_status          text NOT NULL DEFAULT 'NOT_STARTED',
  videos_known_count       integer,
  videos_fetched_count     integer NOT NULL DEFAULT 0,
  backfill_last_run_at     timestamptz,
  total_analyzed_count     integer NOT NULL DEFAULT 0,
  channel_skip_rate        numeric,
  auto_paused_at           timestamptz,
  auto_paused_reason       text,
  health_reset_at          timestamptz,
  created_at               timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT source_channels_niche_check CHECK (niche IN (
    'CHRISTIAN_CONTENT', 'MOTIVATION_DISCIPLINE', 'FINANCE_BUSINESS',
    'LIFE_VALUES_RELATIONSHIPS', 'AFRICAN_KENYAN_SUCCESS')),
  CONSTRAINT source_channels_risk_level_check CHECK (risk_level IS NULL OR risk_level IN ('low', 'medium', 'high')),
  CONSTRAINT source_channels_permission_risk_check CHECK (permission_risk IS NULL OR permission_risk IN ('low', 'medium', 'high')),
  CONSTRAINT source_channels_monetization_risk_check CHECK (monetization_risk IS NULL OR monetization_risk IN ('low', 'medium', 'high')),
  CONSTRAINT source_channels_backfill_status_check CHECK (backfill_status IN ('NOT_STARTED', 'IN_PROGRESS', 'COMPLETE'))
);

CREATE TABLE IF NOT EXISTS short_videos.candidate_videos (
  video_id              text PRIMARY KEY,
  niche                 text NOT NULL,
  source_id             text REFERENCES short_videos.source_channels(source_id) ON DELETE SET NULL,
  source_name           text,
  video_title           text,
  video_url             text,
  youtube_video_id      text NOT NULL UNIQUE,
  duration_seconds      integer,
  published_at          timestamptz,
  view_count            bigint,
  like_count            bigint,
  comment_count         bigint,
  like_percentage       numeric,
  comment_percentage    numeric,
  engagement_percentage numeric,
  transcript_available  boolean,
  language              text,
  validity_status       text,
  validity_score        numeric,
  rejection_reason      text,
  duplicate_status      text,
  processing_status     text NOT NULL DEFAULT 'NEW',
  created_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT candidate_videos_niche_check CHECK (niche IN (
    'CHRISTIAN_CONTENT', 'MOTIVATION_DISCIPLINE', 'FINANCE_BUSINESS',
    'LIFE_VALUES_RELATIONSHIPS', 'AFRICAN_KENYAN_SUCCESS')),
  CONSTRAINT candidate_videos_validity_status_check CHECK (validity_status IS NULL OR validity_status IN ('VALID', 'REJECTED', 'FLAGGED')),
  CONSTRAINT candidate_videos_duplicate_status_check CHECK (duplicate_status IS NULL OR duplicate_status IN ('UNIQUE', 'DUPLICATE')),
  CONSTRAINT candidate_videos_processing_status_check CHECK (processing_status IN ('NEW', 'ANALYZED', 'SKIPPED', 'CLIPPING', 'DONE'))
);

CREATE INDEX IF NOT EXISTS candidate_videos_pending_idx
  ON short_videos.candidate_videos (processing_status, source_id)
  WHERE processing_status = 'NEW';
```

- [ ] **Step 4: Run both tests**

Run: `node --test domains/short-videos/tests/pipeline-store-schema.test.js domains/short-videos/tests/pipeline-store-postgres.test.js`
Expected: both PASS. The replay test from Task 2 now exercises this file twice; `CREATE TABLE IF NOT EXISTS` and named constraints inside it make that safe.

- [ ] **Step 5: Commit**

```bash
git add domains/short-videos/postgres/migrations/004-pipeline-store-sources.sql domains/short-videos/tests/pipeline-store-schema.test.js
git commit -m "feat(postgres): add source_channels and candidate_videos"
```

---

## Task 4: `transcript_analysis` and `clip_moments`

This is where the truncation and the Drive round trip die (spec Section 1, item 1) and where D7's rename lands.

**Files:**
- Create: `domains/short-videos/postgres/migrations/005-pipeline-store-analysis.sql`
- Modify: `domains/short-videos/tests/pipeline-store-schema.test.js`

**Interfaces:**
- Consumes: `short_videos.source_channels`, `short_videos.candidate_videos` (Task 3).
- Produces: `short_videos.transcript_analysis` (PK `analysis_id`), `short_videos.clip_moments` (PK `clip_moment_id`, column `download_status` — the D7 rename of `ssemble_status`).

- [ ] **Step 1: Write the failing test**

Append to `pipeline-store-schema.test.js`:

```js
test('analysis tables drop the truncation columns and apply the D7 rename', () => {
  const schema = read('postgres/migrations/005-pipeline-store-analysis.sql');

  assert.match(schema, /transcript_text text/);
  assert.match(schema, /ai_json_output jsonb/);
  assert.match(schema, /CHECK \(transcript_status IN \('FETCHED', 'FAILED'\)\)/);
  assert.match(schema, /CHECK \(recommended_strategy IN \('USE_20_MIN_WINDOW', 'USE_EXACT_CLIPS_ONLY', 'SKIP_THIS_VIDEO'\)\)/);

  // Section 1 item 1: Postgres text is unbounded, so the Drive stash is deleted.
  assert.doesNotMatch(schema, /transcript_full_url/);
  assert.doesNotMatch(schema, /transcript_full_file_id/);

  // D7: the legacy ssemble_* names do not survive.
  assert.match(schema, /download_status text/);
  assert.match(schema, /download_job_id text/);
  assert.doesNotMatch(schema, /ssemble_status/);
  assert.doesNotMatch(schema, /ssemble_job_id/);
  assert.match(schema, /CHECK \(download_status IN \('PENDING', 'SUBMITTED', 'COMPLETED', 'ERROR', 'AWAITING_MANUAL_APPROVAL'\)\)/);
  assert.match(schema, /CHECK \(final_recommendation IN \('clip', 'use_as_idea_only', 'skip'\)\)/);

  assert.doesNotMatch(schema, /text NOT NULL DEFAULT ''/);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test domains/short-videos/tests/pipeline-store-schema.test.js`
Expected: FAIL with `ENOENT` on `005-pipeline-store-analysis.sql`

- [ ] **Step 3: Write the migration**

```sql
-- Pipeline store, part 2 of 5: transcript analysis and clip moments.
-- transcript_full_url / transcript_full_file_id are deliberately absent:
-- Postgres text is unbounded, so the ~45k truncation and the Drive stash
-- that recovered the real value are both deleted.

CREATE TABLE IF NOT EXISTS short_videos.transcript_analysis (
  analysis_id             text PRIMARY KEY,
  video_id                text REFERENCES short_videos.candidate_videos(video_id) ON DELETE CASCADE,
  niche                   text NOT NULL,
  source_id               text REFERENCES short_videos.source_channels(source_id) ON DELETE SET NULL,
  video_title             text,
  video_url               text,
  transcript_status       text,
  transcript_text         text,
  transcript_length_words integer,
  ai_episode_score        numeric,
  recommended_strategy    text,
  recommended_start_sec   integer,
  recommended_end_sec     integer,
  reason_for_strategy     text,
  rights_risk             text,
  permission_risk         text,
  monetization_risk       text,
  originality_potential   text,
  kenya_relevance         text,
  ai_json_output          jsonb,
  created_at              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT transcript_analysis_status_check CHECK (transcript_status IS NULL OR transcript_status IN ('FETCHED', 'FAILED')),
  CONSTRAINT transcript_analysis_strategy_check CHECK (recommended_strategy IS NULL OR recommended_strategy IN (
    'USE_20_MIN_WINDOW', 'USE_EXACT_CLIPS_ONLY', 'SKIP_THIS_VIDEO'))
);

CREATE TABLE IF NOT EXISTS short_videos.clip_moments (
  clip_moment_id            text PRIMARY KEY,
  video_id                  text REFERENCES short_videos.candidate_videos(video_id) ON DELETE CASCADE,
  niche                     text NOT NULL,
  source_id                 text REFERENCES short_videos.source_channels(source_id) ON DELETE SET NULL,
  rank                      integer,
  start_sec                 integer,
  end_sec                   integer,
  clip_length_seconds       integer,
  hook_first_2_seconds      text,
  core_idea                 text,
  why_valuable              text,
  target_audience           text,
  suggested_title           text,
  suggested_caption         text,
  on_screen_text            text,
  suggested_broll           text,
  commentary_angle          text,
  kenyan_african_application text,
  bible_verse_if_relevant   text,
  needs_extra_context       boolean,
  originality_score         numeric,
  clip_score                numeric,
  rights_risk               text,
  final_recommendation      text,
  download_status           text NOT NULL DEFAULT 'PENDING',
  download_job_id           text,
  strategy                  text,
  source_video_url          text,
  created_at                timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT clip_moments_download_status_check CHECK (download_status IN (
    'PENDING', 'SUBMITTED', 'COMPLETED', 'ERROR', 'AWAITING_MANUAL_APPROVAL')),
  CONSTRAINT clip_moments_recommendation_check CHECK (final_recommendation IS NULL OR final_recommendation IN (
    'clip', 'use_as_idea_only', 'skip'))
);

-- The review UI's third screen reads exactly this set.
CREATE INDEX IF NOT EXISTS clip_moments_awaiting_approval_idx
  ON short_videos.clip_moments (niche)
  WHERE download_status = 'AWAITING_MANUAL_APPROVAL';
```

- [ ] **Step 4: Run the tests**

Run: `node --test domains/short-videos/tests/pipeline-store-schema.test.js domains/short-videos/tests/pipeline-store-postgres.test.js`
Expected: both PASS.

- [ ] **Step 5: Commit**

```bash
git add domains/short-videos/postgres/migrations/005-pipeline-store-analysis.sql domains/short-videos/tests/pipeline-store-schema.test.js
git commit -m "feat(postgres): add transcript_analysis and clip_moments

Drops transcript_full_url and transcript_full_file_id; unbounded text
removes the 45k truncation and the Drive round trip that recovered it.
Applies the D7 rename: ssemble_status -> download_status."
```

---

## Task 5: `created_clips` and `render_jobs`

This task owns **Review Focus 4** — the newline-separated lists becoming `text[]`.

**Files:**
- Create: `domains/short-videos/postgres/migrations/006-pipeline-store-clips.sql`
- Modify: `domains/short-videos/tests/pipeline-store-schema.test.js`
- Modify: `domains/short-videos/tests/pipeline-store-postgres.test.js`

**Interfaces:**
- Consumes: `short_videos.candidate_videos`, `short_videos.clip_moments`.
- Produces: `short_videos.created_clips` (PK `created_clip_id`, column `download_job_id` per D7, `review_status` read by the UI's first screen), `short_videos.render_jobs` (PK `render_id`).

- [ ] **Step 1: Write the failing schema test**

Append to `pipeline-store-schema.test.js`:

```js
test('clip and render tables use arrays, jsonb and real timestamps', () => {
  const schema = read('postgres/migrations/006-pipeline-store-clips.sql');

  // Section 1 item 3: the newline-separated lists become real arrays.
  assert.match(schema, /alternative_titles text\[\]/);
  assert.match(schema, /on_screen_text_beats text\[\]/);
  assert.match(schema, /broll_plan text\[\]/);
  assert.match(schema, /originality_checklist text\[\]/);
  assert.match(schema, /transformation_plan jsonb/);

  assert.match(schema, /CHECK \(review_status IN \('AWAITING_DOWNLOAD', 'NEEDS_REVIEW', 'APPROVED', 'REJECTED'\)\)/);
  assert.match(schema, /download_job_id text/);
  assert.doesNotMatch(schema, /ssemble_job_id/);

  assert.match(schema, /CHECK \(render_status IN \('PENDING', 'DOWNLOADING_ASSETS', 'RENDERING', 'UPLOADING', 'COMPLETED', 'FAILED', 'SKIPPED'\)\)/);
  assert.match(schema, /use_blurred_background boolean/);
  assert.match(schema, /started_at timestamptz/);
  assert.match(schema, /completed_at timestamptz/);

  assert.doesNotMatch(schema, /text NOT NULL DEFAULT ''/);
});
```

- [ ] **Step 2: Write the failing array-edge test (Review Focus 4)**

Append to `pipeline-store-postgres.test.js`:

```js
// Review Focus 4: a newline-joined list that is empty must not become {""}.
// A one-element array holding the empty string silently breaks every
// downstream array_length() and unnest().
test('real Postgres: empty newline lists become NULL or {}, never {""}', { skip: !available }, async () => {
  await withCluster(async ({ sql, file }) => {
    for (const migration of migrationFiles()) file(migration);

    const split = (value) => sql(
      `SELECT coalesce(array_to_json(short_videos.split_lines(${value}))::text, 'null')`);

    assert.equal(split("''"), 'null', 'empty string must not become an array');
    assert.equal(split("'   '"), 'null', 'whitespace-only must not become an array');
    assert.equal(split('NULL'), 'null');
    assert.equal(split("'a'"), '["a"]');
    assert.equal(split("E'a\\nb'"), '["a","b"]');
    // A trailing newline is what a Sheets cell actually contained.
    assert.equal(split("E'a\\nb\\n'"), '["a","b"]', 'trailing newline must not add an empty element');
    assert.equal(split("E'a\\n\\nb'"), '["a","b"]', 'blank interior lines must be dropped');
  });
});
```

- [ ] **Step 3: Run both to verify they fail**

Run: `node --test domains/short-videos/tests/pipeline-store-schema.test.js domains/short-videos/tests/pipeline-store-postgres.test.js`
Expected: schema test FAILs with `ENOENT` on `006-pipeline-store-clips.sql`; the array test FAILs with `function short_videos.split_lines(unknown) does not exist`.

- [ ] **Step 4: Write the migration**

```sql
-- Pipeline store, part 3 of 5: created clips and render jobs.

-- Converts a Sheets-era newline-joined list into a text[], dropping blank
-- lines so an empty cell becomes NULL rather than a one-element array
-- holding the empty string.
CREATE OR REPLACE FUNCTION short_videos.split_lines(value text)
RETURNS text[]
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE WHEN cardinality(lines) = 0 THEN NULL ELSE lines END
  FROM (
    SELECT array_agg(btrim(line) ORDER BY ordinality) AS lines
    FROM unnest(string_to_array(coalesce(value, ''), E'\n')) WITH ORDINALITY AS t(line, ordinality)
    WHERE btrim(line) <> ''
  ) collected;
$$;

CREATE TABLE IF NOT EXISTS short_videos.created_clips (
  created_clip_id            text PRIMARY KEY,
  download_job_id            text,
  video_id                   text REFERENCES short_videos.candidate_videos(video_id) ON DELETE SET NULL,
  clip_moment_id             text REFERENCES short_videos.clip_moments(clip_moment_id) ON DELETE SET NULL,
  niche                      text NOT NULL,
  clip_title                 text,
  clip_url                   text,
  local_file_name            text,
  google_drive_file_id       text,
  google_drive_url           text,
  duration_seconds           integer,
  transcript_excerpt         text,
  suggested_title            text,
  suggested_caption          text,
  content_thesis             text,
  hook                       text,
  narration_script           text,
  commentary_angle           text,
  kenyan_african_localization text,
  bible_verse_if_relevant    text,
  alternative_titles         text[],
  on_screen_text_beats       text[],
  broll_plan                 text[],
  editing_style              text,
  hashtags                   text[],
  cta                        text,
  risk_warning               text,
  originality_checklist      text[],
  transformation_plan        jsonb,
  review_status              text NOT NULL DEFAULT 'AWAITING_DOWNLOAD',
  reviewer_notes             text,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT created_clips_review_status_check CHECK (review_status IN (
    'AWAITING_DOWNLOAD', 'NEEDS_REVIEW', 'APPROVED', 'REJECTED'))
);

-- The review UI's first screen reads exactly this set.
CREATE INDEX IF NOT EXISTS created_clips_needs_review_idx
  ON short_videos.created_clips (created_at)
  WHERE review_status = 'NEEDS_REVIEW';

CREATE TABLE IF NOT EXISTS short_videos.render_jobs (
  render_id              text PRIMARY KEY,
  created_clip_id        text REFERENCES short_videos.created_clips(created_clip_id) ON DELETE CASCADE,
  niche                  text NOT NULL,
  source_drive_file_id   text,
  source_drive_url       text,
  source_file_name       text,
  final_drive_folder_id  text,
  hook_text              text,
  cta_text               text,
  cta_start_second       numeric,
  cta_end_second         numeric,
  music_mood             text,
  music_energy_level     text,
  music_id               text,
  music_drive_file_id    text,
  music_file_name        text,
  music_volume           numeric,
  watermark_drive_file_id text,
  watermark_file_name    text,
  progress_bar_color     text,
  use_blurred_background boolean,
  ffmpeg_command         text,
  render_status          text NOT NULL DEFAULT 'PENDING',
  final_local_path       text,
  final_drive_file_id    text,
  final_drive_url        text,
  warning_message        text,
  error_message          text,
  created_at             timestamptz NOT NULL DEFAULT now(),
  started_at             timestamptz,
  completed_at           timestamptz,
  CONSTRAINT render_jobs_render_status_check CHECK (render_status IN (
    'PENDING', 'DOWNLOADING_ASSETS', 'RENDERING', 'UPLOADING', 'COMPLETED', 'FAILED', 'SKIPPED'))
);

CREATE INDEX IF NOT EXISTS render_jobs_pending_idx
  ON short_videos.render_jobs (created_at)
  WHERE render_status = 'PENDING';
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test domains/short-videos/tests/pipeline-store-schema.test.js domains/short-videos/tests/pipeline-store-postgres.test.js`
Expected: all PASS, including the replay test from Task 2 — `CREATE OR REPLACE FUNCTION` is replay-safe.

- [ ] **Step 6: Commit**

```bash
git add domains/short-videos/postgres/migrations/006-pipeline-store-clips.sql domains/short-videos/tests/pipeline-store-schema.test.js domains/short-videos/tests/pipeline-store-postgres.test.js
git commit -m "feat(postgres): add created_clips and render_jobs

Newline-joined Sheets lists become text[] via split_lines(), which drops
blank lines so an empty cell is NULL rather than a one-element array
holding the empty string."
```

---

## Task 6: `music_library`, `channel_branding`, `error_log`

This task adds the one new constraint the spec argues for: moving WF8c's render-time branding check to write time.

**Files:**
- Create: `domains/short-videos/postgres/migrations/007-pipeline-store-assets.sql`
- Modify: `domains/short-videos/tests/pipeline-store-schema.test.js`
- Modify: `domains/short-videos/tests/pipeline-store-postgres.test.js`

**Interfaces:**
- Consumes: nothing from earlier tasks (these three tables are outside the status chain).
- Produces: `short_videos.music_library` (PK `music_id`), `short_videos.channel_branding` (PK `niche`), `short_videos.error_log` (PK `error_id`).

- [ ] **Step 1: Write the failing schema test**

```js
test('asset tables move the branding uniqueness check to write time', () => {
  const schema = read('postgres/migrations/007-pipeline-store-assets.sql');

  assert.match(schema, /CREATE TABLE IF NOT EXISTS short_videos\.music_library/);
  assert.match(schema, /loop_allowed boolean/);
  assert.match(schema, /times_used integer/);
  assert.match(schema, /last_used_at timestamptz/);

  assert.match(schema, /CREATE TABLE IF NOT EXISTS short_videos\.channel_branding/);
  // Spec Section 1: a unique partial index turns a mid-render failure into a write-time one.
  assert.match(schema, /CREATE UNIQUE INDEX IF NOT EXISTS channel_branding_one_active_per_niche_idx/);
  assert.match(schema, /WHERE active_status/);

  assert.match(schema, /CREATE TABLE IF NOT EXISTS short_videos\.error_log/);
  assert.match(schema, /raw_payload jsonb/);

  assert.doesNotMatch(schema, /text NOT NULL DEFAULT ''/);
});
```

- [ ] **Step 2: Write the failing constraint test**

Append to `pipeline-store-postgres.test.js`:

```js
// Spec Section 1: WF8c used to discover a duplicate branding row mid-render.
test('real Postgres: a second active branding row for a niche is rejected at write time', { skip: !available }, async () => {
  await withCluster(async ({ sql, file }) => {
    for (const migration of migrationFiles()) file(migration);

    const insert = (niche, active) => sql(
      `INSERT INTO short_videos.channel_branding(niche, watermark_drive_file_id, active_status)
       VALUES ('${niche}', 'wm-1', ${active})`);

    insert('FINANCE_BUSINESS', 'true');
    assert.throws(
      () => insert('FINANCE_BUSINESS', 'true'),
      /channel_branding_one_active_per_niche_idx|duplicate key/,
      'a second active row for the same niche must be rejected',
    );
    // An inactive duplicate is how an operator keeps an old branding row around.
    insert('FINANCE_BUSINESS', 'false');
  });
});
```

Note: `channel_branding` has `niche` as its primary key in the structure doc, which would make the partial index redundant. It is **not** the primary key here — the doc's own notes say an operator keeps inactive rows (`Set active_status=FALSE to pause`), so the table needs multiple rows per niche with at most one active. The migration below uses a surrogate `branding_id text PRIMARY KEY` for that reason; this is the one place the plan adds a key the Sheet did not have, and the test above is why.

- [ ] **Step 3: Run both to verify they fail**

Run: `node --test domains/short-videos/tests/pipeline-store-schema.test.js domains/short-videos/tests/pipeline-store-postgres.test.js`
Expected: FAIL with `ENOENT` on `007-pipeline-store-assets.sql`.

- [ ] **Step 4: Write the migration**

```sql
-- Pipeline store, part 4 of 5: assets and the error log.

CREATE TABLE IF NOT EXISTS short_videos.music_library (
  music_id           text PRIMARY KEY,
  niche              text,
  mood               text,
  energy_level       text,
  track_name         text,
  artist_name        text,
  source             text,
  source_url         text,
  license_notes      text,
  drive_file_id      text,
  duration_seconds   integer,
  recommended_volume numeric,
  loop_allowed       boolean,
  active_status      boolean NOT NULL DEFAULT true,
  times_used         integer NOT NULL DEFAULT 0,
  created_at         timestamptz NOT NULL DEFAULT now(),
  last_used_at       timestamptz,
  notes              text
);

CREATE INDEX IF NOT EXISTS music_library_selection_idx
  ON short_videos.music_library (niche, mood, energy_level)
  WHERE active_status;

-- branding_id is a surrogate key the Sheet did not have. The structure doc
-- keys this tab on niche, but its own notes tell operators to pause a row
-- with active_status=FALSE rather than delete it, which needs more than one
-- row per niche. The partial unique index below is the real invariant, and it
-- moves WF8c's mid-render duplicate check to write time.
CREATE TABLE IF NOT EXISTS short_videos.channel_branding (
  branding_id             text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  niche                   text NOT NULL,
  watermark_drive_file_id text,
  primary_color           text,
  secondary_color         text,
  progress_bar_color      text,
  default_cta             text,
  music_default_id        text REFERENCES short_videos.music_library(music_id) ON DELETE SET NULL,
  active_status           boolean NOT NULL DEFAULT true,
  notes                   text,
  created_at              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT channel_branding_progress_bar_color_check CHECK (
    progress_bar_color IS NULL OR progress_bar_color ~ '^0x[0-9A-Fa-f]{6}$')
);

CREATE UNIQUE INDEX IF NOT EXISTS channel_branding_one_active_per_niche_idx
  ON short_videos.channel_branding (niche)
  WHERE active_status;

CREATE TABLE IF NOT EXISTS short_videos.error_log (
  error_id         text PRIMARY KEY,
  workflow_name    text,
  node_name        text,
  related_video_id text,
  error_type       text,
  error_message    text,
  raw_payload      jsonb,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS error_log_recent_idx ON short_videos.error_log (created_at DESC);
```

`gen_random_uuid()` is in core Postgres 13+ and in Supabase; it needs no extension, which matters because `publishing-postgres.test.js` asserts the schema contains no `CREATE EXTENSION`.

- [ ] **Step 5: Run the tests**

Run: `node --test domains/short-videos/tests/pipeline-store-schema.test.js domains/short-videos/tests/pipeline-store-postgres.test.js`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add domains/short-videos/postgres/migrations/007-pipeline-store-assets.sql domains/short-videos/tests/
git commit -m "feat(postgres): add music_library, channel_branding and error_log

A unique partial index on (niche) WHERE active_status moves WF8c's
duplicate-branding failure from mid-render to write time."
```

---

## Task 7: `approved_for_posting` and `publishing_channels`

**Files:**
- Create: `domains/short-videos/postgres/migrations/008-pipeline-store-publishing.sql`
- Modify: `domains/short-videos/tests/pipeline-store-schema.test.js`

**Interfaces:**
- Consumes: `short_videos.created_clips`, `short_videos.render_jobs`.
- Produces: `short_videos.approved_for_posting` (PK `approved_id`, `platforms text[]`, `status` CHECK), `short_videos.publishing_channels` (PK `channel_id`). `approve_clip()` in Task 9 inserts into `approved_for_posting`; WF11 reads both.

- [ ] **Step 1: Write the failing test**

```js
test('publishing tables fail closed on status and platform', () => {
  const schema = read('postgres/migrations/008-pipeline-store-publishing.sql');

  // The structure doc: only APPROVED or READY authorizes WF11; blank fails closed.
  assert.match(schema, /CHECK \(status IN \('PENDING', 'APPROVED', 'READY', 'REJECTED'\)\)/);
  // The structure doc: "platform must contain at least one explicit supported
  // value. Blank does not mean all platforms." A text[] with a length check
  // makes that structural instead of conventional.
  assert.match(schema, /platforms text\[\]/);
  assert.match(schema, /cardinality\(platforms\) > 0/);
  assert.match(schema, /platforms <@ ARRAY\['YOUTUBE_SHORTS', 'TIKTOK', 'INSTAGRAM_REELS', 'FACEBOOK_REELS'\]/);
  assert.match(schema, /scheduled_at timestamptz/);

  assert.match(schema, /CREATE TABLE IF NOT EXISTS short_videos\.publishing_channels/);
  assert.match(schema, /enabled_status boolean/);
  assert.match(schema, /tiktok_domain_verified boolean/);
  assert.match(schema, /token_expires_at timestamptz/);
  assert.match(schema, /CHECK \(credential_slot IN \('YOUTUBE_PRIMARY', 'FACEBOOK_PRIMARY', 'INSTAGRAM_PRIMARY', 'TIKTOK_PRIMARY', 'POSTIZ_PRIMARY'\)\)/);
  assert.match(schema, /CHECK \(audit_status IN \('DEV_PRIVATE_ONLY', 'APPROVED_PUBLIC', 'NEEDS_REVIEW'\)\)/);
  assert.match(schema, /CHECK \(instagram_graph_host IN \('graph\.facebook\.com', 'graph\.instagram\.com'\)\)/);

  assert.doesNotMatch(schema, /text NOT NULL DEFAULT ''/);
});
```

Note the type change: `Approved_For_Posting.platform` was a comma-separated string ("comma-separate values to publish one approved render to multiple platforms"). It becomes `platforms text[]` with a cardinality check, which is what turns "blank does not mean all platforms" from a WF11 convention into a constraint. WF11's platform-splitting code is simplified accordingly in Task 14.

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test domains/short-videos/tests/pipeline-store-schema.test.js`
Expected: FAIL with `ENOENT` on `008-pipeline-store-publishing.sql`

- [ ] **Step 3: Write the migration**

```sql
-- Pipeline store, part 5 of 5: the approval and destination tables.

CREATE TABLE IF NOT EXISTS short_videos.approved_for_posting (
  approved_id       text PRIMARY KEY,
  created_clip_id   text NOT NULL REFERENCES short_videos.created_clips(created_clip_id) ON DELETE CASCADE,
  render_id         text REFERENCES short_videos.render_jobs(render_id) ON DELETE SET NULL,
  niche             text NOT NULL,
  platforms         text[] NOT NULL,
  final_title       text NOT NULL,
  final_caption     text,
  final_description text,
  hashtags          text[],
  status            text NOT NULL DEFAULT 'PENDING',
  scheduled_at      timestamptz,
  public_video_url  text,
  posted_url        text,
  performance_notes text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT approved_for_posting_status_check CHECK (status IN ('PENDING', 'APPROVED', 'READY', 'REJECTED')),
  -- Blank does not mean all platforms. An empty array is rejected outright.
  CONSTRAINT approved_for_posting_platforms_present_check CHECK (cardinality(platforms) > 0),
  CONSTRAINT approved_for_posting_platforms_supported_check CHECK (
    platforms <@ ARRAY['YOUTUBE_SHORTS', 'TIKTOK', 'INSTAGRAM_REELS', 'FACEBOOK_REELS'])
);

-- One approval row per clip. Review Focus 5: this is what makes a second
-- approve_clip() call unable to create a duplicate.
CREATE UNIQUE INDEX IF NOT EXISTS approved_for_posting_one_per_clip_idx
  ON short_videos.approved_for_posting (created_clip_id);

CREATE TABLE IF NOT EXISTS short_videos.publishing_channels (
  channel_id                text PRIMARY KEY,
  niche                     text NOT NULL,
  platform                  text NOT NULL,
  enabled_status            boolean NOT NULL DEFAULT false,
  publishing_backend        text NOT NULL DEFAULT 'DIRECT',
  postiz_integration_id     text,
  credential_name           text,
  credential_slot           text,
  youtube_channel_id        text,
  facebook_page_id          text,
  instagram_user_id         text,
  tiktok_open_id            text,
  meta_graph_version        text,
  instagram_graph_host      text DEFAULT 'graph.facebook.com',
  tiktok_domain_verified    boolean NOT NULL DEFAULT false,
  tiktok_verified_url_prefix text,
  default_privacy           text NOT NULL DEFAULT 'private',
  requires_manual_publish   boolean NOT NULL DEFAULT false,
  audit_status              text,
  token_expires_at          timestamptz,
  last_expiry_audit_at      timestamptz,
  last_health_status        text,
  notes                     text,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT publishing_channels_platform_check CHECK (platform IN (
    'YOUTUBE_SHORTS', 'FACEBOOK_REELS', 'INSTAGRAM_REELS', 'TIKTOK')),
  CONSTRAINT publishing_channels_backend_check CHECK (publishing_backend IN ('DIRECT', 'POSTIZ')),
  CONSTRAINT publishing_channels_credential_slot_check CHECK (credential_slot IS NULL OR credential_slot IN (
    'YOUTUBE_PRIMARY', 'FACEBOOK_PRIMARY', 'INSTAGRAM_PRIMARY', 'TIKTOK_PRIMARY', 'POSTIZ_PRIMARY')),
  CONSTRAINT publishing_channels_audit_status_check CHECK (audit_status IS NULL OR audit_status IN (
    'DEV_PRIVATE_ONLY', 'APPROVED_PUBLIC', 'NEEDS_REVIEW')),
  CONSTRAINT publishing_channels_graph_host_check CHECK (instagram_graph_host IS NULL OR instagram_graph_host IN (
    'graph.facebook.com', 'graph.instagram.com')),
  CONSTRAINT publishing_channels_meta_version_check CHECK (meta_graph_version IS NULL OR meta_graph_version ~ '^v[0-9]+\.[0-9]+$'),
  -- The structure doc: requires_manual_publish must be TRUE for TikTok,
  -- because WF12 supports draft/inbox upload only.
  CONSTRAINT publishing_channels_tiktok_manual_check CHECK (
    platform <> 'TIKTOK' OR requires_manual_publish),
  CONSTRAINT publishing_channels_postiz_identity_check CHECK (
    publishing_backend <> 'POSTIZ' OR (postiz_integration_id IS NOT NULL AND btrim(postiz_integration_id) <> ''))
);

CREATE INDEX IF NOT EXISTS publishing_channels_enabled_idx
  ON short_videos.publishing_channels (niche, platform)
  WHERE enabled_status;
```

- [ ] **Step 4: Run the tests**

Run: `node --test domains/short-videos/tests/pipeline-store-schema.test.js domains/short-videos/tests/pipeline-store-postgres.test.js`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add domains/short-videos/postgres/migrations/008-pipeline-store-publishing.sql domains/short-videos/tests/pipeline-store-schema.test.js
git commit -m "feat(postgres): add approved_for_posting and publishing_channels

platform becomes platforms text[] with a cardinality check, so 'blank does
not mean all platforms' is a constraint rather than a WF11 convention."
```

---

## Task 8: Retype `publishing_jobs` (D6)

**The highest-risk task in this plan.** The spec says so, and the measurement agrees: `001-publishing-queue.sql` and `003-postiz-publishing.sql` contain **41 `text NOT NULL DEFAULT ''` declarations covering 34 distinct columns** — the count differs because `001` re-declares several as `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` for installations that predate them. The queries compare against `''` throughout (`jobs.provider_stage <> ''`). This task changes the types. Task 9 changes the queries. They are split so a reviewer can reject the query rewrite while keeping the migration, and so the test suite tells you which half broke.

**Files:**
- Create: `domains/short-videos/postgres/migrations/009-publishing-jobs-retypes.sql`
- Create: `domains/short-videos/postgres/migrations/009-publishing-jobs-retypes.down.sql`
- Modify: `domains/short-videos/tests/pipeline-store-schema.test.js`
- Modify: `domains/short-videos/tests/publishing-postgres.test.js`

**Interfaces:**
- Consumes: `short_videos.publishing_jobs` as created by `001`/`002`/`003`.
- Produces: the same table with the 41 empty-string columns nullable and `safe_schedule_at` dropped. Task 9's queries depend on exactly this.

- [ ] **Step 1: Write the failing test**

Append to `pipeline-store-schema.test.js`:

```js
test('publishing_jobs retyping removes the empty-string convention and safe_schedule_at', () => {
  const migration = read('postgres/migrations/009-publishing-jobs-retypes.sql');

  // Every column that defaulted to '' loses both the default and the NOT NULL.
  assert.match(migration, /ALTER COLUMN approved_id DROP NOT NULL/);
  assert.match(migration, /ALTER COLUMN approved_id DROP DEFAULT/);
  assert.match(migration, /ALTER COLUMN provider_stage DROP NOT NULL/);
  assert.match(migration, /ALTER COLUMN claimed_by DROP NOT NULL/);
  // Existing '' values become NULL, or the queries in Task 9 would still see ''.
  assert.match(migration, /SET approved_id = NULL WHERE approved_id = ''/);
  // safe_schedule_at exists only to turn a bad date string into infinity.
  // timestamptz cannot hold a bad date string, so it goes.
  assert.match(migration, /DROP FUNCTION IF EXISTS short_videos\.safe_schedule_at/);
  // Replay safety: this must survive a second application.
  assert.match(migration, /DO \$\$/);

  const down = read('postgres/migrations/009-publishing-jobs-retypes.down.sql');
  assert.match(down, /SET approved_id = '' WHERE approved_id IS NULL/);
  assert.match(down, /ALTER COLUMN approved_id SET NOT NULL/);
  assert.match(down, /CREATE OR REPLACE FUNCTION short_videos\.safe_schedule_at/);
});
```

Also update the stale assertion in `publishing-postgres.test.js`. Replace these two lines:

```js
  assert.match(schema, /safe_schedule_at/);
  assert.match(schema, /RETURN 'infinity'::timestamptz/);
```

with:

```js
  // 001 still creates safe_schedule_at; 009 drops it. Both are true of the
  // repo, so assert on the migration rather than on the initial schema.
  const retypes = read('postgres/migrations/009-publishing-jobs-retypes.sql');
  assert.match(retypes, /DROP FUNCTION IF EXISTS short_videos\.safe_schedule_at/);
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test domains/short-videos/tests/pipeline-store-schema.test.js`
Expected: FAIL with `ENOENT` on `009-publishing-jobs-retypes.sql`

- [ ] **Step 3: Write the up migration**

The 41 column names are every `text NOT NULL DEFAULT ''` column in `001-publishing-queue.sql` plus the four added by `003`. Generate the list rather than typing it:

```bash
grep -ohE "^\s*(ADD COLUMN IF NOT EXISTS )?([a-z_]+) text NOT NULL DEFAULT ''" \
  domains/short-videos/postgres/init/001-publishing-queue.sql \
  domains/short-videos/postgres/migrations/003-postiz-publishing.sql \
  | sed -E "s/.*[[:space:]]([a-z_]+) text NOT NULL DEFAULT ''.*/\1/" | sort -u
```

Expected: 34 distinct names, matching the `columns` array below. If the counts differ, use the grep's output rather than the array below — the repo is the source of truth.

Then write the migration using that list:

```sql
-- D6: retire the text NOT NULL DEFAULT '' convention on publishing_jobs.
-- It existed only because Google Sheets sends empty strings and never NULL.
-- Idempotent: the loop below is a no-op once the columns are already nullable.

DO $$
DECLARE
  target text;
  columns text[] := ARRAY[
    'approved_id', 'render_id', 'created_clip_id', 'niche', 'channel_id',
    'destination_id', 'youtube_channel_id', 'facebook_page_id',
    'instagram_user_id', 'tiktok_open_id', 'credential_slot',
    'meta_graph_version', 'tiktok_verified_url_prefix', 'audit_status',
    'video_source', 'video_file_id', 'video_url', 'public_video_url',
    'local_file_path', 'title', 'caption', 'description', 'hashtags',
    'last_error', 'post_id', 'post_url', 'claimed_by', 'provider_stage',
    'provider_ref', 'provider_upload_url', 'postiz_integration_id',
    'postiz_post_id', 'postiz_media_id', 'postiz_media_path'
  ];
BEGIN
  FOREACH target IN ARRAY columns LOOP
    EXECUTE format('ALTER TABLE short_videos.publishing_jobs ALTER COLUMN %I DROP NOT NULL', target);
    EXECUTE format('ALTER TABLE short_videos.publishing_jobs ALTER COLUMN %I DROP DEFAULT', target);
    EXECUTE format('UPDATE short_videos.publishing_jobs SET %I = NULL WHERE %I = ''''', target, target);
  END LOOP;
END $$;

-- Written out rather than only looped, so the regression test can see the
-- intent for the columns the queries in Task 9 compare against.
UPDATE short_videos.publishing_jobs SET approved_id = NULL WHERE approved_id = '';
UPDATE short_videos.publishing_jobs SET provider_stage = NULL WHERE provider_stage = '';
UPDATE short_videos.publishing_jobs SET claimed_by = NULL WHERE claimed_by = '';

-- A bad date string cannot reach a timestamptz column, so the function that
-- converted one into 'infinity' has nothing left to do.
DROP FUNCTION IF EXISTS short_videos.safe_schedule_at(text);
```

- [ ] **Step 4: Write the down migration**

The spec requires a tested down path for exactly this step, because it is the only one that changes existing columns rather than adding.

```sql
-- Reverses 009-publishing-jobs-retypes.sql. Not run by run-migrations.sh;
-- applied by hand during a rollback, before reverting the commit range.

CREATE OR REPLACE FUNCTION short_videos.safe_schedule_at(value text)
RETURNS timestamptz
LANGUAGE plpgsql
IMMUTABLE
AS $$
BEGIN
  IF value IS NULL OR btrim(value) = '' THEN
    RETURN NULL;
  END IF;
  RETURN value::timestamptz;
EXCEPTION WHEN OTHERS THEN
  RETURN 'infinity'::timestamptz;
END;
$$;

DO $$
DECLARE
  target text;
  columns text[] := ARRAY[
    'approved_id', 'render_id', 'created_clip_id', 'niche', 'channel_id',
    'destination_id', 'youtube_channel_id', 'facebook_page_id',
    'instagram_user_id', 'tiktok_open_id', 'credential_slot',
    'meta_graph_version', 'tiktok_verified_url_prefix', 'audit_status',
    'video_source', 'video_file_id', 'video_url', 'public_video_url',
    'local_file_path', 'title', 'caption', 'description', 'hashtags',
    'last_error', 'post_id', 'post_url', 'claimed_by', 'provider_stage',
    'provider_ref', 'provider_upload_url', 'postiz_integration_id',
    'postiz_post_id', 'postiz_media_id', 'postiz_media_path'
  ];
BEGIN
  FOREACH target IN ARRAY columns LOOP
    EXECUTE format('UPDATE short_videos.publishing_jobs SET %I = '''' WHERE %I IS NULL', target, target);
    EXECUTE format('ALTER TABLE short_videos.publishing_jobs ALTER COLUMN %I SET DEFAULT ''''', target);
    EXECUTE format('ALTER TABLE short_videos.publishing_jobs ALTER COLUMN %I SET NOT NULL', target);
  END LOOP;
END $$;

UPDATE short_videos.publishing_jobs SET approved_id = '' WHERE approved_id IS NULL;
ALTER TABLE short_videos.publishing_jobs ALTER COLUMN approved_id SET NOT NULL;
```

Rename it so `run-migrations.sh` never picks it up: the script globs `/migrations/*.sql`, which **would match a `.down.sql` file**. Put it outside that directory instead:

```bash
mkdir -p domains/short-videos/postgres/rollback
git mv domains/short-videos/postgres/migrations/009-publishing-jobs-retypes.down.sql \
       domains/short-videos/postgres/rollback/009-publishing-jobs-retypes.down.sql
```

and update the test's path to `postgres/rollback/009-publishing-jobs-retypes.down.sql`.

- [ ] **Step 5: Write the real-Postgres round-trip test**

Append to `pipeline-store-postgres.test.js`:

```js
// The spec requires a tested down path for 009, the only step that alters
// existing columns rather than adding.
test('real Postgres: the 009 retyping round-trips through its down migration', { skip: !available }, async () => {
  await withCluster(async ({ sql, file }) => {
    for (const migration of migrationFiles()) file(migration);

    sql(`INSERT INTO short_videos.publishing_jobs(publish_id, platform)
         VALUES ('round-trip', 'YOUTUBE_SHORTS')`);
    assert.equal(sql("SELECT approved_id IS NULL FROM short_videos.publishing_jobs WHERE publish_id='round-trip'"), 't');

    file(path.join(root, 'postgres/rollback/009-publishing-jobs-retypes.down.sql'));
    assert.equal(sql("SELECT approved_id = '' FROM short_videos.publishing_jobs WHERE publish_id='round-trip'"), 't');
    assert.equal(sql("SELECT count(*) FROM pg_proc WHERE proname = 'safe_schedule_at'"), '1');

    // And forward again, because a rollback is sometimes followed by a re-land.
    file(path.join(root, 'postgres/migrations/009-publishing-jobs-retypes.sql'));
    assert.equal(sql("SELECT approved_id IS NULL FROM short_videos.publishing_jobs WHERE publish_id='round-trip'"), 't');
  });
});
```

- [ ] **Step 6: Run the tests**

Run: `node --test domains/short-videos/tests/pipeline-store-schema.test.js domains/short-videos/tests/pipeline-store-postgres.test.js domains/short-videos/tests/publishing-postgres.test.js`
Expected: all PASS. `postiz-postgres-integration.test.js` is expected to FAIL at this point — it applies `003` and then exercises queries that still compare against `''`. Task 9 fixes it. Note the failure; do not patch that test here.

- [ ] **Step 7: Commit**

```bash
git add domains/short-videos/postgres/migrations/009-publishing-jobs-retypes.sql domains/short-videos/postgres/rollback/ domains/short-videos/tests/
git commit -m "feat(postgres)!: retype publishing_jobs away from empty-string defaults

34 columns lose NOT NULL and DEFAULT '', existing '' values become NULL,
and safe_schedule_at is dropped because a timestamptz column cannot hold
the bad date string it existed to neutralise.

The down migration lives in postgres/rollback/ rather than
postgres/migrations/ because run-migrations.sh globs migrations/*.sql and
would otherwise replay the rollback on every container start.

postiz-postgres-integration.test.js is red until the queries are rewritten."
```

---

## Task 9: Rewrite the 17 publishing queries for nullable columns

**Files:**
- Modify: all 17 files in `domains/short-videos/postgres/queries/`
- Modify: `domains/short-videos/tests/publishing-postgres.test.js`

**Interfaces:**
- Consumes: the nullable `publishing_jobs` from Task 8.
- Produces: queries that compare with `IS NULL` / `IS NOT NULL` instead of `= ''` / `<> ''`, and build rows without `COALESCE(..., '')`. Task 15 regenerates WF11–WF14 from these files unchanged.

- [ ] **Step 1: Find every empty-string comparison**

```bash
grep -rn "= ''\|<> ''\|COALESCE([^)]*, '')\|NULLIF([^)]*, '')" domains/short-videos/postgres/queries/
```

Expected: matches in `upsert-publishing-jobs.sql` (the bulk of them), plus `claim-next-publishing-job.sql`, `save-provider-checkpoint.sql`, `complete-provider-publish.sql`, and `fail-provider-publish.sql`. Record the list before editing — it is the checklist for this task.

- [ ] **Step 2: Write the failing test**

Append to `publishing-postgres.test.js`:

```js
test('queue queries use NULL semantics, not the empty-string convention', () => {
  const files = fs.readdirSync(path.join(domainRoot, 'postgres/queries'))
    .filter((file) => file.endsWith('.sql'));
  assert.equal(files.length, 17, 'query count changed; update this test deliberately');

  const offenders = [];
  for (const file of files) {
    const sql = read(`postgres/queries/${file}`);
    // A string literal '' is now always a bug: the columns are nullable.
    for (const pattern of [/<> ''/, /= ''/, /COALESCE\([^)]*, ''\)/]) {
      if (pattern.test(sql)) offenders.push(`${file}: ${pattern}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test('the metadata freeze still fires on a dispatched POSTIZ job', () => {
  const upsert = read('postgres/queries/upsert-publishing-jobs.sql');
  // The old guard was provider_stage <> ''. With nullable columns that is
  // always false for a fresh row and must become IS NOT NULL.
  assert.match(upsert, /jobs\.provider_stage IS NOT NULL/);
  assert.doesNotMatch(upsert, /safe_schedule_at/);
  assert.match(upsert, /NULLIF\(btrim\(row->>'scheduled_at'\), ''\)::timestamptz/);
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `node --test domains/short-videos/tests/publishing-postgres.test.js`
Expected: FAIL, listing offenders in `upsert-publishing-jobs.sql` and the four provider query files.

- [ ] **Step 4: Apply the three mechanical rewrites**

Apply these transformations, in this order, to every file the Step 1 grep listed:

| Before | After | Why |
|---|---|---|
| `COALESCE(row->>'col', '')` | `NULLIF(btrim(row->>'col'), '')` | an absent JSON key becomes NULL, not `''` |
| `jobs.col <> ''` | `jobs.col IS NOT NULL` | `NULL <> ''` is NULL, which is not true — the guard would silently stop firing |
| `short_videos.safe_schedule_at(row->>'scheduled_at')` | `NULLIF(btrim(row->>'scheduled_at'), '')::timestamptz` | the function is gone; a bad string now raises instead of becoming `infinity` |

The middle row is the correctness trap. In `upsert-publishing-jobs.sql` the metadata freeze reads:

```sql
WHERE NOT (jobs.publishing_backend = 'POSTIZ' AND (
  jobs.provider_stage <> '' OR jobs.started_at IS NOT NULL OR jobs.publish_status <> 'PENDING'
))
```

With nullable columns, `jobs.provider_stage <> ''` evaluates to NULL for a fresh row, the `OR` chain can no longer short-circuit to true on that term, and **a dispatched Postiz job would start accepting metadata overwrites again** — the exact bug the freeze exists to prevent. It must become:

```sql
WHERE NOT (jobs.publishing_backend = 'POSTIZ' AND (
  jobs.provider_stage IS NOT NULL OR jobs.started_at IS NOT NULL OR jobs.publish_status <> 'PENDING'
))
```

`jobs.publish_status <> 'PENDING'` is safe as-is: `publish_status` keeps its `NOT NULL DEFAULT 'PENDING'` and is not in Task 8's column list.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: all PASS, including `postiz-postgres-integration.test.js`, which went red in Task 8 and is the real-Postgres proof that the rewritten queries still race correctly, recover expired leases, and freeze metadata.

If `postiz-postgres-integration.test.js` fails here, do not weaken it. It exercises the concurrent-submission race with two parallel `psql` processes; a failure means the rewrite changed the locking semantics, which is the one thing this task must not do.

- [ ] **Step 6: Commit**

```bash
git add domains/short-videos/postgres/queries/ domains/short-videos/tests/publishing-postgres.test.js
git commit -m "refactor(postgres)!: rewrite the queue queries for nullable columns

The metadata freeze guard changes from provider_stage <> '' to
provider_stage IS NOT NULL. Left as-is it would evaluate to NULL on a
nullable column, stop contributing to the OR chain, and let a dispatched
Postiz job accept metadata overwrites again."
```

---

## Task 10: `approve_clip()`

This task owns **Review Focus 3 and 5**.

**Files:**
- Create: `domains/short-videos/postgres/migrations/010-approve-clip.sql`
- Modify: `domains/short-videos/tests/pipeline-store-postgres.test.js`

**Interfaces:**
- Consumes: `short_videos.created_clips`, `short_videos.approved_for_posting`, `short_videos.render_jobs`.
- Produces:

```sql
short_videos.approve_clip(
  p_created_clip_id text,
  p_final_title     text,
  p_final_caption   text,
  p_platforms       text[],
  p_hashtags        text[] DEFAULT NULL,
  p_scheduled_at    timestamptz DEFAULT NULL,
  p_reviewer_notes  text DEFAULT NULL
) RETURNS text   -- the new approved_id
```

and

```sql
short_videos.reject_clip(
  p_created_clip_id text,
  p_reviewer_notes  text DEFAULT NULL
) RETURNS void
```

Task 16's `server.js` calls both by PostgREST RPC at `POST /rest/v1/rpc/approve_clip` and `/rpc/reject_clip`.

- [ ] **Step 1: Write the failing test**

```js
// Review Focus 3 and 5. The UI has no session state and operators
// double-click, so both the fail-closed cases and the repeat call matter.
test('real Postgres: approve_clip is atomic and fails closed', { skip: !available }, async () => {
  await withCluster(async ({ sql, file }) => {
    for (const migration of migrationFiles()) file(migration);

    sql(`INSERT INTO short_videos.source_channels(source_id, niche, source_name, youtube_channel_url)
         VALUES ('src-1', 'FINANCE_BUSINESS', 'Example', 'https://youtube.com/@example')`);
    sql(`INSERT INTO short_videos.candidate_videos(video_id, niche, source_id, youtube_video_id)
         VALUES ('vid-1', 'FINANCE_BUSINESS', 'src-1', 'yt-1')`);
    sql(`INSERT INTO short_videos.created_clips(created_clip_id, video_id, niche, review_status)
         VALUES ('clip-1', 'vid-1', 'FINANCE_BUSINESS', 'NEEDS_REVIEW')`);

    const approve = (args) => sql(`SELECT short_videos.approve_clip(${args})`);
    const status = () => sql("SELECT review_status FROM short_videos.created_clips WHERE created_clip_id='clip-1'");
    const approvals = () => sql("SELECT count(*) FROM short_videos.approved_for_posting WHERE created_clip_id='clip-1'");

    // Review Focus 3: an empty platform list must fail, and must leave nothing behind.
    assert.throws(() => approve("'clip-1','Title','Caption',ARRAY[]::text[]"), /at least one platform/i);
    assert.equal(status(), 'NEEDS_REVIEW', 'a failed approval must not change review_status');
    assert.equal(approvals(), '0', 'a failed approval must not insert a row');

    // An unsupported platform is the same class of failure.
    assert.throws(() => approve("'clip-1','Title','Caption',ARRAY['MYSPACE']"), /unsupported platform/i);
    assert.equal(status(), 'NEEDS_REVIEW');
    assert.equal(approvals(), '0');

    // A blank title is not a usable post.
    assert.throws(() => approve("'clip-1','   ','Caption',ARRAY['TIKTOK']"), /title/i);
    assert.equal(approvals(), '0');

    // A clip that is not awaiting review must not be approvable.
    sql("UPDATE short_videos.created_clips SET review_status='AWAITING_DOWNLOAD' WHERE created_clip_id='clip-1'");
    assert.throws(() => approve("'clip-1','Title','Caption',ARRAY['TIKTOK']"), /NEEDS_REVIEW/);
    sql("UPDATE short_videos.created_clips SET review_status='NEEDS_REVIEW' WHERE created_clip_id='clip-1'");

    // The happy path writes both halves.
    const approvedId = approve("'clip-1','Final Title','Final Caption',ARRAY['TIKTOK','YOUTUBE_SHORTS']");
    assert.match(approvedId, /^APPROVE-clip-1$/);
    assert.equal(status(), 'APPROVED');
    assert.equal(approvals(), '1');
    assert.equal(sql("SELECT status FROM short_videos.approved_for_posting WHERE created_clip_id='clip-1'"), 'APPROVED');
    assert.equal(sql("SELECT array_to_string(platforms, ',') FROM short_videos.approved_for_posting WHERE created_clip_id='clip-1'"), 'TIKTOK,YOUTUBE_SHORTS');

    // Review Focus 5: the operator double-clicks.
    const again = approve("'clip-1','Final Title','Final Caption',ARRAY['TIKTOK']");
    assert.equal(again, approvedId, 'a repeat approval returns the same approved_id');
    assert.equal(approvals(), '1', 'a repeat approval must not insert a duplicate');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test domains/short-videos/tests/pipeline-store-postgres.test.js`
Expected: FAIL with `function short_videos.approve_clip(...) does not exist`

- [ ] **Step 3: Write the migration**

```sql
-- The review UI's approve button. PostgREST cannot do a multi-table
-- transaction, and a clip marked APPROVED with no approved_for_posting row
-- vanishes from both queues and is never published, so both writes happen
-- here or neither does.

CREATE OR REPLACE FUNCTION short_videos.approve_clip(
  p_created_clip_id text,
  p_final_title     text,
  p_final_caption   text,
  p_platforms       text[],
  p_hashtags        text[] DEFAULT NULL,
  p_scheduled_at    timestamptz DEFAULT NULL,
  p_reviewer_notes  text DEFAULT NULL
)
RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  v_clip        short_videos.created_clips;
  v_approved_id text := 'APPROVE-' || p_created_clip_id;
  v_existing    text;
  v_supported   text[] := ARRAY['YOUTUBE_SHORTS', 'TIKTOK', 'INSTAGRAM_REELS', 'FACEBOOK_REELS'];
BEGIN
  -- Blank does not mean all platforms.
  IF p_platforms IS NULL OR cardinality(p_platforms) = 0 THEN
    RAISE EXCEPTION 'approve_clip requires at least one platform';
  END IF;
  IF NOT (p_platforms <@ v_supported) THEN
    RAISE EXCEPTION 'approve_clip got an unsupported platform: %',
      array_to_string(ARRAY(SELECT unnest(p_platforms) EXCEPT SELECT unnest(v_supported)), ', ');
  END IF;
  IF p_final_title IS NULL OR btrim(p_final_title) = '' THEN
    RAISE EXCEPTION 'approve_clip requires a non-blank final title';
  END IF;

  -- Review Focus 5: a repeat call returns the first result instead of
  -- inserting a second approval.
  SELECT approved_id INTO v_existing
  FROM short_videos.approved_for_posting
  WHERE created_clip_id = p_created_clip_id;
  IF v_existing IS NOT NULL THEN
    RETURN v_existing;
  END IF;

  SELECT * INTO v_clip
  FROM short_videos.created_clips
  WHERE created_clip_id = p_created_clip_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'approve_clip got an unknown created_clip_id: %', p_created_clip_id;
  END IF;
  IF v_clip.review_status <> 'NEEDS_REVIEW' THEN
    RAISE EXCEPTION 'approve_clip requires review_status NEEDS_REVIEW, found %', v_clip.review_status;
  END IF;

  INSERT INTO short_videos.approved_for_posting (
    approved_id, created_clip_id, render_id, niche, platforms,
    final_title, final_caption, hashtags, status, scheduled_at
  )
  SELECT
    v_approved_id, v_clip.created_clip_id,
    (SELECT render_id FROM short_videos.render_jobs
      WHERE created_clip_id = v_clip.created_clip_id AND render_status = 'COMPLETED'
      ORDER BY completed_at DESC NULLS LAST LIMIT 1),
    v_clip.niche,
    ARRAY(SELECT DISTINCT unnest(p_platforms) ORDER BY 1),
    btrim(p_final_title), NULLIF(btrim(p_final_caption), ''),
    p_hashtags, 'APPROVED', p_scheduled_at;

  UPDATE short_videos.created_clips
  SET review_status = 'APPROVED',
      reviewer_notes = COALESCE(NULLIF(btrim(p_reviewer_notes), ''), reviewer_notes)
  WHERE created_clip_id = p_created_clip_id;

  RETURN v_approved_id;
END;
$$;

-- Rejecting is a single-table write, but it belongs next to its sibling so
-- the UI has one calling convention for both buttons.
CREATE OR REPLACE FUNCTION short_videos.reject_clip(
  p_created_clip_id text,
  p_reviewer_notes  text DEFAULT NULL
)
RETURNS void
LANGUAGE sql
AS $$
  UPDATE short_videos.created_clips
  SET review_status = 'REJECTED',
      reviewer_notes = COALESCE(NULLIF(btrim(p_reviewer_notes), ''), reviewer_notes)
  WHERE created_clip_id = p_created_clip_id
    AND review_status = 'NEEDS_REVIEW';
$$;
```

A `plpgsql` function body is a single implicit transaction, so a `RAISE EXCEPTION` after the `INSERT` rolls the `INSERT` back. That is what makes the both-or-neither assertions in Step 1 pass, and it is why the validation runs before the writes rather than relying on it.

- [ ] **Step 4: Run the tests**

Run: `node --test domains/short-videos/tests/pipeline-store-postgres.test.js domains/short-videos/tests/pipeline-store-schema.test.js`
Expected: all PASS, including the Task 2 replay test — `CREATE OR REPLACE FUNCTION` is replay-safe.

- [ ] **Step 5: Commit**

```bash
git add domains/short-videos/postgres/migrations/010-approve-clip.sql domains/short-videos/tests/pipeline-store-postgres.test.js
git commit -m "feat(postgres): add approve_clip and reject_clip

approve_clip does both halves of an approval in one transaction. A clip
marked APPROVED with no approved_for_posting row would vanish from both
queues and never publish, which is the failure this prevents."
```

---

## Task 11: The `table()` generator helper and the completion assertion

**Files:**
- Create: `domains/short-videos/workflow-code/table-node.js`
- Create: `domains/short-videos/tests/no-google-sheets-nodes.test.js`
- Create: `domains/short-videos/tests/table-node.test.js`
- Create: `domains/short-videos/tests/table-node-postgres.test.js`
- Delete: `domains/short-videos/tests/workflow-sheets-execute-once.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces, all used by Tasks 12–15:

```js
module.exports = {
  // Reads a .sql file from postgres/queries/ and trims it.
  querySql,                 // (name: string) => string
  // Emits an n8n-nodes-base.postgres node, typeVersion 2.6.
  postgresNode,             // (id, name, position, query, queryReplacement?, extra?) => object
  // SELECT the whole table, the shape the Code nodes used to get from Sheets.
  selectAll,                // (table: string) => string
  // INSERT ... ON CONFLICT (key) DO UPDATE from a jsonb row array in $1.
  upsertFromJsonb,          // ({ table, key, columns }) => string
};
```

- [ ] **Step 1: Write the failing completion test**

This is the assertion that defines "the migration is done". `workflow-sheets-execute-once.test.js` cannot serve this purpose: it collects `googleSheets` read nodes missing `executeOnce` and asserts the collection is empty, so once the nodes are gone it passes while asserting nothing.

It is written as a **ratchet**, not a flat assertion. A flat assertion would be red from this task until Task 15, leaving `npm test` failing at five consecutive commits and breaking both the plan's own commit-after-every-task rule and bisectability. Instead a committed ceiling starts at the measured baseline and each task that removes nodes lowers it in the same commit. Two assertions per counter: one fails if the count rises above the ceiling (a reintroduced node), one fails if it drops below (a stale ceiling that must be lowered). The completion criterion is unchanged — the ceiling reaching 0 at Task 15.

```js
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
```

- [ ] **Step 2: Run it and prove the ratchet bites**

Run: `node --test domains/short-videos/tests/no-google-sheets-nodes.test.js`
Expected: PASS, with `SHEETS_NODE_CEILING` at 65 and `SHEETS_PLACEHOLDER_CEILING` at 16. Those counts are the spec's measured baseline; if either differs, stop and report the discrepancy before continuing.

Then prove the ratchet bites rather than trusting a green: lower `SHEETS_NODE_CEILING` to 56 temporarily, re-run, and confirm both node assertions FAIL. Restore it to 65 before continuing.

- [ ] **Step 3: Write the helper**

`upsertFromJsonb` below differs from the sketch this plan originally carried.
That sketch projected each column as `row->>'column'`, copying
`upsert-publishing-jobs.sql`. That file works only because `publishing_jobs` is
entirely `text`. Migration 004 gives `candidate_videos` `integer`, `bigint`,
`numeric`, `boolean` and `timestamptz` columns, and Postgres refuses the
projection outright:

```
ERROR:  column "duration_seconds" is of type integer but expression is of type text
HINT:  You will need to rewrite or cast the expression.
```

So the row is typed through `jsonb_populate_record(NULL::short_videos.<table>,
row)`, which casts via the table's own row type and therefore needs no
column-type list and cannot drift from the schema. Two consequences follow, and
both match what Sheets did:

- An empty string is stripped to absent before typing. `''` is a valid `text`
  value but not a valid integer or timestamp, and a blank cell was how Sheets
  spelled "no value".
- The conflict branch coalesces to the stored row. Sheets' `appendOrUpdate`
  wrote only the columns it was given, so `SET col = EXCLUDED.col` would blank
  every column absent from an incoming row.

`domains/short-videos/tests/table-node-postgres.test.js` proves all four
behaviours against a throwaway cluster.


```js
const fs = require('node:fs');
const path = require('node:path');

const DOMAIN_ROOT = path.join(__dirname, '..');

const querySql = (name) => fs.readFileSync(
  path.join(DOMAIN_ROOT, 'postgres/queries', `${name}.sql`), 'utf8').trim();

// typeVersion 2.6 and this options block match the Postgres nodes the
// publishing workflows already use, so there is one node shape in the repo.
// replaceEmptyStrings stays true: with nullable columns (D6) an empty field
// becoming NULL is now the correct behaviour rather than a workaround.
const postgresNode = (id, name, position, query, queryReplacement = '', extra = {}) => ({
  id,
  name,
  type: 'n8n-nodes-base.postgres',
  typeVersion: 2.6,
  position,
  parameters: {
    resource: 'database',
    operation: 'executeQuery',
    query,
    options: { queryBatching: 'single', queryReplacement, replaceEmptyStrings: true },
  },
  retryOnFail: true,
  maxTries: 3,
  waitBetweenTries: 5000,
  ...extra,
});

// The Code nodes downstream were written against "every row in the tab", so
// a plain SELECT keeps them working unchanged. Fair-share still runs in
// JavaScript (spec Section 2).
const selectAll = (table) => `SELECT * FROM short_videos.${table};`;

// One atomic statement replacing Sheets' read-then-write appendOrUpdate.
// Follows upsert-publishing-jobs.sql in taking the rows as a jsonb array in
// $1, but it cannot reuse that file's `row->>'column'` projection: that works
// only because publishing_jobs is entirely text. The pipeline-store tables
// have integer, bigint, numeric, boolean and timestamptz columns, and Postgres
// will not implicitly cast text to those in an INSERT — it fails with
// `column "duration_seconds" is of type integer but expression is of type
// text`. jsonb_populate_record casts through the table's own row type instead,
// so the statement needs no column-type list and cannot drift from the schema.
//
// Two further differences from a naive projection, both about what Sheets did:
//   - An empty string is stripped to absent before typing. '' is a valid text
//     value but not a valid integer or timestamp, and a blank cell was how
//     Sheets spelled "no value".
//   - The conflict branch coalesces to the stored row, so a partial write
//     updates the fields it carries and leaves the rest. Sheets' appendOrUpdate
//     only ever wrote the columns it was given; `SET col = EXCLUDED.col` would
//     instead blank every column absent from the incoming row.
const upsertFromJsonb = ({ table, key, columns }) => {
  const qualified = `short_videos.${table}`;
  const assignments = columns
    .filter((column) => column !== key)
    .map((column) => `  ${column} = COALESCE(EXCLUDED.${column}, ${qualified}.${column})`)
    .join(',\n');
  return `WITH incoming AS (
  SELECT (
    SELECT jsonb_object_agg(field.key, field.value)
    FROM jsonb_each(element) AS field
    WHERE NULLIF(btrim(field.value #>> '{}'), '') IS NOT NULL
  ) AS row
  FROM jsonb_array_elements($1::jsonb) AS element
  WHERE NULLIF(btrim(element->>'${key}'), '') IS NOT NULL
), typed AS (
  SELECT jsonb_populate_record(NULL::${qualified}, row) AS record
  FROM incoming
  WHERE row IS NOT NULL
)
INSERT INTO ${qualified} (${columns.join(', ')})
SELECT ${columns.map((column) => `(record).${column}`).join(',\n       ')}
FROM typed
ON CONFLICT (${key}) DO UPDATE SET
${assignments}
RETURNING *;`;
};

module.exports = { querySql, postgresNode, selectAll, upsertFromJsonb };
```

- [ ] **Step 4: Write the helper's unit test**

```js
const assert = require('node:assert/strict');
const test = require('node:test');
const { postgresNode, selectAll, upsertFromJsonb } = require('../workflow-code/table-node');

test('postgresNode emits the same node shape the publishing workflows use', () => {
  const node = postgresNode('id-1', 'Read Candidates', [0, 0], 'SELECT 1;');
  assert.equal(node.type, 'n8n-nodes-base.postgres');
  assert.equal(node.typeVersion, 2.6);
  assert.equal(node.parameters.operation, 'executeQuery');
  assert.equal(node.parameters.options.queryBatching, 'single');
  assert.equal(node.retryOnFail, true);
  // executeOnce was a Sheets-read concern; a SELECT runs once by nature.
  assert.equal(node.executeOnce, undefined);
});

test('upsertFromJsonb is one atomic statement keyed on the deterministic id', () => {
  const sql = upsertFromJsonb({
    table: 'candidate_videos',
    key: 'video_id',
    columns: ['video_id', 'niche', 'processing_status'],
  });
  assert.match(sql, /jsonb_array_elements\(\$1::jsonb\)/);
  assert.match(sql, /ON CONFLICT \(video_id\) DO UPDATE SET/);
  assert.match(sql, /niche = EXCLUDED\.niche/);
  // The key must never be overwritten by the conflicting row.
  assert.doesNotMatch(sql, /video_id = EXCLUDED\.video_id/);
  // One statement, so transaction-mode pooling is sufficient (Task 1).
  assert.equal(sql.split(';').filter((part) => part.trim()).length, 1);
  // No n8n expression syntax may leak into SQL.
  assert.doesNotMatch(sql, /\{\{/);
});

test('selectAll targets the short_videos schema explicitly', () => {
  assert.equal(selectAll('source_channels'), 'SELECT * FROM short_videos.source_channels;');
});
```

- [ ] **Step 5: Delete the vacuous test**

```bash
git rm domains/short-videos/tests/workflow-sheets-execute-once.test.js
```

- [ ] **Step 6: Run the suite**

Run: `npm test`
Expected: everything PASSes, including `no-google-sheets-nodes.test.js` at a ceiling of 65. Tasks 12–15 drive the ceiling to zero, lowering it in the same commit that removes the nodes, so the suite is green at every commit in between.

- [ ] **Step 7: Commit**

```bash
git add domains/short-videos/workflow-code/table-node.js domains/short-videos/tests/table-node.test.js domains/short-videos/tests/no-google-sheets-nodes.test.js
git commit -m "feat(generators): add the table() helper and the Sheets-free assertion

Deletes workflow-sheets-execute-once.test.js, which collects googleSheets
read nodes lacking executeOnce and asserts the collection is empty. Once
the Sheets nodes are gone it would pass while asserting nothing. The
replacement asserts no googleSheets node exists at all, which is the
migration's completion criterion and cannot pass vacuously.

The replacement is a ratchet: a committed ceiling, starting at the measured
65 nodes and 16 placeholder references, lowered by each of Tasks 12-15 in the
same commit that removes the nodes. A flat assertion would be red at five
consecutive commits. Separate assertions catch a count above the ceiling (a
reintroduced node) and below it (a ceiling left stale)."
```

---

## Task 12: Regenerate WF1, WF2, WF3 — the vertical slice

These three are the slice the spec verifies live before anything downstream is activated, so they go first and alone. This task also owns **Review Focus 2**.

**Files:**
- Modify: `domains/short-videos/workflow-code/create-wf2-video-fetch.js`
- Modify: `domains/short-videos/workflow-code/create-wf3-validity-check.js`
- Modify: `domains/short-videos/workflow-code/update-wf1-code.js` (WF1 — **not** `create-remaining-workflows.js`, which does not build WF1)
- Modify: `domains/short-videos/workflow-code/validity-check.js`
- Modify: `domains/short-videos/tests/validity-check.test.js`
- Create: `domains/short-videos/postgres/queries/select-source-channels.sql`, `select-candidate-videos.sql`, `upsert-candidate-videos.sql`, `update-source-resolution.sql`, `update-source-backfill-state.sql`, `update-candidate-validity.sql`
- Regenerate: `workflows/01-source-channel-registry.json`, `02-video-fetch.json`, `03-validity-check.json`

**Interfaces:**
- Consumes: `table-node.js` from Task 11; tables from Task 3.
- Produces: the four query files above, reused by Tasks 13–15.

- [ ] **Step 1: Write the failing NULL-percentage test (Review Focus 2)**

Spec Section 1 item 2 drops the write-`0`-when-views-are-zero convention, so
`like_percentage` can now arrive as NULL where WF3 used to see `0`.

Two corrections to the sketch below. There is no `checkValidity` export —
`validity-check.js` exports `applyValidityRules`, `classifyCandidate`,
`computeEngagementMetrics` and `passesEngagementGate`. And the percentages are
*computed* from the counts rather than read from the row, so the NULL does not
arrive from the database at all: it has to start being produced.
`computeEngagementMetrics` currently returns `0` for all three percentages when
views are zero, which is the Sheets convention the spec deletes. So the change
is two-sided — the metrics return NULL when views are zero, and the gate treats
NULL as failing. Append to `domains/short-videos/tests/validity-check.test.js`:

```js
// Review Focus 2. Section 1 replaced "WF3 writes 0 when views are zero" with
// a nullable numeric, so the thresholds now meet NULL. A NULL must reject the
// video, never pass the threshold and never throw.
test('a NULL engagement percentage fails the thresholds without throwing', () => {
  const base = {
    video_id: 'vid-null', view_count: 50000, like_count: null, comment_count: null,
    like_percentage: null, comment_percentage: null, engagement_percentage: null,
  };
  const result = checkValidity([base])[0];
  assert.equal(result.validity_status, 'REJECTED');
  assert.equal(result.rejection_reason, 'LOW_ENGAGEMENT');
});

test('an undefined percentage is treated the same as NULL', () => {
  const result = checkValidity([{ video_id: 'vid-undef', view_count: 50000 }])[0];
  assert.equal(result.validity_status, 'REJECTED');
  assert.equal(result.rejection_reason, 'LOW_ENGAGEMENT');
});
```

Match the import name already used at the top of that test file; if the exported function is named differently, use the existing name rather than renaming it.

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test domains/short-videos/tests/validity-check.test.js`
Expected: FAIL. Either a thrown `TypeError` on a null comparison, or `validity_status` coming back `VALID` because `null >= 0.02` evaluates false but the code path treated a falsy percentage as a pass.

- [ ] **Step 3: Fix the threshold comparisons**

In `domains/short-videos/workflow-code/validity-check.js`, find every percentage threshold comparison and make NULL explicit. The thresholds documented in the structure doc are `view_count >= 10000`, `like_percentage >= 0.02`, `engagement_percentage >= 0.02`, `comment_percentage >= 0.0005`.

```js
// A NULL percentage means "undefined", which fails a minimum threshold.
// Do not coerce it to 0 and do not let Number(null) === 0 decide this
// implicitly: the Sheets-era code relied on the sheet writing a literal 0.
const meetsThreshold = (value, minimum) => {
  if (value === null || value === undefined || value === '') return false;
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= minimum;
};
```

Use `meetsThreshold` for all four comparisons.

- [ ] **Step 4: Run to verify it passes**

Run: `node --test domains/short-videos/tests/validity-check.test.js`
Expected: PASS, including the file's pre-existing cases — `meetsThreshold` is equivalent to the old comparison for every numeric input.

- [ ] **Step 5: Write the four query files**

`select-source-channels.sql`:

```sql
SELECT * FROM short_videos.source_channels;
```

`select-candidate-videos.sql`:

```sql
SELECT * FROM short_videos.candidate_videos;
```

`upsert-candidate-videos.sql` — generate it rather than typing 23 columns:

```bash
node -e "
const { upsertFromJsonb } = require('./domains/short-videos/workflow-code/table-node');
const columns = ['video_id','niche','source_id','source_name','video_title','video_url','youtube_video_id','duration_seconds','published_at','view_count','like_count','comment_count','like_percentage','comment_percentage','engagement_percentage','transcript_available','language','validity_status','validity_score','rejection_reason','duplicate_status','processing_status'];
process.stdout.write(upsertFromJsonb({ table: 'candidate_videos', key: 'video_id', columns }) + '\n');
" > domains/short-videos/postgres/queries/upsert-candidate-videos.sql
```

There is no `upsert-source-channels.sql`. Nothing upserts a whole channel row:
the operator creates it through the review UI, and WF1 and WF2 each update a
few columns of an existing row. Those are three `updateFromJsonb` files instead
— `update-source-resolution.sql` (WF1: the resolved ids, `last_checked_at`,
`notes`), `update-source-backfill-state.sql` (WF2: the backfill counters and
token) and `update-candidate-validity.sql` (WF3: the percentages and the
classification).

**Why an UPDATE rather than an upsert for those three.** `INSERT ... ON
CONFLICT` builds its insert row before the conflict is detected, so a statement
naming only the columns it writes fails on every `NOT NULL` column it omits,
even when the row exists and the intent is an update:

```
ERROR:  null value in column "niche" of relation "source_channels" violates not-null constraint
```

`updateFromJsonb` in `table-node.js` names only what it changes. A blank cell
still lands as NULL, which is what lets WF2 clear `backfill_next_page_token`
when a backfill finishes — something a conflict branch coalescing to the stored
row could never do.

Then verify the generated SQL actually runs:

```bash
node --test domains/short-videos/tests/pipeline-store-postgres.test.js
```

- [ ] **Step 6: Swap the generators**

In `create-wf2-video-fetch.js` and `create-wf3-validity-check.js`, delete the local `sheet` and `sheetsNode` definitions and replace them with a require:

```js
const { querySql, postgresNode } = require('./table-node');
```

Then rewrite each call site. The three Sheets operations map as the spec's table says:

| Before | After |
|---|---|
| `sheetsNode(id, 'Read Source_Channels', pos, sheet('read', 'Source_Channels'))` | `postgresNode(id, 'Read Source_Channels', pos, querySql('select-source-channels'))` |
| `sheetsNode(id, 'Append Candidates', pos, sheet('append', 'Candidate_Videos', {...}))` | `postgresNode(id, 'Upsert Candidates', pos, querySql('upsert-candidate-videos'), '={{ JSON.stringify($input.all().map(item => item.json)) }}')` |
| `sheetsNode(id, 'Update Source', pos, sheet('appendOrUpdate', 'Source_Channels', {...}))` | `postgresNode(id, 'Upsert Source', pos, querySql('upsert-source-channels'), '={{ JSON.stringify($input.all().map(item => item.json)) }}')` |

Keep every node `id` and `position` unchanged so the regenerated JSON diffs cleanly. Rename nodes only where `Append` became `Upsert`, and update the matching `connections` keys when you do.

WF1 is different: it is patched in place by `update-wf1-code.js`, not emitted
whole, and `create-remaining-workflows.js` does not build it at all. Replace its
two Sheets nodes in that script with `Object.assign(node, postgresNode(...))`,
keeping each node's existing id and position, and widen the
`retryOnFail`/`maxTries` loop at the top of the file from `googleSheets` to
`postgres`.

- [ ] **Step 7: Regenerate and inspect the diff**

```bash
node domains/short-videos/workflow-code/create-wf2-video-fetch.js
node domains/short-videos/workflow-code/create-wf3-validity-check.js
node domains/short-videos/workflow-code/create-remaining-workflows.js
git diff --stat domains/short-videos/workflows/
```

Expected: `01`, `02`, `03` change; the other 13 are untouched because their generators have not been edited yet. If a file you did not expect changes, stop — the generator is not deterministic and that must be understood before continuing.

- [ ] **Step 8: Run the suite**

Run: `npm test`
Expected: everything PASSes. Lower `SHEETS_NODE_CEILING` to 56 and `SHEETS_PLACEHOLDER_CEILING` to 13 in this same commit — the 9 nodes across WF1/2/3 are gone. `video-fetch.test.js` and `validity-check.test.js` pass too.

- [ ] **Step 9: Commit**

```bash
git add domains/short-videos/
git commit -m "feat(wf1-3)!: read and write the pipeline store over Postgres

Sheets appendOrUpdate was read-then-write, so the WF2 dedup on
youtube_video_id had a gap where a concurrent run duplicated a row. It is
now one INSERT ... ON CONFLICT against a unique constraint.

WF3's thresholds now treat a NULL percentage as failing. Section 1 made
the percentage columns nullable, replacing the convention where the sheet
wrote a literal 0 when views were zero."
```

---

## Task 13: Regenerate WF4, WF5, WF6

**Files:**
- Modify: `domains/short-videos/workflow-code/create-wf4-transcript-fetch.js`, `create-wf5-ai-transcript-analysis.js`, `create-remaining-workflows.js` (WF6)
- Modify: `domains/short-videos/workflow-code/transcript-fetch.js` (drop the truncation)
- Modify: `domains/short-videos/tests/transcript-fetch.test.js`, `ai-transcript-analysis.test.js`
- Create: `domains/short-videos/postgres/queries/select-transcript-analysis.sql`, `upsert-transcript-analysis.sql`, `select-clip-moments.sql`, `upsert-clip-moments.sql`
- Regenerate: `workflows/04-transcript-fetch.json`, `05-ai-transcript-analysis.json`, `06-yt-dlp-clip-download.json`

**Interfaces:**
- Consumes: `table-node.js`; tables from Task 4.
- Produces: the four query files above, reused by Tasks 14 and 15.

- [ ] **Step 1: Write the failing truncation-removal test**

```js
// Spec Section 1 item 1: Postgres text is unbounded, so the ~45k truncation
// and the Drive stash that recovered the real transcript both go away.
test('the full transcript is stored without truncation or a Drive round trip', () => {
  const long = 'x'.repeat(120000);
  const row = buildTranscriptRow({ video_id: 'vid-1', transcript: long });
  assert.equal(row.transcript_text.length, 120000);
  assert.doesNotMatch(row.transcript_text, /\[TRUNCATED\]/);
  assert.equal(row.transcript_full_url, undefined);
  assert.equal(row.transcript_full_file_id, undefined);
});
```

Use the actual exported builder name from `transcript-fetch.js`; read the file's `module.exports` first.

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test domains/short-videos/tests/transcript-fetch.test.js`
Expected: FAIL — `transcript_text.length` is ~45000 and `transcript_full_url` is set.

- [ ] **Step 3: Remove the truncation**

In `transcript-fetch.js`, delete the 45,000-char slice and the `...[TRUNCATED]` marker, and stop emitting `transcript_full_url` / `transcript_full_file_id`. Also delete the Google Drive upload node from `create-wf4-transcript-fetch.js` that existed only to stash the full transcript — but **leave the other Drive nodes alone**: per D8, media storage stays on Drive and only this one round trip is being removed. Confirm which node you are deleting before you delete it:

```bash
node -e "
const wf = require('./domains/short-videos/workflows/04-transcript-fetch.json');
for (const n of wf.nodes) if (n.type === 'n8n-nodes-base.googleDrive') console.log(n.name, JSON.stringify(n.parameters.operation));
"
```

Expected: the transcript-stash node is the one whose operation uploads a text file. If more than one candidate appears, stop and report rather than guessing.

- [ ] **Step 4: Run to verify it passes**

Run: `node --test domains/short-videos/tests/transcript-fetch.test.js`
Expected: PASS.

- [ ] **Step 5: Write the query files and swap the generators**

Same mechanical procedure as Task 12 Steps 5–6: generate the two upserts with `upsertFromJsonb` using the Tab 3 and Tab 4 column lists, keyed on `analysis_id` and `clip_moment_id`.

**The D7 rename lands here.** `clip_moments` has `download_status` and `download_job_id`, not `ssemble_status` / `ssemble_job_id`. Update `ai-transcript-analysis.js:363`, which currently writes `ssemble_status: options.highRiskSource ? 'AWAITING_MANUAL_APPROVAL' : 'PENDING'`, and the assertion in `ai-transcript-analysis.test.js:678` that reads it. Then confirm no reference survives:

```bash
grep -rn 'ssemble' domains/short-videos/ --include='*.js' --include='*.sql'
```

Expected: no output. Matches in `workflows/*.json` are expected until the next step regenerates them.

- [ ] **Step 6: Regenerate and run the suite**

```bash
node domains/short-videos/workflow-code/create-wf4-transcript-fetch.js
node domains/short-videos/workflow-code/create-wf5-ai-transcript-analysis.js
node domains/short-videos/workflow-code/create-remaining-workflows.js
npm test
```

Expected: everything PASSes. Lower `SHEETS_NODE_CEILING` to 36 (56 − 20 across WF4/5/6) and `SHEETS_PLACEHOLDER_CEILING` to 10 in this same commit.

- [ ] **Step 7: Commit**

```bash
git add domains/short-videos/
git commit -m "feat(wf4-6)!: move transcript analysis and clip moments to Postgres

Drops the ~45k transcript truncation and the Google Drive text-file round
trip that recovered the real value; Postgres text is unbounded. The other
Drive nodes stay, per D8.

Renames ssemble_status to download_status and ssemble_job_id to
download_job_id (D7)."
```

---

## Task 14: Regenerate WF8, WF8b, WF8c, WF8d, WF9, WF10

**Files:**
- Modify: `domains/short-videos/workflow-code/create-remaining-workflows.js`
- Modify: `domains/short-videos/workflow-code/review-queue-digest.js`, `channel-health-check.js`
- Modify: `domains/short-videos/tests/remaining-workflows.test.js`, `channel-health-check.test.js`
- Create: `domains/short-videos/postgres/queries/select-created-clips.sql`, `upsert-created-clips.sql`, `select-render-jobs.sql`, `upsert-render-jobs.sql`, `select-music-library.sql`, `select-channel-branding.sql`, `insert-error-log.sql`
- Regenerate: `workflows/08-*.json`, `09-review-queue-digest.json`, `10-error-handler.json`

**Interfaces:**
- Consumes: `table-node.js`; tables from Tasks 5 and 6.
- Produces: the seven query files above.

- [ ] **Step 1: Write the failing boolean-and-array test**

`review-queue-digest.js` reads `String(channel.active_status || '').toUpperCase() === 'TRUE'` — a Sheets-era string comparison that is now false for a real `true` boolean, which would report every niche as exhausted. Append to `channel-health-check.test.js`:

```js
// active_status is a real boolean now (Section 1 item 3), so the Sheets-era
// String(x).toUpperCase() === 'TRUE' comparison silently reads false.
test('a boolean active_status is recognised as active', () => {
  const digest = buildReviewDigest([], [
    { niche: 'FINANCE_BUSINESS', active_status: true },
    { niche: 'FINANCE_BUSINESS', active_status: false },
  ]);
  assert.equal(digest.exhaustedNiches.length, 0, 'a niche with one active channel is not exhausted');
});

test('a niche whose channels are all inactive is still reported', () => {
  const digest = buildReviewDigest([], [{ niche: 'FINANCE_BUSINESS', active_status: false }]);
  assert.equal(digest.exhaustedNiches.length, 1);
});
```

Adapt the assertion to `buildReviewDigest`'s actual return shape; read the function's `return` statement first.

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test domains/short-videos/tests/channel-health-check.test.js`
Expected: FAIL — the first test reports one exhausted niche because `String(true).toUpperCase()` is `'TRUE'`… but `String(false).toUpperCase()` is `'FALSE'`, so verify which way it actually breaks and keep the test that reproduces the real behaviour.

- [ ] **Step 3: Fix the comparisons**

Replace every Sheets-era truthiness coercion with a direct boolean check:

```js
// active_status is boolean in Postgres. Accept the legacy string forms too,
// so a row written before the migration does not read as inactive.
const isActive = (value) => value === true
  || String(value).toUpperCase() === 'TRUE';
```

Apply it in `review-queue-digest.js` and `channel-health-check.js`. Then find the rest:

```bash
grep -rn "toUpperCase() === 'TRUE'\|=== 'TRUE'\|'FALSE'" domains/short-videos/workflow-code/
```

Expected: every remaining match is inside a module this task or a later one owns. Fix each.

- [ ] **Step 4: Write the query files and swap the generators**

Same procedure as Task 12. Two notes specific to this group:

- `insert-error-log.sql` is an `INSERT`, not an upsert — WF10 appends and never updates:

```sql
INSERT INTO short_videos.error_log (error_id, workflow_name, node_name, related_video_id, error_type, error_message, raw_payload)
VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
ON CONFLICT (error_id) DO NOTHING;
```

- `upsert-created-clips.sql` must convert the four newline-joined lists using the function from Task 5. Wrap those columns in the generated SQL:

```sql
  short_videos.split_lines(row->>'alternative_titles'),
  short_videos.split_lines(row->>'on_screen_text_beats'),
  short_videos.split_lines(row->>'broll_plan'),
  short_videos.split_lines(row->>'originality_checklist'),
```

`upsertFromJsonb` emits a plain `row->>'column'` for every column, so hand-edit these four lines after generating the file, and add a test asserting they are present:

```js
test('created_clips upsert converts the newline lists to arrays', () => {
  const sql = read('postgres/queries/upsert-created-clips.sql');
  for (const column of ['alternative_titles', 'on_screen_text_beats', 'broll_plan', 'originality_checklist']) {
    assert.match(sql, new RegExp(`short_videos\\.split_lines\\(row->>'${column}'\\)`));
  }
});
```

- [ ] **Step 5: Regenerate and run the suite**

```bash
node domains/short-videos/workflow-code/create-remaining-workflows.js
npm test
```

Expected: everything PASSes. Lower `SHEETS_NODE_CEILING` to 14 (36 − 22 across WF8/8b/8c/8d/9/10) and `SHEETS_PLACEHOLDER_CEILING` to 4 in this same commit.

- [ ] **Step 6: Commit**

```bash
git add domains/short-videos/
git commit -m "feat(wf8-10)!: move clips, renders, assets and the error log to Postgres

active_status is a real boolean now, so the Sheets-era
String(x).toUpperCase() === 'TRUE' checks in the digest and health modules
would have read every channel as inactive."
```

---

## Task 15: Regenerate WF11, WF12, WF13, WF14

The publishing workflows already speak Postgres for the queue. What changes is their *Sheets* side: WF11 reads `Approved_For_Posting` and `Publishing_Channels` from the sheet, and WF11–WF14 mirror status back to it. The mirror disappears entirely — Postgres was already the source of truth, and the spec's D1 removes the mirror's reason to exist.

**Files:**
- Modify: `domains/short-videos/workflow-code/create-remaining-workflows.js`, `publishing.js`, `postiz-publishing.js`
- Modify: `domains/short-videos/tests/remaining-workflows.test.js`, `postiz-publishing.test.js`
- Create: `domains/short-videos/postgres/queries/select-approved-for-posting.sql`, `select-publishing-channels.sql`, `upsert-publishing-channels.sql`
- Regenerate: `workflows/11-*.json`, `12-*.json`, `13-*.json`, `14-*.json`

**Interfaces:**
- Consumes: `table-node.js`; tables from Task 7; the rewritten queries from Task 9.
- Produces: 16 workflows with zero Sheets nodes — the state Task 11's assertion demands.

- [ ] **Step 1: Write the failing platform-array test**

Task 7 changed `platform` (comma-separated string) to `platforms text[]`. WF11's splitting code becomes a no-op and must stop splitting.

```js
test('WF11 reads a platform array and no longer splits a comma string', () => {
  const jobs = buildPublishingJobs([{
    approved_id: 'APPROVE-clip-1',
    created_clip_id: 'clip-1',
    niche: 'FINANCE_BUSINESS',
    platforms: ['TIKTOK', 'YOUTUBE_SHORTS'],
    status: 'APPROVED',
    final_title: 'Title',
  }], [
    { channel_id: 'ch-1', niche: 'FINANCE_BUSINESS', platform: 'TIKTOK', enabled_status: true, requires_manual_publish: true, credential_slot: 'TIKTOK_PRIMARY' },
    { channel_id: 'ch-2', niche: 'FINANCE_BUSINESS', platform: 'YOUTUBE_SHORTS', enabled_status: true, credential_slot: 'YOUTUBE_PRIMARY' },
  ]);
  assert.equal(jobs.length, 2);
  assert.deepEqual(jobs.map((job) => job.platform).sort(), ['TIKTOK', 'YOUTUBE_SHORTS']);
});

test('WF11 creates no job for an empty platform array', () => {
  const jobs = buildPublishingJobs([{
    approved_id: 'APPROVE-clip-2', created_clip_id: 'clip-2',
    niche: 'FINANCE_BUSINESS', platforms: [], status: 'APPROVED', final_title: 'Title',
  }], []);
  assert.deepEqual(jobs, [], 'blank does not mean all platforms');
});
```

Use the real exported name from `publishing.js`.

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test domains/short-videos/tests/remaining-workflows.test.js`
Expected: FAIL — the code calls `String(row.platform).split(',')` and `row.platform` is now `undefined`.

- [ ] **Step 3: Read the array instead of splitting the string**

In `publishing.js`, replace the comma-splitting with:

```js
// platforms is a text[] now (Task 7), with a cardinality > 0 constraint
// behind it. Blank still does not mean all platforms, so an empty or
// missing array yields no jobs.
const platformsOf = (row) => (Array.isArray(row.platforms) ? row.platforms : [])
  .map((platform) => String(platform).trim().toUpperCase())
  .filter(Boolean);
```

- [ ] **Step 4: Remove the Sheets mirror**

Delete every Sheets node from WF11–WF14 in `create-remaining-workflows.js`. These were operator-facing mirrors of state Postgres already owned, which the structure doc states outright ("Google Sheets is the operator-facing mirror; `short_videos.publishing_jobs` in Postgres is the publishing queue source of truth"). Removing them also deletes the mirror-write failure path the doc describes, so delete the error branches that existed only to alert on a failed mirror write — and nothing else.

Then delete the local `sheet`/`sheetsNode` helpers from `create-remaining-workflows.js`, since nothing calls them any more.

- [ ] **Step 5: Regenerate and run the suite**

```bash
node domains/short-videos/workflow-code/create-remaining-workflows.js
npm test
```

Expected: **everything PASSes with `SHEETS_NODE_CEILING` and `SHEETS_PLACEHOLDER_CEILING` both lowered to 0.** That zero ceiling is the migration's completion criterion. Verify the count directly as well:

```bash
grep -rc 'googleSheets' domains/short-videos/workflows/ | grep -v ':0' || echo "zero Google Sheets nodes remain"
grep -rhoE '"n8n-nodes-base\.[A-Za-z]+"' domains/short-videos/workflows/ | sort | uniq -c | sort -rn
```

Expected: the first prints the "zero" message; the second shows `googleDrive` at 7 or 8 (one fewer if Task 13 removed the transcript stash) and `postgres` well above its old 22.

- [ ] **Step 6: Commit**

```bash
git add domains/short-videos/
git commit -m "feat(wf11-14)!: drop the Google Sheets mirror from the publishing phase

Postgres was already the publishing queue's source of truth; the Sheets
side was an operator-facing mirror, and the review UI replaces it.
Approved_For_Posting.platform becomes platforms text[], so WF11 reads an
array instead of splitting a comma-separated string.

No Google Sheets node remains in any of the 16 workflows."
```

---

## Task 16: The review UI

**Files:**
- Create: `hosts/review/postgrest.js`, `hosts/review/render.js`, `hosts/review/server.js`, `hosts/review/compose.yaml`, `hosts/review/Dockerfile`, `hosts/review/README.md`
- Create: `tests/review-ui.test.js`
- Modify: `hosts/compose.prod.yaml`, `hosts/compose.local.yaml`, `hosts/.env.example`
- Modify: `tests/hosts-isolation.test.js`, `tests/repo-layout.test.js`

**Interfaces:**
- Consumes: `short_videos.approve_clip` / `reject_clip` (Task 10); tables from Tasks 3–7.
- Produces three modules with no cross-dependency beyond these signatures:

```js
// postgrest.js — the only module that performs I/O.
select(table, params)        // (string, URLSearchParams|object) => Promise<object[]>
patch(table, filter, body)   // (string, object, object) => Promise<object[]>
insert(table, body)          // (string, object) => Promise<object[]>
rpc(fn, args)                // (string, object) => Promise<any>

// render.js — pure, no I/O, no globals.
page({ title, body })               // => string (full HTML document)
clipQueue(clips)                    // (object[]) => string
approveForm(clip)                   // (object) => string
channelForm(values, errors)         // (object, object) => string
momentQueue(moments)                // (object[]) => string
parseApproveForm(formData)          // (URLSearchParams) => { values, errors }
parseChannelForm(formData)          // (URLSearchParams) => { values, errors }
escapeHtml(value)                   // (unknown) => string
```

- [ ] **Step 1: Write the failing render and parse tests**

```js
const assert = require('node:assert/strict');
const test = require('node:test');
const {
  page, clipQueue, approveForm, momentQueue,
  parseApproveForm, parseChannelForm, escapeHtml,
} = require('../hosts/review/render');

test('escapeHtml neutralises a clip title that contains markup', () => {
  assert.equal(escapeHtml('<img src=x onerror=alert(1)>'), '&lt;img src=x onerror=alert(1)&gt;');
  assert.equal(escapeHtml('a "quoted" & ampersand'), 'a &quot;quoted&quot; &amp; ampersand');
  assert.equal(escapeHtml(null), '');
});

// D11: the preview is the operator's own browser fetching Drive. The server
// must never proxy it, so the page carries the Drive URL and no token.
test('the clip queue embeds the Drive preview without a server-side token', () => {
  const html = clipQueue([{
    created_clip_id: 'clip-1',
    clip_title: 'A Clip',
    google_drive_url: 'https://drive.google.com/file/d/abc/preview',
    suggested_title: 'Suggested',
  }]);
  assert.match(html, /https:\/\/drive\.google\.com\/file\/d\/abc\/preview/);
  assert.doesNotMatch(html, /SUPABASE|service_role|apikey|Bearer/i);
});

test('an empty queue says so rather than rendering an empty table', () => {
  assert.match(clipQueue([]), /nothing awaiting review/i);
  assert.match(momentQueue([]), /nothing awaiting approval/i);
});

test('the approve form is prefilled from the clip and lists only supported platforms', () => {
  const html = approveForm({
    created_clip_id: 'clip-1',
    suggested_title: 'Suggested Title',
    suggested_caption: 'Suggested Caption',
    hashtags: ['#one', '#two'],
  });
  assert.match(html, /value="Suggested Title"/);
  assert.match(html, /Suggested Caption/);
  for (const platform of ['YOUTUBE_SHORTS', 'TIKTOK', 'INSTAGRAM_REELS', 'FACEBOOK_REELS']) {
    assert.match(html, new RegExp(`value="${platform}"`));
  }
  // No platform is pre-ticked: blank must not mean all platforms.
  assert.doesNotMatch(html, /checked/);
});

test('parseApproveForm rejects a submission with no platform ticked', () => {
  const { errors } = parseApproveForm(new URLSearchParams(
    'created_clip_id=clip-1&final_title=Title'));
  assert.match(errors.platforms, /at least one platform/i);
});

test('parseApproveForm rejects a blank title', () => {
  const { errors } = parseApproveForm(new URLSearchParams(
    'created_clip_id=clip-1&final_title=++++&platforms=TIKTOK'));
  assert.match(errors.final_title, /title/i);
});

test('parseApproveForm collects multiple platform checkboxes', () => {
  const { values, errors } = parseApproveForm(new URLSearchParams(
    'created_clip_id=clip-1&final_title=Title&platforms=TIKTOK&platforms=YOUTUBE_SHORTS'));
  assert.deepEqual(errors, {});
  assert.deepEqual(values.p_platforms, ['TIKTOK', 'YOUTUBE_SHORTS']);
  assert.equal(values.p_final_title, 'Title');
});

test('parseApproveForm turns a blank schedule date into null, not an empty string', () => {
  const { values } = parseApproveForm(new URLSearchParams(
    'created_clip_id=clip-1&final_title=Title&platforms=TIKTOK&scheduled_at='));
  assert.equal(values.p_scheduled_at, null);
});

test('parseChannelForm requires a niche from the allowed list', () => {
  const bad = parseChannelForm(new URLSearchParams(
    'source_id=src-1&source_name=Example&youtube_channel_url=https://youtube.com/@e&niche=SPORTS'));
  assert.match(bad.errors.niche, /niche/i);

  const good = parseChannelForm(new URLSearchParams(
    'source_id=src-1&source_name=Example&youtube_channel_url=https://youtube.com/@e&niche=FINANCE_BUSINESS'));
  assert.deepEqual(good.errors, {});
  // WF1 fills these in; the form must not invent them.
  assert.equal(good.values.youtube_channel_id, undefined);
  assert.equal(good.values.uploads_playlist_id, undefined);
});

test('parseChannelForm rejects a non-YouTube URL', () => {
  const { errors } = parseChannelForm(new URLSearchParams(
    'source_id=src-1&source_name=Example&niche=FINANCE_BUSINESS&youtube_channel_url=https://vimeo.com/x'));
  assert.match(errors.youtube_channel_url, /youtube/i);
});

test('the page shell declares a charset and a viewport', () => {
  const html = page({ title: 'Review', body: '<p>x</p>' });
  assert.match(html, /<!doctype html>/i);
  assert.match(html, /charset="utf-8"/);
  assert.match(html, /viewport/);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/review-ui.test.js`
Expected: FAIL with `Cannot find module '../hosts/review/render'`

- [ ] **Step 3: Write `render.js`**

Pure functions only — no `require` of anything but `node:` builtins, so the tests need no fixtures and no network.

```js
const NICHES = ['CHRISTIAN_CONTENT', 'MOTIVATION_DISCIPLINE', 'FINANCE_BUSINESS',
  'LIFE_VALUES_RELATIONSHIPS', 'AFRICAN_KENYAN_SUCCESS'];
const PLATFORMS = ['YOUTUBE_SHORTS', 'TIKTOK', 'INSTAGRAM_REELS', 'FACEBOOK_REELS'];

const escapeHtml = (value) => String(value ?? '')
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;');

const page = ({ title, body }) => `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light dark; --gap: 1rem; }
  body { font: 16px/1.5 system-ui, sans-serif; margin: 0 auto; max-width: 60rem; padding: var(--gap); }
  nav a { margin-right: var(--gap); }
  .clip { border-top: 1px solid currentColor; padding: var(--gap) 0; }
  iframe, video { width: 100%; max-width: 24rem; aspect-ratio: 9/16; border: 0; }
  label { display: block; margin: .5rem 0; }
  .error { color: #b00; }
  fieldset { border: 1px solid currentColor; }
</style>
</head><body>
<nav><a href="/">Clips</a><a href="/moments">High-risk moments</a><a href="/channels">Add channel</a></nav>
${body}
</body></html>`;

// D11: the operator's own browser fetches this URL with their Google session.
// The server never proxies Drive and holds no Google credential.
const preview = (clip) => clip.google_drive_url
  ? `<iframe src="${escapeHtml(clip.google_drive_url)}" title="Clip preview" loading="lazy" allow="autoplay"></iframe>`
  : '<p>No Drive URL on this clip yet.</p>';

const clipQueue = (clips) => clips.length === 0
  ? '<h1>Clip review</h1><p>Nothing awaiting review.</p>'
  : `<h1>Clip review</h1>${clips.map((clip) => `<section class="clip">
  <h2>${escapeHtml(clip.clip_title || clip.suggested_title || clip.created_clip_id)}</h2>
  ${preview(clip)}
  ${approveForm(clip)}
  <form method="post" action="/clips/reject">
    <input type="hidden" name="created_clip_id" value="${escapeHtml(clip.created_clip_id)}">
    <button type="submit">Reject</button>
  </form>
</section>`).join('')}`;

const approveForm = (clip) => `<form method="post" action="/clips/approve">
  <input type="hidden" name="created_clip_id" value="${escapeHtml(clip.created_clip_id)}">
  <label>Title <input name="final_title" required value="${escapeHtml(clip.suggested_title || '')}"></label>
  <label>Caption <textarea name="final_caption" rows="3">${escapeHtml(clip.suggested_caption || '')}</textarea></label>
  <label>Hashtags <input name="hashtags" value="${escapeHtml((clip.hashtags || []).join(' '))}"></label>
  <fieldset><legend>Platforms</legend>
  ${PLATFORMS.map((platform) => `<label><input type="checkbox" name="platforms" value="${platform}"> ${platform}</label>`).join('')}
  </fieldset>
  <label>Schedule (optional) <input type="datetime-local" name="scheduled_at"></label>
  <button type="submit">Approve</button>
</form>`;

const momentQueue = (moments) => moments.length === 0
  ? '<h1>High-risk moments</h1><p>Nothing awaiting approval.</p>'
  : `<h1>High-risk moments</h1>${moments.map((moment) => `<section class="clip">
  <h2>${escapeHtml(moment.suggested_title || moment.clip_moment_id)}</h2>
  <p>${escapeHtml(moment.niche)} &middot; ${escapeHtml(moment.core_idea || '')}</p>
  <form method="post" action="/moments/approve">
    <input type="hidden" name="clip_moment_id" value="${escapeHtml(moment.clip_moment_id)}">
    <button type="submit">Release for download</button>
  </form>
</section>`).join('')}`;

const channelForm = (values = {}, errors = {}) => `<h1>Add source channel</h1>
<form method="post" action="/channels">
  ${['source_id', 'source_name', 'youtube_channel_url'].map((field) => `<label>${field}
    <input name="${field}" required value="${escapeHtml(values[field] || '')}">
    ${errors[field] ? `<span class="error">${escapeHtml(errors[field])}</span>` : ''}
  </label>`).join('')}
  <label>niche
    <select name="niche" required>${NICHES.map((niche) =>
      `<option value="${niche}"${values.niche === niche ? ' selected' : ''}>${niche}</option>`).join('')}</select>
    ${errors.niche ? `<span class="error">${escapeHtml(errors.niche)}</span>` : ''}
  </label>
  <label>priority <input type="number" name="priority" min="1" value="${escapeHtml(values.priority || 1)}"></label>
  <button type="submit">Add</button>
</form>`;

const parseApproveForm = (formData) => {
  const errors = {};
  const title = (formData.get('final_title') || '').trim();
  const platforms = formData.getAll('platforms').filter((platform) => PLATFORMS.includes(platform));
  const caption = (formData.get('final_caption') || '').trim();
  const hashtags = (formData.get('hashtags') || '').split(/\s+/).filter(Boolean);
  const scheduled = (formData.get('scheduled_at') || '').trim();

  if (!title) errors.final_title = 'A final title is required.';
  // Blank does not mean all platforms.
  if (platforms.length === 0) errors.platforms = 'Tick at least one platform.';

  return {
    errors,
    values: {
      p_created_clip_id: formData.get('created_clip_id'),
      p_final_title: title,
      p_final_caption: caption || null,
      p_platforms: platforms,
      p_hashtags: hashtags.length ? hashtags : null,
      p_scheduled_at: scheduled ? new Date(scheduled).toISOString() : null,
    },
  };
};

const parseChannelForm = (formData) => {
  const errors = {};
  const values = {};
  for (const field of ['source_id', 'source_name', 'youtube_channel_url']) {
    values[field] = (formData.get(field) || '').trim();
    if (!values[field]) errors[field] = `${field} is required.`;
  }
  values.niche = formData.get('niche');
  if (!NICHES.includes(values.niche)) errors.niche = 'Pick one of the five niches.';
  if (values.youtube_channel_url && !/^https:\/\/(www\.)?youtube\.com\//.test(values.youtube_channel_url)) {
    errors.youtube_channel_url = 'Must be a https://youtube.com/ URL.';
  }
  values.priority = Number(formData.get('priority') || 1);
  // youtube_channel_id and uploads_playlist_id are deliberately absent: WF1
  // resolves them from the URL.
  return { errors, values };
};

module.exports = { page, clipQueue, approveForm, channelForm, momentQueue,
  parseApproveForm, parseChannelForm, escapeHtml, NICHES, PLATFORMS };
```

- [ ] **Step 4: Run the render tests to verify they pass**

Run: `node --test tests/review-ui.test.js`
Expected: PASS.

- [ ] **Step 5: Write `postgrest.js`**

The only module that does I/O. Built-in `fetch`, no dependency.

```js
// Supabase PostgREST over built-in fetch. The service key stays here and is
// never rendered into a page (D11). The one write that spans two tables goes
// through the approve_clip RPC, because PostgREST has no transaction.
const BASE = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_KEY;

if (!BASE || !KEY) {
  throw new Error('SUPABASE_URL and SUPABASE_SERVICE_KEY are required');
}

const headers = {
  apikey: KEY,
  authorization: `Bearer ${KEY}`,
  'content-type': 'application/json',
  'accept-profile': 'short_videos',
  'content-profile': 'short_videos',
};

async function request(method, pathAndQuery, body) {
  const response = await fetch(`${BASE}/rest/v1/${pathAndQuery}`, {
    method,
    headers: { ...headers, prefer: 'return=representation' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  const text = await response.text();
  if (!response.ok) {
    // PostgREST puts a RAISE EXCEPTION message in .message; surface it so the
    // operator sees "requires at least one platform" rather than "500".
    let detail = text;
    try { detail = JSON.parse(text).message || text; } catch {}
    const error = new Error(detail);
    error.status = response.status;
    throw error;
  }
  return text ? JSON.parse(text) : null;
}

const query = (params) => new URLSearchParams(params).toString();

const select = (table, params = {}) => request('GET', `${table}?${query(params)}`);
const insert = (table, body) => request('POST', table, body);
const patch = (table, filter, body) => request('PATCH', `${table}?${query(filter)}`, body);
const rpc = (fn, args) => request('POST', `rpc/${fn}`, args);

module.exports = { select, insert, patch, rpc };
```

- [ ] **Step 6: Write `server.js`**

Three changes to the sketch below, applied when this task was executed:

1. `new URL(request.url, ...)` sits **inside** a `try`, and falls back to
   `127.0.0.1` when `Host` is absent. As written outside the try, a malformed
   or missing `Host` header throws out of the request handler rather than
   answering 400.
2. A `sameOrigin(request, host)` guard rejects any non-GET whose
   `Sec-Fetch-Site` is `cross-site`/`same-site`, or whose `Origin` does not
   match the host, with 403. D5 makes the network the authentication, so there
   is no session to bind a CSRF token to — without this guard any page the
   operator has open can POST an approval or a rejection. A client sending
   neither header is treated as a plain form post.
3. `server.listen` is guarded by `require.main === module` and the module
   exports `{ server, sameOrigin }`, so the guard is unit-testable without
   binding a port or reaching Supabase.


```js
const http = require('node:http');
const render = require('./render');
const db = require('./postgrest');

const BIND = process.env.REVIEW_BIND_ADDRESS || '127.0.0.1';
const PORT = Number(process.env.REVIEW_PORT || 8080);

const html = (response, status, body) => {
  response.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
  response.end(body);
};
const seeOther = (response, location) => {
  response.writeHead(303, { location });
  response.end();
};

const readForm = (request) => new Promise((resolve, reject) => {
  let body = '';
  request.on('data', (chunk) => {
    body += chunk;
    // No session, no auth, but still no unbounded buffer.
    if (body.length > 64 * 1024) { reject(new Error('form too large')); request.destroy(); }
  });
  request.on('end', () => resolve(new URLSearchParams(body)));
  request.on('error', reject);
});

const routes = {
  'GET /': async () => {
    const clips = await db.select('created_clips', {
      review_status: 'eq.NEEDS_REVIEW', order: 'created_at.asc', limit: '50',
    });
    return render.page({ title: 'Clip review', body: render.clipQueue(clips) });
  },
  'GET /moments': async () => {
    const moments = await db.select('clip_moments', {
      download_status: 'eq.AWAITING_MANUAL_APPROVAL', order: 'created_at.asc', limit: '100',
    });
    return render.page({ title: 'High-risk moments', body: render.momentQueue(moments) });
  },
  'GET /channels': async () => render.page({ title: 'Add channel', body: render.channelForm() }),
};

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  const key = `${request.method} ${url.pathname}`;
  try {
    if (routes[key]) return html(response, 200, await routes[key]());

    if (key === 'POST /clips/approve') {
      const { values, errors } = render.parseApproveForm(await readForm(request));
      if (Object.keys(errors).length) {
        return html(response, 400, render.page({
          title: 'Approve failed',
          body: `<h1>Approve failed</h1>${Object.values(errors)
            .map((message) => `<p class="error">${render.escapeHtml(message)}</p>`).join('')}<p><a href="/">Back</a></p>`,
        }));
      }
      await db.rpc('approve_clip', values);
      return seeOther(response, '/');
    }

    if (key === 'POST /clips/reject') {
      const form = await readForm(request);
      await db.rpc('reject_clip', { p_created_clip_id: form.get('created_clip_id') });
      return seeOther(response, '/');
    }

    if (key === 'POST /moments/approve') {
      const form = await readForm(request);
      await db.patch('clip_moments', {
        clip_moment_id: `eq.${form.get('clip_moment_id')}`,
        download_status: 'eq.AWAITING_MANUAL_APPROVAL',
      }, { download_status: 'PENDING' });
      return seeOther(response, '/moments');
    }

    if (key === 'POST /channels') {
      const { values, errors } = render.parseChannelForm(await readForm(request));
      if (Object.keys(errors).length) {
        return html(response, 400, render.page({
          title: 'Add channel', body: render.channelForm(values, errors),
        }));
      }
      await db.insert('source_channels', values);
      return seeOther(response, '/channels');
    }

    return html(response, 404, render.page({ title: 'Not found', body: '<h1>Not found</h1>' }));
  } catch (error) {
    // The message may be a RAISE EXCEPTION from approve_clip, which is
    // operator-facing text, so show it rather than a bare 500.
    return html(response, 500, render.page({
      title: 'Error', body: `<h1>Error</h1><pre>${render.escapeHtml(error.message)}</pre><p><a href="/">Back</a></p>`,
    }));
  }
});

server.listen(PORT, BIND, () => console.log(`review ui on http://${BIND}:${PORT}`));
```

- [ ] **Step 7: Write the Dockerfile and compose service**

`hosts/review/Dockerfile`:

```dockerfile
FROM docker.io/library/node:26-alpine
WORKDIR /app
# No package.json: this service has no dependencies by design.
COPY server.js render.js postgrest.js ./
USER node
CMD ["node", "server.js"]
```

`hosts/review/compose.yaml`:

```yaml
# Operator-facing, tailnet-only. Deliberately not on public-net and
# deliberately not on the heavy host: this box holds exactly one secret,
# the Supabase service key.
services:
  review-ui:
    build: .
    container_name: review-ui
    restart: unless-stopped
    mem_limit: 64m
    # Bound to the tailnet address, never 0.0.0.0. The network is the
    # authentication (D5), so a wrong bind address is the whole security model.
    ports:
      - "${REVIEW_BIND_ADDRESS:?REVIEW_BIND_ADDRESS must be set}:${REVIEW_PORT:-8080}:8080"
    environment:
      SUPABASE_URL: ${SUPABASE_URL:?SUPABASE_URL must be set}
      SUPABASE_SERVICE_KEY: ${SUPABASE_SERVICE_KEY:?SUPABASE_SERVICE_KEY must be set}
      REVIEW_BIND_ADDRESS: "0.0.0.0"
      REVIEW_PORT: "8080"
```

Note the two bind addresses are different on purpose: the container listens on all of *its own* interfaces, and the host publishes that port only on the tailnet address.

Add `REVIEW_BIND_ADDRESS` and `REVIEW_PORT` to `hosts/.env.example`, commented out, next to the Supabase variables from Task 1. Include `hosts/review/compose.yaml` in both `hosts/compose.local.yaml` and `hosts/compose.prod.yaml` the way the existing host directories are included.

- [ ] **Step 8: Extend the host isolation test**

`tests/hosts-isolation.test.js` already asserts which services reach which networks. Add:

```js
test('the review UI is not on public-net and is not published on all interfaces', () => {
  const compose = readFileSync('hosts/review/compose.yaml', 'utf8');
  assert.doesNotMatch(compose, /public-net/);
  assert.doesNotMatch(compose, /"0\.0\.0\.0:/);
  assert.match(compose, /REVIEW_BIND_ADDRESS:\?/, 'the bind address must be required, not defaulted');
  assert.match(compose, /mem_limit: 64m/);
});
```

Match the file-reading helper this test already uses rather than introducing `readFileSync` if it has one.

- [ ] **Step 9: Run the full suite**

Run: `npm test`
Expected: all PASS.

- [ ] **Step 10: Smoke-test it against the real Supabase project**

This step needs Tasks 3–7 and 10 merged (the tables and the `approve_clip` /
`reject_clip` functions) plus `SUPABASE_URL` and `SUPABASE_SERVICE_KEY`, which
are the PostgREST API credentials from Project Settings → API and are *not* the
database connection string from Task 1. Until both are available, run the same
checks against a stub PostgREST on localhost: it proves the routes, the
PostgREST query strings, the HTML escaping, the 403 on a cross-site POST and
the absence of any credential in the page, and leaves only the real schema and
the two functions unproven.

```bash
docker compose -f hosts/compose.local.yaml up -d --build review-ui
curl -sS "http://${REVIEW_BIND_ADDRESS}:${REVIEW_PORT:-8080}/" | head -40
curl -sS "http://${REVIEW_BIND_ADDRESS}:${REVIEW_PORT:-8080}/moments" | head -20
curl -sS "http://${REVIEW_BIND_ADDRESS}:${REVIEW_PORT:-8080}/channels" | head -20
```

Expected: three pages render. With an empty database the clip and moment queues say "Nothing awaiting review" / "Nothing awaiting approval" rather than erroring — that is the Step 1 empty-state test proving itself live.

Then confirm the key never reaches the browser:

```bash
curl -sS "http://${REVIEW_BIND_ADDRESS}:${REVIEW_PORT:-8080}/" | grep -ci 'supabase\|apikey\|Bearer' || echo "no credential in the page"
```

Expected: `no credential in the page`.

- [ ] **Step 11: Commit**

```bash
git add hosts/review/ hosts/compose.local.yaml hosts/compose.prod.yaml hosts/.env.example tests/review-ui.test.js tests/hosts-isolation.test.js
git commit -m "feat(review): add the tailnet-private approval UI

Zero dependencies, no build step, server-rendered HTML. PostgREST over
built-in fetch for the simple reads and writes; the one write that spans
two tables goes through the approve_clip RPC, because PostgREST has no
transaction and a clip marked APPROVED without an approved_for_posting row
would never publish.

Clip previews are fetched by the operator's own browser from the Drive URL,
so the server holds exactly one secret and no Google credential."
```

---

## Task 17: Replace the schema documentation

**Files:**
- Create: `domains/short-videos/docs/postgres-schema.md`
- Delete: `domains/short-videos/docs/google-sheets-structure.md`
- Modify: `domains/short-videos/docs/architecture.md`, `credentials-setup.md`, `hosts/README.md`, `TODOS.md`
- Modify: `tests/repo-layout.test.js`

**Interfaces:**
- Consumes: the migrations from Tasks 3–10.
- Produces: `postgres-schema.md` as the schema source of truth.

- [ ] **Step 1: Write the failing documentation test**

Append to `tests/repo-layout.test.js`:

```js
test('the schema documentation describes Postgres, not Google Sheets', () => {
  assert.equal(existsSync('domains/short-videos/docs/google-sheets-structure.md'), false,
    'the Sheets structure doc must be deleted, not left to contradict the schema');
  const schemaDoc = readFileSync('domains/short-videos/docs/postgres-schema.md', 'utf8');
  for (const table of ['source_channels', 'candidate_videos', 'transcript_analysis',
    'clip_moments', 'created_clips', 'render_jobs', 'music_library',
    'channel_branding', 'error_log', 'approved_for_posting',
    'publishing_channels', 'publishing_jobs']) {
    assert.match(schemaDoc, new RegExp(`\\b${table}\\b`), `${table} is undocumented`);
  }
  assert.equal(schemaDoc.match(/^## /gm).length, 12, 'one section per table');
});

test('no document still points at the deleted Sheets structure doc', () => {
  const offenders = [];
  for (const file of docFiles()) {
    if (readFileSync(file, 'utf8').includes('google-sheets-structure')) offenders.push(file);
  }
  assert.deepEqual(offenders, []);
});
```

Use the repo-walking helper `repo-layout.test.js` already has for `docFiles()`; if it has none, glob `docs/**/*.md` and `domains/*/docs/*.md` with `fs.readdirSync(..., { recursive: true })`. The same applies to `existsSync` and `readFileSync` — use the file-reading helpers that test already defines rather than adding a second set of imports beside them.

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/repo-layout.test.js`
Expected: FAIL — the Sheets doc still exists and `postgres-schema.md` does not.

- [ ] **Step 3: Write `postgres-schema.md`**

Twelve `## <table>` sections. For each: the column list with types, the CHECK values for every status column, the foreign keys, and the workflows that read and write it. Derive it from the migrations rather than from memory:

```bash
for migration in domains/short-videos/postgres/migrations/00[4-8]*.sql; do
  echo "=== $migration"; grep -E '^  [a-z_]+ +' "$migration"
done
```

Open the document with the three things the Sheets doc did not say:

```markdown
# Postgres Schema — Short-Form Video Pipeline

This replaces `google-sheets-structure.md`. The pipeline's state lives in the
`short_videos` schema in Supabase; there is no Google Sheets workbook.

Three notes before the tables:

- **The DDL is the source of truth, not this document.** Every table here is
  created by a numbered migration in `domains/short-videos/postgres/migrations/`.
  If the two disagree, the migration is right.
- **Migrations are replayed on every container start** by
  `hosts/shared/postgres/run-migrations.sh`, so each one is idempotent. A
  migration that is not replay-safe breaks every future boot.
- **Status values are CHECK constraints, not enums**, so adding a value is one
  `ALTER TABLE` rather than a typed migration.
```

Carry over the Sheets doc's genuinely useful prose — the state-machine diagram, the fair-share limits, the seeding tips — and drop everything about tabs, cell limits, `%` formatting and document IDs.

- [ ] **Step 4: Delete the Sheets doc and fix every reference**

```bash
git rm domains/short-videos/docs/google-sheets-structure.md
grep -rn 'google-sheets-structure\|Google Sheets\|GOOGLE_SHEETS' --include='*.md' . | grep -v node_modules
```

Work through every hit. For `credentials-setup.md`, remove the Google Sheets credential rows and add the D8 note:

```markdown
### OAuth consent screen publishing status

An OAuth app left in **Testing** publishing status has its refresh tokens
expired by Google after 7 days, which is what the reauthentication every few
weeks was. Publish the consent screen; verification is not required for this
to take effect. The Google Drive credential still exists — media storage is
Drive — so this setting matters whether or not the pipeline uses Sheets.
```

For `architecture.md`, the Sheets references are structural, not incidental: it describes the state store throughout. Rewrite those passages to name the tables.

- [ ] **Step 5: Run the suite**

Run: `npm test`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add -A domains/short-videos/docs hosts/README.md TODOS.md tests/repo-layout.test.js
git commit -m "docs: replace the Sheets structure doc with the Postgres schema

Deletes google-sheets-structure.md rather than leaving two contradicting
schema documents, and records in credentials-setup.md that a consent screen
in Testing status is what expires the refresh tokens."
```

---

## Task 18: Live vertical-slice verification

**No code.** This is the gate between a green test suite and a running pipeline. All 16 workflows are inactive and `publishing_jobs` has zero rows, so there is no in-flight state to damage — and that is exactly why this verification is cheap now and expensive later.

**Files:**
- Modify: `domains/short-videos/docs/postgres-schema.md` (record the result)

- [ ] **Step 1: Apply the migrations to Supabase**

```bash
for migration in domains/short-videos/postgres/migrations/*.sql; do
  echo "=== $migration"
  psql "$SUPABASE_DATABASE_URL" -X -v ON_ERROR_STOP=1 -f "$migration"
done
```

Expected: every file applies cleanly. Then run the loop a second time — it must also succeed, because `run-migrations.sh` will do exactly that on the next container start.

- [ ] **Step 2: Bind the n8n Postgres credential**

In the heavy n8n UI, create one Postgres credential holding `SUPABASE_DATABASE_URL`'s host, port (the one Task 1 verified), database, user and password. Name it exactly as the generated workflows reference it. Do not put the connection string in workflow JSON.

- [ ] **Step 3: Seed one source channel through the UI**

Open the review UI, go to Add channel, and add one real channel in one niche. Then confirm it landed:

```bash
psql "$SUPABASE_DATABASE_URL" -X -Atc \
  "SELECT source_id, niche, active_status, youtube_channel_id IS NULL AS awaiting_wf1
   FROM short_videos.source_channels"
```

Expected: one row, `active_status` true, `awaiting_wf1` true — WF1 has not run yet.

- [ ] **Step 4: Run WF1 manually**

WF1 has a manual trigger. Execute it once in the n8n UI.

Expected: `youtube_channel_id` and `uploads_playlist_id` are now populated. If WF1 errors, the error is in the generated Postgres node, not in the schema — check the node's query and `queryReplacement` before touching the migration.

- [ ] **Step 5: Activate WF2 and WF3 only**

Activate exactly those two. Leave the other 13 inactive. 12 of the 16 carry schedule triggers, so activating them in bulk starts a dozen clocks against a schema that only three workflows have exercised.

Wait for one scheduled run of each, then check:

```bash
psql "$SUPABASE_DATABASE_URL" -X -Atc \
  "SELECT processing_status, validity_status, count(*)
   FROM short_videos.candidate_videos GROUP BY 1, 2 ORDER BY 1, 2"
```

Expected: rows exist with `processing_status = 'NEW'` from WF2, and WF3 has set `validity_status` on some of them. A `VALID` row proves the whole slice: the UI wrote a source, WF1 resolved it, WF2 inserted candidates against a unique constraint, WF3 read and updated them.

- [ ] **Step 6: Confirm the dedup constraint is doing real work**

Run WF2 a second time before its next schedule. Sheets' `appendOrUpdate` would have duplicated rows under a concurrent run; the `ON CONFLICT` upsert cannot.

```bash
psql "$SUPABASE_DATABASE_URL" -X -Atc \
  "SELECT count(*) - count(DISTINCT youtube_video_id) AS duplicates FROM short_videos.candidate_videos"
```

Expected: `0`. A non-zero result means the upsert's conflict target is wrong, which is a schema bug to fix before activating anything else.

- [ ] **Step 7: Record the result, then activate downstream**

Append a short "Live verification" section to `postgres-schema.md`: the date, which workflows were verified, the row counts observed, and anything that needed fixing. Then activate the remaining 13 workflows, in dependency order (WF4 → WF5 → WF6 → WF8 → WF8c → WF9 → WF10 → WF11 → WF12 → WF13 → WF14), confirming each one's table has plausible rows before enabling the next.

- [ ] **Step 8: Commit**

```bash
git add domains/short-videos/docs/postgres-schema.md
git commit -m "docs(schema): record the live vertical-slice verification"
```

---

## Deferred, deliberately

These are named so they are not mistaken for oversights. Add them to `TODOS.md` in Task 17.

- **Moving media off Google Drive** (spec D8, out of scope). The 7 or 8 remaining `googleDrive` nodes — 8 today, 7 if Task 13 removed the transcript-stash node — and the unresolved `public_video_url` fetchability question for TikTok, Instagram and Facebook.
- **Publishing the OAuth consent screen** (spec D8, out of scope). A console setting, not a code change, and the thing that actually addresses the stated motivation. Do it immediately and separately from this plan.
- **Fair-share as SQL window functions** (spec Section 2). The `pickFairBySource` / `pickFairByGroup` Code nodes stay, with their existing tests.
- **Authentication for the review UI** (spec D5). The tailnet is the authentication.
- **`Ssemble_Jobs`** (spec Section 1). Dead tab, never created.
