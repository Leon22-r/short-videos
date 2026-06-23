const fs = require('node:fs');

const helper = (name) => fs.readFileSync(`n8n/workflow-code/${name}.js`, 'utf8').replace(/module\.exports = \{[\s\S]*?\};\n?/, '');

const sheet = (operation, sheetName, extra = {}) => ({
  operation,
  documentId: { __rl: true, mode: 'id', value: getExistingDocumentId() },
  sheetName: { __rl: true, mode: 'name', value: sheetName },
  options: {},
  ...extra,
});

function getExistingDocumentId() {
  for (const workflowPath of [
    'n8n/workflows/05-ai-transcript-analysis.json',
    'n8n/workflows/04-transcript-fetch.json',
    'n8n/workflows/01-source-channel-registry.json',
  ]) {
    if (!fs.existsSync(workflowPath)) continue;
    try {
      const existing = JSON.parse(fs.readFileSync(workflowPath, 'utf8'));
      const sheetsNode = existing.nodes?.find((candidate) => candidate.parameters?.documentId?.value);
      if (sheetsNode?.parameters?.documentId?.value) return sheetsNode.parameters.documentId.value;
    } catch {}
  }
  return 'GOOGLE_SHEETS_DOCUMENT_ID';
}

const node = (id, name, type, typeVersion, position, parameters = {}, extra = {}) => ({
  id,
  name,
  type,
  typeVersion,
  position,
  parameters,
  ...extra,
});

const codeNode = (id, name, position, jsCode) => node(id, name, 'n8n-nodes-base.code', 2, position, { mode: 'runOnceForAllItems', jsCode });

const sheetsNode = (id, name, position, parameters, extra = {}) => node(
  id,
  name,
  'n8n-nodes-base.googleSheets',
  4.5,
  position,
  parameters,
  { ...(parameters.operation === 'read' ? { executeOnce: true } : {}), ...extra },
);

const httpNode = (id, name, position, parameters, extra = {}) => node(id, name, 'n8n-nodes-base.httpRequest', 4.2, position, parameters, extra);

const openAiNode = (id, name, position) => node(
  id,
  name,
  '@n8n/n8n-nodes-langchain.openAi',
  2,
  position,
  {
    modelId: { __rl: true, mode: 'list', value: 'gpt-4o-mini', cachedResultName: 'GPT-4O-MINI' },
    responses: {
      values: [
        { role: 'system', content: '={{ $json.system_message }}' },
        { role: 'user', content: '={{ $json.user_message }}' },
        {},
      ],
    },
    builtInTools: {},
    options: {},
  },
);

const ifNode = (id, name, position, leftValue, rightValue, type, operation) => node(
  id,
  name,
  'n8n-nodes-base.if',
  2,
  position,
  {
    conditions: {
      options: { caseSensitive: true, typeValidation: 'loose' },
      conditions: [{ leftValue, rightValue, operator: { type, operation, singleValue: true } }],
      combinator: 'and',
    },
  },
);

function writeWorkflow(file, workflow) {
  fs.writeFileSync(file, `${JSON.stringify({
    ...workflow,
    settings: { executionOrder: 'v1', ...(workflow.settings || {}) },
    pinData: {},
    meta: { instanceId: 'placeholder' },
  }, null, 2)}\n`);
}

