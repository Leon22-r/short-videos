const http = require('node:http');
const render = require('./render');
const summarise = require('./summarise');
const db = require('./postgrest');

const BIND = process.env.REVIEW_BIND_ADDRESS || '127.0.0.1';
const PORT = Number(process.env.REVIEW_PORT || 8080);
const PAGE_SIZE = 25;
const LIST_SIZE = 50;
const DAY_MS = 86400000;

// The zone a "Publish at" time is typed in. Checked at start-up, because a
// misspelt zone would otherwise surface as a RangeError on the first approval.
const TIME_ZONE = process.env.REVIEW_TIMEZONE || 'Africa/Nairobi';
new Intl.DateTimeFormat('en-US', { timeZone: TIME_ZONE });

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

// No page here may be framed. The same-origin guard below cannot tell a click
// the operator meant from one a hostile page tricked out of them through a
// transparent iframe of this console, because a form inside the frame posts
// from this origin. One disguised click is enough to override a gate, so
// framing is refused outright. The rest of the policy is cheap backing for
// escapeHtml: the UI has no script at all, so none is allowed to run.
const SECURITY_HEADERS = {
  'x-frame-options': 'DENY',
  'content-security-policy': [
    "default-src 'none'",
    "style-src 'unsafe-inline'",
    'frame-src https://drive.google.com',
    "form-action 'self'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join('; '),
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
};

const html = (response, status, body) => {
  response.writeHead(status, { ...SECURITY_HEADERS, 'content-type': 'text/html; charset=utf-8' });
  response.end(body);
};
const seeOther = (response, location) => {
  response.writeHead(303, { ...SECURITY_HEADERS, location });
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

const since = (days) => new Date(Date.now() - days * DAY_MS).toISOString();

// One row of queue sizes for the navigation. A failure here must not take a
// page down with it: the counts are an aid, the screen is the job. Started
// alongside the screen's own reads rather than before them, so it costs no
// extra round trip; screen() awaits it.
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
  const byId = new Map(moments.map((moment) => [moment.clip_moment_id, moment]));
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
  return { clips: await withMomentContext(rows), total };
};

// A short list with its true size, so the screen can say "newest 50 of 212".
const newest = (table, params) => db.selectPage(table, {
  order: 'created_at.desc', limit: String(LIST_SIZE), ...params,
});

const VIDEO_COLUMNS = 'video_id,video_title,video_url,source_name,rejection_reason,created_at';

const loadHeld = async () => {
  const [flagged, rejected, clips, reasonCounts] = await Promise.all([
    newest('candidate_videos', {
      validity_status: 'eq.FLAGGED', select: VIDEO_COLUMNS, order: 'created_at.asc',
    }),
    newest('candidate_videos', { validity_status: 'eq.REJECTED', select: VIDEO_COLUMNS }),
    newest('created_clips', {
      review_status: 'eq.REJECTED',
      select: 'created_clip_id,clip_title,suggested_title,niche,reviewer_notes,created_at',
    }),
    db.select('held_reasons_30d', {}),
  ]);
  return {
    flagged: flagged.rows,
    rejected: rejected.rows,
    clips: clips.rows,
    reasonCounts,
    totals: { flagged: flagged.total, rejected: rejected.total, clips: clips.total },
  };
};

// Only the columns the screen shows. raw_payload, provider_response and the
// Postiz submit payload carry provider references and credential slots.
const loadStuck = async () => {
  const [moments, renders, publishes, clips] = await Promise.all([
    newest('clip_moments', {
      download_status: 'eq.ERROR',
      select: 'clip_moment_id,suggested_title,source_video_url,start_sec,error_message,created_at',
    }),
    newest('render_jobs', {
      render_status: 'eq.FAILED',
      select: 'render_id,niche,error_message,warning_message,created_at',
    }),
    newest('publishing_jobs', {
      publish_status: 'in.(FAILED,AUTH_REQUIRED)',
      select: 'publish_id,platform,publish_status,last_error,retry_count,created_at,postiz_submitted_at,postiz_post_id',
    }),
    newest('created_clips', {
      review_status: 'in.(AWAITING_DOWNLOAD,NEEDS_RETRY)',
      select: 'created_clip_id,clip_title,review_status,created_at',
      order: 'created_at.asc',
    }),
  ]);
  return {
    moments: moments.rows,
    renders: renders.rows,
    publishes: publishes.rows,
    clips: clips.rows,
    totals: {
      moments: moments.total, renders: renders.total, publishes: publishes.total, clips: clips.total,
    },
  };
};

const loadPipeline = async () => {
  const [stages, channels, publishingChannels, leases, errorRows, throughput] = await Promise.all([
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
    db.select('clip_throughput_7d', {}),
  ]);
  return {
    stages,
    alarms: render.buildAlarms({ stages, channels, publishingChannels, leases }),
    errors: summarise.groupErrors(errorRows),
    throughput,
  };
};

const loadChannels = () =>
  db.select('source_channels', { order: 'niche.asc,priority.asc,source_name.asc', limit: '500' });

// ---------------------------------------------------------------------------
// GET routes
// ---------------------------------------------------------------------------

// PostgREST answers 400 to an offset of 1.5 or Infinity, so only a whole,
// finite, non-negative number gets through.
const offsetOf = (url) => {
  const offset = Math.floor(Number(url.searchParams.get('offset')));
  return Number.isFinite(offset) && offset > 0 ? offset : 0;
};

// counts may be the pending navCounts() promise; it never rejects.
const screen = async (title, current, body, counts) =>
  render.page({ title, body, counts: await counts, current });

const routes = {
  'GET /': async (url, counts) => {
    const offset = offsetOf(url);
    const { clips, total } = await loadClipQueue(offset);
    return screen('Clip review', '/', render.clipQueue(clips, {
      page: { offset, limit: PAGE_SIZE, total }, timeZone: TIME_ZONE,
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
    return screen('High-risk moments', '/moments', render.momentQueue(rows, {
      page: { offset, limit: PAGE_SIZE, total },
    }), counts);
  },

  'GET /held': async (url, counts) =>
    screen('Held', '/held', render.heldBoard(await loadHeld()), counts),

  'GET /stuck': async (url, counts) =>
    screen('Stuck', '/stuck', render.stuckBoard(await loadStuck()), counts),

  'GET /pipeline': async (url, counts) =>
    screen('Pipeline', '/pipeline', render.pipelineBoard(await loadPipeline()), counts),

  'GET /channels': async (url, counts) =>
    screen('Channels', '/channels', render.channelBoard({ channels: await loadChannels() }), counts),

  'GET /published': async (url, counts) => {
    const [jobs, credentials] = await Promise.all([
      newest('publishing_jobs', {
        publish_status: 'in.(PUBLISHED,DRAFT_UPLOADED)',
        select: 'publish_id,title,created_clip_id,niche,platform,completed_at,post_url,publish_status',
        order: 'completed_at.desc.nullslast',
      }),
      db.select('publishing_channels', {
        select: 'channel_id,platform,publishing_backend,enabled_status,last_health_status,token_expires_at',
        order: 'platform.asc',
        limit: '200',
      }),
    ]);
    return screen('Published', '/published', render.publishedBoard({
      jobs: jobs.rows, total: jobs.total, credentials,
    }), counts);
  },
};

// Permalinks, so an item can be linked to from the digest email, reopened
// after rejection, or looked at again once it has left its queue.
const permalinks = [
  [/^\/clips\/([^/]+)$/, async (id, counts) => {
    const clip = await db.selectOne('created_clips', { created_clip_id: `eq.${id}` });
    if (!clip) return null;
    const [withContext] = await withMomentContext([clip]);
    const body = clip.review_status === 'NEEDS_REVIEW'
      ? render.clipItem(withContext, { timeZone: TIME_ZONE })
      // Not in the queue any more, so show the record without a verdict form.
      : `<h1>${render.escapeHtml(clip.clip_title || clip.suggested_title || id)}</h1>
<p class="mute">This clip is ${render.escapeHtml(clip.review_status)}${
          clip.reviewer_notes ? `, noted: ${render.escapeHtml(clip.reviewer_notes)}` : ''}.</p>
${clip.review_status === 'REJECTED'
          ? render.postButton('/clips/reopen', 'created_clip_id', id, 'Reopen for review')
          : ''}`;
    return screen(clip.clip_title || 'Clip', '', body, counts);
  }],
  [/^\/moments\/([^/]+)$/, async (id, counts) => {
    const moment = await db.selectOne('clip_moments', { clip_moment_id: `eq.${id}` });
    if (!moment) return null;
    // The approve form only where approving can work: the write is guarded on
    // AWAITING_MANUAL_APPROVAL, and a button that silently does nothing is
    // worse than none. A failed download gets its retry instead.
    if (moment.download_status === 'AWAITING_MANUAL_APPROVAL') {
      return screen(moment.suggested_title || 'Moment', '', render.momentQueue([moment]), counts);
    }
    const title = moment.suggested_title || id;
    return screen(title, '', `<h1>${render.escapeHtml(title)}</h1>
<p class="mute">This moment is ${render.escapeHtml(render.humanEnum(moment.download_status) || 'unknown')}.</p>
${moment.error_message ? `<pre>${render.escapeHtml(render.redact(moment.error_message))}</pre>` : ''}
${moment.download_status === 'ERROR'
    ? render.postButton('/moments/retry', 'clip_moment_id', id, 'Retry download')
    : ''}`, counts);
  }],
];

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

// A failed validation re-renders the one clip the operator was working on,
// with their values and the errors in place. Re-rendering the queue instead
// loses them whenever the clip is on a later page or came from a permalink.
const reRenderClip = async (clipId, form, errors, counts) => {
  const clip = clipId
    ? await db.selectOne('created_clips', { created_clip_id: `eq.${clipId}`, review_status: 'eq.NEEDS_REVIEW' })
    : undefined;
  if (!clip) return nothingChanged('/', counts);
  const [withContext] = await withMomentContext([clip]);
  return {
    status: 400,
    body: await screen('Clip review', '/', `<h1>Fix and resubmit</h1>${
      render.clipItem(withContext, { values: form, errors, timeZone: TIME_ZONE })}`, counts),
  };
};

// Every write below is guarded on the state it expects, so a lost race — a
// workflow got there first, a second tab, a double submit — matches no row.
// PostgREST reports that as success; the operator is told instead.
async function nothingChanged(back, counts) {
  return {
    status: 409,
    body: await screen('Nothing changed', '', `<h1>Nothing changed</h1>
<p>That item is no longer in the state this button acts on, or it no longer exists. A workflow or another tab may have got there first. Nothing was done.</p>
<p><a href="${render.escapeHtml(back)}">Back</a></p>`, counts),
  };
}

const guardedPatch = async (table, filter, body, back, counts) => {
  const rows = await db.patch(table, filter, body);
  return rows.length ? { redirect: back } : nothingChanged(back, counts);
};

const writes = {
  'POST /clips/approve': async (form, counts) => {
    const { values, errors, form: typed } = render.parseApproveForm(form, { timeZone: TIME_ZONE });
    if (Object.keys(errors).length) return reRenderClip(values.p_created_clip_id, typed, errors, counts);
    await db.rpc('approve_clip', values);
    return { redirect: '/' };
  },

  'POST /clips/reject': async (form, counts) => {
    const { values, errors, form: typed } = render.parseRejectForm(form);
    if (Object.keys(errors).length) return reRenderClip(values.p_created_clip_id, typed, errors, counts);
    await db.rpc('reject_clip', values);
    return { redirect: '/' };
  },

  // Rejecting only sets a status — no Drive file and no render is removed — and
  // approve_clip already demands NEEDS_REVIEW, so putting a clip back is a
  // single-table write that needs no new function. The reject note goes with
  // it: approve_clip keeps old notes when given none, so a reopened clip that
  // is then approved would still read "WRONG_CUT — ..." in the reason counts.
  'POST /clips/reopen': async (form, counts) => guardedPatch('created_clips', {
    created_clip_id: `eq.${form.get('created_clip_id')}`,
    review_status: 'eq.REJECTED',
  }, { review_status: 'NEEDS_REVIEW', reviewer_notes: null }, '/held', counts),

  'POST /moments/approve': async (form, counts) => guardedPatch('clip_moments', {
    clip_moment_id: `eq.${form.get('clip_moment_id')}`,
    download_status: 'eq.AWAITING_MANUAL_APPROVAL',
  }, { download_status: 'PENDING' }, '/moments', counts),

  'POST /moments/retry': async (form, counts) => guardedPatch('clip_moments', {
    clip_moment_id: `eq.${form.get('clip_moment_id')}`,
    download_status: 'eq.ERROR',
  }, { download_status: 'PENDING', error_message: null }, '/stuck', counts),

  'POST /renders/retry': async (form, counts) => guardedPatch('render_jobs', {
    render_id: `eq.${form.get('render_id')}`,
    render_status: 'eq.FAILED',
  }, { render_status: 'PENDING', error_message: null }, '/stuck', counts),

  // Back to PENDING rather than clearing the history: retry_count and
  // last_error are what WF14's backoff reads, and losing them would make a
  // job that has failed six times look new. claimed_by is NULL, not '':
  // migration 009 retired the empty-string convention. A job Postiz may
  // already have posted is refused here as well as hidden on /stuck, since the
  // submit guard would only loop it through claim and lease expiry.
  'POST /publishes/retry': async (form, counts) => guardedPatch('publishing_jobs', {
    publish_id: `eq.${form.get('publish_id')}`,
    publish_status: 'in.(FAILED,AUTH_REQUIRED)',
    postiz_submitted_at: 'is.null',
    postiz_post_id: 'is.null',
  }, {
    publish_status: 'PENDING', next_retry_at: null, claimed_at: null, claimed_by: null, lease_expires_at: null,
  }, '/stuck', counts),

  // The override. WF3 skips anything whose validity_status is already set, so
  // clearing it would only have the same rule reject the video again. Marking
  // it VALID instead sends it straight to WF4, which is what "I disagree with
  // the gate" has to mean. transcript_available is cleared because WF4's own
  // filter wants it unset. The gate's reason is kept, marked as overridden, so
  // the record still says a person pushed this one past a rule.
  'POST /held/release': async (form, counts) => {
    const videoId = form.get('video_id');
    const video = await db.selectOne('candidate_videos', {
      video_id: `eq.${videoId}`,
      validity_status: 'in.(FLAGGED,REJECTED)',
      select: 'video_id,validity_status,rejection_reason',
    });
    if (!video) return nothingChanged('/held', counts);
    const reason = String(video.rejection_reason || '');
    return guardedPatch('candidate_videos', {
      video_id: `eq.${videoId}`,
      validity_status: `eq.${video.validity_status}`,
    }, {
      validity_status: 'VALID',
      rejection_reason: `OVERRIDDEN${reason ? `: ${reason}` : ''}`,
      transcript_available: null,
      processing_status: 'NEW',
    }, '/held', counts);
  },

  'POST /channels': async (form, counts) => {
    const { values, errors } = render.parseChannelForm(form);
    if (Object.keys(errors).length) {
      return {
        status: 400,
        body: await screen('Channels', '/channels',
          render.channelBoard({ channels: await loadChannels(), values, errors }), counts),
      };
    }
    await db.insert('source_channels', values);
    return { redirect: '/channels' };
  },

  // Reactivating clears the auto-pause as well as the flag, otherwise the
  // channel shows as paused for ever and WF5's health check has nothing to
  // re-pause it from.
  'POST /channels/activate': async (form, counts) => guardedPatch('source_channels',
    { source_id: `eq.${form.get('source_id')}` }, {
      active_status: true,
      auto_paused_at: null,
      auto_paused_reason: null,
      health_reset_at: new Date().toISOString(),
    }, '/channels', counts),

  'POST /channels/deactivate': async (form, counts) => guardedPatch('source_channels',
    { source_id: `eq.${form.get('source_id')}` }, { active_status: false }, '/channels', counts),

  'POST /channels/priority': async (form, counts) => {
    const { errors, source_id: sourceId, priority } = render.parsePriorityForm(form);
    if (Object.keys(errors).length) {
      return {
        status: 400,
        body: await screen('Channels', '/channels',
          render.channelBoard({ channels: await loadChannels(), errors }), counts),
      };
    }
    return guardedPatch('source_channels', { source_id: `eq.${sourceId}` }, { priority }, '/channels', counts);
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
      const counts = navCounts();
      if (routes[key]) return html(response, 200, await routes[key](url, counts));
      for (const [pattern, handler] of permalinks) {
        const match = pattern.exec(url.pathname);
        if (!match) continue;
        // A malformed escape such as %E0 is a bad link, not a server fault.
        let id;
        try { id = decodeURIComponent(match[1]); } catch { id = null; }
        const body = id === null ? null : await handler(id, counts);
        if (body) return html(response, 200, body);
        return html(response, 404, render.page({
          title: 'Not found', counts: await counts,
          body: '<h1>Not found</h1><p>No record with that id. It may have been renamed by a backfill.</p>',
        }));
      }
    }

    if (writes[key]) {
      // Only the error pages use it, so it is not awaited unless one renders.
      const counts = navCounts();
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

// Exported so the guards and the handlers are testable without binding a port
// or reaching Supabase (tests replace the postgrest functions); only a direct
// run starts listening.
module.exports = {
  server, sameOrigin, hostAllowed, hostnameOf, offsetOf, routes, permalinks, writes, SECURITY_HEADERS,
};

if (require.main === module) {
  server.listen(PORT, BIND, () => console.log(`review ui on http://${BIND}:${PORT}`));
}
