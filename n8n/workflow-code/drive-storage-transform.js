const TITLE_FORMULAS = {
  CHRISTIAN_CONTENT: ['God Is Not Asking You to Ignore This', 'This Is What Waiting on God Really Means', 'A Biblical Lesson Most People Miss'],
  MOTIVATION_DISCIPLINE: ["The Real Reason You Can't Stay Consistent", 'Motivation Is Not Your Problem', 'Stop Waiting to Feel Ready'],
  FINANCE_BUSINESS: ['Why High Income Still Feels Like Poverty', 'This Money Mistake Keeps People Broke', 'Income Is Not Wealth'],
  LIFE_VALUES_RELATIONSHIPS: ["This Is Not Love, It's Fear", 'Healthy Boundaries Sound Like This', 'Stop Calling This Loyalty'],
  AFRICAN_KENYAN_SUCCESS: ['Every Young Kenyan Builder Should Hear This', 'This Advice Works Differently in Africa', 'The Reality of Building in Kenya'],
};

function pickAwaitingDownloads(clips, jobs, moments, folders, limit = 5) {
  const jobsById = Object.fromEntries(jobs.map((job) => [job.ssemble_job_id, job]));
  const momentsById = Object.fromEntries(moments.map((moment) => [moment.clip_moment_id, moment]));

  return clips
    .filter((clip) => String(clip.review_status) === 'AWAITING_DOWNLOAD')
    .slice(0, limit)
    .map((clip) => {
      const job = jobsById[clip.ssemble_job_id] || {};
      const moment = momentsById[job.clip_moment_id] || {};
      const niche = clip.niche || job.niche || 'AFRICAN_KENYAN_SUCCESS';
      return {
        ...clip,
        niche,
        video_id: clip.video_id || job.video_id || '',
        drive_folder_id: folders[niche],
        file_name: `${niche}_${clip.created_clip_id}.mp4`,
        moment_core_idea: moment.core_idea || '',
        moment_commentary_angle: moment.commentary_angle || '',
        moment_kenyan_application: moment.kenyan_african_application || '',
        moment_bible_verse: moment.bible_verse_if_relevant || '',
        moment_hook: moment.hook_first_2_seconds || '',
        moment_suggested_title: moment.suggested_title || '',
      };
    });
}

function buildDriveIdUpdate(clip, drive) {
  return {
    created_clip_id: clip.created_clip_id,
    local_file_name: clip.file_name,
    google_drive_file_id: drive.id,
    google_drive_url: drive.webViewLink || `https://drive.google.com/file/d/${drive.id}/view`,
  };
}

function buildPlannerRequest(clip) {
  const driveFileId = clip.google_drive_file_id || clip.drive_file_id;
  const driveUrl = clip.google_drive_url || clip.drive_url;
  const systemPrompt = `You are an originality-first short-form video editor, scriptwriter, and monetization-safety reviewer.

Transform the selected clip into a video that clearly adds original value. The final output must not look like a reposted podcast clip. It must look like original commentary content that uses the clip as supporting material.

Return JSON only with: content_thesis, best_title, alternative_titles, hook, narration_script, commentary_angle, kenyan_african_localization, bible_verse_if_relevant, on_screen_text_beats, broll_plan, editing_style, caption, hashtags, cta, risk_warning, originality_checklist.

Title style guides: ${JSON.stringify(TITLE_FORMULAS)}.`;
  const userContent = [
    `Niche: ${clip.niche}`,
    `Clip title: ${clip.clip_title}`,
    `Clip duration: ${clip.duration_seconds}s`,
    `Core idea: ${clip.moment_core_idea}`,
    `Planned commentary angle: ${clip.moment_commentary_angle}`,
    `Kenyan/African application: ${clip.moment_kenyan_application}`,
    `Bible verse hint: ${clip.moment_bible_verse || 'none'}`,
    `Original hook idea: ${clip.moment_hook}`,
    `Suggested title from analysis: ${clip.moment_suggested_title}`,
  ].join('\n');

  return {
    created_clip_id: clip.created_clip_id,
    video_id: clip.video_id,
    niche: clip.niche,
    drive_file_id: driveFileId,
    drive_url: driveUrl,
    file_name: clip.file_name || clip.local_file_name,
    openai_model: 'gpt-4o-mini',
    system_message: systemPrompt,
    user_message: userContent,
  };
}

function parseTransformationPlan(meta, response) {
  let plan = {};
  try {
    if (response.choices) plan = JSON.parse(response.choices[0].message.content);
    else if (response.message && response.message.content) plan = JSON.parse(response.message.content);
    else if (response.text) plan = JSON.parse(response.text);
    else if (response.content) plan = JSON.parse(response.content);
    else plan = response.output || response;
  } catch (error) {
    plan = { parse_error: String(error) };
  }
  return {
    created_clip_id: meta.created_clip_id,
    video_id: meta.video_id,
    niche: meta.niche,
    local_file_name: meta.file_name || meta.local_file_name,
    google_drive_file_id: meta.drive_file_id || meta.google_drive_file_id,
    google_drive_url: meta.drive_url || meta.google_drive_url,
    suggested_title: String(plan.best_title || ''),
    suggested_caption: String(plan.caption || '').slice(0, 500),
    transformation_plan: JSON.stringify(plan).slice(0, 40000),
    review_status: 'NEEDS_REVIEW',
  };
}

module.exports = {
  buildDriveIdUpdate,
  buildPlannerRequest,
  parseTransformationPlan,
  pickAwaitingDownloads,
};
