function nairobiDay(value) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Nairobi' }).format(new Date(value));
}

function isRealJob(job) {
  return job.clip_moment_id && String(job.job_status) !== 'SUBMIT_FAILED';
}

function spentToday(jobs, now = new Date().toISOString()) {
  const today = nairobiDay(now);
  return jobs.filter((job) => job.created_at && nairobiDay(job.created_at) === today && isRealJob(job)).length;
}

function planSsembleRequests(moments, jobs, options = {}) {
  const dailyBudget = Number(options.dailyBudget || 10);
  const now = options.now || new Date().toISOString();
  const webhookUrl = options.webhookUrl || 'https://YOUR_N8N_DOMAIN/webhook/ssemble-callback?secret=SSEMBLE_WEBHOOK_SECRET';
  let remaining = Math.max(0, dailyBudget - spentToday(jobs, now));
  if (remaining === 0) return [];

  const dispatched = {};
  for (const job of jobs) {
    if (isRealJob(job)) dispatched[job.clip_moment_id] = true;
  }

  const pending = moments
    .filter((moment) => String(moment.ssemble_status) === 'PENDING')
    .filter((moment) => !dispatched[moment.clip_moment_id]);

  const byVideo = {};
  for (const moment of pending) {
    byVideo[moment.video_id] = byVideo[moment.video_id] || [];
    byVideo[moment.video_id].push(moment);
  }

  const requests = [];
  for (const videoId of Object.keys(byVideo).sort()) {
    const momentsForVideo = byVideo[videoId].sort((a, b) => Number(b.clip_score || 0) - Number(a.clip_score || 0));
    for (const moment of momentsForVideo) {
      if (remaining === 0) break;
      let start = Math.max(0, Math.floor(Number(moment.start_sec)));
      let end = Math.floor(Number(moment.end_sec));
      if (end - start < 60) {
        const pad = Math.ceil((60 - (end - start)) / 2);
        start = Math.max(0, start - pad);
        end = start + 60;
      }
      if (end - start > 1200) end = start + 1200;
      const isWindow = String(moment.strategy) === 'USE_20_MIN_WINDOW';
      const body = {
        url: moment.source_video_url,
        start,
        end,
        preferredLength: 'under60sec',
        language: 'en',
        music: false,
        layout: 'auto',
        ...(isWindow ? {} : { noClipping: true }),
        webhookUrl,
      };
      requests.push({
        clip_moment_id: moment.clip_moment_id,
        video_id: moment.video_id,
        niche: moment.niche,
        source_video_url: moment.source_video_url,
        start_sec: start,
        end_sec: end,
        ssemble_body: JSON.stringify(body),
      });
      remaining -= 1;
    }
  }
  return requests;
}

function buildReservationRow(request, now = new Date().toISOString()) {
  return {
    ssemble_job_id: `RESERVE-${request.clip_moment_id}`,
    video_id: request.video_id,
    clip_moment_id: request.clip_moment_id,
    niche: request.niche,
    source_video_url: request.source_video_url,
    start_sec: request.start_sec,
    end_sec: request.end_sec,
    request_payload: request.ssemble_body,
    response_payload: '',
    job_status: 'RESERVED',
    webhook_received: 'FALSE',
    error_message: '',
    created_at: now,
    completed_at: '',
  };
}

function buildSubmittedJobUpdate(request, response, now = new Date().toISOString()) {
  return {
    ssemble_job_id: response.data.requestId,
    video_id: request.video_id,
    clip_moment_id: request.clip_moment_id,
    niche: request.niche,
    source_video_url: request.source_video_url,
    start_sec: request.start_sec,
    end_sec: request.end_sec,
    request_payload: request.ssemble_body,
    response_payload: JSON.stringify(response).slice(0, 40000),
    job_status: 'SUBMITTED',
    webhook_received: 'FALSE',
    error_message: '',
    created_at: now,
    completed_at: '',
  };
}

function buildSubmitFailedJobUpdate(request, response, now = new Date().toISOString()) {
  const message = (response.error && response.error.message) || response.message || JSON.stringify(response).slice(0, 500);
  return {
    ssemble_job_id: `SUBMITFAIL-${request.clip_moment_id}-${Date.parse(now) || Date.now()}`,
    video_id: request.video_id,
    clip_moment_id: request.clip_moment_id,
    niche: request.niche,
    source_video_url: request.source_video_url,
    start_sec: request.start_sec,
    end_sec: request.end_sec,
    request_payload: request.ssemble_body,
    response_payload: JSON.stringify(response).slice(0, 40000),
    job_status: 'SUBMIT_FAILED',
    webhook_received: 'FALSE',
    error_message: String(message),
    created_at: now,
    completed_at: '',
  };
}

function buildMomentStatus(request, status, ssembleJobId = '') {
  return {
    clip_moment_id: request.clip_moment_id,
    ssemble_status: status,
    ssemble_job_id: ssembleJobId,
  };
}

module.exports = {
  buildMomentStatus,
  buildReservationRow,
  buildSubmittedJobUpdate,
  buildSubmitFailedJobUpdate,
  planSsembleRequests,
  spentToday,
};
