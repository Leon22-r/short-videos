# Replace Google Sheets with Supabase as the pipeline store

**Status:** Design in progress. Sections 1 and 2 drafted; Sections 3 and 4 not
yet written. **Not ready for an implementation plan.**

**Resume at:** Section 3 (the approval UI). Section 2 was presented in chat but
not explicitly approved — re-confirm it before moving on.

**Classification:** architectural (restructures how every workflow stores state).

**Motivation, in the user's words:** "google sheet's i have to reauthenticate
every few weeks". Google OAuth refresh tokens expire; a Postgres connection
string does not. Everything below serves that one goal.

---

## Current state, measured

- **65 Google Sheets nodes** across all 16 workflows. Sheets is not a side
  store, it is the pipeline's entire state machine.
- **13 tabs**, forming a status-column state machine: `Source_Channels` →
  `Candidate_Videos` → `Transcript_Analysis` → `Clip_Moments` →
  `Created_Clips` → `Render_Jobs` → `Approved_For_Posting` → `Publishing_Jobs`.
  Each workflow reads rows in one status and writes the next.
- Column-by-column structure is documented in
  `domains/short-videos/docs/google-sheets-structure.md` (236 lines). That
  document is the schema source of truth for this migration.
- **A precedent already exists.** `Publishing_Jobs` has a Postgres twin,
  `short_videos.publishing_jobs`, with atomic claim queries under
  `FOR UPDATE SKIP LOCKED` and a migrations runner. The Postiz work moved the
  queue to Postgres and kept the Sheet as an operator-facing mirror.
- **The workflows are generated**, not hand-written:
  `domains/short-videos/workflow-code/create-*.js`. There is a `sheet()` helper
  emitting Google Sheets nodes and a `postgresSql()` helper that reads a `.sql`
  file and embeds it in a Postgres node. This is why 65 nodes is a small diff.
- As of 2026-10-08 the heavy n8n instance holds the 16 workflows (imported,
  **all inactive**), zero credentials, and `publishing_jobs` has zero rows.
  Nothing is in flight.

---

## Decisions taken (all confirmed by the user)

| # | Decision | Consequence |
|---|---|---|
| D1 | **Build a small web UI** for the human-edited tables | No Google credential survives anywhere, which is the actual goal |
| D2 | **Supabase is the single store** | Managed backups and a serverless UI, paid for in internet latency per operation |
| D3 | **Start fresh; archive the Sheets** | No export, no type coercion; derived tables refill themselves |
| D4 | **UI covers approvals + adding source channels** | Two screens. Rare edits use the Supabase dashboard |
| D5 | **UI is private on the tailnet** | No login to build — the network is the authentication |
| D6 | **Proper types and NULLs**, not the `text NOT NULL DEFAULT ''` convention | Requires rewriting the publishing-queue SQL, free data-wise at zero rows |
| D7 | **Rename the legacy `ssemble_*` columns** | `ssemble_status` → `download_status`, `ssemble_job_id` → `download_job_id` |

Approach chosen: **A — schema and generators in one pass, verified by a vertical
slice.** Write all tables as migrations, swap the `sheet()` helper for a table
helper, regenerate all 16 workflows, then prove it by running WF1 → WF2 → WF3
live before activating anything downstream. The state machine is never split
across two stores.

Approaches rejected: a vertical slice with Sheets and Postgres coexisting (the
state machine would span two stores mid-chain, and Google reauth would continue
for weeks — the original complaint, unsolved); and Postgres-first with a Sheets
export for comfort (puts a Google credential straight back).

---

## Section 1 — Data model (drafted)

**12 tables, not 13.** `Ssemble_Jobs` is dead — the structure doc says "legacy
tab retained for older Ssemble rows only. The active yt-dlp WF6 path does not
write this tab." Starting fresh means it is never created. `publishing_jobs`
makes the 13th, moved to Supabase with the rest.

Existing `*_id` values are already deterministic text keys (`YTDLP-<clip_moment_id>`,
`publish_id`), so they stay `text` primary keys. No surrogate serials. String
references between tabs become real foreign keys.

**Three things the move deletes rather than ports:**

1. **The transcript truncation, and a Google Drive dependency with it.**
   `transcript_text` is truncated to ~45,000 chars with a `...[TRUNCATED]`
   marker purely because Sheets cells cap at 50,000, and
   `transcript_full_url` / `transcript_full_file_id` exist to stash the real
   transcript in Drive and read it back. Postgres `text` is unbounded: store the
   full transcript, drop the truncation, drop the Drive round trip, drop both
   columns.
2. **The percentage columns.** `like_percentage`, `comment_percentage`,
   `engagement_percentage` are "decimal percentages for sheet `%` formatting",
   with WF3 writing `0` when views are zero. They become `numeric`, NULL when
   undefined.
3. **Stringly-typed everything.** `active_status` `TRUE`/`FALSE` → `boolean`;
   `created_at` → `timestamptz`; `ai_json_output`, `transformation_plan`,
   `request_payload` → `jsonb`; the newline-separated lists
   (`alternative_titles`, `on_screen_text_beats`, `broll_plan`,
   `originality_checklist`) → `text[]`. Every documented status column gets a
   `CHECK` constraint from its state machine, so `processing_status` can only
   hold `NEW`, `ANALYZED`, `SKIPPED`, `CLIPPING`, `DONE`.

**Per D6**, the `text NOT NULL DEFAULT ''` convention goes. It existed because
Sheets sends empty strings and never NULL. This also retires
`short_videos.safe_schedule_at()`, whose only job is turning an unparseable date
string into `infinity` so it never becomes due — with `timestamptz` the bad
value cannot be stored at all. **This requires rewriting the publishing-queue
SQL in `domains/short-videos/postgres/queries/`, including the atomic claim
query, which is the most correctness-sensitive SQL in the repo.**

