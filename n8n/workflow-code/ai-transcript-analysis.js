const NICHE_RULES = {
  CHRISTIAN_CONTENT: 'Prioritize biblical truth connected to daily life, work, discipline, money, relationships, identity, prayer, obedience, forgiveness, wisdom, and purpose.',
  MOTIVATION_DISCIPLINE: 'Prioritize habits, focus, procrastination, consistency, routines, self-control, confidence, resilience, work ethic, and execution.',
  FINANCE_BUSINESS: 'Prioritize saving, debt, budgeting, investing basics, business ideas, pricing, sales, income, entrepreneurship, wealth habits, cash flow, and money mistakes. Localize using KSh, M-Pesa, SACCOs, MMFs, Nairobi rent, side hustles, and SME realities.',
  LIFE_VALUES_RELATIONSHIPS: 'Prioritize boundaries, communication, trust, self-worth, dating, marriage, emotional maturity, family values, and healthy conflict.',
  AFRICAN_KENYAN_SUCCESS: 'Prioritize founder lessons, practical wisdom, African business realities, Kenyan entrepreneurship, career growth, market realities, mistakes, resilience, and execution.',
};

const SYSTEM_PROMPT = `You are a short-form video content strategist for a Kenya-based commentary brand.

Find valuable, transformable short-form moments. Save Ssemble credits by recommending SKIP_THIS_VIDEO unless the transcript contains strong, brand-safe, original-commentary opportunities.

Return valid JSON matching the requested schema.`;

