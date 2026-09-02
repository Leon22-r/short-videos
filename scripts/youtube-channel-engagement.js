#!/usr/bin/env node

const https = require('node:https');

const ENGAGEMENT_GATE = {
  minViews: 10000,
  minLikePercentage: 0.02,
  minEngagementPercentage: 0.02,
  minCommentPercentage: 0.0005,
};

function numberValue(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function computeVideoMetrics(video) {
  const stats = video.statistics || {};
  const views = numberValue(stats.viewCount);
  const likes = numberValue(stats.likeCount);
  const comments = numberValue(stats.commentCount);
  const likePercentage = views > 0 ? likes / views : 0;
  const commentPercentage = views > 0 ? comments / views : 0;
  const engagementPercentage = views > 0 ? (likes + comments) / views : 0;

  return {
    video_id: video.id,
    title: (video.snippet && video.snippet.title) || '',
    published_at: (video.snippet && video.snippet.publishedAt) || '',
    views,
    likes,
    comments,
    like_percentage: likePercentage,
    comment_percentage: commentPercentage,
    engagement_percentage: engagementPercentage,
    passes_engagement_gate:
      views >= ENGAGEMENT_GATE.minViews &&
      likePercentage >= ENGAGEMENT_GATE.minLikePercentage &&
      engagementPercentage >= ENGAGEMENT_GATE.minEngagementPercentage &&
      commentPercentage >= ENGAGEMENT_GATE.minCommentPercentage,
  };
}

function formatPercent(value) {
  return `${(numberValue(value) * 100).toFixed(2)}%`;
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => {
        let parsed;
        try {
          parsed = JSON.parse(body);
        } catch (error) {
          reject(new Error(`Invalid JSON from YouTube API: ${error.message}`));
          return;
        }

        if (res.statusCode < 200 || res.statusCode >= 300) {
          const apiError = parsed.error && parsed.error.message ? parsed.error.message : body;
          reject(new Error(`YouTube API ${res.statusCode}: ${apiError}`));
          return;
        }

        resolve(parsed);
      });
    }).on('error', reject);
  });
}

function uploadsPlaylistFromChannelId(channelId) {
  if (!/^UC[A-Za-z0-9_-]{22}$/.test(channelId)) return '';
  return `UU${channelId.slice(2)}`;
}

