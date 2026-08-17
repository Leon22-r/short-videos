const PLATFORM_STATUSES = new Set([
  'PENDING',
  'CLAIMED',
  'UPLOADING',
  'PROCESSING',
  'PUBLISHED',
  'RETRY_PENDING',
  'AUTH_REQUIRED',
  'REJECTED',
  'FAILED',
  'DRAFT_UPLOADED',
  'SKIPPED',
]);

const PLATFORMS = [
  'YOUTUBE_SHORTS',
  'FACEBOOK_REELS',
  'INSTAGRAM_REELS',
  'TIKTOK',
];

const MAX_RETRY_ATTEMPTS = 4;
const DEFAULT_LEASE_MINUTES = 30;
const DEFAULT_PROVIDER_POLL_MINUTES = 2;

const CREDENTIAL_SLOTS = {
  YOUTUBE_SHORTS: 'YOUTUBE_PRIMARY',
  FACEBOOK_REELS: 'FACEBOOK_PRIMARY',
  INSTAGRAM_REELS: 'INSTAGRAM_PRIMARY',
  TIKTOK: 'TIKTOK_PRIMARY',
};

function active(row) {
  return ['true', 'active', 'yes', '1', 'enabled'].includes(String(row.enabled_status || row.active_status || '').trim().toLowerCase());
}

function clean(value, limit = 2000) {
  if (value === null || value === undefined) return '';
  return String(value).trim().slice(0, limit);
}

function nowIso(now = new Date()) {
  return now instanceof Date ? now.toISOString() : String(now);
}

function normalizePlatform(platform) {
  const value = clean(platform).toUpperCase();
  if (value === 'YOUTUBE') return 'YOUTUBE_SHORTS';
  if (value === 'FACEBOOK') return 'FACEBOOK_REELS';
  if (value === 'INSTAGRAM') return 'INSTAGRAM_REELS';
  if (value === 'TIKTOK_DRAFT') return 'TIKTOK';
  return value;
}

function normalizeStatus(status) {
  const value = clean(status).toUpperCase();
  return PLATFORM_STATUSES.has(value) ? value : '';
}

function splitPlatforms(value) {
  if (!clean(value)) return [];
  const platforms = String(value)
    .split(/[,\n|]/)
    .map(normalizePlatform)
    .filter(Boolean)
    .filter((platform) => PLATFORMS.includes(platform));
  return [...new Set(platforms)];
}

function truthy(value) {
  return ['true', 'yes', '1', 'enabled'].includes(clean(value).toLowerCase());
}

function destinationIdFor(channel, platform) {
  const fields = {
    YOUTUBE_SHORTS: 'youtube_channel_id',
    FACEBOOK_REELS: 'facebook_page_id',
    INSTAGRAM_REELS: 'instagram_user_id',
    TIKTOK: 'tiktok_open_id',
  };
  return clean(channel?.[fields[platform]]);
}

function channelCanPublish(channel, platform) {
  const auditStatus = clean(channel.audit_status).toUpperCase();
  if (!['APPROVED_PUBLIC', 'DEV_PRIVATE_ONLY'].includes(auditStatus)) return false;
  if (!clean(channel.channel_id) || !destinationIdFor(channel, platform)) return false;
  if (truthy(channel.requires_manual_publish) && platform !== 'TIKTOK') return false;
  return true;
}

function validHttpsUrl(value) {
  try {
    const url = new URL(clean(value, 4000));
    return url.protocol === 'https:' && !url.username && !url.password && (!url.port || url.port === '443');
  } catch {
    return false;
  }
}

function urlWithinVerifiedPrefix(value, prefixValue) {
  try {
    const url = new URL(clean(value, 4000));
    const prefix = new URL(clean(prefixValue, 4000));
    if (!validHttpsUrl(url.toString()) || !validHttpsUrl(prefix.toString())) return false;
    if (prefix.search || prefix.hash || url.origin !== prefix.origin) return false;
    const prefixPath = prefix.pathname || '/';
    if (prefixPath === '/') return true;
    if (prefixPath.endsWith('/')) return url.pathname.startsWith(prefixPath);
    return url.pathname === prefixPath || url.pathname.startsWith(`${prefixPath}/`);
  } catch {
    return false;
  }
}

