# Replace Google Sheets with Supabase as the pipeline store

**Status:** Design complete. Sections 1–4 written and approved by the user.
Ready for `superpowers:writing-plans` once the user approves this document.

**Classification:** architectural (restructures how every workflow stores state).

**Motivation, in the user's words:** "google sheet's i have to reauthenticate
every few weeks". Google OAuth refresh tokens expire; a Postgres connection
string does not.

**Read the correction in D8 before accepting that framing.** Measurement during
design showed this migration alone does not end the reauthentication, because 8
`googleDrive` nodes survive it on the same OAuth clock. The migration is still
worth doing, for reasons restated in D8 — but the reauth is fixed by a consent
screen setting, not by this spec.

---

## Current state, measured

- **65 Google Sheets nodes** across all 16 workflows. Sheets is not a side
  store, it is the pipeline's entire state machine. Per workflow:

  | Workflow | Sheets nodes | Trigger |
  |---|---|---|
  | `01-source-channel-registry` | 2 | manual |
  | `02-video-fetch` | 4 | schedule |
  | `03-validity-check` | 3 | schedule |
  | `04-transcript-fetch` | 4 | schedule |
  | `05-ai-transcript-analysis` | 10 | schedule |
  | `06-yt-dlp-clip-download` | 6 | schedule |
  | `08-drive-storage-transform` | 6 | schedule |
  | `08b-created-clips-transform-backfill` | 2 | manual |
  | `08c-ffmpeg-render-final-clip` | 8 | schedule |
  | `08d-render-jobs-backfill` | 3 | manual |
  | `09-review-queue-digest` | 2 | schedule |
  | `10-error-handler` | 1 | error |
  | `11-build-publishing-jobs` | 6 | schedule |
  | `12-publish-to-platforms` | 5 | schedule |
  | `13-publishing-credential-health` | 2 | schedule |
  | `14-publishing-retry-scheduler` | 1 | schedule |

  12 schedule triggers, 3 manual, 1 error trigger. **All 16 are inactive.**
- **13 tabs**, forming a status-column state machine: `Source_Channels` →
  `Candidate_Videos` → `Transcript_Analysis` → `Clip_Moments` →
  `Created_Clips` → `Render_Jobs` → `Approved_For_Posting` → `Publishing_Jobs`.
  Each workflow reads rows in one status and writes the next. The remaining five
  tabs sit outside that chain: `Ssemble_Jobs` (legacy), `Music_Library`,
  `Channel_Branding`, `Error_Log` and `Publishing_Channels`.
- Column-by-column structure is documented in
  `domains/short-videos/docs/google-sheets-structure.md` (236 lines). That
  document is the schema source of truth for this migration, and is deleted by
  it (Section 4).
- **A precedent already exists.** `Publishing_Jobs` has a Postgres twin,
  `short_videos.publishing_jobs`, with atomic claim queries under
  `FOR UPDATE SKIP LOCKED`, 17 SQL files in
  `domains/short-videos/postgres/queries/`, and a migrations runner whose
  numbering currently stops at `003-postiz-publishing.sql`.
- **The workflows are generated**, not hand-written:
  `domains/short-videos/workflow-code/create-*.js`. There is a `sheet()` helper
  emitting Google Sheets nodes and a `postgresSql()` helper that reads a `.sql`
  file and embeds it in a Postgres node. This is why 65 nodes is a small diff.
- **The repo has zero npm dependencies.** `package.json` declares no
  `dependencies` and no `devDependencies`; tests run under `node --test` on
  Node 26. There is no bundler and no build step anywhere. This constrains
  Section 3.
- As of 2026-10-08 the heavy n8n instance holds the 16 workflows (imported, all
  inactive), zero credentials, and `publishing_jobs` has zero rows. Nothing is
  in flight. **This is the only reason the migration is cheap.**
- **No Supabase project exists yet.** `grep -ril supabase` over the repo hits
  only this spec.

---

## Decisions taken (all confirmed by the user)

