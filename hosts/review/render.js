// Pure rendering. Reads no environment and performs no I/O, so the service key
// cannot reach a page (D11) and every screen below is testable without a
// database. A test asserts this file never mentions the key.

const NICHES = ['CHRISTIAN_CONTENT', 'MOTIVATION_DISCIPLINE', 'FINANCE_BUSINESS',
  'LIFE_VALUES_RELATIONSHIPS', 'AFRICAN_KENYAN_SUCCESS'];
const PLATFORMS = ['YOUTUBE_SHORTS', 'TIKTOK', 'INSTAGRAM_REELS', 'FACEBOOK_REELS'];

// What an operator can see wrong with a clip, in their words rather than the
// pipeline's. Each one points at a knob: a bad cut or a weak hook is WF5's
// prompt, poor audio is the source channel, off-niche is the channel's niche.
// Grouping rejections by these is how a pattern becomes a fix.
const REJECT_REASONS = [
  ['WRONG_CUT', 'Cut in the wrong place'],
  ['WEAK_HOOK', 'Hook does not land'],
  ['POOR_AUDIO', 'Audio quality'],
  ['POOR_VIDEO', 'Video quality'],
  ['RIGHTS_CONCERN', 'Rights concern'],
  ['OFF_NICHE', 'Wrong for this niche'],
  ['DUPLICATE', 'Already posted something like it'],
  ['CAPTION_WRONG', 'Title or caption is wrong'],
  ['OTHER', 'Something else'],
];

// Why the machine stopped a video, as WF2/WF3/WF4 write it. Rendered as prose
// so /held reads as sentences rather than shouted constants.
const MACHINE_REASONS = {
  SHORTS_UPLOAD: 'already a short',
  TOO_SHORT: 'under three minutes',
  TRAILER_OR_PROMO: 'a trailer or promo',
  MUSIC_VIDEO: 'a music video',
  COMPILATION: 'a compilation',
  NEWS_CLIP: 'a news clip',
  STATIC_NARRATION_VISUALS: 'static visuals over narration',
  LOW_ENGAGEMENT: 'engagement below the gate',
  LANGUAGE_CHECK: 'not detected as English or Swahili',
  MANUAL_APPROVAL_REQUIRED: 'from a high-risk channel',
};

const escapeHtml = (value) => String(value ?? '')
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;');

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

const timecode = (seconds) => {
  // A missing duration is not a zero duration: Number(null) is 0, and
  // rendering "0:00" for a clip whose length was never recorded invents a
  // fact. Only a real number becomes a timecode.
  if (seconds === null || seconds === undefined || seconds === '') return '';
  const total = Number(seconds);
  if (!Number.isFinite(total) || total < 0) return '';
  const minutes = Math.floor(total / 60);
  return `${minutes}:${String(Math.floor(total % 60)).padStart(2, '0')}`;
};

