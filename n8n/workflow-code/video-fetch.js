function isoDurationToSeconds(iso) {
  const match = String(iso || '').match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!match) return 0;
  return (Number(match[1] || 0) * 3600) + (Number(match[2] || 0) * 60) + Number(match[3] || 0);
}

function pickActiveChannels(sourceRows) {
  return sourceRows.filter(
    (row) => String(row.active_status).toUpperCase() === 'TRUE' && row.uploads_playlist_id,
  );
}

function countFetchedVideosBySource(candidateRows) {
  return candidateRows.reduce((counts, row) => {
    if (!row.source_id || !row.youtube_video_id) return counts;
    counts[row.source_id] = (counts[row.source_id] || 0) + 1;
    return counts;
  }, {});
}

function channelMeta(channel) {
  return {
    source_id: channel.source_id,
    source_name: channel.source_name,
    niche: channel.niche,
    risk_level: channel.risk_level,
  };
}

function buildUploadsLookup(channel, playlistApi) {
  const ids = (playlistApi.items || [])
    .map((item) => item.contentDetails && item.contentDetails.videoId)
    .filter(Boolean);
  const meta = channelMeta(channel);

  if (ids.length === 0) return { __empty: true, ...meta };
  return { video_ids: ids.join(','), ...meta };
}

function buildFetchPlan(channel) {
  const base = {
    uploads_playlist_id: channel.uploads_playlist_id,
    source_id: channel.source_id,
  };
  const plan = [{ ...base, fetch_kind: 'latest', page_token: '' }];

  if (String(channel.backfill_status || '').toUpperCase() !== 'COMPLETE') {
    plan.push({
      ...base,
      fetch_kind: 'backfill',
      page_token: channel.backfill_next_page_token || '',
    });
  }

  return plan;
}

function buildCandidateRows(meta, videoApi, existingIds, now = new Date().toISOString()) {
  if (meta.__empty) return [{ __noop: true }];

  const out = [];
  for (const video of videoApi.items || []) {
    if (!video.id || existingIds[video.id]) continue;
    existingIds[video.id] = true;

    const snippet = video.snippet || {};
    const statistics = video.statistics || {};
    out.push({
      video_id: `VID-${video.id}`,
      niche: meta.niche,
      source_id: meta.source_id,
      source_name: meta.source_name,
      video_title: snippet.title,
      video_url: `https://www.youtube.com/watch?v=${video.id}`,
      youtube_video_id: video.id,
      duration_seconds: isoDurationToSeconds(video.contentDetails && video.contentDetails.duration),
      published_at: snippet.publishedAt,
      view_count: Number(statistics.viewCount || 0),
      like_count: Number(statistics.likeCount || 0),
      comment_count: Number(statistics.commentCount || 0),
      transcript_available: '',
      language: snippet.defaultAudioLanguage || snippet.defaultLanguage || '',
      validity_status: '',
      validity_score: '',
      rejection_reason: '',
      duplicate_status: 'UNIQUE',
      processing_status: 'NEW',
      created_at: now,
      __category_id: snippet.categoryId || '',
      __is_live: snippet.liveBroadcastContent || 'none',
      __title_lower: (snippet.title || '').toLowerCase(),
    });
  }

  if (out.length === 0) return [{ __noop: true }];
  return out;
}

function stripInternalFields(rows) {
  return rows.map((item) => {
    if (item.__noop) return { __noop: true };

    const { __category_id, __is_live, __title_lower, ...row } = item;
    if (__category_id === '10') {
      row.validity_status = 'REJECTED';
      row.rejection_reason = 'MUSIC_VIDEO';
      row.processing_status = 'SKIPPED';
    }
    if (__is_live === 'live' || __is_live === 'upcoming') {
      row.validity_status = 'REJECTED';
      row.rejection_reason = 'LIVE_STREAM';
      row.processing_status = 'SKIPPED';
    }
    return row;
  });
}

function touchedChannelUpdates(sourceIds, now = new Date().toISOString()) {
  return [...new Set(sourceIds || [])].map((sourceId) => ({
    source_id: sourceId,
    last_checked_at: now,
  }));
}

function buildSourceUpdate(channel, backfillApi, fetchedCounts, now = new Date().toISOString()) {
  const nextToken = backfillApi.nextPageToken || '';
  return {
    source_id: channel.source_id,
    backfill_next_page_token: nextToken,
    backfill_status: nextToken ? 'IN_PROGRESS' : 'COMPLETE',
    videos_known_count: Number((backfillApi.pageInfo || {}).totalResults || 0),
    videos_fetched_count: Number(fetchedCounts[channel.source_id] || 0),
    backfill_last_run_at: now,
    last_checked_at: now,
  };
}

module.exports = {
  buildCandidateRows,
  buildFetchPlan,
  buildSourceUpdate,
  buildUploadsLookup,
  countFetchedVideosBySource,
  isoDurationToSeconds,
  pickActiveChannels,
  stripInternalFields,
  touchedChannelUpdates,
};