**One constraint worth adding:** `Channel_Branding` currently relies on WF8c
checking at render time that exactly one active branding row exists for the
niche, and a missing or duplicate row is a hard render failure discovered
mid-render. A unique partial index on `(niche) WHERE active_status` moves that
failure to write time.

**Still to do in this section:** write the actual DDL, column by column, against
the structure doc. Decide enum-vs-CHECK (CHECK recommended: no migration pain
when a status value is added). Decide the schema name — `short_videos` already
exists and is the obvious home.

---

## Section 2 — How n8n reaches Supabase (drafted, NOT yet approved)

**The Postgres node, not the Supabase node.** n8n ships both. The Supabase node
speaks PostgREST, which cannot express `FOR UPDATE SKIP LOCKED` — exactly how
WF12 atomically leases a publishing job. One access pattern for everything, full
SQL, and the existing `postgres/queries/*.sql` files keep working.

**The generator change is one helper.** Replace calls to `sheet(operation,
sheetName, extra)` with the existing `postgresSql()` pattern. Three Sheets
operations are in use:

| Sheets today | SQL |
|---|---|
| `read` / lookup | `SELECT` |
| `append` | `INSERT` |
| `appendOrUpdate` on a deterministic key | `INSERT ... ON CONFLICT (key) DO UPDATE` |

The third row is a **correctness win, not a translation.** Sheets'
`appendOrUpdate` is read-then-write — two round trips with a gap where a
concurrent run duplicates a row. The pipeline leans on it heavily ("WF2 dedups
on `youtube_video_id`; WF4/WF5/WF6 write via appendOrUpdate on deterministic
keys"). `ON CONFLICT` against a real unique constraint is one atomic statement,
so the dedup stops being a convention and becomes enforced.

**Fair-share stays in JavaScript.** `pickFairBySource` / `pickFairByGroup` run
as Code nodes and are covered by existing tests. They could become SQL window
functions; there is no reason to rewrite tested logic in the same change that
moves the store. They get fed rows from a `SELECT` instead of from Sheets.

**Credential and connection.** One n8n Postgres credential on the heavy
instance holding the Supabase connection string, never in workflow JSON — the
same rule the repo already applies to document IDs. `SUPABASE_DATABASE_URL` in
`hosts/.env` as a `:?`-required variable for the UI.

The local Postgres **stays**, serving the `whatsapp-access` domain. It stops
holding short-videos data.

### Open question — verify before the spec names a port

Supabase exposes a direct connection (5432) and a pooler (6543). To the best of
my knowledge the direct endpoint is IPv6-only unless the IPv4 add-on is enabled,
while the pooler is reachable over IPv4 — and from inside a Docker container on
a 4 GB box that decides whether it connects at all. It also matters for the
queue: transaction-mode pooling is fine for a single `FOR UPDATE SKIP LOCKED`
statement but breaks session-level features.

**This is unverified.** Confirm against the actual Supabase project before the
spec commits to a port or a pooling mode. Do not take the paragraph above as
fact.

---

## Section 3 — The approval UI (NOT WRITTEN)

Needs designing. Known constraints from the decisions:

- Two screens (D4): a review queue of clips awaiting approval, each with the
  video playable inline and approve/reject controls; and a form to add a source
  channel (`source_id`, `niche`, `source_name`, `youtube_channel_url` — WF1
  fills in `youtube_channel_id` and `uploads_playlist_id`).
- Private on the tailnet (D5), so no auth, no sessions, no RLS policies. The
  Supabase service key is held server-side and never shipped to a browser.
- Runs in the existing compose stack, which means a `mem_limit` on a 4 GB box
  where the current prod cap total is already 2944 MB. Budget for it.
- Open: framework, how the clip video is served for preview (the clip lives in
  Google Drive today — does the UI proxy it, and does that reintroduce a Google
  credential?). **That last point needs care: it could quietly undo D1.**
- Which host does it sit on, `heavy` or `public`? It is operator-facing and
  tailnet-only, which argues for a third thing rather than either, since
  `public` is internet-facing and `heavy` holds every credential.

## Section 4 — Migration, testing and rollback (NOT WRITTEN)

Needs designing. Known pieces:

- Tests should assert **zero `googleSheets` nodes survive** anywhere in
  `domains/short-videos/workflows/` — the regenerated output makes that
  checkable rather than aspirational.
- The 16 workflows are regenerated from the generators, so the diff to review is
  the generators plus the SQL files, not 16 JSON files.
- Vertical-slice verification: WF1 → WF2 → WF3 live before activating
  downstream. 12 of the 16 workflows carry schedule triggers, so activation
  order matters and all 16 are currently inactive.
- Rollback: the Sheets workbook is archived and untouched (D3), so reverting
  means reverting the commit and re-binding the Google credential. Worth stating
  explicitly in the spec.
- `domains/short-videos/docs/google-sheets-structure.md` becomes obsolete and
  should be replaced by a schema document, not left to rot.
- The existing publishing-queue tests
  (`domains/short-videos/tests/publishing-postgres.test.js`,
  `postiz-postgres-integration.test.js`) exercise real Postgres. They will need
  to point at the new schema shape per D6.

---

## Process state

The `superpowers:brainstorming` architectural path is: questions → approaches →
sectioned design with approval per section → written spec → spec self-review →
user approves the spec → `superpowers:writing-plans`.

Completed: context exploration, five clarifying questions, three approaches with
approach A chosen, Section 1 (approved via the D6/D7 decisions), Section 2
(presented, approval not given).

**Do not jump to `writing-plans` from here.** Sections 3 and 4 do not exist, and
the spec gate requires a design the user has approved in full. Resume by
re-confirming Section 2, then designing Section 3.
