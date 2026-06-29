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
  backfillTransformationPlanRows,
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

test('WF6 dispatches Ssemble requests fairly by source before spending credits', () => {
  const moments = [
    { clip_moment_id: 'A-1', video_id: 'VID-A1', source_id: 'SRC-A', niche: 'FINANCE_BUSINESS', source_video_url: 'https://youtu.be/a1', start_sec: 0, end_sec: 90, clip_score: 10, strategy: 'USE_EXACT_CLIPS_ONLY', ssemble_status: 'PENDING', created_at: '2026-06-27T00:01:00.000Z' },
    { clip_moment_id: 'A-2', video_id: 'VID-A2', source_id: 'SRC-A', niche: 'FINANCE_BUSINESS', source_video_url: 'https://youtu.be/a2', start_sec: 0, end_sec: 90, clip_score: 9, strategy: 'USE_EXACT_CLIPS_ONLY', ssemble_status: 'PENDING', created_at: '2026-06-27T00:02:00.000Z' },
    { clip_moment_id: 'B-1', video_id: 'VID-B1', source_id: 'SRC-B', niche: 'FINANCE_BUSINESS', source_video_url: 'https://youtu.be/b1', start_sec: 0, end_sec: 90, clip_score: 8, strategy: 'USE_EXACT_CLIPS_ONLY', ssemble_status: 'PENDING', created_at: '2026-06-27T00:01:00.000Z' },
  ];

  const requests = planSsembleRequests(moments, [], {
    dailyBudget: 3,
    now: '2026-06-27T10:00:00.000Z',
    perSourceLimit: 1,
  });

  assert.deepEqual(requests.map((request) => request.clip_moment_id), ['A-1', 'B-1']);
});

test('WF6 falls back to niche fairness when source_id is missing', () => {
  const moments = [
    { clip_moment_id: 'F-1', video_id: 'VID-F1', niche: 'FINANCE_BUSINESS', source_video_url: 'https://youtu.be/f1', start_sec: 0, end_sec: 90, clip_score: 10, strategy: 'USE_EXACT_CLIPS_ONLY', ssemble_status: 'PENDING', created_at: '2026-06-27T00:01:00.000Z' },
    { clip_moment_id: 'F-2', video_id: 'VID-F2', niche: 'FINANCE_BUSINESS', source_video_url: 'https://youtu.be/f2', start_sec: 0, end_sec: 90, clip_score: 9, strategy: 'USE_EXACT_CLIPS_ONLY', ssemble_status: 'PENDING', created_at: '2026-06-27T00:02:00.000Z' },
    { clip_moment_id: 'C-1', video_id: 'VID-C1', niche: 'CHRISTIAN_CONTENT', source_video_url: 'https://youtu.be/c1', start_sec: 0, end_sec: 90, clip_score: 8, strategy: 'USE_EXACT_CLIPS_ONLY', ssemble_status: 'PENDING', created_at: '2026-06-27T00:01:00.000Z' },
  ];

  const requests = planSsembleRequests(moments, [], {
    dailyBudget: 3,
    now: '2026-06-27T10:00:00.000Z',
    perSourceLimit: 1,
  });

  assert.deepEqual(requests.map((request) => request.clip_moment_id), ['F-1', 'C-1']);
});

