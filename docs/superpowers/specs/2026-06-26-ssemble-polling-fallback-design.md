# Ssemble Polling Fallback Design

Date: 2026-06-26

## Goal

Add a fallback workflow that checks submitted Ssemble jobs when the webhook does not arrive. The webhook remains the fast path. Polling only reconciles stale `SUBMITTED` jobs so the pipeline can still create `Created_Clips` and continue to WF8 without manually simulating callbacks.

## Current State

WF6 submits clip requests to Ssemble and writes accepted requests to `Ssemble_Jobs` with `job_status=SUBMITTED`, `webhook_received=FALSE`, and the Ssemble `requestId` in `ssemble_job_id`.

WF7 receives Ssemble webhooks and updates:

- `Ssemble_Jobs`: `COMPLETED` or `FAILED`, `webhook_received=TRUE`
- `Clip_Moments`: `COMPLETED` or `ERROR`
- `Created_Clips`: one row per generated short, keyed by `created_clip_id=CC-<short.id>`

The fallback workflow must produce the same final rows as WF7 so downstream workflows do not care whether completion came from webhook or polling.

## Ssemble API Contract

The workflow uses these documented endpoints:

- `GET https://aiclipping.ssemble.com/api/v1/shorts/:id/status`
  - Checks a request created by `POST /shorts/create`.
  - Status values include `queued`, `processing`, `completed`, `failed`, and `cancelled`.
  - `completed`, `failed`, and `cancelled` are terminal states.
  - On `failed`, `failureReason` may be present.
- `GET https://aiclipping.ssemble.com/api/v1/shorts/:id`
  - Retrieves generated shorts and their video URLs.
  - Call this only after status is `completed`; before completion, the `shorts` array may be empty or incomplete.
- Webhooks retry only a few times and are abandoned if the receiver does not respond with a 2xx status, but the completed clips remain retrievable through `GET /shorts/:id`.

Source docs:

- https://www.ssemble.com/docs/endpoints/get-status
- https://www.ssemble.com/docs/endpoints/get-shorts
- https://www.ssemble.com/docs/webhooks
- https://www.ssemble.com/docs/rate-limits

## Recommended Architecture

Create a new workflow:

`WF7b Ssemble Polling Fallback`

Trigger:

- Schedule every 15 minutes.

Selection rule:

- Read `Ssemble_Jobs`.
- Select rows where:
  - `job_status = SUBMITTED`
  - `webhook_received != TRUE`
  - `created_at <= now - 30 minutes`
  - `ssemble_job_id` is present

The 30-minute age gate gives the webhook enough time to be the normal path and avoids unnecessary API checks.

## Workflow Flow

```text
Schedule 15m
  -> Read Ssemble_Jobs
  -> Pick stale submitted jobs
  -> Loop over picked jobs
      -> Re-read or re-check latest Ssemble_Jobs state
      -> Skip if webhook_received=TRUE or job_status is no longer SUBMITTED
      -> GET /shorts/:id/status
      -> Route by status
          queued/processing:
            leave rows unchanged
          completed:
            GET /shorts/:id
            normalize result to WF7 completed shape
            update Ssemble_Jobs as COMPLETED, webhook_received=TRUE
            update Clip_Moments as COMPLETED
            appendOrUpdate Created_Clips by created_clip_id
          failed/cancelled:
            normalize failure to WF7 failed shape
            update Ssemble_Jobs as FAILED, webhook_received=TRUE
            update Clip_Moments as ERROR
```

## Idempotency

The fallback must use existing deterministic keys:

- `Ssemble_Jobs`: match by `ssemble_job_id`
- `Clip_Moments`: match by `clip_moment_id`
- `Created_Clips`: match by `created_clip_id=CC-<short.id>`

Before each status call, the workflow should re-check the current job state from `Ssemble_Jobs`. If WF7 has already processed the webhook, the poller skips the job. This prevents duplicate writes when the webhook and poller overlap.

When writing clips, use `appendOrUpdate` on `Created_Clips.created_clip_id`. This makes repeated polling safe if a run is retried after partially writing results.

## Shared Helper Design

Reuse the same helper logic as WF7 where possible:

- `shapeJobCompleted`
- `shapeJobFailed`
- `shapeMomentStatus`
- `explodeCreatedClips`

Add a polling-specific normalizer that converts `GET /shorts/:id` into the same internal shape that WF7 currently gets from `shorts.completed` webhooks:

```js
{
  completed: true,
  requestId,
  timestamp,
  shorts,
  failureReason: '',
  raw
}
```

For failures or cancellations, normalize to:

```js
{
  completed: false,
  requestId,
  timestamp,
  shorts: [],
  failureReason,
  raw
}
```

Cancelled requests should map to `job_status=FAILED` and `Clip_Moments.ssemble_status=ERROR`, with `error_message` explaining that Ssemble returned `cancelled`.

## Error Handling

The Ssemble status and result HTTP nodes should use:

- Ssemble API Header Auth credential with `X-API-Key`
- `retryOnFail=true`
- `maxTries=3`
- `waitBetweenTries=5000`

HTTP failure handling:

- `404`: mark the job as `FAILED` only if the request ID is definitely invalid or missing from the account; otherwise log and leave as `SUBMITTED` for manual inspection.
- `429`: leave the job as `SUBMITTED`; retry on the next scheduled run.
- `5xx` or timeout: leave the job as `SUBMITTED`; retry on the next scheduled run.
- malformed completed response with no `shorts`: leave the job as `SUBMITTED` and log an error, because the Ssemble docs warn that premature result calls can be incomplete.

Production deployment should use the existing workflow-level error handler so unexpected workflow failures are written to `Error_Log`.

## Data Model Changes

No required Google Sheet columns are needed for the first version.

Optional future columns if operational visibility becomes necessary:

- `last_polled_at`
- `poll_attempt_count`
- `last_poll_status`

These are intentionally out of scope for the first implementation to avoid sheet migration unless the fallback proves noisy.

## Testing Plan

Unit tests:

- Poll selection picks only stale `SUBMITTED` jobs older than 30 minutes.
- Jobs already marked `webhook_received=TRUE` are skipped.
- `queued` and `processing` leave rows unchanged.
- `completed` status plus `GET /shorts/:id` produces the same `Ssemble_Jobs`, `Clip_Moments`, and `Created_Clips` shapes as WF7.
- `failed` and `cancelled` close the job and moment as failed/error.
- Repeated completed polling does not duplicate `Created_Clips`.

Workflow verification:

- Generated workflow JSON is valid.
- WF7b has the expected connections.
- Ssemble credential is attached to both HTTP nodes.
- Manual test can pin one stale `SUBMITTED` job and mock Ssemble status/result responses before using a real Ssemble request.

## Out Of Scope

- Removing WF7 webhook handling.
- Changing WF6 dispatch behavior or daily budget logic.
- Downloading clips to Drive; WF8 remains responsible for that.
- Using Ssemble list endpoints for bulk reconciliation. Per-job status checks are simpler and bounded by the sheet selection rule.
