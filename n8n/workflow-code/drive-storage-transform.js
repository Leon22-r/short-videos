const { pickFairByGroup } = require('./fair-share');

const TITLE_FORMULAS = {
  CHRISTIAN_CONTENT: ['God Is Not Asking You to Ignore This', 'This Is What Waiting on God Really Means', 'A Biblical Lesson Most People Miss'],
  MOTIVATION_DISCIPLINE: ["The Real Reason You Can't Stay Consistent", 'Motivation Is Not Your Problem', 'Stop Waiting to Feel Ready'],
  FINANCE_BUSINESS: ['Why High Income Still Feels Like Poverty', 'This Money Mistake Keeps People Broke', 'Income Is Not Wealth'],
  LIFE_VALUES_RELATIONSHIPS: ["This Is Not Love, It's Fear", 'Healthy Boundaries Sound Like This', 'Stop Calling This Loyalty'],
  AFRICAN_KENYAN_SUCCESS: ['Every Young Kenyan Builder Should Hear This', 'This Advice Works Differently in Africa', 'The Reality of Building in Kenya'],
};

const TRANSFORMATION_SCHEMA = {
  type: 'object',
  properties: {
    content_thesis: { type: 'string' },
    best_title: { type: 'string' },
    alternative_titles: { type: 'array', items: { type: 'string' } },
    hook: { type: 'string' },
    narration_script: { type: 'string' },
    commentary_angle: { type: 'string' },
    kenyan_african_localization: { type: 'string' },
    bible_verse_if_relevant: { type: ['string', 'null'] },
    on_screen_text_beats: { type: 'array', items: { type: 'string' } },
    broll_plan: { type: 'array', items: { type: 'string' } },
    editing_style: { type: 'string' },
    caption: { type: 'string' },
    hashtags: { type: 'array', items: { type: 'string' } },
    cta: { type: 'string' },
    risk_warning: { type: 'string' },
    originality_checklist: { type: 'array', items: { type: 'string' } },
    render: {
      type: 'object',
      properties: {
        top_hook_text: { type: 'string' },
        cta_text: { type: 'string' },
        cta_start_second: { type: 'number' },
        cta_end_second: { type: 'number' },
        music_mood: { type: 'string' },
        music_energy_level: { type: 'string' },
        music_volume: { type: 'number' },
        use_blurred_background: { type: 'boolean' },
        progress_bar_color: { type: 'string' },
      },
      required: [
        'top_hook_text',
        'cta_text',
        'cta_start_second',
        'cta_end_second',
        'music_mood',
        'music_energy_level',
        'music_volume',
        'use_blurred_background',
        'progress_bar_color',
      ],
      additionalProperties: false,
    },
  },
  required: [
    'content_thesis',
    'best_title',
    'alternative_titles',
    'hook',
    'narration_script',
    'commentary_angle',
    'kenyan_african_localization',
    'bible_verse_if_relevant',
    'on_screen_text_beats',
    'broll_plan',
    'editing_style',
    'caption',
    'hashtags',
    'cta',
    'risk_warning',
    'originality_checklist',
    'render',
  ],
  additionalProperties: false,
};

function stripJsonFence(text) {
  const value = String(text || '').trim();
  const match = value.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match ? match[1].trim() : value;
}

function parseAiResponse(response) {
  if (Array.isArray(response)) return parseAiResponse(response[0] || {});

  let parsed;
  if (typeof response === 'string') parsed = JSON.parse(stripJsonFence(response));
  else if (response && response.choices) parsed = JSON.parse(stripJsonFence(response.choices[0].message.content));
  else if (response && Array.isArray(response.content)) {
    const textPart = response.content.find((part) => ['output_text', 'text'].includes(part.type) && part.text);
    const text = textPart ? textPart.text : '';
    parsed = typeof text === 'string' ? JSON.parse(stripJsonFence(text)) : text;
  } else if (response && response.text) parsed = JSON.parse(stripJsonFence(response.text));
  else if (response && response.message && response.message.content) parsed = JSON.parse(stripJsonFence(response.message.content));
  else if (response && typeof response.content === 'string') parsed = JSON.parse(stripJsonFence(response.content));
  else parsed = response || {};

  if (Array.isArray(parsed)) return parseAiResponse(parsed);

  if (parsed && Object.prototype.hasOwnProperty.call(parsed, 'output')) {
    if (typeof parsed.output === 'string' || Array.isArray(parsed.output)) return parseAiResponse(parsed.output);
    return parsed.output || {};
  }

  return parsed;
}

