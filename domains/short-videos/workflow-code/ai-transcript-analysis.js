const { pickFairByGroup } = require('./fair-share');

const NICHE_RULES = {
  CHRISTIAN_CONTENT: 'Prioritize biblical truth connected to daily life, work, discipline, money, relationships, identity, prayer, obedience, forgiveness, wisdom, and purpose.',
  MOTIVATION_DISCIPLINE: 'Prioritize habits, focus, procrastination, consistency, routines, self-control, confidence, resilience, work ethic, and execution.',
  FINANCE_BUSINESS: 'Prioritize saving, debt, budgeting, investing basics, business ideas, pricing, sales, income, entrepreneurship, wealth habits, cash flow, and money mistakes. Localize using KSh, M-Pesa, SACCOs, MMFs, Nairobi rent, side hustles, and SME realities.',
  LIFE_VALUES_RELATIONSHIPS: 'Prioritize boundaries, communication, trust, self-worth, dating, marriage, emotional maturity, family values, and healthy conflict.',
  AFRICAN_KENYAN_SUCCESS: 'Prioritize founder lessons, practical wisdom, African business realities, Kenyan entrepreneurship, career growth, market realities, mistakes, resilience, and execution.',
};

const SYSTEM_PROMPT = `You are a short-form video content strategist for a Kenya-based commentary brand.

Find valuable, transformable short-form moments.

Default to USE_EXACT_CLIPS_ONLY whenever the transcript contains downloadable short-form moments. Return the best exact 45-90 second clips directly. Use USE_20_MIN_WINDOW only as optional analysis context for dense long videos, never as the preferred recommendation, and still return exact clip ranges inside those windows. Use SKIP_THIS_VIDEO only when the transcript lacks strong, brand-safe, transformable opportunities.

The downstream provider is yt-dlp, which only downloads exact time ranges. A 20-minute window is analysis context only; never rely on the provider to choose shorts from a window.

Return valid JSON matching the requested schema.`;

const WINDOW_SCHEMA = {
  type: 'object',
  properties: {
    use_this: { type: 'boolean' },
    start_sec: { type: 'number' },
    end_sec: { type: 'number' },
    why_this_window: { type: 'string' },
    estimated_number_of_good_clips: { type: 'number' },
  },
  required: ['use_this', 'start_sec', 'end_sec', 'why_this_window', 'estimated_number_of_good_clips'],
  additionalProperties: false,
};

const ANALYSIS_SCHEMA = {
  type: 'object',
  properties: {
        overall_episode_score: { type: 'number', minimum: 0, maximum: 10 },
        recommended_strategy: {
          type: 'string',
          enum: ['SKIP_THIS_VIDEO', 'USE_EXACT_CLIPS_ONLY', 'USE_20_MIN_WINDOW'],
        },
        reason_for_strategy: { type: 'string' },
        best_20_min_windows: {
          type: 'array',
          maxItems: 5,
          items: WINDOW_SCHEMA,
        },
        exact_clips: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              rank: { type: 'number' },
              start_sec: { type: 'number' },
              end_sec: { type: 'number' },
              clip_length_seconds: { type: 'number' },
              clip_score: { type: 'number', minimum: 0, maximum: 10 },
              hook_first_2_seconds: { type: 'string' },
              core_idea: { type: 'string' },
              why_it_is_valuable: { type: 'string' },
              best_target_audience: { type: 'string' },
              suggested_title: { type: 'string' },
              suggested_caption: { type: 'string' },
              on_screen_text: { type: 'string' },
              suggested_b_roll: { type: 'array', items: { type: 'string' } },
              my_original_commentary_angle: { type: 'string' },
              kenyan_african_application: { type: 'string' },
              bible_verse_if_relevant: { type: ['string', 'null'] },
              monetization_risk: { type: 'string', enum: ['low', 'medium', 'high'] },
              copyright_or_reused_content_risk: { type: 'string', enum: ['low', 'medium', 'high'] },
              does_it_need_extra_context: { type: 'boolean' },
              originality_score: { type: 'number', minimum: 0, maximum: 10 },
              final_recommendation: { type: 'string', enum: ['clip', 'use_as_idea_only', 'skip'] },
            },
            required: [
              'rank',
              'start_sec',
              'end_sec',
              'clip_length_seconds',
              'clip_score',
              'hook_first_2_seconds',
              'core_idea',
              'why_it_is_valuable',
              'best_target_audience',
              'suggested_title',
              'suggested_caption',
              'on_screen_text',
              'suggested_b_roll',
              'my_original_commentary_angle',
              'kenyan_african_application',
              'bible_verse_if_relevant',
              'monetization_risk',
              'copyright_or_reused_content_risk',
              'does_it_need_extra_context',
              'originality_score',
              'final_recommendation',
            ],
            additionalProperties: false,
          },
        },
        risk_notes: { type: 'string' },
  },
  required: [
    'overall_episode_score',
    'recommended_strategy',
    'reason_for_strategy',
    'best_20_min_windows',
    'exact_clips',
    'risk_notes',
  ],
  additionalProperties: false,
};

