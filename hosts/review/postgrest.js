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
    throw error;
  }
  return {
    rows: text ? JSON.parse(text) : null,
    // Content-Range is "0-24/531" when a count was asked for, "*/*" when the
    // range is empty. The total is what the pager needs to stop lying about
    // how much it is hiding.
    total: Number(String(response.headers.get('content-range') || '').split('/')[1]) || 0,
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

const select = async (table, params = {}) => (await request('GET', `${table}?${query(params)}`)).rows;

// Same read, plus the unfiltered total, for a screen that paginates.
const selectPage = (table, params = {}) =>
  request('GET', `${table}?${query(params)}`, undefined, { prefer: 'count=exact' });

const selectOne = async (table, params = {}) => {
  const rows = await select(table, { ...params, limit: '1' });
  return Array.isArray(rows) ? rows[0] : rows;
};

const insert = async (table, body) => (await request('POST', table, body)).rows;
const patch = async (table, filter, body) =>
  (await request('PATCH', `${table}?${query(filter)}`, body)).rows;
const rpc = async (fn, args) => (await request('POST', `rpc/${fn}`, args)).rows;

module.exports = { select, selectPage, selectOne, insert, patch, rpc, inList };
