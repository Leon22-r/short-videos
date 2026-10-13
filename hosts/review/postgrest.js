// Supabase PostgREST over built-in fetch. The service key stays here and is
// never rendered into a page (D11). The one write that spans two tables goes
// through the approve_clip RPC, because PostgREST has no transaction.
const BASE = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_KEY;

if (!BASE || !KEY) {
  throw new Error('SUPABASE_URL and SUPABASE_SERVICE_KEY are required');
}

const headers = {
  apikey: KEY,
  authorization: `Bearer ${KEY}`,
  'content-type': 'application/json',
  'accept-profile': 'short_videos',
  'content-profile': 'short_videos',
};

// Content-Range is "0-24/531" when a count was asked for, "*/531" when the
// requested range is past the end, and "*/*" or absent when nothing was
// counted. The total is what the pager needs to stop lying about how much it
// is hiding.
const totalOf = (contentRange) => Number(String(contentRange || '').split('/')[1]) || 0;

async function request(method, pathAndQuery, body, extraHeaders = {}) {
  const response = await fetch(`${BASE}/rest/v1/${pathAndQuery}`, {
    method,
    headers: { ...headers, prefer: 'return=representation', ...extraHeaders },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  const text = await response.text();
  if (!response.ok) {
    // PostgREST puts a RAISE EXCEPTION message in .message; surface it so the
    // operator sees "requires at least one platform" rather than "500".
    let detail = text;
    try { detail = JSON.parse(text).message || text; } catch {}
    const error = new Error(detail);
    error.status = response.status;
    error.contentRange = response.headers.get('content-range');
    throw error;
  }
  return {
    rows: text ? JSON.parse(text) : null,
    total: totalOf(response.headers.get('content-range')),
  };
}

const query = (params) => new URLSearchParams(params).toString();

// PostgREST's in.() takes a bare comma-separated list, so any value carrying a
// comma, a quote or a paren has to be double-quoted. Ids here are generated,
// but they arrive from the database rather than from a literal, so quote them
// all rather than assuming their shape.
const inList = (values) => `in.(${[...new Set(values)]
  .filter((value) => value !== null && value !== undefined && value !== '')
  .map((value) => `"${String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`)
  .join(',')})`;

// A GET always answers with an array; an empty body is the only way to get
// anything else, and callers should not each have to guard against it.
const select = async (table, params = {}) =>
  (await request('GET', `${table}?${query(params)}`)).rows || [];

// Same read, plus the unfiltered total, for a screen that paginates. With a
// count asked for, an offset past the end is 416 rather than an empty page —
// which is the ordinary case of working page 2 while the queue drains, so it
// is an empty page here too, and the total still comes back.
const selectPage = async (table, params = {}) => {
  try {
    const { rows, total } = await request('GET', `${table}?${query(params)}`, undefined, { prefer: 'count=exact' });
    return { rows: rows || [], total };
  } catch (error) {
    if (error.status === 416) return { rows: [], total: totalOf(error.contentRange) };
    throw error;
  }
};

const selectOne = async (table, params = {}) => (await select(table, { ...params, limit: '1' }))[0];

const insert = async (table, body) => (await request('POST', table, body)).rows;
// Returns the rows that matched. A status-guarded patch that matched nothing
// is not an error to PostgREST, so callers that guard on status must check.
const patch = async (table, filter, body) =>
  (await request('PATCH', `${table}?${query(filter)}`, body)).rows || [];
const rpc = async (fn, args) => (await request('POST', `rpc/${fn}`, args)).rows;

module.exports = { select, selectPage, selectOne, insert, patch, rpc, inList, totalOf };
