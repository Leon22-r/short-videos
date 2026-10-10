const fs = require('node:fs');

const { querySql, postgresNode } = require('./table-node');

const workflowPath = process.argv[2];
if (!workflowPath) {
  console.error('Usage: node domains/short-videos/workflow-code/update-wf1-code.js <workflow.json>');
  process.exit(1);
}

const workflows = JSON.parse(fs.readFileSync(workflowPath, 'utf8'));
const workflow = Array.isArray(workflows) ? workflows[0] : workflows;

workflow.description = 'Resolves human-entered YouTube channel URLs into stable channel and uploads-playlist IDs. It keeps source registration explicit while giving downstream discovery a cheap, deterministic playlist input.';

const pickNode = workflow.nodes.find((node) => node.name === 'Pick Unresolved');
const resolveNode = workflow.nodes.find((node) => node.name === 'Resolve Channel');
const parseNode = workflow.nodes.find((node) => node.name === 'Parse Channel Response');

if (!pickNode || !resolveNode || !parseNode) {
  throw new Error('Expected Pick Unresolved, Resolve Channel, and Parse Channel Response nodes');
}

pickNode.parameters.jsCode = `// Rows with a URL but no resolved channel id; build a YouTube API lookup URL per row.
function extractYouTubeVideoId(url) {
  const patterns = [
    /(?:youtube\\.com|m\\.youtube\\.com)\\/watch\\?[^#]*\\bv=([A-Za-z0-9_-]{11})/,
    /(?:youtu\\.be)\\/([A-Za-z0-9_-]{11})/,
    /(?:youtube\\.com|m\\.youtube\\.com)\\/shorts\\/([A-Za-z0-9_-]{11})/,
    /(?:youtube\\.com|m\\.youtube\\.com)\\/embed\\/([A-Za-z0-9_-]{11})/,
    /(?:youtube\\.com|m\\.youtube\\.com)\\/live\\/([A-Za-z0-9_-]{11})/,
  ];

  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) return match[1];
  }

  return null;
}

function buildLookup(row) {
  if (!row.youtube_channel_url || row.youtube_channel_id) return null;

  const url = String(row.youtube_channel_url).trim();
  if (!url) return null;

  const channelMatch = url.match(/\\/channel\\/(UC[A-Za-z0-9_-]{22})(?:[/?#]|$)/);
  if (channelMatch) {
    const channelId = channelMatch[1];
    return {
      ...row,
      lookup_type: 'channel_id',
      lookup_value: channelId,
      lookup_url: \`https://www.googleapis.com/youtube/v3/channels?part=id,contentDetails&id=\${encodeURIComponent(channelId)}\`,
    };
  }

  const handleMatch = url.match(/\\/@([A-Za-z0-9._-]+)(?:[/?#]|$)/);
  if (handleMatch) {
    const handle = handleMatch[1];
    return {
      ...row,
      lookup_type: 'handle',
      lookup_value: handle,
      lookup_url: \`https://www.googleapis.com/youtube/v3/channels?part=id,contentDetails&forHandle=\${encodeURIComponent(handle)}\`,
    };
  }

  const usernameMatch = url.match(/\\/user\\/([^/?#]+)(?:[/?#]|$)/);
  if (usernameMatch) {
    const username = decodeURIComponent(usernameMatch[1]);
    return {
      ...row,
      lookup_type: 'username',
      lookup_value: username,
      lookup_url: \`https://www.googleapis.com/youtube/v3/channels?part=id,contentDetails&forUsername=\${encodeURIComponent(username)}\`,
    };
  }

  const customMatch = url.match(/\\/c\\/([^/?#]+)(?:[/?#]|$)/);
  if (customMatch) {
    const customName = decodeURIComponent(customMatch[1]);
    return {
      ...row,
      lookup_type: 'custom_url_search',
      lookup_value: customName,
      lookup_url: \`https://www.googleapis.com/youtube/v3/search?part=snippet&type=channel&maxResults=1&q=\${encodeURIComponent(customName)}\`,
    };
  }

  const videoId = extractYouTubeVideoId(url);
  if (videoId) {
    return {
      ...row,
      lookup_type: 'video',
      lookup_value: videoId,
      lookup_url: \`https://www.googleapis.com/youtube/v3/videos?part=snippet&id=\${encodeURIComponent(videoId)}\`,
    };
  }

  return null;
}

const out = [];
$input.all().forEach((item, index) => {
  const lookup = buildLookup(item.json);
  if (!lookup) return;
  out.push({ json: lookup, pairedItem: { item: index } });
});

return out;`;

