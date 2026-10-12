const http = require('node:http');
const render = require('./render');
const summarise = require('./summarise');
const db = require('./postgrest');

const BIND = process.env.REVIEW_BIND_ADDRESS || '127.0.0.1';
const PORT = Number(process.env.REVIEW_PORT || 8080);
const PAGE_SIZE = 25;

// The hostnames this server will answer to. Anything else is a DNS rebinding
// attempt: an attacker points their own domain at this address, the operator's
// browser resolves it, and every request then arrives with the attacker's
// domain in Host — and, critically, in Origin too, so an Origin/Host
// comparison agrees with itself and lets the request through. Once that works
// the attacker's page is same-origin with this one, so it can read the clip
// queue as well as post to it. Comparing against a fixed list instead is the
// only check the attacker cannot influence.
//
// The container always listens on 0.0.0.0 and is reached through the published
// port, so the names below are what the operator's browser actually uses:
// loopback for a local tunnel, and the host's tailnet address or name.
const ALLOWED_HOSTS = new Set(
  (process.env.REVIEW_ALLOWED_HOSTS || `${BIND},127.0.0.1,localhost,[::1]`)
    .split(',')
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean),
);

// Host carries a port; the allowlist is matched on the hostname alone, because
// the published port is a deployment detail and an attacker cannot reach a port
// nothing is listening on.
const hostnameOf = (value) => {
  const host = String(value || '').trim().toLowerCase();
  if (!host) return '';
  if (host.startsWith('[')) return host.slice(0, host.indexOf(']') + 1);
  return host.split(':')[0];
};

const hostAllowed = (value) => {
  const hostname = hostnameOf(value);
  return hostname !== '' && ALLOWED_HOSTS.has(hostname);
};

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

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

const since = (days) => new Date(Date.now() - days * 86400000).toISOString();

// One row of queue sizes for the navigation. A failure here must not take a
// page down with it: the counts are an aid, the screen is the job.
const navCounts = async () => {
  try {
    return (await db.selectOne('review_counts', {})) || {};
  } catch {
    return {};
  }
};

// created_clips knows which moment it came from but not where that moment sat
// in the source video, and the cut timestamps are what make a source link
// worth following. One extra read, only the four columns needed.
const withMomentContext = async (clips) => {
  const ids = clips.map((clip) => clip.clip_moment_id).filter(Boolean);
  if (ids.length === 0) return clips;
  const moments = await db.select('clip_moments', {
    clip_moment_id: db.inList(ids),
    select: 'clip_moment_id,source_video_url,start_sec,end_sec',
  });
  const byId = new Map((moments || []).map((moment) => [moment.clip_moment_id, moment]));
  return clips.map((clip) => {
    const moment = byId.get(clip.clip_moment_id);
    return moment ? { ...clip, ...moment, clip_moment_id: clip.clip_moment_id } : clip;
  });
};

const loadClipQueue = async (offset) => {
  const { rows, total } = await db.selectPage('created_clips', {
    review_status: 'eq.NEEDS_REVIEW',
    order: 'created_at.asc',
    offset: String(offset),
    limit: String(PAGE_SIZE),
  });
  return { clips: await withMomentContext(rows || []), total };
};

const loadHeld = async () => {
  const [flagged, rejected, clips, reasonRows] = await Promise.all([
    db.select('candidate_videos', {
      validity_status: 'eq.FLAGGED', order: 'created_at.asc', limit: '50',
    }),
    db.select('candidate_videos', {
      validity_status: 'eq.REJECTED', order: 'created_at.desc', limit: '50',
    }),
    db.select('created_clips', {
      review_status: 'eq.REJECTED', order: 'created_at.desc', limit: '50',
    }),
    db.select('candidate_videos', {
      validity_status: 'eq.REJECTED',
      created_at: `gte.${since(30)}`,
      select: 'rejection_reason',
      limit: '2000',
    }),
  ]);
  return {
    flagged: flagged || [],
    rejected: rejected || [],
    clips: clips || [],
    reasonCounts: summarise.countReasons(reasonRows || []),
  };
};

