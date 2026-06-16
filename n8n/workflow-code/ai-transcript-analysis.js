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

  const sourceByVideo = {};
  for (const candidate of candidateRows) {
    sourceByVideo[candidate.video_id] = candidate.source_id;
  }

  return analysisRows
    .filter((row) => ['FETCHED', 'TRUNCATED'].includes(String(row.transcript_status)))
    .filter((row) => String(row.ai_episode_score || '') === '')
    .slice(0, limit)
    .map((row) => ({
      ...row,
      source_risk: riskBySource[sourceByVideo[row.video_id]] || 'low',
    }));
}

function buildAnalysisRequest(row) {
  const userContent = [
    `Video title: ${row.video_title}`,
    `Video URL: ${row.video_url}`,
    `Niche: ${row.niche}`,
    `Niche rules: ${NICHE_RULES[row.niche] || 'General educational value.'}`,
    'Transcript with timestamps:',
    String(row.transcript_text || '').slice(0, 100000),
  ].join('\n');

  return {
    ...row,
    openai_body: JSON.stringify({
      model: 'gpt-4o-mini',
      response_format: { type: 'json_object' },
      temperature: 0.4,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userContent },
      ],
    }),
  };
}

function parseAiResponse(response) {
  if (typeof response === 'string') return JSON.parse(response);
  if (response && response.choices) return JSON.parse(response.choices[0].message.content);
  return response || {};
}

function parseAndGate(row, response, now = new Date().toISOString()) {
  const ai = parseAiResponse(response);
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
    const strongInWindow = clips.filter(
      (clip) => Number(clip.start_sec) >= Number(window.start_sec) && Number(clip.end_sec) <= Number(window.end_sec),
    ).length;
    if (!(windowLength >= 60 && windowLength <= 1200) || strongInWindow < 3) {
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
    monetization_risk: riskMax(clipMonetizationRisks),
    originality_potential: clips.length ? Math.max(...clips.map((clip) => clamp(clip.originality_score, 0, 10))) : 0,
    kenya_relevance: String(ai.risk_notes || '').slice(0, 300),
    ai_json_output: JSON.stringify(ai).slice(0, 40000),
  };

  const candidateUpdate = {
    video_id: row.video_id,
    processing_status: strategy === 'SKIP_THIS_VIDEO' ? 'SKIPPED' : 'ANALYZED',
  };

  let momentRows = [];
  if (strategy === 'USE_20_MIN_WINDOW') {
    momentRows = [{
      clip_moment_id: `CM-${row.video_id}-W0`,
      video_id: row.video_id,
      niche: row.niche,
      rank: 0,
      start_sec: Number(window.start_sec),
      end_sec: Number(window.end_sec),
      clip_length_seconds: Number(window.end_sec) - Number(window.start_sec),
      hook_first_2_seconds: '',
      core_idea: String(window.why_this_window || '').slice(0, 500),
      why_valuable: `window with ~${window.estimated_number_of_good_clips} strong clips`,
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
      clip_score: episodeScore,
      rights_risk: riskMax(clipRightsRisks),
      final_recommendation: 'clip',
      ssemble_status: highRiskSource ? 'AWAITING_MANUAL_APPROVAL' : 'PENDING',
      ssemble_job_id: '',
      strategy,
      source_video_url: row.video_url,
      created_at: now,
    }];
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

  return { analysisUpdate, candidateUpdate, momentRows };
}

module.exports = {
  buildAnalysisRequest,
  parseAndGate,
  pickUnanalyzed,
};
