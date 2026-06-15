const fs = require('node:fs');

const workflowPath = process.argv[2];
const keyMode = process.argv[3] || 'preserve';

if (!workflowPath) {
  console.error('Usage: node n8n/workflow-code/update-wf1-code.js <workflow.json> [preserve|placeholder]');
  process.exit(1);
}

const workflows = JSON.parse(fs.readFileSync(workflowPath, 'utf8'));
const workflow = Array.isArray(workflows) ? workflows[0] : workflows;

const pickNode = workflow.nodes.find((node) => node.name === 'Pick Unresolved');
const parseNode = workflow.nodes.find((node) => node.name === 'Parse Channel Response');

if (!pickNode || !parseNode) {
  throw new Error('Expected Pick Unresolved and Parse Channel Response nodes');
}

function extractKeyLine(jsCode) {
  const match = jsCode.match(/const KEY = .*?;/);
  if (!match) return "const KEY = 'YOUTUBE_API_KEY';";
  return match[0];
}

const keyLine = keyMode === 'placeholder'
  ? "const KEY = 'YOUTUBE_API_KEY';"
  : extractKeyLine(pickNode.parameters.jsCode);

pickNode.parameters.jsCode = `// Rows with a URL but no resolved channel id; build a YouTube API lookup URL per row.
${keyLine}

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

function buildLookup(row, key) {
  if (!row.youtube_channel_url || row.youtube_channel_id) return null;

  const url = String(row.youtube_channel_url).trim();
  if (!url) return null;

  const encodedKey = encodeURIComponent(key);
  const channelMatch = url.match(/\\/channel\\/(UC[A-Za-z0-9_-]{22})(?:[/?#]|$)/);
  if (channelMatch) {
    const channelId = channelMatch[1];
    return {
      ...row,
      lookup_type: 'channel_id',
      lookup_value: channelId,
      lookup_url: \`https://www.googleapis.com/youtube/v3/channels?part=id,contentDetails&id=\${encodeURIComponent(channelId)}&key=\${encodedKey}\`,
    };
  }

  const handleMatch = url.match(/\\/@([A-Za-z0-9._-]+)(?:[/?#]|$)/);
  if (handleMatch) {
    const handle = handleMatch[1];
    return {
      ...row,
      lookup_type: 'handle',
      lookup_value: handle,
      lookup_url: \`https://www.googleapis.com/youtube/v3/channels?part=id,contentDetails&forHandle=\${encodeURIComponent(handle)}&key=\${encodedKey}\`,
    };
  }

  const usernameMatch = url.match(/\\/user\\/([^/?#]+)(?:[/?#]|$)/);
  if (usernameMatch) {
    const username = decodeURIComponent(usernameMatch[1]);
    return {
      ...row,
      lookup_type: 'username',
      lookup_value: username,
      lookup_url: \`https://www.googleapis.com/youtube/v3/channels?part=id,contentDetails&forUsername=\${encodeURIComponent(username)}&key=\${encodedKey}\`,
    };
  }

  const customMatch = url.match(/\\/c\\/([^/?#]+)(?:[/?#]|$)/);
  if (customMatch) {
    const customName = decodeURIComponent(customMatch[1]);
    return {
      ...row,
      lookup_type: 'custom_url_search',
      lookup_value: customName,
      lookup_url: \`https://www.googleapis.com/youtube/v3/search?part=snippet&type=channel&maxResults=1&q=\${encodeURIComponent(customName)}&key=\${encodedKey}\`,
    };
  }

  const videoId = extractYouTubeVideoId(url);
  if (videoId) {
    return {
      ...row,
      lookup_type: 'video',
      lookup_value: videoId,
      lookup_url: \`https://www.googleapis.com/youtube/v3/videos?part=snippet&id=\${encodeURIComponent(videoId)}&key=\${encodedKey}\`,
    };
  }

  return null;
}

const out = [];
$input.all().forEach((item, index) => {
  const lookup = buildLookup(item.json, KEY);
  if (!lookup) return;
  out.push({ json: lookup, pairedItem: { item: index } });
});

return out;`;

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
