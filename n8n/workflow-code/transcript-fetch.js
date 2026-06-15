const TRANSCRIPT_LIMIT = 45000;

function pickPendingTranscripts(candidateRows, limit = 10) {
  return candidateRows
    .filter((row) => String(row.validity_status) === 'VALID')
    .filter((row) => String(row.transcript_available || '') === '')
    .slice(0, limit);
}

function formatTimestamp(seconds) {
  const totalSeconds = Math.floor(Number(seconds) || 0);
  const minutes = String(Math.floor(totalSeconds / 60)).padStart(2, '0');
  const remainingSeconds = String(totalSeconds % 60).padStart(2, '0');
  return `${minutes}:${remainingSeconds}`;
}

function buildTimestampedTranscript(snippets) {
  return (snippets || [])
    .map((snippet) => `[${formatTimestamp(snippet.start)}] ${snippet.text}`)
    .join('\n');
}

function buildAnalysisRow(video, response, now = new Date().toISOString()) {
  let transcriptText = buildTimestampedTranscript(response.transcript || []);
  let transcriptStatus = 'FETCHED';
  if (transcriptText.length > TRANSCRIPT_LIMIT) {
    transcriptText = `${transcriptText.slice(0, TRANSCRIPT_LIMIT)}\n...[TRUNCATED]`;
    transcriptStatus = 'TRUNCATED';
  }

  return {
    analysis_id: `AN-${video.youtube_video_id}`,
    video_id: video.video_id,
    niche: video.niche,
    video_title: video.video_title,
    video_url: video.video_url,
    transcript_status: transcriptStatus,
    transcript_text: transcriptText,
    transcript_length_words: String(response.plain_text || '').split(/\s+/).filter(Boolean).length,
    ai_episode_score: '',
    recommended_strategy: '',
    recommended_start_sec: '',
    recommended_end_sec: '',
    reason_for_strategy: '',
    rights_risk: '',
    permission_risk: '',
    monetization_risk: '',
    originality_potential: '',
    kenya_relevance: '',
    ai_json_output: '',
    created_at: now,
  };
}

function markTranscriptOk(video, response) {
  return {
    video_id: video.video_id,
    transcript_available: 'TRUE',
    language: response.language_code || video.language,
  };
}

function markTranscriptFailed(video, response) {
  const code = response.error_code || (response.error ? 'HTTP_ERROR' : 'UNKNOWN');
  const infrastructureError = code === 'IP_BLOCKED' || code === 'FETCH_FAILED' || code === 'HTTP_ERROR';
  return {
    video_id: video.video_id,
    transcript_available: infrastructureError ? '' : 'FALSE',
    validity_status: infrastructureError ? video.validity_status : 'REJECTED',
    rejection_reason: infrastructureError ? '' : `TRANSCRIPT_${code}`,
    processing_status: infrastructureError ? video.processing_status : 'SKIPPED',
  };
}

module.exports = {
  buildAnalysisRow,
  buildTimestampedTranscript,
  markTranscriptFailed,
  markTranscriptOk,
  pickPendingTranscripts,
};
