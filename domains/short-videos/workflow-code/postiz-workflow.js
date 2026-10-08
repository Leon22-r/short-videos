// Additive WF12 backend. Kept separate from direct-provider wiring so existing
// in-flight provider checkpoints continue to use their original implementation.
function extendPostizWorkflow(workflow, tools) {
  const { helper, postgresSql, postgresNode, httpNode, codeNode, fallibleCodeNode, switchNode, fullJsonResponse, credentialRef } = tools;
  const h = helper('postiz-publishing');
  const byName = (name) => workflow.nodes.find((node) => node.name === name);
  const base = process.env.POSTIZ_PUBLIC_API_BASE_URL || 'http://postiz:5000/api/public/v1';
  const url = new URL(base);
  if ((url.protocol !== 'https:' && base !== 'http://postiz:5000/api/public/v1') ||
      url.username || url.password || url.search || url.hash || !url.pathname.endsWith('/public/v1')) {
    throw new Error('POSTIZ_PUBLIC_API_BASE_URL must be a trusted HTTPS public/v1 endpoint or the private Docker default');
  }
  const auth = { authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth' };
  const credentials = credentialRef('httpHeaderAuth', 'POSTIZ_API_CREDENTIAL_ID', 'Postiz Public API');
  const ref = (name) => `$('${name}').first().json`;
  const job = ref('Build Provider Route');
  const edge = (name) => [{ node: name, type: 'main', index: 0 }];
  const connect = (from, to, error) => { workflow.connections[from] = { main: [edge(to), ...(error ? [edge(error)] : [])] }; };
  const add = (node) => { workflow.nodes.push(node); return node; };
  let index = 0;
  const position = () => [1320 + (index++ % 6) * 250, 1450 + Math.floor((index - 1) / 6) * 200];
  const code = (name, source, fallible = true) => add((fallible ? fallibleCodeNode : codeNode)(`wf12-postiz-${index}`, name, position(), `${h}\n${source}`));
  const sql = (name, query, params, retry = true) => {
    const n = add(postgresNode(`wf12-postiz-${index}`, name, position(), postgresSql(query), `={{ [${params.join(', ')}] }}`, { retryOnFail: retry }));
    n.parameters.options.replaceEmptyStrings = false;
    return n;
  };
  const http = (name, method, endpoint, extra = {}) => add(httpNode(`wf12-postiz-${index}`, name, position(), {
    method, url: `${base}${endpoint}`, ...auth,
    options: { ...fullJsonResponse(false, method === 'GET' ? 60000 : 300000), redirect: { redirect: { followRedirects: false } } },
    ...extra,
  }, { credentials, onError: 'continueErrorOutput', retryOnFail: method === 'GET', maxTries: 3, waitBetweenTries: 5000 }));

  const routeNode = byName('Build Provider Route');
  // Postiz routing happens before the legacy validator, whose platform-specific
  // OAuth/media requirements do not apply to Postiz integration IDs.
  routeNode.parameters.jsCode = `${h}\nconst backendJob = $('Mark Uploading Atomically').first().json;
const backend = String(backendJob.publishing_backend || 'DIRECT').toUpperCase();
if (backend === 'POSTIZ') {
  const validation = validatePostizJob(backendJob);
  return [{ json: { ...backendJob, ...validation, last_error: validation.reason || '' }, pairedItem: { item: 0 } }];
}
if (backend !== 'DIRECT' || String(backendJob.provider_stage || '').startsWith('POSTIZ_')) {
  return [{ json: { ...backendJob, route: 'SKIP', last_error: 'UNSUPPORTED_PUBLISHING_BACKEND_OR_CHECKPOINT' }, pairedItem: { item: 0 } }];
}
${routeNode.parameters.jsCode}`;
  // HTTP errors may contain signed media URLs or request payloads. Keep those
  // diagnostics in execution access controls, never the operator Sheet mirror.
  const failure = byName('Build Provider Failure State');
  failure.parameters.jsCode = failure.parameters.jsCode.replace('const input = $input.first().json;', `const rawInput = $input.first().json;
const postizFailureClass = classifyError(rawInput.error || rawInput.message || rawInput).status;
const input = job.publishing_backend === 'POSTIZ' ? {
  outcome: ['FAILED', 'REJECTED', 'AUTH_REQUIRED'].includes(rawInput.outcome) ? rawInput.outcome : postizFailureClass,
  error: postizFailureClass === 'AUTH_REQUIRED' ? 'POSTIZ_AUTH_REQUIRED: check the configured credential'
    : postizFailureClass === 'REJECTED' ? 'POSTIZ_REJECTED: inspect execution before retry'
    : job.postiz_submitted_at || rawInput.outcome === 'FAILED'
    ? 'POSTIZ_RECONCILIATION_REQUIRED: inspect execution and saved intent before retry'
    : 'POSTIZ_PRE_SUBMISSION_FAILED: inspect execution before retry',
  provider_response: { reason: 'POSTIZ_OPERATION_FAILED' },
} : rawInput;`);
  const ambiguous = byName('Build Ambiguous Side Effect Failure');
  ambiguous.parameters.jsCode = `if (${job}.publishing_backend === 'POSTIZ') {
  return [{ json: { outcome: 'FAILED', error: 'POSTIZ_AMBIGUOUS_SUBMISSION', provider_response: { reason: 'POSTIZ_AMBIGUOUS_SUBMISSION' } }, pairedItem: { item: 0 } }];
}\n${ambiguous.parameters.jsCode}`;
  const extraRoutes = switchNode('unused', 'unused', [0, 0], '={{ $json.route }}', ['POSTIZ_PREPARE', 'POSTIZ_POLL']);
  byName('Route Provider Stage').parameters.rules.values.push(...extraRoutes.parameters.rules.values);
  workflow.connections['Route Provider Stage'].main.splice(-1, 0, edge('Check Postiz Integration'), edge('List Postiz Posts'));

  http('Check Postiz Integration', 'GET', '/integrations');
  code('Confirm Postiz Integration', `const row = confirmPostizIntegration(${job}, $input.first().json);
return [{ json: { ...row, media_route: row.provider_stage === 'POSTIZ_MEDIA_READY' ? 'READY' : 'UPLOAD' }, pairedItem: { item: 0 } }];`);
  add(switchNode('wf12-postiz-media-route', 'Route Postiz Media', position(), `={{ ${ref('Confirm Postiz Integration')}.media_route }}`, ['UPLOAD', 'READY']));
  http('Import Postiz Video', 'POST', '/upload-from-url', {
    sendBody: true, contentType: 'json', specifyBody: 'json',
    jsonBody: `={{ { url: ${ref('Confirm Postiz Integration')}.public_video_url } }}`,
  });
  code('Validate Postiz Media', `return [{ json: parsePostizMedia($input.first().json), pairedItem: { item: 0 } }];`);
  sql('Save Postiz Media', 'save-postiz-media', [`${job}.publish_id`, `${job}.claimed_by`, `${ref('Validate Postiz Media')}.postiz_media_id`, `${ref('Validate Postiz Media')}.postiz_media_path`]);
  // Both branches carry the complete queue row, either the saved media checkpoint
  // or the already-persisted row. This Code node joins the state with API schema.
  code('Build Postiz Submission', `const row = $input.first().json;
return [{ json: { ...row, submission_payload: buildPostizPayload(row) }, pairedItem: { item: 0 } }];`);
  sql('Begin Postiz Submission', 'begin-postiz-submit', [`${job}.publish_id`, `${job}.claimed_by`, `JSON.stringify(${ref('Build Postiz Submission')}.submission_payload)`], false);
  http('Create Postiz Post', 'POST', '/posts', {
    sendBody: true, contentType: 'json', specifyBody: 'json',
    jsonBody: `={{ ${ref('Begin Postiz Submission')}.postiz_submit_payload }}`,
  });
  code('Validate Postiz Submission', `return [{ json: parsePostizSubmission(${job}, $input.first().json), pairedItem: { item: 0 } }];`);
  sql('Save Postiz Submission', 'save-postiz-submission', [`${job}.publish_id`, `${job}.claimed_by`, `${ref('Validate Postiz Submission')}.postiz_post_id`, `JSON.stringify(${ref('Validate Postiz Submission')})`]);
  code('Build Initial Postiz Poll', `const row = ${ref('Save Postiz Submission')};
return [{ json: { ...row, provider_stage: 'POSTIZ_SUBMITTED', provider_ref: row.postiz_post_id, provider_response: {} }, pairedItem: { item: 0 } }];`);
  // Persisted intent time bounds the lookup. We never search by caption or infer
  // that an empty list means a previous create did not succeed.
  http('List Postiz Posts', 'GET', '/posts', {
    sendQuery: true, queryParameters: { parameters: [
      { name: 'startDate', value: `={{ DateTime.fromISO(${job}.postiz_submitted_at).minus({ days: 1 }).toISO() }}` },
      { name: 'endDate', value: '={{ $now.plus({ days: 1 }).toISO() }}' },
    ] },
  });
  code('Interpret Postiz Post', `const result = interpretPostizStatus(${job}, $input.first().json);
return [{ json: { ...result, provider_stage: 'POSTIZ_SUBMITTED', provider_ref: ${job}.postiz_post_id, provider_response: { postiz_post_id: ${job}.postiz_post_id, ...result } }, pairedItem: { item: 0 } }];`);
  add(switchNode('wf12-postiz-outcome', 'Route Postiz Outcome', position(), `={{ ${ref('Interpret Postiz Post')}.action }}`, ['POLL', 'COMPLETE', 'FAIL']));
  code('Build Postiz Read Retry', `return [{ json: { provider_stage: 'POSTIZ_SUBMITTED', provider_ref: ${job}.postiz_post_id, provider_response: { reason: 'POSTIZ_READ_FAILED_OR_INVALID_RESPONSE' } }, pairedItem: { item: 0 } }];`, false);
  code('Build Postiz Poll State', `const input = $input.first().json;
return [{ json: { publish_id: ${job}.publish_id, claimed_by: ${job}.claimed_by, provider_stage: 'POSTIZ_SUBMITTED', provider_ref: input.provider_ref, provider_response: JSON.stringify(input.provider_response || {}) }, pairedItem: { item: 0 } }];`, false);
  sql('Schedule Postiz Poll', 'schedule-provider-poll', [`${ref('Build Postiz Poll State')}.publish_id`, `${ref('Build Postiz Poll State')}.claimed_by`, `'POSTIZ_SUBMITTED'`, `${ref('Build Postiz Poll State')}.provider_ref`, `${ref('Build Postiz Poll State')}.provider_response`, '2']);
  sql('Complete Postiz Publish', 'complete-postiz-publish', [`${job}.publish_id`, `${job}.claimed_by`, `${ref('Interpret Postiz Post')}.outcome`, `${ref('Interpret Postiz Post')}.post_id || ''`, `${ref('Interpret Postiz Post')}.post_url || ''`, `JSON.stringify(${ref('Interpret Postiz Post')}.provider_response)`]);

  connect('Check Postiz Integration', 'Confirm Postiz Integration', 'Build Provider Failure State');
  connect('Confirm Postiz Integration', 'Route Postiz Media', 'Build Provider Failure State');
  workflow.connections['Route Postiz Media'] = { main: [edge('Import Postiz Video'), edge('Build Postiz Submission'), edge('Build Provider Failure State')] };
  connect('Import Postiz Video', 'Validate Postiz Media', 'Build Provider Failure State');
  connect('Validate Postiz Media', 'Save Postiz Media', 'Build Provider Failure State');
  connect('Save Postiz Media', 'Build Postiz Submission');
  connect('Build Postiz Submission', 'Begin Postiz Submission', 'Build Provider Failure State');
  connect('Begin Postiz Submission', 'Create Postiz Post');
  connect('Create Postiz Post', 'Validate Postiz Submission', 'Build Ambiguous Side Effect Failure');
  connect('Validate Postiz Submission', 'Save Postiz Submission', 'Build Ambiguous Side Effect Failure');
  connect('Save Postiz Submission', 'Build Initial Postiz Poll');
  connect('Build Initial Postiz Poll', 'Build Postiz Poll State', 'Build Provider Failure State');
  connect('List Postiz Posts', 'Interpret Postiz Post', 'Build Postiz Read Retry');
  connect('Interpret Postiz Post', 'Route Postiz Outcome', 'Build Postiz Read Retry');
  workflow.connections['Route Postiz Outcome'] = { main: [edge('Build Postiz Poll State'), edge('Complete Postiz Publish'), edge('Build Provider Failure State'), edge('Build Provider Failure State')] };
  connect('Build Postiz Read Retry', 'Build Postiz Poll State');
  connect('Build Postiz Poll State', 'Schedule Postiz Poll');
  // The Sheets mirror these two fed is gone (D1): Postgres was always the
  // publishing queue's source of truth, and the mirror only existed for the
  // operator to read. Both writes are terminal now.
  workflow.description += ' Opt-in POSTIZ jobs use a durable single-attempt handoff and identity-checked status reconciliation; existing DIRECT jobs keep their provider route.';
  workflow.settings.errorWorkflow = 'WF10_ERROR_HANDLER_WORKFLOW_ID';
  workflow.active = false;
}

module.exports = { extendPostizWorkflow };
