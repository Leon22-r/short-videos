const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const domainRoot = path.resolve(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(domainRoot, relativePath), 'utf8');

test('publishing Postgres schema is portable and constrains queue state', () => {
  const schema = read('postgres/init/001-publishing-queue.sql');

  assert.match(schema, /CREATE SCHEMA IF NOT EXISTS short_videos/);
  assert.match(schema, /publish_id text PRIMARY KEY/);
  assert.match(schema, /payload jsonb NOT NULL/);
  assert.match(schema, /provider_stage text NOT NULL/);
  assert.match(schema, /provider_response jsonb NOT NULL/);
  assert.match(schema, /poll_after timestamptz/);
  assert.match(schema, /safe_schedule_at/);
  assert.match(schema, /RETURN 'infinity'::timestamptz/);
  assert.match(schema, /publish_status IN/);
  assert.match(schema, /publishing_jobs_platform_destination_check/);
  assert.match(schema, /'CLAIMED'/);
  assert.match(schema, /'SKIPPED'/);
  assert.doesNotMatch(schema, /CREATE EXTENSION/i);
});

test('atomic claim uses row locks, skip-locked selection, and retry idempotency', () => {
  const claim = read('postgres/queries/claim-next-publishing-job.sql');

  assert.match(claim, /FOR UPDATE SKIP LOCKED/);
  assert.match(claim, /existing_claim AS MATERIALIZED/);
  assert.match(claim, /claimed_by = \$1/);
  assert.match(claim, /lease_expires_at = now\(\) \+ \(\$2::integer/);
  assert.match(claim, /retry_count < 4/);
  assert.match(claim, /publish_status = 'PROCESSING'/);
  assert.doesNotMatch(claim, /\{\{/);
});

test('provider checkpoints, polling, completion, and failure are ownership guarded', () => {
  for (const file of ['save-provider-checkpoint', 'schedule-provider-poll', 'complete-provider-publish', 'fail-provider-publish']) {
    const sql = read(`postgres/queries/${file}.sql`);
    assert.match(sql, /publish_id = \$1/);
    assert.match(sql, /claimed_by = \$2/);
    assert.doesNotMatch(sql, /\{\{/);
  }
  assert.match(read('postgres/queries/schedule-provider-poll.sql'), /ELSE 'PROCESSING'/);
  assert.match(read('postgres/queries/schedule-provider-poll.sql'), /provider_poll_count \+ 1 >= 180/);
  assert.match(read('postgres/queries/complete-provider-publish.sql'), /'DRAFT_UPLOADED'/);
  assert.match(read('postgres/queries/complete-provider-publish.sql'), /platform = 'TIKTOK'.*provider_ref/s);
});

test('queue mutations use bound parameters and preserve database-owned status on sync', () => {
  const upsert = read('postgres/queries/upsert-publishing-jobs.sql');
  const uploading = read('postgres/queries/mark-publishing-uploading.sql');
  const skipped = read('postgres/queries/mark-publishing-skipped.sql');

  assert.match(upsert, /jsonb_array_elements\(\$1::jsonb\)/);
  assert.match(upsert, /ON CONFLICT \(publish_id\) DO UPDATE/);
  assert.doesNotMatch(upsert.split('ON CONFLICT')[1], /publish_status = EXCLUDED\.publish_status/);
  assert.match(uploading, /publish_id = \$1/);
  assert.match(uploading, /claimed_by = \$2/);
  assert.match(skipped, /destination_id = \$3/);
  assert.match(skipped, /last_error = \$4/);
  assert.match(skipped, /NOT EXISTS \(SELECT 1 FROM updated\)/);
});

test('Postiz intent and immutable backend contracts are explicit in SQL', () => {
  const migration = read('postgres/migrations/003-postiz-publishing.sql');
  assert.match(migration, /publishing_backend text NOT NULL DEFAULT 'DIRECT'/);
  assert.match(migration, /postiz_submit_payload jsonb NOT NULL DEFAULT/);
  const upsert = read('postgres/queries/upsert-publishing-jobs.sql');
  const conflicts = upsert.split('ON CONFLICT')[1];
  assert.doesNotMatch(conflicts, /(?:publishing_backend|postiz_integration_id|postiz_post_id) = EXCLUDED/);
  assert.match(conflicts, /jobs.started_at IS NOT NULL OR jobs.publish_status <> 'PENDING'/);
  for (const name of ['save-postiz-media', 'begin-postiz-submit', 'save-postiz-submission', 'complete-postiz-publish']) {
    const sql = read(`postgres/queries/${name}.sql`);
    assert.match(sql, /claimed_by = \$2/);
    assert.match(sql, /lease_expires_at > now\(\)/);
    assert.match(sql, /publishing_backend = 'POSTIZ'/);
    assert.doesNotMatch(sql, /\{\{/);
  }
  const intent = read('postgres/queries/begin-postiz-submit.sql');
  assert.match(intent, /provider_stage = 'POSTIZ_MEDIA_READY'/);
  assert.match(intent, /postiz_submitted_at IS NULL/);
  assert.match(read('postgres/queries/release-due-publishing-retries.sql'), /automatic resubmission blocked/);
});