const loadStuck = async () => {
  const [moments, renders, publishes, clips] = await Promise.all([
    db.select('clip_moments', {
      download_status: 'eq.ERROR', order: 'created_at.desc', limit: '50',
    }),
    db.select('render_jobs', {
      render_status: 'eq.FAILED', order: 'created_at.desc', limit: '50',
    }),
    db.select('publishing_jobs', {
      publish_status: 'in.(FAILED,AUTH_REQUIRED)', order: 'created_at.desc', limit: '50',
    }),
    db.select('created_clips', {
      review_status: 'in.(AWAITING_DOWNLOAD,NEEDS_RETRY)', order: 'created_at.asc', limit: '50',
    }),
  ]);
  return {
    moments: moments || [], renders: renders || [], publishes: publishes || [], clips: clips || [],
  };
};

const loadPipeline = async () => {
  const [stages, channels, publishingChannels, leases, errorRows, clipRows] = await Promise.all([
    db.select('pipeline_status', { order: 'position.asc' }),
    db.select('source_channels', {
      select: 'source_id,source_name,niche,active_status,auto_paused_at,auto_paused_reason',
      limit: '500',
    }),
    db.select('publishing_channels', {
      select: 'channel_id,platform,token_expires_at,last_health_status,enabled_status',
      limit: '200',
    }),
    db.select('publishing_jobs', {
      publish_status: 'in.(CLAIMED,UPLOADING,PROCESSING)',
      select: 'publish_id,platform,publish_status,claimed_at,claimed_by',
      order: 'claimed_at.asc',
      limit: '100',
    }),
    db.select('error_log', {
      created_at: `gte.${since(7)}`,
      select: 'workflow_name,node_name,error_message,created_at',
      order: 'created_at.desc',
      limit: '500',
    }),
    db.select('created_clips', {
      created_at: `gte.${since(7)}`,
      select: 'created_at,review_status',
      limit: '2000',
    }),
  ]);
  return {
    stages: stages || [],
    alarms: render.buildAlarms({
      stages: stages || [],
      channels: channels || [],
      publishingChannels: publishingChannels || [],
      leases: leases || [],
    }),
    errors: summarise.groupErrors(errorRows || []),
    throughput: summarise.dailyThroughput(clipRows || []),
  };
};

// ---------------------------------------------------------------------------
// GET routes
// ---------------------------------------------------------------------------

const offsetOf = (url) => Math.max(0, Number(url.searchParams.get('offset')) || 0);

const screen = (title, current, body, counts) =>
  render.page({ title, body, counts, current });

const routes = {
  'GET /': async (url, counts) => {
    const offset = offsetOf(url);
    const { clips, total } = await loadClipQueue(offset);
    return screen('Clip review', '/', render.clipQueue(clips, {
      page: { offset, limit: PAGE_SIZE, total },
    }), counts);
  },

  'GET /moments': async (url, counts) => {
    const offset = offsetOf(url);
    const { rows, total } = await db.selectPage('clip_moments', {
      download_status: 'eq.AWAITING_MANUAL_APPROVAL',
      order: 'created_at.asc',
      offset: String(offset),
      limit: String(PAGE_SIZE),
    });
    return screen('High-risk moments', '/moments', render.momentQueue(rows || [], {
      page: { offset, limit: PAGE_SIZE, total },
    }), counts);
  },

  'GET /held': async (url, counts) =>
    screen('Held', '/held', render.heldBoard(await loadHeld()), counts),

  'GET /stuck': async (url, counts) =>
    screen('Stuck', '/stuck', render.stuckBoard(await loadStuck()), counts),

  'GET /pipeline': async (url, counts) =>
    screen('Pipeline', '/pipeline', render.pipelineBoard(await loadPipeline()), counts),

  'GET /channels': async (url, counts) => {
    const channels = await db.select('source_channels', { order: 'niche.asc,priority.asc,source_name.asc', limit: '500' });
    return screen('Channels', '/channels', render.channelBoard({ channels: channels || [] }), counts);
  },

  'GET /published': async (url, counts) => {
    const [jobs, credentials] = await Promise.all([
      db.select('publishing_jobs', {
        publish_status: 'in.(PUBLISHED,DRAFT_UPLOADED)',
        order: 'completed_at.desc.nullslast',
        limit: '50',
      }),
      db.select('publishing_channels', { order: 'platform.asc', limit: '200' }),
    ]);
    return screen('Published', '/published', render.publishedBoard({
      jobs: jobs || [], credentials: credentials || [],
    }), counts);
  },
};