function stripJsonFence(text) {
  const value = String(text || '').trim();
  const match = value.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match ? match[1].trim() : value;
}

function buildSchemaInstructions() {
  return [
    'Return the bare analysis object only. Do not add an output wrapper or commentary.',
    'Do not use Markdown code fences.',
    'Use this strategy enum: SKIP_THIS_VIDEO, USE_EXACT_CLIPS_ONLY, USE_20_MIN_WINDOW. Prefer USE_EXACT_CLIPS_ONLY for all downloadable clips.',
    'All start_sec and end_sec values are raw seconds from the beginning of the video. Minute 5 is start_sec = 300; a 20-minute duration is 1200 seconds.',
    'For USE_20_MIN_WINDOW, populate best_20_min_windows only when window context is genuinely useful. Each window must have use_this=true, estimate at least 3 good clips, and provide a 60-1200 second range.',
    'For USE_20_MIN_WINDOW, exact_clips must contain the exact 45-90 second clips inside the selected windows. The workflow downloads exact_clips with yt-dlp; it does not download whole windows.',
    'For USE_EXACT_CLIPS_ONLY, exact_clips must contain at least one 45-90 second clip with final_recommendation="clip".',
    'For exact_clips[].final_recommendation use: clip, use_as_idea_only, or skip.',
    'For risk fields use lowercase: low, medium, or high.',
    'For SKIP_THIS_VIDEO, return an empty best_20_min_windows array.',
    'The JSON must conform to this schema:',
    JSON.stringify(ANALYSIS_SCHEMA),
  ].join('\n');
}

function clamp(number, low, high) {
  return Math.max(low, Math.min(high, Number(number) || 0));
}

function riskMax(risks) {
  if (risks.includes('high')) return 'high';
  if (risks.includes('medium')) return 'medium';
  return 'low';
}

function pickUnanalyzed(analysisRows, sourceRows, candidateRows, options = 5) {
  const limit = typeof options === 'number' ? options : Number(options.limit || 5);
  const perSourceLimit = typeof options === 'number' ? limit : Number(options.perSourceLimit || 1);
  const riskBySource = {};
  for (const source of sourceRows) {
    riskBySource[source.source_id] = String(source.risk_level || 'low').toLowerCase();
  }

  const candidateByVideo = {};
  for (const candidate of candidateRows) {
    candidateByVideo[candidate.video_id] = candidate;
  }

  const eligible = analysisRows
    .filter((row) => ['FETCHED', 'TRUNCATED'].includes(String(row.transcript_status)))
    .filter((row) => String(row.ai_episode_score || '') === '')
    .map((row) => {
      const candidate = candidateByVideo[row.video_id] || {};
      return {
        ...row,
        processing_status: candidate.processing_status || row.processing_status || 'NEW',
        source_risk: riskBySource[candidate.source_id] || 'low',
        source_id: candidate.source_id || '',
        niche: candidate.niche || row.niche || '',
      };
    });

  return pickFairByGroup(eligible, {
    limit,
    perSourceLimit,
    groupKey: 'niche',
    sourceKey: 'source_id',
    sourceFallbackKeys: ['niche'],
    sortKey: 'created_at',
  });
}

function buildAnalysisPrompt(row) {
  return [
    `Video title: ${row.video_title}`,
    `Video URL: ${row.video_url}`,
    `Niche: ${row.niche}`,
    `Niche rules: ${NICHE_RULES[row.niche] || 'General educational value.'}`,
    'Transcript with timestamps:',
    String(row.transcript_full || row.transcript_text || '').slice(0, 300000),
    buildSchemaInstructions(),
  ].join('\n');
}

