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

async function request(method, pathAndQuery, body) {
  const response = await fetch(`${BASE}/rest/v1/${pathAndQuery}`, {
    method,
    headers: { ...headers, prefer: 'return=representation' },
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
  return text ? JSON.parse(text) : null;
}

const query = (params) => new URLSearchParams(params).toString();

const select = (table, params = {}) => request('GET', `${table}?${query(params)}`);
const insert = (table, body) => request('POST', table, body);
const patch = (table, filter, body) => request('PATCH', `${table}?${query(filter)}`, body);
const rpc = (fn, args) => request('POST', `rpc/${fn}`, args);

module.exports = { select, insert, patch, rpc };
