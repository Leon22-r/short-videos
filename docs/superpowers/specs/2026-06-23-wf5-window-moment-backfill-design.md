# WF5 Window Moment Backfill Design

## Scope

Ensure every successful `USE_20_MIN_WINDOW` analysis has exactly one corresponding `Clip_Moments` window row. Repair historical gaps without another AI request and make future append failures self-healing on the next scheduled WF5 run.

## Window Contract

`USE_20_MIN_WINDOW` does not require exact AI-selected clips. Its `exact_clips` array may be empty because WF6 sends the selected window to Ssemble with automatic clipping enabled.

Each successful window analysis owns one deterministic row:

```text
clip_moment_id = CM-<video_id>-W0
rank = 0
start_sec/end_sec = recommended window bounds
strategy = USE_20_MIN_WINDOW
final_recommendation = clip
ssemble_status = PENDING or AWAITING_MANUAL_APPROVAL
```

The row represents the Ssemble request range, not an individual finished clip.

## Normal Analysis Path

`parseAndGate()` remains responsible for emitting the synthetic window row immediately when it accepts a window strategy. The existing deterministic ID and `appendOrUpdate` Sheets operation make retries idempotent.

Tests will pin that a valid window response with `exact_clips: []` emits exactly one complete row matching the documented `Clip_Moments` columns.

## Integrity Backfill

WF5 will read `Clip_Moments` once per scheduled run and build a set of existing `clip_moment_id` values. A separate repair branch will select `Transcript_Analysis` rows where:

- `recommended_strategy` is `USE_20_MIN_WINDOW`;
- `ai_episode_score` is present;
- `recommended_start_sec` and `recommended_end_sec` form a 60–1200 second window;
- `CM-<video_id>-W0` is absent from `Clip_Moments`.

The repair branch reconstructs the missing row without calling OpenAI. It uses:

- transcript analysis ID/video/niche/video URL and recommended bounds;
- `reason_for_strategy` as a fallback window description;
- parsed `ai_json_output.best_20_min_window` for `why_this_window` and estimated clip count when available;
- stored `rights_risk` and clamped AI score;
- Source/Candidate joins to restore `AWAITING_MANUAL_APPROVAL` for high-risk sources.

The reconstructed row is written through `appendOrUpdate` using `clip_moment_id`. Repeated scheduled runs therefore do not create duplicates.

## Workflow Shape

Add one execute-once `Read Clip_Moments` node after the existing reads. It feeds both:

1. the normal `Pick Unanalyzed` analysis loop;
2. `Build Missing Window Moments -> Backfill Clip_Moments`.

The repair branch is independent of OpenAI availability and does not change candidate status. A temporary Sheets failure leaves the row missing, so the next scheduled run selects it again.

## Score Validation

The structured-output schema will constrain `overall_episode_score`, `clip_score`, and `originality_score` to `0–10`. Runtime validation will enforce those bounds for legacy or direct object inputs. Existing historical scores above 10 are clamped when constructing a repair row, but future AI responses outside the range become retryable validation failures.

## Tests

Add focused tests proving:

- a valid window analysis with empty `exact_clips` produces one schema-complete window row;
- missing historical window rows are reconstructed;
- existing `CM-<video_id>-W0` rows are not reconstructed;
- invalid or skipped analysis rows are ignored;
- malformed historical `ai_json_output` falls back to stored analysis columns;
- high-risk sources produce `AWAITING_MANUAL_APPROVAL`;
- scores outside `0–10` fail validation while historical repair scores are clamped;
- generated WF5 includes the execute-once read and independent append-or-update repair branch.

## Deployment Verification

Regenerate WF5, import it while preserving live credentials, publish it, restart n8n, and export the live workflow to confirm the repair nodes and connections. Run one scheduled/manual execution and verify previously missing deterministic window rows appear in `Clip_Moments` without new OpenAI calls for those repaired analyses.
