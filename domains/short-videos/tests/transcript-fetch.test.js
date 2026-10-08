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
  // Spec Section 1 item 1: transcript_full and the two Drive columns are gone.
  assert.equal(row.transcript_full, undefined);
  assert.equal(row.transcript_full_url, undefined);
  assert.equal(row.transcript_full_file_id, undefined);
  assert.equal(row.transcript_length_words, 4);
  assert.equal(row.created_at, '2026-06-15T00:00:00.000Z');
});

// Spec Section 1 item 1: Postgres text is unbounded, so the ~45k truncation
// and the Drive stash that recovered the real transcript both go away.
test('the full transcript is stored without truncation or a Drive round trip', () => {
  const longText = 'a'.repeat(120000);
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
  assert.equal(row.transcript_text, `[00:00] ${longText}`);
  assert.equal(row.transcript_text.length, 120008);
  assert.doesNotMatch(row.transcript_text, /\[TRUNCATED\]/);
  assert.equal(row.transcript_full, undefined);
  assert.equal(row.transcript_full_url, undefined);
  assert.equal(row.transcript_full_file_id, undefined);
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

// The inverse of the test this replaces. Spec Section 1 item 1 deletes the
// Drive round trip that existed only to recover the untruncated transcript.
// D8 keeps Drive for media, so WF4 must have no Drive node left at all while
// WF6 and WF8 still do.
test('WF4 has no Drive round trip and writes the analysis row straight to Postgres', () => {
  const nodeNames = workflow.nodes.map((node) => node.name);
  assert.equal(workflow.nodes.filter((node) => node.type === 'n8n-nodes-base.googleDrive').length, 0);
  assert.equal(workflow.nodes.filter((node) => node.type === 'n8n-nodes-base.convertToFile').length, 0);
  assert.ok(!nodeNames.includes('Attach Transcript URL'));
  assert.ok(!nodeNames.includes('Upload Transcript To Drive'));

  const upsert = workflow.nodes.find((node) => node.name === 'Upsert Transcript_Analysis');
  assert.equal(upsert.type, 'n8n-nodes-base.postgres');
  assert.match(upsert.parameters.query, /INSERT INTO short_videos\.transcript_analysis/);
  assert.doesNotMatch(upsert.parameters.query, /transcript_full/);

  assert.equal(workflow.connections['Build Analysis Row'].main[0][0].node, 'Upsert Transcript_Analysis');
  assert.equal(workflow.connections['Upsert Transcript_Analysis'].main[0][0].node, 'Mark Transcript OK');
});