// Ages are the whole point of the pipeline screen, so they are rendered as a
// span the operator can judge at a glance rather than a timestamp they have to
// subtract. `now` is a parameter so this stays pure and testable.
const ago = (value, now = Date.now()) => {
  if (!value) return '';
  const then = new Date(value).getTime();
  if (!Number.isFinite(then)) return '';
  const minutes = Math.round((now - then) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
};

const hoursSince = (value, now = Date.now()) => {
  if (!value) return null;
  const then = new Date(value).getTime();
  if (!Number.isFinite(then)) return null;
  return (now - then) / 3600000;
};

// escapeHtml stops a URL breaking out of its attribute; it does not stop
// `javascript:` inside one, which runs on click in an href and on load in an
// iframe src. Every URL rendered here arrives from outside: Drive URLs from
// WF8, post URLs straight out of a provider's API response. So a URL is only
// ever a URL if it is http(s); anything else renders as no link at all.
const safeHref = (value) => {
  const href = String(value ?? '').trim();
  return /^https?:\/\//i.test(href) ? href : '';
};

// A YouTube URL plus the second the moment starts. The operator lands on the
// original episode at the exact cut, which is the fastest way to judge whether
// a clip was taken out of context.
const sourceLink = (url, startSec) => {
  // https only here: these are public video URLs and there is no reason for
  // one to be plain http.
  const href = /^https:\/\//i.test(String(url ?? '').trim()) ? safeHref(url) : '';
  if (!href) return '';
  const start = Number(startSec);
  const at = Number.isFinite(start) && start > 0
    ? `${href}${href.includes('?') ? '&' : '?'}t=${Math.floor(start)}s`
    : href;
  return `<a class="src" href="${escapeHtml(at)}" rel="noreferrer noopener" target="_blank">source${
    Number.isFinite(start) && start > 0 ? ` at ${timecode(start)}` : ''}</a>`;
};

const RISK_TIERS = { HIGH: 'high', MODERATE: 'mid', MEDIUM: 'mid', LOW: 'low', NONE: 'low' };

const riskFlag = (label, level) => {
  const key = String(level || '').toUpperCase();
  if (!key || key === 'NONE' || key === 'N/A') return '';
  return `<span class="flag flag-${RISK_TIERS[key] || 'mid'}">${escapeHtml(label)} ${escapeHtml(key.toLowerCase())}</span>`;
};

const fold = (summary, body) => body
  ? `<details><summary>${escapeHtml(summary)}</summary><div class="fold">${body}</div></details>`
  : '';

// The enums are stored shouting because the database shouts. A person reading
// the screen does not need to be shouted at, and lowercasing keeps the value
// recognisable when they go looking for it in a query.
const humanEnum = (value) => String(value || '').toLowerCase().replace(/_/g, ' ');

const prose = (value) => (value ? `<p>${escapeHtml(value)}</p>` : '');

const field = (label, value) => (value
  ? `<div class="pair"><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`
  : '');

const list = (values) => {
  const items = (values || []).filter(Boolean);
  return items.length
    ? `<ul class="plain">${items.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`
    : '';
};

const empty = (heading, invitation) =>
  `<div class="empty"><p>${escapeHtml(heading)}</p><p class="mute">${escapeHtml(invitation)}</p></div>`;

// Every list is capped, and until now the cap was silent: the 51st clip simply
// did not exist. Say what is shown out of what there is, and offer the next page.
const pager = ({ path, offset = 0, limit = 25, total = 0 }) => {
  if (total <= limit) return '';
  const from = offset + 1;
  const to = Math.min(offset + limit, total);
  const link = (target, label) =>
    `<a href="${escapeHtml(`${path}?offset=${Math.max(0, target)}`)}">${escapeHtml(label)}</a>`;
  return `<nav class="pager"><span class="mute">${from}–${to} of ${total}</span>${
    offset > 0 ? link(offset - limit, 'newer') : ''}${
    to < total ? link(offset + limit, 'older') : ''}</nav>`;
};

// ---------------------------------------------------------------------------
// Shell
// ---------------------------------------------------------------------------

// Dark on purpose, not as a theme: a clip is judged against its surround, and
// a bright page next to a 9:16 video skews how the footage reads. Blue-slate
// rather than near-black so the preview still reads as the brightest thing.
const STYLE = `
:root {
  color-scheme: dark;
  --ground: #1B2430;
  --raised: #2C3A4A;
  --rule: #39485A;
  --bone: #E8E6DF;
  --mute: #8A97A6;
  --go: #46C08A;
  --hold: #E4A33B;
  --step: 1rem;
  --sans: ui-sans-serif, system-ui, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--ground);
  color: var(--bone);
  font: 16px/1.55 var(--sans);
  -webkit-text-size-adjust: 100%;
}
a { color: var(--bone); text-decoration-color: var(--mute); text-underline-offset: 2px; }
a:hover { text-decoration-color: var(--bone); }
:focus-visible { outline: 2px solid var(--go); outline-offset: 2px; }
h1 { font-size: 1.5rem; font-weight: 600; letter-spacing: -0.01em; margin: 0 0 var(--step); }
h2 { font-size: 1.125rem; font-weight: 600; letter-spacing: -0.005em; margin: 0 0 .35rem; }
h3 { font-size: .95rem; font-weight: 600; margin: 1.5rem 0 .5rem; }
p { margin: 0 0 .6rem; max-width: 62ch; }
.mute { color: var(--mute); }

/* The nav carries the live counts, so the screens need no stats strip. */
.bar {
  display: flex; flex-wrap: wrap; gap: .25rem 1.25rem; align-items: baseline;
  padding: .75rem var(--step); border-bottom: 1px solid var(--rule);
  position: sticky; top: 0; background: var(--ground); z-index: 2;
}
.bar a { text-decoration: none; color: var(--mute); display: flex; gap: .4rem; align-items: baseline; }
.bar a:hover, .bar a[aria-current] { color: var(--bone); }
.bar a[aria-current] { box-shadow: inset 0 -2px 0 var(--go); }
.bar .n { font: 600 .8rem/1 var(--mono); color: var(--bone); }
.bar a[aria-current] .n { color: var(--go); }
.bar .n[data-zero] { color: var(--mute); font-weight: 400; }
.bar .alarm .n { color: var(--hold); }

main { padding: calc(var(--step) * 1.5) var(--step) 4rem; max-width: 72rem; margin: 0 auto; }

/* Preview left and locked, decision right. On a phone the preview comes first
   and the verdict sticks to the bottom edge. */
.item { display: grid; gap: calc(var(--step) * 1.5); padding: calc(var(--step) * 1.5) 0; border-top: 1px solid var(--rule); }
.item:first-of-type { border-top: 0; padding-top: 0; }
@media (min-width: 56rem) {
  .item { grid-template-columns: 22rem 1fr; align-items: start; }
  .item .shot { position: sticky; top: 4.5rem; }
}
.shot iframe, .shot video { width: 100%; aspect-ratio: 9/16; border: 1px solid var(--rule); border-radius: 2px; background: #0D1319; display: block; }
.shot .meta { margin: .5rem 0 0; font: .8rem/1.5 var(--mono); color: var(--mute); }
.shot .meta a { color: var(--mute); }

.head { display: flex; flex-wrap: wrap; gap: .5rem 1rem; align-items: baseline; margin-bottom: .75rem; }
.head .stat { font: .8rem/1 var(--mono); color: var(--mute); }
.flag { font: .75rem/1 var(--mono); padding: .3rem .45rem; border-radius: 2px; white-space: nowrap; }
.flag-high { background: var(--hold); color: #221803; }
.flag-mid { color: var(--hold); box-shadow: inset 0 0 0 1px var(--hold); }
.flag-low { color: var(--mute); box-shadow: inset 0 0 0 1px var(--rule); }

.pair { display: flex; gap: .75rem; padding: .3rem 0; border-top: 1px solid var(--rule); }
.pair dt { flex: 0 0 9rem; color: var(--mute); font-size: .875rem; margin: 0; }
.pair dd { margin: 0; max-width: 52ch; }
dl { margin: 0 0 var(--step); }
.plain { margin: 0 0 .6rem; padding-left: 1.1rem; }
.plain li { margin-bottom: .2rem; }
code, .tc { font-family: var(--mono); font-size: .85em; }

details { margin: 0 0 .6rem; }
summary { cursor: pointer; color: var(--mute); font-size: .875rem; }
summary:hover { color: var(--bone); }
.fold { padding: .6rem 0 0; }
.fold pre { white-space: pre-wrap; font: .85rem/1.6 var(--mono); color: var(--mute); max-width: 76ch; margin: 0; }

label { display: block; margin: 0 0 .75rem; font-size: .875rem; color: var(--mute); }
label .req { color: var(--bone); }
input[type=text], input[type=url], input[type=number], input[type=datetime-local], textarea, select {
  display: block; width: 100%; max-width: 34rem; margin-top: .3rem;
  background: var(--raised); color: var(--bone); border: 1px solid var(--rule);
  border-radius: 2px; padding: .5rem .6rem; font: 1rem/1.4 var(--sans);
}
textarea { resize: vertical; }
fieldset { border: 1px solid var(--rule); border-radius: 2px; margin: 0 0 .75rem; padding: .6rem .75rem; }
legend { color: var(--mute); font-size: .875rem; padding: 0 .3rem; }
.ticks { display: flex; flex-wrap: wrap; gap: .5rem 1.25rem; }
.ticks label { display: flex; align-items: center; gap: .4rem; margin: 0; color: var(--bone); font: .85rem/1 var(--mono); }
.ticks input { margin: 0; }
.radios label { display: flex; gap: .5rem; align-items: baseline; color: var(--bone); margin-bottom: .4rem; }

/* The verdict is the one loud thing on the page, and the asymmetry is the
   point: approving is a filled button, rejecting is a disclosure that asks for
   a reason first. Rejecting should not be as cheap as approving. */
.verdict { display: flex; flex-wrap: wrap; gap: var(--step); align-items: center; margin-top: var(--step); padding-top: var(--step); border-top: 1px solid var(--rule); }
button { font: 600 .95rem/1 var(--sans); padding: .7rem 1.1rem; border-radius: 2px; border: 1px solid var(--rule); background: var(--raised); color: var(--bone); cursor: pointer; }
button:hover { border-color: var(--mute); }
button.go { background: var(--go); border-color: var(--go); color: #06281B; padding: .7rem 1.6rem; }
button.go:hover { background: #57CE99; border-color: #57CE99; }
button.quiet { background: none; }
.verdict details { margin: 0; }
.verdict summary { font-size: .95rem; }
.verdict .fold { max-width: 34rem; }

/* A button inside a row is a row-sized action, not a page-sized one. */
td button, td input[type=number] { font-size: .8rem; padding: .35rem .6rem; }
td input[type=number] { width: 4rem; display: inline-block; margin: 0 .3rem 0 0; vertical-align: middle; }
td form.inline, th form.inline { display: inline-flex; gap: .3rem; align-items: center; margin: 0; }

/* One count against another is a shape before it is a number. Painted as a
   background rather than a positioned element, so nothing can stack over the
   label it belongs to. */
.bars td:first-child {
  padding-left: .5rem;
  background-image: linear-gradient(to right, var(--raised) var(--fill, 0%), transparent var(--fill, 0%));
  background-repeat: no-repeat;
  background-size: 100% calc(100% - .4rem);
  background-position: 0 .2rem;
}

.shot-missing { aspect-ratio: 9/16; border: 1px dashed var(--rule); border-radius: 2px; display: flex; flex-direction: column; justify-content: center; padding: var(--step); }
.shot-missing p { margin: 0 0 .3rem; }

table { width: 100%; border-collapse: collapse; margin: 0 0 var(--step); font-size: .9rem; }
th, td { text-align: left; padding: .5rem .6rem .5rem 0; border-bottom: 1px solid var(--rule); vertical-align: baseline; }
th { color: var(--mute); font-weight: 500; font-size: .8rem; }
td.num, th.num { font-family: var(--mono); text-align: right; padding-right: 1.25rem; font-variant-numeric: tabular-nums; }
tr.warn td { color: var(--hold); }
caption { text-align: left; color: var(--mute); font-size: .875rem; padding-bottom: .5rem; }

.empty { padding: 3rem 0; border-top: 1px solid var(--rule); }
.empty p { font-size: 1.05rem; }
.alarms { margin: 0 0 calc(var(--step) * 2); padding: 0; list-style: none; }
.alarms li { padding: .6rem 0 .6rem .75rem; border-left: 2px solid var(--hold); margin-bottom: .5rem; }
.alarms .what { display: block; }
.alarms .why { color: var(--mute); font-size: .875rem; }
.pager { display: flex; gap: 1rem; align-items: baseline; padding-top: var(--step); border-top: 1px solid var(--rule); font-size: .875rem; }
.err { color: var(--hold); font-size: .875rem; display: block; margin-top: .3rem; }
.note { color: var(--mute); font-size: .8rem; margin: -.3rem 0 var(--step); }
/* On a phone a 9rem label column leaves no room for the value, and a 9:16
   placeholder for a clip that does not exist is most of a screen of nothing. */
@media (max-width: 40rem) {
  .pair { display: block; padding: .5rem 0; }
  .pair dt { margin-bottom: .15rem; }
  .pair dd { max-width: none; }
}
@media (max-width: 56rem) { .shot-missing { aspect-ratio: auto; padding: 1.5rem var(--step); } }
@media (prefers-reduced-motion: reduce) { * { transition: none !important; animation: none !important; } }
`;

const NAV = [
  ['/', 'Clips', 'clips'],
  ['/moments', 'Moments', 'moments'],
  ['/held', 'Held', 'held'],
  ['/pipeline', 'Pipeline', 'alarms'],
  ['/stuck', 'Stuck', 'stuck'],
  ['/channels', 'Channels', 'channels'],
  ['/published', 'Published', 'published'],
];

const navBar = (counts = {}, current = '') => `<nav class="bar">${NAV.map(([href, label, key]) => {
  const count = counts[key];
  const shown = count === undefined || count === null ? '' : String(count);
  return `<a href="${href}"${href === current ? ' aria-current="page"' : ''}${
    key === 'alarms' && count ? ' class="alarm"' : ''}><span>${escapeHtml(label)}</span>${
    shown ? `<span class="n"${shown === '0' ? ' data-zero' : ''}>${escapeHtml(shown)}</span>` : ''}</a>`;
}).join('')}</nav>`;

const page = ({ title, body, counts, current }) => `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head><body>
${navBar(counts, current)}
<main>${body}</main>
</body></html>`;

// ---------------------------------------------------------------------------
// Clip review
// ---------------------------------------------------------------------------

// D11: the operator's own browser fetches this URL with their Google session.
// The server never proxies Drive and holds no Google credential.
const preview = (clip) => safeHref(clip.google_drive_url)
  ? `<iframe src="${escapeHtml(safeHref(clip.google_drive_url))}" title="Clip preview" loading="lazy" allow="autoplay"></iframe>`
  : '<div class="shot-missing"><p>No render yet.</p>'
    + '<p class="mute">WF8 has not written a Drive URL for this clip.</p></div>';

// Everything the pipeline already decided about this clip, in the order an
// operator needs it: what could stop it, what it is trying to say, then the
// detail they only want sometimes.
const clipEvidence = (clip) => {
  const flags = [riskFlag('rights', clip.rights_risk)].filter(Boolean).join(' ');
  return `${flags ? `<p>${flags}</p>` : ''}
${clip.risk_warning ? `<p class="err">${escapeHtml(clip.risk_warning)}</p>` : ''}
<dl>
  ${field('Hook', clip.hook)}
  ${field('Thesis', clip.content_thesis)}
  ${field('Angle', clip.commentary_angle)}
  ${field('Localisation', clip.kenyan_african_localization)}
  ${field('Verse', clip.bible_verse_if_relevant)}
  ${field('Call to action', clip.cta)}
</dl>
${fold('On-screen text and b-roll', `${list(clip.on_screen_text_beats)}${list(clip.broll_plan)}`)}
${fold('Originality checklist', list(clip.originality_checklist))}
${fold('Narration script', clip.narration_script ? `<pre>${escapeHtml(clip.narration_script)}</pre>` : '')}
${fold('Transcript excerpt', clip.transcript_excerpt ? `<pre>${escapeHtml(clip.transcript_excerpt)}</pre>` : '')}`;
};

const clipHead = (clip) => {
  const score = Number(clip.clip_score);
  return `<div class="head">
  <h2>${escapeHtml(clip.clip_title || clip.suggested_title || clip.created_clip_id)}</h2>
  <span class="stat">${[
    timecode(clip.duration_seconds),
    escapeHtml(humanEnum(clip.niche)),
    Number.isFinite(score) ? `score ${score}` : '',
  ].filter(Boolean).join('  ')}</span>
</div>`;
};

// The AI already wrote alternative titles. Offering them as radios means the
// operator picks instead of retyping, and it works without any script: the
// parser prefers the chosen radio and falls back to the free-text box.
const titleChoice = (clip, values = {}) => {
  const alternatives = (clip.alternative_titles || []).filter(Boolean);
  const chosen = values.title_choice;
  const suggested = clip.suggested_title || '';
  if (alternatives.length === 0) {
    return `<label>Title
    <input type="text" name="final_title" required value="${escapeHtml(values.final_title ?? suggested)}">
  </label>`;
  }
  const option = (value, label) => `<label><input type="radio" name="title_choice" value="${escapeHtml(value)}"${
    chosen === value || (chosen === undefined && value === suggested) ? ' checked' : ''}> ${escapeHtml(label)}</label>`;
  return `<fieldset><legend>Title</legend>
  <div class="radios">
    ${suggested ? option(suggested, suggested) : ''}
    ${alternatives.map((alt) => option(alt, alt)).join('')}
    ${option('__custom', 'Write my own')}
  </div>
  <label>Your own title
    <input type="text" name="final_title" value="${escapeHtml(values.final_title ?? '')}">
  </label>
</fieldset>`;
};

const approveForm = (clip, values = {}, errors = {}) => {
  const ticked = new Set(values.platforms || []);
  return `<form method="post" action="/clips/approve">
  <input type="hidden" name="created_clip_id" value="${escapeHtml(clip.created_clip_id)}">
  ${titleChoice(clip, values)}
  ${errors.final_title ? `<span class="err">${escapeHtml(errors.final_title)}</span>` : ''}
  <label>Caption
    <textarea name="final_caption" rows="3">${escapeHtml(values.final_caption ?? clip.suggested_caption ?? '')}</textarea>
  </label>
  <label>Hashtags
    <input type="text" name="hashtags" value="${escapeHtml(values.hashtags ?? (clip.hashtags || []).join(' '))}">
  </label>
  <fieldset><legend>Post to</legend>
    <div class="ticks">${PLATFORMS.map((platform) => `<label><input type="checkbox" name="platforms" value="${platform}"${
      ticked.has(platform) ? ' checked' : ''}> ${platform.replace(/_/g, ' ').toLowerCase()}</label>`).join('')}</div>
    ${errors.platforms
      ? `<span class="err">${escapeHtml(errors.platforms)}</span>`
      : '<p class="note">Nothing is ticked by default, because blank must not mean everywhere.</p>'}
  </fieldset>
  <label>Publish at
    <input type="datetime-local" name="scheduled_at" value="${escapeHtml(values.scheduled_at ?? '')}">
  </label>
  <p class="note">Leave empty to publish as soon as the queue reaches it. A time is read in this server's timezone.</p>
  <label>Notes for the record
    <textarea name="reviewer_notes" rows="2">${escapeHtml(values.reviewer_notes ?? '')}</textarea>
  </label>
  <div class="verdict">
    <button class="go" type="submit">Approve clip</button>
    ${rejectFold(clip.created_clip_id)}
  </div>
</form>`;
};

// Rejecting used to be one unlabelled click with no reason and no way back.
// Now it costs a disclosure and a reason, and /held can undo it.
const rejectFold = (clipId) => `<details>
  <summary>Reject…</summary>
  <div class="fold">
    <label>Why
      <select name="reject_reason" form="reject-${escapeHtml(clipId)}" required>
        <option value="">Pick a reason</option>
        ${REJECT_REASONS.map(([code, label]) =>
          `<option value="${code}">${escapeHtml(label)}</option>`).join('')}
      </select>
    </label>
    <label>Notes
      <textarea name="reject_note" form="reject-${escapeHtml(clipId)}" rows="2"></textarea>
    </label>
    <label>Reference link
      <input type="url" name="reject_link" form="reject-${escapeHtml(clipId)}" placeholder="https://">
    </label>
    <button type="submit" form="reject-${escapeHtml(clipId)}">Reject clip</button>
  </div>
</details>`;

// The reject form sits outside the approve form because forms cannot nest; the
// controls above reach it by its id.
const rejectForm = (clipId) => `<form method="post" action="/clips/reject" id="reject-${escapeHtml(clipId)}">
  <input type="hidden" name="created_clip_id" value="${escapeHtml(clipId)}">
</form>`;

const clipItem = (clip, { values, errors } = {}) => `<section class="item" id="${escapeHtml(clip.created_clip_id)}">
  <div class="shot">
    ${preview(clip)}
    <p class="meta">${[
      sourceLink(clip.source_video_url, clip.start_sec),
      clip.start_sec != null ? `cut ${timecode(clip.start_sec)}–${timecode(clip.end_sec)}` : '',
      `<a href="/clips/${escapeHtml(clip.created_clip_id)}">permalink</a>`,
    ].filter(Boolean).join('<br>')}</p>
  </div>
  <div>
    ${clipHead(clip)}
    ${clipEvidence(clip)}
    ${approveForm(clip, values, errors)}
  </div>
</section>
${rejectForm(clip.created_clip_id)}`;

const clipQueue = (clips, context = {}) => {
  const heading = '<h1>Clip review</h1>';
  if (clips.length === 0) {
    return `${heading}${empty('Nothing awaiting review.',
      'When WF8 finishes a render it lands here. Check Pipeline if the queue has been empty longer than you expect.')}`;
  }
  return `${heading}${clips.map((clip) => clipItem(clip, context[clip.created_clip_id])).join('')}${pager({ path: '/', ...context.page })}`;
};

// ---------------------------------------------------------------------------
// High-risk moments
// ---------------------------------------------------------------------------

// This screen exists because the source is high-risk, so the risk is what it
// leads with — until now it showed a niche and an idea and nothing else.
const momentQueue = (moments, context = {}) => {
  const heading = '<h1>High-risk moments</h1>';
  if (moments.length === 0) {
    return `${heading}${empty('Nothing awaiting approval.',
      'Moments from channels marked high-risk wait here before WF6 downloads them.')}`;
  }
  return `${heading}<p class="mute">Releasing a moment sets it back to pending, and WF6 downloads it on its next run.</p>
${moments.map((moment) => `<section class="item" id="${escapeHtml(moment.clip_moment_id)}">
  <div class="shot">
    <p class="meta">${[
      sourceLink(moment.source_video_url, moment.start_sec),
      `cut ${timecode(moment.start_sec)}–${timecode(moment.end_sec)} (${timecode(moment.clip_length_seconds)})`,
      `<a href="/moments/${escapeHtml(moment.clip_moment_id)}">permalink</a>`,
    ].filter(Boolean).join('<br>')}</p>
  </div>
  <div>
    <div class="head">
      <h2>${escapeHtml(moment.suggested_title || moment.clip_moment_id)}</h2>
      <span class="stat">${[escapeHtml(humanEnum(moment.niche)),
        Number.isFinite(Number(moment.clip_score)) ? `score ${Number(moment.clip_score)}` : '',
      ].filter(Boolean).join('  ')}</span>
    </div>
    <p>${[riskFlag('rights', moment.rights_risk), riskFlag('originality', moment.originality_score >= 7 ? 'LOW' : 'MODERATE')].filter(Boolean).join(' ')}</p>
    <dl>
      ${field('Recommendation', moment.final_recommendation)}
      ${field('Core idea', moment.core_idea)}
      ${field('Why valuable', moment.why_valuable)}
      ${field('Audience', moment.target_audience)}
      ${field('Strategy', moment.strategy)}
    </dl>
    ${fold('Commentary angle and localisation',
      `${prose(moment.commentary_angle)}${prose(moment.kenyan_african_application)}`)}
    <form method="post" action="/moments/approve" class="verdict">
      <input type="hidden" name="clip_moment_id" value="${escapeHtml(moment.clip_moment_id)}">
      <button class="go" type="submit">Release for download</button>
    </form>
  </div>
</section>`).join('')}${pager({ path: '/moments', ...context.page })}`;
};

// ---------------------------------------------------------------------------
// Held: what did not pass, and the way through
// ---------------------------------------------------------------------------

// Three different things are "held", and they are held by different actors, so
// they get three tables rather than one merged list:
//   - a candidate the machine rejected on a deterministic rule
//   - a candidate the machine flagged and then left nowhere (FLAGGED is not
//     'VALID', and WF4 wants exactly 'VALID', so nothing ever picks it up)
//   - a clip a person rejected
// Grouping the first by reason is the useful part: one video is an override,
// a whole class failing the same gate is a threshold to change.
const heldBoard = ({ flagged = [], rejected = [], clips = [], reasonCounts = [] } = {}) => {
  const releaseButton = (videoId, label) => `<form method="post" action="/held/release" class="inline">
    <input type="hidden" name="video_id" value="${escapeHtml(videoId)}">
    <button type="submit">${escapeHtml(label)}</button>
  </form>`;

  const videoRow = (video, label) => `<tr>
    <td>${escapeHtml(video.video_title || video.video_id)}<br>
      <span class="mute">${escapeHtml(video.source_name || '')} ${sourceLink(video.video_url, 0)}</span></td>
    <td>${escapeHtml(MACHINE_REASONS[video.rejection_reason] || video.rejection_reason || '')}</td>
    <td class="num">${escapeHtml(ago(video.created_at))}</td>
    <td>${releaseButton(video.video_id, label)}</td>
  </tr>`;

  const nothing = flagged.length === 0 && rejected.length === 0 && clips.length === 0;
  if (nothing) {
    return `<h1>Held</h1>${empty('Nothing is held.',
      'Videos the gates stopped, and clips you rejected, appear here with a way to push them through.')}`;
  }

  return `<h1>Held</h1>
<p>Everything the pipeline or you stopped. Releasing a video skips the gate that
stopped it and sends it straight to WF4 for a transcript.</p>

${reasonCounts.length ? (() => {
    const most = Math.max(...reasonCounts.map(({ count }) => count), 1);
    return `<h3>Why videos are being stopped</h3>
<table class="bars"><caption>Last 30 days. A whole class failing one gate is a threshold worth changing, not a video worth overriding.</caption>
<thead><tr><th>Reason</th><th class="num">Videos</th></tr></thead>
<tbody>${reasonCounts.map(({ reason, count }) => `<tr>
  <td style="--fill:${Math.round((count / most) * 100)}%">${
      escapeHtml(MACHINE_REASONS[reason] || reason || 'unrecorded')}</td>
  <td class="num">${escapeHtml(count)}</td>
</tr>`).join('')}</tbody></table>`;
  })() : ''}

${flagged.length ? `<h3>Flagged, waiting on you</h3>
<table><caption>WF4 takes only VALID, so these advance no further until released. Nothing else will pick them up.</caption>
<thead><tr><th>Video</th><th>Why</th><th class="num">Age</th><th></th></tr></thead>
<tbody>${flagged.map((video) => videoRow(video, 'Release')).join('')}</tbody></table>` : ''}

${rejected.length ? `<h3>Rejected by a gate</h3>
<table><caption>Releasing one overrides the rule that stopped it.</caption>
<thead><tr><th>Video</th><th>Why</th><th class="num">Age</th><th></th></tr></thead>
<tbody>${rejected.map((video) => videoRow(video, 'Override')).join('')}</tbody></table>` : ''}

${clips.length ? `<h3>Clips you rejected</h3>
<table><caption>Reopening puts a clip back in the review queue. Nothing was deleted.</caption>
<thead><tr><th>Clip</th><th>Your reason</th><th class="num">Age</th><th></th></tr></thead>
<tbody>${clips.map((clip) => `<tr>
  <td><a href="/clips/${escapeHtml(clip.created_clip_id)}">${escapeHtml(clip.clip_title || clip.suggested_title || clip.created_clip_id)}</a><br>
    <span class="mute">${escapeHtml(humanEnum(clip.niche))}</span></td>
  <td>${escapeHtml(clip.reviewer_notes || '')}</td>
  <td class="num">${escapeHtml(ago(clip.created_at))}</td>
  <td><form method="post" action="/clips/reopen" class="inline">
    <input type="hidden" name="created_clip_id" value="${escapeHtml(clip.created_clip_id)}">
    <button type="submit">Reopen</button>
  </form></td>
</tr>`).join('')}</tbody></table>` : ''}`;
};

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

// The alarm rules live in JS rather than SQL because they are judgement, and
// judgement is the part worth testing. The view does the arithmetic.
// Six hours, not two: these workflows run on a schedule, and a stage that has
// been quiet for one cycle is normal. The threshold is what keeps the alarm
// worth reading.
const STARVED_AFTER_HOURS = 6;
const STALE_AFTER_HOURS = 6;
const TOKEN_WARN_DAYS = 14;
const LEASE_STALE_HOURS = 1;

// A stage is starved when work has aged there and the stage after it has
// received nothing in that time. That is as close as this service can get to
// "the workflow between them is down" without n8n's execution log, which lives
// on another host behind a second credential.
//
// Only the first stage of a consecutive run is reported. When WF6 stops, every
// stage behind it also goes quiet, and five alarms naming five workflows hide
// the one that broke.
const starvedStages = (stages = [], now = Date.now()) => {
  const ordered = [...stages].sort((a, b) => a.position - b.position);
  const starved = ordered.map((stage, index) => {
    const next = ordered[index + 1];
    // alarm_on_stall is false where a backlog means something other than a
    // stopped workflow: the source fleet, and the queue a person works.
    if (!next || !stage.waiting || stage.alarm_on_stall === false) return null;
    const waitingFor = hoursSince(stage.oldest_waiting, now);
    const downstreamQuiet = hoursSince(next.last_activity, now);
    if (waitingFor === null || waitingFor < STARVED_AFTER_HOURS) return null;
    if (downstreamQuiet !== null && downstreamQuiet < STALE_AFTER_HOURS) return null;
    return {
      kind: 'starved',
      what: `${stage.consumer} may have stopped`,
      why: `${stage.waiting} waiting at ${stage.stage.toLowerCase()}, oldest ${ago(stage.oldest_waiting, now)}, and ${
        next.stage.toLowerCase()} has received nothing ${
        next.last_activity ? `in ${ago(next.last_activity, now)}` : 'ever'}. Inferred from timestamps, not from an execution log.`,
    };
  });
  // Drop any starved stage whose predecessor is also starved: it is the
  // consequence, not the cause.
  return starved.filter((alarm, index) => alarm && !starved[index - 1]);
};

const buildAlarms = ({ stages = [], channels = [], publishingChannels = [], leases = [] } = {}, now = Date.now()) => {
  const alarms = [];

  // A niche with no active channel produces nothing, for ever, silently.
  const byNiche = new Map();
  for (const channel of channels) {
    const niche = channel.niche || 'UNKNOWN';
    if (!byNiche.has(niche)) byNiche.set(niche, []);
    byNiche.get(niche).push(channel);
  }
  for (const [niche, group] of [...byNiche].sort(([a], [b]) => a.localeCompare(b))) {
    if (group.some((channel) => channel.active_status)) continue;
    const paused = group.filter((channel) => channel.auto_paused_at).length;
    alarms.push({
      kind: 'niche-dark',
      what: `${humanEnum(niche)} has no active channel`,
      why: paused === group.length
        ? `All ${group.length} were auto-paused for low-quality videos. Nothing will be fetched for this niche until one is reactivated.`
        : `${group.length - paused} switched off by hand, ${paused} auto-paused.`,
    });
  }

  for (const channel of channels) {
    const pausedFor = hoursSince(channel.auto_paused_at, now);
    if (pausedFor === null || pausedFor > 24) continue;
    alarms.push({
      kind: 'auto-paused',
      what: `${channel.source_name || channel.source_id} was auto-paused ${ago(channel.auto_paused_at, now)} ago`,
      why: channel.auto_paused_reason || 'No reason recorded.',
    });
  }

  // A publish fails hard the moment a token expires, and this is the most
  // preventable outage in the stack.
  for (const channel of publishingChannels) {
    const expires = channel.token_expires_at;
    if (!expires) continue;
    const days = -(hoursSince(expires, now) ?? 0) / 24;
    if (days > TOKEN_WARN_DAYS) continue;
    alarms.push({
      kind: 'token',
      what: days < 0
        ? `${humanEnum(channel.platform)} credential expired ${ago(expires, now)} ago`
        : `${humanEnum(channel.platform)} credential expires in ${Math.max(0, Math.round(days))} days`,
      why: `Channel ${channel.channel_id}. Publishing to this platform fails once it lapses.`,
    });
  }

  // Claimed and never finished: the worker that held the lease went away.
  for (const job of leases) {
    const held = hoursSince(job.claimed_at, now);
    if (held === null || held < LEASE_STALE_HOURS) continue;
    alarms.push({
      kind: 'lease',
      what: `${humanEnum(job.platform)} job ${job.publish_id} claimed ${ago(job.claimed_at, now)} ago and never finished`,
      why: `Status ${humanEnum(job.publish_status)}, held by ${job.claimed_by || 'an unnamed worker'}. WF12 will not pick it up again while the lease stands.`,
    });
  }

  return alarms.concat(starvedStages(stages, now));
};

const alarmList = (alarms) => (alarms.length === 0 ? '' : `<ul class="alarms">${alarms.map((alarm) =>
  `<li><span class="what">${escapeHtml(alarm.what)}</span><span class="why">${escapeHtml(alarm.why)}</span></li>`).join('')}</ul>`);

const pipelineBoard = ({ stages = [], alarms = [], errors = [], throughput = [] } = {}, now = Date.now()) => `<h1>Pipeline</h1>
${alarms.length
    ? alarmList(alarms)
    : `<p class="mute">Nothing is asking for attention.</p>`}

<h3>Where work is sitting</h3>
<table><caption>Waiting counts come from each workflow's own input filter. Last activity is the newest row that stage produced — this service cannot read n8n's execution log, so a stale stage is inferred, not measured.</caption>
<thead><tr><th>Stage</th><th>Waited on by</th><th class="num">Waiting</th><th class="num">Oldest</th><th class="num">Last activity</th></tr></thead>
<tbody>${stages.map((stage) => {
  const waitingFor = hoursSince(stage.oldest_waiting, now);
  return `<tr${waitingFor !== null && waitingFor > 24 ? ' class="warn"' : ''}>
  <td>${escapeHtml(stage.stage)}</td>
  <td class="mute">${escapeHtml(stage.consumer)}</td>
  <td class="num">${escapeHtml(stage.waiting ?? 0)}</td>
  <td class="num">${escapeHtml(ago(stage.oldest_waiting, now) || '—')}</td>
  <td class="num">${escapeHtml(ago(stage.last_activity, now) || '—')}</td>
</tr>`;
}).join('')}</tbody></table>

${throughput.length ? `<h3>Clips reviewed</h3>
<table><caption>The approve-to-reject ratio is the early warning that WF5's output is drifting.</caption>
<thead><tr><th>Day</th><th class="num">Created</th><th class="num">Approved</th><th class="num">Rejected</th></tr></thead>
<tbody>${throughput.map((day) => `<tr>
  <td class="tc">${escapeHtml(day.day)}</td>
  <td class="num">${escapeHtml(day.created ?? 0)}</td>
  <td class="num">${escapeHtml(day.approved ?? 0)}</td>
  <td class="num">${escapeHtml(day.rejected ?? 0)}</td>
</tr>`).join('')}</tbody></table>` : ''}

${errors.length ? `<h3>Errors by workflow</h3>
<table><caption>From error_log, last seven days. Payloads are not rendered.</caption>
<thead><tr><th>Workflow</th><th>Node</th><th class="num">Count</th><th class="num">Latest</th><th>Newest message</th></tr></thead>
<tbody>${errors.map((row) => `<tr>
  <td>${escapeHtml(row.workflow_name || 'unnamed')}</td>
  <td class="mute">${escapeHtml(row.node_name || '')}</td>
  <td class="num">${escapeHtml(row.count)}</td>
  <td class="num">${escapeHtml(ago(row.latest, now))}</td>
  <td>${escapeHtml(row.error_message || '')}</td>
</tr>`).join('')}</tbody></table>` : '<h3>Errors by workflow</h3><p class="mute">No errors logged in the last seven days.</p>'}`;

// ---------------------------------------------------------------------------
// Stuck
// ---------------------------------------------------------------------------

// Individual failures, as opposed to /pipeline's aggregate view. Only the
// operator-facing message is rendered: raw_payload, provider_response and
// postiz_submit_payload carry provider references and credential slots, so
// they stay out of the HTML.
const stuckBoard = ({ moments = [], renders = [], publishes = [], clips = [] } = {}, now = Date.now()) => {
  if (!moments.length && !renders.length && !publishes.length && !clips.length) {
    return `<h1>Stuck</h1>${empty('Nothing is stuck.',
      'Failed downloads, renders and publishes show up here with their error and a way to retry.')}`;
  }
  const retry = (action, name, value, label) => `<form method="post" action="${action}" class="inline">
    <input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">
    <button type="submit">${escapeHtml(label)}</button>
  </form>`;

  return `<h1>Stuck</h1>
${moments.length ? `<h3>Downloads that failed</h3>
<table><thead><tr><th>Moment</th><th>Error</th><th class="num">Age</th><th></th></tr></thead>
<tbody>${moments.map((moment) => `<tr>
  <td><a href="/moments/${escapeHtml(moment.clip_moment_id)}">${escapeHtml(moment.suggested_title || moment.clip_moment_id)}</a><br>
    <span class="mute">${sourceLink(moment.source_video_url, moment.start_sec)}</span></td>
  <td>${escapeHtml(moment.error_message || '')}</td>
  <td class="num">${escapeHtml(ago(moment.created_at, now))}</td>
  <td>${retry('/moments/retry', 'clip_moment_id', moment.clip_moment_id, 'Retry download')}</td>
</tr>`).join('')}</tbody></table>` : ''}

${renders.length ? `<h3>Renders that failed</h3>
<table><thead><tr><th>Render</th><th>Error</th><th class="num">Age</th><th></th></tr></thead>
<tbody>${renders.map((render) => `<tr>
  <td class="tc">${escapeHtml(render.render_id)}<br><span class="mute">${escapeHtml(humanEnum(render.niche))}</span></td>
  <td>${escapeHtml(render.error_message || render.warning_message || '')}</td>
  <td class="num">${escapeHtml(ago(render.created_at, now))}</td>
  <td>${retry('/renders/retry', 'render_id', render.render_id, 'Retry render')}</td>
</tr>`).join('')}</tbody></table>` : ''}

${publishes.length ? `<h3>Publishes that failed</h3>
<table><thead><tr><th>Job</th><th>Platform</th><th>Error</th><th class="num">Tries</th><th class="num">Age</th><th></th></tr></thead>
<tbody>${publishes.map((job) => `<tr>
  <td class="tc">${escapeHtml(job.publish_id)}<br><span class="mute">${escapeHtml(humanEnum(job.publish_status))}</span></td>
  <td>${escapeHtml(humanEnum(job.platform))}</td>
  <td>${escapeHtml(job.last_error || '')}</td>
  <td class="num">${escapeHtml(job.retry_count ?? 0)}</td>
  <td class="num">${escapeHtml(ago(job.created_at, now))}</td>
  <td>${retry('/publishes/retry', 'publish_id', job.publish_id, 'Queue again')}</td>
</tr>`).join('')}</tbody></table>` : ''}

${clips.length ? `<h3>Clips waiting on a download</h3>
<table><caption>Marked AWAITING_DOWNLOAD or NEEDS_RETRY, so they never reached review.</caption>
<thead><tr><th>Clip</th><th>Status</th><th class="num">Age</th></tr></thead>
<tbody>${clips.map((clip) => `<tr>
  <td><a href="/clips/${escapeHtml(clip.created_clip_id)}">${escapeHtml(clip.clip_title || clip.created_clip_id)}</a></td>
  <td class="mute">${escapeHtml(humanEnum(clip.review_status))}</td>
  <td class="num">${escapeHtml(ago(clip.created_at, now))}</td>
</tr>`).join('')}</tbody></table>` : ''}`;
};

// ---------------------------------------------------------------------------
// Channels
// ---------------------------------------------------------------------------

const channelForm = (values = {}, errors = {}) => `<h3>Add a channel</h3>
<form method="post" action="/channels">
  <label>Short id
    <input type="text" name="source_id" required value="${escapeHtml(values.source_id || '')}">
    ${errors.source_id ? `<span class="err">${escapeHtml(errors.source_id)}</span>` : ''}
  </label>
  <label>Name
    <input type="text" name="source_name" required value="${escapeHtml(values.source_name || '')}">
    ${errors.source_name ? `<span class="err">${escapeHtml(errors.source_name)}</span>` : ''}
  </label>
  <label>YouTube channel URL
    <input type="url" name="youtube_channel_url" required value="${escapeHtml(values.youtube_channel_url || '')}">
    ${errors.youtube_channel_url ? `<span class="err">${escapeHtml(errors.youtube_channel_url)}</span>` : ''}
  </label>
  <label>Niche
    <select name="niche" required>${NICHES.map((niche) =>
      `<option value="${niche}"${values.niche === niche ? ' selected' : ''}>${escapeHtml(humanEnum(niche))}</option>`).join('')}</select>
    ${errors.niche ? `<span class="err">${escapeHtml(errors.niche)}</span>` : ''}
  </label>
  <label>Priority
    <input type="number" name="priority" min="1" value="${escapeHtml(values.priority || 1)}">
  </label>
  <p class="note">The channel id and uploads playlist are left empty on purpose — WF1 resolves both from the URL.</p>
  <button class="go" type="submit">Add channel</button>
</form>`;

// The add form was the whole screen, so auto-paused channels went out by email
// and could not be acted on anywhere. Now the fleet is the screen and the form
// sits under it.
const channelBoard = ({ channels = [], values, errors } = {}, now = Date.now()) => {
  const state = (channel) => {
    if (channel.auto_paused_at) return `<span class="flag flag-high">auto-paused</span>`;
    if (!channel.active_status) return `<span class="flag flag-low">off</span>`;
    return `<span class="flag flag-low">active</span>`;
  };
  const action = (channel) => {
    if (channel.auto_paused_at || !channel.active_status) {
      return `<form method="post" action="/channels/activate" class="inline">
        <input type="hidden" name="source_id" value="${escapeHtml(channel.source_id)}">
        <button type="submit">Reactivate</button>
      </form>`;
    }
    return `<form method="post" action="/channels/deactivate" class="inline">
      <input type="hidden" name="source_id" value="${escapeHtml(channel.source_id)}">
      <button class="quiet" type="submit">Switch off</button>
    </form>`;
  };

  return `<h1>Channels</h1>
${channels.length === 0
    ? empty('No channels yet.', 'Add one below and WF1 will resolve its playlist on the next run.')
    : `<table>
<caption>Skip rate is how much of what this channel produced the gates threw away.</caption>
<thead><tr><th>Channel</th><th>Niche</th><th>State</th><th class="num">Priority</th><th class="num">Skip rate</th><th class="num">Checked</th><th></th></tr></thead>
<tbody>${channels.map((channel) => `<tr${channel.auto_paused_at ? ' class="warn"' : ''}>
  <td>${escapeHtml(channel.source_name || channel.source_id)}<br>
    <span class="mute">${sourceLink(channel.youtube_channel_url, 0) || escapeHtml(channel.source_id)}</span>
    ${channel.auto_paused_reason ? `<br><span class="mute">${escapeHtml(channel.auto_paused_reason)}</span>` : ''}</td>
  <td class="mute">${escapeHtml(humanEnum(channel.niche))}</td>
  <td>${state(channel)}</td>
  <td class="num">
    <form method="post" action="/channels/priority" class="inline">
      <input type="hidden" name="source_id" value="${escapeHtml(channel.source_id)}">
      <input type="number" name="priority" min="1" max="99" value="${escapeHtml(channel.priority ?? 1)}" aria-label="Priority for ${escapeHtml(channel.source_name || channel.source_id)}">
      <button type="submit">Set</button>
    </form>
  </td>
  <td class="num">${channel.channel_skip_rate == null ? '—' : escapeHtml(`${Math.round(Number(channel.channel_skip_rate) * 100)}%`)}</td>
  <td class="num">${escapeHtml(ago(channel.last_checked_at, now) || '—')}</td>
  <td>${action(channel)}</td>
</tr>`).join('')}</tbody></table>`}
${channelForm(values, errors)}`;
};

// ---------------------------------------------------------------------------
// Published
// ---------------------------------------------------------------------------

const publishedBoard = ({ jobs = [], credentials = [] } = {}, now = Date.now()) => `<h1>Published</h1>
${jobs.length === 0
    ? empty('Nothing published yet.', 'Approved clips appear here once WF12 has posted them.')
    : `<table>
<thead><tr><th>Clip</th><th>Platform</th><th class="num">Posted</th><th>Link</th></tr></thead>
<tbody>${jobs.map((job) => `<tr>
  <td>${escapeHtml(job.title || job.created_clip_id)}<br>
    <span class="mute">${escapeHtml(humanEnum(job.niche))}</span></td>
  <td>${escapeHtml(humanEnum(job.platform))}</td>
  <td class="num">${escapeHtml(ago(job.completed_at, now) || '—')}</td>
  <td>${safeHref(job.post_url)
    ? `<a href="${escapeHtml(safeHref(job.post_url))}" rel="noreferrer noopener" target="_blank">open</a>`
    : `<span class="mute">${escapeHtml(humanEnum(job.publish_status))}</span>`}</td>
</tr>`).join('')}</tbody></table>`}

<h3>Publishing credentials</h3>
${credentials.length === 0
    ? '<p class="mute">No publishing channels configured.</p>'
    : `<table>
<caption>A lapsed token fails every publish to that platform, so this is the one to watch.</caption>
<thead><tr><th>Channel</th><th>Platform</th><th>Backend</th><th>Health</th><th class="num">Token expires</th></tr></thead>
<tbody>${credentials.map((channel) => {
      const hours = hoursSince(channel.token_expires_at, now);
      const days = hours === null ? null : -hours / 24;
      return `<tr${days !== null && days <= TOKEN_WARN_DAYS ? ' class="warn"' : ''}>
  <td class="tc">${escapeHtml(channel.channel_id)}</td>
  <td>${escapeHtml(humanEnum(channel.platform))}</td>
  <td class="mute">${escapeHtml(humanEnum(channel.publishing_backend))}${
        channel.enabled_status ? '' : ' (disabled)'}</td>
  <td class="mute">${escapeHtml(humanEnum(channel.last_health_status) || '—')}</td>
  <td class="num">${days === null ? '—' : escapeHtml(days < 0 ? `lapsed ${ago(channel.token_expires_at, now)} ago` : `${Math.round(days)}d`)}</td>
</tr>`;
    }).join('')}</tbody></table>`}`;

// ---------------------------------------------------------------------------
// Form parsing
// ---------------------------------------------------------------------------

// Kept alongside the forms they read, so a renamed field breaks in one place.
// Returns the values back out as well as the parsed arguments: a validation
// failure re-renders the form the operator typed into, which until now threw
// their work away and showed a bare error page.
const parseApproveForm = (formData) => {
  const errors = {};
  const choice = formData.get('title_choice');
  const typed = (formData.get('final_title') || '').trim();
  // The radio wins unless it is the "write my own" sentinel.
  const title = (choice && choice !== '__custom' ? String(choice).trim() : typed);
  const platforms = formData.getAll('platforms').filter((platform) => PLATFORMS.includes(platform));
  const caption = (formData.get('final_caption') || '').trim();
  const hashtagText = (formData.get('hashtags') || '').trim();
  const hashtags = hashtagText.split(/\s+/).filter(Boolean);
  const scheduled = (formData.get('scheduled_at') || '').trim();
  const notes = (formData.get('reviewer_notes') || '').trim();

  if (!title) errors.final_title = 'Pick a title or write one.';
  // Blank does not mean all platforms.
  if (platforms.length === 0) errors.platforms = 'Tick at least one platform.';

  let scheduledAt = null;
  if (scheduled) {
    const parsed = new Date(scheduled);
    if (Number.isNaN(parsed.getTime())) errors.scheduled_at = 'That is not a time I can read.';
    else scheduledAt = parsed.toISOString();
  }

  return {
    errors,
    // What to put back in the form if anything above failed.
    form: {
      title_choice: choice ?? undefined,
      final_title: typed,
      final_caption: caption,
      hashtags: hashtagText,
      platforms,
      scheduled_at: scheduled,
      reviewer_notes: notes,
    },
    values: {
      p_created_clip_id: formData.get('created_clip_id'),
      p_final_title: title,
      p_final_caption: caption || null,
      p_platforms: platforms,
      p_hashtags: hashtags.length ? hashtags : null,
      p_scheduled_at: scheduledAt,
      p_reviewer_notes: notes || null,
    },
  };
};

const REJECT_CODES = new Set(REJECT_REASONS.map(([code]) => code));

// reviewer_notes is one text column and the RPC already accepts it, so the
// reason, the note and the link go in as one structured line rather than
// earning a migration. It is overwritten on each decision, so this records the
// current verdict and not a history — a review_decisions table is the answer if
// an audit trail is ever wanted.
const parseRejectForm = (formData) => {
  const errors = {};
  const reason = formData.get('reject_reason') || '';
  const note = (formData.get('reject_note') || '').trim();
  const link = (formData.get('reject_link') || '').trim();

  if (!REJECT_CODES.has(reason)) errors.reject_reason = 'Pick a reason for rejecting.';
  if (link && !/^https?:\/\//.test(link)) errors.reject_link = 'A reference link must start with http:// or https://.';

  return {
    errors,
    values: {
      p_created_clip_id: formData.get('created_clip_id'),
      p_reviewer_notes: [reason, note, link && `ref: ${link}`].filter(Boolean).join(' — ') || null,
    },
  };
};

const parseChannelForm = (formData) => {
  const errors = {};
  const values = {};
  for (const _field of ['source_id', 'source_name', 'youtube_channel_url']) {
    values[_field] = (formData.get(_field) || '').trim();
    if (!values[_field]) errors[_field] = `${_field.replace(/_/g, ' ')} is required.`;
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

const parsePriorityForm = (formData) => {
  const priority = Number(formData.get('priority'));
  const errors = {};
  if (!Number.isInteger(priority) || priority < 1 || priority > 99) {
    errors.priority = 'Priority is a whole number from 1 to 99.';
  }
  return { errors, source_id: formData.get('source_id'), priority };
};

module.exports = {
  page, navBar, clipQueue, clipItem, approveForm, rejectFold, channelForm, channelBoard,
  momentQueue, heldBoard, pipelineBoard, stuckBoard, publishedBoard,
  parseApproveForm, parseRejectForm, parseChannelForm, parsePriorityForm,
  buildAlarms, starvedStages, alarmList, pager, empty,
  escapeHtml, timecode, ago, hoursSince, sourceLink, safeHref, humanEnum,
  NICHES, PLATFORMS, REJECT_REASONS, MACHINE_REASONS,
};