function wf6() {
  const h = helper('ssemble-dispatch');
  writeWorkflow('n8n/workflows/06-ssemble-dispatch.json', {
    name: 'WF6 Ssemble Dispatch',
    nodes: [
      node('wf6-001', 'Schedule 2h', 'n8n-nodes-base.scheduleTrigger', 1.2, [0, 0], { rule: { interval: [{ field: 'hours', hoursInterval: 2 }] } }),
      sheetsNode('wf6-002', 'Read Clip_Moments', [220, 0], sheet('read', 'Clip_Moments')),
      sheetsNode('wf6-003', 'Read Ssemble_Jobs', [440, 0], sheet('read', 'Ssemble_Jobs'), { alwaysOutputData: true }),
      codeNode('wf6-004', 'Plan Requests', [660, 0], `${h}
const requests = planSsembleRequests(
  $('Read Clip_Moments').all().map(i => i.json),
  $('Read Ssemble_Jobs').all().map(i => i.json),
  { dailyBudget: 10, webhookUrl: 'https://YOUR_N8N_DOMAIN/webhook/ssemble-callback?secret=SSEMBLE_WEBHOOK_SECRET' },
);
return requests.map((request, index) => ({ json: request, pairedItem: { item: index } }));`),
      node('wf6-005', 'Dispatch Loop', 'n8n-nodes-base.splitInBatches', 3, [880, 0], { batchSize: 1, options: {} }),
      codeNode('wf6-006', 'Build Reservation Row', [1100, 120], `${h}
const req = $('Dispatch Loop').first().json;
return [{ json: buildReservationRow(req), pairedItem: { item: 0 } }];`),
      sheetsNode('wf6-007', 'Reserve Ssemble Job', [1320, 120], sheet('appendOrUpdate', 'Ssemble_Jobs', { columns: { mappingMode: 'autoMapInputData', value: {}, matchingColumns: ['clip_moment_id'] } })),
      httpNode('wf6-008', 'Call Ssemble Create', [1540, 120], {
        method: 'POST',
        url: 'https://aiclipping.ssemble.com/api/v1/shorts/create',
        authentication: 'genericCredentialType',
        genericAuthType: 'httpHeaderAuth',
        sendBody: true,
        specifyBody: 'json',
        jsonBody: '={{ $("Dispatch Loop").first().json.ssemble_body }}',
        options: { timeout: 60000 },
      }, { onError: 'continueRegularOutput' }),
      ifNode('wf6-009', 'Route On Created', [1760, 120], '={{ $json.data && $json.data.requestId }}', '', 'string', 'notEmpty'),
      codeNode('wf6-010', 'Build Submitted Job Update', [1980, 40], `${h}
const req = $('Dispatch Loop').first().json;
const resp = $input.first().json;
return [{ json: buildSubmittedJobUpdate(req, resp), pairedItem: { item: 0 } }];`),
      sheetsNode('wf6-011', 'Update Reservation Submitted', [2200, 40], sheet('appendOrUpdate', 'Ssemble_Jobs', { columns: { mappingMode: 'autoMapInputData', value: {}, matchingColumns: ['clip_moment_id'] } })),
      codeNode('wf6-012', 'Mark Moment Submitted', [2420, 40], `${h}
const req = $('Dispatch Loop').first().json;
const job = $('Build Submitted Job Update').first().json;
return [{ json: buildMomentStatus(req, 'SUBMITTED', job.ssemble_job_id), pairedItem: { item: 0 } }];`),
      sheetsNode('wf6-013', 'Update Moment Submitted', [2640, 40], sheet('appendOrUpdate', 'Clip_Moments', { columns: { mappingMode: 'autoMapInputData', value: {}, matchingColumns: ['clip_moment_id'] } })),
      codeNode('wf6-014', 'Build Submit Failed Job Update', [1980, 220], `${h}
const req = $('Dispatch Loop').first().json;
const resp = $input.first().json;
return [{ json: buildSubmitFailedJobUpdate(req, resp), pairedItem: { item: 0 } }];`),
      sheetsNode('wf6-015', 'Update Reservation Failed', [2200, 220], sheet('appendOrUpdate', 'Ssemble_Jobs', { columns: { mappingMode: 'autoMapInputData', value: {}, matchingColumns: ['clip_moment_id'] } })),
      codeNode('wf6-016', 'Mark Moment Error', [2420, 220], `${h}
const req = $('Dispatch Loop').first().json;
return [{ json: buildMomentStatus(req, 'ERROR'), pairedItem: { item: 0 } }];`),
      sheetsNode('wf6-017', 'Update Moment Error', [2640, 220], sheet('appendOrUpdate', 'Clip_Moments', { columns: { mappingMode: 'autoMapInputData', value: {}, matchingColumns: ['clip_moment_id'] } })),
      node('wf6-018', 'Wait 5s', 'n8n-nodes-base.wait', 1.1, [2860, 40], { amount: 5 }),
      node('wf6-019', 'Wait 5s b', 'n8n-nodes-base.wait', 1.1, [2860, 220], { amount: 5 }),
    ],
    connections: {
      'Schedule 2h': { main: [[{ node: 'Read Clip_Moments', type: 'main', index: 0 }]] },
      'Read Clip_Moments': { main: [[{ node: 'Read Ssemble_Jobs', type: 'main', index: 0 }]] },
      'Read Ssemble_Jobs': { main: [[{ node: 'Plan Requests', type: 'main', index: 0 }]] },
      'Plan Requests': { main: [[{ node: 'Dispatch Loop', type: 'main', index: 0 }]] },
      'Dispatch Loop': { main: [[], [{ node: 'Build Reservation Row', type: 'main', index: 0 }]] },
      'Build Reservation Row': { main: [[{ node: 'Reserve Ssemble Job', type: 'main', index: 0 }]] },
      'Reserve Ssemble Job': { main: [[{ node: 'Call Ssemble Create', type: 'main', index: 0 }]] },
      'Call Ssemble Create': { main: [[{ node: 'Route On Created', type: 'main', index: 0 }]] },
      'Route On Created': { main: [[{ node: 'Build Submitted Job Update', type: 'main', index: 0 }], [{ node: 'Build Submit Failed Job Update', type: 'main', index: 0 }]] },
      'Build Submitted Job Update': { main: [[{ node: 'Update Reservation Submitted', type: 'main', index: 0 }]] },
      'Update Reservation Submitted': { main: [[{ node: 'Mark Moment Submitted', type: 'main', index: 0 }]] },
      'Mark Moment Submitted': { main: [[{ node: 'Update Moment Submitted', type: 'main', index: 0 }]] },
      'Update Moment Submitted': { main: [[{ node: 'Wait 5s', type: 'main', index: 0 }]] },
      'Wait 5s': { main: [[{ node: 'Dispatch Loop', type: 'main', index: 0 }]] },
      'Build Submit Failed Job Update': { main: [[{ node: 'Update Reservation Failed', type: 'main', index: 0 }]] },
      'Update Reservation Failed': { main: [[{ node: 'Mark Moment Error', type: 'main', index: 0 }]] },
      'Mark Moment Error': { main: [[{ node: 'Update Moment Error', type: 'main', index: 0 }]] },
      'Update Moment Error': { main: [[{ node: 'Wait 5s b', type: 'main', index: 0 }]] },
      'Wait 5s b': { main: [[{ node: 'Dispatch Loop', type: 'main', index: 0 }]] },
    },
  });
}