// Permalinks. Until now an item existed only inside a queue, so a clip could
// not be linked to from the digest email, reopened after rejection, or looked
// at again once it left the list.
const permalinks = [
  [/^\/clips\/([^/]+)$/, async (id, counts) => {
    const clip = await db.selectOne('created_clips', { created_clip_id: `eq.${id}` });
    if (!clip) return null;
    const [withContext] = await withMomentContext([clip]);
    const body = clip.review_status === 'NEEDS_REVIEW'
      ? render.clipItem(withContext)
      // Not in the queue any more, so show the record without a verdict form.
      : `<h1>${render.escapeHtml(clip.clip_title || clip.suggested_title || id)}</h1>
<p class="mute">This clip is ${render.escapeHtml(clip.review_status)}${
          clip.reviewer_notes ? `, noted: ${render.escapeHtml(clip.reviewer_notes)}` : ''}.</p>
${clip.review_status === 'REJECTED'
          ? `<form method="post" action="/clips/reopen" class="verdict">
    <input type="hidden" name="created_clip_id" value="${render.escapeHtml(id)}">
    <button type="submit">Reopen for review</button>
  </form>`
          : ''}`;
    return screen(clip.clip_title || 'Clip', '', body, counts);
  }],
  [/^\/moments\/([^/]+)$/, async (id, counts) => {
    const moment = await db.selectOne('clip_moments', { clip_moment_id: `eq.${id}` });
    if (!moment) return null;
    return screen(moment.suggested_title || 'Moment', '',
      render.momentQueue([moment]), counts);
  }],
];

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

// A failed validation used to throw the operator's typing away and show a bare
// error page. Re-render the queue with their values and the errors in place.
const reRenderClipQueue = async (clipId, form, errors, counts) => {
  const { clips, total } = await loadClipQueue(0);
  return screen('Clip review', '/', render.clipQueue(clips, {
    [clipId]: { values: form, errors },
    page: { offset: 0, limit: PAGE_SIZE, total },
  }), counts);
};