| # | Decision | Consequence |
|---|---|---|
| D1 | **No Google Sheets credential survives.** The Drive credential remains; D8 covers its token lifetime | Narrower than the original D1, and accurate — see D8 |
| D2 | **Supabase is the single store** | Managed backups and a serverless UI, paid for in internet latency per operation |
| D3 | **Start fresh; archive the Sheets** | No export, no type coercion; derived tables refill themselves |
| D4 | **UI covers three human touchpoints** | Clip review, add source channel, high-risk moment approval |
| D5 | **UI is private on the tailnet** | No login to build — the network is the authentication |
| D6 | **Proper types and NULLs**, not the `text NOT NULL DEFAULT ''` convention | Requires rewriting the publishing-queue SQL, free data-wise at zero rows |
| D7 | **Rename the legacy `ssemble_*` columns** | `ssemble_status` → `download_status`, `ssemble_job_id` → `download_job_id` |
| D8 | **Fix the OAuth consent screen first, separately; keep this spec's scope** | The reauth is a consent-screen setting, not an architecture problem |
| D9 | **UI is a zero-dependency Node server over PostgREST**, with atomicity in a Postgres function | Matches the repo's no-dependency, no-build reality |
| D10 | **UI lives in a third host directory, `hosts/review/`** | Not on `public` (internet-facing), not on `heavy` (holds every credential) |
| D11 | **Clip preview is served by the operator's own browser session**, not proxied | The UI server holds exactly one secret: the Supabase key |

Approach chosen: **A — schema and generators in one pass, verified by a vertical
slice.** Write all tables as migrations, swap the `sheet()` helper for a table
helper, regenerate all 16 workflows, then prove it by running WF1 → WF2 → WF3
live before activating anything downstream. The state machine is never split
across two stores.

Approaches rejected: a vertical slice with Sheets and Postgres coexisting (the
state machine would span two stores mid-chain, and Google reauth would continue
for weeks — the original complaint, unsolved); and Postgres-first with a Sheets
export for comfort (puts a Google credential straight back).

### D8 in full — what the measurement changed

Node counts in `domains/short-videos/workflows/`:

```
 65  n8n-nodes-base.googleSheets    <- removed by this spec
  8  n8n-nodes-base.googleDrive     <- survives
 22  n8n-nodes-base.postgres
```

The 8 `googleDrive` nodes live in `04-transcript-fetch`,
`05-ai-transcript-analysis`, `06-yt-dlp-clip-download`,
`08-drive-storage-transform` and `08c-ffmpeg-render-final-clip`. Media storage
is Drive end to end: `Created_Clips.google_drive_file_id`,
`Render_Jobs.final_drive_file_id`, plus music and watermark assets. Drive uses
the same Google OAuth credential family as Sheets, so **removing Sheets does not
stop the reauthentication.**

The likely root cause is in `domains/short-videos/docs/credentials-setup.md:16`:

> Create an OAuth consent screen and add your account as a test user while
> local/staging is not published.

Google expires refresh tokens after 7 days for apps whose consent screen is in
**Testing** publishing status. A published-but-unverified app keeps them. That is
a console setting and zero code.

**Therefore:** publish the consent screen as a separate, immediate task, and
confirm the reauthentication actually stops. This spec proceeds on its own
merits, which the measurement did not weaken:

- `appendOrUpdate` is read-then-write, so the pipeline's dedup is a race
  (Section 2 replaces it with an enforced constraint).
- `transcript_text` is truncated at ~45,000 chars with a Drive round trip to
  recover the real value (Section 1 deletes both).
- Every status column is stringly typed with no constraint (Section 1 adds
  `CHECK`s).

Widening the spec to move media off Drive was considered and rejected for now:
it would add Supabase Storage or S3, rewrite 8 nodes, change WF8c's asset
download paths, and force a resolution to the unsolved `public_video_url`
question for TikTok/Instagram/Facebook. That is a separate spec.

---

## Section 1 — Data model

**12 tables, not 13.** `Ssemble_Jobs` is dead — the structure doc says "legacy
tab retained for older Ssemble rows only. The active yt-dlp WF6 path does not
write this tab." Starting fresh means it is never created. 13 tabs minus
`Ssemble_Jobs` is 12, and `publishing_jobs` is one of those 12 — it is Tab 13 in
the structure doc and already exists in the local Postgres, so for it the work
is a move to Supabase plus the D6 retyping, not a creation.

**Schema name: `short_videos`.** It already exists and holds `publishing_jobs`.

**Status columns use `CHECK` constraints, not `enum` types.** Adding a status
value to a `CHECK` is one `ALTER TABLE`; adding one to an `enum` used across
tables is a migration with ordering constraints. The state machine has gained
values before (`AWAITING_MANUAL_APPROVAL`, `RETRY_PENDING`) and will again.

