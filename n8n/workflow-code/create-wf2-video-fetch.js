const fs = require('node:fs');

const workflowPath = process.argv[2] || 'n8n/workflows/02-video-fetch.json';

const sheet = (operation, sheetName, extra = {}) => ({
  operation,
  documentId: { __rl: true, mode: 'id', value: 'GOOGLE_SHEETS_DOCUMENT_ID' },
  sheetName: { __rl: true, mode: 'name', value: sheetName },
  options: {},
  ...extra,
});

const codeNode = (id, name, position, jsCode) => ({
  parameters: { mode: 'runOnceForAllItems', jsCode },
  id,
  name,
  type: 'n8n-nodes-base.code',
  typeVersion: 2,
  position,
});

const sheetsNode = (id, name, position, parameters, extra = {}) => ({
  parameters,
  id,
  name,
  type: 'n8n-nodes-base.googleSheets',
  typeVersion: 4.5,
  position,
  retryOnFail: true,
  maxTries: 3,
  waitBetweenTries: 5000,
  ...(parameters.operation === 'read' ? { executeOnce: true } : {}),
  ...extra,
});

const httpNode = (id, name, position, url, extra = {}) => ({
  parameters: {
    method: 'GET',
    url,
    authentication: 'genericCredentialType',
    genericAuthType: 'httpQueryAuth',
    options: {},
  },
  id,
  name,
  type: 'n8n-nodes-base.httpRequest',
  typeVersion: 4.2,
  position,
  retryOnFail: true,
  maxTries: 3,
  waitBetweenTries: 5000,
  ...extra,
});

