const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const { buildPublishingJobs, buildCredentialHealthRows } = require('../n8n/workflow-code/publishing');
const {
  validatePostizJob, confirmPostizIntegration, parsePostizMedia, buildPostizPayload,
  parsePostizSubmission, postizPollWindow, interpretPostizStatus, postizReleaseUrl,
} = require('../n8n/workflow-code/postiz-publishing');
const wf = require('../n8n/workflows/12-publish-to-platforms.json');
const now = new Date('2026-09-21T10:00:00Z');
const job = (extra = {}) => ({
  publish_id: 'PUB_RENDER_1_YOUTUBE_SHORTS_C1', publishing_backend: 'POSTIZ',
  platform: 'YOUTUBE_SHORTS', postiz_integration_id: 'integration-1', credential_slot: 'POSTIZ_PRIMARY',
  audit_status: 'DEV_PRIVATE_ONLY', default_privacy: 'private', title: 'A useful video',
  caption: 'Caption, including commas', hashtags: '#shorts #example',
  public_video_url: 'https://media.example.com/video.mp4', provider_stage: '',
  ...extra,
});
const mediaJob = (extra = {}) => job({ provider_stage: 'POSTIZ_MEDIA_READY', postiz_media_id: 'media-1', postiz_media_path: 'https://media.example.com/postiz.mp4', ...extra });
const submittedJob = (extra = {}) => job({ provider_stage: 'POSTIZ_SUBMITTED', postiz_post_id: 'postiz-1', postiz_submitted_at: now.toISOString(), ...extra });
const post = (extra = {}) => ({ id: 'postiz-1', state: 'PUBLISHED', releaseId: 'youtube-1', releaseURL: 'https://www.youtube.com/watch?v=youtube-1', integration: { id: 'integration-1', providerIdentifier: 'youtube' }, ...extra });
const node = (name) => wf.nodes.find((n) => n.name === name);
function runCode(name, input, sources) {
  const items = Array.isArray(input) ? input.map((json) => ({ json })) : [{ json: input }];
  return new Function('$input', '$', node(name).parameters.jsCode)(
    { first: () => items[0], all: () => items },
    (source) => ({ first: () => ({ json: sources[source] }) }),
  );
}

test('Postiz job creation is explicitly opted in, approved and deterministic', () => {
  const approved = [{ approved_id: 'a', render_id: 'r', status: 'APPROVED', platform: 'YOUTUBE_SHORTS', final_title: 'A video' }];
  const renders = [{ render_id: 'r', render_status: 'COMPLETED', final_local_path: '/data/final.mp4', public_video_url: 'https://media.example.com/final.mp4' }];
  const channels = [{ channel_id: 'c', platform: 'YOUTUBE_SHORTS', enabled_status: 'TRUE', audit_status: 'DEV_PRIVATE_ONLY', publishing_backend: 'POSTIZ', postiz_integration_id: 'integration-1' }];
  const rows = buildPublishingJobs(approved, renders, [], channels, [], now);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].publishing_backend, 'POSTIZ');
  assert.equal(rows[0].credential_slot, 'POSTIZ_PRIMARY');
  assert.equal(rows[0].destination_id, 'integration-1');
  assert.equal(buildPublishingJobs(approved, renders, [], channels, rows, now).length, 0);
  assert.equal(buildPublishingJobs([{ ...approved[0], status: 'PENDING' }], renders, [], channels, [], now).length, 0);
  assert.equal(buildPublishingJobs(approved, renders, [], [{ ...channels[0], publishing_backend: 'UNKNOWN' }], [], now).length, 0);
  assert.equal(buildPublishingJobs(approved, renders, [], [{ ...channels[0], publishing_backend: '' }], [], now).length, 0);
});

test('validation preserves privacy, manual TikTok and checkpoint boundaries', () => {
  assert.equal(validatePostizJob(job()).route, 'POSTIZ_PREPARE');
  for (const patch of [
    { public_video_url: 'http://media.example.com/a.mp4' }, { postiz_integration_id: '' },
    { credential_slot: 'YOUTUBE_PRIMARY' }, { audit_status: 'PENDING' },
    { default_privacy: 'public' }, { title: 'x' }, { provider_stage: 'YOUTUBE_SESSION' },
    { provider_stage: 'POSTIZ_MEDIA_READY' },
  ]) assert.equal(validatePostizJob(job(patch)).ready, false, JSON.stringify(patch));
  assert.equal(validatePostizJob(job({ provider_stage: 'POSTIZ_SUBMIT_REQUESTED' })).route, 'AMBIGUOUS');
  assert.equal(validatePostizJob(submittedJob({ public_video_url: '', audit_status: 'REVOKED' })).route, 'POSTIZ_POLL');
  assert.equal(validatePostizJob(submittedJob({ postiz_submitted_at: '' })).ready, false);
  assert.equal(validatePostizJob(job({ platform: 'INSTAGRAM_REELS', default_privacy: 'private' })).ready, false);
  assert.equal(validatePostizJob(job({ platform: 'INSTAGRAM_REELS', audit_status: 'APPROVED_PUBLIC', default_privacy: 'public' })).ready, true);
  assert.equal(validatePostizJob(job({ platform: 'TIKTOK', tiktok_mode: 'DIRECT' })).ready, false);
});