Existing `*_id` values are already deterministic text keys
(`YTDLP-<clip_moment_id>`, `publish_id`), so they stay `text` primary keys. No
surrogate serials. String references between tabs become real foreign keys.

**Three things the move deletes rather than ports:**

1. **The transcript truncation, and a Google Drive dependency with it.**
   `transcript_text` is truncated to ~45,000 chars with a `...[TRUNCATED]`
   marker purely because Sheets cells cap at 50,000, and
   `transcript_full_url` / `transcript_full_file_id` exist to stash the real
   transcript in Drive and read it back. Postgres `text` is unbounded: store the
   full transcript, drop the truncation, drop the Drive round trip, drop both
   columns.
2. **The percentage columns' zero-instead-of-null convention.**
   `like_percentage`, `comment_percentage`, `engagement_percentage` are "decimal
   percentages for sheet `%` formatting", with WF3 writing `0` when views are
   zero. They become `numeric`, NULL when undefined. WF3's validity thresholds
   must then treat NULL as failing the threshold rather than comparing against
   `0`.
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
value cannot be stored at all. **This requires rewriting the 17 files in
`domains/short-videos/postgres/queries/`, including
`claim-next-publishing-job.sql`, which is the most correctness-sensitive SQL in
the repo.**

**One constraint worth adding:** `Channel_Branding` currently relies on WF8c
checking at render time that exactly one active branding row exists for the
niche, and a missing or duplicate row is a hard render failure discovered
mid-render. A unique partial index on `(niche) WHERE active_status` moves that
failure to write time.

**Column-by-column DDL is deliberately not in this spec.** It is mechanical
transcription of `google-sheets-structure.md` under the type rules above, 12
tables wide, and belongs in the implementation plan where each table is a
reviewable step. The decisions a plan cannot make for itself — schema name,
CHECK over enum, which columns die, which constraint is added, text primary
keys — are all fixed above.

---

## Section 2 — How n8n reaches Supabase

**The Postgres node, not the Supabase node.** n8n ships both. The Supabase node
speaks PostgREST, which cannot express `FOR UPDATE SKIP LOCKED` — exactly how
WF12 atomically leases a publishing job. One access pattern for everything, full
SQL, and the existing `postgres/queries/*.sql` files keep working.

(Section 3 gives the *UI* the opposite answer, and the reason they do not
conflict is stated there: the UI never needs a row lock, and a Postgres driver
would cost the repo its first dependency.)

**The generator change is one helper.** Replace calls to `sheet(operation,
sheetName, extra)` with a `table()` helper following the existing
`postgresSql()` pattern. Three Sheets operations are in use:

| Sheets today | SQL |
|---|---|
| `read` / lookup | `SELECT` |
| `append` | `INSERT` |
| `appendOrUpdate` on a deterministic key | `INSERT ... ON CONFLICT (key) DO UPDATE` |

The third row is a **correctness win, not a translation.** Sheets'
`appendOrUpdate` is read-then-write — two round trips with a gap where a
concurrent run duplicates a row. The pipeline leans on it heavily (WF2 dedups on
`youtube_video_id`; WF4/WF5/WF6 write via `appendOrUpdate` on deterministic
keys). `ON CONFLICT` against a real unique constraint is one atomic statement,
so the dedup stops being a convention and becomes enforced.

**Fair-share stays in JavaScript.** `pickFairBySource` / `pickFairByGroup` run
as Code nodes and are covered by `domains/short-videos/tests/fair-share.test.js`.
They could become SQL window functions; there is no reason to rewrite tested
logic in the same change that moves the store. They get fed rows from a `SELECT`
instead of from Sheets.

**Credential and connection.** One n8n Postgres credential on the heavy
instance holding the Supabase connection string, never in workflow JSON — the
same rule the repo already applies to document IDs. `SUPABASE_DATABASE_URL` in
`hosts/.env` as a `:?`-required variable.

The local Postgres **stays**, serving the `whatsapp-access` domain. It stops
holding short-videos data.

### The port and pooling mode are not decided here

Supabase exposes a direct connection (5432) and a pooler (6543). The direct
endpoint is believed to be IPv6-only unless the IPv4 add-on is enabled, while
the pooler is reachable over IPv4 — and from inside a Docker container that
decides whether it connects at all. It also matters for the queue: transaction
mode pooling should be fine for a single `FOR UPDATE SKIP LOCKED` statement but
breaks session-level features.

