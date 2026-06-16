const assert = require('node:assert/strict');
const test = require('node:test');
const {
  buildAnalysisRequest,
  parseAndGate,
  pickUnanalyzed,
} = require('../n8n/workflow-code/ai-transcript-analysis');

const baseRow = {
  analysis_id: 'AN-video1234567',
  video_id: 'VID-video1234567',
  video_title: 'Useful interview',
  video_url: 'https://www.youtube.com/watch?v=video1234567',
  niche: 'FINANCE_BUSINESS',
  transcript_status: 'FETCHED',
  transcript_text: '[00:00] hello world',
  ai_episode_score: '',
  source_risk: 'low',
};

function clip(overrides = {}) {
  return {
    rank: 1,
    start_sec: 60,
    end_sec: 130,
    clip_length_seconds: 70,
    clip_score: 8,
    hook_first_2_seconds: 'Stop wasting money',
    core_idea: 'Budgeting matters',
    why_it_is_valuable: 'Practical money lesson',
    best_target_audience: 'Young professionals',
    suggested_title: 'Budget better',
    suggested_caption: 'Simple budget habit',
    on_screen_text: 'Track every shilling',
    suggested_b_roll: ['M-Pesa statement'],
    my_original_commentary_angle: 'Kenyan personal finance framing',
    kenyan_african_application: 'Use M-Pesa statements and MMFs',
    bible_verse_if_relevant: null,
    monetization_risk: 'low',
    copyright_or_reused_content_risk: 'low',
    does_it_need_extra_context: false,
    originality_score: 8,
    final_recommendation: 'clip',
    ...overrides,
  };
}

function ai(overrides = {}) {
  return {
    overall_episode_score: 8,
    recommended_strategy: 'USE_EXACT_CLIPS_ONLY',
    reason_for_strategy: 'Scattered strong clips',
    best_20_min_window: {
      use_this: false,
      start_sec: 0,
      end_sec: 1200,
      why_this_window: '',
      estimated_number_of_good_clips: 0,
    },
    exact_clips: [clip()],
    risk_notes: 'Kenya relevant',
    ...overrides,
  };
}

test('picks fetched unanalyzed transcripts and joins source risk', () => {
  const rows = pickUnanalyzed(
    [
      { ...baseRow, video_id: 'VID-1' },
      { ...baseRow, video_id: 'VID-2', ai_episode_score: 8 },
      { ...baseRow, video_id: 'VID-3', transcript_status: 'FAILED' },
    ],
    [{ source_id: 'SRC-1', risk_level: 'high' }],
    [{ video_id: 'VID-1', source_id: 'SRC-1' }],
  );

  assert.equal(rows.length, 1);
  assert.equal(rows[0].source_risk, 'high');
});

test('builds OpenAI json request body', () => {
  const result = buildAnalysisRequest(baseRow);
  const body = JSON.parse(result.openai_body);

  assert.equal(body.model, 'gpt-4o-mini');
  assert.equal(body.response_format.type, 'json_object');
  assert.equal(body.messages.length, 2);
  assert.match(body.messages[1].content, /FINANCE_BUSINESS/);
});

test('forces low scoring episodes to skip with no moments', () => {
  const result = parseAndGate(baseRow, ai({ overall_episode_score: 5 }));

  assert.equal(result.analysisUpdate.recommended_strategy, 'SKIP_THIS_VIDEO');
  assert.equal(result.candidateUpdate.processing_status, 'SKIPPED');
  assert.deepEqual(result.momentRows, []);
});

test('conservative gate skips high rights risk results', () => {
  const result = parseAndGate(baseRow, ai({
    exact_clips: [clip({ copyright_or_reused_content_risk: 'high' })],
  }));

  assert.equal(result.analysisUpdate.recommended_strategy, 'SKIP_THIS_VIDEO');
  assert.equal(result.candidateUpdate.processing_status, 'SKIPPED');
  assert.deepEqual(result.momentRows, []);
});

test('downgrades weak 20-minute windows to exact clips', () => {
  const result = parseAndGate(baseRow, ai({
    recommended_strategy: 'USE_20_MIN_WINDOW',
    best_20_min_window: {
      use_this: true,
      start_sec: 0,
      end_sec: 1200,
      why_this_window: 'Only two strong clips',
      estimated_number_of_good_clips: 2,
    },
    exact_clips: [
      clip({ rank: 1, start_sec: 100, end_sec: 180 }),
      clip({ rank: 2, start_sec: 300, end_sec: 390 }),
    ],
  }));

  assert.equal(result.analysisUpdate.recommended_strategy, 'USE_EXACT_CLIPS_ONLY');
  assert.equal(result.momentRows.length, 2);
  assert(result.momentRows.every((row) => row.ssemble_status === 'PENDING'));
});

test('creates one pending window row when there are enough strong clips in range', () => {
  const result = parseAndGate(baseRow, ai({
    recommended_strategy: 'USE_20_MIN_WINDOW',
    best_20_min_window: {
      use_this: true,
      start_sec: 0,
      end_sec: 1200,
      why_this_window: 'Dense section',
      estimated_number_of_good_clips: 4,
    },
    exact_clips: [
      clip({ rank: 1, start_sec: 100, end_sec: 180 }),
      clip({ rank: 2, start_sec: 300, end_sec: 390 }),
      clip({ rank: 3, start_sec: 600, end_sec: 690 }),
    ],
  }));

  assert.equal(result.analysisUpdate.recommended_strategy, 'USE_20_MIN_WINDOW');
  assert.equal(result.momentRows.length, 1);
  assert.equal(result.momentRows[0].clip_moment_id, 'CM-VID-video1234567-W0');
  assert.equal(result.momentRows[0].ssemble_status, 'PENDING');
});

test('high risk source requires manual approval before Ssemble', () => {
  const result = parseAndGate({ ...baseRow, source_risk: 'high' }, ai());

  assert.equal(result.candidateUpdate.processing_status, 'ANALYZED');
  assert.equal(result.momentRows[0].ssemble_status, 'AWAITING_MANUAL_APPROVAL');
});
