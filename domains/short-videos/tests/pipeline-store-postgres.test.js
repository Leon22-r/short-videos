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

    // Test reject_clip
    sql(`INSERT INTO short_videos.created_clips(created_clip_id, video_id, niche, review_status)
         VALUES ('clip-2', 'vid-1', 'FINANCE_BUSINESS', 'NEEDS_REVIEW')`);
    sql("SELECT short_videos.reject_clip('clip-2', 'Not suitable')");
    assert.equal(sql("SELECT review_status FROM short_videos.created_clips WHERE created_clip_id='clip-2'"), 'REJECTED');
    assert.equal(sql("SELECT reviewer_notes FROM short_videos.created_clips WHERE created_clip_id='clip-2'"), 'Not suitable');
  });
});

// Migration 012: verifies that revoking unintended grants strips privileges and default ACLs from authenticated and anon
test('real Postgres: 012 strips all privileges and default ACLs from anon and authenticated', { skip: !available }, async () => {
  await withCluster(async ({ sql, file }) => {
    // Set up roles as they exist on Supabase
    sql('CREATE ROLE service_role; CREATE ROLE authenticated; CREATE ROLE anon;');

    // Run migrations up to 010
    for (const migration of migrationFiles().filter(f => !f.endsWith('011-postgrest-grants.sql') && !f.endsWith('012-revoke-unintended-roles.sql'))) {
      file(migration);
    }

    // Simulate what the old 011 did (granting permissions to anon and authenticated)
    sql(`
      GRANT USAGE ON SCHEMA short_videos TO service_role, authenticated, anon;
      GRANT ALL ON ALL TABLES IN SCHEMA short_videos TO service_role;
      GRANT SELECT ON ALL TABLES IN SCHEMA short_videos TO authenticated;
      ALTER DEFAULT PRIVILEGES IN SCHEMA short_videos GRANT ALL ON TABLES TO service_role;
      ALTER DEFAULT PRIVILEGES IN SCHEMA short_videos GRANT SELECT ON TABLES TO authenticated;
    `);

    // Verify authenticated had select privilege before revoke
    assert.equal(sql("SELECT has_table_privilege('authenticated', 'short_videos.publishing_jobs', 'SELECT')"), 't');
    assert.equal(sql("SELECT has_schema_privilege('anon', 'short_videos', 'USAGE')"), 't');

    // Apply 011 and 012
    file(path.join(migrationsDir, '011-postgrest-grants.sql'));
    file(path.join(migrationsDir, '012-revoke-unintended-roles.sql'));

    // Assert that anon and authenticated have zero privileges
    assert.equal(sql("SELECT has_table_privilege('authenticated', 'short_videos.publishing_jobs', 'SELECT')"), 'f');
    assert.equal(sql("SELECT has_schema_privilege('authenticated', 'short_videos', 'USAGE')"), 'f');
    assert.equal(sql("SELECT has_schema_privilege('anon', 'short_videos', 'USAGE')"), 'f');

    // Assert default privileges for authenticated are cleared
    const defAcl = sql(`
      SELECT count(*) FROM pg_default_acl d
      JOIN pg_namespace n ON n.oid = d.defaclnamespace
      WHERE n.nspname = 'short_videos'
        AND array_to_string(d.defaclacl, ',') LIKE '%authenticated%'
    `);
    assert.equal(defAcl, '0');

    // Assert service_role keeps full privileges
    assert.equal(sql("SELECT has_table_privilege('service_role', 'short_videos.publishing_jobs', 'SELECT')"), 't');
    assert.equal(sql("SELECT has_schema_privilege('service_role', 'short_videos', 'USAGE')"), 't');
  });
});

module.exports = { withCluster, migrationFiles, available, pgBin };


