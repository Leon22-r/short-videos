const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { upsertFromJsonb } = require('../workflow-code/table-node');

const root = path.resolve(__dirname, '..');
const pgBin = process.env.POSTIZ_TEST_PG_BIN || '/usr/lib/postgresql/16/bin';
const available = ['initdb', 'pg_ctl', 'psql'].every((name) => fs.existsSync(path.join(pgBin, name)));

// A port no other test in the repo uses: postiz holds 55439, the pipeline-store
// replay test holds 55441.
const PORT = '55443';

// The generator emits SQL as a string, so the only way to know Postgres accepts
// it is to run it. These tables carry integer, bigint, numeric, boolean and
// timestamptz columns, and the text projection the publishing queue uses fails
// on every one of them.
async function withCluster(body) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'table-node-test-'));
  const data = path.join(temp, 'data');
  const args = ['-X', '-h', temp, '-p', PORT, '-U', 'postgres', '-d', 'postgres', '-Atq', '-v', 'ON_ERROR_STOP=1'];
  const command = (name, extra) => execFileSync(path.join(pgBin, name), extra, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const sql = (statement) => command('psql', [...args, '-c', statement]).trim();
  let started = false;
  try {
    command('initdb', ['-D', data, '-U', 'postgres', '-A', 'trust', '--no-locale']);
    command('pg_ctl', ['-D', data, '-l', path.join(temp, 'postgres.log'), '-o', `-h '' -k ${temp} -p ${PORT}`, '-w', 'start']);
    started = true;
    sql('CREATE SCHEMA IF NOT EXISTS short_videos;');
    sql(fs.readFileSync(path.join(root, 'postgres/migrations/004-pipeline-store-sources.sql'), 'utf8'));
    // Rows arrive from a Code node as a jsonb array, so $1 is substituted the
    // way the Postgres node substitutes queryReplacement.
    const run = (statement, rows) => {
      const file = path.join(temp, 'query.sql');
      fs.writeFileSync(file, statement.replace('$1::jsonb', `'${JSON.stringify(rows)}'::jsonb`));
      return command('psql', [...args, '-f', file]).trim();
    };
    await body({ sql, run });
  } finally {
    if (started) { try { command('pg_ctl', ['-D', data, '-w', 'stop']); } catch {} }
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

const COLUMNS = ['video_id', 'niche', 'youtube_video_id', 'duration_seconds',
  'view_count', 'transcript_available', 'published_at', 'processing_status'];
const statement = () => upsertFromJsonb({ table: 'candidate_videos', key: 'video_id', columns: COLUMNS });

test('real Postgres: the upsert accepts a row of typed columns from jsonb', { skip: !available }, async () => {
  await withCluster(async ({ sql, run }) => {
    run(statement(), [{
      video_id: 'v1', niche: 'FINANCE_BUSINESS', youtube_video_id: 'yt1',
      duration_seconds: '58', view_count: '1200', transcript_available: 'true',
      published_at: '2026-10-01T00:00:00Z', processing_status: 'NEW',
    }]);
    assert.equal(sql("SELECT duration_seconds, view_count, transcript_available FROM short_videos.candidate_videos WHERE video_id = 'v1';"), '58|1200|t');
  });
});

test('real Postgres: a blank cell becomes NULL rather than failing the batch', { skip: !available }, async () => {
  await withCluster(async ({ sql, run }) => {
    run(statement(), [{
      video_id: 'v2', niche: 'FINANCE_BUSINESS', youtube_video_id: 'yt2',
      duration_seconds: '', view_count: '', transcript_available: '',
      published_at: '', processing_status: 'NEW',
    }]);
    assert.equal(sql("SELECT duration_seconds IS NULL, published_at IS NULL FROM short_videos.candidate_videos WHERE video_id = 'v2';"), 't|t');
  });
});

test('real Postgres: a row with a blank key is skipped, not inserted as empty', { skip: !available }, async () => {
  await withCluster(async ({ sql, run }) => {
    run(statement(), [{ video_id: '   ', niche: 'FINANCE_BUSINESS', youtube_video_id: 'yt9', processing_status: 'NEW' }]);
    assert.equal(sql('SELECT count(*) FROM short_videos.candidate_videos;'), '0');
  });
});

test('real Postgres: a partial second write updates its own fields only', { skip: !available }, async () => {
  await withCluster(async ({ sql, run }) => {
    run(statement(), [{
      video_id: 'v1', niche: 'FINANCE_BUSINESS', youtube_video_id: 'yt1',
      duration_seconds: '58', view_count: '1200', transcript_available: 'true',
      published_at: '2026-10-01T00:00:00Z', processing_status: 'NEW',
    }]);
    run(statement(), [{
      video_id: 'v1', niche: 'FINANCE_BUSINESS', youtube_video_id: 'yt1',
      processing_status: 'ANALYZED',
    }]);
    // duration_seconds survives although the second row did not carry it.
    assert.equal(sql("SELECT duration_seconds, processing_status FROM short_videos.candidate_videos WHERE video_id = 'v1';"), '58|ANALYZED');
    assert.equal(sql('SELECT count(*) FROM short_videos.candidate_videos;'), '1');
  });
});
