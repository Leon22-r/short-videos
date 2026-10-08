const assert = require('node:assert/strict');
const test = require('node:test');

const {
  buildCreatedClipRow,
  buildMomentStatus: buildYtDlpMomentStatus,
  buildPortraitCommand,
  buildYtDlpCommand,
  planYtDlpDownloads,
} = require('../workflow-code/yt-dlp-clip-download');
const {
  buildRenderJobRow,
  buildRenderJobBackfillRows,
  buildPlannerRequest,
  backfillTransformationPlanRows,
  normalizeRenderPlan,
  parseTransformationPlan,
  pickAwaitingDownloads,
} = require('../workflow-code/drive-storage-transform');
const {
  buildAssetDownloadPlan,
  buildCompletedRenderUpdate,
  buildFfmpegCommand,
  buildRenderFailureUpdate,
  buildRenderStatusUpdate,
  pickPendingRenderJob,
  selectMusicTrack,
} = require('../workflow-code/ffmpeg-render');
const {
  buildCredentialHealthRows,
  buildPublishAttempt,
  buildPublishClaim,
  buildPublishFailureUpdate,
  buildPublishSuccessUpdate,
  buildPublishingJobs,
  interpretFacebookStatus,
  interpretInstagramContainerStatus,
  interpretTikTokStatus,
  interpretYouTubeStatus,
  pickNextPublishJob,
  pickRetryJobs,
  providerPollUpdate,
  validateProviderJob,
} = require('../workflow-code/publishing');
const { buildReviewDigest } = require('../workflow-code/review-queue-digest');

const wf5 = require('../workflows/05-ai-transcript-analysis.json');

function requireWorkflow(number, name) {
  return require(`../workflows/${number}-${name}.json`);
}

test('WF5 uses OpenAI after provider rollback', () => {
  const names = wf5.nodes.map((node) => node.name);

  assert(names.includes('Build OpenAI Request'));
  assert(names.includes('Call OpenAI'));
  assert(!names.some((name) => name.toLowerCase().includes('gemini')));
});

test('WF6 plans yt-dlp downloads from exact pending clip moments', () => {
  const requests = planYtDlpDownloads(
    [
      {
        clip_moment_id: 'CM-1',
        video_id: 'VID-1',
        niche: 'FINANCE_BUSINESS',
        source_video_url: 'https://www.youtube.com/watch?v=abc',
        start_sec: 30,
        end_sec: 75,
        clip_score: 9,
        strategy: 'USE_EXACT_CLIPS_ONLY',
        download_status: 'PENDING',
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
        download_status: 'PENDING',
      },
    ],
    [{ created_clip_id: 'CC-CM-2', created_at: '2026-06-17T06:00:00.000Z' }],
    { FINANCE_BUSINESS: 'FOLDER-1' },
    {
      limit: 3,
    },
  );

  assert.equal(requests.length, 1);
  assert.equal(requests[0].clip_moment_id, 'CM-1');
  assert.equal(requests[0].created_clip_id, 'CC-CM-1');
  assert.equal(requests[0].download_job_id, 'YTDLP-CM-1');
  assert.equal(requests[0].duration_seconds, 45);
  assert.equal(requests[0].drive_folder_id, 'FOLDER-1');
});

test('WF6 builds a shell-quoted yt-dlp command and compatible Created_Clips row', () => {
  const req = planYtDlpDownloads(
    [{
      clip_moment_id: 'CM-1',
      video_id: 'VID-1',
      niche: 'FINANCE_BUSINESS',
      source_video_url: 'https://www.youtube.com/watch?v=abc',
      start_sec: 0,
      end_sec: 90,
      clip_score: 9,
      strategy: 'USE_EXACT_CLIPS_ONLY',
      download_status: 'PENDING',
    }],
    [],
    { FINANCE_BUSINESS: 'FOLDER-1' },
  )[0];

  const command = buildYtDlpCommand(req);
  const clip = buildCreatedClipRow(
    req,
    { id: 'DRIVE-1', webViewLink: 'https://drive/clip' },
    '2026-06-17T10:00:02.000Z',
  );

  assert.match(command, /python3 -m yt_dlp/);
  assert.match(command, /--download-sections '\*0-90'/);
  assert.match(command, /--download-sections '\*0-90' --force-keyframes-at-cuts/);
  assert.doesNotMatch(command, /--no-part/);
  assert.match(command, /test -s '\/data\/jobs\/CC-CM-1\/source\.mp4'/);
  assert.match(
    command,
    /ffprobe -v error -select_streams v:0 -show_entries stream=codec_type -of csv=p=0 '\/data\/jobs\/CC-CM-1\/source\.mp4' \| grep -q '\^video\$'/,
  );
  assert.equal(req.portrait_path, '/data/jobs/CC-CM-1/portrait.mp4');
  assert.equal(req.portrait_log_path, '/data/jobs/CC-CM-1/ffmpeg-portrait.log');
  assert.equal(clip.created_clip_id, 'CC-CM-1');
  assert.equal(clip.download_job_id, 'YTDLP-CM-1');
  assert.equal(clip.google_drive_file_id, 'DRIVE-1');
  assert.equal(clip.review_status, 'AWAITING_DOWNLOAD');
});

test('WF6 workflow runs yt-dlp before creating the downstream clip row', () => {
  const workflow = requireWorkflow('06', 'yt-dlp-clip-download');
  const names = workflow.nodes.map((node) => node.name);

  assert(names.includes('Plan yt-dlp Downloads'));
  assert(names.includes('Run yt-dlp'));
  assert(names.includes('Build Portrait Command'));
  assert(names.includes('Run FFmpeg Portrait'));
  assert(names.includes('Portrait Succeeded?'));
  assert(names.includes('Read Downloaded Clip'));
  assert(names.includes('Upload Clip To Drive'));
  assert(names.includes('Save Created Clip'));
  assert(!names.includes('Call Ssemble Create'));
  assert.equal(workflow.connections['Plan yt-dlp Downloads'].main[0][0].node, 'Download Loop');
  assert.equal(workflow.connections['Run yt-dlp'].main[0][0].node, 'Download Succeeded?');
  assert.equal(workflow.connections['Download Succeeded?'].main[0][0].node, 'Build Portrait Command');
  assert.equal(workflow.connections['Portrait Succeeded?'].main[0][0].node, 'Read Downloaded Clip');
  assert.equal(workflow.connections['Upload Clip To Drive'].main[0][0].node, 'Build Created Clip Row');
});

test('WF6 dispatches yt-dlp downloads fairly by source', () => {
  const moments = [
    { clip_moment_id: 'A-1', video_id: 'VID-A1', source_id: 'SRC-A', niche: 'FINANCE_BUSINESS', source_video_url: 'https://youtu.be/a1', start_sec: 0, end_sec: 90, clip_score: 10, strategy: 'USE_EXACT_CLIPS_ONLY', download_status: 'PENDING', created_at: '2026-06-27T00:01:00.000Z' },
    { clip_moment_id: 'A-2', video_id: 'VID-A2', source_id: 'SRC-A', niche: 'FINANCE_BUSINESS', source_video_url: 'https://youtu.be/a2', start_sec: 0, end_sec: 90, clip_score: 9, strategy: 'USE_EXACT_CLIPS_ONLY', download_status: 'PENDING', created_at: '2026-06-27T00:02:00.000Z' },
    { clip_moment_id: 'B-1', video_id: 'VID-B1', source_id: 'SRC-B', niche: 'FINANCE_BUSINESS', source_video_url: 'https://youtu.be/b1', start_sec: 0, end_sec: 90, clip_score: 8, strategy: 'USE_EXACT_CLIPS_ONLY', download_status: 'PENDING', created_at: '2026-06-27T00:01:00.000Z' },
  ];

  const requests = planYtDlpDownloads(moments, [], {}, {
    limit: 3,
    perSourceLimit: 1,
  });

  assert.deepEqual(requests.map((request) => request.clip_moment_id), ['A-1', 'B-1']);
});

