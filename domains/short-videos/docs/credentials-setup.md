# Credentials Setup

This repo commits workflow placeholders only. Real secrets live in n8n credentials or Lambda environment variables, never the Google Sheet.

For the opt-in Postiz backend, create a **Header Auth** credential named `Postiz Public API` with header `Authorization` and the raw API key. Bind it to WF12's Postiz HTTP nodes; the exported ID is a placeholder. See [Postiz setup and activation gates](postiz-publishing.md). Existing direct-platform credentials remain necessary for jobs using `DIRECT`.

## Google Cloud

Create or reuse one Google Cloud project, then enable:

- Google Sheets API
- Google Drive API
- YouTube Data API v3
- Gmail API

Create an OAuth consent screen and add your account as a test user while local/staging is not published.

Create an OAuth client for n8n with these redirect URLs:

- `http://localhost:5678/rest/oauth2-credential/callback`
- `https://YOUR_N8N_DOMAIN/rest/oauth2-credential/callback`

Create these n8n credentials:

- `Google Sheets account`: attach to every Google Sheets node.
- `Google Drive account`: attach to WF8 Drive upload.
- `Gmail account`: attach to WF9 digest email.
- `YouTube upload account`: OAuth credential with YouTube upload scope for WF12 YouTube publishing.

Create a YouTube Data API key and restrict it to YouTube Data API v3. In n8n, create a Query Auth credential with query parameter name `key` and the API key as its value, then bind it to every YouTube HTTP node in WF1/WF2. The key must not appear in a URL or committed workflow JSON.

## OpenAI

Create an API key in the OpenAI dashboard.

In n8n, create an official OpenAI credential named `OpenAI account`.

Attach it to:

- WF5 `Call OpenAI`
- WF8 `Call OpenAI Planner`

## Clip Downloads

WF6 uses local `yt-dlp` plus FFmpeg in the n8n runtime. No Ssemble API key or webhook secret is required for the active clip-download path.

The committed `hosts/heavy/Dockerfile` installs `yt-dlp`. Rebuild and recreate the n8n container after pulling this change so the Execute Command node can call it.

## Social Publishing

WF11-WF14 add the publishing phase. Real OAuth access and refresh tokens must live in n8n credentials, not in Google Sheets or committed workflow JSON.

Create an n8n credential of type `Postgres`, name it `Publishing Queue Postgres`, and bind it to every Postgres node in WF11, WF12, and WF14.

For the local Compose database use:

- Host: `publishing-db`
- Port: `5432`
- Database: `short_videos`
- User: `short_videos`
- Password: the `PUBLISHING_DB_PASSWORD` value used by Compose
- SSL: disabled for the internal local Docker network

For Neon, apply `domains/short-videos/postgres/init/001-publishing-queue.sql`, replace the credential fields with the Neon connection details, and enable SSL. Workflow SQL and queue semantics stay unchanged. Never place the Neon connection string in workflow JSON.

Create and bind these exact n8n credentials before enabling the publishing workflows:

| Use | n8n credential type | Credential name | Required setup |
|---|---|---|---|
| Sheet approvals/mirror | `Google Sheets OAuth2 API` (`googleSheetsOAuth2Api`) | `Google Sheets account` | Bind to every Google Sheets node in WF11-WF14 |
| Transactional queue | `Postgres` (`postgres`) | `Publishing Queue Postgres` | Bind to every Postgres node in WF11, WF12, and WF14 |
| YouTube | `YouTube OAuth2 API` (`youTubeOAuth2Api`) | `YouTube Publishing OAuth2` | OAuth grant for the destination channel with YouTube upload/write access |
| Facebook Reels | `Header Auth` (`httpHeaderAuth`) | `Facebook Reels Page Token` | Header `Authorization` with value `OAuth <PAGE_ACCESS_TOKEN>` |
| Instagram Reels | `Header Auth` (`httpHeaderAuth`) | `Instagram Reels Token` | Header `Authorization` with value `Bearer <ACCESS_TOKEN>` appropriate to the selected Graph host/login flow |
| TikTok draft upload | `Bearer Auth` (`httpBearerAuth`) | `TikTok Content Posting Bearer` | Creator user access token authorized for `video.upload` and `user.info.basic` |

