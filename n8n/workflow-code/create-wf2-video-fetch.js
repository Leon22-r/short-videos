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

const googleSheetsNode = (id, name, position, parameters, extra = {}) => ({
  parameters,
  id,
  name,
  type: 'n8n-nodes-base.googleSheets',
  typeVersion: 4.5,
  position,
  ...extra,
});

const workflow = {
  name: 'WF2 Video Fetch',
  nodes: [
    {
      parameters: { rule: { interval: [{ field: 'hours', hoursInterval: 6 }] } },
      id: 'a1b2c3d4-0002-4000-8000-000000000001',
      name: 'Schedule 6h',
      type: 'n8n-nodes-base.scheduleTrigger',
      typeVersion: 1.2,
      position: [0, 0],
    },
    googleSheetsNode(
      'a1b2c3d4-0002-4000-8000-000000000002',
      'Read Source_Channels',
      [220, 0],
      sheet('read', 'Source_Channels'),
    ),
    googleSheetsNode(
      'a1b2c3d4-0002-4000-8000-000000000003',
      'Read Candidate_Videos',
      [440, 0],
      sheet('read', 'Candidate_Videos'),
      { alwaysOutputData: true },
    ),
    codeNode('a1b2c3d4-0002-4000-8000-000000000004', 'Init Run', [660, 0], `// Build dedup set + select active channels. staticData survives across loop iterations.
const sd = $getWorkflowStaticData('global');
sd.existingIds = {};
for (const item of $('Read Candidate_Videos').all()) {
  const id = item.json.youtube_video_id;
  if (id) sd.existingIds[id] = true;
}
sd.touchedSources = [];
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
    {
      parameters: {
        method: 'GET',
        url: '=https://www.googleapis.com/youtube/v3/playlistItems?part=contentDetails&maxResults=10&playlistId={{ $json.uploads_playlist_id }}&key=YOUTUBE_API_KEY',
        options: {},
      },
      id: 'a1b2c3d4-0002-4000-8000-000000000006',
      name: 'Fetch Uploads',
      type: 'n8n-nodes-base.httpRequest',
      typeVersion: 4.2,
      position: [1100, 120],
    },
    codeNode('a1b2c3d4-0002-4000-8000-000000000007', 'Build Videos Lookup', [1320, 120], `const channel = $('Channel Loop').first().json;
const api = $input.first().json;
const ids = (api.items || []).map(i => i.contentDetails && i.contentDetails.videoId).filter(Boolean);
if (ids.length === 0) {
  return [{ json: { __empty: true, ...channelMeta(channel) }, pairedItem: { item: 0 } }];
}
return [{ json: { video_ids: ids.join(','), ...channelMeta(channel) }, pairedItem: { item: 0 } }];

function channelMeta(c) {
  return { source_id: c.source_id, source_name: c.source_name, niche: c.niche, risk_level: c.risk_level };
}`),
    {
      parameters: {
        method: 'GET',
        url: "=https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails,statistics,liveStreamingDetails&id={{ $json.video_ids || 'dQw4w9WgXcQ' }}&key=YOUTUBE_API_KEY",
        options: {},
      },
      id: 'a1b2c3d4-0002-4000-8000-000000000008',
      name: 'Fetch Video Details',
      type: 'n8n-nodes-base.httpRequest',
      typeVersion: 4.2,
      position: [1540, 120],
      alwaysOutputData: true,
    },
    codeNode('a1b2c3d4-0002-4000-8000-000000000009', 'Build Candidate Rows', [1760, 120], `const sd = $getWorkflowStaticData('global');
const meta = $('Build Videos Lookup').first().json;
sd.touchedSources.push(meta.source_id);
if (meta.__empty) return [{ json: { __noop: true }, pairedItem: { item: 0 } }];
const api = $input.first().json;
const out = [];
const now = new Date().toISOString();
for (const v of api.items || []) {
  if (sd.existingIds[v.id]) continue;
  sd.existingIds[v.id] = true;
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
    pairedItem: { item: 0 },
  });
}
if (out.length === 0) return [{ json: { __noop: true }, pairedItem: { item: 0 } }];
return out;

function isoDurationToSeconds(iso) {
  const m = String(iso || '').match(/PT(?:(\\d+)H)?(?:(\\d+)M)?(?:(\\d+)S)?/);
  if (!m) return 0;
  return (Number(m[1] || 0) * 3600) + (Number(m[2] || 0) * 60) + Number(m[3] || 0);
}`),
    codeNode('a1b2c3d4-0002-4000-8000-000000000010', 'Strip Internal Fields', [1980, 120], `return $input.all().map((item, i) => {
  if (item.json.__noop) return { json: { __noop: true }, pairedItem: { item: i } };
  const { __category_id, __is_live, __title_lower, ...row } = item.json;
  if (__category_id === '10') { row.validity_status = 'REJECTED'; row.rejection_reason = 'MUSIC_VIDEO'; row.processing_status = 'SKIPPED'; }
  if (__is_live === 'live' || __is_live === 'upcoming') { row.validity_status = 'REJECTED'; row.rejection_reason = 'LIVE_STREAM'; row.processing_status = 'SKIPPED'; }
  return { json: row, pairedItem: { item: i } };
});`),
    codeNode('a1b2c3d4-0002-4000-8000-000000000011', 'Filter Real Rows', [2200, 20], `return $input.all().filter(i => !i.json.__noop);`),
    googleSheetsNode(
      'a1b2c3d4-0002-4000-8000-000000000012',
      'Append Candidates',
      [2420, 20],
      sheet('append', 'Candidate_Videos', {
        columns: { mappingMode: 'autoMapInputData', value: {}, matchingColumns: [] },
      }),
    ),
    codeNode('a1b2c3d4-0002-4000-8000-000000000013', 'Emit Touched Channels', [1100, -160], `const sd = $getWorkflowStaticData('global');
const now = new Date().toISOString();
const ids = [...new Set(sd.touchedSources || [])];
sd.touchedSources = [];
sd.existingIds = {};
return ids.map((id, i) => ({ json: { source_id: id, last_checked_at: now }, pairedItem: { item: i } }));`),
    googleSheetsNode(
      'a1b2c3d4-0002-4000-8000-000000000014',
      'Update last_checked_at',
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
        [{ node: 'Emit Touched Channels', type: 'main', index: 0 }],
        [{ node: 'Fetch Uploads', type: 'main', index: 0 }],
      ],
    },
    'Fetch Uploads': { main: [[{ node: 'Build Videos Lookup', type: 'main', index: 0 }]] },
    'Build Videos Lookup': { main: [[{ node: 'Fetch Video Details', type: 'main', index: 0 }]] },
    'Fetch Video Details': { main: [[{ node: 'Build Candidate Rows', type: 'main', index: 0 }]] },
    'Build Candidate Rows': { main: [[{ node: 'Strip Internal Fields', type: 'main', index: 0 }]] },
    'Strip Internal Fields': {
      main: [[
        { node: 'Filter Real Rows', type: 'main', index: 0 },
        { node: 'Channel Loop', type: 'main', index: 0 },
      ]],
    },
    'Filter Real Rows': { main: [[{ node: 'Append Candidates', type: 'main', index: 0 }]] },
    'Emit Touched Channels': { main: [[{ node: 'Update last_checked_at', type: 'main', index: 0 }]] },
  },
  settings: { executionOrder: 'v1' },
  pinData: {},
  meta: { instanceId: 'placeholder' },
};

fs.writeFileSync(workflowPath, `${JSON.stringify(workflow, null, 2)}\n`);