test('integration and media responses require exact typed identity', () => {
  assert.equal(confirmPostizIntegration(job(), [{ id: 'integration-1', identifier: 'youtube', disabled: false }]).platform, 'YOUTUBE_SHORTS');
  for (const body of [{}, [], [{ id: 'other', identifier: 'youtube', disabled: false }], [{ id: 'integration-1', identifier: 'facebook', disabled: false }], [{ id: 'integration-1', identifier: 'youtube', disabled: true }]]) {
    assert.throws(() => confirmPostizIntegration(job(), body));
  }
  assert.deepEqual(parsePostizMedia({ body: { id: 'media-1', path: 'https://media.example.com/a.mp4' }, statusCode: 200 }), { postiz_media_id: 'media-1', postiz_media_path: 'https://media.example.com/a.mp4' });
  assert.throws(() => parsePostizMedia({ id: 'x', path: 'https://user:secret@example.com/x' }));
  assert.throws(() => parsePostizMedia({ id: 'x', path: 'https://media.example.com/photo.jpg' }));
  assert.throws(() => parsePostizMedia({ id: 'x', path: 'https://media.example.com/download?id=video.mp4' }));
  assert.throws(() => parsePostizMedia({ statusCode: 401, body: {} }));
});

test('payloads contain exactly one account/media and preserve platform intent', () => {
  const payload = buildPostizPayload(mediaJob(), now);
  assert.equal(payload.type, 'now');
  assert.equal(payload.posts.length, 1);
  assert.equal(payload.posts[0].integration.id, 'integration-1');
  assert.equal(payload.posts[0].settings.type, 'private');
  assert.deepEqual(payload.posts[0].settings.tags, [{ value: 'shorts', label: 'shorts' }, { value: 'example', label: 'example' }]);
  assert.equal(payload.posts[0].value[0].image[0].id, 'media-1');
  const tik = buildPostizPayload(mediaJob({ platform: 'TIKTOK', requires_manual_publish: true, tiktok_mode: 'DRAFT' }), now);
  assert.equal(tik.posts[0].settings.content_posting_method, 'UPLOAD');
  assert.equal(tik.posts[0].settings.autoAddMusic, 'no');
  assert.equal(buildPostizPayload(mediaJob({ platform: 'INSTAGRAM_REELS', audit_status: 'APPROVED_PUBLIC', default_privacy: 'public' }), now).posts[0].settings.post_type, 'post');
  assert.throws(() => buildPostizPayload(submittedJob(), now));
});

test('ambiguous create responses never become confirmed submissions', () => {
  assert.deepEqual(parsePostizSubmission(job(), { statusCode: 200, body: [{ postId: 'postiz-1', integration: 'integration-1' }] }), { postiz_post_id: 'postiz-1' });
  for (const body of [{ postId: 'p' }, [], [{ postId: 'p', integration: 'other' }], [{ postId: '', integration: 'integration-1' }], [{ postId: 'p', integration: 'integration-1' }, { postId: 'q', integration: 'integration-1' }]]) assert.throws(() => parsePostizSubmission(job(), body));
});

