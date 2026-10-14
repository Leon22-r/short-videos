const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');

// postgrest.js fails fast without credentials, so give it dummy ones. Nothing
// here reaches the network: fetch is stubbed for the client tests, and the
// server tests replace the client's functions, which server.js looks up on
// every call.
process.env.SUPABASE_URL = 'http://postgrest.invalid';
process.env.SUPABASE_SERVICE_KEY = 'test-key';
process.env.REVIEW_TIMEZONE = 'Africa/Nairobi';
const db = require('../hosts/review/postgrest');
const { server, offsetOf, writes, permalinks, SECURITY_HEADERS } = require('../hosts/review/server');

const original = { ...db };
const calls = [];
// Every db function records its call and answers from `answers`, keyed by
// function name; a function given no answer returns an empty result.
const stubDb = (answers = {}) => {
  calls.length = 0;
  for (const name of ['select', 'selectOne', 'selectPage', 'patch', 'insert', 'rpc']) {
    db[name] = async (...args) => {
      calls.push([name, ...args]);
      const answer = answers[name];
      if (typeof answer === 'function') return answer(...args);
      if (answer !== undefined) return answer;
      return name === 'selectPage' ? { rows: [], total: 0 } : name === 'selectOne' ? undefined : [];
    };
  }
};
test.afterEach(() => Object.assign(db, original));

const form = (text) => new URLSearchParams(text);
const patches = () => calls.filter(([name]) => name === 'patch');

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

// The values come from the database, not a literal, so none of them may split
// one id into several filter terms.
test('inList quotes every value, escapes quotes and backslashes, drops blanks and duplicates', () => {
  assert.equal(db.inList(['a,b', 'x"y', 'p)q', 'a,b', null, undefined, '']), 'in.("a,b","x\\"y","p)q")');
  assert.equal(db.inList(['c\\d']), 'in.("c\\\\d")');
  assert.equal(db.inList([]), 'in.()');
});

test('the total is read from every Content-Range shape PostgREST sends', () => {
  assert.equal(db.totalOf('0-24/531'), 531);
  assert.equal(db.totalOf('*/12'), 12);
  assert.equal(db.totalOf('*/*'), 0);
  assert.equal(db.totalOf('0-24/*'), 0);
  assert.equal(db.totalOf(null), 0);
});

const withFetch = async (respond, body) => {
  const saved = global.fetch;
  global.fetch = async () => respond();
  try { return await body(); } finally { global.fetch = saved; }
};
const reply = (status, text, contentRange) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => text,
  headers: { get: (name) => (name === 'content-range' ? contentRange : null) },
});

test('a page read returns rows with the total, and a plain read returns rows', async () => {
  await withFetch(() => reply(200, '[{"id":1}]', '0-0/531'), async () => {
    assert.deepEqual(await db.selectPage('t', {}), { rows: [{ id: 1 }], total: 531 });
    assert.deepEqual(await db.select('t', {}), [{ id: 1 }]);
  });
  await withFetch(() => reply(200, '', null), async () => {
    assert.deepEqual(await db.select('t', {}), [], 'an empty body is still an array');
  });
});

// Working page 2 while the queue drains lands here; it must not be a 500.
test('an offset past the end is an empty page with the real total, not an error', async () => {
  await withFetch(() => reply(416, '{"message":"Requested range not satisfiable"}', '*/12'), async () => {
    assert.deepEqual(await db.selectPage('t', { offset: '50' }), { rows: [], total: 12 });
  });
  await withFetch(() => reply(400, '{"message":"bad"}', null), async () => {
    await assert.rejects(db.selectPage('t', {}), /bad/);
  });
});

// ---------------------------------------------------------------------------
// Writes: each is safe only because of its status guard, so pin the guard.
// ---------------------------------------------------------------------------

test('reopen only matches a rejected clip, and clears the old reject note', async () => {
  stubDb({ patch: [{}] });
  const result = await writes['POST /clips/reopen'](form('created_clip_id=c1'), {});
  assert.deepEqual(patches()[0].slice(1), ['created_clips',
    { created_clip_id: 'eq.c1', review_status: 'eq.REJECTED' },
    { review_status: 'NEEDS_REVIEW', reviewer_notes: null }]);
  assert.deepEqual(result, { redirect: '/held' });
});

