const fs = require('node:fs');
const path = require('node:path');

// Resolved from this file's location, not the working directory.
const DOMAIN_ROOT = path.join(__dirname, '..');

const workflowPath = process.argv[2] || path.join(DOMAIN_ROOT, 'workflows/04-transcript-fetch.json');
const fairShareSource = fs.readFileSync(path.join(DOMAIN_ROOT, 'workflow-code/fair-share.js'), 'utf8')
  .replace(/module\.exports = \{[\s\S]*?\};\n?/, '');

const sheet = (operation, sheetName, extra = {}) => ({
  operation,
  documentId: { __rl: true, mode: 'id', value: 'GOOGLE_SHEETS_DOCUMENT_ID' },
  sheetName: { __rl: true, mode: 'name', value: sheetName },
  options: {},
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

const sheetsNode = (id, name, position, parameters, extra = {}) => ({
  parameters,
  id,
  name,
  type: 'n8n-nodes-base.googleSheets',
  typeVersion: 4.5,
  position,
  retryOnFail: true,
  maxTries: 3,
  waitBetweenTries: 5000,
  ...(parameters.operation === 'read' ? { executeOnce: true } : {}),
  ...extra,
});

const waitNode = (id, name, position) => ({
  parameters: { amount: 3 },
  id,
  name,
  type: 'n8n-nodes-base.wait',
  typeVersion: 1.1,
  position,
});

const node = (id, name, type, typeVersion, position, parameters, extra = {}) => ({
  parameters,
  id,
  name,
  type,
  typeVersion,
  position,
  ...extra,
});

const workflow = {
  name: 'WF4 Transcript Fetch',
  description: 'Fetches timestamped transcripts for valid candidates and persists both analysis rows and full transcript files. It separates provider failures from content failures so infrastructure issues remain retryable.',
  nodes: [
    {
      parameters: { rule: { interval: [{ field: 'hours', hoursInterval: 1 }] } },
      id: 'a1b2c3d4-0004-4000-8000-000000000001',
      name: 'Schedule Hourly',
      type: 'n8n-nodes-base.scheduleTrigger',
      typeVersion: 1.2,
      position: [0, 0],
    },
    sheetsNode('a1b2c3d4-0004-4000-8000-000000000002', 'Read Candidate_Videos', [220, 0], sheet('read', 'Candidate_Videos')),
    codeNode('a1b2c3d4-0004-4000-8000-000000000003', 'Pick Pending Transcripts', [440, 0], `${fairShareSource}
const eligible = $input.all()
  .filter(i => String(i.json.validity_status) === 'VALID'
            && String(i.json.transcript_available || '') === '')
  .map(i => i.json);
const pending = pickFairByGroup(eligible, {
  limit: 10,
  perSourceLimit: 2,
  groupKey: 'niche',
  sourceKey: 'source_id',
  sourceFallbackKeys: ['niche'],
  sortKey: 'created_at',
});
return pending.map((row, idx) => ({ json: row, pairedItem: { item: idx } }));`),
    {
      parameters: { batchSize: 1, options: {} },
      id: 'a1b2c3d4-0004-4000-8000-000000000004',
      name: 'Video Loop',
      type: 'n8n-nodes-base.splitInBatches',
      typeVersion: 3,
      position: [660, 0],
    },
    {
      parameters: {
        method: 'POST',
        url: 'TRANSCRIPT_SERVICE_URL',
        authentication: 'genericCredentialType',
        genericAuthType: 'httpHeaderAuth',
        sendBody: true,
        specifyBody: 'json',
        jsonBody: "={{ JSON.stringify({ youtube_url: $json.video_url, language_preferences: ['en','en-US','en-GB','sw'] }) }}",
        options: { timeout: 60000 },
      },
      id: 'a1b2c3d4-0004-4000-8000-000000000005',
      name: 'Call Transcript Service',
      type: 'n8n-nodes-base.httpRequest',
      typeVersion: 4.2,
      position: [880, 120],
      retryOnFail: true,
      maxTries: 3,
      waitBetweenTries: 5000,
      onError: 'continueRegularOutput',
    },
    {
      parameters: {
        conditions: {
          options: { caseSensitive: true, typeValidation: 'loose' },
          conditions: [
            {
              leftValue: '={{ $json.success }}',
              rightValue: true,
              operator: { type: 'boolean', operation: 'equals' },
            },
          ],
          combinator: 'and',
        },
      },
      id: 'a1b2c3d4-0004-4000-8000-000000000006',
      name: 'Route On Success',
      type: 'n8n-nodes-base.if',
      typeVersion: 2,
      position: [1100, 120],
    },
    codeNode('a1b2c3d4-0004-4000-8000-000000000007', 'Build Analysis Row', [1320, 20], `const video = $('Video Loop').first().json;
const resp = $input.first().json;
const snippets = resp.transcript || [];

const lines = snippets.map(s => {
  const t = Math.floor(Number(s.start) || 0);
  const mm = String(Math.floor(t / 60)).padStart(2, '0');
  const ss = String(t % 60).padStart(2, '0');
  return \`[\${mm}:\${ss}] \${s.text}\`;
});
const transcriptFull = lines.join('\\n');
let transcriptText = transcriptFull;
const LIMIT = 45000;
if (transcriptFull.length > LIMIT) {
  transcriptText = transcriptFull.slice(0, LIMIT) + '\\n...[TRUNCATED]';
}
const words = (resp.plain_text || '').split(/\\s+/).filter(Boolean).length;

return [{
  json: {
    analysis_id: \`AN-\${video.youtube_video_id}\`,
    video_id: video.video_id,
    niche: video.niche,
    video_title: video.video_title,
    video_url: video.video_url,
    transcript_status: 'FETCHED',
    transcript_text: transcriptText,
    transcript_full: transcriptFull,
    transcript_full_url: '',
    transcript_full_file_id: '',
    transcript_length_words: words,
    ai_episode_score: '',
    recommended_strategy: '',
    recommended_start_sec: '',
    recommended_end_sec: '',
    reason_for_strategy: '',
    rights_risk: '',
    permission_risk: '',
    monetization_risk: '',
    originality_potential: '',
    kenya_relevance: '',
    ai_json_output: '',
    created_at: new Date().toISOString(),
  },
  pairedItem: { item: 0 },
}];`),
    node(
      'a1b2c3d4-0004-4000-8000-000000000015',
      'Convert Transcript To File',
      'n8n-nodes-base.convertToFile',
      1.1,
      [1540, 20],
      {
        operation: 'toText',
        sourceProperty: 'transcript_full',
        binaryPropertyName: 'data',
        options: {
          fileName: '={{ $json.analysis_id }}.txt',
        },
      },
    ),
    node(
      'a1b2c3d4-0004-4000-8000-000000000016',
      'Upload Transcript To Drive',
      'n8n-nodes-base.googleDrive',
      3,
      [1760, 20],
      {
        resource: 'file',
        operation: 'upload',
        name: '={{ $("Build Analysis Row").first().json.analysis_id }}.txt',
        driveId: { __rl: true, mode: 'list', value: 'My Drive' },
        folderId: { __rl: true, mode: 'id', value: 'TRANSCRIPTS_DRIVE_FOLDER_ID' },
        inputDataFieldName: 'data',
        options: {},
      },
      { onError: 'continueRegularOutput' },
    ),
    codeNode('a1b2c3d4-0004-4000-8000-000000000017', 'Attach Transcript URL', [1980, 20], `const row = { ...$('Build Analysis Row').first().json };
const drive = $input.first().json || {};
row.transcript_full_file_id = drive.id || '';
row.transcript_full_url = drive.webViewLink || (drive.id ? \`https://drive.google.com/file/d/\${drive.id}/view\` : '');
delete row.transcript_full;
return [{ json: row, pairedItem: { item: 0 } }];`),
    sheetsNode(
      'a1b2c3d4-0004-4000-8000-000000000008',
      'Append Transcript_Analysis',
      [2200, 20],
      sheet('appendOrUpdate', 'Transcript_Analysis', {
        columns: { mappingMode: 'autoMapInputData', value: {}, matchingColumns: ['analysis_id'] },
      }),
    ),
    codeNode('a1b2c3d4-0004-4000-8000-000000000009', 'Mark Transcript OK', [2420, 20], `const video = $('Video Loop').first().json;
const resp = $('Call Transcript Service').first().json;
return [{ json: {
  video_id: video.video_id,
  transcript_available: 'TRUE',
  language: resp.language_code || video.language,
}, pairedItem: { item: 0 } }];`),
    sheetsNode(
      'a1b2c3d4-0004-4000-8000-000000000010',
      'Update Candidate OK',
      [2640, 20],
      sheet('appendOrUpdate', 'Candidate_Videos', {
        columns: { mappingMode: 'autoMapInputData', value: {}, matchingColumns: ['video_id'] },
      }),
    ),
    waitNode('a1b2c3d4-0004-4000-8000-000000000011', 'Wait 3s', [2860, 20]),
    codeNode('a1b2c3d4-0004-4000-8000-000000000012', 'Mark Transcript Failed', [1320, 220], `const video = $('Video Loop').first().json;
const resp = $input.first().json;
const code = resp.error_code || (resp.error ? 'HTTP_ERROR' : 'UNKNOWN');
const infra = code === 'IP_BLOCKED' || code === 'FETCH_FAILED' || code === 'HTTP_ERROR';
return [{ json: {
  video_id: video.video_id,
  transcript_available: infra ? '' : 'FALSE',
  validity_status: infra ? video.validity_status : 'REJECTED',
  rejection_reason: infra ? '' : \`TRANSCRIPT_\${code}\`,
  processing_status: infra ? video.processing_status : 'SKIPPED',
}, pairedItem: { item: 0 } }];`),
    sheetsNode(
      'a1b2c3d4-0004-4000-8000-000000000013',
      'Update Candidate Failed',
      [1540, 220],
      sheet('appendOrUpdate', 'Candidate_Videos', {
        columns: { mappingMode: 'autoMapInputData', value: {}, matchingColumns: ['video_id'] },
      }),
    ),
    waitNode('a1b2c3d4-0004-4000-8000-000000000014', 'Wait 3s b', [1760, 220]),
  ],
  connections: {
    'Schedule Hourly': { main: [[{ node: 'Read Candidate_Videos', type: 'main', index: 0 }]] },
    'Read Candidate_Videos': { main: [[{ node: 'Pick Pending Transcripts', type: 'main', index: 0 }]] },
    'Pick Pending Transcripts': { main: [[{ node: 'Video Loop', type: 'main', index: 0 }]] },
    'Video Loop': { main: [[], [{ node: 'Call Transcript Service', type: 'main', index: 0 }]] },
    'Call Transcript Service': { main: [[{ node: 'Route On Success', type: 'main', index: 0 }]] },
    'Route On Success': {
      main: [
        [{ node: 'Build Analysis Row', type: 'main', index: 0 }],
        [{ node: 'Mark Transcript Failed', type: 'main', index: 0 }],
      ],
    },
    'Build Analysis Row': { main: [[{ node: 'Convert Transcript To File', type: 'main', index: 0 }]] },
    'Convert Transcript To File': { main: [[{ node: 'Upload Transcript To Drive', type: 'main', index: 0 }]] },
    'Upload Transcript To Drive': { main: [[{ node: 'Attach Transcript URL', type: 'main', index: 0 }]] },
    'Attach Transcript URL': { main: [[{ node: 'Append Transcript_Analysis', type: 'main', index: 0 }]] },
    'Append Transcript_Analysis': { main: [[{ node: 'Mark Transcript OK', type: 'main', index: 0 }]] },
    'Mark Transcript OK': { main: [[{ node: 'Update Candidate OK', type: 'main', index: 0 }]] },
    'Update Candidate OK': { main: [[{ node: 'Wait 3s', type: 'main', index: 0 }]] },
    'Wait 3s': { main: [[{ node: 'Video Loop', type: 'main', index: 0 }]] },
    'Mark Transcript Failed': { main: [[{ node: 'Update Candidate Failed', type: 'main', index: 0 }]] },
    'Update Candidate Failed': { main: [[{ node: 'Wait 3s b', type: 'main', index: 0 }]] },
    'Wait 3s b': { main: [[{ node: 'Video Loop', type: 'main', index: 0 }]] },
  },
  settings: { executionOrder: 'v1' },
  pinData: {},
  meta: { instanceId: 'placeholder' },
};

fs.writeFileSync(workflowPath, `${JSON.stringify(workflow, null, 2)}\n`);
