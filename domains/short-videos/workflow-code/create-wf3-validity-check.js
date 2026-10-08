const fs = require('node:fs');
const path = require('node:path');

// Resolved from this file's location, not the working directory.
const DOMAIN_ROOT = path.join(__dirname, '..');

const workflowPath = process.argv[2] || path.join(DOMAIN_ROOT, 'workflows/03-validity-check.json');

const { querySql, postgresNode } = require('./table-node');

// Every item the node received, as a jsonb array in $1.
const ROWS = '={{ JSON.stringify($input.all().map(item => item.json)) }}';

const codeNode = (id, name, position, jsCode) => ({
  parameters: { mode: 'runOnceForAllItems', jsCode },
  id,
  name,
  type: 'n8n-nodes-base.code',
  typeVersion: 2,
  position,
});

const applyRulesCode = `const riskBySource = {};
for (const s of $('Read Source_Channels').all()) {
  riskBySource[s.json.source_id] = String(s.json.risk_level || 'low').toLowerCase();
}

const REJECT_PATTERNS = [
  [/(official\\s+)?(trailer|teaser)\\b/i, 'TRAILER_OR_PROMO'],
  [/\\bpromo(tion)?\\b/i, 'TRAILER_OR_PROMO'],
  [/\\b(official (music )?video|lyric video|audio)\\b/i, 'MUSIC_VIDEO'],
  [/\\b(compilation|best of|top \\d+ moments|highlights)\\b/i, 'COMPILATION'],
  [/\\b(news bulletin|breaking news|live news)\\b/i, 'NEWS_CLIP'],
  [/#shorts/i, 'SHORTS_UPLOAD'],
];
const STATIC_NARRATION_PATTERNS = [
  /\\b(one|single)\\s+(picture|image|photo)\\b/i,
  /\\b(static|still)\\s+(image|picture|photo|background|screen)\\b/i,
  /\\b(quote card|quotes slideshow|slideshow|slide show)\\b/i,
  /\\b(text[-\\s]?to[-\\s]?speech|tts|ai voice(?:\\s*over)?|robot voice)\\b.*\\b(story|stories|quotes?|motivation|motivational|wisdom|narration)\\b/i,
  /\\b(story|stories|quotes?|motivation|motivational|wisdom)\\b.*\\b(narration|narrated|voice\\s*over|voiceover)\\b/i,
  /\\b(narration|narrated|voice\\s*over|voiceover)\\b.*\\b(static|still|one picture|single image|slideshow|quotes?)\\b/i,
];
const PREFER_PATTERNS = [
  /podcast/i, /interview/i, /sermon/i, /teaching/i, /lesson/i, /masterclass/i,
  /conversation/i, /keynote/i, /q\\s*&\\s*a/i, /panel/i, /testimony/i,
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

function computeEngagementMetrics(v) {
  const views = numberValue(v.view_count);
  const likes = numberValue(v.like_count);
  const comments = numberValue(v.comment_count);
  if (views <= 0) {
    return {
      like_percentage: 0,
      comment_percentage: 0,
      engagement_percentage: 0,
    };
  }
  return {
    like_percentage: likes / views,
    comment_percentage: comments / views,
    engagement_percentage: (likes + comments) / views,
  };
}

function passesEngagementGate(v, metrics) {
  return (
    numberValue(v.view_count) >= ENGAGEMENT_GATE.minViews &&
    metrics.like_percentage >= ENGAGEMENT_GATE.minLikePercentage &&
    metrics.engagement_percentage >= ENGAGEMENT_GATE.minEngagementPercentage &&
    metrics.comment_percentage >= ENGAGEMENT_GATE.minCommentPercentage
  );
}

const out = [];
for (const item of $input.all()) {
  const v = item.json;
  if (String(v.processing_status) !== 'NEW' || String(v.validity_status || '') !== '') continue;

  const title = String(v.video_title || '');
  const dur = Number(v.duration_seconds || 0);
  const engagementMetrics = computeEngagementMetrics(v);
  let status = 'VALID';
  let reason = '';

  if (dur > 0 && dur <= 60) { status = 'REJECTED'; reason = 'SHORTS_UPLOAD'; }
  else if (dur > 0 && dur < 180) { status = 'REJECTED'; reason = 'TOO_SHORT'; }
  else {
    for (const [re, code] of REJECT_PATTERNS) {
      if (re.test(title)) { status = 'REJECTED'; reason = code; break; }
    }
    const staticText = [v.video_title, v.video_description, v.description, v.source_name, v.source_type]
      .filter(Boolean)
      .join(' ');
    if (status === 'VALID' && STATIC_NARRATION_PATTERNS.some(re => re.test(staticText))) {
      status = 'REJECTED';
      reason = 'STATIC_NARRATION_VISUALS';
    }
  }

  if (status === 'VALID' && !passesEngagementGate(v, engagementMetrics)) {
    status = 'REJECTED';
    reason = 'LOW_ENGAGEMENT';
  }

  const lang = String(v.language || '').toLowerCase();
  if (status === 'VALID' && lang && !lang.startsWith('en') && !lang.startsWith('sw')) {
    status = 'FLAGGED'; reason = 'LANGUAGE_CHECK';
  }

  let score = 5;
  if (dur >= 900 && dur <= 7200) score += 2;
  else if (dur >= 300) score += 1;
  if (PREFER_PATTERNS.some(re => re.test(title))) score += 2;
  const views = Number(v.view_count || 0);
  if (views >= 10000) score += 1;
  score = Math.min(10, score);

  if (status === 'VALID' && riskBySource[v.source_id] === 'high') {
    status = 'FLAGGED'; reason = 'MANUAL_APPROVAL_REQUIRED';
  }

  out.push({
    json: {
      video_id: v.video_id,
      ...engagementMetrics,
      validity_status: status,
      validity_score: score,
      rejection_reason: reason,
      processing_status: status === 'REJECTED' ? 'SKIPPED' : v.processing_status,
    },
    pairedItem: { item: 0 },
  });
}
return out;`;