**All of that is unverified, and no Supabase project exists yet to verify it
against.** This spec therefore names no port. Gate 0 in Section 4 closes the
question with a live test, and the implementation plan must treat it as a
blocking first step rather than assuming 5432.

---

## Section 3 — The approval UI

**Framework: none.** A single-file Node HTTP server, server-rendered HTML, zero
dependencies, no build step. Not minimalism for its own sake: the repo has no
`node_modules` and no bundler, and adding a frontend toolchain to render three
forms means a new build system for the one thing an operator touches twice a
day.

**Data access: PostgREST over built-in `fetch`, not a Postgres driver.** The UI
needs simple reads and writes. A Postgres client means the repo's first npm
dependency plus connection pooling in a container idle 99% of the time.
PostgREST is reachable with `fetch` and the service key over IPv4. The one thing
PostgREST cannot express — the atomic lease — belongs to n8n and is never the
UI's job. This is why D9 and Section 2 differ without contradicting.

**Clip preview holds no Google credential, not even indirectly (D11).** The UI
does not proxy Drive. It emits `Created_Clips.google_drive_url` into the page and
the operator's own browser — already signed into Google — fetches the video. The
server holds exactly one secret, the Supabase service key, and never ships it to
a browser. This closes the risk the earlier draft flagged as able to quietly
undo D1.

**Three screens (D4):**

| Screen | Reads | Writes |
|---|---|---|
| Clip review queue | `created_clips WHERE review_status = 'NEEDS_REVIEW'` | `review_status`, plus an `approved_for_posting` row |
| Add source channel | — | `source_channels` row (`source_id`, `niche`, `source_name`, `youtube_channel_url`, `priority`, risk fields) |
| High-risk moments | `clip_moments WHERE download_status = 'AWAITING_MANUAL_APPROVAL'` | `download_status = 'PENDING'` |

The third screen writes `download_status`, the D7 rename. The UI is that
rename's first consumer, which is one reason the rename lands in this change
rather than later.

WF1 fills `youtube_channel_id` and `uploads_playlist_id` after a channel is
added, so the add-channel form does not collect them.

**Approve is one transaction, not two writes.** The form is prefilled from the
clip's `suggested_title`, `suggested_caption` and `hashtags`; the operator edits
them, ticks platforms, and optionally sets a schedule date. Submitting must set
`review_status = 'APPROVED'` **and** insert the `approved_for_posting` row, or do
neither — a clip marked approved with no posting row vanishes from both queues
silently and is never published. PostgREST cannot do a multi-table transaction,
so this is a Postgres function, `short_videos.approve_clip(...)`, called by RPC.
Atomicity lives in SQL; the UI stays a dumb form.

`Approved_For_Posting.status` must be `APPROVED` or `READY` for WF11 to act, and
`platform` must contain at least one explicit supported value — blank does not
mean all platforms. `approve_clip` enforces both rather than trusting the form.

**Placement: `hosts/review/` (D10).** Bound to the tailnet address only, no
Traefik router, no route, not attached to `public-net`. It is wrong on `public`,
which is internet-facing, and wrong on `heavy`, which holds every pipeline
credential — this box should hold one key and nothing else. `mem_limit: 64m`.
Measured current caps: `provider-uploader` 256m + heavy n8n 1g + `task-runners`
512m + public n8n 640m + traefik 128m + postgres 512m = 3072m on a 4 GB box.

**Testing.** The HTML rendering functions and the form-to-row mapping are pure
and unit-tested under `node --test` alongside the rest of the repo.
`approve_clip` gets an integration test against real Postgres, following the
pattern in `domains/short-videos/tests/publishing-postgres.test.js`, and must
cover the both-or-neither property explicitly.

---

## Section 4 — Migration, testing and rollback

### Gate 0 — connection proof, before any schema is written

Create the Supabase project. From inside a container on `heavy-net`, open a
connection and run `SELECT 1` against the direct port and the pooler port.
Record which worked and the pooling mode; Section 2 names a port only after
this. If only the pooler in transaction mode is reachable, re-verify
`claim-next-publishing-job.sql` under it before anything downstream is written —
a single `FOR UPDATE SKIP LOCKED` statement should be fine in transaction
pooling, but that is an assumption to test, not to assert.

