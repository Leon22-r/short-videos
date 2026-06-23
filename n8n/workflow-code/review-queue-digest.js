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

  if (pending.length === 0 && recentlyPaused.length === 0) return null;

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
    html += `<h2>⚠️ Channels auto-paused today: ${recentlyPaused.length}</h2><ul>`;
    for (const ch of recentlyPaused) {
      html += `<li><strong>${escapeHtml(ch.source_name)}</strong> [${escapeHtml(ch.niche)}] — ${escapeHtml(ch.auto_paused_reason)}</li>`;
    }
    html += '</ul>';
    html += '<p>To re-enable: set active_status=TRUE in Source_Channels tab (WF5 resets health window automatically on next run).</p>';
  }

  let subject;
  if (pending.length > 0 && recentlyPaused.length > 0) {
    subject = `Shorts review queue: ${pending.length} clips, ${recentlyPaused.length} channels paused`;
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
