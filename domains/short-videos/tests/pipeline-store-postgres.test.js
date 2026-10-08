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
    await body({ sql, file, temp });
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

// Finding B: run-migrations.sh records applied migrations to schema_migrations atomically
test('real Postgres: run-migrations records applied versions to schema_migrations', { skip: !available }, async () => {
  await withCluster(async ({ sql, temp }) => {
    const runner = path.resolve(root, '../../hosts/shared/postgres/run-migrations.sh');
    const targetUrl = `postgresql://postgres@/postgres?host=${temp}&port=55441`;

    // First run applies all migrations and writes the ledger
    execFileSync(runner, [targetUrl, migrationsDir], { encoding: 'utf8', env: { ...process.env, PATH: `${pgBin}:${process.env.PATH}` } });

    const expectedVersions = migrationFiles().map(f => path.basename(f));
    const recorded = sql("SELECT string_agg(version, E'\\n' ORDER BY version) FROM short_videos.schema_migrations").split('\n');
    assert.deepEqual(recorded, expectedVersions, 'schema_migrations should match disk migrations');

    // Replay run does not duplicate versions
    execFileSync(runner, [targetUrl, migrationsDir], { encoding: 'utf8', env: { ...process.env, PATH: `${pgBin}:${process.env.PATH}` } });
    const count = sql('SELECT count(*) FROM short_videos.schema_migrations');
    assert.equal(count, String(expectedVersions.length), 'replay must not duplicate rows');
  });
});

// The spec requires a tested down path for 009, the only step that alters
// existing columns rather than adding.
test('real Postgres: the 009 retyping round-trips through its down migration', { skip: !available }, async () => {
  await withCluster(async ({ sql, file }) => {
    for (const migration of migrationFiles()) file(migration);

    sql(`INSERT INTO short_videos.publishing_jobs(publish_id, platform, youtube_channel_id)
         VALUES ('round-trip', 'YOUTUBE_SHORTS', 'yt-ch-1')`);
    assert.equal(sql("SELECT approved_id IS NULL FROM short_videos.publishing_jobs WHERE publish_id='round-trip'"), 't');

    file(path.join(root, 'postgres/rollback/009-publishing-jobs-retypes.down.sql'));
    assert.equal(sql("SELECT approved_id = '' FROM short_videos.publishing_jobs WHERE publish_id='round-trip'"), 't');
    assert.equal(sql("SELECT count(*) FROM pg_proc WHERE proname = 'safe_schedule_at'"), '1');

    // And forward again, because a rollback is sometimes followed by a re-land.
    file(path.join(root, 'postgres/migrations/009-publishing-jobs-retypes.sql'));
    assert.equal(sql("SELECT approved_id IS NULL FROM short_videos.publishing_jobs WHERE publish_id='round-trip'"), 't');
  });
});

module.exports = { withCluster, migrationFiles, available, pgBin };
