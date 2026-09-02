const { pickFairByGroup } = require('./fair-share');

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function safeIdComponent(value) {
  const id = String(value || '').trim();
  if (!/^[A-Za-z0-9_-]+$/.test(id)) {
    throw new Error(`Unsafe id for yt-dlp path: ${JSON.stringify(value)}`);
  }
  return id;
}

function normalizeTimeRange(moment) {
  const start = Math.max(0, Math.floor(Number(moment.start_sec)));
  const end = Math.floor(Number(moment.end_sec));
  const duration = end - start;
  if (!Number.isFinite(start) || !Number.isFinite(end) || duration < 45 || duration > 90) {
    throw new Error(`Invalid yt-dlp clip range for ${moment.clip_moment_id || 'unknown'}: ${moment.start_sec}-${moment.end_sec}`);
  }
  return { start, end, duration };
}

function createdClipIdForMoment(moment) {
  return `CC-${safeIdComponent(moment.clip_moment_id)}`;
}

function ytdlpJobIdForMoment(moment) {
  return `YTDLP-${safeIdComponent(moment.clip_moment_id)}`;
}

function hasCreatedClip(moment, clips) {
  const createdId = createdClipIdForMoment(moment);
  const jobId = ytdlpJobIdForMoment(moment);
  return (clips || []).some((clip) => (
    String(clip.created_clip_id || '') === createdId ||
    String(clip.ssemble_job_id || '') === jobId
  ));
}

function planYtDlpDownloads(moments, createdClips, folders = {}, options = {}) {
  const limit = Number(options.limit || 5);
  const perSourceLimit = Number(options.perSourceLimit || 1);
  const pending = [];

  for (const moment of moments || []) {
    if (String(moment.ssemble_status || '') !== 'PENDING') continue;
    if (!moment.clip_moment_id || !moment.source_video_url) continue;

    let range;
    let createdClipId;
    let ytdlpJobId;
    try {
      range = normalizeTimeRange(moment);
      createdClipId = createdClipIdForMoment(moment);
      ytdlpJobId = ytdlpJobIdForMoment(moment);
    } catch {
      continue;
    }
    if (hasCreatedClip(moment, createdClips)) continue;

    const workdir = `/data/jobs/${createdClipId}`;
    pending.push({
      clip_moment_id: moment.clip_moment_id,
      created_clip_id: createdClipId,
      ssemble_job_id: ytdlpJobId,
      video_id: moment.video_id,
      niche: moment.niche,
      source_id: moment.source_id || '',
      source_video_url: moment.source_video_url,
      start_sec: range.start,
      end_sec: range.end,
      duration_seconds: range.duration,
      clip_score: Number(moment.clip_score || 0),
      clip_title: moment.suggested_title || moment.core_idea || createdClipId,
      file_name: `${moment.niche}_${createdClipId}.mp4`,
      drive_folder_id: folders[moment.niche] || '',
      workdir,
      local_path: `${workdir}/source.mp4`,
      portrait_path: `${workdir}/portrait.mp4`,
      portrait_log_path: `${workdir}/ffmpeg-portrait.log`,
      log_path: `${workdir}/yt-dlp.log`,
      core_idea: moment.core_idea || '',
      suggested_title: moment.suggested_title || '',
      suggested_caption: moment.suggested_caption || '',
      reviewer_notes: [
        `provider=yt-dlp`,
        `strategy=${moment.strategy || ''}`,
        `clip_moment_id=${moment.clip_moment_id}`,
      ].join('; '),
      created_at: moment.created_at || '',
    });
  }

  return pickFairByGroup(pending, {
    limit,
    perSourceLimit,
    groupKey: 'niche',
    sourceKey: 'source_id',
    sourceFallbackKeys: ['niche'],
    compare: (a, b) => {
      const scoreDelta = Number(b.clip_score || 0) - Number(a.clip_score || 0);
      if (scoreDelta !== 0) return scoreDelta;
      return String(a.created_at || '').localeCompare(String(b.created_at || ''));
    },
  });
}

function buildYtDlpCommand(request) {
  safeIdComponent(request.created_clip_id);
  const range = normalizeTimeRange(request);
  const section = `*${range.start}-${range.end}`;
  return [
    'mkdir -p',
    shellQuote(request.workdir),
    '&&',
    'python3 -m yt_dlp',
    '--no-playlist',
    '--force-overwrites',
    '--download-sections',
    shellQuote(section),
    '--force-keyframes-at-cuts',
    '-f',
    shellQuote('bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/best'),
    '--merge-output-format',
    'mp4',
    '-o',
    shellQuote(`${request.workdir}/source.%(ext)s`),
    shellQuote(request.source_video_url),
    '>',
    shellQuote(request.log_path),
    '2>&1',
    '&&',
    'test -s',
    shellQuote(request.local_path),
    '&&',
    'ffprobe -v error -select_streams v:0 -show_entries stream=codec_type -of csv=p=0',
    shellQuote(request.local_path),
    '|',
    "grep -q '^video$'",
  ].join(' ');
}

function buildMomentStatus(request, status, extra = {}) {
  return {
    clip_moment_id: request.clip_moment_id,
    ssemble_status: status,
    ssemble_job_id: request.ssemble_job_id || '',
    ...extra,
  };
}

function buildCreatedClipRow(request, drive, now = new Date().toISOString()) {
  return {
    created_clip_id: request.created_clip_id,
    ssemble_job_id: request.ssemble_job_id,
    video_id: request.video_id,
    niche: request.niche,
    clip_title: String(request.clip_title || ''),
    clip_url: '',
    local_file_name: request.file_name,
    google_drive_file_id: drive.id || '',
    google_drive_url: drive.webViewLink || (drive.id ? `https://drive.google.com/file/d/${drive.id}/view` : ''),
    duration_seconds: request.duration_seconds,
    transcript_excerpt: '',
    suggested_title: String(request.suggested_title || ''),
    suggested_caption: String(request.suggested_caption || ''),
    transformation_plan: '',
    review_status: 'AWAITING_DOWNLOAD',
    reviewer_notes: request.reviewer_notes || 'provider=yt-dlp',
    created_at: now,
  };
}

function buildPortraitCommand(request) {
  const inputPath = request.local_path;
  const outputPath = request.portrait_path;
  const logPath = request.portrait_log_path;
  const vf = 'scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920:(iw-1080)/2:(ih-1920)/2,setsar=1';
  return [
    'ffmpeg -y',
    '-i', shellQuote(inputPath),
    '-map 0:v:0',
    '-map 0:a:0?',
    '-vf', shellQuote(vf),
    '-c:v libx264 -preset veryfast -crf 23 -pix_fmt yuv420p',
    '-c:a aac -b:a 128k',
    '-movflags +faststart',
    shellQuote(outputPath),
    '>', shellQuote(logPath), '2>&1',
    '&&', 'test -s', shellQuote(outputPath),
    '&&',
    'ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=s=x:p=0',
    shellQuote(outputPath),
    '|',
    "grep -qx '1080x1920'",
  ].join(' ');
}

module.exports = {
  buildCreatedClipRow,
  buildMomentStatus,
  buildPortraitCommand,
  buildYtDlpCommand,
  createdClipIdForMoment,
  normalizeTimeRange,
  planYtDlpDownloads,
  safeIdComponent,
  ytdlpJobIdForMoment,
};