const writes = {
  'POST /clips/approve': async (form, counts) => {
    const { values, errors, form: typed } = render.parseApproveForm(form);
    if (Object.keys(errors).length) {
      return { body: await reRenderClipQueue(values.p_created_clip_id, typed, errors, counts), status: 400 };
    }
    await db.rpc('approve_clip', values);
    return { redirect: '/' };
  },

  'POST /clips/reject': async (form, counts) => {
    const { values, errors } = render.parseRejectForm(form);
    if (Object.keys(errors).length) {
      return {
        body: await reRenderClipQueue(values.p_created_clip_id, {}, errors, counts),
        status: 400,
      };
    }
    await db.rpc('reject_clip', values);
    return { redirect: '/' };
  },

  // Rejecting only sets a status — no Drive file and no render is removed — and
  // approve_clip already demands NEEDS_REVIEW, so putting a clip back is a
  // single-table write that needs no new function.
  'POST /clips/reopen': async (form) => {
    await db.patch('created_clips', {
      created_clip_id: `eq.${form.get('created_clip_id')}`,
      review_status: 'eq.REJECTED',
    }, { review_status: 'NEEDS_REVIEW' });
    return { redirect: '/held' };
  },

  'POST /moments/approve': async (form) => {
    await db.patch('clip_moments', {
      clip_moment_id: `eq.${form.get('clip_moment_id')}`,
      download_status: 'eq.AWAITING_MANUAL_APPROVAL',
    }, { download_status: 'PENDING' });
    return { redirect: '/moments' };
  },

  'POST /moments/retry': async (form) => {
    await db.patch('clip_moments', {
      clip_moment_id: `eq.${form.get('clip_moment_id')}`,
      download_status: 'eq.ERROR',
    }, { download_status: 'PENDING', error_message: null });
    return { redirect: '/stuck' };
  },

  'POST /renders/retry': async (form) => {
    await db.patch('render_jobs', {
      render_id: `eq.${form.get('render_id')}`,
      render_status: 'eq.FAILED',
    }, { render_status: 'PENDING', error_message: null });
    return { redirect: '/stuck' };
  },

  // Back to PENDING rather than clearing the history: retry_count and
  // last_error are what WF14's backoff reads, and losing them would make a
  // job that has failed six times look new.
  'POST /publishes/retry': async (form) => {
    await db.patch('publishing_jobs', {
      publish_id: `eq.${form.get('publish_id')}`,
      publish_status: 'in.(FAILED,AUTH_REQUIRED)',
    }, { publish_status: 'PENDING', next_retry_at: null, claimed_at: null, claimed_by: '', lease_expires_at: null });
    return { redirect: '/stuck' };
  },

  // The override. WF3 skips anything whose validity_status is already set, so
  // clearing it would only have the same rule reject the video again. Marking
  // it VALID instead sends it straight to WF4, which is what "I disagree with
  // the gate" has to mean. transcript_available is cleared because WF4's own
  // filter wants it unset.
  'POST /held/release': async (form) => {
    await db.patch('candidate_videos', {
      video_id: `eq.${form.get('video_id')}`,
      validity_status: 'in.(FLAGGED,REJECTED)',
    }, {
      validity_status: 'VALID',
      rejection_reason: '',
      transcript_available: null,
      processing_status: 'NEW',
    });
    return { redirect: '/held' };
  },

  'POST /channels': async (form, counts) => {
    const { values, errors } = render.parseChannelForm(form);
    if (Object.keys(errors).length) {
      const channels = await db.select('source_channels', { order: 'niche.asc,priority.asc', limit: '500' });
      return {
        status: 400,
        body: screen('Channels', '/channels',
          render.channelBoard({ channels: channels || [], values, errors }), counts),
      };
    }
    await db.insert('source_channels', values);
    return { redirect: '/channels' };
  },

  // Reactivating clears the auto-pause as well as the flag, otherwise the
  // channel shows as paused for ever and WF5's health check has nothing to
  // re-pause it from.
  'POST /channels/activate': async (form) => {
    await db.patch('source_channels', { source_id: `eq.${form.get('source_id')}` }, {
      active_status: true,
      auto_paused_at: null,
      auto_paused_reason: null,
      health_reset_at: new Date().toISOString(),
    });
    return { redirect: '/channels' };
  },

  'POST /channels/deactivate': async (form) => {
    await db.patch('source_channels', { source_id: `eq.${form.get('source_id')}` },
      { active_status: false });
    return { redirect: '/channels' };
  },

  'POST /channels/priority': async (form, counts) => {
    const { errors, source_id: sourceId, priority } = render.parsePriorityForm(form);
    if (Object.keys(errors).length) {
      const channels = await db.select('source_channels', { order: 'niche.asc,priority.asc', limit: '500' });
      return {
        status: 400,
        body: screen('Channels', '/channels',
          render.channelBoard({ channels: channels || [], errors }), counts),
      };
    }
    await db.patch('source_channels', { source_id: `eq.${sourceId}` }, { priority });
    return { redirect: '/channels' };
  },
};