resolveNode.parameters = {
  ...resolveNode.parameters,
  authentication: 'genericCredentialType',
  genericAuthType: 'httpQueryAuth',
};
resolveNode.retryOnFail = true;
resolveNode.maxTries = 3;
resolveNode.waitBetweenTries = 5000;

// WF1 is patched in place rather than emitted whole, so the Sheets-to-Postgres
// swap happens here: the two Sheets nodes become Postgres nodes reading the
// same .sql files the other workflows use. Ids and positions are preserved so
// the regenerated JSON diffs cleanly.
const readNode = workflow.nodes.find((node) => node.name === 'Read Source_Channels');
const writeNode = workflow.nodes.find((node) => node.name === 'Update Source Row');

if (!readNode || !writeNode) {
  throw new Error('Expected Read Source_Channels and Update Source Row nodes');
}

Object.assign(readNode, postgresNode(
  readNode.id, readNode.name, readNode.position, querySql('select-source-channels'),
));

// An UPDATE, not an upsert: the operator created the row, WF1 only fills in
// the ids it resolved. An upsert naming these columns alone would fail the
// table's NOT NULL columns.
Object.assign(writeNode, postgresNode(
  writeNode.id, writeNode.name, writeNode.position,
  querySql('update-source-resolution'),
  '={{ JSON.stringify($input.all().map(item => item.json)) }}',
));

for (const node of workflow.nodes.filter((candidate) => candidate.type === 'n8n-nodes-base.postgres')) {
  node.retryOnFail = true;
  node.maxTries = 3;
  node.waitBetweenTries = 5000;
}

parseNode.parameters.jsCode = `// Pair API responses back with source rows (same order, 1:1).
function uploadsPlaylistFromChannelId(channelId) {
  if (!/^UC[A-Za-z0-9_-]{22}$/.test(channelId || '')) return '';
  return \`UU\${channelId.slice(2)}\`;
}

function parseLookupResponse(row, api) {
  const item = api.items && api.items[0];
  if (!item) {
    return {
      source_id: row.source_id,
      notes: \`RESOLVE_FAILED: no channel for \${row.youtube_channel_url}\`,
    };
  }

  if (row.lookup_type === 'video') {
    const channelId = item.snippet && item.snippet.channelId;
    return {
      source_id: row.source_id,
      youtube_channel_id: channelId,
      uploads_playlist_id: uploadsPlaylistFromChannelId(channelId),
      last_checked_at: new Date().toISOString(),
    };
  }

  if (row.lookup_type === 'custom_url_search') {
    const channelId = item.snippet && item.snippet.channelId;
    return {
      source_id: row.source_id,
      youtube_channel_id: channelId,
      uploads_playlist_id: uploadsPlaylistFromChannelId(channelId),
      last_checked_at: new Date().toISOString(),
    };
  }

  return {
    source_id: row.source_id,
    youtube_channel_id: item.id,
    uploads_playlist_id: item.contentDetails && item.contentDetails.relatedPlaylists && item.contentDetails.relatedPlaylists.uploads,
    last_checked_at: new Date().toISOString(),
  };
}

const rows = $('Pick Unresolved').all();
const out = [];
$input.all().forEach((item, i) => {
  out.push({ json: parseLookupResponse(rows[i].json, item.json), pairedItem: { item: i } });
});
return out;`;

fs.writeFileSync(workflowPath, `${JSON.stringify(workflows, null, 2)}\n`);