function wf7() {
  const h = helper('ssemble-webhook');
  writeWorkflow('n8n/workflows/07-ssemble-webhook-receiver.json', {
    name: 'WF7 Ssemble Webhook Receiver',
    nodes: [
      node('wf7-001', 'Webhook', 'n8n-nodes-base.webhook', 2, [0, 0], { httpMethod: 'POST', path: 'ssemble-callback', responseMode: 'onReceived', options: {} }),
      codeNode('wf7-002', 'Verify And Parse', [220, 0], `${h}
const input = $input.first().json;
return [{ json: verifyAndParseWebhook(input), pairedItem: { item: 0 } }];`),
      sheetsNode('wf7-003', 'Read Ssemble_Jobs', [440, 0], sheet('read', 'Ssemble_Jobs'), { alwaysOutputData: true }),
      codeNode('wf7-004', 'Attach Moment', [660, 0], `${h}
const parsed = $('Verify And Parse').first().json;
const jobs = $('Read Ssemble_Jobs').all().map(i => i.json);
return [{ json: attachMoment(parsed, jobs), pairedItem: { item: 0 } }];`),
      ifNode('wf7-005', 'Route On Completed', [880, 0], '={{ $json.completed }}', true, 'boolean', 'equals'),
      codeNode('wf7-006', 'Shape Job Completed', [1100, -100], `${h}
return [{ json: shapeJobCompleted($input.first().json), pairedItem: { item: 0 } }];`),
      sheetsNode('wf7-007', 'Update Job Completed', [1320, -100], sheet('appendOrUpdate', 'Ssemble_Jobs', { columns: { mappingMode: 'autoMapInputData', value: {}, matchingColumns: ['ssemble_job_id'] } })),
      codeNode('wf7-008', 'Shape Moment Completed', [1540, -100], `${h}
const data = $('Attach Moment').first().json;
return [{ json: shapeMomentStatus(data, 'COMPLETED'), pairedItem: { item: 0 } }];`),
      sheetsNode('wf7-009', 'Update Moment Completed', [1760, -100], sheet('appendOrUpdate', 'Clip_Moments', { columns: { mappingMode: 'autoMapInputData', value: {}, matchingColumns: ['clip_moment_id'] } })),
      codeNode('wf7-010', 'Explode Shorts', [1980, -100], `${h}
const rows = explodeCreatedClips($('Attach Moment').first().json);
return rows.map((row, index) => ({ json: row, pairedItem: { item: index } }));`),
      sheetsNode('wf7-011', 'Append Created_Clips', [2200, -100], sheet('appendOrUpdate', 'Created_Clips', { columns: { mappingMode: 'autoMapInputData', value: {}, matchingColumns: ['created_clip_id'] } })),
      codeNode('wf7-012', 'Shape Job Failed', [1100, 120], `${h}
return [{ json: shapeJobFailed($input.first().json), pairedItem: { item: 0 } }];`),
      sheetsNode('wf7-013', 'Update Job Failed', [1320, 120], sheet('appendOrUpdate', 'Ssemble_Jobs', { columns: { mappingMode: 'autoMapInputData', value: {}, matchingColumns: ['ssemble_job_id'] } })),
      codeNode('wf7-014', 'Shape Moment Failed', [1540, 120], `${h}
const data = $('Attach Moment').first().json;
return [{ json: shapeMomentStatus(data, 'ERROR'), pairedItem: { item: 0 } }];`),
      sheetsNode('wf7-015', 'Update Moment Failed', [1760, 120], sheet('appendOrUpdate', 'Clip_Moments', { columns: { mappingMode: 'autoMapInputData', value: {}, matchingColumns: ['clip_moment_id'] } })),
    ],
    connections: {
      Webhook: { main: [[{ node: 'Verify And Parse', type: 'main', index: 0 }]] },
      'Verify And Parse': { main: [[{ node: 'Read Ssemble_Jobs', type: 'main', index: 0 }]] },
      'Read Ssemble_Jobs': { main: [[{ node: 'Attach Moment', type: 'main', index: 0 }]] },
      'Attach Moment': { main: [[{ node: 'Route On Completed', type: 'main', index: 0 }]] },
      'Route On Completed': { main: [[{ node: 'Shape Job Completed', type: 'main', index: 0 }], [{ node: 'Shape Job Failed', type: 'main', index: 0 }]] },
      'Shape Job Completed': { main: [[{ node: 'Update Job Completed', type: 'main', index: 0 }]] },
      'Update Job Completed': { main: [[{ node: 'Shape Moment Completed', type: 'main', index: 0 }]] },
      'Shape Moment Completed': { main: [[{ node: 'Update Moment Completed', type: 'main', index: 0 }]] },
      'Update Moment Completed': { main: [[{ node: 'Explode Shorts', type: 'main', index: 0 }]] },
      'Explode Shorts': { main: [[{ node: 'Append Created_Clips', type: 'main', index: 0 }]] },
      'Shape Job Failed': { main: [[{ node: 'Update Job Failed', type: 'main', index: 0 }]] },
      'Update Job Failed': { main: [[{ node: 'Shape Moment Failed', type: 'main', index: 0 }]] },
      'Shape Moment Failed': { main: [[{ node: 'Update Moment Failed', type: 'main', index: 0 }]] },
    },
  });
}