test('WF6 falls back to niche fairness when source_id is missing', () => {
  const moments = [
    { clip_moment_id: 'F-1', video_id: 'VID-F1', niche: 'FINANCE_BUSINESS', source_video_url: 'https://youtu.be/f1', start_sec: 0, end_sec: 90, clip_score: 10, strategy: 'USE_EXACT_CLIPS_ONLY', download_status: 'PENDING', created_at: '2026-06-27T00:01:00.000Z' },
    { clip_moment_id: 'F-2', video_id: 'VID-F2', niche: 'FINANCE_BUSINESS', source_video_url: 'https://youtu.be/f2', start_sec: 0, end_sec: 90, clip_score: 9, strategy: 'USE_EXACT_CLIPS_ONLY', download_status: 'PENDING', created_at: '2026-06-27T00:02:00.000Z' },
    { clip_moment_id: 'C-1', video_id: 'VID-C1', niche: 'CHRISTIAN_CONTENT', source_video_url: 'https://youtu.be/c1', start_sec: 0, end_sec: 90, clip_score: 8, strategy: 'USE_EXACT_CLIPS_ONLY', download_status: 'PENDING', created_at: '2026-06-27T00:01:00.000Z' },
  ];

  const requests = planYtDlpDownloads(moments, [], {}, {
    limit: 3,
    perSourceLimit: 1,
  });

  assert.deepEqual(requests.map((request) => request.clip_moment_id), ['F-1', 'C-1']);
});

test('WF6 balances yt-dlp downloads by niche before taking extra clips in one niche', () => {
  const moments = [
    { clip_moment_id: 'F-A1', video_id: 'VID-FA1', source_id: 'SRC-FA', niche: 'FINANCE_BUSINESS', source_video_url: 'https://youtu.be/fa1', start_sec: 0, end_sec: 90, clip_score: 10, strategy: 'USE_EXACT_CLIPS_ONLY', download_status: 'PENDING', created_at: '2026-06-27T00:01:00.000Z' },
    { clip_moment_id: 'F-A2', video_id: 'VID-FA2', source_id: 'SRC-FA', niche: 'FINANCE_BUSINESS', source_video_url: 'https://youtu.be/fa2', start_sec: 0, end_sec: 90, clip_score: 9, strategy: 'USE_EXACT_CLIPS_ONLY', download_status: 'PENDING', created_at: '2026-06-27T00:02:00.000Z' },
    { clip_moment_id: 'F-B1', video_id: 'VID-FB1', source_id: 'SRC-FB', niche: 'FINANCE_BUSINESS', source_video_url: 'https://youtu.be/fb1', start_sec: 0, end_sec: 90, clip_score: 8, strategy: 'USE_EXACT_CLIPS_ONLY', download_status: 'PENDING', created_at: '2026-06-27T00:03:00.000Z' },
    { clip_moment_id: 'C-A1', video_id: 'VID-CA1', source_id: 'SRC-CA', niche: 'CHRISTIAN_CONTENT', source_video_url: 'https://youtu.be/ca1', start_sec: 0, end_sec: 90, clip_score: 7, strategy: 'USE_EXACT_CLIPS_ONLY', download_status: 'PENDING', created_at: '2026-06-27T00:01:00.000Z' },
  ];

  const requests = planYtDlpDownloads(moments, [], {}, {
    limit: 3,
    perSourceLimit: 2,
  });

  assert.deepEqual(requests.map((request) => request.clip_moment_id), ['F-A1', 'C-A1', 'F-B1']);
});

test('WF6 builds an FFmpeg portrait conversion command from a planned request', () => {
  const req = planYtDlpDownloads(
    [{
      clip_moment_id: 'CM-1',
      video_id: 'VID-1',
      niche: 'FINANCE_BUSINESS',
      source_video_url: 'https://www.youtube.com/watch?v=abc',
      start_sec: 0,
      end_sec: 90,
      download_status: 'PENDING',
    }],
    [],
    {},
  )[0];

  const command = buildPortraitCommand(req);
  assert.match(command, /ffmpeg -y/);
  assert.match(command, /-i '\/data\/jobs\/CC-CM-1\/source\.mp4'/);
  assert.match(command, /scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920:\(iw-1080\)\/2:\(ih-1920\)\/2,setsar=1/);
  assert.match(command, /-vf/);
  assert.doesNotMatch(command, /boxblur/);
  assert.match(command, /-map 0:v:0 -map 0:a:0\?/);
  assert.match(command, /-pix_fmt yuv420p/);
  assert.match(command, /-movflags \+faststart/);
  assert.match(command, /'\/data\/jobs\/CC-CM-1\/portrait\.mp4'/);
  assert.match(command, /test -s '\/data\/jobs\/CC-CM-1\/portrait\.mp4'/);
  assert.match(
    command,
    /ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=s=x:p=0 '\/data\/jobs\/CC-CM-1\/portrait\.mp4' \| grep -qx '1080x1920'/,
  );
});

test('WF6 rejects unsafe ids and invalid yt-dlp ranges before planning', () => {
  const requests = planYtDlpDownloads([
    { clip_moment_id: 'CM bad', video_id: 'VID-1', niche: 'FINANCE_BUSINESS', source_video_url: 'https://youtu.be/a', start_sec: 0, end_sec: 60, download_status: 'PENDING' },
    { clip_moment_id: 'CM-short', video_id: 'VID-2', niche: 'FINANCE_BUSINESS', source_video_url: 'https://youtu.be/b', start_sec: 0, end_sec: 20, download_status: 'PENDING' },
  ], [], {}, { limit: 5 });

  assert.deepEqual(requests, []);
  assert.deepEqual(buildYtDlpMomentStatus({ clip_moment_id: 'CM-1', download_job_id: 'YTDLP-CM-1' }, 'COMPLETED'), {
    clip_moment_id: 'CM-1',
    download_status: 'COMPLETED',
    download_job_id: 'YTDLP-CM-1',
  });
});

test('WF8 reuses uploaded Drive files and builds OpenAI planner requests', () => {
  const selected = pickAwaitingDownloads(
    [{ created_clip_id: 'CC-1', download_job_id: 'REQ-1', review_status: 'AWAITING_DOWNLOAD', google_drive_file_id: 'DRIVE-1', google_drive_url: 'https://drive/file' }],
    [{ download_job_id: 'REQ-1', clip_moment_id: 'CM-1', video_id: 'VID-1', niche: 'FINANCE_BUSINESS' }],
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
    { created_clip_id: 'CC-A1', download_job_id: 'REQ-A1', review_status: 'AWAITING_DOWNLOAD', created_at: '2026-06-27T00:01:00.000Z' },
    { created_clip_id: 'CC-A2', download_job_id: 'REQ-A2', review_status: 'AWAITING_DOWNLOAD', created_at: '2026-06-27T00:02:00.000Z' },
    { created_clip_id: 'CC-B1', download_job_id: 'REQ-B1', review_status: 'AWAITING_DOWNLOAD', created_at: '2026-06-27T00:01:00.000Z' },
  ];
  const jobs = [
    { download_job_id: 'REQ-A1', clip_moment_id: 'CM-A1', video_id: 'VID-A1', niche: 'FINANCE_BUSINESS' },
    { download_job_id: 'REQ-A2', clip_moment_id: 'CM-A2', video_id: 'VID-A2', niche: 'FINANCE_BUSINESS' },
    { download_job_id: 'REQ-B1', clip_moment_id: 'CM-B1', video_id: 'VID-B1', niche: 'FINANCE_BUSINESS' },
  ];
  const moments = [
    { clip_moment_id: 'CM-A1', source_id: 'SRC-A' },
    { clip_moment_id: 'CM-A2', source_id: 'SRC-A' },
    { clip_moment_id: 'CM-B1', source_id: 'SRC-B' },
  ];

  const selected = pickAwaitingDownloads(clips, jobs, moments, { FINANCE_BUSINESS: 'FOLDER-1' }, { limit: 5, perSourceLimit: 1 });

  assert.deepEqual(selected.map((clip) => clip.created_clip_id), ['CC-A1', 'CC-B1']);
});

