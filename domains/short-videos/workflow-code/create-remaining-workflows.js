const fs = require('node:fs');
const path = require('node:path');

// Resolved from this file's location, not the working directory, so the
// generators run from anywhere and survive the next directory move.
const DOMAIN_ROOT = path.join(__dirname, '..');

const WORKFLOW_OUTPUT_DIR = process.env.N8N_WORKFLOW_OUTPUT_DIR || path.join(DOMAIN_ROOT, 'workflows');
// Every item the node received, as a jsonb array in $1.
const ROWS = '={{ JSON.stringify($input.all().map(item => item.json)) }}';

const postgresSql = (name) => fs.readFileSync(path.join(DOMAIN_ROOT, 'postgres/queries', `${name}.sql`), 'utf8').trim();

const helper = (name) => {
  const source = fs.readFileSync(path.join(DOMAIN_ROOT, 'workflow-code', `${name}.js`), 'utf8');
  const stripped = source
    .replace(/const \{[^}]*pickFairBy(?:Source|Group)[^}]*\} = require\('\.\/fair-share'\);\n\n/, '')
    .replace(/module\.exports = \{[\s\S]*?\};\n?/, '');
  if (!source.includes("require('./fair-share')")) return stripped;

  const fairShare = fs.readFileSync(path.join(DOMAIN_ROOT, 'workflow-code/fair-share.js'), 'utf8')
    .replace(/module\.exports = \{[\s\S]*?\};\n?/, '');
  return `${fairShare}\n${stripped}`;
};

const sheet = (operation, sheetName, extra = {}) => ({
  operation,
  documentId: { __rl: true, mode: 'id', value: 'GOOGLE_SHEETS_DOCUMENT_ID' },
  sheetName: { __rl: true, mode: 'name', value: sheetName },
  options: {},
  ...extra,
});

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
const fallibleCodeNode = (id, name, position, jsCode) => node(
  id,
  name,
  'n8n-nodes-base.code',
  2,
  position,
  { mode: 'runOnceForAllItems', jsCode },
  { onError: 'continueErrorOutput' },
);

const redactProviderStateCode = `return $input.all().map((item, index) => {
  const json = { ...item.json };
  delete json.provider_upload_url;
  delete json.provider_response;
  delete json.payload;
  delete json.public_video_url;
  delete json.local_file_path;
  delete json.postiz_media_path;
  delete json.postiz_submit_payload;
  return { json, pairedItem: { item: index } };
});`;

const sheetsNode = (id, name, position, parameters, extra = {}) => node(
  id,
  name,
  'n8n-nodes-base.googleSheets',
  4.5,
  position,
  parameters,
  {
    ...(parameters.operation === 'read' ? { executeOnce: true } : {}),
    retryOnFail: true,
    maxTries: 3,
    waitBetweenTries: 5000,
    ...extra,
  },
);

const httpNode = (id, name, position, parameters, extra = {}) => node(id, name, 'n8n-nodes-base.httpRequest', 4.2, position, parameters, extra);

const credentialRef = (type, id, name) => ({ [type]: { id, name } });
const youtubeAuth = {
  authentication: 'predefinedCredentialType',
  nodeCredentialType: 'youTubeOAuth2Api',
};
const youtubeCredentials = credentialRef('youTubeOAuth2Api', 'YOUTUBE_PUBLISHING_OAUTH2_CREDENTIAL_ID', 'YouTube Publishing OAuth2');
const facebookAuth = { authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth' };
const facebookCredentials = credentialRef('httpHeaderAuth', 'FACEBOOK_REELS_PAGE_TOKEN_CREDENTIAL_ID', 'Facebook Reels Page Token');
const instagramAuth = { authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth' };
const instagramCredentials = credentialRef('httpHeaderAuth', 'INSTAGRAM_REELS_TOKEN_CREDENTIAL_ID', 'Instagram Reels Token');
const tiktokAuth = { authentication: 'genericCredentialType', genericAuthType: 'httpBearerAuth' };
const tiktokCredentials = credentialRef('httpBearerAuth', 'TIKTOK_CONTENT_POSTING_CREDENTIAL_ID', 'TikTok Content Posting Bearer');

const fullJsonResponse = (neverError = false, timeout = 300000) => ({
  timeout,
  response: { response: { fullResponse: true, neverError, responseFormat: 'json' } },
});

const switchNode = (id, name, position, leftValue, cases, fallbackName = 'Unsupported') => node(
  id,
  name,
  'n8n-nodes-base.switch',
  3.4,
  position,
  {
    mode: 'rules',
    rules: {
      values: cases.map((value) => ({
        renameOutput: true,
        outputKey: value,
        conditions: {
          options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' },
          conditions: [{ leftValue, rightValue: value, operator: { type: 'string', operation: 'equals' } }],
          combinator: 'and',
        },
      })),
    },
    options: { fallbackOutput: 'extra', renameFallbackOutput: fallbackName },
  },
);

const postgresNode = (id, name, position, query, queryReplacement = '', extra = {}) => node(
  id,
  name,
  'n8n-nodes-base.postgres',
  2.6,
  position,
  {
    resource: 'database',
    operation: 'executeQuery',
    query,
    options: {
      queryBatching: 'single',
      queryReplacement,
      replaceEmptyStrings: true,
    },
  },
  {
    retryOnFail: true,
    maxTries: 3,
    waitBetweenTries: 5000,
    ...extra,
  },
);

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
      ],
    },
    builtInTools: {},
    options: {
      textFormat: {
        textOptions: {
          type: 'json_schema',
          name: 'clip_transformation',
          schema: '={{ $json.transformation_schema }}',
          strict: true,
        },
      },
    },
  },
  { onError: 'continueRegularOutput' },
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

const routeIfNode = (id, name, position, route) => ifNode(id, name, position, '={{ $json.route }}', route, 'string', 'equals');

function writeWorkflow(file, workflow) {
  if (path.basename(file) === '12-publish-to-platforms.json') {
    require('./postiz-workflow').extendPostizWorkflow(workflow, {
      helper, postgresSql, postgresNode, httpNode, codeNode, fallibleCodeNode,
      switchNode, fullJsonResponse, credentialRef,
    });
  }
  const outputFile = path.join(WORKFLOW_OUTPUT_DIR, path.basename(file));
  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  fs.writeFileSync(outputFile, `${JSON.stringify({
    ...workflow,
    settings: { executionOrder: 'v1', ...(workflow.settings || {}) },
    pinData: {},
    meta: { instanceId: 'placeholder' },
  }, null, 2)}\n`);
}

