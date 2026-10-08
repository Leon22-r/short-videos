const http = require('node:http');
const render = require('./render');
const db = require('./postgrest');

const BIND = process.env.REVIEW_BIND_ADDRESS || '127.0.0.1';
const PORT = Number(process.env.REVIEW_PORT || 8080);

const html = (response, status, body) => {
  response.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
  response.end(body);
};
const seeOther = (response, location) => {
  response.writeHead(303, { location });
  response.end();
};

const readForm = (request) => new Promise((resolve, reject) => {
  let body = '';
  request.on('data', (chunk) => {
    body += chunk;
    // No session, no auth, but still no unbounded buffer.
    if (body.length > 64 * 1024) { reject(new Error('form too large')); request.destroy(); }
  });
  request.on('end', () => resolve(new URLSearchParams(body)));
  request.on('error', reject);
});

const routes = {
  'GET /': async () => {
    const clips = await db.select('created_clips', {
      review_status: 'eq.NEEDS_REVIEW', order: 'created_at.asc', limit: '50',
    });
    return render.page({ title: 'Clip review', body: render.clipQueue(clips) });
  },
  'GET /moments': async () => {
    const moments = await db.select('clip_moments', {
      download_status: 'eq.AWAITING_MANUAL_APPROVAL', order: 'created_at.asc', limit: '100',
    });
    return render.page({ title: 'High-risk moments', body: render.momentQueue(moments) });
  },
  'GET /channels': async () => render.page({ title: 'Add channel', body: render.channelForm() }),
};

// The network is the authentication (D5), which means the server has no
// session and no token to bind a form to. A page the operator opens in the
// same browser can still POST here, so a state-changing request must look
// same-origin. Sec-Fetch-Site is sent by every current browser and cannot be
// set by page script; Origin is the fallback for anything that omits it.
const sameOrigin = (request, host) => {
  const site = request.headers['sec-fetch-site'];
  if (site) return site === 'same-origin' || site === 'none';
  const origin = request.headers.origin;
  if (!origin) return true; // A plain form post from a non-Fetch-Metadata client.
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
};

const server = http.createServer(async (request, response) => {
  let url;
  try {
    // A malformed or absent Host header must not throw out of the handler.
    url = new URL(request.url, `http://${request.headers.host || '127.0.0.1'}`);
  } catch {
    return html(response, 400, '<!doctype html><title>Bad request</title><h1>Bad request</h1>');
  }
  const key = `${request.method} ${url.pathname}`;
  try {
    if (request.method !== 'GET' && !sameOrigin(request, url.host)) {
      return html(response, 403, render.page({
        title: 'Forbidden',
        body: '<h1>Forbidden</h1><p>This request did not come from this page.</p>',
      }));
    }
    if (routes[key]) return html(response, 200, await routes[key]());

    if (key === 'POST /clips/approve') {
      const { values, errors } = render.parseApproveForm(await readForm(request));
      if (Object.keys(errors).length) {
        return html(response, 400, render.page({
          title: 'Approve failed',
          body: `<h1>Approve failed</h1>${Object.values(errors)
            .map((message) => `<p class="error">${render.escapeHtml(message)}</p>`).join('')}<p><a href="/">Back</a></p>`,
        }));
      }
      await db.rpc('approve_clip', values);
      return seeOther(response, '/');
    }

    if (key === 'POST /clips/reject') {
      const form = await readForm(request);
      await db.rpc('reject_clip', { p_created_clip_id: form.get('created_clip_id') });
      return seeOther(response, '/');
    }

    if (key === 'POST /moments/approve') {
      const form = await readForm(request);
      await db.patch('clip_moments', {
        clip_moment_id: `eq.${form.get('clip_moment_id')}`,
        download_status: 'eq.AWAITING_MANUAL_APPROVAL',
      }, { download_status: 'PENDING' });
      return seeOther(response, '/moments');
    }

    if (key === 'POST /channels') {
      const { values, errors } = render.parseChannelForm(await readForm(request));
      if (Object.keys(errors).length) {
        return html(response, 400, render.page({
          title: 'Add channel', body: render.channelForm(values, errors),
        }));
      }
      await db.insert('source_channels', values);
      return seeOther(response, '/channels');
    }

    return html(response, 404, render.page({ title: 'Not found', body: '<h1>Not found</h1>' }));
  } catch (error) {
    // The message may be a RAISE EXCEPTION from approve_clip, which is
    // operator-facing text, so show it rather than a bare 500.
    return html(response, 500, render.page({
      title: 'Error', body: `<h1>Error</h1><pre>${render.escapeHtml(error.message)}</pre><p><a href="/">Back</a></p>`,
    }));
  }
});

// Exported so the same-origin guard is testable without binding a port or
// reaching Supabase; only a direct run starts listening.
module.exports = { server, sameOrigin };

if (require.main === module) {
  server.listen(PORT, BIND, () => console.log(`review ui on http://${BIND}:${PORT}`));
}
