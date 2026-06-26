const assert = require('node:assert/strict');
const test = require('node:test');

const {
  buildReservationRow,
  buildSubmittedJobUpdate,
  planSsembleRequests,
} = require('../n8n/workflow-code/ssemble-dispatch');
const {
  attachMoment,
  explodeCreatedClips,
  verifyAndParseWebhook,
} = require('../n8n/workflow-code/ssemble-webhook');
const {
  buildNoopPollResult,
  pickStaleSubmittedJobs,
  shouldPollCurrentJob,
  normalizeCompletedPollResult,
  normalizeFailedPollStatus,
  normalizeStatusResponse,
} = require('../n8n/workflow-code/ssemble-polling');
const {
  buildPlannerRequest,
  parseTransformationPlan,
  pickAwaitingDownloads,
} = require('../n8n/workflow-code/drive-storage-transform');
const { buildReviewDigest } = require('../n8n/workflow-code/review-queue-digest');

const wf5 = require('../n8n/workflows/05-ai-transcript-analysis.json');

function requireWorkflow(number, name) {
  return require(`../n8n/workflows/${number}-${name}.json`);
}

test('WF5 uses OpenAI after provider rollback', () => {
  const names = wf5.nodes.map((node) => node.name);

  assert(names.includes('Build OpenAI Request'));
  assert(names.includes('Call OpenAI'));
  assert(!names.some((name) => name.toLowerCase().includes('gemini')));
});

test('WF6 plans Ssemble requests with daily budget, dedupe, and 60s padding', () => {
  const requests = planSsembleRequests(
    [
      {
        clip_moment_id: 'CM-1',
        video_id: 'VID-1',
        niche: 'FINANCE_BUSINESS',
        source_video_url: 'https://www.youtube.com/watch?v=abc',
        start_sec: 30,
        end_sec: 45,
        clip_score: 9,
        strategy: 'USE_EXACT_CLIPS_ONLY',
        ssemble_status: 'PENDING',
      },
      {
        clip_moment_id: 'CM-2',
        video_id: 'VID-2',
        niche: 'FINANCE_BUSINESS',
        source_video_url: 'https://www.youtube.com/watch?v=def',
        start_sec: 0,
        end_sec: 90,
        clip_score: 8,
        strategy: 'USE_EXACT_CLIPS_ONLY',
        ssemble_status: 'PENDING',
      },
    ],
    [{ clip_moment_id: 'CM-2', job_status: 'RESERVED', created_at: '2026-06-17T06:00:00.000Z' }],
    {
      dailyBudget: 3,
      now: '2026-06-17T10:00:00.000Z',
      webhookUrl: 'https://example.com/webhook/ssemble-callback?secret=test',
    },
  );

  assert.equal(requests.length, 1);
  assert.equal(requests[0].clip_moment_id, 'CM-1');
  assert.equal(requests[0].end_sec - requests[0].start_sec, 60);
  assert.equal(JSON.parse(requests[0].ssemble_body).noClipping, true);
});

test('WF6 reserves a clip before calling Ssemble and later updates with requestId', () => {
  const req = planSsembleRequests(
    [{
      clip_moment_id: 'CM-1',
      video_id: 'VID-1',
      niche: 'FINANCE_BUSINESS',
      source_video_url: 'https://www.youtube.com/watch?v=abc',
      start_sec: 0,
      end_sec: 90,
      clip_score: 9,
      strategy: 'USE_EXACT_CLIPS_ONLY',
      ssemble_status: 'PENDING',
    }],
    [],
    { now: '2026-06-17T10:00:00.000Z', webhookUrl: 'https://example.com/hook' },
  )[0];

  const reservation = buildReservationRow(req, '2026-06-17T10:00:01.000Z');
  const submitted = buildSubmittedJobUpdate(req, { data: { requestId: 'REQ-123' } }, '2026-06-17T10:00:02.000Z');

  assert.equal(reservation.ssemble_job_id, 'RESERVE-CM-1');
  assert.equal(reservation.job_status, 'RESERVED');
  assert.equal(submitted.clip_moment_id, 'CM-1');
  assert.equal(submitted.ssemble_job_id, 'REQ-123');
  assert.equal(submitted.job_status, 'SUBMITTED');
});