test('polling separates acceptance, drafts, platform publication and identities', () => {
  const interpret = (value) => interpretPostizStatus(submittedJob(), { posts: value });
  assert.equal(interpret([]).action, 'POLL');
  assert.equal(interpret([post({ state: 'QUEUE' })]).action, 'POLL');
  for (const state of ['DRAFT', 'ERROR', 'DELETED', 'UNKNOWN']) assert.equal(interpret([post({ state })]).action, 'FAIL');
  assert.equal(interpret([post({ integration: { id: 'wrong', providerIdentifier: 'youtube' } })]).action, 'FAIL');
  assert.equal(interpret([post(), post()]).action, 'FAIL');
  for (const releaseURL of ['', 'https://youtube.com/watch', 'https://youtube.com/watchanything?v=x', 'https://youtube.com/shortsanything', 'https://youtube.com.evil.example/watch?v=x', 'https://evil.example/x']) assert.equal(interpret([post({ releaseURL })]).action, 'POLL');
  assert.equal(interpret([post()]).post_id, 'youtube-1');
  assert.equal(interpret([post({ releaseId: undefined })]).post_id, '');
  assert.equal(interpret([post({ releaseId: 'missing' })]).post_id, '');
  const tik = submittedJob({ platform: 'TIKTOK', tiktok_mode: 'DRAFT' });
  const tikPost = post({ integration: { id: 'integration-1', providerIdentifier: 'tiktok' }, settings: { content_posting_method: 'UPLOAD' } });
  assert.deepEqual(interpretPostizStatus(tik, { posts: [tikPost] }), { action: 'COMPLETE', outcome: 'DRAFT_UPLOADED', post_id: '', post_url: '' });
  assert.equal(interpretPostizStatus(tik, { posts: [{ ...tikPost, settings: {} }] }).action, 'FAIL');
  assert.equal(interpretPostizStatus(tik, { posts: [{ ...tikPost, settings: JSON.stringify(tikPost.settings) }] }).outcome, 'DRAFT_UPLOADED');
  assert.equal(interpretPostizStatus(tik, { posts: [{ ...tikPost, settings: '{broken' }] }).action, 'FAIL');
  assert.equal(postizPollWindow(submittedJob(), now).startDate, '2026-09-20T10:00:00.000Z');
});

test('Postiz health metadata does not claim tested credentials', () => {
  assert.equal(buildCredentialHealthRows([{ channel_id: 'c', enabled_status: 'TRUE', publishing_backend: 'POSTIZ' }], now)[0].last_health_status, 'NOT_CHECKED');
});

test('generated routing and payload nodes execute with realistic n8n data shapes', () => {
  for (const n of wf.nodes.filter((n) => n.type === 'n8n-nodes-base.code')) assert.doesNotThrow(() => new Function('$input', '$', n.parameters.jsCode), n.name);
  const route = runCode('Build Provider Route', {}, { 'Mark Uploading Atomically': job() })[0].json;
  assert.equal(route.route, 'POSTIZ_PREPARE');
  assert.equal(runCode('Build Provider Route', {}, { 'Mark Uploading Atomically': submittedJob() })[0].json.route, 'POSTIZ_POLL');
  assert.equal(runCode('Build Provider Route', {}, { 'Mark Uploading Atomically': job({ provider_stage: 'POSTIZ_SUBMIT_REQUESTED' }) })[0].json.route, 'AMBIGUOUS');
  assert.equal(runCode('Build Postiz Submission', mediaJob(), {})[0].json.submission_payload.posts[0].integration.id, 'integration-1');
  const retry = runCode('Build Postiz Read Retry', { error: { message: 'token=secret' } }, { 'Build Provider Route': submittedJob() })[0].json;
  assert.equal(retry.provider_ref, 'postiz-1');
  assert(!JSON.stringify(retry).includes('secret'));
  const sources = { 'Build Provider Route': job() };
  const ambiguous = runCode('Build Ambiguous Side Effect Failure', { error: { message: 'https://media.example/x?token=secret' } }, sources)[0].json;
  assert.equal(ambiguous.outcome, 'FAILED');
  assert(!JSON.stringify(ambiguous).includes('secret'));
  const failure = runCode('Build Provider Failure State', { error: { message: 'token=secret' } }, sources)[0].json;
  assert(!JSON.stringify(failure).includes('secret'));
  const authFailure = runCode('Build Provider Failure State', { error: { message: '401: authorization secret' } }, sources)[0].json;
  assert.equal(authFailure.publish_status, 'AUTH_REQUIRED');
  assert.equal(authFailure.next_retry_at, '');
  assert(!JSON.stringify(authFailure).includes('secret'));
});

test('graph guards create behind a single-winner SQL intent and keeps polls separate', () => {
  const incomingCreate = Object.entries(wf.connections).filter(([, v]) => v.main.flat().some((e) => e.node === 'Create Postiz Post')).map(([name]) => name);
  assert.deepEqual(incomingCreate, ['Begin Postiz Submission']);
  assert.equal(node('Create Postiz Post').retryOnFail, false);
  assert.equal(node('Begin Postiz Submission').retryOnFail, false);
  assert.equal(node('Begin Postiz Submission').alwaysOutputData, undefined);
  assert.match(node('Create Postiz Post').parameters.jsonBody, /Begin Postiz Submission/);
  for (const name of ['Check Postiz Integration', 'Import Postiz Video', 'Create Postiz Post', 'List Postiz Posts']) {
    const n = node(name);
    assert.equal(n.parameters.genericAuthType, 'httpHeaderAuth');
    assert.equal(n.parameters.options.redirect.redirect.followRedirects, false);
    assert(wf.connections[name].main[1].length);
  }
  assert.equal(wf.connections['Create Postiz Post'].main[1][0].node, 'Build Ambiguous Side Effect Failure');
  assert.equal(wf.connections['List Postiz Posts'].main[1][0].node, 'Build Postiz Read Retry');
  const names = new Set(wf.nodes.map((n) => n.name));
  assert.equal(new Set(wf.nodes.map((n) => n.id)).size, wf.nodes.length);
  for (const [source, c] of Object.entries(wf.connections)) {
    assert(names.has(source));
    for (const e of c.main.flat()) assert(names.has(e.node), e.node);
  }
  for (const n of wf.nodes.filter((n) => n.type === 'n8n-nodes-base.switch')) assert.equal(wf.connections[n.name].main.length, n.parameters.rules.values.length + 1, n.name);
});

