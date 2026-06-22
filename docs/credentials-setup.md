# Credentials Setup

This repo commits workflow placeholders only. Real secrets live in n8n credentials, Lambda environment variables, or the Google Sheet.

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

Create a YouTube Data API key and restrict it to YouTube Data API v3. Replace `YOUTUBE_API_KEY` in WF1/WF2 HTTP nodes inside n8n, not in committed JSON.

## OpenAI

Create an API key in the OpenAI dashboard.

In n8n, create an official OpenAI credential named `OpenAI account`.

Attach it to:

- WF5 `Call OpenAI`
- WF8 `Call OpenAI Planner`

## Ssemble

Create an API key in Ssemble.

In n8n, create a Header Auth credential named `Ssemble API`:

- Header name: `X-API-Key`
- Header value: your Ssemble API key

Attach it to WF6 `Call Ssemble Create`.

Set `SSEMBLE_WEBHOOK_SECRET` in the WF6 webhook URL and WF7 `Verify And Parse` code node. Use one random value, for example:

```bash
openssl rand -hex 16
```

## Transcript Lambda

Set these Lambda environment variables:

- `TRANSCRIPT_API_KEY`: shared secret expected by the transcript endpoint.
- `WEBSHARE_PROXY_USERNAME`: optional Webshare proxy username.
- `WEBSHARE_PROXY_PASSWORD`: optional Webshare proxy password.
- `WEBSHARE_IP_LOCATIONS`: optional comma-separated locations.
- `YTA_PROXY_URL`: optional full proxy URL alternative.

In WF4, replace:

- `TRANSCRIPT_SERVICE_URL`
- `TRANSCRIPT_API_KEY`

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
- `YOUTUBE_API_KEY`
- `TRANSCRIPT_SERVICE_URL`
- `TRANSCRIPT_API_KEY`
- `YOUR_N8N_DOMAIN`
- `SSEMBLE_WEBHOOK_SECRET`
- `GOOGLE_DRIVE_FOLDER_*`

Do not commit real API keys, OAuth client secrets, webhook secrets, or Drive folder IDs.