test('WF8 resolves yt-dlp Created_Clips lineage back to Clip_Moments', () => {
  const selected = pickAwaitingDownloads(
    [{ created_clip_id: 'CC-CM-1', download_job_id: 'YTDLP-CM-1', review_status: 'AWAITING_DOWNLOAD', google_drive_file_id: 'DRIVE-1' }],
    [],
    [{ clip_moment_id: 'CM-1', source_id: 'SRC-1', niche: 'FINANCE_BUSINESS', core_idea: 'Track spending' }],
    { FINANCE_BUSINESS: 'FOLDER-1' },
  );

  assert.equal(selected.length, 1);
  assert.equal(selected[0].source_id, 'SRC-1');
  assert.equal(selected[0].moment_core_idea, 'Track spending');
});

test('WF8 falls back to niche fairness when source_id lineage is missing', () => {
  const clips = [
    { created_clip_id: 'CC-F1', download_job_id: 'REQ-F1', review_status: 'AWAITING_DOWNLOAD', created_at: '2026-06-27T00:01:00.000Z' },
    { created_clip_id: 'CC-F2', download_job_id: 'REQ-F2', review_status: 'AWAITING_DOWNLOAD', created_at: '2026-06-27T00:02:00.000Z' },
    { created_clip_id: 'CC-C1', download_job_id: 'REQ-C1', review_status: 'AWAITING_DOWNLOAD', created_at: '2026-06-27T00:01:00.000Z' },
  ];
  const jobs = [
    { download_job_id: 'REQ-F1', clip_moment_id: 'CM-F1', video_id: 'VID-F1', niche: 'FINANCE_BUSINESS' },
    { download_job_id: 'REQ-F2', clip_moment_id: 'CM-F2', video_id: 'VID-F2', niche: 'FINANCE_BUSINESS' },
    { download_job_id: 'REQ-C1', clip_moment_id: 'CM-C1', video_id: 'VID-C1', niche: 'CHRISTIAN_CONTENT' },
  ];

  const selected = pickAwaitingDownloads(clips, jobs, [], {
    FINANCE_BUSINESS: 'FOLDER-F',
    CHRISTIAN_CONTENT: 'FOLDER-C',
  }, { limit: 5, perSourceLimit: 1 });

  assert.deepEqual(selected.map((clip) => clip.created_clip_id), ['CC-F1', 'CC-C1']);
});

