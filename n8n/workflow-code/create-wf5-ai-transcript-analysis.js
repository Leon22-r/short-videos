const fs = require('node:fs');
const { readFileSync } = require('node:fs');

const workflowPath = process.argv[2] || 'n8n/workflows/05-ai-transcript-analysis.json';
const helperSource = readFileSync('n8n/workflow-code/ai-transcript-analysis.js', 'utf8');
const embeddedHelper = helperSource.replace(/module\.exports = \{[\s\S]*?\};\n?/, '');
const healthHelperSource = readFileSync('n8n/workflow-code/channel-health-check.js', 'utf8');
const embeddedHealthHelper = healthHelperSource.replace(/module\.exports = \{[\s\S]*?\};\n?/, '');

const sheet = (operation, sheetName, extra = {}) => ({
  operation,
  documentId: { __rl: true, mode: 'id', value: getExistingDocumentId() },
  sheetName: { __rl: true, mode: 'name', value: sheetName },
  options: {},
  ...extra,
});

function getExistingDocumentId() {
  if (!fs.existsSync(workflowPath)) return 'GOOGLE_SHEETS_DOCUMENT_ID';
  try {
    const existing = JSON.parse(fs.readFileSync(workflowPath, 'utf8'));
    const sheetsNode = existing.nodes?.find((node) => node.parameters?.documentId?.value);
    return sheetsNode?.parameters?.documentId?.value || 'GOOGLE_SHEETS_DOCUMENT_ID';
  } catch {
    return 'GOOGLE_SHEETS_DOCUMENT_ID';
  }
}

