const assert = require('node:assert/strict');
const test = require('node:test');
const workflow = require('../workflows/04-transcript-fetch.json');
const {
  buildAnalysisRow,
  markTranscriptFailed,
  markTranscriptOk,
  pickPendingTranscripts,
} = require('../workflow-code/transcript-fetch');

test('picks pending transcripts fairly by source', () => {
  const rows = [
    ...Array.from({ length: 8 }, (_, index) => ({
      video_id: `A-${index}`,
      source_id: 'SRC-A',
      validity_status: 'VALID',
      transcript_available: '',
      created_at: `2026-06-27T00:0${index}:00.000Z`,
    })),
    ...Array.from({ length: 3 }, (_, index) => ({
      video_id: `B-${index}`,
      source_id: 'SRC-B',
      validity_status: 'VALID',
      transcript_available: '',
      created_at: `2026-06-27T00:0${index}:00.000Z`,
    })),
    { video_id: 'SKIP-1', source_id: 'SRC-C', validity_status: 'FLAGGED', transcript_available: '' },
    { video_id: 'SKIP-2', source_id: 'SRC-C', validity_status: 'VALID', transcript_available: 'TRUE' },
  ];

  const picked = pickPendingTranscripts(rows, { limit: 10, perSourceLimit: 2 });

  assert.deepEqual(picked.map((row) => row.video_id), ['A-0', 'B-0', 'A-1', 'B-1']);
});

test('picks pending transcripts by niche before taking extra rows from one niche', () => {
  const rows = [
    { video_id: 'F-A1', niche: 'FINANCE_BUSINESS', source_id: 'SRC-FA', validity_status: 'VALID', transcript_available: '', created_at: '2026-06-27T00:01:00.000Z' },
    { video_id: 'F-A2', niche: 'FINANCE_BUSINESS', source_id: 'SRC-FA', validity_status: 'VALID', transcript_available: '', created_at: '2026-06-27T00:02:00.000Z' },
    { video_id: 'F-B1', niche: 'FINANCE_BUSINESS', source_id: 'SRC-FB', validity_status: 'VALID', transcript_available: '', created_at: '2026-06-27T00:03:00.000Z' },
    { video_id: 'C-A1', niche: 'CHRISTIAN_CONTENT', source_id: 'SRC-CA', validity_status: 'VALID', transcript_available: '', created_at: '2026-06-27T00:01:00.000Z' },
  ];

  const picked = pickPendingTranscripts(rows, { limit: 3, perSourceLimit: 2 });

  assert.deepEqual(picked.map((row) => row.video_id), ['F-A1', 'C-A1', 'F-B1']);
});

test('builds timestamped transcript analysis rows', () => {
  const row = buildAnalysisRow(
    {
      video_id: 'VID-abc12345678',
      youtube_video_id: 'abc12345678',
      niche: 'FINANCE_BUSINESS',
      source_id: 'SRC-1',
      video_title: 'Useful interview',
      video_url: 'https://www.youtube.com/watch?v=abc12345678',
    },
    {
      transcript: [
        { start: 0, text: 'hello world' },
        { start: 65, text: 'second line' },
      ],
      plain_text: 'hello world second line',
    },
    '2026-06-15T00:00:00.000Z',
  );

  assert.equal(row.analysis_id, 'AN-abc12345678');
  assert.equal(row.source_id, 'SRC-1');
  assert.equal(row.transcript_status, 'FETCHED');
  assert.equal(row.transcript_text, '[00:00] hello world\n[01:05] second line');
  assert.equal(row.transcript_full, '[00:00] hello world\n[01:05] second line');
  assert.equal(row.transcript_full_url, '');
  assert.equal(row.transcript_full_file_id, '');
  assert.equal(row.transcript_length_words, 4);
  assert.equal(row.created_at, '2026-06-15T00:00:00.000Z');
});

