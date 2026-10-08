const NICHES = ['CHRISTIAN_CONTENT', 'MOTIVATION_DISCIPLINE', 'FINANCE_BUSINESS',
  'LIFE_VALUES_RELATIONSHIPS', 'AFRICAN_KENYAN_SUCCESS'];
const PLATFORMS = ['YOUTUBE_SHORTS', 'TIKTOK', 'INSTAGRAM_REELS', 'FACEBOOK_REELS'];

const escapeHtml = (value) => String(value ?? '')
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;');

const page = ({ title, body }) => `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light dark; --gap: 1rem; }
  body { font: 16px/1.5 system-ui, sans-serif; margin: 0 auto; max-width: 60rem; padding: var(--gap); }
  nav a { margin-right: var(--gap); }
  .clip { border-top: 1px solid currentColor; padding: var(--gap) 0; }
  iframe, video { width: 100%; max-width: 24rem; aspect-ratio: 9/16; border: 0; }
  label { display: block; margin: .5rem 0; }
  .error { color: #b00; }
  fieldset { border: 1px solid currentColor; }
</style>
</head><body>
<nav><a href="/">Clips</a><a href="/moments">High-risk moments</a><a href="/channels">Add channel</a></nav>
${body}
</body></html>`;

// D11: the operator's own browser fetches this URL with their Google session.
// The server never proxies Drive and holds no Google credential.
const preview = (clip) => clip.google_drive_url
  ? `<iframe src="${escapeHtml(clip.google_drive_url)}" title="Clip preview" loading="lazy" allow="autoplay"></iframe>`
  : '<p>No Drive URL on this clip yet.</p>';

const clipQueue = (clips) => clips.length === 0
  ? '<h1>Clip review</h1><p>Nothing awaiting review.</p>'
  : `<h1>Clip review</h1>${clips.map((clip) => `<section class="clip">
  <h2>${escapeHtml(clip.clip_title || clip.suggested_title || clip.created_clip_id)}</h2>
  ${preview(clip)}
  ${approveForm(clip)}
  <form method="post" action="/clips/reject">
    <input type="hidden" name="created_clip_id" value="${escapeHtml(clip.created_clip_id)}">
    <button type="submit">Reject</button>
  </form>
</section>`).join('')}`;

const approveForm = (clip) => `<form method="post" action="/clips/approve">
  <input type="hidden" name="created_clip_id" value="${escapeHtml(clip.created_clip_id)}">
  <label>Title <input name="final_title" required value="${escapeHtml(clip.suggested_title || '')}"></label>
  <label>Caption <textarea name="final_caption" rows="3">${escapeHtml(clip.suggested_caption || '')}</textarea></label>
  <label>Hashtags <input name="hashtags" value="${escapeHtml((clip.hashtags || []).join(' '))}"></label>
  <fieldset><legend>Platforms</legend>
  ${PLATFORMS.map((platform) => `<label><input type="checkbox" name="platforms" value="${platform}"> ${platform}</label>`).join('')}
  </fieldset>
  <label>Schedule (optional) <input type="datetime-local" name="scheduled_at"></label>
  <button type="submit">Approve</button>
</form>`;

const momentQueue = (moments) => moments.length === 0
  ? '<h1>High-risk moments</h1><p>Nothing awaiting approval.</p>'
  : `<h1>High-risk moments</h1>${moments.map((moment) => `<section class="clip">
  <h2>${escapeHtml(moment.suggested_title || moment.clip_moment_id)}</h2>
  <p>${escapeHtml(moment.niche)} &middot; ${escapeHtml(moment.core_idea || '')}</p>
  <form method="post" action="/moments/approve">
    <input type="hidden" name="clip_moment_id" value="${escapeHtml(moment.clip_moment_id)}">
    <button type="submit">Release for download</button>
  </form>
</section>`).join('')}`;

const channelForm = (values = {}, errors = {}) => `<h1>Add source channel</h1>
<form method="post" action="/channels">
  ${['source_id', 'source_name', 'youtube_channel_url'].map((field) => `<label>${field}
    <input name="${field}" required value="${escapeHtml(values[field] || '')}">
    ${errors[field] ? `<span class="error">${escapeHtml(errors[field])}</span>` : ''}
  </label>`).join('')}
  <label>niche
    <select name="niche" required>${NICHES.map((niche) =>
      `<option value="${niche}"${values.niche === niche ? ' selected' : ''}>${niche}</option>`).join('')}</select>
    ${errors.niche ? `<span class="error">${escapeHtml(errors.niche)}</span>` : ''}
  </label>
  <label>priority <input type="number" name="priority" min="1" value="${escapeHtml(values.priority || 1)}"></label>
  <button type="submit">Add</button>
</form>`;

const parseApproveForm = (formData) => {
  const errors = {};
  const title = (formData.get('final_title') || '').trim();
  const platforms = formData.getAll('platforms').filter((platform) => PLATFORMS.includes(platform));
  const caption = (formData.get('final_caption') || '').trim();
  const hashtags = (formData.get('hashtags') || '').split(/\s+/).filter(Boolean);
  const scheduled = (formData.get('scheduled_at') || '').trim();

  if (!title) errors.final_title = 'A final title is required.';
  // Blank does not mean all platforms.
  if (platforms.length === 0) errors.platforms = 'Tick at least one platform.';

  return {
    errors,
    values: {
      p_created_clip_id: formData.get('created_clip_id'),
      p_final_title: title,
      p_final_caption: caption || null,
      p_platforms: platforms,
      p_hashtags: hashtags.length ? hashtags : null,
      p_scheduled_at: scheduled ? new Date(scheduled).toISOString() : null,
    },
  };
};

const parseChannelForm = (formData) => {
  const errors = {};
  const values = {};
  for (const field of ['source_id', 'source_name', 'youtube_channel_url']) {
    values[field] = (formData.get(field) || '').trim();
    if (!values[field]) errors[field] = `${field} is required.`;
  }
  values.niche = formData.get('niche');
  if (!NICHES.includes(values.niche)) errors.niche = 'Pick one of the five niches.';
  if (values.youtube_channel_url && !/^https:\/\/(www\.)?youtube\.com\//.test(values.youtube_channel_url)) {
    errors.youtube_channel_url = 'Must be a https://youtube.com/ URL.';
  }
  values.priority = Number(formData.get('priority') || 1);
  // youtube_channel_id and uploads_playlist_id are deliberately absent: WF1
  // resolves them from the URL.
  return { errors, values };
};

module.exports = { page, clipQueue, approveForm, channelForm, momentQueue,
  parseApproveForm, parseChannelForm, escapeHtml, NICHES, PLATFORMS };