function validateProviderJob(job) {
  const platform = normalizePlatform(job?.platform);
  if (!PLATFORMS.includes(platform)) return { ready: false, reason: `UNSUPPORTED_PLATFORM:${platform || 'UNKNOWN'}` };

  const destinationId = destinationIdFor(job, platform);
  if (!destinationId) {
    const fields = {
      YOUTUBE_SHORTS: 'youtube_channel_id',
      FACEBOOK_REELS: 'facebook_page_id',
      INSTAGRAM_REELS: 'instagram_user_id',
      TIKTOK: 'tiktok_open_id',
    };
    return { ready: false, reason: `MISSING_DESTINATION_ID:${fields[platform]}` };
  }

  const expectedSlot = CREDENTIAL_SLOTS[platform];
  const credentialSlot = clean(job?.credential_slot).toUpperCase();
  if (credentialSlot !== expectedSlot) {
    return { ready: false, reason: `UNBOUND_CREDENTIAL_SLOT:${expectedSlot}` };
  }

  if (platform === 'YOUTUBE_SHORTS' && !clean(job?.local_file_path, 4000)) {
    return { ready: false, reason: 'LOCAL_VIDEO_REQUIRED:YOUTUBE_SHORTS' };
  }

  if (platform === 'FACEBOOK_REELS' || platform === 'INSTAGRAM_REELS') {
    if (!/^v\d+\.\d+$/.test(clean(job?.meta_graph_version))) {
      return { ready: false, reason: 'META_GRAPH_VERSION_REQUIRED' };
    }
    if (!validHttpsUrl(job?.public_video_url)) {
      return { ready: false, reason: `PUBLIC_HTTPS_VIDEO_REQUIRED:${platform}` };
    }
  }

  if (platform === 'INSTAGRAM_REELS') {
    const host = clean(job?.instagram_graph_host).toLowerCase();
    if (!['graph.facebook.com', 'graph.instagram.com'].includes(host)) {
      return { ready: false, reason: 'INVALID_INSTAGRAM_GRAPH_HOST' };
    }
  }

  if (platform === 'TIKTOK') {
    if (clean(job?.tiktok_mode).toUpperCase() !== 'DRAFT') {
      return { ready: false, reason: 'TIKTOK_DIRECT_REQUIRES_CREATOR_UI_AND_CONSENT' };
    }
    if (!truthy(job?.tiktok_domain_verified)) {
      return { ready: false, reason: 'TIKTOK_VERIFIED_DOMAIN_REQUIRED' };
    }
    if (!validHttpsUrl(job?.public_video_url)) {
      return { ready: false, reason: 'PUBLIC_HTTPS_VIDEO_REQUIRED:TIKTOK' };
    }
    const verifiedPrefix = clean(job?.tiktok_verified_url_prefix, 4000);
    if (!urlWithinVerifiedPrefix(job?.public_video_url, verifiedPrefix)) {
      return { ready: false, reason: 'TIKTOK_VIDEO_URL_OUTSIDE_VERIFIED_PREFIX' };
    }
  }

  return { ready: true, reason: '', platform, destination_id: destinationId };
}

