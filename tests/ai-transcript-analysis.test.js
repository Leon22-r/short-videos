const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const test = require('node:test');
const {
  ANALYSIS_SCHEMA,
  buildAnalysisRequest,
  buildMissingWindowMoments,
  parseAndGate,
  pickUnanalyzed,
} = require('../n8n/workflow-code/ai-transcript-analysis');
const fixtures = require('./fixtures/wf5-ai-responses');
const workflow = require('../n8n/workflows/05-ai-transcript-analysis.json');

const baseRow = {
  analysis_id: 'AN-video1234567',
  video_id: 'VID-video1234567',
  video_title: 'Useful interview',
  video_url: 'https://www.youtube.com/watch?v=video1234567',
  niche: 'FINANCE_BUSINESS',
  transcript_status: 'FETCHED',
  transcript_text: '[00:00] hello world',
  ai_episode_score: '',
  processing_status: 'NEW',
  source_risk: 'low',
};

function clip(overrides = {}) {
  return {
    rank: 1,
    start_sec: 60,
    end_sec: 130,
    clip_length_seconds: 70,
    clip_score: 8,
    hook_first_2_seconds: 'Stop wasting money',
    core_idea: 'Budgeting matters',
    why_it_is_valuable: 'Practical money lesson',
    best_target_audience: 'Young professionals',
    suggested_title: 'Budget better',
    suggested_caption: 'Simple budget habit',
    on_screen_text: 'Track every shilling',
    suggested_b_roll: ['M-Pesa statement'],
    my_original_commentary_angle: 'Kenyan personal finance framing',
    kenyan_african_application: 'Use M-Pesa statements and MMFs',
    bible_verse_if_relevant: null,
    monetization_risk: 'low',
    copyright_or_reused_content_risk: 'low',
    does_it_need_extra_context: false,
    originality_score: 8,
    final_recommendation: 'clip',
    ...overrides,
  };
}

function ai(overrides = {}) {
  return {
    overall_episode_score: 8,
    recommended_strategy: 'USE_EXACT_CLIPS_ONLY',
    reason_for_strategy: 'Scattered strong clips',
    best_20_min_window: {
      use_this: false,
      start_sec: 0,
      end_sec: 1200,
      why_this_window: '',
      estimated_number_of_good_clips: 0,
    },
    exact_clips: [clip()],
    risk_notes: 'Kenya relevant',
    ...overrides,
  };
}

test('picks fetched unanalyzed transcripts and joins source risk', () => {
  const rows = pickUnanalyzed(
    [
      { ...baseRow, video_id: 'VID-1' },
      { ...baseRow, video_id: 'VID-2', ai_episode_score: 8 },
      { ...baseRow, video_id: 'VID-3', transcript_status: 'FAILED' },
    ],
    [{ source_id: 'SRC-1', risk_level: 'high' }],
    [{ video_id: 'VID-1', source_id: 'SRC-1', processing_status: 'READY_FOR_ANALYSIS' }],
  );

  assert.equal(rows.length, 1);
  assert.equal(rows[0].source_risk, 'high');
  assert.equal(rows[0].processing_status, 'READY_FOR_ANALYSIS');
});

test('pickUnanalyzed preserves full transcript Drive fields', () => {
  const rows = pickUnanalyzed(
    [{
      ...baseRow,
      transcript_full_url: 'https://drive.google.com/file/d/file-1/view',
      transcript_full_file_id: 'file-1',
    }],
    [],
    [{ video_id: baseRow.video_id, source_id: 'SRC-1' }],
  );

  assert.equal(rows.length, 1);
  assert.equal(rows[0].transcript_full_url, 'https://drive.google.com/file/d/file-1/view');
  assert.equal(rows[0].transcript_full_file_id, 'file-1');
});

test('pickUnanalyzed selects AI analysis rows fairly by source', () => {
  const analysisRows = [
    ...Array.from({ length: 4 }, (_, index) => ({
      ...baseRow,
      analysis_id: `AN-A-${index}`,
      video_id: `VID-A-${index}`,
      transcript_status: 'FETCHED',
      ai_episode_score: '',
      created_at: `2026-06-27T00:0${index}:00.000Z`,
    })),
    ...Array.from({ length: 2 }, (_, index) => ({
      ...baseRow,
      analysis_id: `AN-B-${index}`,
      video_id: `VID-B-${index}`,
      transcript_status: 'FETCHED',
      ai_episode_score: '',
      created_at: `2026-06-27T00:0${index}:00.000Z`,
    })),
  ];
  const candidates = [
    ...Array.from({ length: 4 }, (_, index) => ({ video_id: `VID-A-${index}`, source_id: 'SRC-A' })),
    ...Array.from({ length: 2 }, (_, index) => ({ video_id: `VID-B-${index}`, source_id: 'SRC-B' })),
  ];

  const picked = pickUnanalyzed(analysisRows, [], candidates, { limit: 5, perSourceLimit: 1 });

  assert.deepEqual(picked.map((row) => row.video_id), ['VID-A-0', 'VID-B-0']);
});

