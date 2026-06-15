const assert = require('node:assert/strict');
const test = require('node:test');
const {
  buildAnalysisRow,
  markTranscriptFailed,
  markTranscriptOk,
  pickPendingTranscripts,
} = require('../n8n/workflow-code/transcript-fetch');

test('picks at most 10 valid candidates without transcript state', () => {
  const rows = Array.from({ length: 12 }, (_, index) => ({
    video_id: `VID-${index}`,
    validity_status: 'VALID',
    transcript_available: '',
  }));
  rows.push({ video_id: 'SKIP-1', validity_status: 'FLAGGED', transcript_available: '' });
  rows.push({ video_id: 'SKIP-2', validity_status: 'VALID', transcript_available: 'TRUE' });

  const picked = pickPendingTranscripts(rows);

  assert.equal(picked.length, 10);
  assert.equal(picked[0].video_id, 'VID-0');
  assert.equal(picked[9].video_id, 'VID-9');
});

test('builds timestamped transcript analysis rows', () => {
  const row = buildAnalysisRow(
    {
      video_id: 'VID-abc12345678',
      youtube_video_id: 'abc12345678',
      niche: 'FINANCE_BUSINESS',
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
  assert.equal(row.transcript_status, 'FETCHED');
  assert.equal(row.transcript_text, '[00:00] hello world\n[01:05] second line');
  assert.equal(row.transcript_length_words, 4);
  assert.equal(row.created_at, '2026-06-15T00:00:00.000Z');
});

test('truncates transcript text near the sheet cell limit', () => {
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

  assert.equal(row.transcript_status, 'TRUNCATED');
  assert(row.transcript_text.endsWith('\n...[TRUNCATED]'));
  assert(row.transcript_text.length > 45000);
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
