const assert = require('node:assert/strict');
const test = require('node:test');
const {
  buildCandidateRows,
  buildUploadsLookup,
  buildFetchPlan,
  buildSourceUpdate,
  countFetchedVideosBySource,
  isoDurationToSeconds,
  pickActiveChannels,
  stripInternalFields,
  touchedChannelUpdates,
} = require('../n8n/workflow-code/video-fetch');

test('parses ISO 8601 YouTube durations into seconds', () => {
  assert.equal(isoDurationToSeconds('PT1H2M3S'), 3723);
  assert.equal(isoDurationToSeconds('PT15M'), 900);
  assert.equal(isoDurationToSeconds('PT42S'), 42);
  assert.equal(isoDurationToSeconds(''), 0);
});

test('selects only active channels with upload playlists', () => {
  const rows = [
    { source_id: 'SRC-1', active_status: 'TRUE', uploads_playlist_id: 'UU1' },
    { source_id: 'SRC-2', active_status: 'FALSE', uploads_playlist_id: 'UU2' },
    { source_id: 'SRC-3', active_status: 'true', uploads_playlist_id: '' },
  ];

  assert.deepEqual(pickActiveChannels(rows), [rows[0]]);
});

test('builds upload lookup from playlist API response', () => {
  const channel = { source_id: 'SRC-1', source_name: 'Source', niche: 'FINANCE_BUSINESS', risk_level: 'low' };
  const api = { items: [{ contentDetails: { videoId: 'abc12345678' } }] };

  assert.deepEqual(buildUploadsLookup(channel, api), {
    source_id: 'SRC-1',
    source_name: 'Source',
    niche: 'FINANCE_BUSINESS',
    risk_level: 'low',
    video_ids: 'abc12345678',
  });
});

test('returns an empty marker when a channel has no uploads', () => {
  const result = buildUploadsLookup({ source_id: 'SRC-1' }, { items: [] });

  assert.equal(result.__empty, true);
  assert.equal(result.source_id, 'SRC-1');
});

test('builds candidate rows and dedups existing and in-run video IDs', () => {
  const existingIds = { oldvideo1234: true };
  const meta = { source_id: 'SRC-1', source_name: 'Source', niche: 'FINANCE_BUSINESS' };
  const api = {
    items: [
      { id: 'oldvideo1234' },
      {
        id: 'newvideo1234',
        snippet: {
          title: 'A useful interview',
          publishedAt: '2026-01-01T00:00:00Z',
          defaultLanguage: 'en',
          categoryId: '22',
          liveBroadcastContent: 'none',
        },
        contentDetails: { duration: 'PT20M5S' },
        statistics: { viewCount: '100', likeCount: '10', commentCount: '3' },
      },
      {
        id: 'newvideo1234',
        snippet: { title: 'Duplicate in same run', categoryId: '22', liveBroadcastContent: 'none' },
        contentDetails: { duration: 'PT1M' },
        statistics: {},
      },
    ],
  };

  const rows = buildCandidateRows(meta, api, existingIds, '2026-06-15T00:00:00.000Z');

  assert.equal(rows.length, 1);
  assert.equal(rows[0].youtube_video_id, 'newvideo1234');
  assert.equal(rows[0].duration_seconds, 1205);
  assert.equal(rows[0].processing_status, 'NEW');
  assert.equal(existingIds.newvideo1234, true);
});

test('returns noop marker when every video is duplicate', () => {
  const rows = buildCandidateRows(
    { source_id: 'SRC-1' },
    { items: [{ id: 'oldvideo1234' }] },
    { oldvideo1234: true },
    '2026-06-15T00:00:00.000Z',
  );

  assert.deepEqual(rows, [{ __noop: true }]);
});

test('limits newly built candidate rows per channel', () => {
  const meta = { source_id: 'SRC-1', source_name: 'Source', niche: 'FINANCE_BUSINESS' };
  const api = {
    items: Array.from({ length: 8 }, (_, index) => ({
      id: `video${index}`,
      snippet: {
        title: `Useful interview ${index}`,
        publishedAt: `2026-06-27T00:0${index}:00.000Z`,
        defaultAudioLanguage: 'en',
        categoryId: '22',
        liveBroadcastContent: 'none',
      },
      statistics: { viewCount: '1000', likeCount: '10', commentCount: '2' },
      contentDetails: { duration: 'PT20M' },
    })),
  };

  const rows = buildCandidateRows(meta, api, {}, '2026-06-27T01:00:00.000Z', { perSourceLimit: 5 });

  assert.equal(rows.length, 5);
  assert.deepEqual(rows.map((row) => row.youtube_video_id), ['video0', 'video1', 'video2', 'video3', 'video4']);
});