test('pickUnanalyzed balances AI analysis by niche before taking extra rows from one niche', () => {
  const analysisRows = [
    ...['VID-FA1', 'VID-FA2', 'VID-FB1', 'VID-CA1'].map((videoId, index) => ({
      ...baseRow,
      analysis_id: `AN-${videoId}`,
      video_id: videoId,
      transcript_status: 'FETCHED',
      ai_episode_score: '',
      created_at: `2026-06-27T00:0${index + 1}:00.000Z`,
    })),
  ];
  const candidates = [
    { video_id: 'VID-FA1', niche: 'FINANCE_BUSINESS', source_id: 'SRC-FA' },
    { video_id: 'VID-FA2', niche: 'FINANCE_BUSINESS', source_id: 'SRC-FA' },
    { video_id: 'VID-FB1', niche: 'FINANCE_BUSINESS', source_id: 'SRC-FB' },
    { video_id: 'VID-CA1', niche: 'CHRISTIAN_CONTENT', source_id: 'SRC-CA' },
  ];

  const picked = pickUnanalyzed(analysisRows, [], candidates, { limit: 3, perSourceLimit: 2 });

  assert.deepEqual(picked.map((row) => row.video_id), ['VID-FA1', 'VID-CA1', 'VID-FB1']);
});

test('builds OpenAI app node analysis inputs', () => {
  const result = buildAnalysisRequest(baseRow);

  assert.equal(ANALYSIS_SCHEMA.properties.output, undefined);
  assert.deepEqual(ANALYSIS_SCHEMA.properties.overall_episode_score, {
    type: 'number', minimum: 0, maximum: 10,
  });
  assert.equal(ANALYSIS_SCHEMA.properties.best_20_min_window, undefined);
  assert.equal(ANALYSIS_SCHEMA.properties.best_20_min_windows.type, 'array');
  assert.equal(ANALYSIS_SCHEMA.properties.best_20_min_windows.maxItems, 5);
  assert.equal(result.video_id, baseRow.video_id);
  assert.equal(result.openai_model, 'gpt-4o-mini');
  assert.deepEqual(JSON.parse(result.analysis_schema), ANALYSIS_SCHEMA);
  assert.match(result.system_message, /content strategist/);
  assert.match(result.system_message, /Default to USE_EXACT_CLIPS_ONLY/);
  assert.match(result.system_message, /Return the best exact 45-90 second clips directly/);
  assert.match(result.system_message, /USE_20_MIN_WINDOW only as optional analysis context/);
  assert.match(result.system_message, /yt-dlp, which only downloads exact time ranges/);
  assert.match(result.user_message, /FINANCE_BUSINESS/);
  assert.match(result.user_message, /"overall_episode_score"/);
  assert.match(result.user_message, /Return the bare analysis object/);
  assert.match(result.user_message, /Do not use Markdown code fences/);
  assert.doesNotMatch(result.user_message, /top-level object must have exactly one key named "output"/);
  assert.doesNotMatch(result.user_message, /```json/);
  assert.match(result.user_message, /raw seconds from the beginning/);
  assert.match(result.user_message, /minute 5.*300/i);
  assert.match(result.user_message, /USE_20_MIN_WINDOW.*best_20_min_windows/i);
  assert.match(result.user_message, /exact_clips.*45-90 second clips inside the selected windows/i);
  assert.match(result.user_message, /For SKIP_THIS_VIDEO.*empty best_20_min_windows array/i);
  assert.match(result.user_message, /USE_EXACT_CLIPS_ONLY.*at least one 45-90 second clip/);
});

test('buildAnalysisRequest uses full transcript text before preview fallback', () => {
  const fullTail = 'late transcript marker at minute 100';
  const result = buildAnalysisRequest({
    ...baseRow,
    transcript_text: '[00:00] preview only',
    transcript_full: `[00:00] preview only\n[100:00] ${fullTail}`,
  });

  assert.match(result.user_message, new RegExp(fullTail));
  assert.doesNotMatch(result.user_message, /\[00:00\] preview only$/);
});

test('parses output wrapper responses', () => {
  const result = parseAndGate(baseRow, { output: ai() });

  assert.equal(result.analysisUpdate.recommended_strategy, 'USE_EXACT_CLIPS_ONLY');
  assert.equal(result.momentRows.length, 1);
});

test('parses official OpenAI node fenced output text responses', () => {
  const response = {
    id: 'msg_123',
    type: 'message',
    status: 'completed',
    content: [{
      type: 'output_text',
      text: `\`\`\`json
{
  "output": ${JSON.stringify(ai())}
}
\`\`\``,
    }],
    role: 'assistant',
  };

  const result = parseAndGate(baseRow, response);

  assert.equal(result.analysisUpdate.recommended_strategy, 'USE_EXACT_CLIPS_ONLY');
  assert.equal(result.momentRows.length, 1);
});

