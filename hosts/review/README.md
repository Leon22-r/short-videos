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
- **A validation failure keeps what you typed.** It used to show a bare error
  page with a Back link, which threw away the caption you had just written.

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
holds no Google credential.

## What the pipeline screen can and cannot tell you

Whether WF6 ran at 06:00 lives in n8n's own database on the `heavy` host. Reaching
it would mean a second credential in a container that holds exactly one, so this
service infers liveness from data freshness instead and says so on the page.

Each stage shows three numbers: how much is waiting, how long the oldest item
has waited, and when the stage last received anything. A stage is reported as
starved when work has aged past six hours there and the next stage has received
nothing in that time — and only the first stage of a consecutive run is
reported, because when one workflow stops every stage behind it goes quiet too.

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
straight to WF4. That is what disagreeing with a gate has to mean.

`FLAGGED` is the case that matters most: WF4 takes `validity_status = 'VALID'`
exactly, so a candidate flagged `LANGUAGE_CHECK` or `MANUAL_APPROVAL_REQUIRED`
advanced no further and appeared in no queue. `/held` is the only thing that
moves it.

`/held` groups gate rejections by reason on purpose. One video failing a rule is
an override; a whole class failing the same rule is a threshold to change.

## Schema this service owns

Migration `013-pipeline-status.sql` adds two read-only views, `pipeline_status`
and `review_counts`. Everything else — reopening a clip, releasing a held video,
retrying a download, render or publish, reactivating a channel — is a PATCH
through the existing grants. `approve_clip` and `reject_clip` already accepted
`p_reviewer_notes`; the UI now sends it.

The reason, note and link from a rejection are stored as one structured line in
`reviewer_notes`. It is overwritten on each decision, so it records the current
verdict and not a history. An audit trail would want its own table.

## Running it

Set `REVIEW_BIND_ADDRESS`, `SUPABASE_URL` and `SUPABASE_SERVICE_KEY` in
`hosts/.env`, then:

```bash
docker compose -f hosts/compose.local.yaml up -d --build review-ui
curl -sS "http://${REVIEW_BIND_ADDRESS}:${REVIEW_PORT:-5680}/"
```

Locally, without Docker:

```bash
SUPABASE_URL=... SUPABASE_SERVICE_KEY=... node hosts/review/server.js
```