test('WF6 workflow writes reservation before Ssemble API call', () => {
  const workflow = requireWorkflow('06', 'ssemble-dispatch');

  assert.equal(workflow.connections['Plan Requests'].main[0][0].node, 'Dispatch Loop');
  assert.equal(workflow.connections['Build Reservation Row'].main[0][0].node, 'Reserve Ssemble Job');
  assert.equal(workflow.connections['Reserve Ssemble Job'].main[0][0].node, 'Call Ssemble Create');
});

test('WF7 verifies webhook secret, joins job lineage, and explodes shorts', () => {
  const parsed = verifyAndParseWebhook(
    {
      query: { secret: 'good' },
      body: {
        event: 'shorts.completed',
        requestId: 'REQ-123',
        timestamp: '2026-06-17T10:05:00.000Z',
        data: { shorts: [{ id: 'short1', title: 'Clip', video_url: 'https://cdn/clip.mp4', duration: 42, viral_score: 88 }] },
      },
    },
    'good',
  );
  const attached = attachMoment(parsed, [{ ssemble_job_id: 'REQ-123', clip_moment_id: 'CM-1', video_id: 'VID-1', niche: 'FINANCE_BUSINESS' }]);
  const clips = explodeCreatedClips(attached, '2026-06-17T10:06:00.000Z');

  assert.equal(attached.clip_moment_id, 'CM-1');
  assert.equal(clips.length, 1);
  assert.equal(clips[0].created_clip_id, 'CC-short1');
  assert.equal(clips[0].review_status, 'AWAITING_DOWNLOAD');
});

test('WF7b picks only stale submitted jobs that still need polling', () => {
  const jobs = [
    {
      ssemble_job_id: 'REQ-old',
      clip_moment_id: 'CM-old',
      job_status: 'SUBMITTED',
      webhook_received: 'FALSE',
      created_at: '2026-06-26T09:00:00.000Z',
    },
    {
      ssemble_job_id: 'REQ-fresh',
      clip_moment_id: 'CM-fresh',
      job_status: 'SUBMITTED',
      webhook_received: 'FALSE',
      created_at: '2026-06-26T09:45:00.000Z',
    },
    {
      ssemble_job_id: 'REQ-webhook',
      clip_moment_id: 'CM-webhook',
      job_status: 'COMPLETED',
      webhook_received: 'TRUE',
      created_at: '2026-06-26T08:00:00.000Z',
    },
    {
      ssemble_job_id: '',
      clip_moment_id: 'CM-missing',
      job_status: 'SUBMITTED',
      webhook_received: 'FALSE',
      created_at: '2026-06-26T08:00:00.000Z',
    },
  ];

  const picked = pickStaleSubmittedJobs(jobs, '2026-06-26T09:31:00.000Z', 30);

  assert.deepEqual(picked.map((job) => job.ssemble_job_id), ['REQ-old']);
});

test('WF7b recheck skips jobs already closed by webhook', () => {
  assert.equal(shouldPollCurrentJob({ ssemble_job_id: 'REQ-1', job_status: 'SUBMITTED', webhook_received: 'FALSE' }), true);
  assert.equal(shouldPollCurrentJob({ job_status: 'COMPLETED', webhook_received: 'TRUE' }), false);
  assert.equal(shouldPollCurrentJob({ job_status: 'FAILED', webhook_received: 'TRUE' }), false);
  assert.equal(shouldPollCurrentJob({ job_status: 'SUBMITTED', webhook_received: 'TRUE' }), false);
});

test('WF7b normalizes Ssemble status responses into routeable states', () => {
  const completed = normalizeStatusResponse(
    { status: 'completed', data: { status: 'completed' } },
    { ssemble_job_id: 'REQ-1' },
    '2026-06-26T10:00:00.000Z',
  );
  const processing = normalizeStatusResponse(
    { data: { status: 'processing' } },
    { ssemble_job_id: 'REQ-2' },
    '2026-06-26T10:00:00.000Z',
  );
  const failed = normalizeStatusResponse(
    { status: 'failed', failureReason: 'render failed' },
    { ssemble_job_id: 'REQ-3' },
    '2026-06-26T10:00:00.000Z',
  );

  assert.equal(completed.requestId, 'REQ-1');
  assert.equal(completed.status, 'completed');
  assert.equal(completed.route, 'completed');
  assert.equal(processing.route, 'pending');
  assert.equal(failed.route, 'failed');
  assert.equal(failed.failureReason, 'render failed');
});

