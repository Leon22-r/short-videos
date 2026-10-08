# Review UI

The operator-facing approval surface for the short-videos pipeline. Three
screens, server-rendered, no JavaScript shipped to the browser:

| Path | What it does |
| --- | --- |
| `/` | Clips in `created_clips.review_status = 'NEEDS_REVIEW'`: preview, edit the title/caption/hashtags, pick platforms, approve or reject. |
| `/moments` | Moments held at `clip_moments.download_status = 'AWAITING_MANUAL_APPROVAL'` because the source is high-risk. Releasing one sets it back to `PENDING` so WF6 downloads it. |
| `/channels` | Adds a row to `source_channels`. `youtube_channel_id` and `uploads_playlist_id` are left empty on purpose — WF1 resolves them from the URL. |

## Why it looks like this

- **Zero dependencies and no build step.** The repo has none, and this service
  keeps it that way: three files, `node:` builtins, built-in `fetch`.
- **The network is the authentication.** There is no login. The container
  publishes its port only on the host's Tailscale address, so reaching the UI
  at all means being on the tailnet. `REVIEW_BIND_ADDRESS` is therefore
  required with no default — a default would publish it on every interface.
  Because there is no session, POSTs are checked for `Sec-Fetch-Site`/`Origin`
  instead of a CSRF token: without that, any page the operator has open could
  approve a clip.
- **One secret, and it stays server-side.** `SUPABASE_SERVICE_KEY` bypasses
  row-level security. `render.js` is pure and reads no environment, so the key
  cannot reach a page; a test asserts that.
- **Clip previews are not proxied.** The page carries the Google Drive URL and
  the operator's own browser fetches it with their Google session, so this
  service holds no Google credential.
- **Approving spans two tables**, so it goes through the `approve_clip`
  Postgres function rather than two PostgREST calls: PostgREST has no
  transaction, and a clip marked `APPROVED` without its `approved_for_posting`
  row would never publish.

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
