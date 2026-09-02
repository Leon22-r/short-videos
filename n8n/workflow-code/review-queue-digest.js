function escapeHtml(value) {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function buildReviewDigest(clips, channels = []) {
  const pending = clips.filter((clip) => String(clip.review_status) === 'NEEDS_REVIEW');

  const yesterday = new Date(Date.now() - 86400000);
  const recentlyPaused = channels.filter((ch) => {
    if (!ch.auto_paused_at) return false;
    try { return new Date(ch.auto_paused_at) > yesterday; } catch { return false; }
  });
  const channelsByNiche = {};
  for (const channel of channels) {
    const niche = channel.niche || 'UNKNOWN';
    channelsByNiche[niche] = channelsByNiche[niche] || [];
    channelsByNiche[niche].push(channel);
  }
  const exhaustedNiches = Object.entries(channelsByNiche)
    .map(([niche, nicheChannels]) => {
      const active = nicheChannels.filter((channel) => String(channel.active_status || '').toUpperCase() === 'TRUE');
      if (nicheChannels.length === 0 || active.length > 0) return null;
      const autoPaused = nicheChannels.filter((channel) => channel.auto_paused_at);
      return {
        niche,
        total: nicheChannels.length,
        autoPaused: autoPaused.length,
        manualInactive: nicheChannels.length - autoPaused.length,
        reason: autoPaused.length === nicheChannels.length
          ? 'all channels auto-paused for low-quality videos'
          : 'no active channels remain',
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.niche.localeCompare(b.niche));

  if (pending.length === 0 && recentlyPaused.length === 0 && exhaustedNiches.length === 0) return null;

  let html = '';

  if (pending.length > 0) {
    const byNiche = {};
    for (const clip of pending) {
      const niche = clip.niche || 'UNKNOWN';
      byNiche[niche] = byNiche[niche] || [];
      byNiche[niche].push(clip);
    }
    html += `<h2>Clips awaiting review: ${pending.length}</h2>`;
    for (const niche of Object.keys(byNiche).sort()) {
      html += `<h3>${escapeHtml(niche)} (${byNiche[niche].length})</h3><ul>`;
      for (const clip of byNiche[niche]) {
        const title = escapeHtml(clip.suggested_title || clip.clip_title || clip.created_clip_id);
        html += `<li><a href="${escapeHtml(clip.google_drive_url)}">${title}</a> - ${escapeHtml(clip.duration_seconds)}s - ${escapeHtml(clip.reviewer_notes)}</li>`;
      }
      html += '</ul>';
    }
    html += '<p>Approve by setting review_status=APPROVED in Created_Clips, then copy to Approved_For_Posting.</p>';
  }

  if (recentlyPaused.length > 0) {
    html += `<h2>Channels auto-paused today: ${recentlyPaused.length}</h2><ul>`;
    for (const ch of recentlyPaused) {
      html += `<li><strong>${escapeHtml(ch.source_name)}</strong> [${escapeHtml(ch.niche)}] - ${escapeHtml(ch.auto_paused_reason)}</li>`;
    }
    html += '</ul>';
    html += '<p>To re-enable: set active_status=TRUE in Source_Channels tab (WF5 resets health window automatically on next run).</p>';
  }

  if (exhaustedNiches.length > 0) {
    html += `<h2>Niches needing new channels: ${exhaustedNiches.length}</h2><ul>`;
    for (const item of exhaustedNiches) {
      html += `<li><strong>${escapeHtml(item.niche)}</strong> - No active channels remain (${item.total} total, ${item.autoPaused} auto-paused, ${item.manualInactive} manually inactive). ${escapeHtml(item.reason)}.</li>`;
    }
    html += '</ul>';
    html += '<p>Add new Source_Channels rows or re-enable suitable channels to keep these niches represented.</p>';
  }

  let subject;
  if (pending.length > 0 || recentlyPaused.length > 0 || exhaustedNiches.length > 0) {
    const parts = [];
    if (pending.length > 0) parts.push(`${pending.length} clips`);
    if (recentlyPaused.length > 0) parts.push(`${recentlyPaused.length} channels auto-paused`);
    if (exhaustedNiches.length > 0) parts.push(`${exhaustedNiches.length} niche attention`);
    subject = `Shorts review queue: ${parts.join(', ')}`;
  } else if (pending.length > 0) {
    subject = `Shorts review queue: ${pending.length} clips`;
  } else {
    subject = `Shorts alert: ${recentlyPaused.length} channels auto-paused`;
  }

  return { subject, html };
}

module.exports = {
  buildReviewDigest,
};
