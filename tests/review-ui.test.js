const assert = require('node:assert/strict');
const test = require('node:test');
const {
  page, clipQueue, approveForm, momentQueue,
  parseApproveForm, parseChannelForm, escapeHtml,
} = require('../hosts/review/render');

test('escapeHtml neutralises a clip title that contains markup', () => {
  assert.equal(escapeHtml('<img src=x onerror=alert(1)>'), '&lt;img src=x onerror=alert(1)&gt;');
  assert.equal(escapeHtml('a "quoted" & ampersand'), 'a &quot;quoted&quot; &amp; ampersand');
  assert.equal(escapeHtml(null), '');
});

// D11: the preview is the operator's own browser fetching Drive. The server
// must never proxy it, so the page carries the Drive URL and no token.
test('the clip queue embeds the Drive preview without a server-side token', () => {
  const html = clipQueue([{
    created_clip_id: 'clip-1',
    clip_title: 'A Clip',
    google_drive_url: 'https://drive.google.com/file/d/abc/preview',
    suggested_title: 'Suggested',
  }]);
  assert.match(html, /https:\/\/drive\.google\.com\/file\/d\/abc\/preview/);
  assert.doesNotMatch(html, /SUPABASE|service_role|apikey|Bearer/i);
});

test('an empty queue says so rather than rendering an empty table', () => {
  assert.match(clipQueue([]), /nothing awaiting review/i);
  assert.match(momentQueue([]), /nothing awaiting approval/i);
});

test('the approve form is prefilled from the clip and lists only supported platforms', () => {
  const html = approveForm({
    created_clip_id: 'clip-1',
    suggested_title: 'Suggested Title',
    suggested_caption: 'Suggested Caption',
    hashtags: ['#one', '#two'],
  });
  assert.match(html, /value="Suggested Title"/);
  assert.match(html, /Suggested Caption/);
  for (const platform of ['YOUTUBE_SHORTS', 'TIKTOK', 'INSTAGRAM_REELS', 'FACEBOOK_REELS']) {
    assert.match(html, new RegExp(`value="${platform}"`));
  }
  // No platform is pre-ticked: blank must not mean all platforms.
  assert.doesNotMatch(html, /checked/);
});

test('parseApproveForm rejects a submission with no platform ticked', () => {
  const { errors } = parseApproveForm(new URLSearchParams(
    'created_clip_id=clip-1&final_title=Title'));
  assert.match(errors.platforms, /at least one platform/i);
});

test('parseApproveForm rejects a blank title', () => {
  const { errors } = parseApproveForm(new URLSearchParams(
    'created_clip_id=clip-1&final_title=++++&platforms=TIKTOK'));
  assert.match(errors.final_title, /title/i);
});

test('parseApproveForm collects multiple platform checkboxes', () => {
  const { values, errors } = parseApproveForm(new URLSearchParams(
    'created_clip_id=clip-1&final_title=Title&platforms=TIKTOK&platforms=YOUTUBE_SHORTS'));
  assert.deepEqual(errors, {});
  assert.deepEqual(values.p_platforms, ['TIKTOK', 'YOUTUBE_SHORTS']);
  assert.equal(values.p_final_title, 'Title');
});

test('parseApproveForm turns a blank schedule date into null, not an empty string', () => {
  const { values } = parseApproveForm(new URLSearchParams(
    'created_clip_id=clip-1&final_title=Title&platforms=TIKTOK&scheduled_at='));
  assert.equal(values.p_scheduled_at, null);
});

test('parseChannelForm requires a niche from the allowed list', () => {
  const bad = parseChannelForm(new URLSearchParams(
    'source_id=src-1&source_name=Example&youtube_channel_url=https://youtube.com/@e&niche=SPORTS'));
  assert.match(bad.errors.niche, /niche/i);

  const good = parseChannelForm(new URLSearchParams(
    'source_id=src-1&source_name=Example&youtube_channel_url=https://youtube.com/@e&niche=FINANCE_BUSINESS'));
  assert.deepEqual(good.errors, {});
  // WF1 fills these in; the form must not invent them.
  assert.equal(good.values.youtube_channel_id, undefined);
  assert.equal(good.values.uploads_playlist_id, undefined);
});

