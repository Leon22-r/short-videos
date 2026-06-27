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
    'The JSON must conform to this schema:',
    JSON.stringify(TRANSFORMATION_SCHEMA),
  ].join('\n');
}

function pickAwaitingDownloads(clips, jobs, moments, folders, limit = 5) {
  const jobsById = Object.fromEntries(jobs.map((job) => [job.ssemble_job_id, job]));
  const momentsById = Object.fromEntries(moments.map((moment) => [moment.clip_moment_id, moment]));

  return clips
    .filter((clip) => String(clip.review_status) === 'AWAITING_DOWNLOAD')
    .slice(0, limit)
    .map((clip) => {
      const job = jobsById[clip.ssemble_job_id] || {};
      const moment = momentsById[job.clip_moment_id] || {};
      const niche = clip.niche || job.niche || 'AFRICAN_KENYAN_SUCCESS';
      return {
        ...clip,
        niche,
        video_id: clip.video_id || job.video_id || '',
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
  return {
    created_clip_id: meta.created_clip_id,
    video_id: meta.video_id,
    niche: meta.niche,
    local_file_name: meta.file_name || meta.local_file_name,
    google_drive_file_id: meta.drive_file_id || meta.google_drive_file_id,
    google_drive_url: meta.drive_url || meta.google_drive_url,
    suggested_title: title,
    suggested_caption: String(plan.caption || '').slice(0, 500),
    transformation_plan: JSON.stringify(parseError ? { parse_error: parseError, raw: response } : plan).slice(0, 40000),
    review_status: parseError || !title ? 'NEEDS_RETRY' : 'NEEDS_REVIEW',
  };
}

module.exports = {
  TRANSFORMATION_SCHEMA,
  buildDriveIdUpdate,
  buildPlannerRequest,
  parseAiResponse,
  parseTransformationPlan,
  pickAwaitingDownloads,
};