function normalizeHashtags(value) {
  if (!value) return '';
  if (Array.isArray(value)) return value.map((tag) => clean(tag).replace(/^#?/, '#')).filter((tag) => tag !== '#').join(' ');
  return String(value)
    .split(/[\s,\n]+/)
    .map((tag) => clean(tag).replace(/^#?/, '#'))
    .filter((tag) => tag !== '#')
    .join(' ');
}

function titleFor(row) {
  return clean(row.final_title || row.suggested_title || row.clip_title || row.created_clip_id, 100);
}

function captionFor(row) {
  const caption = clean(row.final_caption || row.suggested_caption || row.final_description || '', 1800);
  const hashtags = normalizeHashtags(row.hashtags);
  if (!hashtags) return caption;
  if (!caption) return hashtags;
  return `${caption}\n\n${hashtags}`.slice(0, 2200);
}

function renderReady(render) {
  return clean(render.render_status).toUpperCase() === 'COMPLETED' && (render.final_drive_file_id || render.final_drive_url || render.final_local_path);
}

function jobKey(row) {
  return `${clean(row.render_id)}::${normalizePlatform(row.platform)}::${clean(row.channel_id)}`;
}

function buildPublishingJobs(approvedRows, renderRows, createdRows, channelRows, existingJobs, now = new Date()) {
  const timestamp = nowIso(now);
  const rendersById = Object.fromEntries((renderRows || []).map((row) => [clean(row.render_id), row]));
  const createdById = Object.fromEntries((createdRows || []).map((row) => [clean(row.created_clip_id), row]));
  const existingKeys = new Set((existingJobs || []).map(jobKey));
  const channels = (channelRows || []).filter(active);
  const out = [];

  for (const approved of approvedRows || []) {
    const status = clean(approved.status).toUpperCase();
    if (!['APPROVED', 'READY'].includes(status)) continue;

    const created = createdById[clean(approved.created_clip_id)] || {};
    const renderId = clean(approved.render_id || created.render_id || `RENDER_${approved.created_clip_id}`);
    const render = rendersById[renderId] || {};
    if (!renderReady(render)) continue;

    const niche = clean(approved.niche || render.niche || created.niche);
    const requestedPlatforms = splitPlatforms(approved.platform);
    for (const platform of requestedPlatforms) {
      const matchingChannels = channels.filter((channel) => {
        if (normalizePlatform(channel.platform) !== platform) return false;
        if (clean(channel.niche) && clean(channel.niche) !== niche) return false;
        return channelCanPublish(channel, platform);
      });

      for (const channel of matchingChannels) {
        const channelId = clean(channel.channel_id);
        const destinationId = destinationIdFor(channel, platform);
        const requiresManualPublish = truthy(channel.requires_manual_publish);
        const auditStatus = clean(channel.audit_status).toUpperCase();
        const row = {
          publish_id: `PUB_${renderId}_${platform}_${channelId}`,
          approved_id: clean(approved.approved_id),
          render_id: renderId,
          created_clip_id: clean(approved.created_clip_id),
          niche,
          platform,
          channel_id: channelId,
          destination_id: destinationId,
          youtube_channel_id: clean(channel.youtube_channel_id),
          facebook_page_id: clean(channel.facebook_page_id),
          instagram_user_id: clean(channel.instagram_user_id),
          tiktok_open_id: clean(channel.tiktok_open_id),
          credential_slot: clean(channel.credential_slot).toUpperCase() || CREDENTIAL_SLOTS[platform],
          meta_graph_version: clean(channel.meta_graph_version),
          instagram_graph_host: clean(channel.instagram_graph_host).toLowerCase() || 'graph.facebook.com',
          tiktok_domain_verified: truthy(channel.tiktok_domain_verified) ? 'TRUE' : 'FALSE',
          tiktok_verified_url_prefix: clean(channel.tiktok_verified_url_prefix, 4000),
          default_privacy: auditStatus === 'DEV_PRIVATE_ONLY'
            ? (platform === 'TIKTOK' ? 'SELF_ONLY' : 'private')
            : clean(channel.default_privacy) || (platform === 'TIKTOK' ? 'SELF_ONLY' : 'private'),
          requires_manual_publish: requiresManualPublish ? 'TRUE' : 'FALSE',
          audit_status: auditStatus,
          tiktok_mode: platform === 'TIKTOK' && requiresManualPublish ? 'DRAFT' : 'DIRECT',
          video_source: render.final_local_path ? 'LOCAL_FILE' : 'DRIVE',
          video_file_id: clean(render.final_drive_file_id),
          video_url: clean(render.final_drive_url),
          public_video_url: clean(approved.public_video_url || render.public_video_url, 4000),
          local_file_path: clean(render.final_local_path),
          title: titleFor({ ...created, ...approved }),
          caption: captionFor({ ...created, ...approved }),
          description: clean(approved.final_description || created.suggested_caption || approved.final_caption, 4000),
          hashtags: normalizeHashtags(approved.hashtags || created.hashtags),
          scheduled_at: clean(approved.scheduled_date || approved.scheduled_at),
          publish_status: 'PENDING',
          retry_count: clean(approved.retry_count) || '0',
          next_retry_at: '',
          last_error: '',
          post_id: '',
          post_url: '',
          claimed_at: '',
          claimed_by: '',
          lease_expires_at: '',
          created_at: timestamp,
          updated_at: timestamp,
        };
        if (!existingKeys.has(jobKey(row))) {
          existingKeys.add(jobKey(row));
          out.push(row);
        }
      }
    }
  }

  return out;
}

function providerPollUpdate(job, providerStage, providerRef, providerResponse = {}, now = new Date(), minutes = DEFAULT_PROVIDER_POLL_MINUTES) {
  const timestamp = nowIso(now);
  const pollMinutes = Number(minutes);
  const safeMinutes = Number.isFinite(pollMinutes) && pollMinutes > 0 ? Math.min(pollMinutes, 60) : DEFAULT_PROVIDER_POLL_MINUTES;
  return {
    publish_id: clean(job?.publish_id),
    claimed_by: clean(job?.claimed_by),
    publish_status: 'PROCESSING',
    provider_stage: clean(providerStage),
    provider_ref: clean(providerRef, 1000),
    provider_response: JSON.stringify(providerResponse || {}),
    poll_after: new Date(Date.parse(timestamp) + safeMinutes * 60000).toISOString(),
    updated_at: timestamp,
  };
}

function interpretYouTubeStatus(response = {}) {
  const item = Array.isArray(response.items) ? response.items[0] : null;
  if (!item) return { outcome: 'FAILED', error: 'YouTube status response did not contain the uploaded video' };
  const processing = clean(item.processingDetails?.processingStatus).toLowerCase();
  const upload = clean(item.status?.uploadStatus).toLowerCase();
  if (processing === 'succeeded' && upload === 'processed') {
    return { outcome: 'PUBLISHED', post_id: clean(item.id), post_url: `https://www.youtube.com/watch?v=${clean(item.id)}` };
  }
  if (processing === 'failed' || ['failed', 'rejected', 'deleted'].includes(upload)) {
    const reason = item.processingDetails?.processingFailureReason || item.status?.failureReason || item.status?.rejectionReason || `${processing}/${upload}`;
    return { outcome: upload === 'rejected' ? 'REJECTED' : 'FAILED', error: `YouTube processing failed: ${clean(reason)}` };
  }
  if (processing === 'terminated') return { outcome: 'FAILED', error: 'YouTube processing status terminated without success' };
  return { outcome: 'PROCESSING' };
}

function interpretFacebookStatus(response = {}) {
  const status = response.status || {};
  const phases = [status.uploading_phase, status.processing_phase, status.publishing_phase].filter(Boolean);
  const failed = phases.find((phase) => clean(phase.status).toLowerCase() === 'error' || (Array.isArray(phase.errors) && phase.errors.length));
  if (failed) return { outcome: 'FAILED', error: `Facebook Reel failed: ${clean(JSON.stringify(failed.errors || failed))}` };
  if (clean(status.publishing_phase?.status).toLowerCase() === 'complete') {
    const id = clean(response.id || response.video_id);
    return { outcome: 'PUBLISHED', post_id: id, post_url: clean(response.permalink_url || response.permalink) };
  }
  return { outcome: 'PROCESSING' };
}

function interpretInstagramContainerStatus(response = {}) {
  const status = clean(response.status_code).toUpperCase();
  if (status === 'FINISHED') return { outcome: 'READY_TO_PUBLISH', container_id: clean(response.id) };
  if (status === 'PUBLISHED') return { outcome: 'PUBLISHED', container_id: clean(response.id) };
  if (status === 'ERROR' || status === 'EXPIRED') return { outcome: 'FAILED', error: `Instagram container ${status}: ${clean(response.status)}` };
  return { outcome: 'PROCESSING' };
}

function interpretTikTokStatus(response = {}, providerRef = '') {
  const data = response.data || {};
  const status = clean(data.status).toUpperCase();
  if (status === 'SEND_TO_USER_INBOX') {
    return { outcome: 'DRAFT_UPLOADED', post_id: '' };
  }
  if (status === 'PUBLISH_COMPLETE') {
    const publicIds = Array.isArray(data.publicaly_available_post_id) ? data.publicaly_available_post_id : [];
    return { outcome: 'PUBLISHED', post_id: clean(publicIds[0]) };
  }
  if (status === 'FAILED') return { outcome: 'FAILED', error: `TikTok processing failed: ${clean(data.fail_reason || response.error?.message)}` };
  return { outcome: 'PROCESSING' };
}

function parseDueAt(value) {
  if (!clean(value)) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function scheduleIsDue(row, current) {
  const scheduledAt = parseDueAt(row.scheduled_at);
  return scheduledAt === null || (Number.isFinite(scheduledAt) && scheduledAt <= current);
}

function leaseIsStale(row, current, staleClaimMinutes = DEFAULT_LEASE_MINUTES) {
  const explicitExpiry = parseDueAt(row.lease_expires_at);
  if (Number.isFinite(explicitExpiry)) return explicitExpiry <= current;

  const claimedAt = parseDueAt(row.claimed_at || row.started_at || row.updated_at);
  if (!Number.isFinite(claimedAt)) return false;
  const minutes = Number(staleClaimMinutes);
  const staleAfterMs = (Number.isFinite(minutes) && minutes > 0 ? minutes : DEFAULT_LEASE_MINUTES) * 60000;
  return claimedAt + staleAfterMs <= current;
}

function pickNextPublishJob(rows, now = new Date(), options = {}) {
  const current = Date.parse(nowIso(now));
  if (!Number.isFinite(current)) return null;
  return (rows || [])
    .filter((row) => {
      const status = normalizeStatus(row.publish_status);
      if (!scheduleIsDue(row, current)) return false;
      if (status === 'PENDING') return true;
      if (status === 'CLAIMED' || status === 'UPLOADING') {
        return leaseIsStale(row, current, options.staleClaimMinutes);
      }
      if (status !== 'RETRY_PENDING') return false;
      if (retryCountOf(row.retry_count) >= MAX_RETRY_ATTEMPTS) return false;
      if (!row.next_retry_at) return true;
      const retryAt = Date.parse(row.next_retry_at);
      return Number.isFinite(retryAt) && retryAt <= current;
    })
    .sort((a, b) => {
      const aDue = parseDueAt(a.scheduled_at) ?? parseDueAt(a.created_at) ?? 0;
      const bDue = parseDueAt(b.scheduled_at) ?? parseDueAt(b.created_at) ?? 0;
      return aDue - bDue || clean(a.created_at).localeCompare(clean(b.created_at));
    })[0] || null;
}

function buildPublishClaim(job, claimedBy, now = new Date(), leaseMinutes = DEFAULT_LEASE_MINUTES) {
  const publishId = clean(job?.publish_id);
  const worker = clean(claimedBy, 200);
  if (!publishId) throw new Error('Cannot claim a publishing job without publish_id');
  if (!worker) throw new Error('Cannot claim a publishing job without claimed_by');

  const timestamp = nowIso(now);
  const current = Date.parse(timestamp);
  if (!Number.isFinite(current)) throw new Error('Cannot claim a publishing job with an invalid timestamp');
  const requestedLease = Number(leaseMinutes);
  const safeLeaseMinutes = Number.isFinite(requestedLease) && requestedLease > 0
    ? Math.min(requestedLease, 1440)
    : DEFAULT_LEASE_MINUTES;

  return {
    ...job,
    publish_status: 'CLAIMED',
    claimed_at: timestamp,
    claimed_by: worker,
    lease_expires_at: new Date(current + safeLeaseMinutes * 60000).toISOString(),
    updated_at: timestamp,
  };
}

function buildPublishAttempt(job, now = new Date()) {
  const platform = normalizePlatform(job.platform);
  const timestamp = nowIso(now);
  const title = clean(job.title || job.created_clip_id, 100);
  const caption = clean(job.caption || job.description, 2200);
  const visibility = clean(job.default_privacy) || (platform === 'TIKTOK' ? 'SELF_ONLY' : 'private');

  return {
    ...job,
    platform,
    publish_status: 'UPLOADING',
    started_at: timestamp,
    updated_at: timestamp,
    title,
    caption,
    youtube_metadata: JSON.stringify({
      snippet: {
        title,
        description: caption,
        tags: normalizeHashtags(job.hashtags).replace(/#/g, '').split(/\s+/).filter(Boolean),
        categoryId: '22',
      },
      status: {
        privacyStatus: platform === 'YOUTUBE_SHORTS' ? visibility : 'private',
        selfDeclaredMadeForKids: false,
      },
    }),
    facebook_metadata: JSON.stringify({ description: caption }),
    instagram_metadata: JSON.stringify({ caption }),
    tiktok_metadata: JSON.stringify({
      post_info: {
        title: caption,
        privacy_level: visibility,
        disable_duet: false,
        disable_comment: false,
        disable_stitch: false,
      },
      source_info: job.video_url
        ? { source: 'PULL_FROM_URL', video_url: job.video_url }
        : { source: 'FILE_UPLOAD' },
    }),
  };
}

function retryDelayMinutes(retryCount) {
  const count = Number(retryCount || 0);
  if (count <= 0) return 15;
  if (count === 1) return 60;
  if (count === 2) return 360;
  return 1440;
}

function classifyError(error) {
  const message = clean(error?.message || error?.error?.message || error?.body?.error?.message || error?.body || error, 2000);
  if (/auth|oauth|token|401|403|permission|scope|credential/i.test(message)) return { status: 'AUTH_REQUIRED', retryable: false, message };
  if (/reject|copyright|policy|invalid.*video|privacy|unsupported|duplicate/i.test(message)) return { status: 'REJECTED', retryable: false, message };
  return { status: 'RETRY_PENDING', retryable: true, message: message || 'Platform publish failed' };
}

function buildPublishSuccessUpdate(job, response = {}, now = new Date()) {
  const platform = normalizePlatform(job.platform);
  const postId = clean(response.id || response.video_id || response.publish_id || response.data?.id || response.data?.publish_id || response.share_id);
  const postUrl = clean(response.url || response.post_url || response.permalink_url || response.data?.share_url || response.data?.url);
  const completedStatus = platform === 'TIKTOK' && clean(job.tiktok_mode).toUpperCase() === 'DRAFT' ? 'DRAFT_UPLOADED' : 'PUBLISHED';
  const status = postId ? completedStatus : 'FAILED';
  return {
    publish_id: job.publish_id,
    platform,
    publish_status: status,
    post_id: postId,
    post_url: postUrl,
    last_error: postId ? '' : 'Platform response did not include a confirmed post ID',
    updated_at: nowIso(now),
    completed_at: postId ? nowIso(now) : '',
    claimed_at: '',
    claimed_by: '',
    lease_expires_at: '',
  };
}

function retryCountOf(value) {
  const count = Number(value);
  return Number.isInteger(count) && count >= 0 ? count : MAX_RETRY_ATTEMPTS;
}

function buildPublishFailureUpdate(job, error, now = new Date()) {
  const classified = classifyError(error);
  const previousRetryCount = retryCountOf(job.retry_count || 0);
  const retryCount = previousRetryCount + (classified.retryable ? 1 : 0);
  const failed = classified.retryable && retryCount >= MAX_RETRY_ATTEMPTS;
  const nextRetry = classified.retryable && !failed
    ? new Date(Date.parse(nowIso(now)) + retryDelayMinutes(previousRetryCount) * 60000).toISOString()
    : '';

  return {
    publish_id: job.publish_id,
    platform: normalizePlatform(job.platform),
    publish_status: failed ? 'FAILED' : classified.status,
    retry_count: String(retryCount),
    next_retry_at: nextRetry,
    last_error: classified.message,
    updated_at: nowIso(now),
    claimed_at: '',
    claimed_by: '',
    lease_expires_at: '',
  };
}

function buildCredentialHealthRows(channels, now = new Date()) {
  const timestamp = nowIso(now);
  return (channels || [])
    .filter(active)
    .map((channel) => {
      const expiresAt = Date.parse(channel.token_expires_at || '');
      let status = 'HEALTHY';
      if (Number.isFinite(expiresAt) && expiresAt < Date.parse(timestamp)) status = 'INVALID';
      else if (Number.isFinite(expiresAt) && expiresAt - Date.parse(timestamp) < 7 * 86400000) status = 'EXPIRING';
      return {
        channel_id: clean(channel.channel_id || channel.destination_id || channel.credential_name),
        platform: normalizePlatform(channel.platform),
        last_health_status: status,
        last_expiry_audit_at: timestamp,
        updated_at: timestamp,
      };
    });
}

function pickRetryJobs(rows, now = new Date()) {
  return (rows || [])
    .filter((row) => normalizeStatus(row.publish_status) === 'RETRY_PENDING')
    .filter((row) => {
      if (retryCountOf(row.retry_count) >= MAX_RETRY_ATTEMPTS) return true;
      if (!row.next_retry_at) return true;
      const next = Date.parse(row.next_retry_at);
      return Number.isFinite(next) && next <= Date.parse(nowIso(now));
    })
    .map((row) => ({
      publish_id: row.publish_id,
      publish_status: retryCountOf(row.retry_count) >= MAX_RETRY_ATTEMPTS ? 'FAILED' : 'PENDING',
      next_retry_at: '',
      claimed_at: '',
      claimed_by: '',
      lease_expires_at: '',
      updated_at: nowIso(now),
    }));
}

module.exports = {
  PLATFORMS,
  MAX_RETRY_ATTEMPTS,
  CREDENTIAL_SLOTS,
  buildPublishClaim,
  buildCredentialHealthRows,
  buildPublishAttempt,
  buildPublishFailureUpdate,
  buildPublishSuccessUpdate,
  buildPublishingJobs,
  normalizePlatform,
  providerPollUpdate,
  interpretFacebookStatus,
  interpretInstagramContainerStatus,
  interpretTikTokStatus,
  interpretYouTubeStatus,
  pickNextPublishJob,
  pickRetryJobs,
  retryDelayMinutes,
  splitPlatforms,
  validateProviderJob,
};
