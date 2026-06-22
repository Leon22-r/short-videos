function escapeHtml(value) {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function buildReviewDigest(clips) {
  const pending = clips.filter((clip) => String(clip.review_status) === 'NEEDS_REVIEW');
  if (pending.length === 0) return null;

  const byNiche = {};
  for (const clip of pending) {
    const niche = clip.niche || 'UNKNOWN';
    byNiche[niche] = byNiche[niche] || [];
    byNiche[niche].push(clip);
  }

  let html = `<h2>Clips awaiting review: ${pending.length}</h2>`;
  for (const niche of Object.keys(byNiche).sort()) {
    html += `<h3>${escapeHtml(niche)} (${byNiche[niche].length})</h3><ul>`;
    for (const clip of byNiche[niche]) {
      const title = escapeHtml(clip.suggested_title || clip.clip_title || clip.created_clip_id);
      html += `<li><a href="${escapeHtml(clip.google_drive_url)}">${title}</a> - ${escapeHtml(clip.duration_seconds)}s - ${escapeHtml(clip.reviewer_notes)}</li>`;
    }
    html += '</ul>';
  }
  html += '<p>Approve by setting review_status=APPROVED in Created_Clips, then copy to Approved_For_Posting.</p>';

  return {
    subject: `Shorts review queue: ${pending.length} clips`,
    html,
  };
}

module.exports = {
  buildReviewDigest,
};
