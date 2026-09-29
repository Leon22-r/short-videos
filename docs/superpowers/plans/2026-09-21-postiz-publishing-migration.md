# Postiz publishing migration

Agreed in Agent Room AM-XHPN by Codex and PostizReviewer on 2026-09-21.
User authorized joint planning followed by implementation. This plan covers repository implementation and local verification; deployment and real posting remain separate gates.

## Outcome and boundaries

Keep discovery, rendering, approvals and the transactional publishing queue. Add an opt-in Postiz delivery backend to WF12. Existing jobs remain DIRECT; newly created channels/jobs explicitly select POSTIZ and a Postiz integration ID. A job's backend and account mapping never change through Sheet synchronization. No automatic fallback between backends.

n8n owns due-time dispatch and pre-submission retries. Postiz receives one `type: now` post per deterministic queue job and owns subsequent platform delivery. n8n only reconciles the accepted Postiz post. Scheduled acceptance is not publication, and Postiz IDs are never represented as platform IDs.

## Durable contract

- Add `publishing_backend` (DIRECT default), `postiz_integration_id`, `postiz_post_id`, `postiz_media_id`, `postiz_media_path`, `postiz_submit_payload`, and `postiz_submitted_at`. The timestamp records submission intent, not proof of acceptance.
- Freeze backend/integration at insertion and all Postiz media, destination, schedule, content and payload once any Postiz stage exists. Existing direct checkpoints stay on the direct path.
- Validate the configured integration against the expected platform before uploading/submitting. Use one deployment-controlled Postiz endpoint and n8n credentials; never accept a credential destination URL from a Sheet row.
- Import a public HTTPS video into Postiz and durably store its media ID/path (`POSTIZ_MEDIA_READY`). Local/Drive-only media needs a public publishing URL before selecting this backend.
- Build the platform payload and atomically persist it with `POSTIZ_SUBMIT_REQUESTED` before making the create request. The transition is a single-winner compare-and-set, guarded by the current live lease. Disable automatic HTTP retries for create.
- Save the one returned Postiz ID only when the response matches the expected integration; then enter `POSTIZ_SUBMITTED` and poll. An uncertain response or restart after intent without a stored ID becomes a manual-reconciliation failure; never blindly resubmit or match by caption.
- Poll by persisted post and integration identity within the submission date range. Unknown/missing states cannot report success. Require PUBLISHED and a valid platform release URL for public-platform completion. TikTok remains upload/inbox only and reports DRAFT_UPLOADED, never public publication.
- Bound polls and keep post-submit failures poll-only. Preserve the external identifiers and intent on failure. WF14 cannot turn a durable intent into another create.
- Keep Postiz media paths, request snapshots and provider responses out of the Sheet mirror. WF13 reports Postiz credential health as NOT_CHECKED; expiry metadata is not an API health check.

## Ownership and sequence

1. **Baseline (complete):** clean main at 8f2d924, `npm test` passes 15 test files; current Postiz API docs and source inspected. Installed server version and live behavior are unverified.
2. **PostizReviewer:** additive SQL migration/init compatibility, queue synchronization protections, dedicated Postiz transition queries, regression and isolated real-Postgres tests. Owns `n8n/postgres/**`, `tests/publishing-postgres.test.js`, and a dedicated SQL integration test/harness.
3. **Codex:** Postiz contract helpers, opt-in job creation/health metadata, WF12 generated nodes and error routes, focused behavior/graph tests, generated exports and documentation. Owns `n8n/workflow-code/**`, `n8n/workflows/**`, remaining relevant tests and docs.
4. **Integration:** agree query signatures, regenerate exports, execute full local suite and isolated Postgres scenarios, inspect saved JSON connections and error branches. No shared-file writes across owners.
5. **Independent review:** reviewer critiques helper/workflow changes; Codex reviews SQL changes. Resolve findings, rerun affected checks, then record delivery status in the room.

## Verification

Cover opt-in and unsupported backend handling; approval/account/privacy gates; integration mismatch; media validation; response cardinality and identity; intent-before-network; crash and concurrent intent attempts; expired leases; Sheet mutation after checkpoints; QUEUE/DRAFT/ERROR/PUBLISHED and missing post results; platform ID separation; bounded polling and no re-create after intent; existing direct regressions; fresh and upgrade schema application.

No live n8n MCP tools are available in this session. Use repository node contracts and official source for static generation; report that runtime n8n validation/import and actual provider delivery remain unverified. Before activation: pin/check deployed Postiz version, bind credentials and endpoint, confirm workers, run controlled authorized end-to-end posts, and inspect imported workflow connections.

## Rollout and rollback

Keep direct jobs on their existing backend. Enable POSTIZ on a single new destination mapping first after live verification. Do not recreate old deterministic queue keys or switch in-flight jobs. To stop Postiz intake, disable the relevant channel; retain reconciliation for previously submitted jobs. A return to direct publishing requires accounting for every Postiz intent/accepted post first to prevent duplicates.

## References

- https://docs.postiz.com/public-api/posts/create
- https://docs.postiz.com/public-api/posts/list
- https://docs.postiz.com/public-api/uploads/upload-from-url
- https://github.com/gitroomhq/postiz-app/blob/main/apps/backend/src/public-api/routes/v1/public.integrations.controller.ts
- https://github.com/gitroomhq/postiz-app/blob/main/libraries/nestjs-libraries/src/database/prisma/posts/posts.repository.ts

## Completion evidence

Repository implementation and mutual review completed in room messages 18–19. `npm test` passed 210 tests, zero failures/skips, including isolated real PostgreSQL migration, claim/intent race and crash-recovery scenarios. `git diff --check` passed. WF11–WF14 exports were regenerated; helper/graph tests compile the Code nodes, exercise representative runtime data shapes and verify error-output connections.

Review refinements: freeze Postiz metadata from the first dispatch (even before a media checkpoint); validate snapshot integration and media at the SQL intent boundary; require MP4 media paths for Postiz's video selection; validate YouTube release paths; redact raw Postiz errors while preserving auth classification; parse persisted JSON-string TikTok settings. n8n HTTP/SQL parameter shapes were checked against official `n8n@2.25.7` source because live MCP validation was unavailable.

Delivery remains local and uncommitted. No production migration, n8n import/activation, credential binding, real Postiz request or platform publication was performed. Use `docs/postiz-publishing.md` for those deployment gates.