// The review UI's alarms are only as good as these predicates, and each one is
// a copy of a workflow's input filter, so they are pinned against real rows.
test('real Postgres: pipeline_status counts only what each consumer would pick up', { skip: !available }, async () => {
  await withCluster(async ({ sql, file }) => {
    for (const migration of migrationFiles()) file(migration);
    // Replayed, as run-migrations.sh does on every boot: the in-place edits to
    // 013 and the new objects in 014 must both survive a second pass.
    for (const migration of migrationFiles()) file(migration);

    sql(`INSERT INTO short_videos.source_channels(source_id, niche, source_name, youtube_channel_url)
         VALUES ('src-1', 'FINANCE_BUSINESS', 'Example', 'https://youtube.com/@example')`);
    sql(`INSERT INTO short_videos.candidate_videos(video_id, niche, source_id, youtube_video_id, validity_status, rejection_reason, created_at) VALUES
         ('v-flag', 'FINANCE_BUSINESS', 'src-1', 'y1', 'FLAGGED', 'MANUAL_APPROVAL_REQUIRED', now()),
         ('v-rej1', 'FINANCE_BUSINESS', 'src-1', 'y2', 'REJECTED', 'TOO_SHORT', now()),
         ('v-rej2', 'FINANCE_BUSINESS', 'src-1', 'y3', 'REJECTED', 'TOO_SHORT', now()),
         ('v-old',  'FINANCE_BUSINESS', 'src-1', 'y4', 'REJECTED', 'LOW_ENGAGEMENT', now() - interval '40 days')`);
    sql(`INSERT INTO short_videos.created_clips(created_clip_id, video_id, niche, review_status) VALUES
         ('clip-a', 'v-flag', 'FINANCE_BUSINESS', 'APPROVED'),
         ('clip-b', 'v-flag', 'FINANCE_BUSINESS', 'APPROVED')`);
    // Two approvals: one WF11 has already turned into a job, one it has not.
    sql(`INSERT INTO short_videos.approved_for_posting(approved_id, created_clip_id, niche, platforms, final_title, status, created_at) VALUES
         ('ap-done', 'clip-a', 'FINANCE_BUSINESS', ARRAY['TIKTOK'], 'T', 'APPROVED', now() - interval '3 days'),
         ('ap-wait', 'clip-b', 'FINANCE_BUSINESS', ARRAY['TIKTOK'], 'T', 'APPROVED', now() - interval '2 hours')`);
    sql(`INSERT INTO short_videos.publishing_jobs(publish_id, approved_id, platform, tiktok_open_id, publish_status, scheduled_at, created_at) VALUES
         ('pj-done',   'ap-done', 'TIKTOK', 'tt-1', 'PUBLISHED', NULL, now() - interval '3 days'),
         ('pj-due',    NULL,      'TIKTOK', 'tt-1', 'PENDING',   now() - interval '1 hour', now() - interval '5 hours'),
         ('pj-later',  NULL,      'TIKTOK', 'tt-1', 'PENDING',   now() + interval '1 day',  now() - interval '9 hours'),
         ('pj-draft',  NULL,      'TIKTOK', 'tt-1', 'DRAFT_UPLOADED', NULL, now())`);
    sql(`INSERT INTO short_videos.publishing_jobs(publish_id, platform, tiktok_open_id, publish_status, retry_count, next_retry_at) VALUES
         ('pj-backoff', 'TIKTOK', 'tt-1', 'RETRY_PENDING', 1, now() + interval '2 hours'),
         ('pj-capped',  'TIKTOK', 'tt-1', 'RETRY_PENDING', 4, NULL)`);

    const stage = (position, column) => sql(
      `SELECT ${column} FROM short_videos.pipeline_status WHERE position = ${position}`);

    // Stage 8: an approval that already has a job is not waiting, so the
    // stage no longer counts every approval ever made.
    assert.equal(stage(8, 'waiting'), '1');
    assert.equal(stage(8, "oldest_waiting > now() - interval '3 hours'"), 't',
      'the oldest waiting approval is the unqueued one, not the first ever');

    // Stage 9: only due work counts — not tomorrow's post, not a backoff
    // still running, not a job past the retry cap — and its wait runs from
    // when it fell due.
    assert.equal(stage(9, 'waiting'), '1');
    assert.equal(stage(9, "oldest_waiting > now() - interval '2 hours'"), 't');

    // Every stage carries its own consumer's output column.
    assert.equal(sql('SELECT string_agg(position::text, \',\' ORDER BY position) FROM short_videos.pipeline_status WHERE consumer_last_output IS NOT NULL'), '5,8',
      'only the consumers with output in this fixture are dated: clips exist (WF6), jobs exist (WF11)');
    assert.equal(stage(9, 'consumer_last_output'), '',
      'no job has been claimed, so the publisher has produced nothing to date it by');

    // The nav counts match their screens.
    assert.equal(sql('SELECT held FROM short_videos.review_counts'), '1', 'held is FLAGGED only');
    assert.equal(sql('SELECT published FROM short_videos.review_counts'), '2', 'published includes drafts, as /published does');

    // 014: exact roll-ups.
    assert.equal(sql("SELECT reason || '=' || count FROM short_videos.held_reasons_30d"), 'TOO_SHORT=2',
      'grouped, and the 40-day-old rejection is outside the window');
    assert.equal(sql('SELECT count(*) FROM short_videos.clip_throughput_7d'), '7');
    assert.equal(sql("SELECT created || '/' || approved FROM short_videos.clip_throughput_7d ORDER BY day DESC LIMIT 1"), '2/2');
  });
});
