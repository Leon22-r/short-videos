# WF5 Structured Output Design

## Scope

Make WF5 produce and persist one bare transcript-analysis object reliably. Eliminate Markdown-fence failures and model-level wrapper drift while retaining bounded compatibility with historical OpenAI Responses payloads.

## Canonical Analysis Contract

The model output is the bare analysis object:

```json
{
  "overall_episode_score": 8.5,
  "recommended_strategy": "USE_20_MIN_WINDOW",
  "reason_for_strategy": "...",
  "best_20_min_window": {
    "use_this": true,
    "start_sec": 0,
    "end_sec": 1200,
    "why_this_window": "...",
    "estimated_number_of_good_clips": 5
  },
  "exact_clips": [],
  "risk_notes": "low"
}
```

The model must not add an `output` wrapper or Markdown code fence. Every response must contain all required fields. For `SKIP_THIS_VIDEO`, `best_20_min_window` remains complete with `use_this=false`, numeric zero values, an empty explanation, and an estimate of zero.

## OpenAI Node

Configure the n8n OpenAI Responses node to use JSON-schema structured output with the bare analysis schema. The request should enforce the schema at the provider boundary instead of relying on prose instructions alone.

The n8n node will still return its transport envelope:

```text
output[] -> message -> content[] -> output_text.text
```

That envelope is not part of the model contract and must never be stored as successful `ai_json_output`.

## Parsing and Compatibility

Parsing has two stages:

1. Extract text from the n8n/OpenAI transport envelope.
2. Parse and validate the canonical analysis object.

For bounded backward compatibility, the parser also accepts:

- a complete legacy Markdown-fenced JSON block;
- a legacy model-level `{ "output": analysis }` wrapper;
- arrays added by n8n around transport messages.

The parser will not guess missing fence boundaries, concatenate fragments, remove arbitrary trailing text, or repair malformed JSON. Such inputs remain retryable failures with the raw transport response retained for diagnosis.

Legacy responses that put `risk_notes` beside the model-level `output` wrapper are invalid. They must retry rather than silently relocating fields.

## Validation

Validation requires:

- every top-level analysis field;
- a complete `best_20_min_window` object;
- an array for `exact_clips`;
- complete required fields for every exact clip;
- allowed strategy, recommendation, and risk enum values;
- finite numeric values for scores and timestamps.

Existing business gates remain responsible for score thresholds, risk thresholds, window duration, estimated clip count, and exact-clip selection.

## Persistence

- Successful `ai_json_output` stores only `JSON.stringify(validatedAnalysis)`.
- Retry failures keep the raw OpenAI/n8n envelope in `ai_json_output` and a bounded diagnostic in `reason_for_strategy`.
- Retry failures leave the AI score and strategy empty and preserve candidate status.

## Tests

Add regression fixtures for all five supplied payload classes:

1. Complete fenced legacy output with misplaced `risk_notes`: retry with a missing-field diagnostic.
2. Missing closing fence: retry with a JSON/fence diagnostic.
3. Complete fenced exact-clip output: parse successfully.
4. Complete fenced window output: parse successfully and persist the bare object.
5. Legacy SKIP output with an empty window object: reject under full validation.

Also test canonical structured output without fences or a model wrapper, n8n envelope extraction, generator/workflow JSON parity, and the configured OpenAI JSON schema.

## Deployment Verification

Regenerate `05-ai-transcript-analysis.json`, import it into the local n8n 2.25.7 runtime, reactivate WF5, and export the live workflow to verify the deployed parser and structured-output configuration match the repository artifact. Execute one known transcript and confirm the sheet contains a bare analysis object and no retry diagnostic.
