function exactClip(overrides = {}) {
  return {
    rank: 1,
    start_sec: 60,
    end_sec: 120,
    clip_length_seconds: 60,
    clip_score: 9,
    hook_first_2_seconds: 'You need to meet this founder.',
    core_idea: 'Education shaped the founder journey.',
    why_it_is_valuable: 'It provides an actionable entrepreneurship lesson.',
    best_target_audience: 'Aspiring Kenyan entrepreneurs',
    suggested_title: 'Education and entrepreneurship',
    suggested_caption: 'A practical founder lesson.',
    on_screen_text: 'Education shapes opportunity',
    suggested_b_roll: ['Nairobi classroom'],
    my_original_commentary_angle: 'Connect education to local opportunity.',
    kenyan_african_application: 'Apply the lesson to Kenyan founders.',
    bible_verse_if_relevant: null,
    monetization_risk: 'low',
    copyright_or_reused_content_risk: 'low',
    does_it_need_extra_context: false,
    originality_score: 9,
    final_recommendation: 'clip',
    ...overrides,
  };
}

function analysis(overrides = {}) {
  return {
    overall_episode_score: 8.5,
    recommended_strategy: 'USE_20_MIN_WINDOW',
    reason_for_strategy: 'The video contains valuable entrepreneurship lessons.',
    best_20_min_window: {
      use_this: true,
      start_sec: 0,
      end_sec: 1200,
      why_this_window: 'This section contains a dense set of useful lessons.',
      estimated_number_of_good_clips: 5,
    },
    exact_clips: [
      exactClip({ rank: 1, start_sec: 60, end_sec: 120 }),
      exactClip({ rank: 2, start_sec: 180, end_sec: 250, clip_score: 8 }),
      exactClip({ rank: 3, start_sec: 420, end_sec: 500, clip_score: 8 }),
    ],
    risk_notes: 'low',
    ...overrides,
  };
}

function responseEnvelope(text, id = 'msg_fixture') {
  return [{
    output: [{
      id,
      type: 'message',
      status: 'completed',
      content: [{
        type: 'output_text',
        annotations: [],
        logprobs: [],
        text,
      }],
      role: 'assistant',
    }],
  }];
}

const windowAnalysis = analysis();
const normalizedWindowAnalysis = {
  ...windowAnalysis,
  best_20_min_windows: [windowAnalysis.best_20_min_window],
};
delete normalizedWindowAnalysis.best_20_min_window;
const multiWindowAnalysis = analysis({
  best_20_min_windows: [
    {
      use_this: true,
      start_sec: 0,
      end_sec: 1200,
      why_this_window: 'The opening has several founder lessons.',
      estimated_number_of_good_clips: 5,
    },
    {
      use_this: true,
      start_sec: 2400,
      end_sec: 3600,
      why_this_window: 'The later section has dense money lessons.',
      estimated_number_of_good_clips: 4,
    },
  ],
  best_20_min_window: undefined,
});
const exactAnalysis = analysis({
  recommended_strategy: 'USE_EXACT_CLIPS_ONLY',
  exact_clips: [exactClip()],
});
const skipWithEmptyWindow = analysis({
  overall_episode_score: 6.5,
  recommended_strategy: 'SKIP_THIS_VIDEO',
  best_20_min_window: {},
  exact_clips: [],
});

module.exports = {
  canonicalUnfenced: responseEnvelope(JSON.stringify(windowAnalysis), 'msg_canonical'),
  exactAnalysis,
  exactClip,
  multiWindowAnalysis,
  missingClosingFence: responseEnvelope(
    `\`\`\`json\n${JSON.stringify({ output: windowAnalysis })}`,
    'msg_missing_fence',
  ),
  misplacedRiskNotes: responseEnvelope(
    `\`\`\`json\n${JSON.stringify({
      output: { ...windowAnalysis, risk_notes: undefined },
      risk_notes: 'low',
    })}\n\`\`\``,
    'msg_misplaced_risk',
  ),
  responseEnvelope,
  normalizedWindowAnalysis,
  skipWithEmptyWindow: responseEnvelope(
    `\`\`\`json\n${JSON.stringify({ output: skipWithEmptyWindow })}\n\`\`\``,
    'msg_empty_window',
  ),
  validLegacyExact: responseEnvelope(
    `\`\`\`json\n${JSON.stringify({ output: exactAnalysis })}\n\`\`\``,
    'msg_legacy_exact',
  ),
  validLegacyWindow: responseEnvelope(
    `\`\`\`json\n${JSON.stringify({ output: windowAnalysis })} \n\`\`\``,
    'msg_legacy_window',
  ),
  structuredObject: responseEnvelope(windowAnalysis, 'msg_structured_object'),
  windowAnalysis,
};
