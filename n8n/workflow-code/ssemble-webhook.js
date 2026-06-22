function verifyAndParseWebhook(input, secret = 'SSEMBLE_WEBHOOK_SECRET') {
  const query = input.query || {};
  if (query.secret !== secret) {
    throw new Error('Webhook secret mismatch - dropping payload');
  }
  const payload = input.body || {};
  const completed = payload.event === 'shorts.completed';
  return {
    completed,
    requestId: payload.requestId || '',
    timestamp: payload.timestamp || new Date().toISOString(),
    shorts: (completed && payload.data && payload.data.shorts) || [],
    failureReason: (!completed && payload.data && payload.data.failureReason) || '',
    raw: JSON.stringify(payload).slice(0, 40000),
  };
}

function attachMoment(parsed, jobs) {
  const job = jobs.find((row) => String(row.ssemble_job_id) === String(parsed.requestId)) || {};
  return {
    ...parsed,
    clip_moment_id: job.clip_moment_id || '',
    video_id: job.video_id || '',
    niche: job.niche || '',
  };
}

function shapeJobCompleted(data) {
  return {
    ssemble_job_id: data.requestId,
    job_status: 'COMPLETED',
    webhook_received: 'TRUE',
    response_payload: data.raw,
    completed_at: data.timestamp,
  };
}

function shapeJobFailed(data) {
  return {
    ssemble_job_id: data.requestId,
    job_status: 'FAILED',
    webhook_received: 'TRUE',
    error_message: String(data.failureReason || '').slice(0, 1000),
    completed_at: data.timestamp,
  };
}

function shapeMomentStatus(data, status) {
  return {
    clip_moment_id: data.clip_moment_id || 'NOOP-ORPHAN',
    ssemble_status: status,
  };
}

function explodeCreatedClips(data, now = new Date().toISOString()) {
  return (data.shorts || []).map((short, index) => ({
    created_clip_id: `CC-${short.id}`,
    ssemble_job_id: data.requestId,
    video_id: data.video_id || '',
    niche: data.niche || '',
    clip_title: String(short.title || ''),
    clip_url: String(short.video_url || ''),
    local_file_name: '',
    google_drive_file_id: '',
    google_drive_url: '',
    duration_seconds: Number(short.duration || 0),
    transcript_excerpt: '',
    suggested_title: '',
    suggested_caption: '',
    transformation_plan: '',
    review_status: 'AWAITING_DOWNLOAD',
    reviewer_notes: `viral_score=${short.viral_score || ''}`,
    created_at: now,
    rank: index + 1,
  }));
}

module.exports = {
  attachMoment,
  explodeCreatedClips,
  shapeJobCompleted,
  shapeJobFailed,
  shapeMomentStatus,
  verifyAndParseWebhook,
};
