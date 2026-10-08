const REJECT_PATTERNS = [
  [/(official\s+)?(trailer|teaser)\b/i, 'TRAILER_OR_PROMO'],
  [/\bpromo(tion)?\b/i, 'TRAILER_OR_PROMO'],
  [/\b(official (music )?video|lyric video|audio)\b/i, 'MUSIC_VIDEO'],
  [/\b(compilation|best of|top \d+ moments|highlights)\b/i, 'COMPILATION'],
  [/\b(news bulletin|breaking news|live news|breaking news)\b/i, 'NEWS_CLIP'],
  [/#shorts/i, 'SHORTS_UPLOAD'],
];

const STATIC_NARRATION_PATTERNS = [
  /\b(one|single)\s+(picture|image|photo)\b/i,
  /\b(static|still)\s+(image|picture|photo|background|screen)\b/i,
  /\b(quote card|quotes slideshow|slideshow|slide show)\b/i,
  /\b(text[-\s]?to[-\s]?speech|tts|ai voice(?:\s*over)?|robot voice)\b.*\b(story|stories|quotes?|motivation|motivational|wisdom|narration)\b/i,
  /\b(story|stories|quotes?|motivation|motivational|wisdom)\b.*\b(narration|narrated|voice\s*over|voiceover)\b/i,
  /\b(narration|narrated|voice\s*over|voiceover)\b.*\b(static|still|one picture|single image|slideshow|quotes?)\b/i,
];

const PREFER_PATTERNS = [
  /podcast/i,
  /interview/i,
  /sermon/i,
  /teaching/i,
  /lesson/i,
  /masterclass/i,
  /conversation/i,
  /keynote/i,
  /q\s*&\s*a/i,
  /panel/i,
  /testimony/i,
];

const ENGAGEMENT_GATE = {
  minViews: 10000,
  minLikePercentage: 0.02,
  minEngagementPercentage: 0.02,
  minCommentPercentage: 0.0005,
};

function numberValue(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function computeEngagementMetrics(candidate) {
  const views = numberValue(candidate.view_count);
  const likes = numberValue(candidate.like_count);
  const comments = numberValue(candidate.comment_count);

  // Zero views makes a percentage undefined, not zero. Writing 0 was a Sheets
  // formatting convention; the columns are nullable numeric now (spec Section 1
  // item 2), and the gate below treats NULL as failing.
  if (views <= 0) {
    return {
      like_percentage: null,
      comment_percentage: null,
      engagement_percentage: null,
    };
  }

  return {
    like_percentage: likes / views,
    comment_percentage: comments / views,
    engagement_percentage: (likes + comments) / views,
  };
}

// A NULL percentage means "undefined", which fails a minimum threshold. The
// check is explicit rather than leaning on `null >= 0.02` being false, because
// Number(null) and Number('') are both 0 and an implicit coercion elsewhere
// would read a missing value as a real zero. Postgres returns numeric as a
// string, so a numeric-looking string must still compare as a number.
function meetsThreshold(value, minimum) {
  if (value === null || value === undefined || value === '') return false;
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= minimum;
}

function passesEngagementGate(candidate, metrics = computeEngagementMetrics(candidate)) {
  return (
    meetsThreshold(candidate.view_count, ENGAGEMENT_GATE.minViews) &&
    meetsThreshold(metrics.like_percentage, ENGAGEMENT_GATE.minLikePercentage) &&
    meetsThreshold(metrics.engagement_percentage, ENGAGEMENT_GATE.minEngagementPercentage) &&
    meetsThreshold(metrics.comment_percentage, ENGAGEMENT_GATE.minCommentPercentage)
  );
}

function buildRiskBySource(sourceRows) {
  return sourceRows.reduce((lookup, row) => {
    if (!row.source_id) return lookup;
    lookup[row.source_id] = String(row.risk_level || 'low').toLowerCase();
    return lookup;
  }, {});
}

function scoreCandidate(candidate) {
  const title = String(candidate.video_title || '');
  const duration = Number(candidate.duration_seconds || 0);
  const views = Number(candidate.view_count || 0);
  let score = 5;

  if (duration >= 900 && duration <= 7200) score += 2;
  else if (duration >= 300) score += 1;
  if (PREFER_PATTERNS.some((pattern) => pattern.test(title))) score += 2;
  if (views >= 10000) score += 1;

  return Math.min(10, score);
}

function staticNarrationRisk(candidate) {
  const text = [
    candidate.video_title,
    candidate.video_description,
    candidate.description,
    candidate.source_name,
    candidate.source_type,
  ].filter(Boolean).join(' ');

  return STATIC_NARRATION_PATTERNS.some((pattern) => pattern.test(text));
}

function classifyCandidate(candidate, riskBySource) {
  const title = String(candidate.video_title || '');
  const duration = Number(candidate.duration_seconds || 0);
  const engagementMetrics = computeEngagementMetrics(candidate);
  let status = 'VALID';
  let reason = '';

  if (duration > 0 && duration <= 60) {
    status = 'REJECTED';
    reason = 'SHORTS_UPLOAD';
  } else if (duration > 0 && duration < 180) {
    status = 'REJECTED';
    reason = 'TOO_SHORT';
  } else {
    for (const [pattern, code] of REJECT_PATTERNS) {
      if (pattern.test(title)) {
        status = 'REJECTED';
        reason = code;
        break;
      }
    }
    if (status === 'VALID' && staticNarrationRisk(candidate)) {
      status = 'REJECTED';
      reason = 'STATIC_NARRATION_VISUALS';
    }
  }

  if (status === 'VALID' && !passesEngagementGate(candidate, engagementMetrics)) {
    status = 'REJECTED';
    reason = 'LOW_ENGAGEMENT';
  }

  const language = String(candidate.language || '').toLowerCase();
  if (status === 'VALID' && language && !language.startsWith('en') && !language.startsWith('sw')) {
    status = 'FLAGGED';
    reason = 'LANGUAGE_CHECK';
  }

  if (status === 'VALID' && riskBySource[candidate.source_id] === 'high') {
    status = 'FLAGGED';
    reason = 'MANUAL_APPROVAL_REQUIRED';
  }

  return {
    video_id: candidate.video_id,
    ...engagementMetrics,
    validity_status: status,
    validity_score: scoreCandidate(candidate),
    rejection_reason: reason,
    processing_status: status === 'REJECTED' ? 'SKIPPED' : candidate.processing_status,
  };
}

function applyValidityRules(candidateRows, riskBySource) {
  return candidateRows
    .filter((candidate) => String(candidate.processing_status) === 'NEW')
    .filter((candidate) => String(candidate.validity_status || '') === '')
    .map((candidate) => classifyCandidate(candidate, riskBySource));
}

module.exports = {
  ENGAGEMENT_GATE,
  meetsThreshold,
  applyValidityRules,
  buildRiskBySource,
  classifyCandidate,
  computeEngagementMetrics,
  passesEngagementGate,
  scoreCandidate,
  staticNarrationRisk,
};