function parseChannelInput(input) {
  const value = String(input || '').trim();
  const channelIdMatch = value.match(/(?:^|\/)(UC[A-Za-z0-9_-]{22})(?:[/?#]|$)/);
  if (channelIdMatch) return { type: 'channel_id', value: channelIdMatch[1] };

  const handleMatch = value.match(/(?:youtube\.com\/)?@([A-Za-z0-9._-]+)(?:[/?#]|$)/);
  if (handleMatch) return { type: 'handle', value: handleMatch[1] };

  const customMatch = value.match(/youtube\.com\/(?:c|user)\/([^/?#]+)/);
  if (customMatch) return { type: 'search', value: decodeURIComponent(customMatch[1]) };

  return { type: 'search', value };
}

async function resolveUploadsPlaylist(input, apiKey) {
  const parsed = parseChannelInput(input);
  if (parsed.type === 'channel_id') {
    return {
      channelId: parsed.value,
      uploadsPlaylistId: uploadsPlaylistFromChannelId(parsed.value),
    };
  }

  const encodedKey = encodeURIComponent(apiKey);
  let url;
  if (parsed.type === 'handle') {
    url = `https://www.googleapis.com/youtube/v3/channels?part=id,contentDetails&forHandle=${encodeURIComponent(parsed.value)}&key=${encodedKey}`;
  } else {
    url = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=channel&maxResults=1&q=${encodeURIComponent(parsed.value)}&key=${encodedKey}`;
  }

  const response = await getJson(url);
  const item = response.items && response.items[0];
  if (!item) throw new Error(`No YouTube channel found for "${input}"`);

  if (parsed.type === 'handle') {
    return {
      channelId: item.id,
      uploadsPlaylistId: item.contentDetails.relatedPlaylists.uploads,
    };
  }

  const channelId = item.snippet.channelId;
  return {
    channelId,
    uploadsPlaylistId: uploadsPlaylistFromChannelId(channelId),
  };
}

async function fetchUploads(uploadsPlaylistId, apiKey, maxVideos) {
  const videoIds = [];
  let pageToken = '';

  while (videoIds.length < maxVideos) {
    const pageSize = Math.min(50, maxVideos - videoIds.length);
    const url = new URL('https://www.googleapis.com/youtube/v3/playlistItems');
    url.searchParams.set('part', 'contentDetails');
    url.searchParams.set('playlistId', uploadsPlaylistId);
    url.searchParams.set('maxResults', String(pageSize));
    url.searchParams.set('key', apiKey);
    if (pageToken) url.searchParams.set('pageToken', pageToken);

    const response = await getJson(url.toString());
    for (const item of response.items || []) {
      const videoId = item.contentDetails && item.contentDetails.videoId;
      if (videoId) videoIds.push(videoId);
    }

    if (!response.nextPageToken) break;
    pageToken = response.nextPageToken;
  }

  return videoIds;
}

async function fetchVideoDetails(videoIds, apiKey) {
  const videos = [];
  for (let i = 0; i < videoIds.length; i += 50) {
    const batch = videoIds.slice(i, i + 50);
    const url = new URL('https://www.googleapis.com/youtube/v3/videos');
    url.searchParams.set('part', 'snippet,statistics');
    url.searchParams.set('id', batch.join(','));
    url.searchParams.set('key', apiKey);

    const response = await getJson(url.toString());
    videos.push(...(response.items || []));
  }

  return videos;
}

function printTable(rows) {
  console.log([
    'PASS',
    'VIEWS',
    'LIKES',
    'COMMENTS',
    'LIKE_%',
    'COMMENT_%',
    'ENGAGEMENT_%',
    'VIDEO_ID',
    'TITLE',
  ].join('\t'));

  for (const row of rows) {
    console.log([
      row.passes_engagement_gate ? 'YES' : 'NO',
      row.views,
      row.likes,
      row.comments,
      formatPercent(row.like_percentage),
      formatPercent(row.comment_percentage),
      formatPercent(row.engagement_percentage),
      row.video_id,
      row.title.replace(/\s+/g, ' ').trim(),
    ].join('\t'));
  }
}

function parseArgs(argv) {
  const args = {
    channel: '',
    maxVideos: 25,
    json: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') {
      args.json = true;
    } else if (arg === '--max') {
      args.maxVideos = Number(argv[i + 1] || 25);
      i += 1;
    } else if (!args.channel) {
      args.channel = arg;
    }
  }

  if (!args.channel) {
    throw new Error('Usage: YOUTUBE_API_KEY=... node scripts/youtube-channel-engagement.js <channel-url-or-id> [--max 25] [--json]');
  }
  if (!Number.isInteger(args.maxVideos) || args.maxVideos < 1 || args.maxVideos > 500) {
    throw new Error('--max must be an integer between 1 and 500');
  }

  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) throw new Error('Set YOUTUBE_API_KEY in the environment');

  const { channelId, uploadsPlaylistId } = await resolveUploadsPlaylist(args.channel, apiKey);
  const videoIds = await fetchUploads(uploadsPlaylistId, apiKey, args.maxVideos);
  const videos = await fetchVideoDetails(videoIds, apiKey);
  const rows = videos.map(computeVideoMetrics);

  if (args.json) {
    console.log(JSON.stringify({ channel_id: channelId, uploads_playlist_id: uploadsPlaylistId, videos: rows }, null, 2));
  } else {
    console.log(`# channel_id=${channelId} uploads_playlist_id=${uploadsPlaylistId}`);
    printTable(rows);
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  computeVideoMetrics,
  formatPercent,
  parseChannelInput,
  uploadsPlaylistFromChannelId,
};