test('keeps full transcript while truncating the sheet preview near the cell limit', () => {
  const longText = 'a'.repeat(46000);
  const row = buildAnalysisRow(
    {
      video_id: 'VID-abc12345678',
      youtube_video_id: 'abc12345678',
      niche: 'FINANCE_BUSINESS',
      video_title: 'Long transcript',
      video_url: 'https://www.youtube.com/watch?v=abc12345678',
    },
    {
      transcript: [{ start: 0, text: longText }],
      plain_text: 'one two',
    },
    '2026-06-15T00:00:00.000Z',
  );

  assert.equal(row.transcript_status, 'FETCHED');
  assert(row.transcript_text.endsWith('\n...[TRUNCATED]'));
  assert(row.transcript_text.length > 45000);
  assert.equal(row.transcript_full, `[00:00] ${longText}`);
  assert.equal(row.transcript_full_url, '');
  assert.equal(row.transcript_full_file_id, '');
});

test('marks transcript success on candidate rows', () => {
  assert.deepEqual(markTranscriptOk(
    { video_id: 'VID-1', language: 'en-US' },
    { language_code: 'en' },
  ), {
    video_id: 'VID-1',
    transcript_available: 'TRUE',
    language: 'en',
  });
});

test('rejects video-level transcript failures', () => {
  assert.deepEqual(markTranscriptFailed(
    {
      video_id: 'VID-1',
      validity_status: 'VALID',
      processing_status: 'NEW',
    },
    { error_code: 'INVALID_VIDEO_ID' },
  ), {
    video_id: 'VID-1',
    transcript_available: 'FALSE',
    validity_status: 'REJECTED',
    rejection_reason: 'TRANSCRIPT_INVALID_VIDEO_ID',
    processing_status: 'SKIPPED',
  });
});

test('leaves infrastructure transcript failures retryable', () => {
  assert.deepEqual(markTranscriptFailed(
    {
      video_id: 'VID-1',
      validity_status: 'VALID',
      processing_status: 'NEW',
    },
    { error_code: 'IP_BLOCKED' },
  ), {
    video_id: 'VID-1',
    transcript_available: '',
    validity_status: 'VALID',
    rejection_reason: '',
    processing_status: 'NEW',
  });
});

test('WF4 uploads full transcripts to Drive before appending sheet rows', () => {
  const nodeTypes = Object.fromEntries(workflow.nodes.map((node) => [node.name, node.type]));
  const convert = workflow.nodes.find((node) => node.name === 'Convert Transcript To File');
  const upload = workflow.nodes.find((node) => node.name === 'Upload Transcript To Drive');
  const attach = workflow.nodes.find((node) => node.name === 'Attach Transcript URL');
  const append = workflow.nodes.find((node) => node.name === 'Append Transcript_Analysis');

  assert.equal(nodeTypes['Convert Transcript To File'], 'n8n-nodes-base.convertToFile');
  assert.equal(nodeTypes['Upload Transcript To Drive'], 'n8n-nodes-base.googleDrive');
  assert.equal(nodeTypes['Attach Transcript URL'], 'n8n-nodes-base.code');
  assert.equal(convert.parameters.operation, 'toText');
  assert.equal(convert.parameters.sourceProperty, 'transcript_full');
  assert.equal(upload.parameters.resource, 'file');
  assert.equal(upload.parameters.operation, 'upload');
  assert.equal(upload.parameters.inputDataFieldName, 'data');
  assert.equal(upload.onError, 'continueRegularOutput');
  assert.match(attach.parameters.jsCode, /\$\('Build Analysis Row'\)\.first\(\)\.json/);
  assert.match(attach.parameters.jsCode, /transcript_full_url/);
  assert.match(attach.parameters.jsCode, /transcript_full_file_id/);
  assert.match(attach.parameters.jsCode, /delete row\.transcript_full/);
  assert.deepEqual(append.parameters.columns.matchingColumns, ['analysis_id']);

  assert.equal(workflow.connections['Build Analysis Row'].main[0][0].node, 'Convert Transcript To File');
  assert.equal(workflow.connections['Convert Transcript To File'].main[0][0].node, 'Upload Transcript To Drive');
  assert.equal(workflow.connections['Upload Transcript To Drive'].main[0][0].node, 'Attach Transcript URL');
  assert.equal(workflow.connections['Attach Transcript URL'].main[0][0].node, 'Append Transcript_Analysis');
});