function wf8() {
  const h = helper('drive-storage-transform');
  const folders = `{
  CHRISTIAN_CONTENT: 'GOOGLE_DRIVE_FOLDER_CHRISTIAN_CONTENT',
  MOTIVATION_DISCIPLINE: 'GOOGLE_DRIVE_FOLDER_MOTIVATION_DISCIPLINE',
  FINANCE_BUSINESS: 'GOOGLE_DRIVE_FOLDER_FINANCE_BUSINESS',
  LIFE_VALUES_RELATIONSHIPS: 'GOOGLE_DRIVE_FOLDER_LIFE_VALUES_RELATIONSHIPS',
  AFRICAN_KENYAN_SUCCESS: 'GOOGLE_DRIVE_FOLDER_AFRICAN_KENYAN_SUCCESS',
}`;
  writeWorkflow('n8n/workflows/08-drive-storage-transform.json', {
    name: 'WF8 Drive Storage Transform',
    nodes: [
      node('wf8-001', 'Schedule 30m', 'n8n-nodes-base.scheduleTrigger', 1.2, [0, 0], { rule: { interval: [{ field: 'minutes', minutesInterval: 30 }] } }),
      sheetsNode('wf8-002', 'Read Created_Clips', [220, 0], sheet('read', 'Created_Clips')),
      sheetsNode('wf8-003', 'Read Ssemble_Jobs', [440, 0], sheet('read', 'Ssemble_Jobs'), { alwaysOutputData: true }),
      sheetsNode('wf8-004', 'Read Clip_Moments', [660, 0], sheet('read', 'Clip_Moments'), { alwaysOutputData: true }),
      codeNode('wf8-005', 'Pick Awaiting Download', [880, 0], `${h}
const rows = pickAwaitingDownloads(
  $('Read Created_Clips').all().map(i => i.json),
  $('Read Ssemble_Jobs').all().map(i => i.json),
  $('Read Clip_Moments').all().map(i => i.json),
  ${folders},
);
return rows.map((row, index) => ({ json: row, pairedItem: { item: index } }));`),
      node('wf8-006', 'Clip Loop', 'n8n-nodes-base.splitInBatches', 3, [1100, 0], { batchSize: 1, options: {} }),
      ifNode('wf8-007', 'Already Uploaded?', [1320, 120], '={{ $json.google_drive_file_id }}', '', 'string', 'notEmpty'),
      httpNode('wf8-008', 'Download Clip', [1540, 220], { method: 'GET', url: '={{ $json.clip_url }}', options: { timeout: 300000, response: { response: { responseFormat: 'file', outputPropertyName: 'data' } } } }),
      node('wf8-009', 'Upload To Drive', 'n8n-nodes-base.googleDrive', 3, [1760, 220], { resource: 'file', operation: 'upload', name: '={{ $("Clip Loop").first().json.file_name }}', driveId: { __rl: true, mode: 'list', value: 'My Drive' }, folderId: { __rl: true, mode: 'id', value: '={{ $("Clip Loop").first().json.drive_folder_id }}' }, inputDataFieldName: 'data', options: {} }),
      codeNode('wf8-010', 'Shape Drive Ids', [1980, 220], `${h}
const clip = $('Clip Loop').first().json;
const drive = $input.first().json;
return [{ json: buildDriveIdUpdate(clip, drive), pairedItem: { item: 0 } }];`),
      sheetsNode('wf8-011', 'Save Drive Ids', [2200, 220], sheet('appendOrUpdate', 'Created_Clips', { columns: { mappingMode: 'autoMapInputData', value: {}, matchingColumns: ['created_clip_id'] } })),
      codeNode('wf8-012', 'Build Planner Request', [2420, 120], `${h}
const clip = { ...$('Clip Loop').first().json };
try {
  const saved = $('Shape Drive Ids').first().json;
  clip.google_drive_file_id = clip.google_drive_file_id || saved.google_drive_file_id;
  clip.google_drive_url = clip.google_drive_url || saved.google_drive_url;
} catch (error) {}
return [{ json: buildPlannerRequest(clip), pairedItem: { item: 0 } }];`),
      openAiNode('wf8-013', 'Call OpenAI Planner', [2640, 120]),
      codeNode('wf8-014', 'Parse Plan', [2860, 120], `${h}
const meta = $('Build Planner Request').first().json;
const resp = $input.first().json;
return [{ json: parseTransformationPlan(meta, resp), pairedItem: { item: 0 } }];`),
      sheetsNode('wf8-015', 'Update Created Clip', [3080, 120], sheet('appendOrUpdate', 'Created_Clips', { columns: { mappingMode: 'autoMapInputData', value: {}, matchingColumns: ['created_clip_id'] } })),
    ],
    connections: {
      'Schedule 30m': { main: [[{ node: 'Read Created_Clips', type: 'main', index: 0 }]] },
      'Read Created_Clips': { main: [[{ node: 'Read Ssemble_Jobs', type: 'main', index: 0 }]] },
      'Read Ssemble_Jobs': { main: [[{ node: 'Read Clip_Moments', type: 'main', index: 0 }]] },
      'Read Clip_Moments': { main: [[{ node: 'Pick Awaiting Download', type: 'main', index: 0 }]] },
      'Pick Awaiting Download': { main: [[{ node: 'Clip Loop', type: 'main', index: 0 }]] },
      'Clip Loop': { main: [[], [{ node: 'Already Uploaded?', type: 'main', index: 0 }]] },
      'Already Uploaded?': { main: [[{ node: 'Build Planner Request', type: 'main', index: 0 }], [{ node: 'Download Clip', type: 'main', index: 0 }]] },
      'Download Clip': { main: [[{ node: 'Upload To Drive', type: 'main', index: 0 }]] },
      'Upload To Drive': { main: [[{ node: 'Shape Drive Ids', type: 'main', index: 0 }]] },
      'Shape Drive Ids': { main: [[{ node: 'Save Drive Ids', type: 'main', index: 0 }]] },
      'Save Drive Ids': { main: [[{ node: 'Build Planner Request', type: 'main', index: 0 }]] },
      'Build Planner Request': { main: [[{ node: 'Call OpenAI Planner', type: 'main', index: 0 }]] },
      'Call OpenAI Planner': { main: [[{ node: 'Parse Plan', type: 'main', index: 0 }]] },
      'Parse Plan': { main: [[{ node: 'Update Created Clip', type: 'main', index: 0 }]] },
      'Update Created Clip': { main: [[{ node: 'Clip Loop', type: 'main', index: 0 }]] },
    },
  });
}