const ANALYSIS_SCHEMA = {
  type: 'object',
  properties: {
        overall_episode_score: { type: 'number', minimum: 0, maximum: 10 },
        recommended_strategy: {
          type: 'string',
          enum: ['SKIP_THIS_VIDEO', 'USE_EXACT_CLIPS_ONLY', 'USE_20_MIN_WINDOW'],
        },
        reason_for_strategy: { type: 'string' },
        best_20_min_window: {
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
    'best_20_min_window',
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
    'Use this strategy enum: SKIP_THIS_VIDEO, USE_EXACT_CLIPS_ONLY, USE_20_MIN_WINDOW.',
    'All start_sec and end_sec values are raw seconds from the beginning of the video. Minute 5 is start_sec = 300; a 20-minute duration is 1200 seconds.',
    'For USE_20_MIN_WINDOW, set best_20_min_window.use_this=true, estimate at least 3 good clips, and provide a 60-1200 second window; exact_clips may be empty.',
    'For USE_EXACT_CLIPS_ONLY, exact_clips must contain at least one clip with final_recommendation="clip".',
    'For exact_clips[].final_recommendation use: clip, use_as_idea_only, or skip.',
    'For risk fields use lowercase: low, medium, or high.',
    'For SKIP_THIS_VIDEO, provide a complete best_20_min_window with use_this=false, numeric zero values, an empty why_this_window, and estimated_number_of_good_clips=0.',
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

function pickUnanalyzed(analysisRows, sourceRows, candidateRows, limit = 5) {
  const riskBySource = {};
  for (const source of sourceRows) {
    riskBySource[source.source_id] = String(source.risk_level || 'low').toLowerCase();
  }

  const candidateByVideo = {};
  for (const candidate of candidateRows) {
    candidateByVideo[candidate.video_id] = candidate;
  }

  return analysisRows
    .filter((row) => ['FETCHED', 'TRUNCATED'].includes(String(row.transcript_status)))
    .filter((row) => String(row.ai_episode_score || '') === '')
    .slice(0, limit)
    .map((row) => {
      const candidate = candidateByVideo[row.video_id] || {};
      return {
        ...row,
        processing_status: candidate.processing_status || row.processing_status || 'NEW',
        source_risk: riskBySource[candidate.source_id] || 'low',
      };
    });
}

function buildAnalysisPrompt(row) {
  return [
    `Video title: ${row.video_title}`,
    `Video URL: ${row.video_url}`,
    `Niche: ${row.niche}`,
    `Niche rules: ${NICHE_RULES[row.niche] || 'General educational value.'}`,
    'Transcript with timestamps:',
    String(row.transcript_text || '').slice(0, 100000),
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
      ai_json_output: String(output || message).slice(0, 40000),
    },
    candidateUpdate: {
      video_id: row.video_id,
      processing_status: row.processing_status || 'NEW',
    },
    momentRows: [],
  };
}

function buildWindowMoment(row, window, options = {}) {
  const startSec = Number(window.start_sec);
  const endSec = Number(window.end_sec);
  const estimatedClips = Number(options.estimatedClips);
  const rightsRisk = ['low', 'medium', 'high'].includes(String(options.rightsRisk).toLowerCase())
    ? String(options.rightsRisk).toLowerCase()
    : 'low';

  return {
    clip_moment_id: `CM-${row.video_id}-W0`,
    video_id: row.video_id,
    niche: row.niche || '',
    rank: 0,
    start_sec: startSec,
    end_sec: endSec,
    clip_length_seconds: endSec - startSec,
    hook_first_2_seconds: '',
    core_idea: String(window.why_this_window || options.fallbackReason || '').slice(0, 500),
    why_valuable: Number.isFinite(estimatedClips)
      ? `window with ~${estimatedClips} strong clips`
      : 'window selected for automatic clipping',
    target_audience: '',
    suggested_title: '',
    suggested_caption: '',
    on_screen_text: '',
    suggested_broll: '',
    commentary_angle: '',
    kenyan_african_application: '',
    bible_verse_if_relevant: '',
    needs_extra_context: 'FALSE',
    originality_score: '',
    clip_score: clamp(options.clipScore, 0, 10),
    rights_risk: rightsRisk,
    final_recommendation: 'clip',
    ssemble_status: options.highRiskSource ? 'AWAITING_MANUAL_APPROVAL' : 'PENDING',
    ssemble_job_id: '',
    strategy: 'USE_20_MIN_WINDOW',
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

    const clipMomentId = `CM-${row.video_id}-W0`;
    if (existingIds.has(clipMomentId)) continue;

    const startSec = Number(row.recommended_start_sec);
    const endSec = Number(row.recommended_end_sec);
    const windowLength = endSec - startSec;
    if (!Number.isFinite(startSec) || !Number.isFinite(endSec) || startSec < 0
      || windowLength < 60 || windowLength > 1200) continue;

    const stored = parseStoredAnalysis(row.ai_json_output);
    const storedWindow = stored.best_20_min_window || {};
    const sourceRisk = riskBySource[sourceByVideo[row.video_id]] || 'low';
    repairs.push(buildWindowMoment(row, {
      start_sec: startSec,
      end_sec: endSec,
      why_this_window: storedWindow.why_this_window || row.reason_for_strategy || '',
    }, {
      clipScore: row.ai_episode_score,
      rightsRisk: row.rights_risk,
      estimatedClips: storedWindow.estimated_number_of_good_clips,
      highRiskSource: sourceRisk === 'high',
      fallbackReason: row.reason_for_strategy,
      now: timestamp,
    }));
    existingIds.add(clipMomentId);
  }

  return repairs;
}

function parseAndGate(row, response, now = new Date().toISOString()) {
  let ai;
  try {
    if (response && response.error) throw new Error(String(response.error.message || response.error));
    ai = parseAiResponse(response);
    validateAiResponse(ai);
  } catch (error) {
    return buildRetryableResult(row, response, error);
  }
  const episodeScore = clamp(ai.overall_episode_score, 0, 10);

  let clips = (ai.exact_clips || [])
    .filter((clip) => clamp(clip.clip_score, 0, 10) >= 7)
    .filter((clip) => Number(clip.end_sec) > Number(clip.start_sec) && Number(clip.start_sec) >= 0)
    .sort((a, b) => clamp(b.clip_score, 0, 10) - clamp(a.clip_score, 0, 10))
    .slice(0, 3);

  const clipRightsRisks = clips.map((clip) => String(clip.copyright_or_reused_content_risk || 'low'));
  const clipMonetizationRisks = clips.map((clip) => String(clip.monetization_risk || 'low'));
  const conservativeRisk = riskMax([...clipRightsRisks, ...clipMonetizationRisks]);

  let strategy = String(ai.recommended_strategy || 'SKIP_THIS_VIDEO');
  if (episodeScore < 7 || conservativeRisk === 'high') strategy = 'SKIP_THIS_VIDEO';

  const window = ai.best_20_min_window || {};
  if (strategy === 'USE_20_MIN_WINDOW') {
    const windowLength = Number(window.end_sec) - Number(window.start_sec);
    const validWindow = window.use_this === true
      && windowLength >= 60
      && windowLength <= 1200
      && Number(window.estimated_number_of_good_clips) >= 3;
    if (!validWindow) {
      strategy = clips.length > 0 ? 'USE_EXACT_CLIPS_ONLY' : 'SKIP_THIS_VIDEO';
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
    recommended_start_sec: strategy === 'USE_20_MIN_WINDOW' ? Number(window.start_sec) : '',
    recommended_end_sec: strategy === 'USE_20_MIN_WINDOW' ? Number(window.end_sec) : '',
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
    ai_json_output: JSON.stringify(ai).slice(0, 40000),
  };

  const candidateUpdate = {
    video_id: row.video_id,
    processing_status: strategy === 'SKIP_THIS_VIDEO' ? 'SKIPPED' : 'ANALYZED',
  };

  let momentRows = [];
  if (strategy === 'USE_20_MIN_WINDOW') {
    momentRows = [buildWindowMoment(row, window, {
      clipScore: episodeScore,
      rightsRisk: riskMax(clipRightsRisks),
      estimatedClips: window.estimated_number_of_good_clips,
      highRiskSource,
      now,
    })];
  } else if (strategy === 'USE_EXACT_CLIPS_ONLY') {
    momentRows = clips.map((clip, index) => ({
      clip_moment_id: `CM-${row.video_id}-${index + 1}`,
      video_id: row.video_id,
      niche: row.niche,
      rank: index + 1,
      start_sec: Number(clip.start_sec),
      end_sec: Number(clip.end_sec),
      clip_length_seconds: Number(clip.end_sec) - Number(clip.start_sec),
      hook_first_2_seconds: String(clip.hook_first_2_seconds || ''),
      core_idea: String(clip.core_idea || '').slice(0, 500),
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
      rights_risk: String(clip.copyright_or_reused_content_risk || 'low'),
      final_recommendation: String(clip.final_recommendation),
      ssemble_status: (highRiskSource || String(clip.copyright_or_reused_content_risk) === 'high')
        ? 'AWAITING_MANUAL_APPROVAL'
        : 'PENDING',
      ssemble_job_id: '',
      strategy,
      source_video_url: row.video_url,
      created_at: now,
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
