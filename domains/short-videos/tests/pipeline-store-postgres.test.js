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