test('parseChannelForm rejects a non-YouTube URL', () => {
  const { errors } = parseChannelForm(new URLSearchParams(
    'source_id=src-1&source_name=Example&niche=FINANCE_BUSINESS&youtube_channel_url=https://vimeo.com/x'));
  assert.match(errors.youtube_channel_url, /youtube/i);
});

test('the page shell declares a charset and a viewport', () => {
  const html = page({ title: 'Review', body: '<p>x</p>' });
  assert.match(html, /<!doctype html>/i);
  assert.match(html, /charset="utf-8"/);
  assert.match(html, /viewport/);
});

// server.js is required with stub credentials so postgrest.js's fail-fast check
// passes; nothing below opens a socket or reaches Supabase.
process.env.SUPABASE_URL ||= 'https://example.invalid';
process.env.SUPABASE_SERVICE_KEY ||= 'stub-key-for-tests';
const { sameOrigin } = require('../hosts/review/server');

// D5 makes the network the authentication, so there is no session to bind a
// CSRF token to. A page the operator has open in the same browser could still
// POST here, which would approve or reject a clip.
test('a cross-site POST is not treated as same-origin', () => {
  assert.equal(sameOrigin({ headers: { "sec-fetch-site": "cross-site" } }), false);
  assert.equal(sameOrigin({ headers: { 'sec-fetch-site': 'same-site' } }), false);
});

test('the review UI own pages and direct navigation are same-origin', () => {
  assert.equal(sameOrigin({ headers: { 'sec-fetch-site': 'same-origin' } }), true);
  assert.equal(sameOrigin({ headers: { 'sec-fetch-site': 'none' } }), true);
});

test('without Fetch Metadata the Origin header decides, and a bad one fails closed', () => {
  // Checked against the configured hostnames, not against this request's Host.
  assert.equal(sameOrigin({ headers: { origin: 'http://127.0.0.1:5680' } }), true);
  assert.equal(sameOrigin({ headers: { origin: 'http://evil.example' } }), false);
  assert.equal(sameOrigin({ headers: { origin: 'not a url' } }), false);
  // A client that sends neither header is a plain form post, not an attack.
  assert.equal(sameOrigin({ headers: {} }), true);
});

// DNS rebinding. An attacker points their own domain at this server's address;
// the operator's browser resolves it and every request then arrives with the
// attacker's domain in Host *and* in Origin, so an Origin-against-Host check
// agrees with itself and passes. Once that works the attacker's page is
// same-origin with this one, so it can read the clip queue as well as post to
// it — which is why the Host check runs for GET too, not only for writes.
const { hostAllowed, hostnameOf } = require('../hosts/review/server');

test('only the configured hostnames are answered', () => {
  for (const host of ['127.0.0.1', '127.0.0.1:5680', 'localhost', 'localhost:8080', '[::1]', '[::1]:5680']) {
    assert.equal(hostAllowed(host), true, `${host} should be allowed`);
  }
  for (const host of ['rebind.attacker.example', 'rebind.attacker.example:5680', '127.0.0.1.attacker.example', 'evil.test']) {
    assert.equal(hostAllowed(host), false, `${host} must be refused`);
  }
});

test('a missing or malformed Host is refused rather than defaulted', () => {
  for (const host of ['', undefined, null, '   ', ':5680']) {
    assert.equal(hostAllowed(host), false);
  }
});

test('the hostname is compared without its port, and IPv6 brackets survive', () => {
  assert.equal(hostnameOf('127.0.0.1:5680'), '127.0.0.1');
  assert.equal(hostnameOf('[::1]:5680'), '[::1]');
  assert.equal(hostnameOf('LOCALHOST:8080'), 'localhost');
});

// The Origin fallback must not be checked against the request's own Host: under
// rebinding both carry the attacker's domain.
test('an Origin on an unlisted host is refused even when it matches Host', () => {
  assert.equal(sameOrigin({ headers: { origin: 'http://rebind.attacker.example' } }), false);
  assert.equal(sameOrigin({ headers: { origin: 'http://127.0.0.1:5680' } }), true);
});
