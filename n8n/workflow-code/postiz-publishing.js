// Pure contracts shared by generated n8n nodes and local regression tests.
// No network or credentials here: HTTP nodes own those boundaries.
const POSTIZ_PROVIDERS = {
  YOUTUBE_SHORTS: 'youtube', FACEBOOK_REELS: 'facebook',
  INSTAGRAM_REELS: 'instagram', TIKTOK: 'tiktok',
};

function postizText(value) { return typeof value === 'string' ? value.trim() : ''; }

function postizHttps(value) {
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && !u.username && !u.password && (!u.port || u.port === '443');
  } catch { return false; }
}

function postizVideoUrl(value) {
  return postizHttps(value) && new URL(value).pathname.toLowerCase().endsWith('.mp4');
}

function postizResponseBody(response) {
  if (response?.statusCode && (response.statusCode < 200 || response.statusCode >= 300)) {
    throw new Error('POSTIZ_HTTP_' + response.statusCode);
  }
  return response?.body === undefined ? response : response.body;
}

function validatePostizJob(job) {
  const fail = (reason) => ({ ready: false, reason, route: 'SKIP' });
  if (job.publishing_backend !== 'POSTIZ') return fail('POSTIZ_BACKEND_REQUIRED');
  if (!POSTIZ_PROVIDERS[job.platform]) return fail('POSTIZ_UNSUPPORTED_PLATFORM');
  if (!postizText(job.postiz_integration_id)) return fail('POSTIZ_INTEGRATION_REQUIRED');
  const stage = postizText(job.provider_stage);
  // Reconciliation does not depend on media still existing or a new approval.
  if (stage === 'POSTIZ_SUBMITTED' && postizText(job.postiz_post_id)) {
    if (!Number.isFinite(Date.parse(job.postiz_submitted_at))) return fail('POSTIZ_INTENT_TIME_REQUIRED');
    return { ready: true, route: 'POSTIZ_POLL' };
  }
  if (stage === 'POSTIZ_SUBMIT_REQUESTED' || postizText(job.postiz_post_id)) {
    return { ready: true, route: 'AMBIGUOUS' };
  }
  if (!['', 'POSTIZ_MEDIA_READY'].includes(stage)) return fail('POSTIZ_UNSUPPORTED_CHECKPOINT');
  if (!['APPROVED_PUBLIC', 'DEV_PRIVATE_ONLY'].includes(job.audit_status)) return fail('POSTIZ_APPROVAL_REQUIRED');
  if (job.credential_slot !== 'POSTIZ_PRIMARY') return fail('POSTIZ_CREDENTIAL_SLOT_REQUIRED');
  if (!postizHttps(job.public_video_url)) return fail('POSTIZ_PUBLIC_HTTPS_VIDEO_REQUIRED');
  if (job.platform === 'YOUTUBE_SHORTS') {
    if (!['private', 'unlisted', 'public'].includes(job.default_privacy)) return fail('POSTIZ_INVALID_YOUTUBE_PRIVACY');
    if (job.audit_status === 'DEV_PRIVATE_ONLY' && job.default_privacy !== 'private') return fail('POSTIZ_PRIVATE_ONLY');
    if (postizText(job.title).length < 2 || job.title.length > 100) return fail('POSTIZ_YOUTUBE_TITLE_LENGTH');
  }
  if (['FACEBOOK_REELS', 'INSTAGRAM_REELS'].includes(job.platform) &&
      (job.audit_status !== 'APPROVED_PUBLIC' || job.default_privacy !== 'public')) {
    return fail('POSTIZ_META_PUBLIC_APPROVAL_REQUIRED');
  }
  if (job.platform === 'TIKTOK' && (job.tiktok_mode !== 'DRAFT' || ![true, 'TRUE'].includes(job.requires_manual_publish))) {
    return fail('POSTIZ_TIKTOK_INBOX_ONLY');
  }
  if (stage === 'POSTIZ_MEDIA_READY' && (!postizText(job.postiz_media_id) || !postizVideoUrl(job.postiz_media_path))) {
    return fail('POSTIZ_INVALID_MEDIA_CHECKPOINT');
  }
  return { ready: true, route: 'POSTIZ_PREPARE' };
}

function confirmPostizIntegration(job, response) {
  const body = postizResponseBody(response);
  if (!Array.isArray(body)) throw new Error('POSTIZ_INVALID_INTEGRATIONS_RESPONSE');
  const matches = body.filter((item) => item.id === job.postiz_integration_id);
  if (matches.length !== 1 || matches[0].identifier !== POSTIZ_PROVIDERS[job.platform] ||
      matches[0].disabled !== false) throw new Error('POSTIZ_INTEGRATION_MISMATCH_OR_DISABLED');
  return job;
}

function parsePostizMedia(response) {
  const body = postizResponseBody(response);
  // Postiz's Meta providers select video vs image by the stored path extension.
  if (!postizText(body?.id) || !postizVideoUrl(body?.path)) throw new Error('POSTIZ_INVALID_MP4_MEDIA_RESPONSE');
  return { postiz_media_id: body.id, postiz_media_path: body.path };
}

