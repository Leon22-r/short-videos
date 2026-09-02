const FINAL_FOLDER_BY_NICHE = {
  CHRISTIAN_CONTENT: 'GOOGLE_DRIVE_FINAL_FOLDER_CHRISTIAN_CONTENT',
  MOTIVATION_DISCIPLINE: 'GOOGLE_DRIVE_FINAL_FOLDER_MOTIVATION_DISCIPLINE',
  FINANCE_BUSINESS: 'GOOGLE_DRIVE_FINAL_FOLDER_FINANCE_BUSINESS',
  LIFE_VALUES_RELATIONSHIPS: 'GOOGLE_DRIVE_FINAL_FOLDER_LIFE_VALUES_RELATIONSHIPS',
  AFRICAN_KENYAN_SUCCESS: 'GOOGLE_DRIVE_FINAL_FOLDER_AFRICAN_KENYAN_SUCCESS',
};

const DEFAULT_FONTFILE = '/usr/share/fonts/dejavu/DejaVuSans.ttf';

function active(row) {
  return ['true', 'active', 'yes', '1'].includes(String(row.active_status || '').trim().toLowerCase());
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  const safe = Number.isFinite(number) ? number : fallback;
  return Math.min(max, Math.max(min, safe));
}

function pickPendingRenderJob(rows) {
  return (rows || [])
    .filter((row) => String(row.render_status || '').trim().toUpperCase() === 'PENDING')
    .sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')))[0] || null;
}

function selectMusicTrack(job, rows, branding = {}) {
  const activeRows = (rows || []).filter(active).filter((row) => row.niche === job.niche);
  const mood = String(job.music_mood || '').toLowerCase();
  const energy = String(job.music_energy_level || '').toLowerCase();
  const tests = [
    (row) => String(row.mood || '').toLowerCase() === mood && String(row.energy_level || '').toLowerCase() === energy,
    (row) => String(row.mood || '').toLowerCase() === mood,
    (row) => String(row.energy_level || '').toLowerCase() === energy,
    (row) => row.music_id && row.music_id === branding.music_default_id,
  ];
  const picked = tests.map((fn) => activeRows.find(fn)).find(Boolean);
  if (!picked) return null;

  return {
    music_id: picked.music_id,
    music_drive_file_id: picked.drive_file_id,
    music_file_name: `${picked.music_id || 'music'}.mp3`,
    music_volume: clampNumber(job.music_volume || picked.recommended_volume, 0.04, 0.14, 0.09),
  };
}

function buildRenderStatusUpdate(job, status, now = new Date().toISOString(), extra = {}) {
  return {
    render_id: job.render_id,
    render_status: status,
    started_at: status === 'DOWNLOADING_ASSETS' ? now : (job.started_at || ''),
    completed_at: ['COMPLETED', 'FAILED', 'SKIPPED'].includes(status) ? now : (job.completed_at || ''),
    ...extra,
  };
}

function buildRenderFailureUpdate(job, message, now = new Date().toISOString()) {
  return buildRenderStatusUpdate(job, 'FAILED', now, {
    error_message: String(message || 'Render failed').slice(0, 2000),
  });
}