test('parses array-wrapped official OpenAI node output', () => {
  const response = [{
    id: 'msg_123',
    type: 'message',
    status: 'completed',
    content: [{
      type: 'output_text',
      annotations: [],
      logprobs: [],
      text: `\`\`\`json
{
  "output": ${JSON.stringify(ai({
    recommended_strategy: 'USE_20_MIN_WINDOW',
    best_20_min_window: {
      use_this: true,
      start_sec: 60,
      end_sec: 120,
      why_this_window: 'Useful but does not contain enough strong clips',
      estimated_number_of_good_clips: 3
    },
    exact_clips: [
      clip({ rank: 1, start_sec: 60, end_sec: 110, clip_length_seconds: 50 }),
      clip({ rank: 2, start_sec: 65, end_sec: 120, clip_length_seconds: 55, clip_score: 8 }),
    ],
  }))}
}
\`\`\``,
    }],
    role: 'assistant',
  }];

  const result = parseAndGate(baseRow, response);

  assert.equal(result.analysisUpdate.ai_episode_score, 8);
  assert.equal(result.analysisUpdate.recommended_strategy, 'USE_EXACT_CLIPS_ONLY');
  assert.equal(result.candidateUpdate.processing_status, 'ANALYZED');
  assert.equal(result.momentRows.length, 2);
});

test('parses official OpenAI node output string wrappers', () => {
  const response = {
    output: JSON.stringify([{
      id: 'msg_123',
      type: 'message',
      status: 'completed',
      content: [{
        type: 'output_text',
        annotations: [],
        logprobs: [],
        text: `\`\`\`json
{
  "output": ${JSON.stringify(ai({
    recommended_strategy: 'USE_20_MIN_WINDOW',
    reason_for_strategy: 'The video provides practical insights.',
    best_20_min_window: {
      use_this: true,
      start_sec: 0,
      end_sec: 40,
      why_this_window: 'Short useful opening section',
      estimated_number_of_good_clips: 3
    },
    exact_clips: [],
    risk_notes: 'low',
  }))}
}
\`\`\``,
      }],
      role: 'assistant',
    }]),
  };

  const result = parseAndGate(baseRow, response);

  assert.equal(result.analysisUpdate.ai_episode_score, 8);
  assert.equal(result.analysisUpdate.recommended_strategy, 'SKIP_THIS_VIDEO');
  assert.equal(result.analysisUpdate.reason_for_strategy, 'The video provides practical insights.');
  assert.match(result.analysisUpdate.ai_json_output, /overall_episode_score/);
  assert.doesNotMatch(result.analysisUpdate.ai_json_output, /msg_123/);
  assert.equal(result.candidateUpdate.processing_status, 'SKIPPED');
  assert.deepEqual(result.momentRows, []);
});

test('WF5 uses official OpenAI node without separate moderation', () => {
  const nodeTypes = Object.fromEntries(workflow.nodes.map((node) => [node.name, node.type]));
  const openAi = workflow.nodes.find((node) => node.name === 'Call OpenAI');

  assert.equal(nodeTypes['Moderate Transcript'], undefined);
  assert.equal(nodeTypes['Build OpenAI Request'], 'n8n-nodes-base.code');
  assert.equal(nodeTypes['Call OpenAI'], '@n8n/n8n-nodes-langchain.openAi');
  assert(!workflow.nodes.some((node) => node.name.toLowerCase().includes('gemini')));
  assert(!workflow.nodes.some((node) => node.type.toLowerCase().includes('gemini')));
  assert.equal(openAi.parameters.operation, undefined);
  assert.equal(openAi.parameters.modelId.value, 'gpt-4o-mini');
  assert.equal(openAi.parameters.responses.values.length, 2);
  assert(openAi.parameters.responses.values.every((message) => message.role && message.content));
  assert.equal(openAi.parameters.responses.values[0].role, 'system');
  assert.equal(openAi.parameters.responses.values[0].content, '={{ $json.system_message }}');
  assert.equal(openAi.parameters.responses.values[1].content, '={{ $json.user_message }}');
  assert.deepEqual(openAi.parameters.builtInTools, {});
  assert.deepEqual(openAi.parameters.options.textFormat.textOptions, {
    type: 'json_schema',
    name: 'transcript_analysis',
    schema: '={{ $json.analysis_schema }}',
    strict: true,
  });
  assert.equal(openAi.onError, 'continueRegularOutput');

  const buildRequest = workflow.nodes.find((node) => node.name === 'Build OpenAI Request');
  assert(buildRequest.parameters.jsCode.includes(buildAnalysisRequest(baseRow).system_message));

  assert.equal(
    workflow.connections['Build OpenAI Request'].main[0][0].node,
    'Call OpenAI',
  );
  assert.equal(workflow.connections['Call OpenAI'].main[0][0].node, 'Parse And Gate');
});