test('WF6 balances Ssemble spend by niche before spending extra credits in one niche', () => {
  const moments = [
    { clip_moment_id: 'F-A1', video_id: 'VID-FA1', source_id: 'SRC-FA', niche: 'FINANCE_BUSINESS', source_video_url: 'https://youtu.be/fa1', start_sec: 0, end_sec: 90, clip_score: 10, strategy: 'USE_EXACT_CLIPS_ONLY', ssemble_status: 'PENDING', created_at: '2026-06-27T00:01:00.000Z' },
    { clip_moment_id: 'F-A2', video_id: 'VID-FA2', source_id: 'SRC-FA', niche: 'FINANCE_BUSINESS', source_video_url: 'https://youtu.be/fa2', start_sec: 0, end_sec: 90, clip_score: 9, strategy: 'USE_EXACT_CLIPS_ONLY', ssemble_status: 'PENDING', created_at: '2026-06-27T00:02:00.000Z' },
    { clip_moment_id: 'F-B1', video_id: 'VID-FB1', source_id: 'SRC-FB', niche: 'FINANCE_BUSINESS', source_video_url: 'https://youtu.be/fb1', start_sec: 0, end_sec: 90, clip_score: 8, strategy: 'USE_EXACT_CLIPS_ONLY', ssemble_status: 'PENDING', created_at: '2026-06-27T00:03:00.000Z' },
    { clip_moment_id: 'C-A1', video_id: 'VID-CA1', source_id: 'SRC-CA', niche: 'CHRISTIAN_CONTENT', source_video_url: 'https://youtu.be/ca1', start_sec: 0, end_sec: 90, clip_score: 7, strategy: 'USE_EXACT_CLIPS_ONLY', ssemble_status: 'PENDING', created_at: '2026-06-27T00:01:00.000Z' },
  ];

  const requests = planSsembleRequests(moments, [], {
    dailyBudget: 3,
    now: '2026-06-27T10:00:00.000Z',
    perSourceLimit: 2,
  });

  assert.deepEqual(requests.map((request) => request.clip_moment_id), ['F-A1', 'C-A1', 'F-B1']);
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

test('WF8 picks awaiting downloads fairly by source lineage', () => {
  const clips = [
    { created_clip_id: 'CC-A1', ssemble_job_id: 'REQ-A1', review_status: 'AWAITING_DOWNLOAD', created_at: '2026-06-27T00:01:00.000Z' },
    { created_clip_id: 'CC-A2', ssemble_job_id: 'REQ-A2', review_status: 'AWAITING_DOWNLOAD', created_at: '2026-06-27T00:02:00.000Z' },
    { created_clip_id: 'CC-B1', ssemble_job_id: 'REQ-B1', review_status: 'AWAITING_DOWNLOAD', created_at: '2026-06-27T00:01:00.000Z' },
  ];
  const jobs = [
    { ssemble_job_id: 'REQ-A1', clip_moment_id: 'CM-A1', video_id: 'VID-A1', niche: 'FINANCE_BUSINESS' },
    { ssemble_job_id: 'REQ-A2', clip_moment_id: 'CM-A2', video_id: 'VID-A2', niche: 'FINANCE_BUSINESS' },
    { ssemble_job_id: 'REQ-B1', clip_moment_id: 'CM-B1', video_id: 'VID-B1', niche: 'FINANCE_BUSINESS' },
  ];
  const moments = [
    { clip_moment_id: 'CM-A1', source_id: 'SRC-A' },
    { clip_moment_id: 'CM-A2', source_id: 'SRC-A' },
    { clip_moment_id: 'CM-B1', source_id: 'SRC-B' },
  ];

  const selected = pickAwaitingDownloads(clips, jobs, moments, { FINANCE_BUSINESS: 'FOLDER-1' }, { limit: 5, perSourceLimit: 1 });

  assert.deepEqual(selected.map((clip) => clip.created_clip_id), ['CC-A1', 'CC-B1']);
});

test('WF8 falls back to niche fairness when source_id lineage is missing', () => {
  const clips = [
    { created_clip_id: 'CC-F1', ssemble_job_id: 'REQ-F1', review_status: 'AWAITING_DOWNLOAD', created_at: '2026-06-27T00:01:00.000Z' },
    { created_clip_id: 'CC-F2', ssemble_job_id: 'REQ-F2', review_status: 'AWAITING_DOWNLOAD', created_at: '2026-06-27T00:02:00.000Z' },
    { created_clip_id: 'CC-C1', ssemble_job_id: 'REQ-C1', review_status: 'AWAITING_DOWNLOAD', created_at: '2026-06-27T00:01:00.000Z' },
  ];
  const jobs = [
    { ssemble_job_id: 'REQ-F1', clip_moment_id: 'CM-F1', video_id: 'VID-F1', niche: 'FINANCE_BUSINESS' },
    { ssemble_job_id: 'REQ-F2', clip_moment_id: 'CM-F2', video_id: 'VID-F2', niche: 'FINANCE_BUSINESS' },
    { ssemble_job_id: 'REQ-C1', clip_moment_id: 'CM-C1', video_id: 'VID-C1', niche: 'CHRISTIAN_CONTENT' },
  ];

  const selected = pickAwaitingDownloads(clips, jobs, [], {
    FINANCE_BUSINESS: 'FOLDER-F',
    CHRISTIAN_CONTENT: 'FOLDER-C',
  }, { limit: 5, perSourceLimit: 1 });

  assert.deepEqual(selected.map((clip) => clip.created_clip_id), ['CC-F1', 'CC-C1']);
});

test('WF8 balances downloads by niche before taking extra clips from one niche', () => {
  const clips = [
    { created_clip_id: 'CC-FA1', ssemble_job_id: 'REQ-FA1', review_status: 'AWAITING_DOWNLOAD', created_at: '2026-06-27T00:01:00.000Z' },
    { created_clip_id: 'CC-FA2', ssemble_job_id: 'REQ-FA2', review_status: 'AWAITING_DOWNLOAD', created_at: '2026-06-27T00:02:00.000Z' },
    { created_clip_id: 'CC-FB1', ssemble_job_id: 'REQ-FB1', review_status: 'AWAITING_DOWNLOAD', created_at: '2026-06-27T00:03:00.000Z' },
    { created_clip_id: 'CC-CA1', ssemble_job_id: 'REQ-CA1', review_status: 'AWAITING_DOWNLOAD', created_at: '2026-06-27T00:01:00.000Z' },
  ];
  const jobs = [
    { ssemble_job_id: 'REQ-FA1', clip_moment_id: 'CM-FA1', video_id: 'VID-FA1', niche: 'FINANCE_BUSINESS' },
    { ssemble_job_id: 'REQ-FA2', clip_moment_id: 'CM-FA2', video_id: 'VID-FA2', niche: 'FINANCE_BUSINESS' },
    { ssemble_job_id: 'REQ-FB1', clip_moment_id: 'CM-FB1', video_id: 'VID-FB1', niche: 'FINANCE_BUSINESS' },
    { ssemble_job_id: 'REQ-CA1', clip_moment_id: 'CM-CA1', video_id: 'VID-CA1', niche: 'CHRISTIAN_CONTENT' },
  ];
  const moments = [
    { clip_moment_id: 'CM-FA1', source_id: 'SRC-FA' },
    { clip_moment_id: 'CM-FA2', source_id: 'SRC-FA' },
    { clip_moment_id: 'CM-FB1', source_id: 'SRC-FB' },
    { clip_moment_id: 'CM-CA1', source_id: 'SRC-CA' },
  ];

  const selected = pickAwaitingDownloads(clips, jobs, moments, {
    FINANCE_BUSINESS: 'FOLDER-F',
    CHRISTIAN_CONTENT: 'FOLDER-C',
  }, { limit: 3, perSourceLimit: 2 });

  assert.deepEqual(selected.map((clip) => clip.created_clip_id), ['CC-FA1', 'CC-CA1', 'CC-FB1']);
});

test('WF8 planner request carries the strict JSON schema and schema instructions', () => {
  const planner = buildPlannerRequest({
    created_clip_id: 'CC-1', niche: 'FINANCE_BUSINESS', clip_title: 'Money', duration_seconds: 45,
  });
  const schema = JSON.parse(planner.transformation_schema);

  assert.equal(schema.type, 'object');
  assert.equal(schema.additionalProperties, false);
  assert(schema.required.includes('best_title'));
  assert(schema.required.includes('caption'));
  assert.match(planner.user_message, /must conform to this schema/);
  assert.match(planner.user_message, /Do not use Markdown code fences/);
});

test('WF8 parse survives fenced, array, and content-part response shapes', () => {
  const meta = { created_clip_id: 'CC-1', video_id: 'VID-1', niche: 'FINANCE_BUSINESS' };
  const payload = { best_title: 'Stop Wasting M-Pesa', caption: 'Hard truth about money' };

  const fenced = parseTransformationPlan(meta, {
    choices: [{ message: { content: '```json\n' + JSON.stringify(payload) + '\n```' } }],
  });
  const arrayShape = parseTransformationPlan(meta, [{ message: { content: JSON.stringify(payload) } }]);
  const contentParts = parseTransformationPlan(meta, {
    content: [{ type: 'output_text', text: JSON.stringify(payload) }],
  });

  for (const out of [fenced, arrayShape, contentParts]) {
    assert.equal(out.suggested_title, 'Stop Wasting M-Pesa');
    assert.equal(out.suggested_caption, 'Hard truth about money');
    assert.equal(out.review_status, 'NEEDS_REVIEW');
  }
});

test('WF8 parse promotes transformation plan fields into readable sheet columns', () => {
  const meta = { created_clip_id: 'CC-1', video_id: 'VID-1', niche: 'FINANCE_BUSINESS' };
  const payload = {
    content_thesis: 'Kenyan founders need distribution before polish.',
    best_title: 'Distribution Beats Polish',
    alternative_titles: ['Build Distribution First', 'Stop Polishing in Private'],
    hook: 'Your startup does not need more polish.',
    narration_script: 'Start with buyers, not vanity metrics.',
    commentary_angle: 'Explain why local distribution beats perfect infrastructure.',
    kenyan_african_localization: 'Use M-Pesa, WhatsApp groups, and estate-level agents.',
    bible_verse_if_relevant: 'null',
    on_screen_text_beats: ['Distribution first', 'Talk to buyers', 'Use local channels'],
    broll_plan: ['Founder on phone', 'M-Pesa payment screen'],
    editing_style: 'Fast cuts with readable captions',
    caption: 'Build where buyers already are.',
    hashtags: ['#KenyanStartups', '#BusinessTips'],
    cta: 'Follow for practical African startup lessons.',
    risk_warning: 'Avoid implying guaranteed business results.',
    originality_checklist: ['Adds local context', 'Uses original narration'],
  };

  const parsed = parseTransformationPlan(meta, payload);

  assert.equal(parsed.content_thesis, payload.content_thesis);
  assert.equal(parsed.hook, payload.hook);
  assert.equal(parsed.narration_script, payload.narration_script);
  assert.equal(parsed.commentary_angle, payload.commentary_angle);
  assert.equal(parsed.kenyan_african_localization, payload.kenyan_african_localization);
  assert.equal(parsed.bible_verse_if_relevant, '');
  assert.equal(parsed.alternative_titles, 'Build Distribution First\nStop Polishing in Private');
  assert.equal(parsed.on_screen_text_beats, 'Distribution first\nTalk to buyers\nUse local channels');
  assert.equal(parsed.broll_plan, 'Founder on phone\nM-Pesa payment screen');
  assert.equal(parsed.editing_style, payload.editing_style);
  assert.equal(parsed.hashtags, '#KenyanStartups #BusinessTips');
  assert.equal(parsed.cta, payload.cta);
  assert.equal(parsed.risk_warning, payload.risk_warning);
  assert.equal(parsed.originality_checklist, 'Adds local context\nUses original narration');
  assert.equal(parsed.review_status, 'NEEDS_REVIEW');
});

test('WF8b backfills readable transformation columns from existing JSON plans', () => {
  const rows = backfillTransformationPlanRows([
    {
      created_clip_id: 'CC-old',
      video_id: 'VID-old',
      niche: 'FINANCE_BUSINESS',
      transformation_plan: JSON.stringify({
        content_thesis: 'Old thesis',
        best_title: 'Old Title',
        alternative_titles: ['Alt One', 'Alt Two'],
        hook: 'Old hook',
        narration_script: 'Old narration',
        commentary_angle: 'Old angle',
        kenyan_african_localization: 'Old localization',
        bible_verse_if_relevant: null,
        on_screen_text_beats: ['Beat one', 'Beat two'],
        broll_plan: ['Shot one'],
        editing_style: 'Clean captions',
        caption: 'Old caption',
        hashtags: ['KenyaBusiness', '#Startups'],
        cta: 'Old CTA',
        risk_warning: 'Old risk',
        originality_checklist: ['Original enough'],
      }),
      content_thesis: '',
    },
    {
      created_clip_id: 'CC-done',
      transformation_plan: '{"best_title":"Done"}',
      content_thesis: 'Already filled',
    },
    {
      created_clip_id: 'CC-bad',
      transformation_plan: 'not json',
      content_thesis: '',
    },
  ]);

  assert.equal(rows.length, 1);
  assert.equal(rows[0].created_clip_id, 'CC-old');
  assert.equal(rows[0].content_thesis, 'Old thesis');
  assert.equal(rows[0].suggested_title, 'Old Title');
  assert.equal(rows[0].suggested_caption, 'Old caption');
  assert.equal(rows[0].hashtags, '#KenyaBusiness #Startups');
  assert.equal(rows[0].alternative_titles, 'Alt One\nAlt Two');
});

test('WF8 parse flags unrecoverable responses for retry instead of writing blanks', () => {
  const meta = { created_clip_id: 'CC-1', video_id: 'VID-1', niche: 'FINANCE_BUSINESS' };

  const garbage = parseTransformationPlan(meta, { choices: [{ message: { content: 'not json at all' } }] });
  const apiError = parseTransformationPlan(meta, { error: { message: 'rate limited' } });

  assert.equal(garbage.review_status, 'NEEDS_RETRY');
  assert.equal(garbage.suggested_title, '');
  assert.match(garbage.transformation_plan, /parse_error/);
  assert.equal(apiError.review_status, 'NEEDS_RETRY');
  assert.match(apiError.transformation_plan, /rate limited/);
});

test('WF8 planner OpenAI node enforces strict json_schema structured output', () => {
  const workflow = requireWorkflow('08', 'drive-storage-transform');
  const openAi = workflow.nodes.find((node) => node.name === 'Call OpenAI Planner');
  const textOptions = openAi.parameters.options.textFormat.textOptions;

  assert.equal(textOptions.type, 'json_schema');
  assert.equal(textOptions.strict, true);
  assert.equal(textOptions.schema, '={{ $json.transformation_schema }}');
  assert.equal(openAi.onError, 'continueRegularOutput');
  assert(!openAi.parameters.responses.values.some((value) => Object.keys(value).length === 0));
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

test('WF8b one-off backfill workflow parses transformation JSON and updates Created_Clips', () => {
  const workflow = requireWorkflow('08b', 'created-clips-transform-backfill');
  const names = workflow.nodes.map((node) => node.name);

  assert(names.includes('Manual Trigger'));
  assert(names.includes('Read Created_Clips'));
  assert(names.includes('Backfill Transform Columns'));
  assert(names.includes('Update Created_Clips'));
  assert.equal(workflow.connections['Manual Trigger'].main[0][0].node, 'Read Created_Clips');
  assert.equal(workflow.connections['Read Created_Clips'].main[0][0].node, 'Backfill Transform Columns');
  assert.equal(workflow.connections['Backfill Transform Columns'].main[0][0].node, 'Update Created_Clips');
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

test('WF9 digest alerts when a niche has no active channels left', () => {
  const channels = [
    { source_name: 'Finance A', niche: 'FINANCE_BUSINESS', active_status: 'FALSE', auto_paused_at: new Date().toISOString(), auto_paused_reason: 'skip_rate=80%' },
    { source_name: 'Finance B', niche: 'FINANCE_BUSINESS', active_status: 'FALSE', auto_paused_at: '', auto_paused_reason: 'manual disable' },
    { source_name: 'Faith A', niche: 'CHRISTIAN_CONTENT', active_status: 'TRUE' },
  ];

  const digest = buildReviewDigest([], channels);

  assert.match(digest.subject, /niche attention/);
  assert.match(digest.html, /FINANCE_BUSINESS/);
  assert.match(digest.html, /No active channels remain/);
});

test('WF9 digest returns null when no clips and no recently paused channels', () => {
  const oldTimestamp = new Date(Date.now() - 90000000).toISOString(); // 25h ago
  const channels = [
    { source_name: 'Old Channel', niche: 'FINANCE_BUSINESS', auto_paused_at: oldTimestamp, auto_paused_reason: 'skip_rate=70%' },
    { source_name: 'Active Channel', niche: 'FINANCE_BUSINESS', active_status: 'TRUE' },
  ];
  assert.equal(buildReviewDigest([], channels), null);
});

test('WF9 digest includes both clips and channels when both present', () => {
  const now = new Date().toISOString();
  const clips = [{ review_status: 'NEEDS_REVIEW', niche: 'MOTIVATION_DISCIPLINE', created_clip_id: 'clip-1', google_drive_url: 'https://drive/1', duration_seconds: 60, reviewer_notes: '', suggested_title: 'Test' }];
  const channels = [
    { source_name: 'Finance Guru KE', niche: 'FINANCE_BUSINESS', active_status: 'FALSE', auto_paused_at: now, auto_paused_reason: 'skip_rate=80%' },
    { source_name: 'Finance Backup', niche: 'FINANCE_BUSINESS', active_status: 'TRUE' },
  ];
  const digest = buildReviewDigest(clips, channels);
  assert.match(digest.subject, /1 clips, 1 channels auto-paused/);
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

test('WF7b polling fallback checks stale Ssemble jobs and only fetches shorts after completed status', () => {
  const workflow = requireWorkflow('07b', 'ssemble-polling-fallback');
  const names = workflow.nodes.map((node) => node.name);
  const statusNode = workflow.nodes.find((node) => node.name === 'Check Ssemble Status');
  const shortsNode = workflow.nodes.find((node) => node.name === 'Get Ssemble Shorts');
  const shortsInbound = Object.entries(workflow.connections)
    .flatMap(([source, connection]) => (connection.main || [])
      .flatMap((branch) => branch.map((target) => ({ source, target: target.node }))))
    .filter((connection) => connection.target === 'Get Ssemble Shorts');
  const sheetWriteNodes = new Set([
    'Append Created_Clips',
    'Update Error Status',
    'Update Processing Status',
  ]);
  const skipNoOpTarget = workflow.connections['Still Needs Poll?'].main[1][0].node;
  const emptyShortsTarget = workflow.connections['Completed Has Shorts?'].main[1][0].node;

  assert.equal(workflow.nodes[0].name, 'Schedule 15m');
  assert(names.includes('Pick Stale Submitted Jobs'));
  assert(names.includes('Confirm Still Submitted'));
  assert(names.includes('Still Needs Poll?'));
  assert(names.includes('Check Ssemble Status'));
  assert(names.includes('Get Ssemble Shorts'));
  assert(names.includes('Normalize Completed Poll'));
  assert(names.includes('Completed Has Shorts?'));
  assert(names.includes('Append Created_Clips'));
  assert.match(statusNode.parameters.url, /\/status/);
  assert.doesNotMatch(shortsNode.parameters.url, /\/status/);
  assert.equal(statusNode.parameters.authentication, 'genericCredentialType');
  assert.equal(statusNode.parameters.genericAuthType, 'httpHeaderAuth');
  assert.equal(shortsNode.parameters.authentication, 'genericCredentialType');
  assert.equal(shortsNode.parameters.genericAuthType, 'httpHeaderAuth');
  assert.equal(workflow.connections['Confirm Still Submitted'].main[0][0].node, 'Still Needs Poll?');
  assert.equal(workflow.connections['Still Needs Poll?'].main[0][0].node, 'Check Ssemble Status');
  assert.equal(skipNoOpTarget, 'Wait 2s Pending');
  assert(!sheetWriteNodes.has(skipNoOpTarget));
  assert.deepEqual(shortsInbound, [{ source: 'Status Completed?', target: 'Get Ssemble Shorts' }]);
  assert.equal(workflow.connections['Status Completed?'].main[0][0].node, 'Get Ssemble Shorts');
  assert.equal(workflow.connections['Status Completed?'].main[1][0].node, 'Status Failed?');
  assert.equal(workflow.connections['Status Failed?'].main[1][0].node, 'Wait 2s Pending');
  assert.equal(workflow.connections['Get Ssemble Shorts'].main[0][0].node, 'Normalize Completed Poll');
  assert.equal(workflow.connections['Normalize Completed Poll'].main[0][0].node, 'Completed Has Shorts?');
  assert.equal(workflow.connections['Completed Has Shorts?'].main[0][0].node, 'Shape Job Completed');
  assert.equal(emptyShortsTarget, 'Wait 2s Pending');
  assert(!sheetWriteNodes.has(emptyShortsTarget));
  assert.equal(workflow.connections['Append Created_Clips'].main[0][0].node, 'Wait 2s Completed');
  assert.equal(workflow.connections['Wait 2s Pending'].main[0][0].node, 'Poll Loop');
});

test('WF7, WF7b, WF8, and WF9 workflow files exist with expected entry nodes', () => {
  assert.equal(requireWorkflow('07', 'ssemble-webhook-receiver').nodes[0].name, 'Webhook');
  assert.equal(requireWorkflow('07b', 'ssemble-polling-fallback').nodes[0].name, 'Schedule 15m');
  assert.equal(requireWorkflow('08', 'drive-storage-transform').nodes[0].name, 'Schedule 30m');
  assert.equal(requireWorkflow('09', 'review-queue-digest').nodes[0].name, 'Schedule Daily');
});
