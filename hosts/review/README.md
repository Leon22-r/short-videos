# Review UI

The operator-facing approval surface for the short-videos pipeline. Server-rendered,
no JavaScript shipped to the browser, no dependencies.

| Path | What it does |
| --- | --- |
| `/` | Clips in `created_clips.review_status = 'NEEDS_REVIEW'`: preview, the evidence WF5 and WF8 already recorded, edit the title/caption/hashtags, pick platforms, approve or reject with a reason. |
| `/clips/<id>` | One clip, whatever its status. The link the digest email and the held list point at. |
| `/moments` | Moments held at `clip_moments.download_status = 'AWAITING_MANUAL_APPROVAL'` because the source is high-risk. Releasing one sets it back to `PENDING` so WF6 downloads it. |
| `/moments/<id>` | One moment. |
| `/held` | Everything a gate or you stopped, and the way through: flagged candidates, gate-rejected candidates, and clips you rejected. |
| `/pipeline` | Alarms, where work is sitting, throughput, and errors grouped by workflow. |
| `/stuck` | Individual failures — downloads, renders, publishes — each with a retry. |
| `/channels` | The source fleet with its health, plus the add form. Reactivate, switch off, re-prioritise. |
| `/published` | What went out and where, plus how long each publishing credential has left. |

## Why it looks like this

- **Zero dependencies and no build step.** The repo has none, and this service
  keeps it that way: four files, `node:` builtins, built-in `fetch`.
  `render.js` and `summarise.js` are pure — no environment, no I/O — so every
  screen and every alarm rule is testable without a database, and a test
  asserts that purity against the source rather than against one call's output.
- **Dark on purpose, not as a theme.** A clip is judged against its surround,
  and a bright page beside a 9:16 preview skews how the footage reads. The
  ground is blue-slate rather than near-black so the preview stays the
  brightest thing on screen. Monospace is used only for data an operator
  compares — timecodes, ids, counts, ages — never for labels.
- **Evidence before the verdict.** `created_clips` carries thirty columns and
  the approve form used to show three, so clips were approved blind. The risk
  flag, the warning, the hook, the thesis and the cut timestamps now sit above
  the form; the narration, b-roll and transcript fold away.
- **Approving and rejecting are deliberately asymmetric.** Approve is one
  filled button. Reject is a disclosure that asks for a reason from a fixed
  list, an optional note and an optional link, and `/held` can undo it.
  Rejecting should not be as cheap as approving, and a rejection with no
  recorded reason teaches the pipeline nothing.
- **A validation failure keeps what you typed.** The page re-renders the one
  clip you were working on — wherever it sat in the queue, or from its
  permalink — with your values and the error beside the field. A failed reject
  reopens its disclosure with your choices.
- **A typed title wins.** The AI's suggested title is pre-checked, so typing
  your own and forgetting the radio must not publish the suggestion.

## The network is the authentication

There is no login. The container publishes its port only on the host's
Tailscale address, so reaching the UI at all means being on the tailnet.
`REVIEW_BIND_ADDRESS` is therefore required with no default — a default would
publish it on every interface. Because there is no session, POSTs are checked
for `Sec-Fetch-Site`/`Origin` instead of a CSRF token: without that, any page
the operator has open could approve a clip.

**`REVIEW_ALLOWED_HOSTS` is the DNS-rebinding defence.** A request whose `Host`
is not on that list gets 403, for reads as well as writes. Without it, an
attacker who points their own domain at this address has the operator's browser
send requests carrying *their* name in both `Host` and `Origin` — which agree
with each other, so an Origin-against-Host check passes and their page becomes
same-origin with this one, able to read the clip queue as well as post to it.
The allowlist is the one input the attacker cannot influence. A tailnet
deployment must add its own hostname or address.

**One secret, and it stays server-side.** `SUPABASE_SERVICE_KEY` bypasses row
level security. It lives in `postgrest.js` and nowhere else.

**No payload reaches a page.** `/stuck` and `/pipeline` render
`error_message` and `last_error` only. `raw_payload`, `provider_response` and
`postiz_submit_payload` carry provider references and credential slots, so they
are never passed to a renderer; a test asserts it.

**Clip previews are not proxied.** The page carries the Google Drive URL and the
operator's own browser fetches it with their Google session, so this service
holds no Google credential. Only `https://drive.google.com/` URLs are framed, in
a sandbox without top-level navigation, so a wrong or tampered URL cannot load an
arbitrary page inside a console whose buttons override gates.

**Nothing here can be framed.** Every response sends `X-Frame-Options: DENY`
and a `Content-Security-Policy` with `frame-ancestors 'none'`. The same-origin
check cannot stop a click a hostile page tricks out of the operator through a
transparent iframe of this console, because a form inside the frame posts from
this origin; refusing to be framed is the only defence. The policy also allows
no script at all, which the UI never needed.

**Error text is redacted.** Workflow and provider errors often quote the request
they made, so anything shaped like a token, key or `Authorization` value is
blanked and messages are cut to 300 characters before they are rendered.