test('WF5 downloads full transcript when available and falls back for old rows', () => {
  const nodeTypes = Object.fromEntries(workflow.nodes.map((node) => [node.name, node.type]));
  const hasFull = workflow.nodes.find((node) => node.name === 'Has Full Transcript File?');
  const download = workflow.nodes.find((node) => node.name === 'Download Full Transcript');
  const extract = workflow.nodes.find((node) => node.name === 'Extract Transcript Text');
  const buildRequest = workflow.nodes.find((node) => node.name === 'Build OpenAI Request');

  assert.equal(nodeTypes['Has Full Transcript File?'], 'n8n-nodes-base.if');
  assert.equal(nodeTypes['Download Full Transcript'], 'n8n-nodes-base.googleDrive');
  assert.equal(nodeTypes['Extract Transcript Text'], 'n8n-nodes-base.extractFromFile');
  assert.equal(download.parameters.resource, 'file');
  assert.equal(download.parameters.operation, 'download');
  assert.equal(download.parameters.binaryPropertyName, 'data');
  assert.equal(extract.parameters.operation, 'text');
  assert.equal(extract.parameters.binaryPropertyName, 'data');
  assert.equal(extract.parameters.options.destinationKey, 'transcript_full');
  assert.match(buildRequest.parameters.jsCode, /\$\('Analysis Loop'\)\.first\(\)\.json/);
  assert.match(buildRequest.parameters.jsCode, /\$json\.transcript_full \|\| row\.transcript_text/);

  assert.equal(workflow.connections['Analysis Loop'].main[1][0].node, 'Has Full Transcript File?');
  assert.equal(workflow.connections['Has Full Transcript File?'].main[0][0].node, 'Download Full Transcript');
  assert.equal(workflow.connections['Has Full Transcript File?'].main[1][0].node, 'Build OpenAI Request');
  assert.equal(workflow.connections['Download Full Transcript'].main[0][0].node, 'Extract Transcript Text');
  assert.equal(workflow.connections['Extract Transcript Text'].main[0][0].node, 'Build OpenAI Request');
});