function buildSchemaInstructions() {
  return [
    'Return the bare transformation object only. Do not add an output wrapper or commentary.',
    'Do not use Markdown code fences.',
    'best_title must be a single scroll-stopping title under 70 characters.',
    'alternative_titles must contain 2-3 distinct title options.',
    'narration_script must be original voice-over copy, not a transcript of the clip.',
    'commentary_angle must add an original take so the output is not a reposted podcast clip.',
    'on_screen_text_beats, broll_plan, hashtags, and originality_checklist must be arrays of short strings.',
    'Set bible_verse_if_relevant to null when no verse applies.',
    'The captions are already burned into the Ssemble video. Do not create subtitle or caption-burn instructions.',
    'Add a render object for the FFmpeg render plan: top hook text, CTA text/timing, music mood/energy/volume, blurred-background choice, and progress bar color.',
    'progress_bar_color must use FFmpeg-safe 0xRRGGBB format.',
    'music_volume must be a decimal between 0.04 and 0.14.',
    'The JSON must conform to this schema:',
    JSON.stringify(TRANSFORMATION_SCHEMA),
  ].join('\n');
}

function pickAwaitingDownloads(clips, jobs, moments, folders, options = 5) {
  const limit = typeof options === 'number' ? options : Number(options.limit || 5);
  const perSourceLimit = typeof options === 'number' ? limit : Number(options.perSourceLimit || 1);
  const jobsById = Object.fromEntries(jobs.map((job) => [job.ssemble_job_id, job]));
  const momentsById = Object.fromEntries(moments.map((moment) => [moment.clip_moment_id, moment]));

  const enriched = clips
    .filter((clip) => String(clip.review_status) === 'AWAITING_DOWNLOAD')
    .map((clip) => {
      const job = jobsById[clip.ssemble_job_id] || {};
      const moment = momentsById[job.clip_moment_id] || {};
      const niche = clip.niche || job.niche || 'AFRICAN_KENYAN_SUCCESS';
      return {
        ...clip,
        niche,
        video_id: clip.video_id || job.video_id || '',
        source_id: moment.source_id || job.source_id || clip.source_id || '',
        drive_folder_id: folders[niche],
        file_name: `${niche}_${clip.created_clip_id}.mp4`,
        moment_core_idea: moment.core_idea || '',
        moment_commentary_angle: moment.commentary_angle || '',
        moment_kenyan_application: moment.kenyan_african_application || '',
        moment_bible_verse: moment.bible_verse_if_relevant || '',
        moment_hook: moment.hook_first_2_seconds || '',
        moment_suggested_title: moment.suggested_title || '',
      };
    });

  return pickFairByGroup(enriched, {
    limit,
    perSourceLimit,
    groupKey: 'niche',
    sourceKey: 'source_id',
    sourceFallbackKeys: ['niche'],
    sortKey: 'created_at',
  });
}

function buildDriveIdUpdate(clip, drive) {
  return {
    created_clip_id: clip.created_clip_id,
    local_file_name: clip.file_name,
    google_drive_file_id: drive.id,
    google_drive_url: drive.webViewLink || `https://drive.google.com/file/d/${drive.id}/view`,
  };
}

function buildPlannerRequest(clip) {
  const driveFileId = clip.google_drive_file_id || clip.drive_file_id;
  const driveUrl = clip.google_drive_url || clip.drive_url;
  const systemPrompt = `You are an originality-first short-form video editor, scriptwriter, and monetization-safety reviewer.

Transform the selected clip into a video that clearly adds original value. The final output must not look like a reposted podcast clip. It must look like original commentary content that uses the clip as supporting material.

Title style guides: ${JSON.stringify(TITLE_FORMULAS[clip.niche] || TITLE_FORMULAS.AFRICAN_KENYAN_SUCCESS)}.`;
  const userContent = [
    `Niche: ${clip.niche}`,
    `Clip title: ${clip.clip_title}`,
    `Clip duration: ${clip.duration_seconds}s`,
    `Core idea: ${clip.moment_core_idea}`,
    `Planned commentary angle: ${clip.moment_commentary_angle}`,
    `Kenyan/African application: ${clip.moment_kenyan_application}`,
    `Bible verse hint: ${clip.moment_bible_verse || 'none'}`,
    `Original hook idea: ${clip.moment_hook}`,
    `Suggested title from analysis: ${clip.moment_suggested_title}`,
    '',
    buildSchemaInstructions(),
  ].join('\n');

  return {
    created_clip_id: clip.created_clip_id,
    video_id: clip.video_id,
    niche: clip.niche,
    drive_file_id: driveFileId,
    drive_url: driveUrl,
    file_name: clip.file_name || clip.local_file_name,
    openai_model: 'gpt-4o-mini',
    transformation_schema: JSON.stringify(TRANSFORMATION_SCHEMA),
    system_message: systemPrompt,
    user_message: userContent,
  };
}