function wf9() {
  const h = helper('review-queue-digest');
  writeWorkflow('n8n/workflows/09-review-queue-digest.json', {
    name: 'WF9 Review Queue Digest',
    settings: { timezone: 'Africa/Nairobi' },
    nodes: [
      node('wf9-001', 'Schedule Daily', 'n8n-nodes-base.scheduleTrigger', 1.2, [0, 0], { rule: { interval: [{ field: 'cronExpression', expression: '0 8 * * *' }] } }),
      sheetsNode('wf9-005', 'Read Source_Channels', [220, 0], sheet('read', 'Source_Channels')),
      sheetsNode('wf9-002', 'Read Created_Clips', [440, 0], sheet('read', 'Created_Clips')),
      codeNode('wf9-003', 'Build Digest', [660, 0], `${h}
const channels = $('Read Source_Channels').all().map(i => i.json);
const digest = buildReviewDigest($input.all().map(i => i.json), channels);
if (!digest) return [];
return [{ json: digest, pairedItem: { item: 0 } }];`),
      node('wf9-004', 'Send Digest', 'n8n-nodes-base.gmail', 2.1, [880, 0], { resource: 'message', operation: 'send', sendTo: 'njihialeon00@gmail.com', subject: '={{ $json.subject }}', message: '={{ $json.html }}', options: {} }),
    ],
    connections: {
      'Schedule Daily': { main: [[{ node: 'Read Source_Channels', type: 'main', index: 0 }]] },
      'Read Source_Channels': { main: [[{ node: 'Read Created_Clips', type: 'main', index: 0 }]] },
      'Read Created_Clips': { main: [[{ node: 'Build Digest', type: 'main', index: 0 }]] },
      'Build Digest': { main: [[{ node: 'Send Digest', type: 'main', index: 0 }]] },
    },
  });
}

wf6();
wf7();
wf8();
wf9();