test('WF8 balances downloads by niche before taking extra clips from one niche', () => {
  const clips = [
    { created_clip_id: 'CC-FA1', download_job_id: 'REQ-FA1', review_status: 'AWAITING_DOWNLOAD', created_at: '2026-06-27T00:01:00.000Z' },
    { created_clip_id: 'CC-FA2', download_job_id: 'REQ-FA2', review_status: 'AWAITING_DOWNLOAD', created_at: '2026-06-27T00:02:00.000Z' },
    { created_clip_id: 'CC-FB1', download_job_id: 'REQ-FB1', review_status: 'AWAITING_DOWNLOAD', created_at: '2026-06-27T00:03:00.000Z' },
    { created_clip_id: 'CC-CA1', download_job_id: 'REQ-CA1', review_status: 'AWAITING_DOWNLOAD', created_at: '2026-06-27T00:01:00.000Z' },
  ];
  const jobs = [
    { download_job_id: 'REQ-FA1', clip_moment_id: 'CM-FA1', video_id: 'VID-FA1', niche: 'FINANCE_BUSINESS' },
    { download_job_id: 'REQ-FA2', clip_moment_id: 'CM-FA2', video_id: 'VID-FA2', niche: 'FINANCE_BUSINESS' },
    { download_job_id: 'REQ-FB1', clip_moment_id: 'CM-FB1', video_id: 'VID-FB1', niche: 'FINANCE_BUSINESS' },
    { download_job_id: 'REQ-CA1', clip_moment_id: 'CM-CA1', video_id: 'VID-CA1', niche: 'CHRISTIAN_CONTENT' },
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

test('WF8 planner schema includes render instructions for FFmpeg', () => {
  const planner = buildPlannerRequest({
    created_clip_id: 'CC-1',
    niche: 'FINANCE_BUSINESS',
    clip_title: 'Money',
    duration_seconds: 45,
  });
  const schema = JSON.parse(planner.transformation_schema);

  assert(schema.required.includes('render'));
  assert.equal(schema.properties.render.type, 'object');
  assert(schema.properties.render.required.includes('top_hook_text'));
  assert(schema.properties.render.required.includes('music_mood'));
  assert(schema.properties.render.required.includes('progress_bar_color'));
  assert.deepEqual(schema.properties.render.properties.music_mood.enum, [
    'peaceful',
    'reflective',
    'hopeful',
    'emotional',
    'focused',
    'confident',
    'urgent',
    'powerful',
    'inspiring',
    'warm',
  ]);
  assert.deepEqual(schema.properties.render.properties.music_energy_level.enum, ['low', 'medium', 'high']);
  assert.match(planner.user_message, /downloaded with yt-dlp/i);
  assert.match(planner.user_message, /FFmpeg render plan/i);
  assert.match(planner.user_message, /Do not invent other mood or energy values/i);
  assert.match(planner.user_message, /peaceful: calm, soft, spiritual, gentle teaching/i);
  assert.match(planner.user_message, /high energy: 0\.10 to 0\.14/i);
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
  assert.deepEqual(parsed.alternative_titles, ['Build Distribution First', 'Stop Polishing in Private']);
  assert.deepEqual(parsed.on_screen_text_beats, ['Distribution first', 'Talk to buyers', 'Use local channels']);
  assert.deepEqual(parsed.broll_plan, ['Founder on phone', 'M-Pesa payment screen']);
  assert.equal(parsed.editing_style, payload.editing_style);
  assert.deepEqual(parsed.hashtags, ['#KenyanStartups', '#BusinessTips']);
  assert.equal(parsed.cta, payload.cta);
  assert.equal(parsed.risk_warning, payload.risk_warning);
  assert.deepEqual(parsed.originality_checklist, ['Adds local context', 'Uses original narration']);
  assert.equal(parsed.review_status, 'NEEDS_REVIEW');
});

test('WF8 builds normalized Render_Jobs rows from transformation plans', () => {
  const meta = {
    created_clip_id: 'CC-99',
    video_id: 'VID-99',
    niche: 'FINANCE_BUSINESS',
    drive_file_id: 'SRC-DRIVE-99',
    drive_url: 'https://drive/source',
    file_name: 'FINANCE_BUSINESS_CC-99.mp4',
    duration_seconds: 45,
  };
  const parsed = parseTransformationPlan(meta, {
    content_thesis: 'Money habits decide the outcome.',
    best_title: 'Track Your Money',
    alternative_titles: ['Know Where It Goes', 'Money Needs Direction'],
    hook: 'You cannot fix money you do not track.',
    narration_script: 'Track spending before chasing income.',
    commentary_angle: 'Make this practical for Kenyan earners.',
    kenyan_african_localization: 'Mention M-Pesa statements and chama discipline.',
    bible_verse_if_relevant: null,
    on_screen_text_beats: ['Track it', 'Review weekly'],
    broll_plan: ['Budget notebook'],
    editing_style: 'Clean finance education',
    caption: 'Track first. Optimize second.',
    hashtags: ['FinanceBusiness'],
    cta: 'Follow for practical money lessons.',
    risk_warning: 'No guaranteed results.',
    originality_checklist: ['Adds original commentary'],
    render: {
      top_hook_text: 'Why your money disappears',
      cta_text: 'Follow for practical money lessons',
      cta_start_second: 50,
      cta_end_second: 5,
      music_mood: 'focused',
      music_energy_level: 'medium',
      music_volume: 0.3,
      use_blurred_background: true,
      progress_bar_color: '#137546',
    },
  });

  const row = buildRenderJobRow(parsed, '2026-06-29T10:00:00.000Z');

  assert.equal(row.render_id, 'RENDER_CC-99');
  assert.equal(row.created_clip_id, 'CC-99');
  assert.equal(row.source_drive_file_id, 'SRC-DRIVE-99');
  assert.equal(row.hook_text, 'Why your money disappears');
  assert.equal(row.cta_start_second, 42);
  assert.equal(row.cta_end_second, 45);
  assert.equal(row.music_volume, 0.14);
  assert.equal(row.progress_bar_color, '0x137546');
  assert.equal(row.render_status, 'PENDING');
});

test('WF8 rejects a created_clip_id that would escape the render path', () => {
  for (const badId of ['../../etc/passwd', 'cc/99', 'cc 99', 'cc;rm', '']) {
    assert.throws(
      () => buildRenderJobRow({ created_clip_id: badId, niche: 'FINANCE_BUSINESS' }, '2026-06-29T10:00:00.000Z'),
      /Unsafe created_clip_id/,
    );
  }
});

test('WF8d backfills PENDING render jobs for created clips missing one', () => {
  const validPlan = JSON.stringify({ best_title: 'Track Your Money', render: { top_hook_text: 'Why money disappears', cta_text: 'Follow' } });
  const created = [
    // Ready: has plan + drive file, no existing render job -> PENDING job created.
    { created_clip_id: 'CC-1', niche: 'FINANCE_BUSINESS', google_drive_file_id: 'SRC-1', transformation_plan: validPlan },
    // Already has a render job -> skipped (not recreated).
    { created_clip_id: 'CC-2', niche: 'FINANCE_BUSINESS', google_drive_file_id: 'SRC-2', transformation_plan: validPlan },
    // Not uploaded to Drive yet -> skipped (nothing to render).
    { created_clip_id: 'CC-3', niche: 'FINANCE_BUSINESS', transformation_plan: validPlan },
    // Unparseable plan -> skipped.
    { created_clip_id: 'CC-4', niche: 'FINANCE_BUSINESS', google_drive_file_id: 'SRC-4', transformation_plan: '{not json' },
    // No plan at all -> skipped.
    { created_clip_id: 'CC-5', niche: 'FINANCE_BUSINESS', google_drive_file_id: 'SRC-5' },
  ];
  const existing = [{ render_id: 'RENDER_CC-2', render_status: 'COMPLETED' }];

  const jobs = buildRenderJobBackfillRows(created, existing, '2026-06-30T00:00:00.000Z');

  assert.deepEqual(jobs.map((j) => j.render_id), ['RENDER_CC-1']);
  assert.equal(jobs[0].render_status, 'PENDING');
  assert.equal(jobs[0].source_drive_file_id, 'SRC-1');
  assert.equal(jobs[0].hook_text, 'Why money disappears');
  assert.equal(jobs[0].created_at, '2026-06-30T00:00:00.000Z');
});

test('WF8d is idempotent and does not duplicate within one batch', () => {
  const validPlan = JSON.stringify({ best_title: 'T', render: {} });
  const created = [
    { created_clip_id: 'CC-9', niche: 'FINANCE_BUSINESS', google_drive_file_id: 'SRC-9', transformation_plan: validPlan },
    { created_clip_id: 'CC-9', niche: 'FINANCE_BUSINESS', google_drive_file_id: 'SRC-9', transformation_plan: validPlan },
  ];
  assert.equal(buildRenderJobBackfillRows(created, []).length, 1);
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
  // hashtags is text[] too, so the tags stay separate rather than joined.
  assert.deepEqual(rows[0].hashtags, ['#KenyaBusiness', '#Startups']);
  assert.deepEqual(rows[0].alternative_titles, ['Alt One', 'Alt Two']);
});

test('WF8 parse flags unrecoverable responses for retry instead of writing blanks', () => {
  const meta = { created_clip_id: 'CC-1', video_id: 'VID-1', niche: 'FINANCE_BUSINESS' };

  const garbage = parseTransformationPlan(meta, { choices: [{ message: { content: 'not json at all' } }] });
  const apiError = parseTransformationPlan(meta, { error: { message: 'rate limited' } });

  assert.equal(garbage.review_status, 'NEEDS_RETRY');
  assert.equal(garbage.suggested_title, '');
  // transformation_plan is jsonb now, so the failure detail is an object.
  assert.match(garbage.transformation_plan.parse_error, /not valid JSON/);
  assert.equal(apiError.review_status, 'NEEDS_RETRY');
  assert.match(apiError.transformation_plan.parse_error, /rate limited/);
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

test('WF8 creates Render_Jobs rows after updating Created_Clips', () => {
  const workflow = requireWorkflow('08', 'drive-storage-transform');
  const names = workflow.nodes.map((node) => node.name);

  assert(names.includes('Build Render Job'));
  assert(names.includes('Create Render Job'));
  assert.equal(workflow.connections['Update Created Clip'].main[0][0].node, 'Build Render Job');
  assert.equal(workflow.connections['Build Render Job'].main[0][0].node, 'Create Render Job');
  assert.equal(workflow.connections['Create Render Job'].main[0][0].node, 'Clip Loop');
});

test('WF8c workflow renders one pending job and stores FFmpeg command', () => {
  const workflow = requireWorkflow('08c', 'ffmpeg-render-final-clip');
  const names = workflow.nodes.map((node) => node.name);

  assert(names.includes('Read Render_Jobs'));
  assert(names.includes('Pick Pending Render'));
  assert(names.includes('Read Channel_Branding'));
  assert(names.includes('Read Music_Library'));
  assert(names.includes('Build Asset Plan'));
  assert(names.includes('Create Render Workspace'));
  assert(names.includes('Download Source Clip'));
  assert(names.includes('Write Source Clip'));
  assert(names.includes('Download Watermark'));
  assert(names.includes('Write Watermark'));
  assert(names.includes('Download Music'));
  assert(names.includes('Write Music'));
  assert(names.includes('Build FFmpeg Command'));
  assert(names.includes('Run FFmpeg'));
  assert(names.includes('Read Final Output'));
  assert(names.includes('Upload Final To Drive'));
  assert(names.includes('Mark Render Completed'));
  assert.equal(workflow.connections['Assets Ready?'].main[0][0].node, 'Create Render Workspace');
  assert.equal(workflow.connections['Create Render Workspace'].main[0][0].node, 'Download Source Clip');
  assert.equal(workflow.nodes.find((node) => node.name === 'Run FFmpeg').type, 'n8n-nodes-base.executeCommand');
  assert.match(workflow.nodes.find((node) => node.name === 'Create Render Workspace').parameters.command, /mkdir -p/);
  assert.equal(
    workflow.nodes.find((node) => node.name === 'Download Source Clip').parameters.fileId.value,
    '={{ $("Build Asset Plan").first().json.source_drive_file_id }}',
  );
  assert.equal(workflow.nodes.find((node) => node.name === 'Write Source Clip').type, 'n8n-nodes-base.readWriteFile');
  assert.equal(workflow.nodes.find((node) => node.name === 'Read Final Output').type, 'n8n-nodes-base.readWriteFile');
});

test('WF8c picks one oldest pending render job', () => {
  const picked = pickPendingRenderJob([
    { render_id: 'RENDER-new', render_status: 'PENDING', created_at: '2026-06-29T10:05:00.000Z' },
    { render_id: 'RENDER-old', render_status: 'PENDING', created_at: '2026-06-29T10:00:00.000Z' },
    { render_id: 'RENDER-done', render_status: 'COMPLETED', created_at: '2026-06-29T09:00:00.000Z' },
  ]);

  assert.equal(picked.render_id, 'RENDER-old');
});

test('WF8c selects music by niche mood energy and default fallback', () => {
  const rows = [
    { music_id: 'FIN-DEFAULT', niche: 'FINANCE_BUSINESS', mood: 'premium', energy_level: 'low', drive_file_id: 'DRIVE-D', recommended_volume: '0.07', active_status: 'TRUE' },
    { music_id: 'FIN-FOCUSED', niche: 'FINANCE_BUSINESS', mood: 'focused', energy_level: 'medium', drive_file_id: 'DRIVE-F', recommended_volume: '0.09', active_status: 'TRUE' },
  ];
  const exact = selectMusicTrack(
    { niche: 'FINANCE_BUSINESS', music_mood: 'focused', music_energy_level: 'medium', music_volume: 0.2 },
    rows,
    { music_default_id: 'FIN-DEFAULT' },
  );
  const fallback = selectMusicTrack(
    { niche: 'FINANCE_BUSINESS', music_mood: 'missing', music_energy_level: 'missing', music_volume: 0.01 },
    rows,
    { music_default_id: 'FIN-DEFAULT' },
  );

  assert.equal(exact.music_id, 'FIN-FOCUSED');
  assert.equal(exact.music_volume, 0.14);
  assert.equal(fallback.music_id, 'FIN-DEFAULT');
  assert.equal(fallback.music_volume, 0.04);
});

test('WF8c builds asset plan and fails when branding is missing', () => {
  const job = { render_id: 'RENDER-1', niche: 'FINANCE_BUSINESS', source_drive_file_id: 'SRC', music_mood: 'focused', music_energy_level: 'medium' };
  const plan = buildAssetDownloadPlan(
    job,
    [{ niche: 'FINANCE_BUSINESS', watermark_drive_file_id: 'WM', progress_bar_color: '0x137546', default_cta: 'Follow', active_status: 'TRUE' }],
    [],
    { FINANCE_BUSINESS: 'FINAL-FOLDER' },
  );
  const missing = buildAssetDownloadPlan(job, [], [], { FINANCE_BUSINESS: 'FINAL-FOLDER' });

  assert.equal(plan.watermark_drive_file_id, 'WM');
  assert.equal(plan.final_drive_folder_id, 'FINAL-FOLDER');
  assert.equal(plan.render_status, 'DOWNLOADING_ASSETS');
  assert.equal(missing.render_status, 'FAILED');
  assert.match(missing.error_message, /branding/i);
});

test('WF8c FFmpeg command writes text to files and uses explicit fontfile', () => {
  const command = buildFfmpegCommand({
    render_id: 'RENDER-1',
    workdir: '/data/jobs/RENDER-1',
    input_path: '/data/jobs/RENDER-1/input.mp4',
    watermark_path: '/data/jobs/RENDER-1/watermark.png',
    music_path: '/data/jobs/RENDER-1/music.mp3',
    output_path: '/data/jobs/RENDER-1/output.mp4',
    log_path: '/data/jobs/RENDER-1/render.log',
    hook_text: "Don't waste money: track it",
    cta_text: 'Follow for money lessons',
    cta_start_second: 38,
    cta_end_second: 42,
    duration_seconds: 42,
    progress_bar_color: '0x137546',
    music_volume: 0.09,
    fontfile: '/usr/share/fonts/dejavu/DejaVuSans.ttf',
  });

  assert.match(command, /ffmpeg -y/);
  assert(command.includes("fontfile='/usr/share/fonts/dejavu/DejaVuSans.ttf'"));
  assert.match(command, /amix=inputs=2/);
  assert.match(command, /0x137546/);
  assert.match(command, /render.log' 2>&1/);

  // Text is drawn via textfile= with expansion disabled — this is what keeps
  // apostrophes ("Don't") from breaking ffmpeg's quote parsing.
  assert(command.includes("textfile='/data/jobs/RENDER-1/hook.txt':expansion=none"));
  assert(command.includes("textfile='/data/jobs/RENDER-1/cta.txt':expansion=none"));
  assert(command.includes("> '/data/jobs/RENDER-1/hook.txt'"));
  assert.match(command, /printf %s '[^']*Don'/); // hook written with shell-safe quoting
  // The raw apostrophe is never left inside a single-quoted ffmpeg text= arg.
  assert(!command.includes(":text='Don"));
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

test('WF11 builds deterministic publishing jobs from approved completed renders', () => {
  const rows = buildPublishingJobs(
    [{
      approved_id: 'APR-1',
      created_clip_id: 'CC-1',
      niche: 'FINANCE_BUSINESS',
      platform: 'YOUTUBE_SHORTS,TIKTOK',
      final_title: 'Track Your Money',
      final_caption: 'Know where it goes.',
      hashtags: '#KenyaFinance #Money',
      status: 'APPROVED',
    }],
    [{
      render_id: 'RENDER_CC-1',
      created_clip_id: 'CC-1',
      niche: 'FINANCE_BUSINESS',
      render_status: 'COMPLETED',
      final_drive_file_id: 'DRIVE-FINAL',
      final_drive_url: 'https://drive/final',
      final_local_path: '/data/jobs/RENDER_CC-1/output.mp4',
    }],
    [{ created_clip_id: 'CC-1', suggested_title: 'Old Title', suggested_caption: 'Old caption' }],
    [
      { channel_id: 'finance_youtube', youtube_channel_id: 'UC-FINANCE', niche: 'FINANCE_BUSINESS', platform: 'YOUTUBE_SHORTS', enabled_status: 'TRUE', audit_status: 'APPROVED_PUBLIC', default_privacy: 'public' },
      { channel_id: 'finance_tiktok', tiktok_open_id: 'TT-FINANCE', niche: 'FINANCE_BUSINESS', platform: 'TIKTOK', enabled_status: 'TRUE', audit_status: 'DEV_PRIVATE_ONLY', requires_manual_publish: 'TRUE' },
      { channel_id: 'finance_ig', instagram_user_id: 'IG-FINANCE', niche: 'FINANCE_BUSINESS', platform: 'INSTAGRAM_REELS', enabled_status: 'FALSE', audit_status: 'APPROVED_PUBLIC' },
    ],
    [],
    '2026-07-25T08:00:00.000Z',
  );

  assert.deepEqual(rows.map((row) => row.publish_id), [
    'PUB_RENDER_CC-1_YOUTUBE_SHORTS_finance_youtube',
    'PUB_RENDER_CC-1_TIKTOK_finance_tiktok',
  ]);
  assert.equal(rows[0].video_source, 'LOCAL_FILE');
  assert.equal(rows[0].title, 'Track Your Money');
  assert.equal(rows[0].publish_status, 'PENDING');
  assert.equal(rows[0].destination_id, 'UC-FINANCE');
  assert.equal(rows[0].default_privacy, 'public');
  assert.equal(rows[1].destination_id, 'TT-FINANCE');
  assert.equal(rows[1].requires_manual_publish, 'TRUE');
  assert.equal(rows[1].tiktok_mode, 'DRAFT');
  assert.equal(rows[1].default_privacy, 'SELF_ONLY');
});

test('WF11 fails closed for unapproved rows, missing platforms, and unaudited destinations', () => {
  const approvedRows = [
    { approved_id: 'APR-PENDING', created_clip_id: 'CC-1', platform: 'YOUTUBE_SHORTS', status: 'PENDING' },
    { approved_id: 'APR-BLANK', created_clip_id: 'CC-1', platform: '', status: 'APPROVED' },
    { approved_id: 'APR-INVALID', created_clip_id: 'CC-1', platform: 'MYSPACE', status: 'APPROVED' },
    { approved_id: 'APR-READY', created_clip_id: 'CC-1', platform: 'YOUTUBE_SHORTS', status: 'READY' },
  ];
  const renderRows = [{ render_id: 'RENDER_CC-1', created_clip_id: 'CC-1', render_status: 'COMPLETED', final_drive_url: 'https://drive/final' }];

  assert.deepEqual(buildPublishingJobs(
    approvedRows,
    renderRows,
    [],
    [{ channel_id: 'yt', youtube_channel_id: 'UC-1', platform: 'YOUTUBE_SHORTS', enabled_status: 'TRUE', audit_status: 'NEEDS_REVIEW' }],
    [],
  ), []);

  const rows = buildPublishingJobs(
    approvedRows,
    renderRows,
    [],
    [{ channel_id: 'yt', youtube_channel_id: 'UC-1', platform: 'YOUTUBE_SHORTS', enabled_status: 'TRUE', audit_status: 'DEV_PRIVATE_ONLY' }],
    [],
  );

  assert.equal(rows.length, 1);
  assert.equal(rows[0].approved_id, 'APR-READY');
  assert.equal(rows[0].default_privacy, 'private');
});

test('WF11 skips duplicate publishing jobs and incomplete renders', () => {
  const rows = buildPublishingJobs(
    [
      { approved_id: 'APR-1', created_clip_id: 'CC-1', niche: 'FINANCE_BUSINESS', platform: 'YOUTUBE_SHORTS', status: 'APPROVED' },
      { approved_id: 'APR-2', created_clip_id: 'CC-2', niche: 'FINANCE_BUSINESS', platform: 'YOUTUBE_SHORTS', status: 'APPROVED' },
    ],
    [
      { render_id: 'RENDER_CC-1', created_clip_id: 'CC-1', render_status: 'COMPLETED', final_drive_url: 'https://drive/final' },
      { render_id: 'RENDER_CC-2', created_clip_id: 'CC-2', render_status: 'FAILED', final_drive_url: 'https://drive/final2' },
    ],
    [],
    [{ channel_id: 'finance_youtube', youtube_channel_id: 'UC-FINANCE', niche: 'FINANCE_BUSINESS', platform: 'YOUTUBE_SHORTS', enabled_status: 'TRUE', audit_status: 'APPROVED_PUBLIC' }],
    [{ render_id: 'RENDER_CC-1', platform: 'YOUTUBE_SHORTS', channel_id: 'finance_youtube' }],
  );

  assert.deepEqual(rows, []);
});

test('WF12 picks due publish jobs and builds platform metadata without tokens', () => {
  const picked = pickNextPublishJob([
    { publish_id: 'PUB-later', publish_status: 'RETRY_PENDING', next_retry_at: '2026-07-25T09:00:00.000Z', created_at: '2026-07-25T07:00:00.000Z' },
    { publish_id: 'PUB-exhausted', publish_status: 'RETRY_PENDING', retry_count: '4', next_retry_at: '2026-07-25T08:00:00.000Z', created_at: '2026-07-25T06:00:00.000Z' },
    { publish_id: 'PUB-now', publish_status: 'PENDING', platform: 'YOUTUBE_SHORTS', title: 'T', caption: 'C', created_at: '2026-07-25T08:00:00.000Z' },
  ], '2026-07-25T08:30:00.000Z');
  const attempt = buildPublishAttempt({ ...picked, hashtags: '#A #B' }, '2026-07-25T08:31:00.000Z');
  const youtube = JSON.parse(attempt.youtube_metadata);

  assert.equal(picked.publish_id, 'PUB-now');
  assert.equal(attempt.publish_status, 'UPLOADING');
  assert.equal(youtube.status.privacyStatus, 'private');
  assert.deepEqual(youtube.snippet.tags, ['A', 'B']);
  assert.doesNotMatch(JSON.stringify(attempt), /Bearer|refresh_token|access_token|client_secret/i);
});

test('WF12 honors publishing schedules and only recovers expired claims', () => {
  const now = '2026-07-25T08:30:00.000Z';
  const picked = pickNextPublishJob([
    { publish_id: 'PUB-future', publish_status: 'PENDING', scheduled_at: '2030-01-01T00:00:00.000Z', created_at: '2026-07-25T06:00:00.000Z' },
    { publish_id: 'PUB-invalid-date', publish_status: 'PENDING', scheduled_at: 'not-a-date', created_at: '2026-07-25T06:30:00.000Z' },
    { publish_id: 'PUB-active-claim', publish_status: 'CLAIMED', lease_expires_at: '2026-07-25T08:45:00.000Z', created_at: '2026-07-25T07:00:00.000Z' },
    { publish_id: 'PUB-stale-claim', publish_status: 'CLAIMED', lease_expires_at: '2026-07-25T08:29:00.000Z', created_at: '2026-07-25T07:30:00.000Z' },
  ], now);

  assert.equal(picked.publish_id, 'PUB-stale-claim');
});

test('WF12 builds bounded claims and recovers legacy stale uploads', () => {
  const claim = buildPublishClaim(
    { publish_id: 'PUB-1', publish_status: 'PENDING' },
    'wf12-execution-123',
    '2026-07-25T08:00:00.000Z',
    20,
  );
  const recovered = pickNextPublishJob([
    { publish_id: 'PUB-uploading', publish_status: 'UPLOADING', started_at: '2026-07-25T07:00:00.000Z' },
  ], '2026-07-25T08:00:00.000Z');

  assert.equal(claim.publish_status, 'CLAIMED');
  assert.equal(claim.claimed_at, '2026-07-25T08:00:00.000Z');
  assert.equal(claim.claimed_by, 'wf12-execution-123');
  assert.equal(claim.lease_expires_at, '2026-07-25T08:20:00.000Z');
  assert.equal(recovered.publish_id, 'PUB-uploading');
  assert.throws(() => buildPublishClaim({ publish_id: 'PUB-1' }, ''), /claimed_by/);
});

test('WF12 classifies publish success, retryable failure, and auth failure', () => {
  const job = { publish_id: 'PUB-1', platform: 'YOUTUBE_SHORTS', retry_count: '0' };
  const success = buildPublishSuccessUpdate(job, { id: 'YT-1', url: 'https://youtube/shorts/YT-1' }, '2026-07-25T08:00:00.000Z');
  const retry = buildPublishFailureUpdate(job, { error: { message: '429 rate limit' } }, '2026-07-25T08:00:00.000Z');
  const auth = buildPublishFailureUpdate(job, { error: { message: '401 invalid token' } }, '2026-07-25T08:00:00.000Z');

  assert.equal(success.publish_status, 'PUBLISHED');
  assert.equal(success.post_id, 'YT-1');
  assert.equal(retry.publish_status, 'RETRY_PENDING');
  assert.equal(retry.retry_count, '1');
  assert.equal(retry.next_retry_at, '2026-07-25T08:15:00.000Z');
  assert.equal(auth.publish_status, 'AUTH_REQUIRED');
  assert.equal(auth.retry_count, '0');
  assert.equal(auth.claimed_by, '');
  assert.equal(buildPublishSuccessUpdate(job, {}, '2026-07-25T08:00:00.000Z').publish_status, 'FAILED');
});

test('WF12 exhausts retryable failures at count four instead of stranding them', () => {
  const failed = buildPublishFailureUpdate(
    { publish_id: 'PUB-4', platform: 'YOUTUBE_SHORTS', retry_count: '3', claimed_by: 'worker' },
    { error: { message: '429 rate limit' } },
    '2026-07-25T08:00:00.000Z',
  );

  assert.equal(failed.publish_status, 'FAILED');
  assert.equal(failed.retry_count, '4');
  assert.equal(failed.next_retry_at, '');
  assert.equal(failed.claimed_by, '');
});

test('WF12 validates provider prerequisites and keeps TikTok direct posting fail closed', () => {
  assert.deepEqual(validateProviderJob({ platform: 'YOUTUBE_SHORTS', youtube_channel_id: 'UC-1', credential_slot: 'YOUTUBE_PRIMARY', local_file_path: '/data/video.mp4' }).ready, true);
  assert.equal(validateProviderJob({ platform: 'YOUTUBE_SHORTS', destination_id: 'UC-GENERIC', credential_slot: 'YOUTUBE_PRIMARY', local_file_path: '/data/video.mp4' }).reason, 'MISSING_DESTINATION_ID:youtube_channel_id');
  assert.equal(validateProviderJob({ platform: 'YOUTUBE_SHORTS', youtube_channel_id: 'UC-1', credential_slot: 'YOUTUBE_PRIMARY' }).reason, 'LOCAL_VIDEO_REQUIRED:YOUTUBE_SHORTS');
  assert.equal(validateProviderJob({ platform: 'FACEBOOK_REELS', facebook_page_id: 'PAGE-1', credential_slot: 'FACEBOOK_PRIMARY', public_video_url: 'https://media.example/video.mp4' }).reason, 'META_GRAPH_VERSION_REQUIRED');
  assert.equal(validateProviderJob({ platform: 'INSTAGRAM_REELS', instagram_user_id: 'IG-1', credential_slot: 'INSTAGRAM_PRIMARY', public_video_url: 'https://media.example/video.mp4', meta_graph_version: 'v24.0', instagram_graph_host: 'evil.example' }).reason, 'INVALID_INSTAGRAM_GRAPH_HOST');
  assert.equal(validateProviderJob({ platform: 'TIKTOK', tiktok_open_id: 'TT-1', credential_slot: 'TIKTOK_PRIMARY', tiktok_mode: 'DIRECT', public_video_url: 'https://media.example/video.mp4', tiktok_domain_verified: 'TRUE' }).reason, 'TIKTOK_DIRECT_REQUIRES_CREATOR_UI_AND_CONSENT');
  assert.equal(validateProviderJob({ platform: 'TIKTOK', tiktok_open_id: 'TT-1', credential_slot: 'TIKTOK_PRIMARY', tiktok_mode: 'DRAFT', public_video_url: 'https://media.example/video.mp4', tiktok_domain_verified: 'TRUE', tiktok_verified_url_prefix: 'https://media.example/' }).ready, true);
  assert.equal(validateProviderJob({ platform: 'TIKTOK', tiktok_open_id: 'TT-1', credential_slot: 'TIKTOK_PRIMARY', tiktok_mode: 'DRAFT', public_video_url: 'https://other.example/video.mp4', tiktok_domain_verified: 'TRUE', tiktok_verified_url_prefix: 'https://media.example/' }).reason, 'TIKTOK_VIDEO_URL_OUTSIDE_VERIFIED_PREFIX');
  for (const publicVideoUrl of [
    'https://media.example.evil/video.mp4',
    'https://media.example/videos-evil/video.mp4',
  ]) {
    assert.equal(validateProviderJob({ platform: 'TIKTOK', tiktok_open_id: 'TT-1', credential_slot: 'TIKTOK_PRIMARY', tiktok_mode: 'DRAFT', public_video_url: publicVideoUrl, tiktok_domain_verified: 'TRUE', tiktok_verified_url_prefix: 'https://media.example/videos' }).reason, 'TIKTOK_VIDEO_URL_OUTSIDE_VERIFIED_PREFIX');
  }
  for (const publicVideoUrl of ['https://user:pass@media.example/videos/video.mp4', 'https://media.example:8443/videos/video.mp4']) {
    assert.equal(validateProviderJob({ platform: 'TIKTOK', tiktok_open_id: 'TT-1', credential_slot: 'TIKTOK_PRIMARY', tiktok_mode: 'DRAFT', public_video_url: publicVideoUrl, tiktok_domain_verified: 'TRUE', tiktok_verified_url_prefix: 'https://media.example/videos' }).ready, false);
  }
});

test('WF12 interprets asynchronous provider acknowledgements only after terminal status', () => {
  assert.equal(interpretYouTubeStatus({ items: [{ id: 'YT-1', processingDetails: { processingStatus: 'processing' }, status: { uploadStatus: 'uploaded' } }] }).outcome, 'PROCESSING');
  assert.equal(interpretYouTubeStatus({ items: [{ id: 'YT-1', processingDetails: { processingStatus: 'succeeded' }, status: { uploadStatus: 'processed' } }] }).outcome, 'PUBLISHED');
  assert.equal(interpretFacebookStatus({ id: 'FB-1', status: { publishing_phase: { status: 'processing' } } }).outcome, 'PROCESSING');
  assert.equal(interpretFacebookStatus({ id: 'FB-1', status: { publishing_phase: { status: 'complete' } } }).outcome, 'PUBLISHED');
  assert.equal(interpretInstagramContainerStatus({ id: 'IGC-1', status_code: 'FINISHED' }).outcome, 'READY_TO_PUBLISH');
  assert.deepEqual(interpretTikTokStatus({ data: { status: 'SEND_TO_USER_INBOX' } }, 'TT-PUB-1'), { outcome: 'DRAFT_UPLOADED', post_id: '' });
  assert.deepEqual(interpretTikTokStatus({ data: { status: 'PUBLISH_COMPLETE' } }, 'TT-PUB-1'), { outcome: 'PUBLISHED', post_id: '' });
  assert.deepEqual(interpretTikTokStatus({ data: { status: 'PUBLISH_COMPLETE', publicaly_available_post_id: ['TT-VIDEO-1'] } }, 'TT-PUB-1'), { outcome: 'PUBLISHED', post_id: 'TT-VIDEO-1' });
  assert.equal(interpretTikTokStatus({ data: { status: 'PROCESSING_DOWNLOAD', publish_id: 'TT-PUB-1' } }).outcome, 'PROCESSING');
});

test('WF12 builds a durable provider polling checkpoint', () => {
  const update = providerPollUpdate({ publish_id: 'PUB-1', claimed_by: 'worker-1' }, 'YOUTUBE_PROCESSING', 'YT-1', { ok: true }, '2026-08-17T12:00:00.000Z', 2);
  assert.equal(update.publish_status, 'PROCESSING');
  assert.equal(update.provider_ref, 'YT-1');
  assert.equal(update.poll_after, '2026-08-17T12:02:00.000Z');
});

test('WF13 and WF14 build maintenance updates from sheet state', () => {
  const health = buildCredentialHealthRows([
    { channel_id: 'yt', platform: 'YOUTUBE_SHORTS', enabled_status: 'TRUE', token_expires_at: '2026-07-26T00:00:00.000Z' },
    { channel_id: 'ig', platform: 'INSTAGRAM_REELS', enabled_status: 'FALSE', token_expires_at: '2026-07-26T00:00:00.000Z' },
  ], '2026-07-25T08:00:00.000Z');
  const retries = pickRetryJobs([
    { publish_id: 'PUB-1', publish_status: 'RETRY_PENDING', retry_count: '1', next_retry_at: '2026-07-25T07:59:00.000Z' },
    { publish_id: 'PUB-2', publish_status: 'RETRY_PENDING', retry_count: '4', next_retry_at: '2026-07-25T07:59:00.000Z' },
  ], '2026-07-25T08:00:00.000Z');

  assert.equal(health.length, 1);
  assert.equal(health[0].last_health_status, 'EXPIRING');
  assert.equal(health[0].last_expiry_audit_at, '2026-07-25T08:00:00.000Z');
  assert.equal(health[0].last_token_test_at, undefined);
  assert.deepEqual(retries, [
    {
      publish_id: 'PUB-1',
      publish_status: 'PENDING',
      next_retry_at: '',
      claimed_at: '',
      claimed_by: '',
      lease_expires_at: '',
      updated_at: '2026-07-25T08:00:00.000Z',
    },
    {
      publish_id: 'PUB-2',
      publish_status: 'FAILED',
      next_retry_at: '',
      claimed_at: '',
      claimed_by: '',
      lease_expires_at: '',
      updated_at: '2026-07-25T08:00:00.000Z',
    },
  ]);
});

test('WF11-WF14 use an atomic Postgres queue and complete every provider through verified terminal state', () => {
  const wf11 = requireWorkflow('11', 'build-publishing-jobs');
  const wf12 = requireWorkflow('12', 'publish-to-platforms');
  const wf13 = requireWorkflow('13', 'publishing-credential-health');
  const wf14 = requireWorkflow('14', 'publishing-retry-scheduler');
  const wf12Names = wf12.nodes.map((node) => node.name);
  const claimNode = wf12.nodes.find((node) => node.name === 'Claim Next Job Atomically');
  const uploadingNode = wf12.nodes.find((node) => node.name === 'Mark Uploading Atomically');
  const safeSkipCode = wf12.nodes.find((node) => node.name === 'Build Safe Skip Reason').parameters.jsCode;
  const safeSkipNode = wf12.nodes.find((node) => node.name === 'Save Safe Skip Atomically');
  const healthCode = wf13.nodes.find((node) => node.name === 'Build Expiry Audit Updates').parameters.jsCode;

  assert.equal(wf11.nodes[0].name, 'Schedule 30m');
  assert(wf11.nodes.some((node) => node.name === 'Build Missing Publish Jobs'));
  assert.equal(wf11.nodes.find((node) => node.name === 'Sync Atomic Publishing Queue').type, 'n8n-nodes-base.postgres');
  assert.equal(wf12.nodes[0].name, 'Schedule 15m');
  assert(wf12Names.includes('Claim Next Job Atomically'));
  assert(wf12Names.includes('Mark Uploading Atomically'));
  assert(wf12Names.includes('Build Safe Skip Reason'));
  assert(wf12Names.includes('Save Safe Skip Atomically'));
  const httpNames = wf12.nodes.filter((node) => node.type === 'n8n-nodes-base.httpRequest').map((node) => node.name);
  assert(httpNames.includes('Start YouTube Resumable Upload'));
  assert(httpNames.includes('Check YouTube Processing'));
  assert(httpNames.includes('Start Facebook Reel'));
  assert(httpNames.includes('Check Facebook Reel Status'));
  assert(httpNames.includes('Create Instagram Reel Container'));
  assert(httpNames.includes('Publish Instagram Reel'));
  assert(httpNames.includes('Start TikTok Draft Pull'));
  assert(httpNames.includes('Check TikTok Draft Status'));
  assert.equal(claimNode.type, 'n8n-nodes-base.postgres');
  assert.equal(claimNode.typeVersion, 2.6);
  assert.match(claimNode.parameters.query, /FOR UPDATE SKIP LOCKED/);
  assert.match(claimNode.parameters.query, /existing_claim/);
  assert.match(claimNode.parameters.options.queryReplacement, /\$execution\.id/);
  assert.match(uploadingNode.parameters.query, /claimed_by = \$2/);
  assert.match(safeSkipNode.parameters.query, /publish_status = 'SKIPPED'/);
  assert.match(safeSkipCode, /UNSUPPORTED_PROVIDER_STATE/);
  assert.match(wf12.nodes.find((node) => node.name === 'Build Provider Route').parameters.jsCode, /TIKTOK_DIRECT_REQUIRES_CREATOR_UI_AND_CONSENT/);
  assert(wf12.nodes.filter((node) => node.type === 'n8n-nodes-base.httpRequest').every((node) => node.credentials && !/Bearer\s+\S+|access_token|client_secret/i.test(JSON.stringify(node.parameters))));
  // D1 removed the Sheets mirror and its redaction step from every branch.
  assert.equal(wf12.connections['Claim Next Job Atomically'].main[0][0].node, 'Mark Uploading Atomically');
  assert.equal(wf12.connections['Save Safe Skip Atomically'], undefined);
  assert.equal(wf13.nodes[0].name, 'Schedule Daily');
  assert.match(healthCode, /last_expiry_audit_at/);
  assert.doesNotMatch(healthCode, /last_token_test_at/);
  assert.equal(wf14.nodes[0].name, 'Schedule Hourly');
  assert.equal(wf14.nodes.find((node) => node.name === 'Release Due Retries Atomically').type, 'n8n-nodes-base.postgres');
});

test('WF6, WF8, WF9, and publishing workflow files exist with expected entry nodes', () => {
  assert.equal(requireWorkflow('06', 'yt-dlp-clip-download').nodes[0].name, 'Schedule 15m');
  assert.equal(requireWorkflow('08', 'drive-storage-transform').nodes[0].name, 'Schedule 30m');
  assert.equal(requireWorkflow('09', 'review-queue-digest').nodes[0].name, 'Schedule Daily');
  assert.equal(requireWorkflow('11', 'build-publishing-jobs').nodes[0].name, 'Schedule 30m');
  assert.equal(requireWorkflow('12', 'publish-to-platforms').nodes[0].name, 'Schedule 15m');
  assert.equal(requireWorkflow('13', 'publishing-credential-health').nodes[0].name, 'Schedule Daily');
  assert.equal(requireWorkflow('14', 'publishing-retry-scheduler').nodes[0].name, 'Schedule Hourly');
});

// Task 7 made approved_for_posting.platforms a text[] with a cardinality check,
// so WF11 reads a list instead of splitting a comma-separated string.
const wf11Fixtures = (approvedRow) => [
  [approvedRow],
  [{
    render_id: 'RENDER_CC-9', created_clip_id: 'CC-9', niche: 'FINANCE_BUSINESS',
    render_status: 'COMPLETED', final_drive_file_id: 'DRIVE-FINAL',
    final_drive_url: 'https://drive/final', final_local_path: '/data/jobs/RENDER_CC-9/output.mp4',
  }],
  [{ created_clip_id: 'CC-9', suggested_title: 'Title', suggested_caption: 'Caption' }],
  [
    { channel_id: 'finance_youtube', youtube_channel_id: 'UC-FINANCE', niche: 'FINANCE_BUSINESS', platform: 'YOUTUBE_SHORTS', enabled_status: 'TRUE', audit_status: 'APPROVED_PUBLIC', default_privacy: 'public' },
    { channel_id: 'finance_tiktok', tiktok_open_id: 'TT-FINANCE', niche: 'FINANCE_BUSINESS', platform: 'TIKTOK', enabled_status: 'TRUE', audit_status: 'DEV_PRIVATE_ONLY', requires_manual_publish: 'TRUE' },
  ],
  [],
  '2026-07-25T08:00:00.000Z',
];

test('WF11 reads a platform array and no longer splits a comma string', () => {
  const rows = buildPublishingJobs(...wf11Fixtures({
    approved_id: 'APR-9', created_clip_id: 'CC-9', niche: 'FINANCE_BUSINESS',
    platforms: ['YOUTUBE_SHORTS', 'TIKTOK'], final_title: 'Title', status: 'APPROVED',
  }));
  assert.deepEqual(rows.map((row) => row.platform), ['YOUTUBE_SHORTS', 'TIKTOK']);
});

test('WF11 creates no job for an empty platform array', () => {
  const rows = buildPublishingJobs(...wf11Fixtures({
    approved_id: 'APR-9', created_clip_id: 'CC-9', niche: 'FINANCE_BUSINESS',
    platforms: [], final_title: 'Title', status: 'APPROVED',
  }));
  assert.deepEqual(rows, [], 'blank does not mean all platforms');
});

// A row written before the migration carried a comma-separated string. It must
// not silently resolve to no platforms.
test('WF11 still understands a legacy comma-separated platform string', () => {
  const rows = buildPublishingJobs(...wf11Fixtures({
    approved_id: 'APR-9', created_clip_id: 'CC-9', niche: 'FINANCE_BUSINESS',
    platform: 'YOUTUBE_SHORTS,TIKTOK', final_title: 'Title', status: 'APPROVED',
  }));
  assert.deepEqual(rows.map((row) => row.platform), ['YOUTUBE_SHORTS', 'TIKTOK']);
});