function textValue(value, limit = 2000) {
  if (value === null || value === undefined) return '';
  const text = String(value).trim();
  if (text.toLowerCase() === 'null') return '';
  return text.slice(0, limit);
}

function listValue(value, options = {}) {
  const items = Array.isArray(value) ? value : (value ? [value] : []);
  const cleaned = items
    .map((item) => String(item || '').trim())
    .filter(Boolean);
  if (options.hashtags) {
    return cleaned
      .map((tag) => (tag.startsWith('#') ? tag : `#${tag.replace(/^#+/, '')}`))
      .join(' ')
      .slice(0, options.limit || 1000);
  }
  return cleaned.join('\n').slice(0, options.limit || 4000);
}

function numberValue(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clampNumber(value, min, max, fallback) {
  return Math.min(max, Math.max(min, numberValue(value, fallback)));
}

function normalizeFfmpegColor(value, fallback = '0xFFFFFF') {
  const raw = String(value || '').trim();
  const hex = raw.startsWith('#') ? raw.slice(1) : raw.replace(/^0x/i, '');
  return /^[0-9a-fA-F]{6}$/.test(hex) ? `0x${hex.toUpperCase()}` : fallback;
}

function boolValue(value, fallback = true) {
  if (typeof value === 'boolean') return value;
  const text = String(value || '').trim().toLowerCase();
  if (['true', 'yes', '1'].includes(text)) return true;
  if (['false', 'no', '0'].includes(text)) return false;
  return fallback;
}

function normalizeRenderPlan(plan = {}, meta = {}) {
  const duration = Math.max(1, numberValue(meta.duration_seconds, numberValue(meta.clip_duration, 45)));
  const render = plan && typeof plan.render === 'object' ? plan.render : {};
  const ctaText = textValue(render.cta_text || plan.cta || 'Follow for more.', 120);
  const startFallback = Math.max(0, Math.floor(duration - 4));
  let start = clampNumber(render.cta_start_second, 0, duration, startFallback);
  let end = clampNumber(render.cta_end_second, 0, duration, duration);
  if (end <= start) {
    end = duration;
    start = Math.max(0, Math.floor(duration - 3));
  }

  return {
    top_hook_text: textValue(render.top_hook_text || plan.hook || plan.best_title || meta.suggested_title || meta.clip_title || 'Watch this', 100),
    cta_text: ctaText,
    cta_start_second: Math.round(start),
    cta_end_second: Math.round(end),
    music_mood: textValue(render.music_mood || 'focused', 80),
    music_energy_level: textValue(render.music_energy_level || 'medium', 80),
    music_volume: clampNumber(render.music_volume, 0.04, 0.14, 0.09),
    use_blurred_background: boolValue(render.use_blurred_background, true),
    progress_bar_color: normalizeFfmpegColor(render.progress_bar_color, '0xFFFFFF'),
  };
}

function parseTransformationPlan(meta, response) {
  let plan;
  let parseError = '';
  try {
    if (response && response.error) throw new Error(String(response.error.message || response.error));
    plan = parseAiResponse(response);
    if (!plan || typeof plan !== 'object' || Array.isArray(plan)) {
      throw new Error('AI response was not a JSON object');
    }
  } catch (error) {
    plan = {};
    parseError = String(error.message || error).slice(0, 500);
  }

  const title = String(plan.best_title || '').trim();
  const render = normalizeRenderPlan(plan, meta);
  return {
    created_clip_id: meta.created_clip_id,
    video_id: meta.video_id,
    niche: meta.niche,
    duration_seconds: meta.duration_seconds,
    local_file_name: meta.file_name || meta.local_file_name,
    google_drive_file_id: meta.drive_file_id || meta.google_drive_file_id,
    google_drive_url: meta.drive_url || meta.google_drive_url,
    suggested_title: title,
    suggested_caption: String(plan.caption || '').slice(0, 500),
    content_thesis: textValue(plan.content_thesis, 2000),
    hook: textValue(plan.hook, 1000),
    narration_script: textValue(plan.narration_script, 5000),
    commentary_angle: textValue(plan.commentary_angle, 2000),
    kenyan_african_localization: textValue(plan.kenyan_african_localization, 2000),
    bible_verse_if_relevant: textValue(plan.bible_verse_if_relevant, 1000),
    alternative_titles: listValue(plan.alternative_titles, { limit: 2000 }),
    on_screen_text_beats: listValue(plan.on_screen_text_beats, { limit: 3000 }),
    broll_plan: listValue(plan.broll_plan, { limit: 3000 }),
    editing_style: textValue(plan.editing_style, 1000),
    hashtags: listValue(plan.hashtags, { hashtags: true, limit: 1000 }),
    cta: textValue(plan.cta, 1000),
    risk_warning: textValue(plan.risk_warning, 1000),
    originality_checklist: listValue(plan.originality_checklist, { limit: 3000 }),
    render_plan: render,
    transformation_plan: JSON.stringify(parseError ? { parse_error: parseError, raw: response } : plan).slice(0, 40000),
    review_status: parseError || !title ? 'NEEDS_RETRY' : 'NEEDS_REVIEW',
  };
}

function safeIdComponent(value) {
  // render_id becomes a filesystem path (/data/jobs/RENDER_<id>) in WF8c, so the
  // clip id must not smuggle path separators or `..` traversal into it.
  const id = String(value || '').trim();
  if (!/^[A-Za-z0-9_-]+$/.test(id)) {
    throw new Error(`Unsafe created_clip_id for render path: ${JSON.stringify(value)}`);
  }
  return id;
}

function buildRenderJobRow(parsed, now = new Date().toISOString()) {
  const render = parsed.render_plan || normalizeRenderPlan({}, parsed);
  const clipId = safeIdComponent(parsed.created_clip_id);
  return {
    render_id: `RENDER_${clipId}`,
    created_clip_id: clipId,
    niche: parsed.niche,
    source_drive_file_id: parsed.google_drive_file_id,
    source_drive_url: parsed.google_drive_url,
    source_file_name: parsed.local_file_name || `${parsed.niche}_${clipId}.mp4`,
    final_drive_folder_id: '',
    hook_text: render.top_hook_text,
    cta_text: render.cta_text,
    cta_start_second: render.cta_start_second,
    cta_end_second: render.cta_end_second,
    music_mood: render.music_mood,
    music_energy_level: render.music_energy_level,
    music_id: '',
    music_drive_file_id: '',
    music_file_name: '',
    music_volume: render.music_volume,
    watermark_drive_file_id: '',
    watermark_file_name: '',
    progress_bar_color: render.progress_bar_color,
    use_blurred_background: render.use_blurred_background ? 'TRUE' : 'FALSE',
    ffmpeg_command: '',
    render_status: parsed.review_status === 'NEEDS_REVIEW' ? 'PENDING' : 'SKIPPED',
    final_local_path: '',
    final_drive_file_id: '',
    final_drive_url: '',
    warning_message: '',
    error_message: parsed.review_status === 'NEEDS_REVIEW' ? '' : 'Transformation plan unavailable; render skipped.',
    created_at: now,
    started_at: '',
    completed_at: '',
  };
}

function backfillTransformationPlanRows(rows) {
  const alreadyFilledKeys = [
    'content_thesis',
    'hook',
    'narration_script',
    'commentary_angle',
    'kenyan_african_localization',
    'alternative_titles',
    'on_screen_text_beats',
    'broll_plan',
    'editing_style',
    'hashtags',
    'cta',
    'risk_warning',
    'originality_checklist',
  ];

  const updates = [];
  for (const row of rows || []) {
    if (!row.created_clip_id || !row.transformation_plan) continue;
    if (alreadyFilledKeys.some((key) => String(row[key] || '').trim())) continue;

    let plan;
    try {
      plan = JSON.parse(stripJsonFence(row.transformation_plan));
    } catch {
      continue;
    }
    if (!plan || typeof plan !== 'object' || Array.isArray(plan) || plan.parse_error) continue;

    updates.push(parseTransformationPlan(row, plan));
  }
  return updates;
}

module.exports = {
  TRANSFORMATION_SCHEMA,
  backfillTransformationPlanRows,
  buildDriveIdUpdate,
  buildPlannerRequest,
  buildRenderJobRow,
  normalizeFfmpegColor,
  normalizeRenderPlan,
  parseAiResponse,
  parseTransformationPlan,
  pickAwaitingDownloads,
};