**This gate blocks every step below. An implementation plan must not reorder
it.**

### Order of work

Each step is verifiable on its own, continuing the existing migration numbering.

1. **Gate 0.**
2. `migrations/004-pipeline-store.sql` — the 12 tables, `CHECK` constraints per
   status column, foreign keys, the `(niche) WHERE active_status` unique partial
   index.
3. `migrations/005-publishing-queue-retypes.sql` — D6 applied to
   `publishing_jobs`; rewrite the 17 files in `postgres/queries/`; retire
   `safe_schedule_at()`. **Highest-risk step in the migration**, because it
   touches the atomic claim. `publishing-postgres.test.js` and
   `postiz-postgres-integration.test.js` must go green against real Postgres
   before step 4 begins.
4. `migrations/006-approve-clip.sql` — the `approve_clip()` function.
5. **Generators** — `sheet()` → `table()`, regenerate all 16 workflows. The
   diff to review is the generators plus the SQL files; the 16 JSON files are
   output, not input.
6. **The review UI** in `hosts/review/`.

### Testing

**One trap to name explicitly.**
`domains/short-videos/tests/workflow-sheets-execute-once.test.js` iterates
workflow nodes collecting `googleSheets` read nodes that lack
`executeOnce: true`, then asserts the collection is empty. After the migration it
finds zero `googleSheets` nodes at all, the collection stays empty, and **the
test passes while asserting nothing.** Delete it and replace it with the
inverse assertion: *no `n8n-nodes-base.googleSheets` node exists anywhere in
`domains/short-videos/workflows/`*. That is the migration's completion
criterion, and it is the one assertion here that cannot pass vacuously.

Six other test files reference sheet shapes and row payloads —
`ai-transcript-analysis.test.js`, `remaining-workflows.test.js`,
`workflow-generator-hardening.test.js`, `transcript-fetch.test.js`,
`postiz-publishing.test.js`, `postiz-postgres-integration.test.js`. They change
with the generator, in the same commit as the generator.

New coverage: the `approve_clip` both-or-neither integration test (Section 3),
and a test that WF3's thresholds treat a NULL percentage as failing rather than
as `0` (Section 1).

### Activation order

All 16 workflows are inactive, and `publishing_jobs` has zero rows — there is no
in-flight state. Verify the vertical slice WF1 → WF2 → WF3 live with the other
13 still inactive, then activate downstream. The 12 schedule triggers mean a
careless bulk activation starts a dozen clocks against a schema exercised in
only three workflows.

### Rollback

The Sheets workbook is archived and untouched (D3), so rolling back means
reverting the commit range and re-binding the Google Sheets credential. One
caveat: step 3 retypes `publishing_jobs`, so a rollback after that point is a
revert **plus** a down-migration. Write `005` with a tested down path. It is the
only step that needs one — steps 2, 4 and 6 only add.

### Documentation

- `domains/short-videos/docs/google-sheets-structure.md` is the schema source of
  truth for this migration and is obsolete the moment `004` lands. Replace it
  with `postgres-schema.md` maintained alongside the DDL, and **delete it**
  rather than leaving two conflicting schema documents.
- `domains/short-videos/docs/credentials-setup.md` loses its Google Sheets rows
  and gains the consent-screen publishing note from D8.
- `domains/short-videos/docs/architecture.md` references Sheets as the state
  store throughout and needs the same pass.

---

## Out of scope

- **Moving media off Google Drive** (D8). A separate spec: Supabase Storage or
  S3, 8 nodes, WF8c asset paths, and the unresolved `public_video_url`
  fetchability question for TikTok, Instagram and Facebook.
- **Publishing the OAuth consent screen** (D8). Do it immediately and
  separately; it is a console setting, not a code change, and it is what
  actually addresses the stated motivation.
- **Rewriting fair-share as SQL window functions** (Section 2). Tested logic
  stays as it is during a store migration.
- **Authentication for the review UI** (D5). The tailnet is the authentication.

---

## Process state

The `superpowers:brainstorming` architectural path is: questions → approaches →
sectioned design with approval per section → written spec → spec self-review →
user approves the spec → `superpowers:writing-plans`.

Completed: context exploration, clarifying questions, three approaches with
approach A chosen, Sections 1–4 designed and each approved by the user, spec
written and self-reviewed.

**Next gate:** the user reviews this document. `superpowers:writing-plans` is
the only skill invoked after that approval.