// The network is the authentication (D5), which means the server has no
// session and no token to bind a form to. A page the operator opens in the
// same browser can still POST here, so a state-changing request must look
// same-origin. Sec-Fetch-Site is sent by every current browser and cannot be
// set by page script; Origin is the fallback for anything that omits it.
// Applied to every non-GET. Both halves are required and they defend against
// different things: ALLOWED_HOSTS stops a rebound domain (the attacker controls
// Host, so Host can never be the thing a check trusts), and the Origin
// comparison below stops a different origin on an allowed *host* — a browser
// treats http://localhost:5678 and http://localhost:5680 as separate origins,
// and n8n itself sits on one of them, so comparing hostnames while ignoring the
// port would make any other local service same-origin with this one.
const sameOrigin = (request) => {
  const site = request.headers['sec-fetch-site'];
  // Only same-origin, deliberately not 'none'. 'none' is a user-initiated
  // navigation — a typed URL or a bookmark — which is not how a form posts, so
  // accepting it on a write would reopen the hole for any client that can set
  // the header while omitting Origin.
  if (site) return site === 'same-origin';
  const origin = request.headers.origin;
  if (!origin) return true; // A plain form post from a non-Fetch-Metadata client.
  try {
    // host, not hostname: it carries the port, and the port is part of the
    // origin. Compared to this request's Host, which the allowlist has already
    // vouched for — under rebinding Host is rejected before we get here.
    return new URL(origin).host.toLowerCase() === String(request.headers.host || '').toLowerCase();
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
  // Before routing, and for GET as well: a rebound page can read a response it
  // is same-origin with, so the clip queue leaks without this.
  if (!hostAllowed(request.headers.host)) {
    return html(response, 403, '<!doctype html><title>Forbidden</title><h1>Forbidden</h1>'
      + '<p>This server does not answer to that hostname.</p>');
  }

  const key = `${request.method} ${url.pathname}`;
  try {
    if (request.method !== 'GET' && !sameOrigin(request)) {
      return html(response, 403, render.page({
        title: 'Forbidden',
        body: '<h1>Forbidden</h1><p>This request did not come from this page.</p>',
      }));
    }

    if (request.method === 'GET') {
      const counts = await navCounts();
      if (routes[key]) return html(response, 200, await routes[key](url, counts));
      for (const [pattern, handler] of permalinks) {
        const match = pattern.exec(url.pathname);
        if (!match) continue;
        const body = await handler(decodeURIComponent(match[1]), counts);
        if (body) return html(response, 200, body);
        return html(response, 404, render.page({
          title: 'Not found', counts,
          body: '<h1>Not found</h1><p>No record with that id. It may have been renamed by a backfill.</p>',
        }));
      }
    }

    if (writes[key]) {
      const counts = await navCounts();
      const result = await writes[key](await readForm(request), counts);
      if (result.redirect) return seeOther(response, result.redirect);
      return html(response, result.status || 200, result.body);
    }

    return html(response, 404, render.page({ title: 'Not found', body: '<h1>Not found</h1>' }));
  } catch (error) {
    // The message may be a RAISE EXCEPTION from approve_clip, which is
    // operator-facing text, so show it rather than a bare 500.
    return html(response, 500, render.page({
      title: 'Error',
      body: `<h1>That did not go through</h1><pre>${render.escapeHtml(error.message)}</pre>`
        + '<p><a href="/">Back to the queue</a></p>',
    }));
  }
});

// Exported so the same-origin guard is testable without binding a port or
// reaching Supabase; only a direct run starts listening.
module.exports = { server, sameOrigin, hostAllowed, hostnameOf };

if (require.main === module) {
  server.listen(PORT, BIND, () => console.log(`review ui on http://${BIND}:${PORT}`));
}
