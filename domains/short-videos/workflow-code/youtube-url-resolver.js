function uploadsPlaylistFromChannelId(channelId) {
  if (!/^UC[A-Za-z0-9_-]{22}$/.test(channelId)) return '';
  return `UU${channelId.slice(2)}`;
}

function extractYouTubeVideoId(url) {
  const patterns = [
    /(?:youtube\.com|m\.youtube\.com)\/watch\?[^#]*\bv=([A-Za-z0-9_-]{11})/,
    /(?:youtu\.be)\/([A-Za-z0-9_-]{11})/,
    /(?:youtube\.com|m\.youtube\.com)\/shorts\/([A-Za-z0-9_-]{11})/,
    /(?:youtube\.com|m\.youtube\.com)\/embed\/([A-Za-z0-9_-]{11})/,
    /(?:youtube\.com|m\.youtube\.com)\/live\/([A-Za-z0-9_-]{11})/,
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

  const channelMatch = url.match(/\/channel\/(UC[A-Za-z0-9_-]{22})(?:[/?#]|$)/);
  if (channelMatch) {
    const channelId = channelMatch[1];
    return {
      ...row,
      lookup_type: 'channel_id',
      lookup_value: channelId,
      lookup_url: `https://www.googleapis.com/youtube/v3/channels?part=id,contentDetails&id=${encodeURIComponent(channelId)}`,
    };
  }

  const handleMatch = url.match(/\/@([A-Za-z0-9._-]+)(?:[/?#]|$)/);
  if (handleMatch) {
    const handle = handleMatch[1];
    return {
      ...row,
      lookup_type: 'handle',
      lookup_value: handle,
      lookup_url: `https://www.googleapis.com/youtube/v3/channels?part=id,contentDetails&forHandle=${encodeURIComponent(handle)}`,
    };
  }

  const usernameMatch = url.match(/\/user\/([^/?#]+)(?:[/?#]|$)/);
  if (usernameMatch) {
    const username = decodeURIComponent(usernameMatch[1]);
    return {
      ...row,
      lookup_type: 'username',
      lookup_value: username,
      lookup_url: `https://www.googleapis.com/youtube/v3/channels?part=id,contentDetails&forUsername=${encodeURIComponent(username)}`,
    };
  }

  const customMatch = url.match(/\/c\/([^/?#]+)(?:[/?#]|$)/);
  if (customMatch) {
    const customName = decodeURIComponent(customMatch[1]);
    return {
      ...row,
      lookup_type: 'custom_url_search',
      lookup_value: customName,
      lookup_url: `https://www.googleapis.com/youtube/v3/search?part=snippet&type=channel&maxResults=1&q=${encodeURIComponent(customName)}`,
    };
  }

  const videoId = extractYouTubeVideoId(url);
  if (videoId) {
    return {
      ...row,
      lookup_type: 'video',
      lookup_value: videoId,
      lookup_url: `https://www.googleapis.com/youtube/v3/videos?part=snippet&id=${encodeURIComponent(videoId)}`,
    };
  }

  return {
    source_id: row.source_id,
    notes: `RESOLVE_SKIPPED: unsupported YouTube URL ${url}`,
  };
}

function parseLookupResponse(row, api) {
  const item = api.items && api.items[0];
  if (!item) {
    return {
      source_id: row.source_id,
      notes: `RESOLVE_FAILED: no channel for ${row.youtube_channel_url}`,
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
    uploads_playlist_id:
      item.contentDetails &&
      item.contentDetails.relatedPlaylists &&
      item.contentDetails.relatedPlaylists.uploads,
    last_checked_at: new Date().toISOString(),
  };
}

module.exports = {
  buildLookup,
  extractYouTubeVideoId,
  parseLookupResponse,
  uploadsPlaylistFromChannelId,
};