function buildAssetDownloadPlan(job, brandingRows, musicRows, finalFolders = FINAL_FOLDER_BY_NICHE, now = new Date().toISOString()) {
  if (!job || !job.render_id) return buildRenderFailureUpdate({ render_id: '' }, 'Missing render job', now);
  if (!job.source_drive_file_id) return buildRenderFailureUpdate(job, 'Missing source Drive file ID', now);

  const matchingBranding = (brandingRows || []).filter(active).filter((row) => row.niche === job.niche);
  if (matchingBranding.length !== 1) {
    return buildRenderFailureUpdate(job, `Missing active Channel_Branding row for niche ${job.niche}`, now);
  }

  const branding = matchingBranding[0];
  if (!branding.watermark_drive_file_id) {
    return buildRenderFailureUpdate(job, `Missing watermark Drive file ID for niche ${job.niche}`, now);
  }

  const music = selectMusicTrack(job, musicRows, branding);
  const warning = music ? '' : 'No active matching music found; rendering without background music.';

  return buildRenderStatusUpdate(job, 'DOWNLOADING_ASSETS', now, {
    final_drive_folder_id: finalFolders[job.niche] || '',
    watermark_drive_file_id: branding.watermark_drive_file_id,
    watermark_file_name: `${job.niche}_watermark.png`,
    progress_bar_color: job.progress_bar_color || branding.progress_bar_color || '0xFFFFFF',
    cta_text: job.cta_text || branding.default_cta || '',
    warning_message: warning,
    ...(music || { music_id: '', music_drive_file_id: '', music_file_name: '', music_volume: '' }),
  });
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function shellDoubleQuote(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, '\\$').replace(/`/g, '\\`')}"`;
}

function buildFfmpegCommand(options) {
  const fontfile = options.fontfile || DEFAULT_FONTFILE;
  const duration = Math.max(1, Number(options.duration_seconds || 45));
  // Text is written to files and read via drawtext `textfile=` so apostrophes
  // ("Don't", "It's") and other punctuation can't break ffmpeg's quote parsing.
  // `expansion=none` stops ffmpeg from interpreting %{...} and backslashes in the
  // rendered copy.
  const hook = String(options.hook_text || '');
  const cta = String(options.cta_text || '');
  const progress = options.progress_bar_color || '0xFFFFFF';
  const workdir = options.workdir || `/data/jobs/${options.render_id}`;
  const hookFile = `${workdir}/hook.txt`;
  const ctaFile = `${workdir}/cta.txt`;
  const ctaStart = Number(options.cta_start_second || Math.max(0, duration - 4));
  const ctaEnd = Number(options.cta_end_second || duration);
  const hasMusic = Boolean(options.music_path);
  const baseFilters = [
    '[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=25:1[bg]',
    '[0:v]scale=950:-1[fg]',
    '[bg][fg]overlay=(W-w)/2:(H-h)/2[base]',
    '[base]drawbox=x=0:y=0:w=1080:h=180:color=black@0.35:t=fill[tbox]',
    `[tbox]drawtext=fontfile='${fontfile}':textfile='${hookFile}':expansion=none:fontcolor=white:fontsize=58:x=(w-text_w)/2:y=60:box=1:boxcolor=black@0.25:boxborderw=18[title]`,
    `[title]drawbox=x=0:y=h-12:w='1080*t/${duration}':h=12:color=${progress}@0.95:t=fill[progress]`,
    `[progress]drawtext=fontfile='${fontfile}':textfile='${ctaFile}':expansion=none:fontcolor=white:fontsize=48:x=(w-text_w)/2:y=1580:box=1:boxcolor=black@0.45:boxborderw=18:enable='between(t,${ctaStart},${ctaEnd})'[cta]`,
    '[1:v]scale=110:-1[wm]',
    '[cta][wm]overlay=x=W-w-35:y=35[vout]',
  ];
  const audioFilters = hasMusic
    ? `;[0:a]volume=1.0[a0];[2:a]volume=${clampNumber(options.music_volume, 0.04, 0.14, 0.09)},aloop=loop=-1:size=2e+09[bgm];[a0][bgm]amix=inputs=2:duration=first:dropout_transition=2[aout]`
    : ';[0:a]volume=1.0[aout]';
  const inputs = [
    `-i ${shellQuote(options.input_path)}`,
    `-i ${shellQuote(options.watermark_path)}`,
    hasMusic ? `-i ${shellQuote(options.music_path)}` : '',
  ].filter(Boolean).join(' ');

  return [
    'mkdir -p',
    shellQuote(workdir),
    '&&',
    'printf %s',
    shellQuote(hook),
    '>',
    shellQuote(hookFile),
    '&&',
    'printf %s',
    shellQuote(cta),
    '>',
    shellQuote(ctaFile),
    '&&',
    'ffmpeg -y',
    inputs,
    '-filter_complex',
    shellDoubleQuote(`${baseFilters.join(';')}${audioFilters}`),
    '-map "[vout]" -map "[aout]" -c:v libx264 -preset veryfast -crf 23 -c:a aac -b:a 128k -shortest',
    shellQuote(options.output_path),
    '>',
    shellQuote(options.log_path),
    '2>&1',
  ].join(' ');
}

function buildCompletedRenderUpdate(job, drive, now = new Date().toISOString()) {
  return buildRenderStatusUpdate(job, 'COMPLETED', now, {
    final_drive_file_id: drive.id,
    final_drive_url: drive.webViewLink || `https://drive.google.com/file/d/${drive.id}/view`,
    final_local_path: job.final_local_path || `/data/jobs/${job.render_id}/output.mp4`,
    error_message: '',
  });
}

module.exports = {
  DEFAULT_FONTFILE,
  FINAL_FOLDER_BY_NICHE,
  buildAssetDownloadPlan,
  buildCompletedRenderUpdate,
  buildFfmpegCommand,
  buildRenderFailureUpdate,
  buildRenderStatusUpdate,
  pickPendingRenderJob,
  selectMusicTrack,
};