test('every status-guarded write is pinned to the state it expects', async () => {
  stubDb({ patch: [{}] });
  const cases = [
    ['POST /moments/approve', 'clip_moment_id=m1', 'clip_moments', { clip_moment_id: 'eq.m1', download_status: 'eq.AWAITING_MANUAL_APPROVAL' }],
    ['POST /moments/retry', 'clip_moment_id=m1', 'clip_moments', { clip_moment_id: 'eq.m1', download_status: 'eq.ERROR' }],
    ['POST /renders/retry', 'render_id=r1', 'render_jobs', { render_id: 'eq.r1', render_status: 'eq.FAILED' }],
    ['POST /channels/deactivate', 'source_id=s1', 'source_channels', { source_id: 'eq.s1' }],
  ];
  for (const [key, body, table, filter] of cases) {
    calls.length = 0;
    await writes[key](form(body), {});
    assert.equal(patches()[0][1], table, key);
    assert.deepEqual(patches()[0][2], filter, key);
  }
});

// WF14's backoff reads retry_count and last_error; a job Postiz may already
// have posted must never go back to PENDING.
test('queue again keeps the retry history, uses NULL for claimed_by, and refuses Postiz-submitted jobs', async () => {
  stubDb({ patch: [{}] });
  await writes['POST /publishes/retry'](form('publish_id=p1'), {});
  const [, table, filter, body] = patches()[0];
  assert.equal(table, 'publishing_jobs');
  assert.equal(filter.publish_status, 'in.(FAILED,AUTH_REQUIRED)');
  assert.equal(filter.postiz_submitted_at, 'is.null');
  assert.equal(filter.postiz_post_id, 'is.null');
  assert.ok(!('retry_count' in body) && !('last_error' in body));
  assert.equal(body.claimed_by, null);
});

test('an override keeps the gate\'s reason, marked overridden, and is guarded on the state it read', async () => {
  stubDb({
    selectOne: { video_id: 'v1', validity_status: 'REJECTED', rejection_reason: 'LOW_ENGAGEMENT' },
    patch: [{}],
  });
  const result = await writes['POST /held/release'](form('video_id=v1'), {});
  const [, table, filter, body] = patches()[0];
  assert.equal(table, 'candidate_videos');
  assert.deepEqual(filter, { video_id: 'eq.v1', validity_status: 'eq.REJECTED' });
  assert.equal(body.validity_status, 'VALID');
  assert.equal(body.rejection_reason, 'OVERRIDDEN: LOW_ENGAGEMENT');
  assert.equal(body.transcript_available, null);
  assert.deepEqual(result, { redirect: '/held' });
});

// A lost race matches no row, which PostgREST reports as success.
test('a write that matched nothing says so instead of redirecting as if it worked', async () => {
  stubDb({ patch: [] });
  const result = await writes['POST /renders/retry'](form('render_id=r1'), Promise.resolve({}));
  assert.equal(result.status, 409);
  assert.match(result.body, /Nothing changed/);
  stubDb({ selectOne: undefined });
  const gone = await writes['POST /held/release'](form('video_id=v9'), {});
  assert.equal(gone.status, 409);
  assert.equal(patches().length, 0, 'a video no longer held is not written at all');
});

// The old path re-rendered page 1, so a clip on page 2 or from a permalink
// lost the operator's typing and the error with it.
test('a failed approval re-renders that one clip with the typing and the errors', async () => {
  stubDb({ selectOne: { created_clip_id: 'c7', review_status: 'NEEDS_REVIEW', suggested_title: 'S' } });
  const result = await writes['POST /clips/approve'](
    form('created_clip_id=c7&final_title=Kept&final_caption=Mine'), {});
  assert.equal(result.status, 400);
  assert.match(result.body, /Fix and resubmit/);
  assert.match(result.body, /id="c7"/);
  assert.match(result.body, />Mine</);
  assert.match(result.body, /Tick at least one platform/);
  assert.equal(calls.filter(([name]) => name === 'rpc').length, 0);
  assert.equal(calls.find(([name]) => name === 'selectOne')[2].review_status, 'eq.NEEDS_REVIEW');
});

test('a failed reject shows its error, and a clip already decided is reported, not re-rendered', async () => {
  stubDb({ selectOne: { created_clip_id: 'c7', review_status: 'NEEDS_REVIEW' } });
  const result = await writes['POST /clips/reject'](form('created_clip_id=c7'), {});
  assert.equal(result.status, 400);
  assert.match(result.body, /Pick a reason for rejecting/);
  stubDb({ selectOne: undefined });
  const decided = await writes['POST /clips/reject'](form('created_clip_id=c7'), {});
  assert.equal(decided.status, 409);
});

test('an approval is read in the configured zone', async () => {
  stubDb();
  await writes['POST /clips/approve'](
    form('created_clip_id=c1&final_title=T&platforms=TIKTOK&scheduled_at=2026-10-20T09:00'), {});
  const [, fn, args] = calls.find(([name]) => name === 'rpc');
  assert.equal(fn, 'approve_clip');
  assert.equal(args.p_scheduled_at, '2026-10-20T06:00:00.000Z');
});

