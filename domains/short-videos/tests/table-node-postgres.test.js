const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { upsertFromJsonb, updateFromJsonb } = require('../workflow-code/table-node');

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

test('real Postgres: an update leaves the columns it does not name alone', { skip: !available }, async () => {
  await withCluster(async ({ sql, run }) => {
    run(statement(), [{
      video_id: 'v1', niche: 'FINANCE_BUSINESS', youtube_video_id: 'yt1',
      duration_seconds: '58', view_count: '1200', transcript_available: 'true',
      published_at: '2026-10-01T00:00:00Z', processing_status: 'NEW',
    }]);
    // What WF3 does: it owns the classification columns and nothing else.
    run(updateFromJsonb({
      table: 'candidate_videos',
      key: 'video_id',
      columns: ['video_id', 'validity_status', 'processing_status'],
    }), [{ video_id: 'v1', validity_status: 'VALID', processing_status: 'ANALYZED' }]);
    assert.equal(sql("SELECT duration_seconds, view_count, validity_status, processing_status FROM short_videos.candidate_videos WHERE video_id = 'v1';"), '58|1200|VALID|ANALYZED');
    assert.equal(sql('SELECT count(*) FROM short_videos.candidate_videos;'), '1');
  });
});

// `INSERT ... ON CONFLICT` builds its insert row before the conflict is
// detected, so a narrow upsert cannot be used for a state transition on a table
// with NOT NULL columns. This is why updateFromJsonb exists.
test('real Postgres: a narrow upsert fails on the NOT NULL columns it omits', { skip: !available }, async () => {
  await withCluster(async ({ run }) => {
    const narrow = upsertFromJsonb({
      table: 'source_channels', key: 'source_id', columns: ['source_id', 'backfill_status'],
    });
    assert.throws(() => run(narrow, [{ source_id: 'src-1', backfill_status: 'COMPLETE' }]),
      /null value in column "niche".*violates not-null constraint/s);
  });
});

// WF2 clears backfill_next_page_token when a channel's backfill finishes. The
// Code node emits '' for "no more pages", which must land as NULL, not ''.
test('real Postgres: an update writes its own columns and can clear one', { skip: !available }, async () => {
  await withCluster(async ({ sql, run }) => {
    run(upsertFromJsonb({
      table: 'source_channels',
      key: 'source_id',
      columns: ['source_id', 'niche', 'source_name', 'youtube_channel_url', 'backfill_next_page_token', 'backfill_status'],
    }), [{
      source_id: 'src-1', niche: 'FINANCE_BUSINESS', source_name: 'Example',
      youtube_channel_url: 'https://youtube.com/@example',
      backfill_next_page_token: 'PAGE2', backfill_status: 'IN_PROGRESS',
    }]);
    assert.equal(sql("SELECT backfill_next_page_token FROM short_videos.source_channels WHERE source_id = 'src-1';"), 'PAGE2');

    run(updateFromJsonb({
      table: 'source_channels',
      key: 'source_id',
      columns: ['source_id', 'backfill_next_page_token', 'backfill_status'],
    }), [{ source_id: 'src-1', backfill_next_page_token: '', backfill_status: 'COMPLETE' }]);
    assert.equal(sql("SELECT backfill_next_page_token IS NULL, backfill_status, source_name FROM short_videos.source_channels WHERE source_id = 'src-1';"), 't|COMPLETE|Example');
  });
});

test('real Postgres: an update for an unknown key changes nothing', { skip: !available }, async () => {
  await withCluster(async ({ sql, run }) => {
    run(updateFromJsonb({
      table: 'source_channels', key: 'source_id', columns: ['source_id', 'backfill_status'],
    }), [{ source_id: 'does-not-exist', backfill_status: 'COMPLETE' }]);
    assert.equal(sql('SELECT count(*) FROM short_videos.source_channels;'), '0');
  });
});

// The committed .sql files are what the workflows actually run, so a column
// renamed in a migration shows up here rather than at runtime in n8n.
test('real Postgres: every committed WF1-WF3 query runs against the schema', { skip: !available }, async () => {
  const queries = {
    'select-source-channels': null,
    'select-candidate-videos': null,
    'upsert-candidate-videos': [{
      video_id: 'v1', niche: 'FINANCE_BUSINESS', youtube_video_id: 'yt1',
      video_title: 'A Title', duration_seconds: '1800', view_count: '50000',
      like_count: '1200', comment_count: '40', like_percentage: '0.024',
      comment_percentage: '0.0008', engagement_percentage: '0.0248',
      transcript_available: 'true', language: 'en', processing_status: 'NEW',
      published_at: '2026-10-01T00:00:00Z',
    }],
    'update-candidate-validity': [{
      video_id: 'v1', like_percentage: '0.024', comment_percentage: '0.0008',
      engagement_percentage: '0.0248', validity_status: 'VALID',
      validity_score: '8', rejection_reason: '', processing_status: 'ANALYZED',
    }],
    'update-source-resolution': [{
      source_id: 'src-1', youtube_channel_id: 'UC0123456789012345678901',
      uploads_playlist_id: 'UU0123456789012345678901',
      last_checked_at: '2026-10-08T00:00:00Z', notes: '',
    }],
    'update-source-backfill-state': [{
      source_id: 'src-1', backfill_next_page_token: '', backfill_status: 'COMPLETE',
      videos_known_count: '120', videos_fetched_count: '120',
      backfill_last_run_at: '2026-10-08T00:00:00Z', last_checked_at: '2026-10-08T00:00:00Z',
    }],
  };

  await withCluster(async ({ sql, run }) => {
    sql(`INSERT INTO short_videos.source_channels (source_id, niche, source_name, youtube_channel_url)
         VALUES ('src-1', 'FINANCE_BUSINESS', 'Example', 'https://youtube.com/@example');`);
    for (const [name, rows] of Object.entries(queries)) {
      const statement = fs.readFileSync(path.join(root, 'postgres/queries', `${name}.sql`), 'utf8');
      if (rows === null) {
        sql(statement.replace(/;\s*$/, ''));
      } else {
        run(statement, rows);
      }
    }
    // The chain end to end: WF1 resolved the channel, WF2 wrote the candidate
    // and cleared the backfill token, WF3 classified it.
    assert.equal(sql("SELECT uploads_playlist_id, backfill_next_page_token IS NULL, videos_fetched_count FROM short_videos.source_channels WHERE source_id = 'src-1';"), 'UU0123456789012345678901|t|120');
    assert.equal(sql("SELECT validity_status, validity_score, rejection_reason IS NULL, processing_status FROM short_videos.candidate_videos WHERE video_id = 'v1';"), 'VALID|8|t|ANALYZED');
  });
});