function buildPostizPayload(job, now = new Date()) {
  const validation = validatePostizJob(job);
  if (!validation.ready || validation.route !== 'POSTIZ_PREPARE' || job.provider_stage !== 'POSTIZ_MEDIA_READY') {
    throw new Error(validation.reason || 'POSTIZ_MEDIA_NOT_READY');
  }
  const settings = { __type: POSTIZ_PROVIDERS[job.platform] };
  if (job.platform === 'YOUTUBE_SHORTS') Object.assign(settings, {
    title: job.title, type: job.default_privacy, selfDeclaredMadeForKids: 'no',
    tags: postizText(job.hashtags).replace(/#/g, '').split(/\s+/).filter(Boolean).map((value) => ({ value, label: value })),
  });
  if (job.platform === 'INSTAGRAM_REELS') Object.assign(settings, { post_type: 'post', collaborators: [] });
  if (job.platform === 'TIKTOK') Object.assign(settings, {
    title: postizText(job.title).slice(0, 90), privacy_level: 'SELF_ONLY', duet: false,
    stitch: false, comment: false, autoAddMusic: 'no', brand_content_toggle: false,
    brand_organic_toggle: false, content_posting_method: 'UPLOAD',
  });
  return {
    type: 'now', date: now.toISOString(), shortLink: false, tags: [],
    posts: [{ integration: { id: job.postiz_integration_id }, settings,
      value: [{ content: postizText(job.caption) || postizText(job.description) || job.title,
        image: [{ id: job.postiz_media_id, path: job.postiz_media_path }] }] }],
  };
}

function parsePostizSubmission(job, response) {
  const body = postizResponseBody(response);
  if (!Array.isArray(body) || body.length !== 1 || !postizText(body[0]?.postId) ||
      body[0].integration !== job.postiz_integration_id) throw new Error('POSTIZ_AMBIGUOUS_SUBMISSION_RESPONSE');
  return { postiz_post_id: body[0].postId };
}

function postizPollWindow(job, now = new Date()) {
  const start = Date.parse(job.postiz_submitted_at);
  if (!Number.isFinite(start)) throw new Error('POSTIZ_INTENT_TIME_REQUIRED');
  return { startDate: new Date(start - 86400000).toISOString(), endDate: new Date(Math.max(start, now.getTime()) + 86400000).toISOString() };
}

function postizReleaseUrl(platform, value) {
  if (!postizHttps(value)) return false;
  const u = new URL(value);
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  if (platform === 'YOUTUBE_SHORTS') return (host === 'youtube.com' &&
    ((u.pathname === '/watch' && /^[\w-]+$/.test(u.searchParams.get('v') || '')) || /^\/shorts\/[\w-]+\/?$/.test(u.pathname))) ||
    (host === 'youtu.be' && /^\/[\w-]+\/?$/.test(u.pathname));
  if (platform === 'FACEBOOK_REELS') return host === 'facebook.com' && u.pathname.length > 1;
  if (platform === 'INSTAGRAM_REELS') return host === 'instagram.com' && /^\/(reel|p|tv)\//.test(u.pathname);
  return false;
}

function interpretPostizStatus(job, response) {
  const body = postizResponseBody(response);
  if (!body || !Array.isArray(body.posts)) throw new Error('POSTIZ_INVALID_POST_LIST');
  const matches = body.posts.filter((post) => post.id === job.postiz_post_id);
  if (matches.length === 0) return { action: 'POLL', reason: 'POSTIZ_POST_NOT_VISIBLE' };
  if (matches.length !== 1) return { action: 'FAIL', outcome: 'FAILED', error: 'POSTIZ_DUPLICATE_POST_ID' };
  const post = matches[0];
  if (post.integration?.id !== job.postiz_integration_id || post.integration?.providerIdentifier !== POSTIZ_PROVIDERS[job.platform]) {
    return { action: 'FAIL', outcome: 'FAILED', error: 'POSTIZ_POST_IDENTITY_MISMATCH' };
  }
  if (post.state === 'QUEUE') return { action: 'POLL', reason: 'POSTIZ_QUEUED' };
  if (post.state !== 'PUBLISHED') return { action: 'FAIL', outcome: 'FAILED', error: 'POSTIZ_REQUIRES_REVIEW:' + postizText(post.state) };
  if (job.platform === 'TIKTOK') {
    let settings = post.settings;
    // Some self-hosted versions return the Prisma JSON string unchanged.
    if (typeof settings === 'string') {
      try { settings = JSON.parse(settings); } catch { settings = null; }
    }
    if (settings?.content_posting_method !== 'UPLOAD') return { action: 'FAIL', outcome: 'FAILED', error: 'POSTIZ_TIKTOK_MODE_MISMATCH' };
    return { action: 'COMPLETE', outcome: 'DRAFT_UPLOADED', post_id: '', post_url: '' };
  }
  if (!postizReleaseUrl(job.platform, post.releaseURL)) return { action: 'POLL', reason: 'POSTIZ_RELEASE_URL_UNCONFIRMED' };
  return { action: 'COMPLETE', outcome: 'PUBLISHED', post_id: postizText(post.releaseId) === 'missing' ? '' : postizText(post.releaseId), post_url: post.releaseURL };
}

module.exports = {
  validatePostizJob, confirmPostizIntegration, parsePostizMedia, buildPostizPayload,
  parsePostizSubmission, postizPollWindow, interpretPostizStatus, postizReleaseUrl,
};
