# SDD Progress — n8n Video Pipeline

## Postiz migration — 2026-09-21

- [x] Joint plan and independent review in Agent Room AM-XHPN.
- [x] Opt-in Postiz handoff, immutable routing, durable submission intent and bounded result reconciliation.
- [x] Regenerate WF11–WF14; document setup, failure recovery and rollback.
- [x] Pass 210 tests including real isolated Postgres migration/race/recovery checks.
- [ ] Deploy migration, bind credentials/endpoint/error workflow, validate imported n8n connections and run authorized live delivery tests.

See `docs/superpowers/plans/2026-09-21-postiz-publishing-migration.md` and `docs/postiz-publishing.md`. Implementation is local and uncommitted; production activation was not performed.

## Current worktree delivery

Branch: `feat/n8n-video-pipeline-phase1`

- [x] Replace the Ssemble dispatch/webhook path with exact-range `yt-dlp` downloads in WF6.
- [x] Add the WF8c FFmpeg render queue, local job workspace, Drive upload, and render status trail.
- [x] Add WF11-WF14 publishing queue scaffolding and deterministic publishing job IDs.
- [x] Finish publishing hardening: fail-closed approval/platform gates, due-time selection, recoverable worker leases, deterministic retry exhaustion, and destination-specific IDs.
- [x] Add a self-starting, Neon-compatible Postgres publishing queue with atomic multi-worker claims and Google Sheets mirroring.
- [ ] Bind credentials and runtime-only document/folder IDs in the target n8n instance, then validate workflows and inspect their saved connections.
- [ ] Run controlled provider tests. Local/unit validation is not evidence of live upload, processing, publication, OAuth entitlement, or app-audit approval.

Production publishing remains disabled until the relevant platform path reaches its documented terminal state in a controlled live test. YouTube and Meta must return confirmed media IDs/URLs; TikTok inbox delivery remains a manual creator handoff, with its tracking ID kept separate from any public post ID. Until then, keep destinations disabled or use private/draft/manual modes.

## Historical delivery — Channel Health Ranking Feature

## Starting commit: eee494c

## Tasks
- [x] Task 1: Schema docs — new columns for Source_Channels (5) and Transcript_Analysis (1) (commit 7d30173, review clean)
- [x] Task 2: Create channel-health-check.js + tests (commit 2284260, review clean)
- [x] Task 3: Extend WF5 (write source_id, re-enable detect, health check nodes) (commit 6ec6242, review clean — 2 minor notes: duplicate require, doubled rejection_reason fallback)
- [x] Task 4: Extend WF9 digest (auto-paused channels section) (commit 806fa55, review clean)
- [x] Fix: stale snapshot bug in Shape Candidates To Skip (commit fe27d69) — excludes current-run video IDs via Pick Unanalyzed