test('WF5 generator embeds the helper prompt without overriding it', () => {
  const generator = readFileSync('n8n/workflow-code/create-wf5-ai-transcript-analysis.js', 'utf8');

  assert.doesNotMatch(generator, /replace\(\/const SYSTEM_PROMPT/);
});

test('WF5 independently backfills missing window moments from sheet state', () => {
  const readMoments = workflow.nodes.find((node) => node.name === 'Read Clip_Moments');
  const buildMissing = workflow.nodes.find((node) => node.name === 'Build Missing Window Moments');
  const backfill = workflow.nodes.find((node) => node.name === 'Backfill Clip_Moments');

  assert.equal(readMoments.type, 'n8n-nodes-base.googleSheets');
  assert.equal(readMoments.parameters.operation, 'read');
  assert.equal(readMoments.parameters.sheetName.value, 'Clip_Moments');
  assert.equal(readMoments.executeOnce, true);
  assert.equal(readMoments.alwaysOutputData, true);
  assert.equal(buildMissing.type, 'n8n-nodes-base.code');
  assert.match(buildMissing.parameters.jsCode, /buildMissingWindowMoments/);
  assert.equal(backfill.type, 'n8n-nodes-base.googleSheets');
  assert.equal(backfill.parameters.operation, 'appendOrUpdate');
  assert.equal(backfill.parameters.sheetName.value, 'Clip_Moments');
  assert.deepEqual(backfill.parameters.columns.matchingColumns, ['clip_moment_id']);

  assert.equal(
    workflow.connections['Read Candidate_Videos'].main[0][0].node,
    'Read Clip_Moments',
  );
  assert.deepEqual(
    workflow.connections['Read Clip_Moments'].main[0].map((connection) => connection.node).sort(),
    ['Build Missing Window Moments', 'Pick Unanalyzed'],
  );
  assert.equal(
    workflow.connections['Build Missing Window Moments'].main[0][0].node,
    'Backfill Clip_Moments',
  );
});

test('WF5 loop branches use the current parse result for each analyzed video', () => {
  const shapeCandidate = workflow.nodes.find((node) => node.name === 'Shape Candidate Update');
  const explodeMoments = workflow.nodes.find((node) => node.name === 'Explode Clip Moments');
  const channelHealth = workflow.nodes.find((node) => node.name === 'Channel Health Check');
  const parseOutputs = workflow.connections['Parse And Gate'].main[0].map((connection) => connection.node).sort();

  assert.match(shapeCandidate.parameters.jsCode, /parseResult = \$input\.first\(\)\.json/);
  assert.match(shapeCandidate.parameters.jsCode, /parseResult\.candidateUpdate/);
  assert.doesNotMatch(shapeCandidate.parameters.jsCode, /\$\('Parse And Gate'\)\.first\(\)/);
  assert.match(explodeMoments.parameters.jsCode, /\$input\.first\(\)\.json\.momentRows/);
  assert.doesNotMatch(explodeMoments.parameters.jsCode, /\$\('Parse And Gate'\)\.first\(\)/);
  assert.doesNotMatch(channelHealth.parameters.jsCode, /\$\('Shape Analysis Update'\)\.first\(\)/);
  assert.deepEqual(parseOutputs, [
    'Explode Clip Moments',
    'Shape Analysis Update',
    'Shape Candidate Update',
  ]);
  assert.equal(
    workflow.connections['Update Analysis Row'].main[0][0].node,
    'Channel Health Check',
  );
  assert.deepEqual(
    workflow.connections['Update Candidate Status'].main[0].map((connection) => connection.node),
    ['Analysis Loop'],
  );
});

test('forces low scoring episodes to skip with no moments', () => {
  const result = parseAndGate(baseRow, ai({ overall_episode_score: 5 }));

  assert.equal(result.analysisUpdate.recommended_strategy, 'SKIP_THIS_VIDEO');
  assert.equal(result.candidateUpdate.processing_status, 'SKIPPED');
  assert.deepEqual(result.momentRows, []);
});

test('conservative gate skips high rights risk results', () => {
  const result = parseAndGate(baseRow, ai({
    exact_clips: [clip({ copyright_or_reused_content_risk: 'high' })],
  }));

  assert.equal(result.analysisUpdate.recommended_strategy, 'SKIP_THIS_VIDEO');
  assert.equal(result.candidateUpdate.processing_status, 'SKIPPED');
  assert.deepEqual(result.momentRows, []);
});

test('downgrades weak 20-minute windows to exact clips', () => {
  const result = parseAndGate(baseRow, ai({
    recommended_strategy: 'USE_20_MIN_WINDOW',
    best_20_min_window: {
      use_this: true,
      start_sec: 0,
      end_sec: 1200,
      why_this_window: 'Only two strong clips',
      estimated_number_of_good_clips: 2,
    },
    exact_clips: [
      clip({ rank: 1, start_sec: 100, end_sec: 180 }),
      clip({ rank: 2, start_sec: 300, end_sec: 390 }),
    ],
  }));

  assert.equal(result.analysisUpdate.recommended_strategy, 'USE_EXACT_CLIPS_ONLY');
  assert.equal(result.momentRows.length, 2);
  assert(result.momentRows.every((row) => row.ssemble_status === 'PENDING'));
});

test('creates exact pending clip rows when there are enough strong clips in a window', () => {
  const result = parseAndGate(baseRow, ai({
    recommended_strategy: 'USE_20_MIN_WINDOW',
    best_20_min_window: {
      use_this: true,
      start_sec: 0,
      end_sec: 1200,
      why_this_window: 'Dense section',
      estimated_number_of_good_clips: 4,
    },
    exact_clips: [
      clip({ rank: 1, start_sec: 100, end_sec: 180 }),
      clip({ rank: 2, start_sec: 300, end_sec: 390 }),
      clip({ rank: 3, start_sec: 600, end_sec: 690 }),
    ],
  }));

  assert.equal(result.analysisUpdate.recommended_strategy, 'USE_EXACT_CLIPS_ONLY');
  assert.equal(result.momentRows.length, 3);
  assert.equal(result.momentRows[0].clip_moment_id, 'CM-VID-video1234567-1');
  assert.equal(result.momentRows[0].start_sec, 100);
  assert.equal(result.momentRows[0].end_sec, 180);
  assert.equal(result.momentRows[0].ssemble_status, 'PENDING');
});

test('creates exact rows from valid 20-minute windows and caps total downloads at five', () => {
  const windows = Array.from({ length: 6 }, (_, index) => ({
    use_this: true,
    start_sec: index * 1300,
    end_sec: index * 1300 + 1200,
    why_this_window: `Dense section ${index}`,
    estimated_number_of_good_clips: 3 + index,
  }));
  const result = parseAndGate(baseRow, ai({
    recommended_strategy: 'USE_20_MIN_WINDOW',
    best_20_min_windows: windows,
    best_20_min_window: undefined,
    exact_clips: windows.map((window, index) => clip({
      rank: index + 1,
      start_sec: window.start_sec + 60,
      end_sec: window.start_sec + 120,
      clip_length_seconds: 60,
    })),
  }));

  assert.equal(result.analysisUpdate.recommended_strategy, 'USE_EXACT_CLIPS_ONLY');
  assert.equal(result.analysisUpdate.recommended_start_sec, '');
  assert.equal(result.analysisUpdate.recommended_end_sec, '');
  assert.equal(result.momentRows.length, 5);
  assert.deepEqual(result.momentRows.map((row) => row.clip_moment_id), [
    'CM-VID-video1234567-1',
    'CM-VID-video1234567-2',
    'CM-VID-video1234567-3',
    'CM-VID-video1234567-4',
    'CM-VID-video1234567-5',
  ]);
  assert.equal(result.momentRows[1].start_sec, 1360);
  assert.equal(result.momentRows[1].core_idea, 'Budgeting matters');
});

test('skips a window result without exact downloadable clips', () => {
  const result = parseAndGate(baseRow, ai({
    recommended_strategy: 'USE_20_MIN_WINDOW',
    best_20_min_window: {
      use_this: true,
      start_sec: 300,
      end_sec: 1500,
      why_this_window: 'Dense section for automatic clipping',
      estimated_number_of_good_clips: 3,
    },
    exact_clips: [],
  }));

  assert.equal(result.analysisUpdate.recommended_strategy, 'SKIP_THIS_VIDEO');
  assert.equal(result.candidateUpdate.processing_status, 'SKIPPED');
  assert.deepEqual(result.momentRows, []);
});

test('backfills one complete deterministic row for a missing window moment', () => {
  const now = '2026-06-23T10:00:00.000Z';
  const analysisRows = [{
    video_id: 'VID-1',
    niche: 'FINANCE_BUSINESS',
    video_url: 'https://youtube.test/1',
    ai_episode_score: 75,
    recommended_strategy: 'USE_20_MIN_WINDOW',
    recommended_start_sec: 0,
    recommended_end_sec: 1200,
    reason_for_strategy: 'Useful window',
    rights_risk: 'medium',
    ai_json_output: JSON.stringify({
      best_20_min_windows: [{
        use_this: true,
        start_sec: 0,
        end_sec: 1200,
        why_this_window: 'Dense founder section',
        estimated_number_of_good_clips: 5,
      }],
      exact_clips: [clip({ rank: 1, start_sec: 60, end_sec: 120 })],
    }),
  }];

  const rows = buildMissingWindowMoments(
    analysisRows,
    [{ source_id: 'SRC-1', risk_level: 'low' }],
    [{ video_id: 'VID-1', source_id: 'SRC-1' }],
    [],
    now,
  );

  assert.equal(rows.length, 1);
  assert.equal(rows[0].clip_moment_id, 'CM-VID-1-W0-1');
  assert.equal(rows[0].source_id, 'SRC-1');
  assert.equal(rows[0].rank, 1);
  assert.equal(rows[0].clip_score, 8);
  assert.equal(rows[0].rights_risk, 'medium');
  assert.equal(rows[0].ssemble_status, 'PENDING');
  assert.equal(rows[0].core_idea, 'Budgeting matters');
  assert.equal(rows[0].why_valuable, 'Practical money lesson');
  assert.equal(rows[0].created_at, now);
});

test('backfills every missing stored window moment independently', () => {
  const rows = buildMissingWindowMoments([{
    video_id: 'VID-1',
    niche: 'FINANCE_BUSINESS',
    video_url: 'https://youtube.test/1',
    ai_episode_score: 8,
    recommended_strategy: 'USE_20_MIN_WINDOW',
    recommended_start_sec: 0,
    recommended_end_sec: 1200,
    rights_risk: 'low',
    ai_json_output: JSON.stringify({
      best_20_min_windows: [
        {
          use_this: true,
          start_sec: 0,
          end_sec: 1200,
          why_this_window: 'Opening section',
          estimated_number_of_good_clips: 5,
        },
        {
          use_this: true,
          start_sec: 2400,
          end_sec: 3600,
          why_this_window: 'Later section',
          estimated_number_of_good_clips: 4,
        },
      ],
      exact_clips: [
        clip({ rank: 1, start_sec: 60, end_sec: 120 }),
        clip({ rank: 2, start_sec: 2460, end_sec: 2520 }),
      ],
    }),
  }], [], [], [{ clip_moment_id: 'CM-VID-1-W0-1' }], '2026-06-23T10:00:00.000Z');

  assert.equal(rows.length, 1);
  assert.equal(rows[0].clip_moment_id, 'CM-VID-1-W1-2');
  assert.equal(rows[0].start_sec, 2460);
  assert.equal(rows[0].core_idea, 'Budgeting matters');
});

test('window backfill skips existing, non-window, and invalid-window rows', () => {
  const valid = {
    video_id: 'VID-1',
    recommended_strategy: 'USE_20_MIN_WINDOW',
    recommended_start_sec: 0,
    recommended_end_sec: 1200,
  };

  assert.deepEqual(buildMissingWindowMoments(
    [valid], [], [], [{ clip_moment_id: 'CM-VID-1-W0' }], '2026-06-23T10:00:00.000Z',
  ), []);
  assert.deepEqual(buildMissingWindowMoments([
    { ...valid, video_id: 'VID-2', recommended_strategy: 'SKIP_THIS_VIDEO' },
    { ...valid, video_id: 'VID-3', recommended_end_sec: 20 },
    { ...valid, video_id: 'VID-4', recommended_end_sec: 1300 },
  ], [], [], [], '2026-06-23T10:00:00.000Z'), []);
});

test('window backfill skips malformed metadata without exact downloadable clips', () => {
  const rows = buildMissingWindowMoments([{
    video_id: 'VID-2',
    niche: 'AFRICAN_KENYAN_SUCCESS',
    video_url: 'https://youtube.test/2',
    ai_episode_score: 8,
    recommended_strategy: 'USE_20_MIN_WINDOW',
    recommended_start_sec: 300,
    recommended_end_sec: 900,
    reason_for_strategy: 'Fallback reason',
    rights_risk: '',
    ai_json_output: '{bad json',
  }], [{ source_id: 'SRC-2', risk_level: 'high' }], [{
    video_id: 'VID-2', source_id: 'SRC-2',
  }], [], '2026-06-23T10:00:00.000Z');

  assert.deepEqual(rows, []);
});

test('high risk source requires manual approval before provider download', () => {
  const result = parseAndGate({ ...baseRow, source_risk: 'high', source_id: 'SRC-1' }, ai());

  assert.equal(result.candidateUpdate.processing_status, 'ANALYZED');
  assert.equal(result.momentRows[0].ssemble_status, 'AWAITING_MANUAL_APPROVAL');
  assert.equal(result.momentRows[0].source_id, 'SRC-1');
});

test('returns a retryable result for OpenAI errors', () => {
  const result = parseAndGate(
    { ...baseRow, processing_status: 'READY_FOR_ANALYSIS' },
    { error: { message: 'Rate limit exceeded' } },
  );

  assert.equal(result.retryable, true);
  assert.equal(result.analysisUpdate.ai_episode_score, '');
  assert.equal(result.analysisUpdate.recommended_strategy, '');
  assert.match(result.analysisUpdate.reason_for_strategy, /Rate limit exceeded/);
  assert.match(result.analysisUpdate.ai_json_output, /Rate limit exceeded/);
  assert.equal(result.candidateUpdate.processing_status, 'READY_FOR_ANALYSIS');
  assert.deepEqual(result.momentRows, []);
});

test('returns a retryable result for unknown response shapes', () => {
  const result = parseAndGate(baseRow, { unexpected: true });

  assert.equal(result.retryable, true);
  assert.equal(result.analysisUpdate.ai_episode_score, '');
  assert.equal(result.candidateUpdate.processing_status, 'NEW');
  assert.deepEqual(result.momentRows, []);
});

test('returns a retryable result for malformed JSON', () => {
  const result = parseAndGate(baseRow, '{not-json');

  assert.equal(result.retryable, true);
  assert.equal(result.analysisUpdate.ai_episode_score, '');
  assert.match(result.analysisUpdate.reason_for_strategy, /JSON/);
  assert.deepEqual(result.momentRows, []);
});

test('maps permission risk and Kenya relevance to their semantic sources', () => {
  const result = parseAndGate(baseRow, ai({
    risk_notes: 'Copyright warning, not audience relevance',
    exact_clips: [clip({
      copyright_or_reused_content_risk: 'medium',
      kenyan_african_application: 'Explain the lesson using M-Pesa budgeting.',
    })],
  }));

  assert.equal(result.analysisUpdate.permission_risk, 'medium');
  assert.equal(result.analysisUpdate.kenya_relevance, 'Explain the lesson using M-Pesa budgeting.');
  assert.doesNotMatch(result.analysisUpdate.kenya_relevance, /Copyright warning/);
});

test('rejects legacy output with risk_notes outside the analysis wrapper', () => {
  const result = parseAndGate(baseRow, fixtures.misplacedRiskNotes);

  assert.equal(result.retryable, true);
  assert.match(result.analysisUpdate.reason_for_strategy, /missing required fields: risk_notes/);
});

test('rejects legacy output with a missing closing fence', () => {
  const result = parseAndGate(baseRow, fixtures.missingClosingFence);

  assert.equal(result.retryable, true);
  assert.match(result.analysisUpdate.reason_for_strategy, /Unexpected token|fence|JSON/);
});

test('accepts complete legacy exact-clip output', () => {
  const result = parseAndGate(baseRow, fixtures.validLegacyExact);

  assert.equal(result.retryable, false);
  assert.equal(result.analysisUpdate.recommended_strategy, 'USE_EXACT_CLIPS_ONLY');
  assert.equal(result.momentRows.length, 1);
});

test('accepts complete legacy window output and stores only bare analysis JSON', () => {
  const result = parseAndGate(baseRow, fixtures.validLegacyWindow);
  const stored = JSON.parse(result.analysisUpdate.ai_json_output);

  assert.equal(result.retryable, false);
  assert.equal(result.analysisUpdate.recommended_strategy, 'USE_EXACT_CLIPS_ONLY');
  assert.deepEqual(stored, fixtures.normalizedWindowAnalysis);
  assert.equal(stored.output, undefined);
  assert.doesNotMatch(result.analysisUpdate.ai_json_output, /msg_legacy_window|```/);
});

test('accepts canonical unfenced output in the n8n transport envelope', () => {
  const result = parseAndGate(baseRow, fixtures.canonicalUnfenced);

  assert.equal(result.retryable, false);
  assert.deepEqual(JSON.parse(result.analysisUpdate.ai_json_output), fixtures.normalizedWindowAnalysis);
});

test('accepts n8n structured output when content text is already an object', () => {
  const result = parseAndGate(baseRow, fixtures.structuredObject);

  assert.equal(result.retryable, false);
  assert.deepEqual(JSON.parse(result.analysisUpdate.ai_json_output), fixtures.normalizedWindowAnalysis);
});

test('rejects a SKIP response with an incomplete window object', () => {
  const result = parseAndGate(baseRow, fixtures.skipWithEmptyWindow);

  assert.equal(result.retryable, true);
  assert.match(result.analysisUpdate.reason_for_strategy, /best_20_min_window.*missing required fields/);
});

test('rejects invalid schema enums', () => {
  const result = parseAndGate(baseRow, {
    ...fixtures.windowAnalysis,
    recommended_strategy: 'UNKNOWN_STRATEGY',
  });

  assert.equal(result.retryable, true);
  assert.match(result.analysisUpdate.reason_for_strategy, /recommended_strategy.*allowed values/);
});

test('rejects non-finite analysis numbers', () => {
  const result = parseAndGate(baseRow, {
    ...fixtures.windowAnalysis,
    overall_episode_score: Infinity,
  });

  assert.equal(result.retryable, true);
  assert.match(result.analysisUpdate.reason_for_strategy, /overall_episode_score.*finite number/);
});

test('constrains all AI quality scores to the zero-to-ten range', () => {
  assert.deepEqual(ANALYSIS_SCHEMA.properties.overall_episode_score, {
    type: 'number', minimum: 0, maximum: 10,
  });
  assert.deepEqual(ANALYSIS_SCHEMA.properties.exact_clips.items.properties.clip_score, {
    type: 'number', minimum: 0, maximum: 10,
  });
  assert.deepEqual(ANALYSIS_SCHEMA.properties.exact_clips.items.properties.originality_score, {
    type: 'number', minimum: 0, maximum: 10,
  });
});

test('rejects an AI episode score above ten instead of silently clamping it', () => {
  const result = parseAndGate(baseRow, {
    ...fixtures.windowAnalysis,
    overall_episode_score: 75,
  });

  assert.equal(result.retryable, true);
  assert.match(result.analysisUpdate.reason_for_strategy, /overall_episode_score.*at most 10/);
});

test('rejects incomplete exact clips', () => {
  const result = parseAndGate(baseRow, {
    ...fixtures.exactAnalysis,
    exact_clips: [{ rank: 1, start_sec: 0, end_sec: 60 }],
  });

  assert.equal(result.retryable, true);
  assert.match(result.analysisUpdate.reason_for_strategy, /exact_clips\[0\].*missing required fields/);
});