test('pre-rejects music and live videos while stripping internal fields', () => {
  const [music, live, normal, noop] = stripInternalFields([
    { video_id: 'VID-1', processing_status: 'NEW', __category_id: '10', __is_live: 'none' },
    { video_id: 'VID-2', processing_status: 'NEW', __category_id: '22', __is_live: 'live' },
    { video_id: 'VID-3', processing_status: 'NEW', __category_id: '22', __is_live: 'none' },
    { __noop: true },
  ]);

  assert.equal(music.validity_status, 'REJECTED');
  assert.equal(music.rejection_reason, 'MUSIC_VIDEO');
  assert.equal(music.processing_status, 'SKIPPED');
  assert.equal('__category_id' in music, false);
  assert.equal(live.rejection_reason, 'LIVE_STREAM');
  assert.equal(normal.validity_status, undefined);
  assert.deepEqual(noop, { __noop: true });
});

test('deduplicates touched source updates', () => {
  const updates = touchedChannelUpdates(['SRC-1', 'SRC-1', 'SRC-2'], '2026-06-15T00:00:00.000Z');

  assert.deepEqual(updates, [
    { source_id: 'SRC-1', last_checked_at: '2026-06-15T00:00:00.000Z' },
    { source_id: 'SRC-2', last_checked_at: '2026-06-15T00:00:00.000Z' },
  ]);
});

test('plans latest plus first backfill fetch for channels without saved token', () => {
  const plan = buildFetchPlan({
    source_id: 'SRC-1',
    uploads_playlist_id: 'UU1',
    backfill_next_page_token: '',
    backfill_status: '',
  });

  assert.deepEqual(plan, [
    { fetch_kind: 'latest', page_token: '', uploads_playlist_id: 'UU1', source_id: 'SRC-1' },
    { fetch_kind: 'backfill', page_token: '', uploads_playlist_id: 'UU1', source_id: 'SRC-1' },
  ]);
});

test('plans latest plus saved backfill token for in-progress channels', () => {
  const plan = buildFetchPlan({
    source_id: 'SRC-1',
    uploads_playlist_id: 'UU1',
    backfill_next_page_token: 'PAGE-2',
    backfill_status: 'IN_PROGRESS',
  });

  assert.deepEqual(plan.map((p) => [p.fetch_kind, p.page_token]), [
    ['latest', ''],
    ['backfill', 'PAGE-2'],
  ]);
});

test('skips backfill fetch for completed channels while still checking latest uploads', () => {
  const plan = buildFetchPlan({
    source_id: 'SRC-1',
    uploads_playlist_id: 'UU1',
    backfill_next_page_token: '',
    backfill_status: 'COMPLETE',
  });

  assert.deepEqual(plan.map((p) => p.fetch_kind), ['latest']);
});

test('builds source update for in-progress backfill', () => {
  const update = buildSourceUpdate(
    { source_id: 'SRC-1' },
    { pageInfo: { totalResults: 123 }, nextPageToken: 'NEXT-2' },
    { 'SRC-1': 41 },
    '2026-06-15T00:00:00.000Z',
  );

  assert.deepEqual(update, {
    source_id: 'SRC-1',
    backfill_next_page_token: 'NEXT-2',
    backfill_status: 'IN_PROGRESS',
    videos_known_count: 123,
    videos_fetched_count: 41,
    backfill_last_run_at: '2026-06-15T00:00:00.000Z',
    last_checked_at: '2026-06-15T00:00:00.000Z',
  });
});

test('marks source complete when backfill response has no next page token', () => {
  const update = buildSourceUpdate(
    { source_id: 'SRC-1' },
    { pageInfo: { totalResults: 123 } },
    { 'SRC-1': 123 },
    '2026-06-15T00:00:00.000Z',
  );

  assert.equal(update.backfill_next_page_token, '');
  assert.equal(update.backfill_status, 'COMPLETE');
});

test('counts fetched candidate videos by source', () => {
  assert.deepEqual(countFetchedVideosBySource([
    { source_id: 'SRC-1', youtube_video_id: 'a' },
    { source_id: 'SRC-1', youtube_video_id: 'b' },
    { source_id: 'SRC-2', youtube_video_id: 'c' },
    { source_id: 'SRC-2', youtube_video_id: '' },
  ]), {
    'SRC-1': 2,
    'SRC-2': 1,
  });
});
