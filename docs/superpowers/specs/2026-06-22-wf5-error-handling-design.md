# WF5 Error Handling and Window Contract

## Scope

Correct WF5 AI request construction, response validation, window gating, retry behavior, prompt consistency, and analysis-column mappings. Keep the workflow generator, generated JSON, helper module, and tests synchronized. Do not change unrelated workflows.

## AI Request

- Send exactly two OpenAI messages: one system message and one user message.
- Configure the OpenAI node to continue through its regular output when the API call fails.
- Use the same system prompt in the helper module and generated workflow.

## Prompt Contract

- Define every `start_sec` and `end_sec` value as raw seconds from the beginning of the source video.
- Include examples: minute 5 is `300`; a 20-minute duration is `1200` seconds.
- For `USE_20_MIN_WINDOW`, require `best_20_min_window.use_this=true`, a valid window, and at least three estimated good clips. `exact_clips` may be empty because Ssemble performs automatic clipping for window requests.
- For `USE_EXACT_CLIPS_ONLY`, require at least one exact clip whose `final_recommendation` is `clip`.

## Parsing and Gating

- Reject response shapes that do not contain an explicit `overall_episode_score` and the required analysis fields instead of coercing them to score zero.
- Keep episode score and risk gates.
- Accept `USE_20_MIN_WINDOW` only when:
  - `use_this` is true;
  - the window is between 60 and 1200 seconds inclusive;
  - `estimated_number_of_good_clips` is at least 3.
- Do not require `exact_clips` for window mode.
- Keep exact-clip filtering and final-recommendation enforcement for exact mode.

## Retryable Failures

API errors and malformed AI responses must not mark a video as skipped.

For a retryable failure, WF5 will:

- record a bounded error description in the analysis row;
- preserve `ai_episode_score` as empty so the row remains eligible for a later run;
- preserve the candidate's existing `processing_status`;
- emit no clip moments;
- continue the loop so later batch items still run.

The selected candidate row must carry its current processing status into the analysis loop so error handling can preserve it safely.

## Sheet Mappings

- Populate `permission_risk` from the AI copyright/reused-content assessment using the same conservative aggregate used for rights risk.
- Populate `kenya_relevance` from clip-level `kenyan_african_application` values, not `risk_notes`.
- Preserve `risk_notes` in `ai_json_output`; do not mislabel it as Kenya relevance.

## Tests

Add regression coverage proving:

- generated OpenAI messages contain exactly two complete entries;
- the OpenAI node has regular-output error continuation;
- helper and embedded system prompts match;
- raw-seconds and strategy rules appear in the prompt;
- valid window responses with empty `exact_clips` create one window moment;
- short windows and windows estimating fewer than three clips are rejected;
- unknown response shapes become retryable failures rather than skipped videos;
- retryable failures preserve candidate status and leave the score empty;
- `permission_risk` and `kenya_relevance` use their intended sources;
- regenerated workflow JSON matches the generator.

Run the focused WF5 tests first, then the complete Node test suite.