test('WF7b leaves transient polling errors as no-op retries', () => {
  const noop = buildNoopPollResult(
    { ssemble_job_id: 'REQ-429', clip_moment_id: 'CM-1' },
    { statusCode: 429, message: 'rate limit' },
    '2026-06-26T10:00:00.000Z',
  );

  assert.equal(noop.requestId, 'REQ-429');
  assert.equal(noop.route, 'pending');
  assert.match(noop.failureReason, /rate limit/);
});

test('WF7b completed poll result reuses WF7 clip shaping path', () => {
  const job = {
    ssemble_job_id: 'REQ-123',
    clip_moment_id: 'CM-1',
    video_id: 'VID-1',
    niche: 'FINANCE_BUSINESS',
  };
  const normalized = normalizeCompletedPollResult(
    job,
    { status: 'completed' },
    {
      data: {
        shorts: [
          {
            id: 'short1',
            title: 'Clip',
            video_url: 'https://cdn/clip.mp4',
            duration: 42,
            viral_score: 88,
          },
        ],
      },
    },
    '2026-06-26T10:05:00.000Z',
  );
  const attached = attachMoment(normalized, [job]);
  const clips = explodeCreatedClips(attached, '2026-06-26T10:06:00.000Z');

  assert.equal(normalized.completed, true);
  assert.equal(normalized.requestId, 'REQ-123');
  assert.equal(attached.clip_moment_id, 'CM-1');
  assert.equal(clips.length, 1);
  assert.equal(clips[0].created_clip_id, 'CC-short1');
  assert.equal(clips[0].review_status, 'AWAITING_DOWNLOAD');
});

test('WF7b failed and cancelled statuses close the moment as error', () => {
  const failed = normalizeFailedPollStatus(
    { ssemble_job_id: 'REQ-failed' },
    { status: 'failed', failureReason: 'render failed' },
    '2026-06-26T10:05:00.000Z',
  );
  const cancelled = normalizeFailedPollStatus(
    { ssemble_job_id: 'REQ-cancelled' },
    { status: 'cancelled' },
    '2026-06-26T10:06:00.000Z',
  );

  assert.equal(failed.completed, false);
  assert.equal(failed.requestId, 'REQ-failed');
  assert.equal(failed.failureReason, 'render failed');
  assert.equal(cancelled.failureReason, 'Ssemble returned cancelled');
});

test('WF8 reuses uploaded Drive files and builds OpenAI planner requests', () => {
  const selected = pickAwaitingDownloads(
    [{ created_clip_id: 'CC-1', ssemble_job_id: 'REQ-1', review_status: 'AWAITING_DOWNLOAD', google_drive_file_id: 'DRIVE-1', google_drive_url: 'https://drive/file' }],
    [{ ssemble_job_id: 'REQ-1', clip_moment_id: 'CM-1', video_id: 'VID-1', niche: 'FINANCE_BUSINESS' }],
    [{ clip_moment_id: 'CM-1', core_idea: 'Budgeting', commentary_angle: 'Kenyan angle', suggested_title: 'Budget' }],
    { FINANCE_BUSINESS: 'FOLDER-1' },
  );
  const planner = buildPlannerRequest(selected[0]);
  const parsed = parseTransformationPlan(
    selected[0],
    { choices: [{ message: { content: JSON.stringify({ best_title: 'Use M-Pesa Better', caption: 'Caption' }) } }] },
  );

  assert.equal(selected[0].drive_folder_id, 'FOLDER-1');
  assert.equal(planner.openai_model, 'gpt-4o-mini');
  assert.match(planner.user_message, /Budgeting/);
  assert.equal(parsed.suggested_title, 'Use M-Pesa Better');
  assert.equal(parsed.review_status, 'NEEDS_REVIEW');
});