const workflow = {
  name: 'WF2 Video Fetch',
  description: 'Fetches recent and backfill uploads fairly across active source channels. It keeps discovery resumable and prevents one channel from monopolizing the candidate queue.',
  nodes: [
    {
      parameters: { rule: { interval: [{ field: 'hours', hoursInterval: 6 }] } },
      id: 'a1b2c3d4-0002-4000-8000-000000000001',
      name: 'Schedule 6h',
      type: 'n8n-nodes-base.scheduleTrigger',
      typeVersion: 1.2,
      position: [0, 0],
    },
    sheetsNode('a1b2c3d4-0002-4000-8000-000000000002', 'Read Source_Channels', [220, 0], sheet('read', 'Source_Channels')),
    sheetsNode(
      'a1b2c3d4-0002-4000-8000-000000000003',
      'Read Candidate_Videos',
      [440, 0],
      sheet('read', 'Candidate_Videos'),
      { alwaysOutputData: true },
    ),
    codeNode('a1b2c3d4-0002-4000-8000-000000000004', 'Init Run', [660, 0], `const sd = $getWorkflowStaticData('global');
sd.existingIds = {};
sd.fetchedCounts = {};
for (const item of $('Read Candidate_Videos').all()) {
  const row = item.json;
  if (row.youtube_video_id) sd.existingIds[row.youtube_video_id] = true;
  if (row.source_id && row.youtube_video_id) sd.fetchedCounts[row.source_id] = (sd.fetchedCounts[row.source_id] || 0) + 1;
}
sd.sourceUpdates = {};
const channels = $('Read Source_Channels').all()
  .filter(i => String(i.json.active_status).toUpperCase() === 'TRUE' && i.json.uploads_playlist_id)
  .map((i, idx) => ({ json: i.json, pairedItem: { item: idx } }));
return channels;`),
    {
      parameters: { batchSize: 1, options: {} },
      id: 'a1b2c3d4-0002-4000-8000-000000000005',
      name: 'Channel Loop',
      type: 'n8n-nodes-base.splitInBatches',
      typeVersion: 3,
      position: [880, 0],
    },
    codeNode('a1b2c3d4-0002-4000-8000-000000000006', 'Build Fetch Requests', [1100, 120], `const channel = $('Channel Loop').first().json;
const base = { ...channel, page_token: '', fetch_kind: 'latest' };
const out = [{ json: base, pairedItem: { item: 0 } }];
if (String(channel.backfill_status || '').toUpperCase() !== 'COMPLETE') {
  out.push({
    json: { ...channel, page_token: channel.backfill_next_page_token || '', fetch_kind: 'backfill' },
    pairedItem: { item: 0 },
  });
}
return out;`),
    httpNode(
      'a1b2c3d4-0002-4000-8000-000000000007',
      'Fetch Uploads',
      [1320, 120],
      "={{ 'https://www.googleapis.com/youtube/v3/playlistItems?part=contentDetails&maxResults=50&playlistId=' + $json.uploads_playlist_id + ($json.page_token ? '&pageToken=' + $json.page_token : '') }}",
    ),
    codeNode('a1b2c3d4-0002-4000-8000-000000000008', 'Build Videos Lookup', [1540, 120], `const requests = $('Build Fetch Requests').all();
const out = [];
for (const [i, item] of $input.all().entries()) {
  const request = requests[i].json;
  const api = item.json;
  const ids = (api.items || []).map(v => v.contentDetails && v.contentDetails.videoId).filter(Boolean);
  if (request.fetch_kind === 'backfill') {
    const sd = $getWorkflowStaticData('global');
    sd.sourceUpdates[request.source_id] = {
      source_id: request.source_id,
      backfill_next_page_token: api.nextPageToken || '',
      backfill_status: api.nextPageToken ? 'IN_PROGRESS' : 'COMPLETE',
      videos_known_count: Number((api.pageInfo || {}).totalResults || 0),
    };
  }
  if (ids.length === 0) {
    out.push({ json: { __empty: true, ...channelMeta(request) }, pairedItem: { item: i } });
  } else {
    out.push({ json: { video_ids: ids.join(','), ...channelMeta(request) }, pairedItem: { item: i } });
  }
}
return out;

function channelMeta(c) {
  return {
    source_id: c.source_id,
    source_name: c.source_name,
    niche: c.niche,
    risk_level: c.risk_level,
    fetch_kind: c.fetch_kind,
  };
}`),
    httpNode(
      'a1b2c3d4-0002-4000-8000-000000000009',
      'Fetch Video Details',
      [1760, 120],
      "=https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails,statistics,liveStreamingDetails&id={{ $json.video_ids || 'dQw4w9WgXcQ' }}",
      { alwaysOutputData: true },
    ),
    codeNode('a1b2c3d4-0002-4000-8000-000000000010', 'Build Candidate Rows', [1980, 120], `const sd = $getWorkflowStaticData('global');
const metas = $('Build Videos Lookup').all();
const MAX_NEW_VIDEOS_PER_SOURCE = 5;
const newThisSource = {};
const out = [];
const now = new Date().toISOString();
for (const [i, item] of $input.all().entries()) {
  const meta = metas[i].json;
  if (meta.__empty) continue;
  for (const v of item.json.items || []) {
    if (!v.id || sd.existingIds[v.id]) continue;
    newThisSource[meta.source_id] = newThisSource[meta.source_id] || 0;
    if (newThisSource[meta.source_id] >= MAX_NEW_VIDEOS_PER_SOURCE) continue;
    newThisSource[meta.source_id] += 1;
    sd.existingIds[v.id] = true;
    sd.fetchedCounts[meta.source_id] = (sd.fetchedCounts[meta.source_id] || 0) + 1;
    out.push({
      json: {
        video_id: \`VID-\${v.id}\`,
        niche: meta.niche,
        source_id: meta.source_id,
        source_name: meta.source_name,
        video_title: v.snippet.title,
        video_url: \`https://www.youtube.com/watch?v=\${v.id}\`,
        youtube_video_id: v.id,
        duration_seconds: isoDurationToSeconds(v.contentDetails.duration),
        published_at: v.snippet.publishedAt,
        view_count: Number((v.statistics || {}).viewCount || 0),
        like_count: Number((v.statistics || {}).likeCount || 0),
        comment_count: Number((v.statistics || {}).commentCount || 0),
        transcript_available: '',
        language: v.snippet.defaultAudioLanguage || v.snippet.defaultLanguage || '',
        validity_status: '',
        validity_score: '',
        rejection_reason: '',
        duplicate_status: 'UNIQUE',
        processing_status: 'NEW',
        created_at: now,
        __category_id: v.snippet.categoryId || '',
        __is_live: v.snippet.liveBroadcastContent || 'none',
        __title_lower: (v.snippet.title || '').toLowerCase(),
      },
      pairedItem: { item: i },
    });
  }
}
if (out.length === 0) return [{ json: { __noop: true }, pairedItem: { item: 0 } }];
return out;

function isoDurationToSeconds(iso) {
  const m = String(iso || '').match(/PT(?:(\\d+)H)?(?:(\\d+)M)?(?:(\\d+)S)?/);
  if (!m) return 0;
  return (Number(m[1] || 0) * 3600) + (Number(m[2] || 0) * 60) + Number(m[3] || 0);
}`),
    codeNode('a1b2c3d4-0002-4000-8000-000000000011', 'Strip Internal Fields', [2200, 120], `return $input.all().map((item, i) => {
  if (item.json.__noop) return { json: { __noop: true }, pairedItem: { item: i } };
  const { __category_id, __is_live, __title_lower, ...row } = item.json;
  if (__category_id === '10') { row.validity_status = 'REJECTED'; row.rejection_reason = 'MUSIC_VIDEO'; row.processing_status = 'SKIPPED'; }
  if (__is_live === 'live' || __is_live === 'upcoming') { row.validity_status = 'REJECTED'; row.rejection_reason = 'LIVE_STREAM'; row.processing_status = 'SKIPPED'; }
  return { json: row, pairedItem: { item: i } };
});`),
    codeNode('a1b2c3d4-0002-4000-8000-000000000012', 'Filter Real Rows', [2420, 20], `return $input.all().filter(i => !i.json.__noop);`),
    sheetsNode(
      'a1b2c3d4-0002-4000-8000-000000000013',
      'Append Candidates',
      [2640, 20],
      sheet('append', 'Candidate_Videos', { columns: { mappingMode: 'autoMapInputData', value: {}, matchingColumns: [] } }),
    ),
    codeNode('a1b2c3d4-0002-4000-8000-000000000014', 'Emit Source Update', [1100, -160], `const sd = $getWorkflowStaticData('global');
const channel = $('Channel Loop').first().json;
const now = new Date().toISOString();
const update = sd.sourceUpdates[channel.source_id] || {
  source_id: channel.source_id,
  backfill_next_page_token: channel.backfill_next_page_token || '',
  backfill_status: channel.backfill_status || 'COMPLETE',
  videos_known_count: Number(channel.videos_known_count || 0),
};
delete sd.sourceUpdates[channel.source_id];
return [{
  json: {
    source_id: channel.source_id,
    backfill_next_page_token: update.backfill_next_page_token || '',
    backfill_status: update.backfill_status || 'COMPLETE',
    videos_known_count: Number(update.videos_known_count || 0),
    videos_fetched_count: Number((sd.fetchedCounts || {})[channel.source_id] || 0),
    backfill_last_run_at: now,
    last_checked_at: now,
  },
  pairedItem: { item: 0 },
}];`),
    sheetsNode(
      'a1b2c3d4-0002-4000-8000-000000000015',
      'Update Source Backfill State',
      [1320, -160],
      sheet('appendOrUpdate', 'Source_Channels', {
        columns: { mappingMode: 'autoMapInputData', value: {}, matchingColumns: ['source_id'] },
      }),
    ),
  ],
  connections: {
    'Schedule 6h': { main: [[{ node: 'Read Source_Channels', type: 'main', index: 0 }]] },
    'Read Source_Channels': { main: [[{ node: 'Read Candidate_Videos', type: 'main', index: 0 }]] },
    'Read Candidate_Videos': { main: [[{ node: 'Init Run', type: 'main', index: 0 }]] },
    'Init Run': { main: [[{ node: 'Channel Loop', type: 'main', index: 0 }]] },
    'Channel Loop': {
      main: [
        [],
        [{ node: 'Build Fetch Requests', type: 'main', index: 0 }],
      ],
    },
    'Build Fetch Requests': { main: [[{ node: 'Fetch Uploads', type: 'main', index: 0 }]] },
    'Fetch Uploads': { main: [[{ node: 'Build Videos Lookup', type: 'main', index: 0 }]] },
    'Build Videos Lookup': { main: [[{ node: 'Fetch Video Details', type: 'main', index: 0 }]] },
    'Fetch Video Details': { main: [[{ node: 'Build Candidate Rows', type: 'main', index: 0 }]] },
    'Build Candidate Rows': { main: [[{ node: 'Strip Internal Fields', type: 'main', index: 0 }]] },
    'Strip Internal Fields': {
      main: [[
        { node: 'Filter Real Rows', type: 'main', index: 0 },
        { node: 'Emit Source Update', type: 'main', index: 0 },
      ]],
    },
    'Filter Real Rows': { main: [[{ node: 'Append Candidates', type: 'main', index: 0 }]] },
    'Emit Source Update': { main: [[{ node: 'Update Source Backfill State', type: 'main', index: 0 }]] },
    'Update Source Backfill State': { main: [[{ node: 'Channel Loop', type: 'main', index: 0 }]] },
  },
  settings: { executionOrder: 'v1' },
  pinData: {},
  meta: { instanceId: 'placeholder' },
};

fs.writeFileSync(workflowPath, `${JSON.stringify(workflow, null, 2)}\n`);
