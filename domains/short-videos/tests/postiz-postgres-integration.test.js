const assert = require('node:assert/strict');
const { execFileSync, execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');
const test = require('node:test');

const runAsync = promisify(execFile);
const root = path.resolve(__dirname, '..');
const pgBin = process.env.POSTIZ_TEST_PG_BIN || '/usr/lib/postgresql/16/bin';
const available = ['initdb', 'pg_ctl', 'psql'].every(name => fs.existsSync(path.join(pgBin, name)));
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const literal = value => value === null ? 'NULL' : `'${String(value).replace(/'/g, "''")}'`;

test('real Postgres: migration, frozen mapping, submission races, lease recovery and terminal states', { skip: !available }, async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'postiz-queue-test-'));
  const data = path.join(temp, 'data');
  const psqlArgs = ['-X', '-h', temp, '-p', '55439', '-U', 'postgres', '-d', 'postgres', '-Atq', '-v', 'ON_ERROR_STOP=1'];
  const command = (name, args) => execFileSync(path.join(pgBin, name), args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const sql = statement => command('psql', [...psqlArgs, '-c', statement]).trim();
  const prepared = (name, args) => `PREPARE operation AS ${read(`postgres/queries/${name}.sql`)}\nEXECUTE operation (${args.map(literal).join(',')});`;
  const query = (name, args) => sql(prepared(name, args));
  const row = id => JSON.parse(sql(`SELECT row_to_json(j) FROM short_videos.publishing_jobs j WHERE publish_id=${literal(id)}`));
  const upsert = jobs => query('upsert-publishing-jobs', [JSON.stringify(jobs)]);
  const baseJob = id => ({ publish_id: id, publishing_backend: 'POSTIZ', postiz_integration_id: 'integration-1', platform: 'YOUTUBE_SHORTS', channel_id: 'channel-1', title: 'Original', public_video_url: 'https://media.example/video.mp4', scheduled_at: '2020-01-01T00:00:00Z' });
  const owned = (id, worker = 'worker') => sql(`UPDATE short_videos.publishing_jobs SET publish_status='UPLOADING', claimed_by=${literal(worker)}, lease_expires_at=now()+interval '1 hour' WHERE publish_id=${literal(id)}`);
  const payloadFor = id => JSON.stringify({ type: 'now', posts: [{ integration: { id: 'integration-1' }, value: [{ image: [{ id, path: 'https://media.example/import.mp4' }] }] }] });
  const payload = payloadFor('media-1');
  let started = false;
  try {
    command('initdb', ['-D', data, '-U', 'postgres', '-A', 'trust', '--no-locale']);
    command('pg_ctl', ['-D', data, '-l', path.join(temp, 'postgres.log'), '-o', `-h '' -k ${temp} -p 55439`, '-w', 'start']);
    started = true;

    // First exercise an existing pre-Postiz installation with a legacy checkpoint.
    const init = read('postgres/init/001-publishing-queue.sql');
    sql(init.split('-- Postiz backend additions')[0]);
    sql("INSERT INTO short_videos.publishing_jobs(publish_id,platform,youtube_channel_id,provider_stage,provider_ref) VALUES ('legacy','YOUTUBE_SHORTS','yt-1','YOUTUBE_PROCESSING','video-1')");
    const migration = read('postgres/migrations/003-postiz-publishing.sql');
    sql(migration);
    sql(migration);
    assert.equal(row('legacy').publishing_backend, 'DIRECT');
    assert.equal(row('legacy').provider_ref, 'video-1');
    assert.equal(row('legacy').provider_stage, 'YOUTUBE_PROCESSING');
    // The complete fresh init is repeatable against the upgraded installation.
    sql(init);
    assert.throws(() => upsert([{ ...baseJob('bad'), publishing_backend: 'UNKNOWN' }]));
    assert.throws(() => upsert([{ ...baseJob('bad'), postiz_integration_id: '' }]));
    assert.throws(() => upsert([{ ...baseJob('bad'), publishing_backend: 'DIRECT' }]));

    upsert([baseJob('postiz')]);
    upsert([{ ...baseJob('postiz'), publishing_backend: 'DIRECT', youtube_channel_id: 'other', postiz_integration_id: 'other', title: 'Before checkpoint' }]);
    assert.equal(row('postiz').publishing_backend, 'POSTIZ');
    assert.equal(row('postiz').postiz_integration_id, 'integration-1');
    assert.equal(row('postiz').title, 'Before checkpoint');
    owned('postiz');
    const importing = row('postiz');
    upsert([{ ...baseJob('postiz'), title: 'Mutated during import', public_video_url: 'https://other.example/wrong.mp4' }]);
    assert.deepEqual(row('postiz'), importing, 'freeze before import starts, even with no provider stage');
    assert.equal(query('save-postiz-media', ['postiz', 'wrong-worker', 'media-1', 'https://media.example/import.mp4']), '');
    query('save-postiz-media', ['postiz', 'worker', 'media-1', 'https://media.example/import.mp4']);
    const before = row('postiz');
    upsert([{ ...baseJob('postiz'), title: 'Changed later', platform: 'TIKTOK', postiz_integration_id: 'other', scheduled_at: '2099-01-01T00:00:00Z', postiz_post_id: 'forged', provider_stage: '', public_video_url: 'https://other.example/video.mp4' }]);
    assert.deepEqual(row('postiz'), before, 'Sheet refresh must not alter an in-progress Postiz job');
    assert.equal(query('save-provider-checkpoint', ['postiz', 'worker', 'YOUTUBE_SESSION', 'x', '', '{}']), '');
    assert.equal(query('begin-postiz-submit', ['postiz', 'worker', payload.replace('integration-1', 'wrong-integration')]), '');
    assert.equal(query('begin-postiz-submit', ['postiz', 'worker', payload.replace('media-1', 'wrong-media')]), '');
    assert.equal(query('begin-postiz-submit', ['postiz', 'worker', payload.replace('https://media.example/import.mp4', 'https://other.example/wrong.mp4')]), '');

    const intent = prepared('begin-postiz-submit', ['postiz', 'worker', payload]);
    const race = await Promise.all([1, 2].map(() => runAsync(path.join(pgBin, 'psql'), [...psqlArgs, '-c', intent])));
    assert.equal(race.filter(result => result.stdout.trim()).length, 1, 'only one concurrent intent may return a row to the HTTP node');
    assert.equal(query('begin-postiz-submit', ['postiz', 'worker', payload]), '');
    assert.deepEqual(row('postiz').postiz_submit_payload, JSON.parse(payload));
    assert.ok(row('postiz').postiz_submitted_at);

    // Simulate a worker crash after intent and before an acknowledged response.
    sql("UPDATE short_videos.publishing_jobs SET lease_expires_at=now()-interval '1 minute' WHERE publish_id='postiz'; UPDATE short_videos.publishing_jobs SET publish_status='FAILED' WHERE publish_id='legacy'");
    query('claim-next-publishing-job', ['recovery-worker', '30']);
    query('mark-publishing-uploading', ['postiz', 'recovery-worker']);
    assert.equal(row('postiz').provider_stage, 'POSTIZ_SUBMIT_REQUESTED');
    assert.equal(query('begin-postiz-submit', ['postiz', 'recovery-worker', payload]), '');
    query('fail-provider-publish', ['postiz', 'recovery-worker', 'RETRY_PENDING', '1', '2099-01-01T00:00:00Z', 'timeout', '{}']);
    assert.equal(row('postiz').publish_status, 'FAILED');
    assert.equal(row('postiz').next_retry_at, null);
    assert.deepEqual(row('postiz').postiz_submit_payload, JSON.parse(payload));
    sql("UPDATE short_videos.publishing_jobs SET publish_status='RETRY_PENDING', next_retry_at=NULL WHERE publish_id='postiz'");
    sql(read('postgres/queries/release-due-publishing-retries.sql'));
    assert.equal(row('postiz').publish_status, 'FAILED');

    upsert([baseJob('accepted')]);
    owned('accepted');
    query('save-postiz-media', ['accepted', 'worker', 'media-2', 'https://media.example/import.mp4']);
    query('begin-postiz-submit', ['accepted', 'worker', payloadFor('media-2')]);
    query('save-postiz-submission', ['accepted', 'worker', 'postiz-2', '{}']);
    assert.ok(query('save-postiz-submission', ['accepted', 'worker', 'postiz-2', '{}']), 'same result can be durably saved after a lost database acknowledgment');
    assert.equal(query('save-postiz-submission', ['accepted', 'worker', 'different-post', '{}']), '');
    assert.equal(query('schedule-provider-poll', ['accepted', 'worker', 'YOUTUBE_PROCESSING', 'postiz-2', '{}', '2']), '');
    query('schedule-provider-poll', ['accepted', 'worker', 'POSTIZ_SUBMITTED', 'postiz-2', '{}', '2']);
    assert.equal(row('accepted').publish_status, 'PROCESSING');
    assert.equal(row('accepted').postiz_post_id, 'postiz-2');
    owned('accepted');
    assert.equal(query('complete-provider-publish', ['accepted', 'worker', 'PUBLISHED', 'postiz-2', 'https://youtube.com/watch?v=2', 'POSTIZ_PUBLISHED', '{}']), '');
    assert.equal(query('complete-postiz-publish', ['accepted', 'worker', 'PUBLISHED', '', '', '{}']), '');
    assert.equal(query('complete-postiz-publish', ['accepted', 'worker', 'DRAFT_UPLOADED', '', '', '{}']), '');
    sql("UPDATE short_videos.publishing_jobs SET lease_expires_at=now()-interval '1 minute' WHERE publish_id='accepted'");
    assert.equal(query('complete-postiz-publish', ['accepted', 'worker', 'PUBLISHED', '', 'https://youtube.com/watch?v=2', '{}']), '');
    owned('accepted');
    query('complete-postiz-publish', ['accepted', 'worker', 'PUBLISHED', '', 'https://youtube.com/watch?v=2', '{}']);
    assert.equal(row('accepted').publish_status, 'PUBLISHED');
    assert.equal(row('accepted').post_id, '', 'Postiz ID is never a platform ID');
    assert.equal(row('accepted').postiz_post_id, 'postiz-2');

    upsert([{ ...baseJob('draft'), platform: 'TIKTOK' }]);
    owned('draft');
    query('save-postiz-media', ['draft', 'worker', 'media-3', 'https://media.example/import.mp4']);
    query('begin-postiz-submit', ['draft', 'worker', payloadFor('media-3')]);
    query('save-postiz-submission', ['draft', 'worker', 'postiz-3', '{}']);
    assert.equal(query('complete-postiz-publish', ['draft', 'worker', 'PUBLISHED', '', 'https://tiktok.com/video/3', '{}']), '');
    query('complete-postiz-publish', ['draft', 'worker', 'DRAFT_UPLOADED', '', '', '{}']);
    assert.equal(row('draft').publish_status, 'DRAFT_UPLOADED');

    upsert([baseJob('bounded')]);
    owned('bounded');
    query('save-postiz-media', ['bounded', 'worker', 'media-4', 'https://media.example/import.mp4']);
    query('begin-postiz-submit', ['bounded', 'worker', payloadFor('media-4')]);
    sql("UPDATE short_videos.publishing_jobs SET lease_expires_at=now()-interval '1 minute' WHERE publish_id='bounded'");
    assert.equal(query('save-postiz-submission', ['bounded', 'worker', 'postiz-4', '{}']), '');
    owned('bounded');
    query('save-postiz-submission', ['bounded', 'worker', 'postiz-4', '{}']);
    sql("UPDATE short_videos.publishing_jobs SET provider_poll_count=179 WHERE publish_id='bounded'");
    query('schedule-provider-poll', ['bounded', 'worker', 'POSTIZ_SUBMITTED', 'postiz-4', '{}', '2']);
    assert.equal(row('bounded').publish_status, 'FAILED');
    assert.equal(row('bounded').postiz_post_id, 'postiz-4');
    assert.match(row('bounded').last_error, /manual reconciliation/);

    // Finally prove a fresh database can use POSTIZ without running migrations separately.
    sql('DROP SCHEMA short_videos CASCADE');
    sql(init);
    upsert([baseJob('fresh')]);
    assert.equal(row('fresh').publishing_backend, 'POSTIZ');
  } finally {
    if (started) command('pg_ctl', ['-D', data, '-m', 'immediate', '-w', 'stop']);
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