test('WF8 uses official OpenAI node for planner', () => {
  const workflow = requireWorkflow('08', 'drive-storage-transform');
  const nodeTypes = Object.fromEntries(workflow.nodes.map((node) => [node.name, node.type]));
  const openAi = workflow.nodes.find((node) => node.name === 'Call OpenAI Planner');

  assert.equal(nodeTypes['Call OpenAI Planner'], '@n8n/n8n-nodes-langchain.openAi');
  assert.equal(openAi.parameters.operation, undefined);
  assert.equal(openAi.parameters.modelId.value, 'gpt-4o-mini');
  assert.equal(openAi.parameters.responses.values[0].role, 'system');
  assert.equal(openAi.parameters.responses.values[0].content, '={{ $json.system_message }}');
  assert.equal(openAi.parameters.responses.values[1].content, '={{ $json.user_message }}');
  assert.deepEqual(openAi.parameters.builtInTools, {});
  assert(!workflow.nodes.some((node) => node.name === 'Call OpenAI Planner' && node.type === 'n8n-nodes-base.httpRequest'));
});

test('WF9 digest skips empty queue and groups review links', () => {
  assert.equal(buildReviewDigest([]), null);

  const digest = buildReviewDigest([
    {
      niche: 'FINANCE_BUSINESS',
      review_status: 'NEEDS_REVIEW',
      google_drive_url: 'https://drive/clip',
      suggested_title: 'Budget clip',
      duration_seconds: 40,
      reviewer_notes: 'viral_score=80',
    },
  ]);

  assert.match(digest.subject, /1 clips/);
  assert.match(digest.html, /FINANCE_BUSINESS/);
  assert.match(digest.html, /https:\/\/drive\/clip/);
});

test('WF9 digest includes auto-paused channels section', () => {
  const now = new Date().toISOString();
  const channels = [
    { source_name: 'Finance Guru KE', niche: 'FINANCE_BUSINESS', auto_paused_at: now, auto_paused_reason: 'skip_rate=80% (8/10 videos)' },
  ];
  const digest = buildReviewDigest([], channels);
  assert.ok(digest !== null);
  assert.match(digest.subject, /channels auto-paused/);
  assert.match(digest.html, /Finance Guru KE/);
  assert.match(digest.html, /skip_rate=80%/);
  assert.match(digest.html, /active_status=TRUE/);
});

test('WF9 digest returns null when no clips and no recently paused channels', () => {
  const oldTimestamp = new Date(Date.now() - 90000000).toISOString(); // 25h ago
  const channels = [
    { source_name: 'Old Channel', niche: 'FINANCE_BUSINESS', auto_paused_at: oldTimestamp, auto_paused_reason: 'skip_rate=70%' },
  ];
  assert.equal(buildReviewDigest([], channels), null);
});

test('WF9 digest includes both clips and channels when both present', () => {
  const now = new Date().toISOString();
  const clips = [{ review_status: 'NEEDS_REVIEW', niche: 'MOTIVATION_DISCIPLINE', created_clip_id: 'clip-1', google_drive_url: 'https://drive/1', duration_seconds: 60, reviewer_notes: '', suggested_title: 'Test' }];
  const channels = [{ source_name: 'Finance Guru KE', niche: 'FINANCE_BUSINESS', auto_paused_at: now, auto_paused_reason: 'skip_rate=80%' }];
  const digest = buildReviewDigest(clips, channels);
  assert.match(digest.subject, /1 clips, 1 channels paused/);
  assert.match(digest.html, /Finance Guru KE/);
  assert.match(digest.html, /MOTIVATION_DISCIPLINE/);
});

test('WF9 digest channels older than 24h are excluded', () => {
  const recent = new Date().toISOString();
  const old = new Date(Date.now() - 90000000).toISOString(); // 25h ago
  const channels = [
    { source_name: 'Recent', niche: 'FINANCE_BUSINESS', auto_paused_at: recent, auto_paused_reason: 'skip_rate=80%' },
    { source_name: 'Old', niche: 'FINANCE_BUSINESS', auto_paused_at: old, auto_paused_reason: 'skip_rate=70%' },
  ];
  const digest = buildReviewDigest([], channels);
  assert.match(digest.html, /Recent/);
  assert.doesNotMatch(digest.html, /Old.*auto-paused/);
});

test('WF7, WF8, and WF9 workflow files exist with expected entry nodes', () => {
  assert.equal(requireWorkflow('07', 'ssemble-webhook-receiver').nodes[0].name, 'Webhook');
  assert.equal(requireWorkflow('08', 'drive-storage-transform').nodes[0].name, 'Schedule 30m');
  assert.equal(requireWorkflow('09', 'review-queue-digest').nodes[0].name, 'Schedule Daily');
});