Provider credential IDs in generated JSON are placeholders; Google Sheets and Postgres nodes also require deployment-time binding. Open every credentialed node after import and bind the real credential by ID. Tokens and refresh tokens stay in n8n credentials.

WF12 currently has one statically bound credential slot/account per platform:

- `YOUTUBE_PRIMARY`
- `FACEBOOK_PRIMARY`
- `INSTAGRAM_PRIMARY`
- `TIKTOK_PRIMARY`

Set `Publishing_Channels.credential_slot` to the matching value. The destination ID on that row must belong to the account authorized by that platform credential. Multiple rows may describe routing, but WF12 cannot safely publish through a second account on the same platform until another explicit credential slot and provider branch are implemented.

Provider prerequisites:

- YouTube: enable YouTube Data API v3 and ensure the OAuth project/channel can upload. WF12 uses the official resumable upload protocol, persists the session URI, resumes interrupted transfers, and polls `videos.list` until processing succeeds or fails. Unverified API projects may be restricted to private uploads. See [YouTube resumable uploads](https://developers.google.com/youtube/v3/guides/using_resumable_upload_protocol) and [video processing status](https://developers.google.com/youtube/v3/guides/implementation/videos).
- Facebook Reels: create a Meta app and obtain a Page access token with the Page video/Reels publishing permissions required by the current Graph API version. Set `meta_graph_version` explicitly, for example `vNN.N`; do not rely on an unversioned endpoint. See Meta's [official Facebook Reels Publishing collection](https://www.postman.com/meta/facebook/folder/simabyk/reels-publishing).
- Instagram Reels: use a professional Instagram account and a token valid for the selected login/API variant. Set `instagram_graph_host` to `graph.facebook.com` for Instagram API with Facebook Login or `graph.instagram.com` only when the credential and app use the Instagram Login flow. See Meta's [official Instagram Reels Publishing collection](https://www.postman.com/meta/instagram/folder/23987686-8cdc2637-eebc-4770-aa59-7b0a0bba5a64).
- TikTok: add Content Posting API, obtain approval for `video.upload`, and have the creator authorize `video.upload` plus `user.info.basic`; WF12 reads the token's `open_id` before each init or status poll and rejects a mismatch. WF12 intentionally uses the draft/inbox endpoint, not Direct Post. TikTok Direct Post requires current creator-info UI, manual privacy/interaction choices, preview, and explicit per-post consent; TikTok also identifies an internal team-account upload utility as an unacceptable Direct Post use case. See [TikTok draft upload](https://developers.tiktok.com/doc/content-posting-api-reference-upload-video), [status polling](https://developers.tiktok.com/doc/content-posting-api-reference-get-video-status), and [content-sharing guidelines](https://developers.tiktok.com/doc/content-sharing-guidelines).

Populate `Publishing_Channels` with non-secret destination metadata:

- `channel_id`: stable local destination key, e.g. `finance_ke_youtube`
- `niche`
- `platform`
- `enabled_status`
- `credential_name`: human label only
- `credential_slot`: one of the four supported `*_PRIMARY` values above
- platform identifiers such as `youtube_channel_id`, `facebook_page_id`, `instagram_user_id`, or `tiktok_open_id`
- `meta_graph_version` for Facebook and Instagram
- `instagram_graph_host` for Instagram
- `tiktok_domain_verified=TRUE` only after verification, with the exact HTTPS value stored in `tiktok_verified_url_prefix`
- `audit_status`
- `token_expires_at` when the platform exposes a useful expiry timestamp

Before enabling WF12, bind the Postgres credential and open every platform HTTP/native node in n8n to bind the correct provider credential. The committed workflow endpoints are intentionally credential-neutral placeholders so secrets never enter source control.

Facebook, Instagram, and TikTok pull media from `public_video_url`. It must be a stable, provider-fetchable HTTPS URL without embedded credentials. For TikTok it must also be non-redirecting, remain accessible throughout the pull window, and be under the verified domain or URL prefix. A Google Drive share URL is an operator link; it is not proven to be directly fetchable by these providers and must not be copied into `public_video_url` without a controlled provider test. Prefer an owned HTTPS object-storage/CDN URL.

Provider-issued resumable session and upload URLs may contain signed tokens. WF12 stores them only in Postgres (`provider_upload_url`/`provider_response`) and they must not be added to Google Sheets, logs, or documentation.

WF13 is a configuration/expiry monitor, not a live credential probe. Its `last_health_status` and `last_expiry_audit_at` fields describe what can be inferred from `enabled_status`, `audit_status`, required destination metadata, and `token_expires_at`; they do not prove that an access token works. Use a lightweight authenticated provider request before production, and treat `401`, `403`, missing scopes, or an app-review restriction as `AUTH_REQUIRED`/manual action.

Enable destinations one platform at a time. The implementation and local tests have no live provider proof because no real provider credentials were used. A valid generated workflow does not prove OAuth scopes, resumable transfer, remote URL fetchability, asynchronous processing, provider entitlement, app review, or public visibility. Keep the destination disabled, private, draft, or manual until a controlled live run reaches the documented terminal state and the result is verified in the destination account.

## Transcript Lambda

Set these Lambda environment variables:

- `TRANSCRIPT_API_KEY`: shared secret expected by the transcript endpoint.
- `WEBSHARE_PROXY_USERNAME`: optional Webshare proxy username.
- `WEBSHARE_PROXY_PASSWORD`: optional Webshare proxy password.
- `WEBSHARE_IP_LOCATIONS`: optional comma-separated locations.
- `YTA_PROXY_URL`: optional full proxy URL alternative.

In n8n, create a Header Auth credential for WF4:

- Header name: `x-api-key`
- Header value: the same secret stored as the Lambda/server `TRANSCRIPT_API_KEY`

Bind that credential to WF4 `Call Transcript Service`. The secret must not be typed into an HTTP header field or committed workflow JSON.

In WF4, replace only the service URL placeholder:

- `TRANSCRIPT_SERVICE_URL`

## Drive Folders

Create one Google Drive folder per niche and replace these WF8 placeholders in `Pick Awaiting Download`:

- `GOOGLE_DRIVE_FOLDER_CHRISTIAN_CONTENT`
- `GOOGLE_DRIVE_FOLDER_MOTIVATION_DISCIPLINE`
- `GOOGLE_DRIVE_FOLDER_FINANCE_BUSINESS`
- `GOOGLE_DRIVE_FOLDER_LIFE_VALUES_RELATIONSHIPS`
- `GOOGLE_DRIVE_FOLDER_AFRICAN_KENYAN_SUCCESS`

## Workflow Placeholders

Expected committed placeholders:

- `GOOGLE_SHEETS_DOCUMENT_ID`
- `TRANSCRIPT_SERVICE_URL`
- `YOUR_N8N_DOMAIN`
- `GOOGLE_DRIVE_FOLDER_*`

The files in `domains/short-videos/workflow-code/` are canonical and generators must emit placeholders. Bind real Google Sheet document IDs, Drive folder IDs, domains, and credential selections only in the deployment/runtime copy (or through an explicit deployment-time substitution step). Do not copy runtime-bound generated JSON back over the placeholder source, and do not regenerate deployed workflows without reapplying and verifying those bindings.

After every create/update, validate the workflow, fetch it back from n8n, inspect its `connections`, and open each credentialed node to confirm the intended credential is selected. Validation alone does not prove the saved connections or account selection.

The local `hosts/.env` file is ignored. Keep a separately managed example or secret-manager record of required variable names; never commit the populated file.

Do not commit real API keys, OAuth client secrets, refresh tokens, bearer tokens, webhook secrets, platform account IDs you consider private, or Drive folder IDs.