function wf6() {
  const h = helper('yt-dlp-clip-download');
  const folders = `{
  CHRISTIAN_CONTENT: 'GOOGLE_DRIVE_FOLDER_CHRISTIAN_CONTENT',
  MOTIVATION_DISCIPLINE: 'GOOGLE_DRIVE_FOLDER_MOTIVATION_DISCIPLINE',
  FINANCE_BUSINESS: 'GOOGLE_DRIVE_FOLDER_FINANCE_BUSINESS',
  LIFE_VALUES_RELATIONSHIPS: 'GOOGLE_DRIVE_FOLDER_LIFE_VALUES_RELATIONSHIPS',
  AFRICAN_KENYAN_SUCCESS: 'GOOGLE_DRIVE_FOLDER_AFRICAN_KENYAN_SUCCESS',
}`;
  writeWorkflow('06-yt-dlp-clip-download.json', {
    name: 'WF6 yt-dlp Clip Download',
    nodes: [
      node('wf6-001', 'Schedule 15m', 'n8n-nodes-base.scheduleTrigger', 1.2, [0, 0], { rule: { interval: [{ field: 'minutes', minutesInterval: 15 }] } }),
      postgresNode('wf6-002', 'Read Clip_Moments', [220, 0], postgresSql('select-clip-moments')),
      postgresNode('wf6-003', 'Read Created_Clips', [440, 0], postgresSql('select-created-clips'), '', { alwaysOutputData: true }),
      codeNode('wf6-004', 'Plan yt-dlp Downloads', [660, 0], `${h}
const requests = planYtDlpDownloads(
  $('Read Clip_Moments').all().map(i => i.json),
  $('Read Created_Clips').all().map(i => i.json),
  ${folders},
  { limit: 5, perSourceLimit: 1 },
);
return requests.map((request, index) => ({ json: request, pairedItem: { item: index } }));`),
      node('wf6-005', 'Download Loop', 'n8n-nodes-base.splitInBatches', 3, [880, 0], { batchSize: 1, options: {} }),
      codeNode('wf6-006', 'Build yt-dlp Command', [1100, 120], `${h}
const req = $('Download Loop').first().json;
const command = buildYtDlpCommand(req);
return [{ json: { ...req, command }, pairedItem: { item: 0 } }];`),
      codeNode('wf6-007', 'Mark Moment Downloading', [1320, 120], `${h}
const req = $('Download Loop').first().json;
return [{ json: buildMomentStatus(req, 'SUBMITTED'), pairedItem: { item: 0 } }];`),
      postgresNode('wf6-008', 'Update Moment Downloading', [1540, 120], postgresSql('update-moment-download-status'), ROWS),
      node('wf6-009', 'Run yt-dlp', 'n8n-nodes-base.executeCommand', 1, [1760, 120], { command: '={{ $("Build yt-dlp Command").first().json.command }}' }, { onError: 'continueRegularOutput' }),
      ifNode('wf6-010', 'Download Succeeded?', [1980, 120], '={{ $json.exitCode }}', 0, 'number', 'equals'),
      codeNode('wf6-011', 'Build Portrait Command', [2200, 40], `${h}
const req = $('Download Loop').first().json;
const command = buildPortraitCommand(req);
return [{ json: { ...req, command }, pairedItem: { item: 0 } }];`),
      node('wf6-012', 'Run FFmpeg Portrait', 'n8n-nodes-base.executeCommand', 1, [2420, 40], { command: '={{ $("Build Portrait Command").first().json.command }}' }, { onError: 'continueRegularOutput' }),
      ifNode('wf6-013', 'Portrait Succeeded?', [2640, 40], '={{ $json.exitCode }}', 0, 'number', 'equals'),
      node('wf6-014', 'Read Downloaded Clip', 'n8n-nodes-base.readWriteFile', 1, [2860, -40], { operation: 'read', fileSelector: '={{ $("Download Loop").first().json.portrait_path }}', options: { dataPropertyName: 'data' } }),
      node('wf6-015', 'Upload Clip To Drive', 'n8n-nodes-base.googleDrive', 3, [3080, -40], { resource: 'file', operation: 'upload', name: '={{ $("Download Loop").first().json.file_name }}', driveId: { __rl: true, mode: 'list', value: 'My Drive' }, folderId: { __rl: true, mode: 'id', value: '={{ $("Download Loop").first().json.drive_folder_id }}' }, inputDataFieldName: 'data', options: {} }),
      codeNode('wf6-016', 'Build Created Clip Row', [3300, -40], `${h}
const req = $('Download Loop').first().json;
const drive = $input.first().json;
return [{ json: buildCreatedClipRow(req, drive), pairedItem: { item: 0 } }];`),
      postgresNode('wf6-017', 'Save Created Clip', [3520, -40], postgresSql('upsert-created-clips'), ROWS),
      codeNode('wf6-018', 'Mark Moment Completed', [3740, -40], `${h}
const req = $('Download Loop').first().json;
return [{ json: buildMomentStatus(req, 'COMPLETED'), pairedItem: { item: 0 } }];`),
      postgresNode('wf6-019', 'Update Moment Completed', [3960, -40], postgresSql('update-moment-download-status'), ROWS),
      codeNode('wf6-020', 'Mark Moment Error', [2200, 240], `${h}
const req = $('Download Loop').first().json;
const out = $input.first().json;
return [{ json: buildMomentStatus(req, 'ERROR', { error_message: String(out.stderr || out.error || out.message || 'yt-dlp download failed').slice(0, 1000) }), pairedItem: { item: 0 } }];`),
      postgresNode('wf6-021', 'Update Moment Error', [2420, 240], postgresSql('update-moment-download-status'), ROWS),
      node('wf6-022', 'Wait 2s Completed', 'n8n-nodes-base.wait', 1.1, [4180, -40], { amount: 2 }),
      node('wf6-023', 'Wait 2s Failed', 'n8n-nodes-base.wait', 1.1, [2640, 240], { amount: 2 }),
    ],
    connections: {
      'Schedule 15m': { main: [[{ node: 'Read Clip_Moments', type: 'main', index: 0 }]] },
      'Read Clip_Moments': { main: [[{ node: 'Read Created_Clips', type: 'main', index: 0 }]] },
      'Read Created_Clips': { main: [[{ node: 'Plan yt-dlp Downloads', type: 'main', index: 0 }]] },
      'Plan yt-dlp Downloads': { main: [[{ node: 'Download Loop', type: 'main', index: 0 }]] },
      'Download Loop': { main: [[], [{ node: 'Build yt-dlp Command', type: 'main', index: 0 }]] },
      'Build yt-dlp Command': { main: [[{ node: 'Mark Moment Downloading', type: 'main', index: 0 }]] },
      'Mark Moment Downloading': { main: [[{ node: 'Update Moment Downloading', type: 'main', index: 0 }]] },
      'Update Moment Downloading': { main: [[{ node: 'Run yt-dlp', type: 'main', index: 0 }]] },
      'Run yt-dlp': { main: [[{ node: 'Download Succeeded?', type: 'main', index: 0 }]] },
      'Download Succeeded?': { main: [[{ node: 'Build Portrait Command', type: 'main', index: 0 }], [{ node: 'Mark Moment Error', type: 'main', index: 0 }]] },
      'Build Portrait Command': { main: [[{ node: 'Run FFmpeg Portrait', type: 'main', index: 0 }]] },
      'Run FFmpeg Portrait': { main: [[{ node: 'Portrait Succeeded?', type: 'main', index: 0 }]] },
      'Portrait Succeeded?': { main: [[{ node: 'Read Downloaded Clip', type: 'main', index: 0 }], [{ node: 'Mark Moment Error', type: 'main', index: 0 }]] },
      'Read Downloaded Clip': { main: [[{ node: 'Upload Clip To Drive', type: 'main', index: 0 }]] },
      'Upload Clip To Drive': { main: [[{ node: 'Build Created Clip Row', type: 'main', index: 0 }]] },
      'Build Created Clip Row': { main: [[{ node: 'Save Created Clip', type: 'main', index: 0 }]] },
      'Save Created Clip': { main: [[{ node: 'Mark Moment Completed', type: 'main', index: 0 }]] },
      'Mark Moment Completed': { main: [[{ node: 'Update Moment Completed', type: 'main', index: 0 }]] },
      'Update Moment Completed': { main: [[{ node: 'Wait 2s Completed', type: 'main', index: 0 }]] },
      'Wait 2s Completed': { main: [[{ node: 'Download Loop', type: 'main', index: 0 }]] },
      'Mark Moment Error': { main: [[{ node: 'Update Moment Error', type: 'main', index: 0 }]] },
      'Update Moment Error': { main: [[{ node: 'Wait 2s Failed', type: 'main', index: 0 }]] },
      'Wait 2s Failed': { main: [[{ node: 'Download Loop', type: 'main', index: 0 }]] },
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
  writeWorkflow('08-drive-storage-transform.json', {
    name: 'WF8 Drive Storage Transform',
    nodes: [
      node('wf8-001', 'Schedule 30m', 'n8n-nodes-base.scheduleTrigger', 1.2, [0, 0], { rule: { interval: [{ field: 'minutes', minutesInterval: 30 }] } }),
      postgresNode('wf8-002', 'Read Created_Clips', [220, 0], postgresSql('select-created-clips')),
      postgresNode('wf8-004', 'Read Clip_Moments', [440, 0], postgresSql('select-clip-moments'), '', { alwaysOutputData: true }),
      codeNode('wf8-005', 'Pick Awaiting Download', [880, 0], `${h}
const rows = pickAwaitingDownloads(
  $('Read Created_Clips').all().map(i => i.json),
  // Ssemble_Jobs was a legacy tab with no Postgres equivalent: the structure
  // doc records that the active yt-dlp path never wrote it, so there is nothing
  // to port. The lineage it supplied comes from created_clips.download_job_id.
  [],
  $('Read Clip_Moments').all().map(i => i.json),
  ${folders},
  { limit: 5, perSourceLimit: 1 },
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
      postgresNode('wf8-011', 'Save Drive Ids', [2200, 220], postgresSql('update-clip-drive-ids'), ROWS),
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
      postgresNode('wf8-015', 'Update Created Clip', [3080, 120], postgresSql('update-clip-transformation'), ROWS),
      codeNode('wf8-016', 'Build Render Job', [3300, 120], `${h}
const parsed = $('Parse Plan').first().json;
return [{ json: buildRenderJobRow(parsed), pairedItem: { item: 0 } }];`),
      postgresNode('wf8-017', 'Create Render Job', [3520, 120], postgresSql('upsert-render-jobs'), ROWS),
    ],
    connections: {
      'Schedule 30m': { main: [[{ node: 'Read Created_Clips', type: 'main', index: 0 }]] },
      'Read Created_Clips': { main: [[{ node: 'Read Clip_Moments', type: 'main', index: 0 }]] },
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
      'Update Created Clip': { main: [[{ node: 'Build Render Job', type: 'main', index: 0 }]] },
      'Build Render Job': { main: [[{ node: 'Create Render Job', type: 'main', index: 0 }]] },
      'Create Render Job': { main: [[{ node: 'Clip Loop', type: 'main', index: 0 }]] },
    },
  });
}

function wf9() {
  const h = helper('review-queue-digest');
  writeWorkflow('09-review-queue-digest.json', {
    name: 'WF9 Review Queue Digest',
    settings: { timezone: 'Africa/Nairobi' },
    nodes: [
      node('wf9-001', 'Schedule Daily', 'n8n-nodes-base.scheduleTrigger', 1.2, [0, 0], { rule: { interval: [{ field: 'cronExpression', expression: '0 8 * * *' }] } }),
      postgresNode('wf9-005', 'Read Source_Channels', [220, 0], postgresSql('select-source-channels')),
      postgresNode('wf9-002', 'Read Created_Clips', [440, 0], postgresSql('select-created-clips')),
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

function wf11() {
  const h = helper('publishing');
  writeWorkflow('11-build-publishing-jobs.json', {
    name: 'WF11 Build Publishing Jobs',
    description: 'Creates one fail-closed publishing queue row per explicitly approved render and enabled platform destination. It separates human approval from billable provider work so no upload starts implicitly.',
    settings: { timezone: 'Africa/Nairobi' },
    nodes: [
      node('wf11-001', 'Schedule 30m', 'n8n-nodes-base.scheduleTrigger', 1.2, [0, 0], { rule: { interval: [{ field: 'minutes', minutesInterval: 30 }] } }),
      sheetsNode('wf11-002', 'Read Approved_For_Posting', [220, 0], sheet('read', 'Approved_For_Posting')),
      sheetsNode('wf11-003', 'Read Render_Jobs', [440, 0], sheet('read', 'Render_Jobs'), { alwaysOutputData: true }),
      sheetsNode('wf11-004', 'Read Created_Clips', [660, 0], sheet('read', 'Created_Clips'), { alwaysOutputData: true }),
      sheetsNode('wf11-005', 'Read Publishing_Channels', [880, 0], sheet('read', 'Publishing_Channels'), { alwaysOutputData: true }),
      sheetsNode('wf11-006', 'Read Publishing_Jobs', [1100, 0], sheet('read', 'Publishing_Jobs'), { alwaysOutputData: true }),
      {
        ...codeNode('wf11-007', 'Build Missing Publish Jobs', [1320, 0], `${h}
const rows = buildPublishingJobs(
  $('Read Approved_For_Posting').all().map(i => i.json),
  $('Read Render_Jobs').all().map(i => i.json),
  $('Read Created_Clips').all().map(i => i.json),
  $('Read Publishing_Channels').all().map(i => i.json),
  $('Read Publishing_Jobs').all().map(i => i.json),
);
return rows.map((row, index) => ({ json: row, pairedItem: { item: index } }));`),
        alwaysOutputData: true,
      },
      postgresNode(
        'wf11-008',
        'Sync Atomic Publishing Queue',
        [1540, 0],
        postgresSql('upsert-publishing-jobs'),
        `={{ JSON.stringify([
  ...$('Read Publishing_Jobs').all(),
  ...$('Build Missing Publish Jobs').all(),
].map(item => item.json).filter(row => row.publish_id)) }}`,
        { executeOnce: true },
      ),
      codeNode('wf11-009', 'Return New Publish Jobs', [1760, 0], `return $('Build Missing Publish Jobs').all()
  .filter(item => item.json.publish_id)
  .map((item, index) => ({ json: item.json, pairedItem: { item: index } }));`),
      sheetsNode('wf11-010', 'Append Publishing Jobs', [1980, 0], sheet('appendOrUpdate', 'Publishing_Jobs', { columns: { mappingMode: 'autoMapInputData', value: {}, matchingColumns: ['publish_id'] } })),
    ],
    connections: {
      'Schedule 30m': { main: [[{ node: 'Read Approved_For_Posting', type: 'main', index: 0 }]] },
      'Read Approved_For_Posting': { main: [[{ node: 'Read Render_Jobs', type: 'main', index: 0 }]] },
      'Read Render_Jobs': { main: [[{ node: 'Read Created_Clips', type: 'main', index: 0 }]] },
      'Read Created_Clips': { main: [[{ node: 'Read Publishing_Channels', type: 'main', index: 0 }]] },
      'Read Publishing_Channels': { main: [[{ node: 'Read Publishing_Jobs', type: 'main', index: 0 }]] },
      'Read Publishing_Jobs': { main: [[{ node: 'Build Missing Publish Jobs', type: 'main', index: 0 }]] },
      'Build Missing Publish Jobs': { main: [[{ node: 'Sync Atomic Publishing Queue', type: 'main', index: 0 }]] },
      'Sync Atomic Publishing Queue': { main: [[{ node: 'Return New Publish Jobs', type: 'main', index: 0 }]] },
      'Return New Publish Jobs': { main: [[{ node: 'Append Publishing Jobs', type: 'main', index: 0 }]] },
    },
  });
}

function wf12() {
  const h = helper('publishing');
  const providerRoutes = [
    'YOUTUBE_START', 'YOUTUBE_SESSION', 'YOUTUBE_PROCESSING',
    'FACEBOOK_START', 'FACEBOOK_VIDEO_CREATED', 'FACEBOOK_PROCESSING',
    'INSTAGRAM_START', 'INSTAGRAM_CONTAINER', 'INSTAGRAM_MEDIA_PUBLISHED',
    'TIKTOK_START', 'TIKTOK_PROCESSING', 'SKIP', 'AMBIGUOUS',
  ];
  writeWorkflow('12-publish-to-platforms.json', {
    name: 'WF12 Publish To Platforms',
    description: 'Atomically claims due publishing jobs and runs resumable YouTube, Facebook Reel, Instagram Reel, or TikTok draft/inbox provider stages. Provider IDs and polling checkpoints are persisted before advancing so asynchronous acknowledgements are never mistaken for a completed publication.',
    settings: { timezone: 'Africa/Nairobi' },
    nodes: [
      node('wf12-001', 'Schedule 15m', 'n8n-nodes-base.scheduleTrigger', 1.2, [0, 0], { rule: { interval: [{ field: 'minutes', minutesInterval: 15 }] } }),
      postgresNode(
        'wf12-002',
        'Claim Next Job Atomically',
        [220, 0],
        postgresSql('claim-next-publishing-job'),
        `={{ 'WF12:' + String($execution.id || 'unknown') }},180`,
      ),
      codeNode('wf12-002b', 'Redact Atomic Claim For Sheet', [330, -120], redactProviderStateCode),
      sheetsNode('wf12-003', 'Mirror Atomic Claim', [440, 0], sheet('appendOrUpdate', 'Publishing_Jobs', { columns: { mappingMode: 'autoMapInputData', value: {}, matchingColumns: ['publish_id'] } })),
      postgresNode(
        'wf12-004',
        'Mark Uploading Atomically',
        [660, 0],
        postgresSql('mark-publishing-uploading'),
        `={{ $('Claim Next Job Atomically').first().json.publish_id }},={{ $('Claim Next Job Atomically').first().json.claimed_by }}`,
      ),
      codeNode('wf12-005', 'Build Provider Route', [880, 0], `${h}
const job = $('Mark Uploading Atomically').first().json;
const validation = validateProviderJob(job);
let route = 'SKIP';
if (validation.ready) {
  const stage = String(job.provider_stage || '').toUpperCase();
  if (job.platform === 'YOUTUBE_SHORTS') route = stage === 'YOUTUBE_PROCESSING' ? 'YOUTUBE_PROCESSING' : (stage === 'YOUTUBE_SESSION' ? 'YOUTUBE_SESSION' : 'YOUTUBE_START');
  if (job.platform === 'FACEBOOK_REELS') route = stage === 'FACEBOOK_FINISH_REQUESTED' ? 'AMBIGUOUS' : (stage === 'FACEBOOK_PROCESSING' ? 'FACEBOOK_PROCESSING' : (stage === 'FACEBOOK_VIDEO_CREATED' ? 'FACEBOOK_VIDEO_CREATED' : 'FACEBOOK_START'));
  if (job.platform === 'INSTAGRAM_REELS') route = stage === 'INSTAGRAM_PUBLISH_REQUESTED' ? 'AMBIGUOUS' : (stage === 'INSTAGRAM_MEDIA_PUBLISHED' ? 'INSTAGRAM_MEDIA_PUBLISHED' : (stage ? 'INSTAGRAM_CONTAINER' : 'INSTAGRAM_START'));
  if (job.platform === 'TIKTOK') route = stage === 'TIKTOK_INIT_REQUESTED' ? 'AMBIGUOUS' : (stage === 'TIKTOK_PROCESSING' ? 'TIKTOK_PROCESSING' : 'TIKTOK_START');
}
return [{ json: { ...job, route, ready: validation.ready, last_error: validation.reason || '' }, pairedItem: { item: 0 } }];`),
      switchNode('wf12-006', 'Route Provider Stage', [1100, 0], '={{ $json.route }}', providerRoutes),

      httpNode('wf12-yt-000a', 'Verify YouTube Destination', [1200, -1040], {
        method: 'GET', url: 'https://www.googleapis.com/youtube/v3/channels', ...youtubeAuth,
        sendQuery: true, queryParameters: { parameters: [{ name: 'part', value: 'id' }, { name: 'mine', value: 'true' }] },
        options: fullJsonResponse(false, 120000),
      }, { credentials: youtubeCredentials, retryOnFail: true, maxTries: 3, waitBetweenTries: 5000, onError: 'continueErrorOutput' }),
      fallibleCodeNode('wf12-yt-000b', 'Confirm YouTube Destination', [1420, -1040], `const body = $input.first().json.body || $input.first().json;
const actual = String(body.items?.[0]?.id || '').trim();
const expected = String($('Build Provider Route').first().json.youtube_channel_id || '').trim();
if (!actual || actual !== expected) throw new Error('YouTube credential channel mismatch: expected ' + expected + ', received ' + (actual || 'none'));
return [{ json: { ...$('Build Provider Route').first().json, youtube_channel_id: actual }, pairedItem: { item: 0 } }];`),
      switchNode('wf12-yt-000c', 'Route Verified YouTube Stage', [1640, -1040], '={{ $json.route }}', ['YOUTUBE_START', 'YOUTUBE_SESSION', 'YOUTUBE_PROCESSING']),

      httpNode('wf12-yt-003', 'Start YouTube Resumable Upload', [1760, -880], {
        method: 'POST',
        url: 'http://provider-uploader:8080/youtube/init',
        ...youtubeAuth,
        sendBody: true,
        contentType: 'json',
        specifyBody: 'json',
        jsonBody: `={{ JSON.stringify({ file_path: $json.local_file_path, mime_type: 'video/mp4', notify_subscribers: false, metadata: { snippet: { title: $json.title, description: $json.caption, tags: String($json.hashtags || '').replace(/#/g, '').split(/\\s+/).filter(Boolean), categoryId: '22' }, status: { privacyStatus: $json.default_privacy || 'private', selfDeclaredMadeForKids: false } } }) }}`,
        options: fullJsonResponse(false, 300000),
      }, { credentials: youtubeCredentials, onError: 'continueErrorOutput' }),
      fallibleCodeNode('wf12-yt-004', 'Build YouTube Session Checkpoint', [1980, -880], `const wrapper = $input.first().json;
const response = wrapper.body || wrapper;
if (Number(response.statusCode) !== 200 || !response.location) throw new Error('YouTube resumable init did not return HTTP 200 and a session URL');
return [{ json: { provider_stage: 'YOUTUBE_SESSION', provider_ref: '', provider_upload_url: response.location, provider_response: JSON.stringify({ video_size: response.totalBytes, video_mime: response.mimeType, init_status: response.statusCode }) }, pairedItem: { item: 0 } }];`),
      postgresNode('wf12-yt-005', 'Save YouTube Session', [2200, -880], postgresSql('save-provider-checkpoint'), `={{ $('Build Provider Route').first().json.publish_id }},={{ $('Build Provider Route').first().json.claimed_by }},={{ $json.provider_stage }},={{ $json.provider_ref }},={{ $json.provider_upload_url }},={{ $json.provider_response }}`),
      postgresNode('wf12-yt-006', 'Extend YouTube Upload Lease', [2420, -880], postgresSql('extend-publishing-lease'), `={{ $('Build Provider Route').first().json.publish_id }},={{ $('Build Provider Route').first().json.claimed_by }},120`),

      httpNode('wf12-yt-008', 'Probe YouTube Session', [1320, -660], {
        method: 'POST', url: 'http://provider-uploader:8080/youtube/probe', ...youtubeAuth,
        sendBody: true, contentType: 'json', specifyBody: 'json',
        jsonBody: `={{ JSON.stringify({ upload_url: $json.provider_upload_url, total_bytes: JSON.parse($json.provider_response || '{}').video_size }) }}`,
        options: fullJsonResponse(true, 120000),
      }, { credentials: youtubeCredentials, retryOnFail: true, maxTries: 3, waitBetweenTries: 5000, onError: 'continueErrorOutput' }),
      fallibleCodeNode('wf12-yt-009', 'Interpret YouTube Session', [1540, -660], `const wrapper = $input.first().json;
const response = wrapper.body || wrapper;
const status = Number(response.statusCode);
if ((status === 200 || status === 201) && response.body?.id) return [{ json: { route: 'COMPLETE', provider_ref: response.body.id, provider_response: response.body }, pairedItem: { item: 0 } }];
if (status === 308) {
  if (response.retryAfter) return [{ json: { route: 'WAIT', provider_ref: $('Build Provider Route').first().json.provider_ref, provider_response: response, retry_after: response.retryAfter }, pairedItem: { item: 0 } }];
  const range = response.range || '';
  const match = String(range).match(/bytes=0-(\\d+)/);
  return [{ json: { route: 'RESUME', offset: match ? Number(match[1]) + 1 : 0 }, pairedItem: { item: 0 } }];
}
throw new Error(status === 404 ? 'YouTube resumable session expired; operator must verify duplicates before restarting' : 'Unexpected YouTube session status: ' + status);`),
      switchNode('wf12-yt-010', 'Route YouTube Session', [1760, -660], '={{ $json.route }}', ['RESUME', 'COMPLETE', 'WAIT']),
      postgresNode('wf12-yt-011', 'Extend YouTube Resume Lease', [1980, -700], postgresSql('extend-publishing-lease'), `={{ $('Build Provider Route').first().json.publish_id }},={{ $('Build Provider Route').first().json.claimed_by }},120`),
      codeNode('wf12-yt-012', 'Build YouTube Retry Poll', [2200, -600], `const input = $input.first().json;
const seconds = Math.max(1, Math.min(3600, Number(input.retry_after) || 60));
return [{ json: { action: 'POLL', provider_stage: 'YOUTUBE_SESSION', provider_ref: input.provider_ref || '', provider_response: input.provider_response || {}, poll_minutes: Math.ceil(seconds / 60) }, pairedItem: { item: 0 } }];`),
      httpNode('wf12-yt-013', 'Upload YouTube Video Bytes', [2860, -780], {
        method: 'POST', url: 'http://provider-uploader:8080/youtube/upload', ...youtubeAuth,
        sendBody: true, contentType: 'json', specifyBody: 'json',
        jsonBody: `={{ JSON.stringify({ upload_url: $('Build Provider Route').first().json.provider_upload_url || $('Save YouTube Session').first().json.provider_upload_url, file_path: $('Build Provider Route').first().json.local_file_path, total_bytes: JSON.parse(($('Build Provider Route').first().json.provider_response || $('Save YouTube Session').first().json.provider_response || '{}')).video_size, offset: $('Interpret YouTube Session').isExecuted ? $('Interpret YouTube Session').first().json.offset : 0, mime_type: JSON.parse(($('Build Provider Route').first().json.provider_response || $('Save YouTube Session').first().json.provider_response || '{}')).video_mime || 'video/mp4' }) }}`,
        options: fullJsonResponse(false, 1800000),
      }, { credentials: youtubeCredentials, onError: 'continueErrorOutput' }),
      fallibleCodeNode('wf12-yt-014', 'Build YouTube Processing Poll', [3080, -780], `const wrapper = $input.first().json;
const response = wrapper.body || wrapper;
if (![200, 201].includes(Number(response.statusCode)) || !response.body?.id) throw new Error('YouTube upload did not return a confirmed video ID');
return [{ json: { action: 'POLL', provider_stage: 'YOUTUBE_PROCESSING', provider_ref: response.body.id, provider_response: response.body, poll_minutes: 2 }, pairedItem: { item: 0 } }];`),
      codeNode('wf12-yt-015', 'Build YouTube Completed Session Poll', [1980, -580], `const data = $input.first().json;
return [{ json: { action: 'POLL', provider_stage: 'YOUTUBE_PROCESSING', provider_ref: data.provider_ref, provider_response: data.provider_response, poll_minutes: 2 }, pairedItem: { item: 0 } }];`),
      httpNode('wf12-yt-016', 'Check YouTube Processing', [1320, -440], {
        method: 'GET', url: 'https://www.googleapis.com/youtube/v3/videos', ...youtubeAuth,
        sendQuery: true, queryParameters: { parameters: [{ name: 'part', value: 'processingDetails,status' }, { name: 'id', value: '={{ $json.provider_ref }}' }] },
        options: fullJsonResponse(false, 120000),
      }, { credentials: youtubeCredentials, retryOnFail: true, maxTries: 3, waitBetweenTries: 5000, onError: 'continueErrorOutput' }),
      fallibleCodeNode('wf12-yt-017', 'Interpret YouTube Processing', [1540, -440], `${h}
const body = $input.first().json.body || $input.first().json;
const result = interpretYouTubeStatus(body);
return [{ json: { action: result.outcome === 'PROCESSING' ? 'POLL' : (result.outcome === 'PUBLISHED' ? 'COMPLETE' : 'FAIL'), provider_stage: 'YOUTUBE_PROCESSING', provider_ref: $('Build Provider Route').first().json.provider_ref, provider_response: body, poll_minutes: 2, ...result }, pairedItem: { item: 0 } }];`),

      httpNode('wf12-fb-001', 'Start Facebook Reel', [1320, -180], {
        method: 'POST', url: `={{ 'https://graph.facebook.com/' + $json.meta_graph_version + '/' + $json.facebook_page_id + '/video_reels' }}`, ...facebookAuth,
        sendQuery: true, queryParameters: { parameters: [{ name: 'upload_phase', value: 'start' }] }, options: fullJsonResponse(false, 120000),
      }, { credentials: facebookCredentials, onError: 'continueErrorOutput' }),
      fallibleCodeNode('wf12-fb-002', 'Build Facebook Video Checkpoint', [1540, -180], `const body = $input.first().json.body || $input.first().json;
if (!body.video_id || !body.upload_url) throw new Error('Facebook Reel init did not return video_id and upload_url');
return [{ json: { provider_stage: 'FACEBOOK_VIDEO_CREATED', provider_ref: body.video_id, provider_upload_url: body.upload_url, provider_response: JSON.stringify(body) }, pairedItem: { item: 0 } }];`),
      postgresNode('wf12-fb-003', 'Save Facebook Video', [1760, -180], postgresSql('save-provider-checkpoint'), `={{ $('Build Provider Route').first().json.publish_id }},={{ $('Build Provider Route').first().json.claimed_by }},={{ $json.provider_stage }},={{ $json.provider_ref }},={{ $json.provider_upload_url }},={{ $json.provider_response }}`),
      httpNode('wf12-fb-004', 'Send Hosted Video To Facebook', [1980, -180], {
        method: 'POST', url: '={{ $json.provider_upload_url }}', ...facebookAuth,
        sendHeaders: true, headerParameters: { parameters: [{ name: 'file_url', value: '={{ $("Build Provider Route").first().json.public_video_url }}' }] },
        options: fullJsonResponse(false, 300000),
      }, { credentials: facebookCredentials, onError: 'continueErrorOutput' }),
      fallibleCodeNode('wf12-fb-004b', 'Confirm Facebook Hosted Upload', [2090, -300], `const body = $input.first().json.body || $input.first().json;
if (body.success !== true) throw new Error('Facebook hosted Reel transfer was not acknowledged');
return [{ json: body, pairedItem: { item: 0 } }];`),
      codeNode('wf12-fb-004c', 'Build Facebook Finish Intent', [2140, -300], `const job = $('Build Provider Route').first().json;
return [{ json: { provider_stage: 'FACEBOOK_FINISH_REQUESTED', provider_ref: job.provider_ref || $('Save Facebook Video').first().json.provider_ref, provider_upload_url: '', provider_response: JSON.stringify($input.first().json || {}) }, pairedItem: { item: 0 } }];`),
      postgresNode('wf12-fb-004d', 'Save Facebook Finish Intent', [2180, -300], postgresSql('save-provider-checkpoint'), `={{ $('Build Provider Route').first().json.publish_id }},={{ $('Build Provider Route').first().json.claimed_by }},={{ $json.provider_stage }},={{ $json.provider_ref }},={{ '' }},={{ $json.provider_response }}`),
      httpNode('wf12-fb-005', 'Finish Facebook Reel', [2200, -180], {
        method: 'POST', url: `={{ 'https://graph.facebook.com/' + $('Build Provider Route').first().json.meta_graph_version + '/' + $('Build Provider Route').first().json.facebook_page_id + '/video_reels' }}`, ...facebookAuth,
        sendQuery: true,
        queryParameters: { parameters: [
          { name: 'upload_phase', value: 'finish' },
          { name: 'video_id', value: '={{ $("Build Provider Route").first().json.provider_ref || $("Save Facebook Video").first().json.provider_ref }}' },
          { name: 'video_state', value: `={{ String($('Build Provider Route').first().json.default_privacy).toLowerCase() === 'public' ? 'PUBLISHED' : 'DRAFT' }}` },
          { name: 'title', value: '={{ $("Build Provider Route").first().json.title }}' },
          { name: 'description', value: '={{ $("Build Provider Route").first().json.caption }}' },
        ] },
        options: fullJsonResponse(false, 120000),
      }, { credentials: facebookCredentials, onError: 'continueErrorOutput' }),
      fallibleCodeNode('wf12-fb-006', 'Build Facebook Processing Poll', [2420, -180], `const body = $input.first().json.body || $input.first().json;
if (body.success !== true) throw new Error('Facebook Reel finish was not acknowledged');
return [{ json: { action: 'POLL', provider_stage: 'FACEBOOK_PROCESSING', provider_ref: $('Build Provider Route').first().json.provider_ref || $('Save Facebook Video').first().json.provider_ref, provider_response: body, poll_minutes: 2 }, pairedItem: { item: 0 } }];`),
      httpNode('wf12-fb-007', 'Check Facebook Reel Status', [1320, 40], {
        method: 'GET', url: `={{ 'https://graph.facebook.com/' + $json.meta_graph_version + '/' + $json.provider_ref }}`, ...facebookAuth,
        sendQuery: true, queryParameters: { parameters: [{ name: 'fields', value: 'status' }] }, options: fullJsonResponse(false, 120000),
      }, { credentials: facebookCredentials, retryOnFail: true, maxTries: 3, waitBetweenTries: 5000, onError: 'continueErrorOutput' }),
      fallibleCodeNode('wf12-fb-008', 'Interpret Facebook Reel Status', [1540, 40], `${h}
const body = $input.first().json.body || $input.first().json;
const result = interpretFacebookStatus(body);
if (result.outcome === 'PUBLISHED' && String($('Build Provider Route').first().json.default_privacy).toLowerCase() !== 'public') result.outcome = 'DRAFT_UPLOADED';
return [{ json: { action: result.outcome === 'PROCESSING' ? 'POLL' : (['PUBLISHED', 'DRAFT_UPLOADED'].includes(result.outcome) ? 'COMPLETE' : 'FAIL'), provider_stage: 'FACEBOOK_PROCESSING', provider_ref: $('Build Provider Route').first().json.provider_ref, provider_response: body, poll_minutes: 2, ...result }, pairedItem: { item: 0 } }];`),

      httpNode('wf12-ig-001', 'Create Instagram Reel Container', [1320, 300], {
        method: 'POST', url: `={{ 'https://' + $json.instagram_graph_host + '/' + $json.meta_graph_version + '/' + $json.instagram_user_id + '/media' }}`, ...instagramAuth,
        sendQuery: true, queryParameters: { parameters: [
          { name: 'media_type', value: 'REELS' }, { name: 'video_url', value: '={{ $json.public_video_url }}' },
          { name: 'caption', value: '={{ $json.caption }}' }, { name: 'share_to_feed', value: 'true' },
        ] }, options: fullJsonResponse(false, 120000),
      }, { credentials: instagramCredentials, onError: 'continueErrorOutput' }),
      fallibleCodeNode('wf12-ig-002', 'Build Instagram Container Poll', [1540, 300], `const body = $input.first().json.body || $input.first().json;
if (!body.id) throw new Error('Instagram container creation did not return an ID');
return [{ json: { action: 'POLL', provider_stage: 'INSTAGRAM_CONTAINER', provider_ref: body.id, provider_response: body, poll_minutes: 2 }, pairedItem: { item: 0 } }];`),
      httpNode('wf12-ig-003', 'Check Instagram Container', [1320, 520], {
        method: 'GET', url: `={{ 'https://' + $json.instagram_graph_host + '/' + $json.meta_graph_version + '/' + $json.provider_ref }}`, ...instagramAuth,
        sendQuery: true, queryParameters: { parameters: [{ name: 'fields', value: 'status_code,status' }] }, options: fullJsonResponse(false, 120000),
      }, { credentials: instagramCredentials, retryOnFail: true, maxTries: 3, waitBetweenTries: 5000, onError: 'continueErrorOutput' }),
      fallibleCodeNode('wf12-ig-004', 'Interpret Instagram Container', [1540, 520], `${h}
const body = $input.first().json.body || $input.first().json;
const result = interpretInstagramContainerStatus(body);
const action = result.outcome === 'PROCESSING' ? 'POLL' : (result.outcome === 'READY_TO_PUBLISH' ? 'PUBLISH' : 'FAIL');
return [{ json: { action, provider_stage: 'INSTAGRAM_CONTAINER', provider_ref: $('Build Provider Route').first().json.provider_ref, provider_response: body, poll_minutes: 2, ...result, error: result.error || (result.outcome === 'PUBLISHED' ? 'Instagram reports PUBLISHED but the media ID was not durably captured; manual reconciliation required' : '') }, pairedItem: { item: 0 } }];`),
      switchNode('wf12-ig-005', 'Route Instagram Container', [1760, 520], '={{ $json.action }}', ['POLL', 'PUBLISH', 'FAIL']),
      codeNode('wf12-ig-006', 'Build Instagram Publish Intent', [1980, 480], `return [{ json: { provider_stage: 'INSTAGRAM_PUBLISH_REQUESTED', provider_ref: $('Build Provider Route').first().json.provider_ref, provider_upload_url: '', provider_response: JSON.stringify($input.first().json.provider_response || {}) }, pairedItem: { item: 0 } }];`),
      postgresNode('wf12-ig-007', 'Save Instagram Publish Intent', [2200, 480], postgresSql('save-provider-checkpoint'), `={{ $('Build Provider Route').first().json.publish_id }},={{ $('Build Provider Route').first().json.claimed_by }},={{ $json.provider_stage }},={{ $json.provider_ref }},={{ $json.provider_upload_url }},={{ $json.provider_response }}`),
      httpNode('wf12-ig-008', 'Publish Instagram Reel', [2420, 480], {
        method: 'POST', url: `={{ 'https://' + $('Build Provider Route').first().json.instagram_graph_host + '/' + $('Build Provider Route').first().json.meta_graph_version + '/' + $('Build Provider Route').first().json.instagram_user_id + '/media_publish' }}`, ...instagramAuth,
        sendQuery: true, queryParameters: { parameters: [{ name: 'creation_id', value: '={{ $json.provider_ref }}' }] }, options: fullJsonResponse(false, 120000),
      }, { credentials: instagramCredentials, onError: 'continueErrorOutput' }),
      fallibleCodeNode('wf12-ig-009', 'Build Instagram Media Checkpoint', [2640, 480], `const body = $input.first().json.body || $input.first().json;
if (!body.id) throw new Error('Instagram media_publish did not return a media ID');
return [{ json: { provider_stage: 'INSTAGRAM_MEDIA_PUBLISHED', provider_ref: body.id, provider_upload_url: '', provider_response: JSON.stringify(body) }, pairedItem: { item: 0 } }];`),
      postgresNode('wf12-ig-010', 'Save Instagram Media ID', [2860, 480], postgresSql('save-provider-checkpoint'), `={{ $('Build Provider Route').first().json.publish_id }},={{ $('Build Provider Route').first().json.claimed_by }},={{ $json.provider_stage }},={{ $json.provider_ref }},={{ $json.provider_upload_url }},={{ $json.provider_response }}`),
      httpNode('wf12-ig-011', 'Get Instagram Reel Permalink', [3080, 480], {
        method: 'GET', url: `={{ 'https://' + $('Build Provider Route').first().json.instagram_graph_host + '/' + $('Build Provider Route').first().json.meta_graph_version + '/' + $json.provider_ref }}`, ...instagramAuth,
        sendQuery: true, queryParameters: { parameters: [{ name: 'fields', value: 'permalink,media_product_type' }] }, options: fullJsonResponse(false, 120000),
      }, { credentials: instagramCredentials, retryOnFail: true, maxTries: 3, waitBetweenTries: 5000, onError: 'continueErrorOutput' }),
      fallibleCodeNode('wf12-ig-012', 'Build Instagram Completion', [3300, 480], `const body = $input.first().json.body || $input.first().json;
const resumed = String($('Build Provider Route').first().json.provider_stage || '') === 'INSTAGRAM_MEDIA_PUBLISHED';
const id = resumed ? $('Build Provider Route').first().json.provider_ref : $('Save Instagram Media ID').first().json.provider_ref;
if (!id || !body.permalink) throw new Error('Instagram Reel confirmation did not return ID and permalink');
return [{ json: { action: 'COMPLETE', outcome: 'PUBLISHED', provider_stage: 'INSTAGRAM_PUBLISHED', provider_ref: id, provider_response: body, post_id: id, post_url: body.permalink }, pairedItem: { item: 0 } }];`),

      httpNode('wf12-tt-000a', 'Verify TikTok Destination', [1200, 680], {
        method: 'GET', url: 'https://open.tiktokapis.com/v2/user/info/', ...tiktokAuth,
        sendQuery: true, queryParameters: { parameters: [{ name: 'fields', value: 'open_id' }] },
        options: fullJsonResponse(false, 120000),
      }, { credentials: tiktokCredentials, retryOnFail: true, maxTries: 3, waitBetweenTries: 5000, onError: 'continueErrorOutput' }),
      fallibleCodeNode('wf12-tt-000b', 'Confirm TikTok Destination', [1420, 680], `const body = $input.first().json.body || $input.first().json;
const actual = String(body.data?.user?.open_id || '').trim();
const job = $('Build Provider Route').first().json;
const expected = String(job.tiktok_open_id || '').trim();
if (!actual || actual !== expected) throw new Error('TikTok credential identity mismatch: expected ' + expected + ', received ' + (actual || 'none'));
return [{ json: { ...job, tiktok_open_id: actual }, pairedItem: { item: 0 } }];`),
      switchNode('wf12-tt-000c', 'Route Verified TikTok Stage', [1640, 680], '={{ $json.route }}', ['TIKTOK_START', 'TIKTOK_PROCESSING']),
      codeNode('wf12-tt-000d', 'Build TikTok Init Intent', [1760, 620], `return [{ json: { provider_stage: 'TIKTOK_INIT_REQUESTED', provider_ref: '', provider_upload_url: '', provider_response: '{}' }, pairedItem: { item: 0 } }];`),
      postgresNode('wf12-tt-000e', 'Save TikTok Init Intent', [1980, 620], postgresSql('save-provider-checkpoint'), `={{ $('Build Provider Route').first().json.publish_id }},={{ $('Build Provider Route').first().json.claimed_by }},={{ $json.provider_stage }},={{ '' }},={{ '' }},={{ $json.provider_response }}`),
      httpNode('wf12-tt-001', 'Start TikTok Draft Pull', [1320, 760], {
        method: 'POST', url: 'https://open.tiktokapis.com/v2/post/publish/inbox/video/init/', ...tiktokAuth,
        sendBody: true, contentType: 'json', specifyBody: 'json',
        jsonBody: `={{ JSON.stringify({ source_info: { source: 'PULL_FROM_URL', video_url: $json.public_video_url } }) }}`,
        options: fullJsonResponse(false, 120000),
      }, { credentials: tiktokCredentials, onError: 'continueErrorOutput' }),
      fallibleCodeNode('wf12-tt-002', 'Build TikTok Draft Poll', [1540, 760], `const body = $input.first().json.body || $input.first().json;
if (!body.data?.publish_id) throw new Error('TikTok draft init did not return publish_id');
return [{ json: { action: 'POLL', provider_stage: 'TIKTOK_PROCESSING', provider_ref: body.data.publish_id, provider_response: body, poll_minutes: 2 }, pairedItem: { item: 0 } }];`),
      postgresNode('wf12-tt-002b', 'Save TikTok Publish ID', [1760, 760], postgresSql('save-provider-checkpoint'), `={{ $('Build Provider Route').first().json.publish_id }},={{ $('Build Provider Route').first().json.claimed_by }},={{ $json.provider_stage }},={{ $json.provider_ref }},={{ '' }},={{ JSON.stringify($json.provider_response || {}) }}`, { onError: 'continueErrorOutput' }),
      httpNode('wf12-tt-003', 'Check TikTok Draft Status', [1320, 980], {
        method: 'POST', url: 'https://open.tiktokapis.com/v2/post/publish/status/fetch/', ...tiktokAuth,
        sendBody: true, contentType: 'json', specifyBody: 'json', jsonBody: `={{ JSON.stringify({ publish_id: $json.provider_ref }) }}`,
        options: fullJsonResponse(false, 120000),
      }, { credentials: tiktokCredentials, retryOnFail: true, maxTries: 3, waitBetweenTries: 5000, onError: 'continueErrorOutput' }),
      fallibleCodeNode('wf12-tt-004', 'Interpret TikTok Draft Status', [1540, 980], `${h}
const body = $input.first().json.body || $input.first().json;
const providerRef = $('Build Provider Route').first().json.provider_ref;
const result = interpretTikTokStatus(body, providerRef);
return [{ json: { action: result.outcome === 'PROCESSING' ? 'POLL' : (['PUBLISHED', 'DRAFT_UPLOADED'].includes(result.outcome) ? 'COMPLETE' : 'FAIL'), provider_stage: 'TIKTOK_PROCESSING', provider_ref: providerRef, provider_response: body, poll_minutes: 2, ...result }, pairedItem: { item: 0 } }];`),

      switchNode('wf12-common-001', 'Route Provider Outcome', [3520, 0], '={{ $json.action }}', ['POLL', 'COMPLETE', 'FAIL']),
      fallibleCodeNode('wf12-common-002', 'Build Provider Poll State', [3740, -80], `${h}
const job = $('Build Provider Route').first().json;
const input = $input.first().json;
return [{ json: providerPollUpdate(job, input.provider_stage, input.provider_ref, input.provider_response, new Date(), input.poll_minutes), pairedItem: { item: 0 } }];`),
      postgresNode('wf12-common-003', 'Schedule Provider Poll Atomically', [3960, -80], postgresSql('schedule-provider-poll'), `={{ $json.publish_id }},={{ $json.claimed_by }},={{ $json.provider_stage }},={{ $json.provider_ref }},={{ $json.provider_response }},={{ String(Math.max(1, Math.ceil((Date.parse($json.poll_after) - Date.now()) / 60000))) }}`),
      codeNode('wf12-common-003b', 'Redact Provider Processing For Sheet', [4070, -180], redactProviderStateCode),
      sheetsNode('wf12-common-004', 'Mirror Provider Processing', [4180, -80], sheet('appendOrUpdate', 'Publishing_Jobs', { columns: { mappingMode: 'autoMapInputData', value: {}, matchingColumns: ['publish_id'] } })),
      fallibleCodeNode('wf12-common-005', 'Build Provider Completion State', [3740, 40], `const job = $('Build Provider Route').first().json;
const input = $input.first().json;
const status = input.outcome === 'DRAFT_UPLOADED' ? 'DRAFT_UPLOADED' : 'PUBLISHED';
const postId = String(input.post_id || input.provider_ref || '').trim();
const isTikTokTrackingOnly = job.platform === 'TIKTOK' && !String(input.post_id || '').trim() && String(input.provider_ref || job.provider_ref || '').trim();
if (!postId && !isTikTokTrackingOnly) throw new Error('Provider completion is missing a confirmed provider ID');
return [{ json: { publish_id: job.publish_id, claimed_by: job.claimed_by, publish_status: status, post_id: isTikTokTrackingOnly ? '' : postId, post_url: String(input.post_url || ''), provider_stage: input.provider_stage || (job.platform + '_COMPLETE'), provider_response: JSON.stringify(input.provider_response || {}) }, pairedItem: { item: 0 } }];`),
      postgresNode('wf12-common-006', 'Complete Provider Publish Atomically', [3960, 40], postgresSql('complete-provider-publish'), `={{ $json.publish_id }},={{ $json.claimed_by }},={{ $json.publish_status }},={{ $json.post_id }},={{ $json.post_url }},={{ $json.provider_stage }},={{ $json.provider_response }}`),
      codeNode('wf12-common-006b', 'Redact Provider Completion For Sheet', [4070, 10], redactProviderStateCode),
      sheetsNode('wf12-common-007', 'Mirror Provider Completion', [4180, 40], sheet('appendOrUpdate', 'Publishing_Jobs', { columns: { mappingMode: 'autoMapInputData', value: {}, matchingColumns: ['publish_id'] } })),
      codeNode('wf12-common-008', 'Build Provider Failure State', [3740, 160], `${h}
const job = $('Build Provider Route').first().json;
const input = $input.first().json;
let update = buildPublishFailureUpdate(job, input.error || input.message || input, new Date());
if (['FAILED', 'REJECTED', 'AUTH_REQUIRED'].includes(input.outcome)) update = { ...update, publish_status: input.outcome, next_retry_at: '' };
return [{ json: { ...update, claimed_by: job.claimed_by, provider_response: JSON.stringify(input.provider_response || input || {}) }, pairedItem: { item: 0 } }];`),
      codeNode('wf12-common-008b', 'Build Ambiguous Side Effect Failure', [3520, 260], `const input = $input.first().json;
return [{ json: { outcome: 'FAILED', error: 'AMBIGUOUS_PROVIDER_SIDE_EFFECT: manual reconciliation required before retry; ' + String(input.error?.message || input.message || input.error || 'provider response could not be durably confirmed'), provider_response: input }, pairedItem: { item: 0 } }];`),
      postgresNode('wf12-common-009', 'Save Provider Failure Atomically', [3960, 160], postgresSql('fail-provider-publish'), `={{ $json.publish_id }},={{ $json.claimed_by }},={{ $json.publish_status }},={{ $json.retry_count }},={{ $json.next_retry_at }},={{ $json.last_error }},={{ $json.provider_response }}`),
      codeNode('wf12-common-009b', 'Redact Provider Failure For Sheet', [4070, 210], redactProviderStateCode),
      sheetsNode('wf12-common-010', 'Mirror Provider Failure', [4180, 160], sheet('appendOrUpdate', 'Publishing_Jobs', { columns: { mappingMode: 'autoMapInputData', value: {}, matchingColumns: ['publish_id'] } })),

      codeNode('wf12-skip-001', 'Build Safe Skip Reason', [1320, 1200], `const job = $('Build Provider Route').first().json;
return [{ json: { publish_id: job.publish_id, platform: job.platform, destination_id: job.destination_id || '', claimed_by: job.claimed_by, last_error: job.last_error || 'UNSUPPORTED_PROVIDER_STATE:' + String(job.provider_stage || 'UNKNOWN') }, pairedItem: { item: 0 } }];`),
      postgresNode(
        'wf12-skip-002',
        'Save Safe Skip Atomically',
        [1540, 1200],
        postgresSql('mark-publishing-skipped'),
        `={{ $('Build Safe Skip Reason').first().json.publish_id }},={{ $('Build Safe Skip Reason').first().json.claimed_by }},={{ $('Build Safe Skip Reason').first().json.destination_id }},={{ $('Build Safe Skip Reason').first().json.last_error }}`,
      ),
      codeNode('wf12-skip-002b', 'Redact Safe Skip For Sheet', [1650, 1100], redactProviderStateCode),
      sheetsNode('wf12-skip-003', 'Mirror Safe Skip', [1760, 1200], sheet('appendOrUpdate', 'Publishing_Jobs', { columns: { mappingMode: 'autoMapInputData', value: {}, matchingColumns: ['publish_id'] } })),
    ],
    connections: {
      'Schedule 15m': { main: [[{ node: 'Claim Next Job Atomically', type: 'main', index: 0 }]] },
      'Claim Next Job Atomically': { main: [[{ node: 'Redact Atomic Claim For Sheet', type: 'main', index: 0 }]] },
      'Redact Atomic Claim For Sheet': { main: [[{ node: 'Mirror Atomic Claim', type: 'main', index: 0 }]] },
      'Mirror Atomic Claim': { main: [[{ node: 'Mark Uploading Atomically', type: 'main', index: 0 }]] },
      'Mark Uploading Atomically': { main: [[{ node: 'Build Provider Route', type: 'main', index: 0 }]] },
      'Build Provider Route': { main: [[{ node: 'Route Provider Stage', type: 'main', index: 0 }]] },
      'Route Provider Stage': { main: [
        [{ node: 'Verify YouTube Destination', type: 'main', index: 0 }],
        [{ node: 'Verify YouTube Destination', type: 'main', index: 0 }],
        [{ node: 'Verify YouTube Destination', type: 'main', index: 0 }],
        [{ node: 'Start Facebook Reel', type: 'main', index: 0 }],
        [{ node: 'Send Hosted Video To Facebook', type: 'main', index: 0 }],
        [{ node: 'Check Facebook Reel Status', type: 'main', index: 0 }],
        [{ node: 'Create Instagram Reel Container', type: 'main', index: 0 }],
        [{ node: 'Check Instagram Container', type: 'main', index: 0 }],
        [{ node: 'Get Instagram Reel Permalink', type: 'main', index: 0 }],
        [{ node: 'Verify TikTok Destination', type: 'main', index: 0 }],
        [{ node: 'Verify TikTok Destination', type: 'main', index: 0 }],
        [{ node: 'Build Safe Skip Reason', type: 'main', index: 0 }],
        [{ node: 'Build Ambiguous Side Effect Failure', type: 'main', index: 0 }],
        [{ node: 'Build Safe Skip Reason', type: 'main', index: 0 }],
      ] },
      'Verify YouTube Destination': { main: [[{ node: 'Confirm YouTube Destination', type: 'main', index: 0 }], [{ node: 'Build Provider Failure State', type: 'main', index: 0 }]] },
      'Confirm YouTube Destination': { main: [[{ node: 'Route Verified YouTube Stage', type: 'main', index: 0 }], [{ node: 'Build Provider Failure State', type: 'main', index: 0 }]] },
      'Route Verified YouTube Stage': { main: [[{ node: 'Start YouTube Resumable Upload', type: 'main', index: 0 }], [{ node: 'Probe YouTube Session', type: 'main', index: 0 }], [{ node: 'Check YouTube Processing', type: 'main', index: 0 }], [{ node: 'Build Provider Failure State', type: 'main', index: 0 }]] },
      'Start YouTube Resumable Upload': { main: [[{ node: 'Build YouTube Session Checkpoint', type: 'main', index: 0 }], [{ node: 'Build Provider Failure State', type: 'main', index: 0 }]] },
      'Build YouTube Session Checkpoint': { main: [[{ node: 'Save YouTube Session', type: 'main', index: 0 }], [{ node: 'Build Provider Failure State', type: 'main', index: 0 }]] },
      'Save YouTube Session': { main: [[{ node: 'Extend YouTube Upload Lease', type: 'main', index: 0 }]] },
      'Extend YouTube Upload Lease': { main: [[{ node: 'Upload YouTube Video Bytes', type: 'main', index: 0 }]] },
      'Probe YouTube Session': { main: [[{ node: 'Interpret YouTube Session', type: 'main', index: 0 }], [{ node: 'Build Provider Failure State', type: 'main', index: 0 }]] },
      'Interpret YouTube Session': { main: [[{ node: 'Route YouTube Session', type: 'main', index: 0 }], [{ node: 'Build Provider Failure State', type: 'main', index: 0 }]] },
      'Route YouTube Session': { main: [[{ node: 'Extend YouTube Resume Lease', type: 'main', index: 0 }], [{ node: 'Build YouTube Completed Session Poll', type: 'main', index: 0 }], [{ node: 'Build YouTube Retry Poll', type: 'main', index: 0 }], [{ node: 'Build Provider Failure State', type: 'main', index: 0 }]] },
      'Extend YouTube Resume Lease': { main: [[{ node: 'Upload YouTube Video Bytes', type: 'main', index: 0 }]] },
      'Build YouTube Retry Poll': { main: [[{ node: 'Route Provider Outcome', type: 'main', index: 0 }]] },
      'Upload YouTube Video Bytes': { main: [[{ node: 'Build YouTube Processing Poll', type: 'main', index: 0 }], [{ node: 'Build Provider Failure State', type: 'main', index: 0 }]] },
      'Build YouTube Processing Poll': { main: [[{ node: 'Route Provider Outcome', type: 'main', index: 0 }], [{ node: 'Build Provider Failure State', type: 'main', index: 0 }]] },
      'Build YouTube Completed Session Poll': { main: [[{ node: 'Route Provider Outcome', type: 'main', index: 0 }]] },
      'Check YouTube Processing': { main: [[{ node: 'Interpret YouTube Processing', type: 'main', index: 0 }], [{ node: 'Build Provider Failure State', type: 'main', index: 0 }]] },
      'Interpret YouTube Processing': { main: [[{ node: 'Route Provider Outcome', type: 'main', index: 0 }], [{ node: 'Build Provider Failure State', type: 'main', index: 0 }]] },
      'Start Facebook Reel': { main: [[{ node: 'Build Facebook Video Checkpoint', type: 'main', index: 0 }], [{ node: 'Build Provider Failure State', type: 'main', index: 0 }]] },
      'Build Facebook Video Checkpoint': { main: [[{ node: 'Save Facebook Video', type: 'main', index: 0 }], [{ node: 'Build Provider Failure State', type: 'main', index: 0 }]] },
      'Save Facebook Video': { main: [[{ node: 'Send Hosted Video To Facebook', type: 'main', index: 0 }]] },
      'Send Hosted Video To Facebook': { main: [[{ node: 'Confirm Facebook Hosted Upload', type: 'main', index: 0 }], [{ node: 'Build Provider Failure State', type: 'main', index: 0 }]] },
      'Confirm Facebook Hosted Upload': { main: [[{ node: 'Build Facebook Finish Intent', type: 'main', index: 0 }], [{ node: 'Build Provider Failure State', type: 'main', index: 0 }]] },
      'Build Facebook Finish Intent': { main: [[{ node: 'Save Facebook Finish Intent', type: 'main', index: 0 }]] },
      'Save Facebook Finish Intent': { main: [[{ node: 'Finish Facebook Reel', type: 'main', index: 0 }]] },
      'Finish Facebook Reel': { main: [[{ node: 'Build Facebook Processing Poll', type: 'main', index: 0 }], [{ node: 'Build Ambiguous Side Effect Failure', type: 'main', index: 0 }]] },
      'Build Facebook Processing Poll': { main: [[{ node: 'Route Provider Outcome', type: 'main', index: 0 }], [{ node: 'Build Ambiguous Side Effect Failure', type: 'main', index: 0 }]] },
      'Check Facebook Reel Status': { main: [[{ node: 'Interpret Facebook Reel Status', type: 'main', index: 0 }], [{ node: 'Build Provider Failure State', type: 'main', index: 0 }]] },
      'Interpret Facebook Reel Status': { main: [[{ node: 'Route Provider Outcome', type: 'main', index: 0 }], [{ node: 'Build Provider Failure State', type: 'main', index: 0 }]] },
      'Create Instagram Reel Container': { main: [[{ node: 'Build Instagram Container Poll', type: 'main', index: 0 }], [{ node: 'Build Provider Failure State', type: 'main', index: 0 }]] },
      'Build Instagram Container Poll': { main: [[{ node: 'Route Provider Outcome', type: 'main', index: 0 }], [{ node: 'Build Provider Failure State', type: 'main', index: 0 }]] },
      'Check Instagram Container': { main: [[{ node: 'Interpret Instagram Container', type: 'main', index: 0 }], [{ node: 'Build Provider Failure State', type: 'main', index: 0 }]] },
      'Interpret Instagram Container': { main: [[{ node: 'Route Instagram Container', type: 'main', index: 0 }], [{ node: 'Build Provider Failure State', type: 'main', index: 0 }]] },
      'Route Instagram Container': { main: [[{ node: 'Route Provider Outcome', type: 'main', index: 0 }], [{ node: 'Build Instagram Publish Intent', type: 'main', index: 0 }], [{ node: 'Build Provider Failure State', type: 'main', index: 0 }], [{ node: 'Build Provider Failure State', type: 'main', index: 0 }]] },
      'Build Instagram Publish Intent': { main: [[{ node: 'Save Instagram Publish Intent', type: 'main', index: 0 }]] },
      'Save Instagram Publish Intent': { main: [[{ node: 'Publish Instagram Reel', type: 'main', index: 0 }]] },
      'Publish Instagram Reel': { main: [[{ node: 'Build Instagram Media Checkpoint', type: 'main', index: 0 }], [{ node: 'Build Ambiguous Side Effect Failure', type: 'main', index: 0 }]] },
      'Build Instagram Media Checkpoint': { main: [[{ node: 'Save Instagram Media ID', type: 'main', index: 0 }], [{ node: 'Build Ambiguous Side Effect Failure', type: 'main', index: 0 }]] },
      'Save Instagram Media ID': { main: [[{ node: 'Get Instagram Reel Permalink', type: 'main', index: 0 }]] },
      'Get Instagram Reel Permalink': { main: [[{ node: 'Build Instagram Completion', type: 'main', index: 0 }], [{ node: 'Build Provider Failure State', type: 'main', index: 0 }]] },
      'Build Instagram Completion': { main: [[{ node: 'Route Provider Outcome', type: 'main', index: 0 }], [{ node: 'Build Provider Failure State', type: 'main', index: 0 }]] },
      'Verify TikTok Destination': { main: [[{ node: 'Confirm TikTok Destination', type: 'main', index: 0 }], [{ node: 'Build Provider Failure State', type: 'main', index: 0 }]] },
      'Confirm TikTok Destination': { main: [[{ node: 'Route Verified TikTok Stage', type: 'main', index: 0 }], [{ node: 'Build Provider Failure State', type: 'main', index: 0 }]] },
      'Route Verified TikTok Stage': { main: [[{ node: 'Build TikTok Init Intent', type: 'main', index: 0 }], [{ node: 'Check TikTok Draft Status', type: 'main', index: 0 }], [{ node: 'Build Provider Failure State', type: 'main', index: 0 }]] },
      'Build TikTok Init Intent': { main: [[{ node: 'Save TikTok Init Intent', type: 'main', index: 0 }]] },
      'Save TikTok Init Intent': { main: [[{ node: 'Start TikTok Draft Pull', type: 'main', index: 0 }]] },
      'Start TikTok Draft Pull': { main: [[{ node: 'Build TikTok Draft Poll', type: 'main', index: 0 }], [{ node: 'Build Ambiguous Side Effect Failure', type: 'main', index: 0 }]] },
      'Build TikTok Draft Poll': { main: [[{ node: 'Save TikTok Publish ID', type: 'main', index: 0 }], [{ node: 'Build Ambiguous Side Effect Failure', type: 'main', index: 0 }]] },
      'Save TikTok Publish ID': { main: [[{ node: 'Build Provider Poll State', type: 'main', index: 0 }], [{ node: 'Build Ambiguous Side Effect Failure', type: 'main', index: 0 }]] },
      'Check TikTok Draft Status': { main: [[{ node: 'Interpret TikTok Draft Status', type: 'main', index: 0 }], [{ node: 'Build Provider Failure State', type: 'main', index: 0 }]] },
      'Interpret TikTok Draft Status': { main: [[{ node: 'Route Provider Outcome', type: 'main', index: 0 }], [{ node: 'Build Provider Failure State', type: 'main', index: 0 }]] },
      'Route Provider Outcome': { main: [[{ node: 'Build Provider Poll State', type: 'main', index: 0 }], [{ node: 'Build Provider Completion State', type: 'main', index: 0 }], [{ node: 'Build Provider Failure State', type: 'main', index: 0 }], [{ node: 'Build Provider Failure State', type: 'main', index: 0 }]] },
      'Build Provider Poll State': { main: [[{ node: 'Schedule Provider Poll Atomically', type: 'main', index: 0 }], [{ node: 'Build Provider Failure State', type: 'main', index: 0 }]] },
      'Schedule Provider Poll Atomically': { main: [[{ node: 'Redact Provider Processing For Sheet', type: 'main', index: 0 }]] },
      'Redact Provider Processing For Sheet': { main: [[{ node: 'Mirror Provider Processing', type: 'main', index: 0 }]] },
      'Build Provider Completion State': { main: [[{ node: 'Complete Provider Publish Atomically', type: 'main', index: 0 }], [{ node: 'Build Provider Failure State', type: 'main', index: 0 }]] },
      'Complete Provider Publish Atomically': { main: [[{ node: 'Redact Provider Completion For Sheet', type: 'main', index: 0 }]] },
      'Redact Provider Completion For Sheet': { main: [[{ node: 'Mirror Provider Completion', type: 'main', index: 0 }]] },
      'Build Provider Failure State': { main: [[{ node: 'Save Provider Failure Atomically', type: 'main', index: 0 }]] },
      'Build Ambiguous Side Effect Failure': { main: [[{ node: 'Build Provider Failure State', type: 'main', index: 0 }]] },
      'Save Provider Failure Atomically': { main: [[{ node: 'Redact Provider Failure For Sheet', type: 'main', index: 0 }]] },
      'Redact Provider Failure For Sheet': { main: [[{ node: 'Mirror Provider Failure', type: 'main', index: 0 }]] },
      'Build Safe Skip Reason': { main: [[{ node: 'Save Safe Skip Atomically', type: 'main', index: 0 }]] },
      'Save Safe Skip Atomically': { main: [[{ node: 'Redact Safe Skip For Sheet', type: 'main', index: 0 }]] },
      'Redact Safe Skip For Sheet': { main: [[{ node: 'Mirror Safe Skip', type: 'main', index: 0 }]] },
    },
  });
}

function wf13() {
  const h = helper('publishing');
  writeWorkflow('13-publishing-credential-health.json', {
    name: 'WF13 Publishing Token Expiry Audit',
    description: 'Audits configured token-expiry metadata for enabled publishing channels and records when that metadata was checked. It does not call provider APIs or claim that credentials were tested live.',
    settings: { timezone: 'Africa/Nairobi' },
    nodes: [
      node('wf13-001', 'Schedule Daily', 'n8n-nodes-base.scheduleTrigger', 1.2, [0, 0], { rule: { interval: [{ field: 'cronExpression', expression: '0 7 * * *' }] } }),
      sheetsNode('wf13-002', 'Read Publishing_Channels', [220, 0], sheet('read', 'Publishing_Channels')),
      codeNode('wf13-003', 'Build Expiry Audit Updates', [440, 0], `${h}
const rows = buildCredentialHealthRows($input.all().map(i => i.json));
return rows.map((row, index) => ({ json: row, pairedItem: { item: index } }));`),
      sheetsNode('wf13-004', 'Update Channel Expiry Audit', [660, 0], sheet('appendOrUpdate', 'Publishing_Channels', { columns: { mappingMode: 'autoMapInputData', value: {}, matchingColumns: ['channel_id'] } })),
    ],
    connections: {
      'Schedule Daily': { main: [[{ node: 'Read Publishing_Channels', type: 'main', index: 0 }]] },
      'Read Publishing_Channels': { main: [[{ node: 'Build Expiry Audit Updates', type: 'main', index: 0 }]] },
      'Build Expiry Audit Updates': { main: [[{ node: 'Update Channel Expiry Audit', type: 'main', index: 0 }]] },
    },
  });
}

function wf14() {
  writeWorkflow('14-publishing-retry-scheduler.json', {
    name: 'WF14 Publishing Retry Scheduler',
    description: 'Atomically releases due retryable publishing jobs in Postgres and terminalizes exhausted retries, then mirrors those state changes to Google Sheets. This keeps retry timing deterministic across overlapping workers.',
    settings: { timezone: 'Africa/Nairobi' },
    nodes: [
      node('wf14-001', 'Schedule Hourly', 'n8n-nodes-base.scheduleTrigger', 1.2, [0, 0], { rule: { interval: [{ field: 'hours', hoursInterval: 1 }] } }),
      postgresNode('wf14-002', 'Release Due Retries Atomically', [220, 0], postgresSql('release-due-publishing-retries')),
      codeNode('wf14-002b', 'Redact Retry State For Sheet', [330, 0], redactProviderStateCode),
      sheetsNode('wf14-003', 'Mirror Retry State', [440, 0], sheet('appendOrUpdate', 'Publishing_Jobs', { columns: { mappingMode: 'autoMapInputData', value: {}, matchingColumns: ['publish_id'] } })),
    ],
    connections: {
      'Schedule Hourly': { main: [[{ node: 'Release Due Retries Atomically', type: 'main', index: 0 }]] },
      'Release Due Retries Atomically': { main: [[{ node: 'Redact Retry State For Sheet', type: 'main', index: 0 }]] },
      'Redact Retry State For Sheet': { main: [[{ node: 'Mirror Retry State', type: 'main', index: 0 }]] },
    },
  });
}

function wf8b() {
  const h = helper('drive-storage-transform');
  writeWorkflow('08b-created-clips-transform-backfill.json', {
    name: 'WF8b Created Clips Transform Backfill',
    nodes: [
      node('wf8b-001', 'Manual Trigger', 'n8n-nodes-base.manualTrigger', 1, [0, 0], {}),
      postgresNode('wf8b-002', 'Read Created_Clips', [220, 0], postgresSql('select-created-clips')),
      codeNode('wf8b-003', 'Backfill Transform Columns', [440, 0], `${h}
const rows = backfillTransformationPlanRows($input.all().map(i => i.json));
return rows.map((row, index) => ({ json: row, pairedItem: { item: index } }));`),
      postgresNode('wf8b-004', 'Update Created_Clips', [660, 0], postgresSql('update-clip-transformation'), ROWS),
    ],
    connections: {
      'Manual Trigger': { main: [[{ node: 'Read Created_Clips', type: 'main', index: 0 }]] },
      'Read Created_Clips': { main: [[{ node: 'Backfill Transform Columns', type: 'main', index: 0 }]] },
      'Backfill Transform Columns': { main: [[{ node: 'Update Created_Clips', type: 'main', index: 0 }]] },
    },
  });
}

function wf8d() {
  const h = helper('drive-storage-transform');
  writeWorkflow('08d-render-jobs-backfill.json', {
    name: 'WF8d Render Jobs Backfill',
    nodes: [
      node('wf8d-001', 'Manual Trigger', 'n8n-nodes-base.manualTrigger', 1, [0, 0], {}),
      postgresNode('wf8d-002', 'Read Created_Clips', [220, 0], postgresSql('select-created-clips')),
      postgresNode('wf8d-003', 'Read Render_Jobs', [440, 0], postgresSql('select-render-jobs'), '', { alwaysOutputData: true }),
      codeNode('wf8d-004', 'Build Render Jobs', [660, 0], `${h}
const created = $('Read Created_Clips').all().map(i => i.json);
const existing = $('Read Render_Jobs').all().map(i => i.json);
const rows = buildRenderJobBackfillRows(created, existing);
return rows.map((row, index) => ({ json: row, pairedItem: { item: index } }));`),
      postgresNode('wf8d-005', 'Append Render Jobs', [880, 0], postgresSql('upsert-render-jobs'), ROWS),
    ],
    connections: {
      'Manual Trigger': { main: [[{ node: 'Read Created_Clips', type: 'main', index: 0 }]] },
      'Read Created_Clips': { main: [[{ node: 'Read Render_Jobs', type: 'main', index: 0 }]] },
      'Read Render_Jobs': { main: [[{ node: 'Build Render Jobs', type: 'main', index: 0 }]] },
      'Build Render Jobs': { main: [[{ node: 'Append Render Jobs', type: 'main', index: 0 }]] },
    },
  });
}

function wf8c() {
  const h = helper('ffmpeg-render');
  const finalFolders = `{
  CHRISTIAN_CONTENT: 'GOOGLE_DRIVE_FINAL_FOLDER_CHRISTIAN_CONTENT',
  MOTIVATION_DISCIPLINE: 'GOOGLE_DRIVE_FINAL_FOLDER_MOTIVATION_DISCIPLINE',
  FINANCE_BUSINESS: 'GOOGLE_DRIVE_FINAL_FOLDER_FINANCE_BUSINESS',
  LIFE_VALUES_RELATIONSHIPS: 'GOOGLE_DRIVE_FINAL_FOLDER_LIFE_VALUES_RELATIONSHIPS',
  AFRICAN_KENYAN_SUCCESS: 'GOOGLE_DRIVE_FINAL_FOLDER_AFRICAN_KENYAN_SUCCESS',
}`;
  writeWorkflow('08c-ffmpeg-render-final-clip.json', {
    name: 'WF8c FFmpeg Render Final Clip',
    nodes: [
      node('wf8c-001', 'Schedule 15m', 'n8n-nodes-base.scheduleTrigger', 1.2, [0, 0], { rule: { interval: [{ field: 'minutes', minutesInterval: 15 }] } }),
      postgresNode('wf8c-002', 'Read Render_Jobs', [220, 0], postgresSql('select-render-jobs')),
      codeNode('wf8c-003', 'Pick Pending Render', [440, 0], `${h}
const job = pickPendingRenderJob($input.all().map(i => i.json));
return job ? [{ json: job, pairedItem: { item: 0 } }] : [];`),
      postgresNode('wf8c-004', 'Read Channel_Branding', [660, 0], postgresSql('select-channel-branding'), '', { alwaysOutputData: true }),
      postgresNode('wf8c-005', 'Read Music_Library', [880, 0], postgresSql('select-music-library'), '', { alwaysOutputData: true }),
      codeNode('wf8c-006', 'Build Asset Plan', [1100, 0], `${h}
const job = $('Pick Pending Render').first().json;
const plan = buildAssetDownloadPlan(
  job,
  $('Read Channel_Branding').all().map(i => i.json),
  $('Read Music_Library').all().map(i => i.json),
  ${finalFolders},
);
return [{ json: { ...job, ...plan }, pairedItem: { item: 0 } }];`),
      postgresNode('wf8c-007', 'Save Asset Plan', [1320, 0], postgresSql('update-render-asset-plan'), ROWS),
      ifNode('wf8c-008', 'Assets Ready?', [1540, 0], '={{ $json.render_status }}', 'DOWNLOADING_ASSETS', 'string', 'equals'),
      node('wf8c-009', 'Create Render Workspace', 'n8n-nodes-base.executeCommand', 1, [1760, -120], { command: '={{ "mkdir -p /data/jobs/" + $("Build Asset Plan").first().json.render_id }}' }),
      node('wf8c-010', 'Download Source Clip', 'n8n-nodes-base.googleDrive', 3, [1980, -120], { resource: 'file', operation: 'download', fileId: { __rl: true, mode: 'id', value: '={{ $("Build Asset Plan").first().json.source_drive_file_id }}' }, options: { binaryPropertyName: 'source' } }),
      node('wf8c-011', 'Write Source Clip', 'n8n-nodes-base.readWriteFile', 1, [2200, -120], { operation: 'write', fileName: '={{ "/data/jobs/" + $("Build Asset Plan").first().json.render_id + "/input.mp4" }}', dataPropertyName: 'source', options: {} }),
      node('wf8c-012', 'Download Watermark', 'n8n-nodes-base.googleDrive', 3, [2420, -120], { resource: 'file', operation: 'download', fileId: { __rl: true, mode: 'id', value: '={{ $("Build Asset Plan").first().json.watermark_drive_file_id }}' }, options: { binaryPropertyName: 'watermark' } }),
      node('wf8c-013', 'Write Watermark', 'n8n-nodes-base.readWriteFile', 1, [2640, -120], { operation: 'write', fileName: '={{ "/data/jobs/" + $("Build Asset Plan").first().json.render_id + "/watermark.png" }}', dataPropertyName: 'watermark', options: {} }),
      node('wf8c-014', 'Download Music', 'n8n-nodes-base.googleDrive', 3, [2860, -120], { resource: 'file', operation: 'download', fileId: { __rl: true, mode: 'id', value: '={{ $("Build Asset Plan").first().json.music_drive_file_id }}' }, options: { binaryPropertyName: 'music' } }, { onError: 'continueRegularOutput' }),
      node('wf8c-015', 'Write Music', 'n8n-nodes-base.readWriteFile', 1, [3080, -120], { operation: 'write', fileName: '={{ "/data/jobs/" + $("Build Asset Plan").first().json.render_id + "/music.mp3" }}', dataPropertyName: 'music', options: {} }, { onError: 'continueRegularOutput' }),
      codeNode('wf8c-016', 'Build FFmpeg Command', [3300, -120], `${h}
const job = $('Build Asset Plan').first().json;
const workdir = \`/data/jobs/\${job.render_id}\`;
const hasMusic = Boolean(job.music_drive_file_id);
const command = buildFfmpegCommand({
  ...job,
  workdir,
  input_path: \`\${workdir}/input.mp4\`,
  watermark_path: \`\${workdir}/watermark.png\`,
  music_path: hasMusic ? \`\${workdir}/music.mp3\` : '',
  output_path: \`\${workdir}/output.mp4\`,
  log_path: \`\${workdir}/render.log\`,
});
return [{
  json: {
    ...buildRenderStatusUpdate(job, 'RENDERING', new Date().toISOString(), {
      ffmpeg_command: command,
      final_local_path: \`\${workdir}/output.mp4\`,
    }),
    command,
  },
  pairedItem: { item: 0 },
}];`),
      postgresNode('wf8c-017', 'Mark Rendering', [3520, -120], postgresSql('update-render-status'), ROWS),
      node('wf8c-018', 'Run FFmpeg', 'n8n-nodes-base.executeCommand', 1, [3740, -120], { command: '={{ $json.command }}' }, { onError: 'continueRegularOutput' }),
      codeNode('wf8c-019', 'Mark Uploading', [3960, -120], `${h}
const job = $('Build Asset Plan').first().json;
return [{ json: buildRenderStatusUpdate(job, 'UPLOADING'), pairedItem: { item: 0 } }];`),
      postgresNode('wf8c-020', 'Save Uploading', [4180, -120], postgresSql('update-render-status'), ROWS),
      node('wf8c-021', 'Read Final Output', 'n8n-nodes-base.readWriteFile', 1, [4400, -120], { operation: 'read', fileSelector: '={{ "/data/jobs/" + $("Build Asset Plan").first().json.render_id + "/output.mp4" }}', options: { dataPropertyName: 'data' } }),
      node('wf8c-022', 'Upload Final To Drive', 'n8n-nodes-base.googleDrive', 3, [4620, -120], { resource: 'file', operation: 'upload', name: '={{ $("Build Asset Plan").first().json.render_id }}_final.mp4', driveId: { __rl: true, mode: 'list', value: 'My Drive' }, folderId: { __rl: true, mode: 'id', value: '={{ $("Build Asset Plan").first().json.final_drive_folder_id }}' }, inputDataFieldName: 'data', options: {} }),
      codeNode('wf8c-023', 'Build Completed Update', [4840, -120], `${h}
const job = $('Build Asset Plan').first().json;
const drive = $input.first().json;
return [{ json: buildCompletedRenderUpdate(job, drive), pairedItem: { item: 0 } }];`),
      postgresNode('wf8c-024', 'Mark Render Completed', [5060, -120], postgresSql('update-render-completed'), ROWS),
      codeNode('wf8c-025', 'Build Asset Failure', [1760, 160], `${h}
const job = $('Build Asset Plan').first().json;
return [{ json: buildRenderFailureUpdate(job, job.error_message || 'Render asset setup failed'), pairedItem: { item: 0 } }];`),
      postgresNode('wf8c-026', 'Mark Asset Failure', [1980, 160], postgresSql('update-render-failed'), ROWS),
    ],
    connections: {
      'Schedule 15m': { main: [[{ node: 'Read Render_Jobs', type: 'main', index: 0 }]] },
      'Read Render_Jobs': { main: [[{ node: 'Pick Pending Render', type: 'main', index: 0 }]] },
      'Pick Pending Render': { main: [[{ node: 'Read Channel_Branding', type: 'main', index: 0 }]] },
      'Read Channel_Branding': { main: [[{ node: 'Read Music_Library', type: 'main', index: 0 }]] },
      'Read Music_Library': { main: [[{ node: 'Build Asset Plan', type: 'main', index: 0 }]] },
      'Build Asset Plan': { main: [[{ node: 'Save Asset Plan', type: 'main', index: 0 }]] },
      'Save Asset Plan': { main: [[{ node: 'Assets Ready?', type: 'main', index: 0 }]] },
      'Assets Ready?': { main: [[{ node: 'Create Render Workspace', type: 'main', index: 0 }], [{ node: 'Build Asset Failure', type: 'main', index: 0 }]] },
      'Create Render Workspace': { main: [[{ node: 'Download Source Clip', type: 'main', index: 0 }]] },
      'Download Source Clip': { main: [[{ node: 'Write Source Clip', type: 'main', index: 0 }]] },
      'Write Source Clip': { main: [[{ node: 'Download Watermark', type: 'main', index: 0 }]] },
      'Download Watermark': { main: [[{ node: 'Write Watermark', type: 'main', index: 0 }]] },
      'Write Watermark': { main: [[{ node: 'Download Music', type: 'main', index: 0 }]] },
      'Download Music': { main: [[{ node: 'Write Music', type: 'main', index: 0 }]] },
      'Write Music': { main: [[{ node: 'Build FFmpeg Command', type: 'main', index: 0 }]] },
      'Build FFmpeg Command': { main: [[{ node: 'Mark Rendering', type: 'main', index: 0 }]] },
      'Mark Rendering': { main: [[{ node: 'Run FFmpeg', type: 'main', index: 0 }]] },
      'Run FFmpeg': { main: [[{ node: 'Mark Uploading', type: 'main', index: 0 }]] },
      'Mark Uploading': { main: [[{ node: 'Save Uploading', type: 'main', index: 0 }]] },
      'Save Uploading': { main: [[{ node: 'Read Final Output', type: 'main', index: 0 }]] },
      'Read Final Output': { main: [[{ node: 'Upload Final To Drive', type: 'main', index: 0 }]] },
      'Upload Final To Drive': { main: [[{ node: 'Build Completed Update', type: 'main', index: 0 }]] },
      'Build Completed Update': { main: [[{ node: 'Mark Render Completed', type: 'main', index: 0 }]] },
      'Build Asset Failure': { main: [[{ node: 'Mark Asset Failure', type: 'main', index: 0 }]] },
    },
  });
}

function generateAll() {
  wf6();
  wf8();
  wf8b();
  wf8c();
  wf8d();
  wf9();
  wf11();
  wf12();
  wf13();
  wf14();
}

if (require.main === module) generateAll();

module.exports = { generateAll };