test('the channels error pages list channels in the same order as the normal page', async () => {
  stubDb();
  await writes['POST /channels/priority'](form('source_id=s1&priority=0'), {});
  await writes['POST /channels'](form('source_id='), {});
  for (const [, table, params] of calls.filter(([name]) => name === 'select')) {
    assert.equal(table, 'source_channels');
    assert.equal(params.order, 'niche.asc,priority.asc,source_name.asc');
  }
  assert.equal(patches().length, 0);
});

// ---------------------------------------------------------------------------
// Permalinks
// ---------------------------------------------------------------------------

const permalink = (path) => permalinks.find(([pattern]) => pattern.test(path));
const openLink = async (path) => {
  const [pattern, handler] = permalink(path);
  return handler(decodeURIComponent(pattern.exec(path)[1]), {});
};

test('a clip permalink shows the verdict form only while the clip awaits review', async () => {
  stubDb({ selectOne: { created_clip_id: 'c1', review_status: 'NEEDS_REVIEW' } });
  assert.match(await openLink('/clips/c1'), /action="\/clips\/approve"/);
  stubDb({ selectOne: { created_clip_id: 'c1', review_status: 'APPROVED' } });
  const approved = await openLink('/clips/c1');
  assert.doesNotMatch(approved, /action="\/clips\/(approve|reopen)"/);
  stubDb({ selectOne: { created_clip_id: 'c1', review_status: 'REJECTED' } });
  assert.match(await openLink('/clips/c1'), /action="\/clips\/reopen"/);
  stubDb({ selectOne: undefined });
  assert.equal(await openLink('/clips/nope'), null);
});

test('a moment permalink offers approval only when approval can work', async () => {
  stubDb({ selectOne: { clip_moment_id: 'm1', download_status: 'AWAITING_MANUAL_APPROVAL' } });
  assert.match(await openLink('/moments/m1'), /action="\/moments\/approve"/);
  stubDb({ selectOne: { clip_moment_id: 'm1', download_status: 'ERROR', error_message: 'yt-dlp 403 token=abc' } });
  const failed = await openLink('/moments/m1');
  assert.doesNotMatch(failed, /action="\/moments\/approve"/);
  assert.match(failed, /action="\/moments\/retry"/);
  assert.doesNotMatch(failed, /token=abc/);
  stubDb({ selectOne: { clip_moment_id: 'm1', download_status: 'DOWNLOADED' } });
  assert.doesNotMatch(await openLink('/moments/m1'), /<form/);
});

test('offsets are whole, finite and non-negative', () => {
  const at = (value) => offsetOf(new URL(`http://x/?offset=${value}`));
  assert.equal(at('25'), 25);
  assert.equal(at('1.5'), 1);
  assert.equal(at('Infinity'), 0);
  assert.equal(at('-5'), 0);
  assert.equal(at('abc'), 0);
});

// ---------------------------------------------------------------------------
// Over HTTP
// ---------------------------------------------------------------------------

const listen = () => new Promise((resolve) => {
  server.listen(0, '127.0.0.1', () => resolve(server.address().port));
});
const get = (port, path) => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port, path, headers: { host: '127.0.0.1' } }, (response) => {
    let body = '';
    response.on('data', (chunk) => { body += chunk; });
    response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body }));
  }).on('error', reject);
});

// A form inside a framed copy of this page posts same-origin, so the
// Sec-Fetch-Site guard cannot stop a tricked click; only refusing to be framed
// can.
test('every response refuses framing, and a malformed permalink is a 404', async () => {
  stubDb({ selectOne: undefined });
  const port = await listen();
  try {
    const page = await get(port, '/clips/missing');
    assert.equal(page.status, 404);
    assert.equal(page.headers['x-frame-options'], 'DENY');
    assert.match(page.headers['content-security-policy'], /frame-ancestors 'none'/);
    assert.match(page.headers['content-security-policy'], /frame-src https:\/\/drive\.google\.com/);
    const malformed = await get(port, '/clips/%E0');
    assert.equal(malformed.status, 404, 'a bad escape is a bad link, not a server fault');
    const forbidden = await new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path: '/', headers: { host: 'evil.example' } },
        (response) => { response.resume(); resolve(response); }).on('error', reject);
    });
    assert.equal(forbidden.statusCode, 403);
    assert.equal(forbidden.headers['x-frame-options'], 'DENY');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  assert.equal(SECURITY_HEADERS['x-frame-options'], 'DENY');
});
