# Short Videos Pipeline Architecture

The pipeline is a Google-Sheets-driven n8n system. Each workflow reads rows in one state, writes the next state, and can be rerun safely.

## Workflow Chain

1. WF1 `Source Channel Registry`: resolves YouTube channel URLs into channel IDs and uploads playlist IDs.
2. WF2 `Video Fetch`: fetches new and backfill videos from uploads playlists, deduping by `youtube_video_id`.
3. WF3 `Validity Check`: rejects short, live, music, or weak candidates before transcript work.
4. WF4 `Transcript Fetch`: calls the transcript Lambda and writes `Transcript_Analysis`.
5. WF5 `AI Transcript Analysis`: uses OpenAI to score transcripts and write `Clip_Moments`.
6. WF6 `Ssemble Dispatch`: reserves each pending moment, enforces the daily credit budget, then calls Ssemble.
7. WF7 `Ssemble Webhook Receiver`: receives fast Ssemble callbacks and creates `Created_Clips`.
8. WF8 `Drive Storage Transform`: downloads clips, uploads to Drive, and uses OpenAI to create a transformation plan.
9. WF9 `Review Queue Digest`: emails clips waiting for review.
10. WF10 `Error Handler`: records workflow errors to `Error_Log`.

## State Machine

`Candidate_Videos.processing_status`:

- `NEW` -> WF3 marks `validity_status=VALID`, `REJECTED`, or `FLAGGED`.
- `VALID` rows flow through WF4 transcript fetch.
- WF5 marks rows `ANALYZED` or `SKIPPED`.

`Clip_Moments.ssemble_status`:

- `PENDING` -> WF6 reserves and submits to Ssemble.
- `SUBMITTED` -> WF7 marks `COMPLETED` or `ERROR`.
- `AWAITING_MANUAL_APPROVAL` waits for a manual flip to `PENDING`.
- `ERROR` can be reset manually to `PENDING` when retrying is appropriate.

`Created_Clips.review_status`:

- `AWAITING_DOWNLOAD` -> WF8 stores in Drive and marks `NEEDS_REVIEW`.
- `NEEDS_REVIEW` -> human review sets `APPROVED` or `REJECTED`.

## Credit Controls

WF5 saves Ssemble credits before dispatch:

- Skips episodes with score below 7.
- Skips high rights or monetization risk.
- Caps exact clips to the top 3.
- Requires at least 3 strong clips inside a 20-minute window before using window mode.
- Routes high-risk sources to `AWAITING_MANUAL_APPROVAL`.

WF6 is the only workflow that spends Ssemble credits:

- Default `DAILY_BUDGET` is 10.
- Budget day uses the Africa/Nairobi calendar day.
- `SUBMIT_FAILED` rows are excluded from credit spend.
- Every request is first written as a `RESERVED` row in `Ssemble_Jobs`.
- Any non-`SUBMIT_FAILED` job row blocks duplicate dispatch for that `clip_moment_id`.
- Sub-60s exact clips are padded to 60 seconds.
- Over-1200s requests are capped to 1200 seconds.
- Exact clips use `noClipping: true`.

## Idempotency

- WF2 dedups videos by `youtube_video_id`.
- WF4 writes transcript rows by deterministic `analysis_id`.
- WF5 writes clip moments by deterministic `clip_moment_id`.
- WF6 uses `clip_moment_id` reservations to prevent duplicate Ssemble spend after partial failures.
- WF7 writes created clips by deterministic `created_clip_id`.
- WF8 saves Drive IDs immediately after upload and reuses them on retries.

## Human Boundary

Automated:

- discovery
- validation
- transcript fetch
- AI analysis
- Ssemble dispatch
- webhook ingestion
- Drive storage
- transformation planning
- review digest

Manual:

- source channel selection
- resolving `FLAGGED` candidates
- approving `AWAITING_MANUAL_APPROVAL` moments
- final clip review
- copying approved clips to `Approved_For_Posting`
- posting to YouTube, TikTok, Instagram, or Facebook

Posting workflows are intentionally out of scope for this phase.