**A lost race is reported.** Every write is guarded on the state it expects —
reopen only matches a rejected clip, retry only a failed render, and so on. When
a workflow or another tab got there first, the guard matches no row, and the UI
says "Nothing changed" instead of redirecting as if it had worked.

**Publish times have a named zone.** A `datetime-local` value carries no zone and
the container runs in UTC, so the server reads it as `REVIEW_TIMEZONE`
(`Africa/Nairobi` by default) and stores the UTC instant.

## What the pipeline screen can and cannot tell you

Whether WF6 ran at 06:00 lives in n8n's own database on the `heavy` host. Reaching
it would mean a second credential in a container that holds exactly one, so this
service infers liveness from data freshness instead and says so on the page.

Each stage shows how much is waiting, how long the oldest item has waited, and
when that stage's consumer last produced anything (`consumer_last_output`). A
stage is reported as starved when work has aged past six hours there and its
consumer has produced nothing in that time. Judging a stage by its own
consumer's output, rather than by the next stage's arrivals, is what lets the
last stage (WF12) alarm at all, and stops WF6's clips from vouching for a dead
renderer. WF3's output cannot be dated — it updates `candidate_videos` in place
and the table has no `updated_at` — so stage 2 is judged on the age of its
backlog alone, and the alarm says so.

Every starved stage is reported. When one workflow stops, the stages after it
drain to zero and raise nothing, so two alarms mean two outages.

Only due work counts as waiting: a post scheduled for tomorrow, or a retry whose
backoff has not elapsed, is not a stall.

Two stages never raise that alarm, flagged by `alarm_on_stall` in the view: the
source fleet, where "waiting" is the size of the fleet rather than a backlog,
and the review queue, whose consumer is a person.

Each stage's waiting predicate is a copy of the consumer workflow's own input
filter. **When a workflow's filter changes, `pipeline_status` must change with
it.** The workflow is named in the view beside every branch.

## Releasing a held video overrides a gate

WF3 skips any candidate whose `validity_status` is already set, so clearing it
would only have the same deterministic rule reject the video again. Releasing
therefore marks it `VALID` and clears `transcript_available`, which sends it
straight to WF4. That is what disagreeing with a gate has to mean. The gate's
reason is kept as `OVERRIDDEN: <reason>`, so the record still shows a person
pushed it past a rule.

Two rejections get no release button, because releasing would only bring them
back: WF4's own `TRANSCRIPT_*` rejections (WF4 would fetch the same missing
transcript again, and each fetch risks an IP block), and WF5's channel
auto-pause (WF5 skips the video again while the channel is paused — the screen
links to `/channels`, where the real fix is).

Likewise `/stuck` offers no "Queue again" for a publish Postiz may already have
posted (a Postiz submit is recorded, or the error asks for manual
reconciliation). The submit guard would refuse it, and it would loop through
claim and lease expiry while looking handled.

`FLAGGED` is the case that matters most: WF4 takes `validity_status = 'VALID'`
exactly, so a candidate flagged `LANGUAGE_CHECK` or `MANUAL_APPROVAL_REQUIRED`
advanced no further and appeared in no queue. `/held` is the only thing that
moves it.

`/held` groups gate rejections by reason on purpose. One video failing a rule is
an override; a whole class failing the same rule is a threshold to change. The
Held badge counts `FLAGGED` only — the videos genuinely waiting on a person. A
gate's `REJECTED` is the filter doing its job, and counting it would make the
badge grow for ever.

## Schema this service owns

Migration `013-pipeline-status.sql` adds two read-only views, `pipeline_status`
and `review_counts`. `run-migrations.sh` replays every file on every boot, so
013 is edited in place when those views change: a later migration adding a
column would make 013's own `CREATE OR REPLACE VIEW` fail on replay. Columns are
only ever appended.

Migration `014-review-ui-rollups.sql` adds `held_reasons_30d` and
`clip_throughput_7d`, which group in the database so the counts are exact —
grouping raw rows in JS was silently capped by Supabase's `max-rows` — and
partial indexes for the statuses `review_counts` counts on every page.

Everything else — reopening a clip, releasing a held video,
retrying a download, render or publish, reactivating a channel — is a PATCH
through the existing grants. `approve_clip` and `reject_clip` already accepted
`p_reviewer_notes`; the UI now sends it.

The reason, note and link from a rejection are stored as one structured line in
`reviewer_notes`. It is overwritten on each decision, so it records the current
verdict and not a history. An audit trail would want its own table.

## Running it

Set `REVIEW_BIND_ADDRESS`, `SUPABASE_URL` and `SUPABASE_SERVICE_KEY` in
`hosts/.env` (and `REVIEW_TIMEZONE` if you are not in East Africa Time), then:

```bash
docker compose --env-file hosts/.env -f hosts/review/compose.yaml up -d --build
curl -sS "http://${REVIEW_BIND_ADDRESS}:${REVIEW_PORT:-5680}/"
```

Locally, without Docker:

```bash
SUPABASE_URL=... SUPABASE_SERVICE_KEY=... node hosts/review/server.js
```