const workflow = {
  name: 'WF3 Validity Check',
  description: 'Applies format, rights-risk, language, and engagement gates before transcript work. It rejects weak candidates early so downstream provider and processing capacity is reserved for viable videos.',
  nodes: [
    {
      parameters: { rule: { interval: [{ field: 'hours', hoursInterval: 1 }] } },
      id: 'a1b2c3d4-0003-4000-8000-000000000001',
      name: 'Schedule Hourly',
      type: 'n8n-nodes-base.scheduleTrigger',
      typeVersion: 1.2,
      position: [0, 0],
    },
    postgresNode('a1b2c3d4-0003-4000-8000-000000000002', 'Read Source_Channels', [220, 0], querySql('select-source-channels')),
    postgresNode('a1b2c3d4-0003-4000-8000-000000000003', 'Read Candidate_Videos', [440, 0], querySql('select-candidate-videos')),
    codeNode('a1b2c3d4-0003-4000-8000-000000000004', 'Apply Rules', [660, 0], applyRulesCode),
    // An UPDATE: WF2 created these rows, and WF3 owns only the classification
    // columns. The percentages can be NULL now (spec Section 1 item 2).
    postgresNode(
      'a1b2c3d4-0003-4000-8000-000000000005',
      'Update Candidate Rows',
      [880, 0],
      querySql('update-candidate-validity'),
      ROWS,
    ),
  ],
  connections: {
    'Schedule Hourly': { main: [[{ node: 'Read Source_Channels', type: 'main', index: 0 }]] },
    'Read Source_Channels': { main: [[{ node: 'Read Candidate_Videos', type: 'main', index: 0 }]] },
    'Read Candidate_Videos': { main: [[{ node: 'Apply Rules', type: 'main', index: 0 }]] },
    'Apply Rules': { main: [[{ node: 'Update Candidate Rows', type: 'main', index: 0 }]] },
  },
  settings: { executionOrder: 'v1' },
  pinData: {},
  meta: { instanceId: 'placeholder' },
};

fs.writeFileSync(workflowPath, `${JSON.stringify(workflow, null, 2)}\n`);