function buildAnalysisRequest(row) {
  const userContent = buildAnalysisPrompt(row);

  return {
    ...row,
    openai_model: 'gpt-4o-mini',
    analysis_schema: JSON.stringify(ANALYSIS_SCHEMA),
    system_message: SYSTEM_PROMPT,
    user_message: userContent,
  };
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

function validateSchema(value, schema, path = 'AI response') {
  const allowedTypes = Array.isArray(schema.type) ? schema.type : [schema.type];
  const actualType = value === null ? 'null' : (Array.isArray(value) ? 'array' : typeof value);
  if (!allowedTypes.includes(actualType)) {
    throw new Error(`${path} must be ${allowedTypes.join(' or ')}`);
  }

  if (schema.enum && !schema.enum.includes(value)) {
    throw new Error(`${path} must be one of the allowed values: ${schema.enum.join(', ')}`);
  }

  if (actualType === 'number' && !Number.isFinite(value)) {
    throw new Error(`${path} must be a finite number`);
  }
  if (actualType === 'number' && schema.minimum !== undefined && value < schema.minimum) {
    throw new Error(`${path} must be at least ${schema.minimum}`);
  }
  if (actualType === 'number' && schema.maximum !== undefined && value > schema.maximum) {
    throw new Error(`${path} must be at most ${schema.maximum}`);
  }

  if (actualType === 'object') {
    const required = schema.required || [];
    const missing = required.filter((field) => !Object.prototype.hasOwnProperty.call(value, field));
    if (missing.length > 0) throw new Error(`${path} missing required fields: ${missing.join(', ')}`);

    const properties = schema.properties || {};
    if (schema.additionalProperties === false) {
      const unexpected = Object.keys(value).filter((field) => !Object.prototype.hasOwnProperty.call(properties, field));
      if (unexpected.length > 0) throw new Error(`${path} has unexpected fields: ${unexpected.join(', ')}`);
    }
    for (const [field, fieldSchema] of Object.entries(properties)) {
      if (Object.prototype.hasOwnProperty.call(value, field)) {
        validateSchema(value[field], fieldSchema, `${path}.${field}`);
      }
    }
  }

  if (actualType === 'array' && schema.items) {
    value.forEach((item, index) => validateSchema(item, schema.items, `${path}[${index}]`));
  }
}

function normalizeAnalysis(ai) {
  const normalized = { ...(ai || {}) };
  if (!Array.isArray(normalized.best_20_min_windows)) {
    if (normalized.best_20_min_window !== undefined) {
      normalized.best_20_min_windows = [normalized.best_20_min_window];
    } else {
      normalized.best_20_min_windows = [];
    }
  }
  delete normalized.best_20_min_window;
  return normalized;
}

function validateAiResponse(ai) {
  validateSchema(ai, ANALYSIS_SCHEMA);
}

function buildRetryableResult(row, response, error) {
  const apiMessage = response && response.error
    ? (response.error.message || response.error)
    : error.message;
  const message = `AI analysis retry required: ${String(apiMessage || error).slice(0, 900)}`;
  let output;
  try {
    output = JSON.stringify(response);
  } catch {
    output = String(response);
  }

  return {
    retryable: true,
    analysisUpdate: {
      analysis_id: row.analysis_id,
      ai_episode_score: '',
      recommended_strategy: '',
      recommended_start_sec: '',
      recommended_end_sec: '',
      reason_for_strategy: message,
      rights_risk: '',
      permission_risk: '',
      monetization_risk: '',
      originality_potential: '',
      kenya_relevance: '',
      ai_json_output: String(output || message),
    },
    candidateUpdate: {
      video_id: row.video_id,
      processing_status: row.processing_status || 'NEW',
    },
    momentRows: [],
  };
}

function buildMomentFromClip(row, clip, options = {}) {
  const startSec = Number(clip.start_sec);
  const endSec = Number(clip.end_sec);
  const rank = Number.isFinite(Number(clip.rank)) ? Number(clip.rank) : Number(options.rank || 1);
  const idSuffix = options.idSuffix || rank;
  const rightsRisk = ['low', 'medium', 'high'].includes(String(options.rightsRisk).toLowerCase())
    ? String(options.rightsRisk).toLowerCase()
    : String(clip.copyright_or_reused_content_risk || 'low');

  return {
    clip_moment_id: `CM-${row.video_id}-${idSuffix}`,
    video_id: row.video_id,
    niche: row.niche,
    source_id: options.sourceId || row.source_id || '',
    rank,
    start_sec: startSec,
    end_sec: endSec,
    clip_length_seconds: endSec - startSec,
    hook_first_2_seconds: String(clip.hook_first_2_seconds || ''),
    core_idea: String(clip.core_idea || options.fallbackReason || '').slice(0, 500),
    why_valuable: String(clip.why_it_is_valuable || '').slice(0, 500),
    target_audience: String(clip.best_target_audience || ''),
    suggested_title: String(clip.suggested_title || ''),
    suggested_caption: String(clip.suggested_caption || '').slice(0, 500),
    on_screen_text: String(clip.on_screen_text || ''),
    suggested_broll: JSON.stringify(clip.suggested_b_roll || []),
    commentary_angle: String(clip.my_original_commentary_angle || '').slice(0, 500),
    kenyan_african_application: String(clip.kenyan_african_application || '').slice(0, 500),
    bible_verse_if_relevant: clip.bible_verse_if_relevant || '',
    needs_extra_context: clip.does_it_need_extra_context ? 'TRUE' : 'FALSE',
    originality_score: clamp(clip.originality_score, 0, 10),
    clip_score: clamp(clip.clip_score, 0, 10),
    rights_risk: rightsRisk,
    final_recommendation: String(clip.final_recommendation),
    download_status: options.highRiskSource ? 'AWAITING_MANUAL_APPROVAL' : 'PENDING',
    download_job_id: '',
    strategy: options.strategy || 'USE_EXACT_CLIPS_ONLY',
    source_video_url: row.video_url || '',
    created_at: options.now || new Date().toISOString(),
  };
}

function parseStoredAnalysis(value) {
  if (!value) return {};
  try {
    const parsed = typeof value === 'string' ? JSON.parse(stripJsonFence(value)) : value;
    return parsed && parsed.output && typeof parsed.output === 'object' ? parsed.output : (parsed || {});
  } catch {
    return {};
  }
}

function collectWindows(ai) {
  return (ai.best_20_min_windows || [])
    .filter((window) => {
      const windowLength = Number(window.end_sec) - Number(window.start_sec);
      return window.use_this === true
        && Number(window.start_sec) >= 0
        && windowLength >= 60
        && windowLength <= 1200
        && Number(window.estimated_number_of_good_clips) >= 3;
    })
    .slice(0, 5);
}

function collectValidClips(ai) {
  return (ai.exact_clips || [])
    .filter((clip) => String(clip.final_recommendation) === 'clip')
    .filter((clip) => clamp(clip.clip_score, 0, 10) >= 7)
    .filter((clip) => {
      const start = Number(clip.start_sec);
      const end = Number(clip.end_sec);
      const length = end - start;
      return Number.isFinite(start)
        && Number.isFinite(end)
        && start >= 0
        && length >= 45
        && length <= 90;
    })
    .sort((a, b) => clamp(b.clip_score, 0, 10) - clamp(a.clip_score, 0, 10));
}

function collectWindowClips(ai, windows) {
  const seen = new Set();
  const rows = [];
  for (const [windowIndex, window] of windows.entries()) {
    const windowClips = collectValidClips(ai)
      .filter((clip) => Number(clip.start_sec) >= Number(window.start_sec) && Number(clip.end_sec) <= Number(window.end_sec))
      .slice(0, 3);
    for (const clip of windowClips) {
      const key = `${clip.start_sec}-${clip.end_sec}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({ clip, window, windowIndex });
    }
  }
  return rows.slice(0, 5);
}

function buildMissingWindowMoments(analysisRows, sourceRows, candidateRows, momentRows, now) {
  const riskBySource = {};
  for (const source of sourceRows || []) {
    riskBySource[source.source_id] = String(source.risk_level || 'low').toLowerCase();
  }

  const sourceByVideo = {};
  for (const candidate of candidateRows || []) {
    sourceByVideo[candidate.video_id] = candidate.source_id;
  }

  const existingIds = new Set((momentRows || []).map((row) => String(row.clip_moment_id || '')));
  const timestamp = now || new Date().toISOString();
  const repairs = [];

  for (const row of analysisRows || []) {
    if (String(row.recommended_strategy) !== 'USE_20_MIN_WINDOW' || !row.video_id) continue;

    const stored = parseStoredAnalysis(row.ai_json_output);
    const normalized = normalizeAnalysis(stored);
    const windows = collectWindows(normalized);
    if (windows.length === 0) continue;
    const sourceRisk = riskBySource[sourceByVideo[row.video_id]] || 'low';
    const sourceId = sourceByVideo[row.video_id] || row.source_id || '';
    collectWindowClips(normalized, windows).forEach(({ clip, windowIndex }, index) => {
      const clipMomentId = `CM-${row.video_id}-W${windowIndex}-${index + 1}`;
      if (existingIds.has(clipMomentId)) return;
      repairs.push(buildMomentFromClip(row, clip, {
        idSuffix: `W${windowIndex}-${index + 1}`,
        rank: index + 1,
        rightsRisk: row.rights_risk,
        highRiskSource: sourceRisk === 'high',
        sourceId,
        fallbackReason: row.reason_for_strategy,
        strategy: 'USE_20_MIN_WINDOW',
        now: timestamp,
      }));
      existingIds.add(clipMomentId);
    });
  }

  return repairs;
}

function parseAndGate(row, response, now = new Date().toISOString()) {
  let ai;
  try {
    if (response && response.error) throw new Error(String(response.error.message || response.error));
    ai = normalizeAnalysis(parseAiResponse(response));
    validateAiResponse(ai);
  } catch (error) {
    return buildRetryableResult(row, response, error);
  }
  const episodeScore = clamp(ai.overall_episode_score, 0, 10);

  let clips = collectValidClips(ai).slice(0, 5);

  const clipRightsRisks = clips.map((clip) => String(clip.copyright_or_reused_content_risk || 'low'));
  const clipMonetizationRisks = clips.map((clip) => String(clip.monetization_risk || 'low'));
  const conservativeRisk = riskMax([...clipRightsRisks, ...clipMonetizationRisks]);

  let strategy = String(ai.recommended_strategy || 'SKIP_THIS_VIDEO');
  if (episodeScore < 7 || conservativeRisk === 'high') strategy = 'SKIP_THIS_VIDEO';

  const windows = collectWindows(ai);
  const windowClips = collectWindowClips(ai, windows);
  if (strategy === 'USE_20_MIN_WINDOW') {
    if (windows.length === 0 || windowClips.length === 0) {
      strategy = clips.length > 0 ? 'USE_EXACT_CLIPS_ONLY' : 'SKIP_THIS_VIDEO';
    } else {
      strategy = 'USE_EXACT_CLIPS_ONLY';
    }
  }
  if (strategy === 'USE_EXACT_CLIPS_ONLY') {
    clips = clips.filter((clip) => String(clip.final_recommendation) === 'clip');
    if (clips.length === 0) strategy = 'SKIP_THIS_VIDEO';
  }

  const highRiskSource = String(row.source_risk) === 'high';
  const analysisUpdate = {
    analysis_id: row.analysis_id,
    ai_episode_score: episodeScore,
    recommended_strategy: strategy,
    recommended_start_sec: strategy === 'USE_20_MIN_WINDOW' ? Number(windows[0].start_sec) : '',
    recommended_end_sec: strategy === 'USE_20_MIN_WINDOW' ? Number(windows[0].end_sec) : '',
    reason_for_strategy: String(ai.reason_for_strategy || '').slice(0, 1000),
    rights_risk: riskMax(clipRightsRisks),
    permission_risk: riskMax(clipRightsRisks),
    monetization_risk: riskMax(clipMonetizationRisks),
    originality_potential: clips.length ? Math.max(...clips.map((clip) => clamp(clip.originality_score, 0, 10))) : 0,
    kenya_relevance: clips
      .map((clip) => String(clip.kenyan_african_application || '').trim())
      .filter(Boolean)
      .join(' | ')
      .slice(0, 300),
    // ai_json_output is jsonb now, so the object goes in as an object. The
    // old 40k slice was a Sheets cell limit, and truncating JSON mid-document
    // makes it unparseable. Stringifying it would also be wrong: a JSON string
    // lands in a jsonb column as a string scalar, so ai_json_output->'clips'
    // would come back NULL. The failure path below stores a bare error
    // message, which is a valid jsonb string scalar.
    ai_json_output: ai,
  };

  const candidateUpdate = {
    video_id: row.video_id,
    processing_status: strategy === 'SKIP_THIS_VIDEO' ? 'SKIPPED' : 'ANALYZED',
  };

  let momentRows = [];
  if (strategy === 'USE_20_MIN_WINDOW') {
    momentRows = windowClips.map(({ clip, windowIndex }, index) => buildMomentFromClip(row, clip, {
      idSuffix: `W${windowIndex}-${index + 1}`,
      rank: index + 1,
      rightsRisk: riskMax(clipRightsRisks),
      highRiskSource,
      sourceId: row.source_id || '',
      strategy,
      now,
    }));
  } else if (strategy === 'USE_EXACT_CLIPS_ONLY') {
    momentRows = clips.map((clip, index) => buildMomentFromClip(row, clip, {
      idSuffix: index + 1,
      rank: index + 1,
      rightsRisk: String(clip.copyright_or_reused_content_risk || 'low'),
      highRiskSource: highRiskSource || String(clip.copyright_or_reused_content_risk) === 'high',
      sourceId: row.source_id || '',
      strategy,
      created_at: now,
      now,
    }));
  }

  return { retryable: false, analysisUpdate, candidateUpdate, momentRows };
}

module.exports = {
  ANALYSIS_SCHEMA,
  buildAnalysisRequest,
  buildMissingWindowMoments,
  parseAndGate,
  pickUnanalyzed,
};
