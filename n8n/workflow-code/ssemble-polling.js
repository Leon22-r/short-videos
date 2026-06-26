function isTrue(value) {
  return String(value || '').toUpperCase() === 'TRUE';
}

function isSubmitted(job) {
  return String(job.job_status || '').toUpperCase() === 'SUBMITTED';
}

function ageMinutes(createdAt, now) {
  const created = Date.parse(createdAt || '');
  const current = Date.parse(now || new Date().toISOString());
  if (!Number.isFinite(created) || !Number.isFinite(current)) return 0;
  return Math.floor((current - created) / 60000);
}

function shouldPollCurrentJob(job) {
  return Boolean(job && job.ssemble_job_id && isSubmitted(job) && !isTrue(job.webhook_received));
}

function pickStaleSubmittedJobs(jobs, now = new Date().toISOString(), minAgeMinutes = 30, limit = 10) {
  return (jobs || [])
    .filter((job) => shouldPollCurrentJob(job))
    .filter((job) => ageMinutes(job.created_at, now) >= minAgeMinutes)
    .sort((a, b) => Date.parse(a.created_at || 0) - Date.parse(b.created_at || 0))
    .slice(0, limit);
}

function findLatestJob(candidate, jobs) {
  return (jobs || []).find((job) => String(job.ssemble_job_id) === String(candidate.ssemble_job_id)) || candidate;
}

function readStatus(response) {
  return String(
    response?.data?.status ||
    response?.status ||
    response?.state ||
    '',
  ).toLowerCase();
}

function readFailureReason(response, fallback = '') {
  return String(
    response?.data?.failureReason ||
    response?.failureReason ||
    response?.error?.message ||
    response?.message ||
    fallback ||
    '',
  );
}

function normalizeStatusResponse(response, job, now = new Date().toISOString()) {
  const status = readStatus(response);
  let route = 'pending';
  if (status === 'completed') route = 'completed';
  if (status === 'failed' || status === 'cancelled') route = 'failed';

  return {
    requestId: job.ssemble_job_id,
    clip_moment_id: job.clip_moment_id || '',
    video_id: job.video_id || '',
    niche: job.niche || '',
    status,
    route,
    timestamp: response?.timestamp || response?.data?.timestamp || now,
    failureReason: route === 'failed'
      ? readFailureReason(response, status === 'cancelled' ? 'Ssemble returned cancelled' : 'Ssemble processing failed')
      : '',
    raw: JSON.stringify(response || {}).slice(0, 40000),
  };
}

function extractShorts(response) {
  const shorts = response?.data?.shorts || response?.shorts || response?.data?.data?.shorts || [];
  return Array.isArray(shorts) ? shorts : [];
}

function normalizeCompletedPollResult(job, statusResponse, resultResponse, now = new Date().toISOString()) {
  return {
    completed: true,
    requestId: job.ssemble_job_id,
    timestamp: resultResponse?.timestamp || statusResponse?.timestamp || now,
    shorts: extractShorts(resultResponse),
    failureReason: '',
    raw: JSON.stringify({ status: statusResponse || {}, result: resultResponse || {} }).slice(0, 40000),
  };
}

function normalizeFailedPollStatus(job, statusResponse, now = new Date().toISOString()) {
  const normalized = normalizeStatusResponse(statusResponse, job, now);
  return {
    completed: false,
    requestId: job.ssemble_job_id,
    timestamp: normalized.timestamp,
    shorts: [],
    failureReason: normalized.failureReason || 'Ssemble processing failed',
    raw: normalized.raw,
  };
}

function buildNoopPollResult(job, response, now = new Date().toISOString()) {
  return {
    requestId: job.ssemble_job_id,
    clip_moment_id: job.clip_moment_id || '',
    video_id: job.video_id || '',
    niche: job.niche || '',
    status: readStatus(response) || 'pending',
    route: 'pending',
    timestamp: response?.timestamp || now,
    failureReason: readFailureReason(response),
    raw: JSON.stringify(response || {}).slice(0, 40000),
  };
}

module.exports = {
  buildNoopPollResult,
  findLatestJob,
  normalizeCompletedPollResult,
  normalizeFailedPollStatus,
  normalizeStatusResponse,
  pickStaleSubmittedJobs,
  shouldPollCurrentJob,
};
