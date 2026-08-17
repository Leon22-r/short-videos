const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const repoRoot = path.resolve(__dirname, '..');

function readWorkflow(outputDir, fileName) {
  return JSON.parse(fs.readFileSync(path.join(outputDir, fileName), 'utf8'));
}

test('remaining workflow generator is config-neutral and provider-terminal-state safe', (t) => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'short-videos-workflows-'));
  t.after(() => fs.rmSync(outputDir, { recursive: true, force: true }));

  const generatorPath = path.join(repoRoot, 'n8n/workflow-code/create-remaining-workflows.js');
  const previousOutputDir = process.env.N8N_WORKFLOW_OUTPUT_DIR;
  process.env.N8N_WORKFLOW_OUTPUT_DIR = outputDir;
  delete require.cache[require.resolve(generatorPath)];
  try {
    require(generatorPath).generateAll();
  } finally {
    if (previousOutputDir === undefined) delete process.env.N8N_WORKFLOW_OUTPUT_DIR;
    else process.env.N8N_WORKFLOW_OUTPUT_DIR = previousOutputDir;
  }

  const generatedFiles = fs.readdirSync(outputDir).filter((file) => file.endsWith('.json'));
  assert(generatedFiles.length > 0);

  for (const fileName of generatedFiles) {
    const workflow = readWorkflow(outputDir, fileName);
    const sheetsNodes = workflow.nodes.filter((node) => node.type === 'n8n-nodes-base.googleSheets');
    for (const sheetsNode of sheetsNodes) {
      assert.equal(sheetsNode.parameters.documentId.value, 'GOOGLE_SHEETS_DOCUMENT_ID', `${fileName}: Sheet ID must remain deploy-time configuration`);
      assert.equal(sheetsNode.retryOnFail, true, `${fileName}: Google Sheets calls should retry transient failures`);
      assert.equal(sheetsNode.maxTries, 3);
      assert.equal(sheetsNode.waitBetweenTries, 5000);
    }
  }

  const publishingFiles = [
    '11-build-publishing-jobs.json',
    '12-publish-to-platforms.json',
    '13-publishing-credential-health.json',
    '14-publishing-retry-scheduler.json',
  ];
  for (const fileName of publishingFiles) {
    const workflow = readWorkflow(outputDir, fileName);
    assert(String(workflow.description || '').trim().length >= 40, `${fileName}: description should explain its safety boundary`);
  }

  const wf12 = readWorkflow(outputDir, '12-publish-to-platforms.json');
  const wf12Names = wf12.nodes.map((node) => node.name);
  assert(wf12.nodes.some((node) => node.name === 'Start YouTube Resumable Upload'));
  assert(wf12.nodes.some((node) => node.name === 'Check YouTube Processing'));
  assert(wf12.nodes.some((node) => node.name === 'Start Facebook Reel'));
  assert(wf12.nodes.some((node) => node.name === 'Check Facebook Reel Status'));
  assert(wf12.nodes.some((node) => node.name === 'Create Instagram Reel Container'));
  assert(wf12.nodes.some((node) => node.name === 'Publish Instagram Reel'));
  assert(wf12.nodes.some((node) => node.name === 'Start TikTok Draft Pull'));
  assert(wf12.nodes.some((node) => node.name === 'Check TikTok Draft Status'));
  assert(wf12Names.includes('Schedule Provider Poll Atomically'));
  assert(wf12Names.includes('Complete Provider Publish Atomically'));
  assert.equal(wf12.connections['Claim Next Job Atomically'].main[0][0].node, 'Redact Atomic Claim For Sheet');
  assert.equal(wf12.connections['Redact Atomic Claim For Sheet'].main[0][0].node, 'Mirror Atomic Claim');
  assert.equal(wf12.connections['Mirror Atomic Claim'].main[0][0].node, 'Mark Uploading Atomically');

  const claimNode = wf12.nodes.find((node) => node.name === 'Claim Next Job Atomically');
  const safeSkipCode = wf12.nodes.find((node) => node.name === 'Build Safe Skip Reason').parameters.jsCode;
  const safeSkipNode = wf12.nodes.find((node) => node.name === 'Save Safe Skip Atomically');
  assert.equal(claimNode.type, 'n8n-nodes-base.postgres');
  assert.equal(claimNode.typeVersion, 2.6);
  assert.match(claimNode.parameters.query, /FOR UPDATE SKIP LOCKED/);
  assert.match(claimNode.parameters.query, /existing_claim/);
  assert.match(claimNode.parameters.options.queryReplacement, /\$execution\.id/);
  assert.match(safeSkipNode.parameters.query, /claimed_by = \$2/);
  assert.match(safeSkipCode, /UNSUPPORTED_PROVIDER_STATE/);
  const routeCode = wf12.nodes.find((node) => node.name === 'Build Provider Route').parameters.jsCode;
  assert.match(routeCode, /validateProviderJob/);
  assert.match(routeCode, /TIKTOK_DIRECT_REQUIRES_CREATOR_UI_AND_CONSENT/);
  assert.match(routeCode, /FACEBOOK_FINISH_REQUESTED/);
  assert.match(routeCode, /INSTAGRAM_PUBLISH_REQUESTED/);
  assert.match(routeCode, /TIKTOK_INIT_REQUESTED/);
  for (const requestNode of wf12.nodes.filter((node) => node.type === 'n8n-nodes-base.httpRequest')) {
    assert(requestNode.credentials, `${requestNode.name}: provider credentials must use n8n credential references`);
    assert.doesNotMatch(JSON.stringify(requestNode.parameters), /Bearer\s+[A-Za-z0-9._-]+|access_token|client_secret/i);
  }
  assert(wf12Names.includes('Verify YouTube Destination'));
  assert(wf12Names.includes('Verify TikTok Destination'));
  assert(wf12Names.includes('Extend YouTube Upload Lease'));
  assert(wf12Names.includes('Build Ambiguous Side Effect Failure'));
  assert(wf12Names.includes('Save TikTok Publish ID'));
  assert.equal(wf12.nodes.some((node) => node.name === 'Read YouTube Video'), false);
  assert.doesNotMatch(JSON.stringify(wf12), /getBinaryDataBuffer|toString\('base64'\)/);
  assert.match(wf12.nodes.find((node) => node.name === 'Upload YouTube Video Bytes').parameters.url, /provider-uploader/);
  for (const sheetNode of wf12.nodes.filter((node) => node.type === 'n8n-nodes-base.googleSheets')) {
    const source = Object.entries(wf12.connections).find(([, outputs]) => JSON.stringify(outputs).includes(`\"node\":\"${sheetNode.name}\"`))?.[0] || '';
    assert.match(source, /^Redact /, `${sheetNode.name}: every Sheet mirror must receive a redacted row`);
  }
  assert.match(wf12.nodes.find((node) => node.name === 'Confirm YouTube Destination').parameters.jsCode, /credential channel mismatch/);

  const nodeNames = new Set(wf12.nodes.map((node) => node.name));
  for (const [source, outputs] of Object.entries(wf12.connections)) {
    assert(nodeNames.has(source), `connection source must exist: ${source}`);
    for (const output of outputs.main || []) {
      for (const target of output || []) assert(nodeNames.has(target.node), `${source} targets missing node ${target.node}`);
    }
  }
  for (const fallible of wf12.nodes.filter((node) => node.onError === 'continueErrorOutput')) {
    assert((wf12.connections[fallible.name]?.main?.[1] || []).length > 0, `${fallible.name}: error output must be wired`);
  }

  const wf11 = readWorkflow(outputDir, '11-build-publishing-jobs.json');
  const syncNode = wf11.nodes.find((node) => node.name === 'Sync Atomic Publishing Queue');
  assert.equal(syncNode.type, 'n8n-nodes-base.postgres');
  assert.match(syncNode.parameters.query, /ON CONFLICT \(publish_id\) DO UPDATE/);

  const wf14 = readWorkflow(outputDir, '14-publishing-retry-scheduler.json');
  assert.equal(wf14.nodes.find((node) => node.name === 'Release Due Retries Atomically').type, 'n8n-nodes-base.postgres');

  const wf13 = readWorkflow(outputDir, '13-publishing-credential-health.json');
  assert.equal(wf13.name, 'WF13 Publishing Token Expiry Audit');
  assert.match(wf13.description, /does not call provider APIs/i);
  assert.doesNotMatch(JSON.stringify(wf13), /last_token_test_at/);
  assert.match(JSON.stringify(wf13), /last_expiry_audit_at/);
});