test('every queue mirror redacts Postiz snapshots and media paths', () => {
  const secretRow = { publish_id: 'p', postiz_post_id: 'postiz-1', postiz_media_path: 'https://private.example/a', postiz_submit_payload: { caption: 'sensitive' }, provider_response: { token: 'secret' }, payload: { secret: true } };
  for (const name of ['Redact Atomic Claim For Sheet', 'Redact Provider Processing For Sheet', 'Redact Provider Completion For Sheet', 'Redact Provider Failure For Sheet']) {
    const result = runCode(name, secretRow, {})[0].json;
    assert.equal(result.postiz_post_id, 'postiz-1');
    for (const key of ['postiz_media_path', 'postiz_submit_payload', 'provider_response', 'payload']) assert.equal(result[key], undefined);
  }
  const retry = JSON.parse(fs.readFileSync('n8n/workflows/14-publishing-retry-scheduler.json', 'utf8'));
  assert.equal(retry.connections['Release Due Retries Atomically'].main[0][0].node, 'Redact Retry State For Sheet');
});

test('postizReleaseUrl accepts only per-platform public release URL shapes', () => {
  for (const url of ['https://youtube.com/watch?v=abc123', 'https://www.youtube.com/shorts/abc123',
    'https://youtube.com/shorts/abc123/', 'https://youtu.be/abc123']) {
    assert.equal(postizReleaseUrl('YOUTUBE_SHORTS', url), true, url);
  }
  for (const url of ['https://youtube.com/watch', 'https://youtube.com/watch?v=', 'https://youtube.com/',
    'https://vimeo.com/shorts/abc123', 'https://evil.com/shorts/abc123']) {
    assert.equal(postizReleaseUrl('YOUTUBE_SHORTS', url), false, url);
  }
  for (const url of ['https://instagram.com/reel/abc123', 'https://instagram.com/p/abc123',
    'https://www.instagram.com/tv/abc123']) {
    assert.equal(postizReleaseUrl('INSTAGRAM_REELS', url), true, url);
  }
  for (const url of ['https://instagram.com/someprofile', 'https://instagram.com/', 'https://instagram.com/stories/x/1']) {
    assert.equal(postizReleaseUrl('INSTAGRAM_REELS', url), false, url);
  }
  // TikTok never publishes publicly (inbox/draft handoff only), so it has no release URL shape.
  assert.equal(postizReleaseUrl('TIKTOK', 'https://tiktok.com/@a/video/1'), false);
  assert.equal(postizReleaseUrl('UNKNOWN_PLATFORM', 'https://youtube.com/shorts/abc123'), false);
});

test('postizReleaseUrl rejects non-https and credential-bearing URLs on every platform', () => {
  for (const platform of ['YOUTUBE_SHORTS', 'FACEBOOK_REELS', 'INSTAGRAM_REELS']) {
    for (const url of ['http://youtube.com/shorts/abc123', 'https://user:pw@instagram.com/reel/abc123',
      'https://facebook.com:8443/reel/abc123', 'not-a-url', '']) {
      assert.equal(postizReleaseUrl(platform, url), false, platform + ' ' + url);
    }
  }
});

// Documents a KNOWN GAP, deliberately not asserting the ideal: FACEBOOK_REELS only
// checks the host plus a non-empty path, so any facebook.com path confirms a release.
// Instagram pins '/reel|p|tv/' by comparison. Tighten once a live Meta test shows the
// real Reels URL shape; until then interpretPostizStatus can mark a job PUBLISHED on a
// facebook.com URL that is not a Reel.
test('postizReleaseUrl is host-only for Facebook (known gap, pending live Meta test)', () => {
  assert.equal(postizReleaseUrl('FACEBOOK_REELS', 'https://facebook.com/reel/abc123'), true);
  assert.equal(postizReleaseUrl('FACEBOOK_REELS', 'https://facebook.com/x'), true);
  assert.equal(postizReleaseUrl('FACEBOOK_REELS', 'https://facebook.com/'), false);
  assert.equal(postizReleaseUrl('FACEBOOK_REELS', 'https://notfacebook.com/reel/abc123'), false);
});
