const REJECT_PATTERNS = [
  [/(official\s+)?(trailer|teaser)\b/i, 'TRAILER_OR_PROMO'],
  [/\bpromo(tion)?\b/i, 'TRAILER_OR_PROMO'],
  [/\b(official (music )?video|lyric video|audio)\b/i, 'MUSIC_VIDEO'],
  [/\b(compilation|best of|top \d+ moments|highlights)\b/i, 'COMPILATION'],
  [/\b(news bulletin|breaking news|live news|breaking news)\b/i, 'NEWS_CLIP'],
  [/#shorts/i, 'SHORTS_UPLOAD'],
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

function classifyCandidate(candidate, riskBySource) {
  const title = String(candidate.video_title || '');
  const duration = Number(candidate.duration_seconds || 0);
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
  applyValidityRules,
  buildRiskBySource,
  classifyCandidate,
  scoreCandidate,
};
