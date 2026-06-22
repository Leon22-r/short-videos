const fs = require('node:fs');

const workflowPath = process.argv[2] || 'n8n/workflows/03-validity-check.json';

const sheet = (operation, sheetName, extra = {}) => ({
  operation,
  documentId: { __rl: true, mode: 'id', value: 'GOOGLE_SHEETS_DOCUMENT_ID' },
  sheetName: { __rl: true, mode: 'name', value: sheetName },
  options: {},
  ...extra,
});

const sheetsNode = (id, name, position, parameters, extra = {}) => ({
  parameters,
  id,
  name,
  type: 'n8n-nodes-base.googleSheets',
  typeVersion: 4.5,
  position,
  ...(parameters.operation === 'read' ? { executeOnce: true } : {}),
  ...extra,
});

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
const PREFER_PATTERNS = [
  /podcast/i, /interview/i, /sermon/i, /teaching/i, /lesson/i, /masterclass/i,
  /conversation/i, /keynote/i, /q\\s*&\\s*a/i, /panel/i, /testimony/i,
];

const out = [];
for (const item of $input.all()) {
  const v = item.json;
  if (String(v.processing_status) !== 'NEW' || String(v.validity_status || '') !== '') continue;

  const title = String(v.video_title || '');
  const dur = Number(v.duration_seconds || 0);
  let status = 'VALID';
  let reason = '';

  if (dur > 0 && dur <= 60) { status = 'REJECTED'; reason = 'SHORTS_UPLOAD'; }
  else if (dur > 0 && dur < 180) { status = 'REJECTED'; reason = 'TOO_SHORT'; }
  else {
    for (const [re, code] of REJECT_PATTERNS) {
      if (re.test(title)) { status = 'REJECTED'; reason = code; break; }
    }
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
  nodes: [
    {
      parameters: { rule: { interval: [{ field: 'hours', hoursInterval: 1 }] } },
      id: 'a1b2c3d4-0003-4000-8000-000000000001',
      name: 'Schedule Hourly',
      type: 'n8n-nodes-base.scheduleTrigger',
      typeVersion: 1.2,
      position: [0, 0],
    },
    sheetsNode('a1b2c3d4-0003-4000-8000-000000000002', 'Read Source_Channels', [220, 0], sheet('read', 'Source_Channels')),
    sheetsNode('a1b2c3d4-0003-4000-8000-000000000003', 'Read Candidate_Videos', [440, 0], sheet('read', 'Candidate_Videos')),
    codeNode('a1b2c3d4-0003-4000-8000-000000000004', 'Apply Rules', [660, 0], applyRulesCode),
    sheetsNode(
      'a1b2c3d4-0003-4000-8000-000000000005',
      'Update Candidate Rows',
      [880, 0],
      sheet('appendOrUpdate', 'Candidate_Videos', {
        columns: { mappingMode: 'autoMapInputData', value: {}, matchingColumns: ['video_id'] },
      }),
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
