const assert = require('node:assert/strict');
const test = require('node:test');
const {
  buildLookup,
  extractYouTubeVideoId,
  parseLookupResponse,
  uploadsPlaylistFromChannelId,
} = require('../n8n/workflow-code/youtube-url-resolver');

const key = 'test key';

test('builds channel lookup for channel URLs', () => {
  const result = buildLookup({
    source_id: 'src1',
    youtube_channel_url: 'https://www.youtube.com/channel/UC1234567890123456789012/videos',
  }, key);

  assert.equal(result.lookup_type, 'channel_id');
  assert.equal(result.lookup_value, 'UC1234567890123456789012');
  assert.match(result.lookup_url, /channels\?part=id,contentDetails/);
  assert.match(result.lookup_url, /id=UC1234567890123456789012/);
});

test('builds handle lookup for handle URLs with subpaths', () => {
  const result = buildLookup({
    source_id: 'src2',
    youtube_channel_url: 'https://www.youtube.com/@Some.Handle-1/shorts',
  }, key);

  assert.equal(result.lookup_type, 'handle');
  assert.equal(result.lookup_value, 'Some.Handle-1');
  assert.match(result.lookup_url, /forHandle=Some.Handle-1/);
});

test('builds username lookup for legacy user URLs', () => {
  const result = buildLookup({
    source_id: 'src3',
    youtube_channel_url: 'https://www.youtube.com/user/GoogleDevelopers',
  }, key);

  assert.equal(result.lookup_type, 'username');
  assert.equal(result.lookup_value, 'GoogleDevelopers');
  assert.match(result.lookup_url, /forUsername=GoogleDevelopers/);
});

test('builds search lookup for custom c URLs', () => {
  const result = buildLookup({
    source_id: 'src4',
    youtube_channel_url: 'https://www.youtube.com/c/GoogleDevelopers/videos',
  }, key);

  assert.equal(result.lookup_type, 'custom_url_search');
  assert.equal(result.lookup_value, 'GoogleDevelopers');
  assert.match(result.lookup_url, /search\?part=snippet/);
  assert.match(result.lookup_url, /type=channel/);
});

test('extracts video IDs from common video URL shapes', () => {
  assert.equal(extractYouTubeVideoId('https://www.youtube.com/watch?v=abcdefghijk'), 'abcdefghijk');
  assert.equal(extractYouTubeVideoId('https://youtu.be/abcdefghijk?t=1'), 'abcdefghijk');
  assert.equal(extractYouTubeVideoId('https://www.youtube.com/shorts/abcdefghijk'), 'abcdefghijk');
  assert.equal(extractYouTubeVideoId('https://www.youtube.com/embed/abcdefghijk'), 'abcdefghijk');
  assert.equal(extractYouTubeVideoId('https://www.youtube.com/live/abcdefghijk'), 'abcdefghijk');
});

test('builds video lookup for video URLs', () => {
  const result = buildLookup({
    source_id: 'src5',
    youtube_channel_url: 'https://youtu.be/abcdefghijk',
  }, key);

  assert.equal(result.lookup_type, 'video');
  assert.equal(result.lookup_value, 'abcdefghijk');
  assert.match(result.lookup_url, /videos\?part=snippet/);
});

test('skips already resolved and empty rows', () => {
  assert.equal(buildLookup({ youtube_channel_url: '', youtube_channel_id: '' }, key), null);
  assert.equal(buildLookup({
    youtube_channel_url: 'https://www.youtube.com/@x',
    youtube_channel_id: 'UC1234567890123456789012',
  }, key), null);
});

test('returns a note for unsupported URLs', () => {
  const result = buildLookup({
    source_id: 'src6',
    youtube_channel_url: 'https://example.com/not-youtube',
  }, key);

  assert.equal(result.source_id, 'src6');
  assert.match(result.notes, /RESOLVE_SKIPPED/);
});

test('parses channel lookup responses', () => {
  const result = parseLookupResponse(
    { source_id: 'src7', lookup_type: 'handle' },
    { items: [{ id: 'UC1234567890123456789012', contentDetails: { relatedPlaylists: { uploads: 'UU1234567890123456789012' } } }] },
  );

  assert.equal(result.youtube_channel_id, 'UC1234567890123456789012');
  assert.equal(result.uploads_playlist_id, 'UU1234567890123456789012');
});

test('parses video and search responses by deriving uploads playlist from channel ID', () => {
  const api = { items: [{ snippet: { channelId: 'UC1234567890123456789012' } }] };

  assert.equal(parseLookupResponse({ source_id: 'src8', lookup_type: 'video' }, api).uploads_playlist_id, 'UU1234567890123456789012');
  assert.equal(parseLookupResponse({ source_id: 'src9', lookup_type: 'custom_url_search' }, api).uploads_playlist_id, 'UU1234567890123456789012');
  assert.equal(uploadsPlaylistFromChannelId('bad'), '');
});