const codeNode = (id, name, position, jsCode) => ({
  parameters: { mode: 'runOnceForAllItems', jsCode },
  id,
  name,
  type: 'n8n-nodes-base.code',
  typeVersion: 2,
  position,
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

const openAiNode = (id, name, position) => ({
  parameters: {
    modelId: { __rl: true, mode: 'list', value: 'gpt-4o-mini', cachedResultName: 'GPT-4O-MINI' },
    responses: {
      values: [
        { role: 'system', content: '={{ $json.system_message }}' },
        { role: 'user', content: '={{ $json.user_message }}' },
      ],
    },
    builtInTools: {},
    options: {
      textFormat: {
        textOptions: {
          type: 'json_schema',
          name: 'transcript_analysis',
          schema: '={{ $json.analysis_schema }}',
          strict: true,
        },
      },
    },
  },
  id,
  name,
  type: '@n8n/n8n-nodes-langchain.openAi',
  typeVersion: 2,
  position,
  onError: 'continueRegularOutput',
});

const workflow = {
  name: 'WF5 AI Transcript Analysis',
  nodes: [
    {
      parameters: { rule: { interval: [{ field: 'hours', hoursInterval: 1 }] } },
      id: 'a1b2c3d4-0005-4000-8000-000000000001',
      name: 'Schedule Hourly',
      type: 'n8n-nodes-base.scheduleTrigger',
      typeVersion: 1.2,
      position: [0, 0],
    },
    sheetsNode('a1b2c3d4-0005-4000-8000-000000000002', 'Read Transcript_Analysis', [220, 0], sheet('read', 'Transcript_Analysis')),
    sheetsNode('a1b2c3d4-0005-4000-8000-000000000003', 'Read Source_Channels', [440, 0], sheet('read', 'Source_Channels')),
    sheetsNode('a1b2c3d4-0005-4000-8000-000000000004', 'Read Candidate_Videos', [660, 0], sheet('read', 'Candidate_Videos')),
    sheetsNode(
      'a1b2c3d4-0005-4000-8000-000000000016',
      'Read Clip_Moments',
      [880, -120],
      sheet('read', 'Clip_Moments'),
      { alwaysOutputData: true },
    ),
    codeNode('a1b2c3d4-0005-4000-8000-000000000005', 'Pick Unanalyzed', [880, 120], `${embeddedHelper}
const rows = pickUnanalyzed(
  $('Read Transcript_Analysis').all().map(i => i.json),
  $('Read Source_Channels').all().map(i => i.json),
  $('Read Candidate_Videos').all().map(i => i.json),
  5,
);
return rows.map((row, index) => ({ json: row, pairedItem: { item: index } }));`),
    codeNode('a1b2c3d4-0005-4000-8000-000000000017', 'Build Missing Window Moments', [1100, -160], `${embeddedHelper}
const rows = buildMissingWindowMoments(
  $('Read Transcript_Analysis').all().map(i => i.json),
  $('Read Source_Channels').all().map(i => i.json),
  $('Read Candidate_Videos').all().map(i => i.json),
  $('Read Clip_Moments').all().map(i => i.json),
  new Date().toISOString(),
);
return rows.map((row, index) => ({ json: row, pairedItem: { item: index } }));`),
    sheetsNode(
      'a1b2c3d4-0005-4000-8000-000000000018',
      'Backfill Clip_Moments',
      [1320, -160],
      sheet('appendOrUpdate', 'Clip_Moments', {
        columns: { mappingMode: 'autoMapInputData', value: {}, matchingColumns: ['clip_moment_id'] },
      }),
    ),
    {
      parameters: { batchSize: 1, options: {} },
      id: 'a1b2c3d4-0005-4000-8000-000000000006',
      name: 'Analysis Loop',
      type: 'n8n-nodes-base.splitInBatches',
      typeVersion: 3,
      position: [1100, 0],
    },
    codeNode('a1b2c3d4-0005-4000-8000-000000000007', 'Build OpenAI Request', [1320, 120], `${embeddedHelper}
const row = $input.first().json;
return [{ json: buildAnalysisRequest(row), pairedItem: { item: 0 } }];`),
    openAiNode('a1b2c3d4-0005-4000-8000-000000000008', 'Call OpenAI', [1540, 120]),
    codeNode('a1b2c3d4-0005-4000-8000-000000000009', 'Parse And Gate', [1760, 120], `${embeddedHelper}
const row = $('Build OpenAI Request').first().json;
const resp = $input.first().json;
let result;
try {
  result = parseAndGate(row, resp);
} catch (err) {
  throw new Error(\`AI returned unparseable JSON for \${row.video_id}: \${String(err)}\`);
}
return [{ json: result, pairedItem: { item: 0 } }];`),
    codeNode('a1b2c3d4-0005-4000-8000-000000000010', 'Shape Analysis Update', [1980, 120], `const parseResult = $input.first().json;
const sourceId = $('Build OpenAI Request').first().json.source_id || '';
return [{ json: { ...parseResult.analysisUpdate, source_id: sourceId }, pairedItem: { item: 0 } }];`),
    sheetsNode(
      'a1b2c3d4-0005-4000-8000-000000000011',
      'Update Analysis Row',
      [2200, 120],
      sheet('appendOrUpdate', 'Transcript_Analysis', {
        columns: { mappingMode: 'autoMapInputData', value: {}, matchingColumns: ['analysis_id'] },
      }),
    ),
    codeNode('a1b2c3d4-0005-4000-8000-000000000012', 'Shape Candidate Update', [2420, 120], `return [{ json: $('Parse And Gate').first().json.candidateUpdate, pairedItem: { item: 0 } }];`),
    sheetsNode(
      'a1b2c3d4-0005-4000-8000-000000000013',
      'Update Candidate Status',
      [2640, 120],
      sheet('appendOrUpdate', 'Candidate_Videos', {
        columns: { mappingMode: 'autoMapInputData', value: {}, matchingColumns: ['video_id'] },
      }),
    ),
    codeNode('a1b2c3d4-0005-4000-8000-000000000014', 'Explode Clip Moments', [2860, 20], `const rows = $('Parse And Gate').first().json.momentRows || [];
return rows.map((row, index) => ({ json: row, pairedItem: { item: index } }));`),
    sheetsNode(
      'a1b2c3d4-0005-4000-8000-000000000015',
      'Append Clip_Moments',
      [3080, 20],
      sheet('appendOrUpdate', 'Clip_Moments', {
        columns: { mappingMode: 'autoMapInputData', value: {}, matchingColumns: ['clip_moment_id'] },
      }),
    ),
    codeNode('a1b2c3d4-0005-4000-8000-000000000019', 'Channel Health Check', [2860, 320], `${embeddedHealthHelper}

const sourceId = $('Shape Analysis Update').first().json.source_id || '';
if (!sourceId) {
  return [{ json: { shouldPause: false, source_id: '', skipped: true } }];
}

const channels = $('Read Source_Channels').all().map(r => r.json);
const channelRow = channels.find(c => c.source_id === sourceId) || {};

const candidates = $('Read Candidate_Videos').all().map(r => r.json);
const sourceByVideo = {};
for (const c of candidates) {
  if (c.video_id && c.source_id) sourceByVideo[c.video_id] = c.source_id;
}

const videoId = $('Build OpenAI Request').first().json.video_id || '';
const taRows = $('Read Transcript_Analysis').all().map(r => ({
  ...r.json,
  source_id: r.json.source_id || sourceByVideo[r.json.video_id] || ''
}));

const now = new Date().toISOString();
const currentAnalysis = $('Shape Analysis Update').first().json;
const currentTARow = {
  source_id: sourceId,
  video_id: videoId,
  ai_episode_score: currentAnalysis.ai_episode_score,
  recommended_strategy: currentAnalysis.recommended_strategy,
  created_at: now,
};
const allTARows = taRows.filter(r => r.video_id !== videoId).concat([currentTARow]);

const isReEnable = detectReEnable(channelRow);
const healthResetAt = isReEnable ? now : (channelRow.health_reset_at || '');
const health = evaluateChannelHealth(sourceId, allTARows, healthResetAt);

const update = {
  source_id: sourceId,
  total_analyzed_count: health.total,
  channel_skip_rate: health.skipRate !== null ? health.skipRate : '',
};

if (isReEnable) {
  update.auto_paused_at = '';
  update.auto_paused_reason = '';
  update.health_reset_at = now;
}

if (health.shouldPause) {
  update.active_status = 'FALSE';
  update.auto_paused_at = now;
  update.auto_paused_reason = health.reason;
}

return [{ json: { ...update, shouldPause: health.shouldPause } }];`),
    sheetsNode(
      'a1b2c3d4-0005-4000-8000-000000000020',
      'Update Channel Health',
      [3080, 320],
      sheet('appendOrUpdate', 'Source_Channels', {
        columns: { mappingMode: 'autoMapInputData', value: {}, matchingColumns: ['source_id'] },
      }),
    ),
    {
      parameters: {
        conditions: {
          options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
          conditions: [{
            id: 'cond-pause-check',
            leftValue: "={{ $('Channel Health Check').first().json.shouldPause }}",
            rightValue: true,
            operator: { type: 'boolean', operation: 'true' },
          }],
          combinator: 'and',
        },
        options: {},
      },
      id: 'a1b2c3d4-0005-4000-8000-000000000021',
      name: 'IF Should Pause Channel',
      type: 'n8n-nodes-base.if',
      typeVersion: 2.2,
      position: [3300, 320],
    },
    codeNode('a1b2c3d4-0005-4000-8000-000000000022', 'Shape Candidates To Skip', [3520, 220], `
const result = $('Channel Health Check').first().json;
const sourceId = result.source_id || '';
const reason = result.auto_paused_reason || 'Channel auto-paused';

const candidates = $('Read Candidate_Videos').all().map(r => r.json);
const toSkip = candidates.filter(c =>
  c.source_id === sourceId &&
  !['DONE', 'ANALYZED', 'SKIPPED'].includes(String(c.processing_status || ''))
);

if (toSkip.length === 0) return [];

return toSkip.map((c, i) => ({
  json: {
    video_id: c.video_id,
    processing_status: 'SKIPPED',
    validity_status: 'REJECTED',
    rejection_reason: \`Channel auto-paused: \${reason}\`,
  },
  pairedItem: { item: i },
}));`),
    sheetsNode(
      'a1b2c3d4-0005-4000-8000-000000000023',
      'Bulk Skip Candidates',
      [3740, 220],
      sheet('appendOrUpdate', 'Candidate_Videos', {
        columns: { mappingMode: 'autoMapInputData', value: {}, matchingColumns: ['video_id'] },
      }),
    ),
  ],
  connections: {
    'Schedule Hourly': { main: [[{ node: 'Read Transcript_Analysis', type: 'main', index: 0 }]] },
    'Read Transcript_Analysis': { main: [[{ node: 'Read Source_Channels', type: 'main', index: 0 }]] },
    'Read Source_Channels': { main: [[{ node: 'Read Candidate_Videos', type: 'main', index: 0 }]] },
    'Read Candidate_Videos': { main: [[{ node: 'Read Clip_Moments', type: 'main', index: 0 }]] },
    'Read Clip_Moments': {
      main: [[
        { node: 'Pick Unanalyzed', type: 'main', index: 0 },
        { node: 'Build Missing Window Moments', type: 'main', index: 0 },
      ]],
    },
    'Build Missing Window Moments': { main: [[{ node: 'Backfill Clip_Moments', type: 'main', index: 0 }]] },
    'Pick Unanalyzed': { main: [[{ node: 'Analysis Loop', type: 'main', index: 0 }]] },
    'Analysis Loop': { main: [[], [{ node: 'Build OpenAI Request', type: 'main', index: 0 }]] },
    'Build OpenAI Request': { main: [[{ node: 'Call OpenAI', type: 'main', index: 0 }]] },
    'Call OpenAI': { main: [[{ node: 'Parse And Gate', type: 'main', index: 0 }]] },
    'Parse And Gate': { main: [[{ node: 'Shape Analysis Update', type: 'main', index: 0 }]] },
    'Shape Analysis Update': { main: [[{ node: 'Update Analysis Row', type: 'main', index: 0 }]] },
    'Update Analysis Row': { main: [[{ node: 'Shape Candidate Update', type: 'main', index: 0 }]] },
    'Shape Candidate Update': { main: [[{ node: 'Update Candidate Status', type: 'main', index: 0 }]] },
    'Update Candidate Status': {
      main: [[
        { node: 'Explode Clip Moments', type: 'main', index: 0 },
        { node: 'Analysis Loop', type: 'main', index: 0 },
        { node: 'Channel Health Check', type: 'main', index: 0 },
      ]],
    },
    'Explode Clip Moments': { main: [[{ node: 'Append Clip_Moments', type: 'main', index: 0 }]] },
    'Channel Health Check': { main: [[{ node: 'Update Channel Health', type: 'main', index: 0 }]] },
    'Update Channel Health': { main: [[{ node: 'IF Should Pause Channel', type: 'main', index: 0 }]] },
    'IF Should Pause Channel': {
      main: [
        [{ node: 'Shape Candidates To Skip', type: 'main', index: 0 }],
        [],
      ],
    },
    'Shape Candidates To Skip': { main: [[{ node: 'Bulk Skip Candidates', type: 'main', index: 0 }]] },
  },
  settings: { executionOrder: 'v1' },
  pinData: {},
  meta: { instanceId: 'placeholder' },
};

fs.writeFileSync(workflowPath, `${JSON.stringify(workflow, null, 2)}\n`);
