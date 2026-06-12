# n8n Short-Form Video Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a credit-efficient, Google-Sheets-driven n8n pipeline that discovers long-form YouTube videos for 5 Kenyan content niches, validates them, fetches transcripts via a proxied AWS Lambda, AI-scores them, clips the best moments via Ssemble (1 credit per request), stores clips in Google Drive, and queues them for human review.

**Architecture:** 10 modular n8n workflows chained through status columns in one Google Sheets workbook (each workflow reads rows in state X, writes state Y — independently re-runnable). A Python Lambda (Function URL) wraps `youtube-transcript-api` 1.2.4 with Webshare/generic proxy support. AI analysis happens BEFORE any Ssemble credit is spent; deterministic Code-node gates enforce the credit rules regardless of what the LLM says.

**Tech Stack:** n8n (Docker, existing `n8n/compose.local.yaml` + `compose.prod.yaml`), Google Sheets + Drive (OAuth2), YouTube Data API v3, AWS Lambda python3.12 + Function URL, `youtube-transcript-api==1.2.4` (vendored in `lamba-function/`), OpenAI `gpt-4o-mini` via HTTP, Ssemble API (`https://aiclipping.ssemble.com/api/v1`), Gmail digest.

**Target repo:** `/home/leon/projects/short-videos` — all paths relative to it.

---

## Verified Facts (do NOT re-derive; sources checked 2026-06-11)

### Ssemble API (from https://www.ssemble.com/docs)
- Base URL: `https://aiclipping.ssemble.com/api/v1`
- Create: `POST /shorts/create` — auth header `X-API-Key: <key>` (NOT Bearer)
- Request fields: `url` (YouTube URL) XOR `fileUrl`; `start`,`end` (seconds); `preferredLength` ∈ `under30sec|under60sec|under90sec|under3min|under5min|under10min`; `language` (ISO 639-1); `templateId` (24-hex, optional); `noClipping` (bool — whole range becomes ONE clip); `music` (bool), `musicName`, `musicVolume` (0–100); `layout` ∈ `auto|fill|fit|square`; `webhookUrl`; overlays `hookTitle`,`memeHook`,`gameVideo`,`ctaEnabled`/`ctaText`
- **Constraints: 60 ≤ (end−start) ≤ 1200 seconds.** Max source video 5h. **1 credit per request regardless of clips generated.**
- Success: `{"data":{"requestId","status":"processing","creditsUsed":1,"estimatedCompletionTime","queuePosition"}}`
- Error: `{"error":{"code","message","details"}}`
- Webhook payload (no signature headers — secure via secret query param):
  - completed: `{"event":"shorts.completed","requestId","status":"completed","timestamp","data":{"shorts":[{"id","title","video_url","duration","viral_score"}]}}`
  - failed: `{"event":"shorts.failed","requestId","status":"failed","timestamp","data":{"failureReason"}}`
  - Retries 3× (0s/1s/3s), 10s timeout each.
- Polling fallback: `GET /shorts/:id/status`, `GET /shorts/:id`, `GET /templates`
- **Credit economics:** WINDOW strategy = 1 credit → many clips. EXACT clips = 1 credit EACH. Exact clip ranges < 60s MUST be padded to ≥ 60s.

### youtube-transcript-api 1.2.4 (verified from vendored source in `lamba-function/youtube_transcript_api/`)
- `YouTubeTranscriptApi(proxy_config=...)` — NOT thread-safe, one instance per invocation
- `api.fetch(video_id, languages=("en",))` → `FetchedTranscript` with `.snippets`, `.language_code`, `.is_generated`, `.to_raw_data()` → `[{"text","start","duration"}]`
- `api.list(video_id)` → `TranscriptList` with `.find_transcript(langs)`, `.find_generated_transcript(langs)`, iteration yields `Transcript` (`.language_code`, `.is_generated`, `.translate(code)`)
- Proxies (`youtube_transcript_api.proxies`):
  - `GenericProxyConfig(http_url=..., https_url=...)` — at least one required
  - `WebshareProxyConfig(proxy_username=..., proxy_password=..., filter_ip_locations=None, retries_when_blocked=10)` — rotating residential, auto-retries on 429, recommended for YouTube IP blocks
- Exceptions (`youtube_transcript_api._errors`, all importable from package root): `TranscriptsDisabled`, `NoTranscriptFound`, `VideoUnavailable`, `RequestBlocked`, `IpBlocked`, `InvalidVideoId`, `AgeRestricted`, `VideoUnplayable`, `CouldNotRetrieveTranscript` (base)

### Existing repo assets
- `n8n/compose.local.yaml`, `n8n/compose.prod.yaml`, `n8n/.env.example`, `n8n/AWS-DEPLOY.md` (Traefik + TLS prod setup)
- `lamba-function/` — vendored deps (`youtube_transcript_api/`, `requests/`, `defusedxml/`, `charset_normalizer/`, etc.), stale `function.zip`, **no handler yet**
- `docs/google-sheets-structure.md` — ALREADY WRITTEN (8 tabs + helper columns `uploads_playlist_id`, `strategy`, `source_video_url`; state machine documented). Treat as authoritative for column names.
- `transcript.py` — throwaway PoC, leave as-is

---

## File Structure (created by this plan)

```
n8n/workflows/
  10-error-handler.json            # WF10 — Error Trigger → Error_Log (built FIRST)
  01-source-channel-registry.json  # WF1  — resolve channel IDs + uploads playlists
  02-video-fetch.json              # WF2  — YouTube API → Candidate_Videos (dedup)
  03-validity-check.json           # WF3  — deterministic rule engine
  04-transcript-fetch.json         # WF4  — Lambda → Transcript_Analysis
  05-ai-transcript-analysis.json   # WF5  — OpenAI scoring → Clip_Moments
  06-ssemble-dispatch.json         # WF6  — credit-gated Ssemble requests
  07-ssemble-webhook-receiver.json # WF7  — webhook → Ssemble_Jobs/Created_Clips
  08-drive-storage-transform.json  # WF8  — download → Drive → transformation plan
  09-review-queue-digest.json      # WF9  — daily email digest
lamba-function/                    # [sic] directory name is a typo for "lambda-function" —
  handler.py                       #   kept deliberately: vendored deps, tests, build.sh and
  build.sh                         #   deploy commands all reference this exact path. Do NOT rename.
tests/
  test_handler.py                  # pytest for handler.py
docs/
  google-sheets-structure.md       # EXISTS — verify only
  credentials-setup.md             # every credential + where it plugs in
  architecture.md                  # diagram + state machine + ops knobs
```

---

## Conventions (read before ANY workflow task)

### C1. Workflow JSON envelope
Every workflow file uses this envelope. Tasks below specify only the `name`, `nodes` array and `connections` object — wrap them in:

```json
{
  "name": "<NAME>",
  "nodes": [],
  "connections": {},
  "settings": { "executionOrder": "v1" },
  "pinData": {},
  "meta": { "instanceId": "placeholder" }
}
```

After importing WF10 into n8n, copy its workflow ID from the URL and add `"errorWorkflow": "<that id>"` to `settings` of every OTHER workflow (done in n8n UI under Workflow Settings → Error Workflow — simpler than editing JSON).

### C2. Node object shape
```json
{
  "parameters": { },
  "id": "a1b2c3d4-0001-4000-8000-000000000001",
  "name": "<unique name>",
  "type": "n8n-nodes-base.<type>",
  "typeVersion": <ver>,
  "position": [x, y]
}
```
`id` must be unique per node — use the pattern above with an incrementing suffix. Positions: start `[0,0]`, step x by 220.

### C3. Google Sheets nodes (typeVersion 4.5)
- Read whole tab:
  ```json
  { "operation": "read",
    "documentId": { "__rl": true, "mode": "id", "value": "GOOGLE_SHEETS_DOCUMENT_ID" },
    "sheetName": { "__rl": true, "mode": "name", "value": "<Tab_Name>" },
    "options": {} }
  ```
- Append row: same `documentId`/`sheetName` plus
  ```json
  { "operation": "append",
    "columns": { "mappingMode": "autoMapInputData", "value": {}, "matchingColumns": [] },
    "options": {} }
  ```
  With `autoMapInputData`, the incoming item's JSON keys must EXACTLY match the sheet's header names — Code nodes upstream are written to guarantee this.
- Update-by-key:
  ```json
  { "operation": "appendOrUpdate",
    "columns": { "mappingMode": "autoMapInputData", "value": {}, "matchingColumns": ["<key_column>"] },
    "options": {} }
  ```
- **Filtering happens in Code nodes, not in Sheets filters** (simpler, testable, avoids lookup quirks). Reads pull the whole tab; tabs stay small because processed rows leave each state quickly. If a tab grows past ~5k rows, archive old rows manually.
- Credential: every Sheets node needs the `Google Sheets account` OAuth2 credential selected in the UI after import (JSON files intentionally carry no `credentials` block).

### C4. OpenAI calls = HTTP Request nodes (not the langchain node — deterministic, importable)
```json
{ "method": "POST",
  "url": "https://api.openai.com/v1/chat/completions",
  "authentication": "genericCredentialType",
  "genericAuthType": "httpHeaderAuth",
  "sendBody": true,
  "specifyBody": "json",
  "jsonBody": "={{ $json.openai_body }}",
  "options": { "timeout": 120000 } }
```
The upstream Code node sets `openai_body` to a **stringified** JSON request body. Credential: `Header Auth` named `OpenAI API` with header name `Authorization`, value `Bearer <OPENAI_API_KEY>`.

### C5. Code nodes
`type: "n8n-nodes-base.code"`, `typeVersion: 2`, parameters `{ "mode": "runOnceForAllItems", "jsCode": "<code>" }` unless stated otherwise. Code uses `$input.all()` / `$('Node Name').first().json` — never `{{ }}` expressions. Items returned as `[{json: {...}}]`. New items that don't map 1:1 to inputs include `pairedItem: { item: 0 }`.

### C6. Placeholders to replace after import (single authoritative list)

| Placeholder string | Appears in | Replace with |
|---|---|---|
| `GOOGLE_SHEETS_DOCUMENT_ID` | every Sheets node | workbook ID from sheet URL |
| `YOUTUBE_API_KEY` | WF1, WF2 HTTP URLs | Google Cloud API key (YouTube Data API v3 enabled) |
| `TRANSCRIPT_SERVICE_URL` | WF4 HTTP URL | Lambda Function URL (no trailing slash) |
| `TRANSCRIPT_API_KEY` | WF4 header | same secret you set in Lambda env |
| `SSEMBLE_WEBHOOK_SECRET` | WF6 Code, WF7 Code | one random string, e.g. `openssl rand -hex 16` |
| `YOUR_N8N_DOMAIN` | WF6 Code | your n8n prod domain (from `n8n/.env`) |
| `GOOGLE_DRIVE_FOLDER_<NICHE>` (5×) | WF8 Code map | Drive folder IDs, one per niche |
| Credentials (UI, not JSON): `Google Sheets account`, `Google Drive account`, `Gmail account`, `OpenAI API` (Header Auth), `Ssemble API` (Header Auth, header `X-API-Key`) | per workflow | created in n8n UI |

### C7. Workflow task format
Each workflow task specifies: (a) parameters JSON per non-Code node, (b) full JavaScript source per Code node, (c) the `connections` object. Assemble the file per C1/C2: nodes in listed order, positions per C2, and each Code node's JS embedded as its `jsCode` string (JSON-escape the source — `\n` for newlines, `\"` for quotes — when writing the file). After writing, ALWAYS validate: `python3 -m json.tool n8n/workflows/<file> > /dev/null && echo OK`.

### C8. Commits
Each task ends with a commit. Conventional prefixes: `feat:`, `test:`, `docs:`, `chore:`. n8n JSON files are code — commit them as `feat(n8n): ...`.

### C9. Local testing loop
```bash
cd n8n && docker compose -f compose.local.yaml up -d   # n8n at http://localhost:5678
```
Import a workflow: n8n UI → Workflows → ⋮ → Import from File. After every workflow task: import, attach credentials, run manually with seeded sheet data, check the target tab.

---

## Task 1: Repo scaffolding

**Files:**
- Create: `n8n/workflows/` (directory)
- Create: `tests/` (directory)

- [ ] **Step 1: Create directories**

```bash
mkdir -p n8n/workflows tests
```

- [ ] **Step 2: Verify**

```bash
ls -d n8n/workflows tests
```
Expected: both paths printed.

- [ ] **Step 3: Commit** (directories are empty — commit happens with first files in later tasks; skip if `git status` shows nothing)

---

## Task 2: Transcript Lambda — failing tests first

**Files:**
- Create: `tests/test_handler.py`
- Test: `tests/test_handler.py`

The handler contract (consumed by WF4):

Request — Lambda Function URL `POST /transcript`, header `x-api-key`:
```json
{ "youtube_url": "https://www.youtube.com/watch?v=VIDEO_ID",
  "language_preferences": ["en", "en-US", "en-GB", "sw"] }
```
Success response (HTTP 200):
```json
{ "success": true, "video_id": "VIDEO_ID", "language_code": "en", "is_generated": true,
  "transcript": [ { "text": "...", "start": 0.0, "duration": 4.2 } ],
  "plain_text": "full transcript text" }
```
Error response (HTTP 200 — WF4 branches on `success`, not status code; only auth failures use 401/400):
```json
{ "success": false, "video_id": "VIDEO_ID", "error_code": "TRANSCRIPTS_DISABLED", "error_message": "..." }
```
Error code map: `TRANSCRIPTS_DISABLED`, `NO_TRANSCRIPT_FOUND`, `VIDEO_UNAVAILABLE`, `IP_BLOCKED` (covers `RequestBlocked`+`IpBlocked`), `INVALID_VIDEO_ID` (also for unparseable URLs), `AGE_RESTRICTED`, `FETCH_FAILED` (base `CouldNotRetrieveTranscript` and unexpected exceptions).

- [ ] **Step 1: Write the failing tests**

```python
# tests/test_handler.py
import json
import sys
from pathlib import Path

import pytest

# handler.py lives in lamba-function/ next to the vendored deps
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "lamba-function"))

import handler  # noqa: E402
from youtube_transcript_api._errors import (  # noqa: E402
    TranscriptsDisabled,
    VideoUnavailable,
    IpBlocked,
)


API_KEY = "test-secret"


@pytest.fixture(autouse=True)
def _set_env(monkeypatch):
    monkeypatch.setenv("TRANSCRIPT_API_KEY", API_KEY)
    monkeypatch.delenv("WEBSHARE_PROXY_USERNAME", raising=False)
    monkeypatch.delenv("WEBSHARE_PROXY_PASSWORD", raising=False)
    monkeypatch.delenv("YTA_PROXY_URL", raising=False)


def make_event(body, api_key=API_KEY):
    return {
        "headers": {"x-api-key": api_key} if api_key else {},
        "body": json.dumps(body),
        "isBase64Encoded": False,
    }


class FakeFetched:
    language_code = "en"
    is_generated = True

    def to_raw_data(self):
        return [
            {"text": "hello world", "start": 0.0, "duration": 2.0},
            {"text": "second line", "start": 2.0, "duration": 3.0},
        ]


def test_extract_video_id_variants():
    cases = {
        "https://www.youtube.com/watch?v=Pzfle5WWaTo": "Pzfle5WWaTo",
        "https://youtu.be/Pzfle5WWaTo": "Pzfle5WWaTo",
        "https://www.youtube.com/live/Pzfle5WWaTo?feature=share": "Pzfle5WWaTo",
        "https://www.youtube.com/embed/Pzfle5WWaTo": "Pzfle5WWaTo",
        "https://www.youtube.com/watch?v=Pzfle5WWaTo&t=120": "Pzfle5WWaTo",
        "Pzfle5WWaTo": "Pzfle5WWaTo",
    }
    for url, vid in cases.items():
        assert handler.extract_video_id(url) == vid, url


def test_extract_video_id_invalid():
    assert handler.extract_video_id("https://example.com/nope") is None


def test_success(monkeypatch):
    monkeypatch.setattr(
        handler, "_fetch_transcript", lambda vid, langs: FakeFetched()
    )
    resp = handler.handler(
        make_event({"youtube_url": "https://youtu.be/Pzfle5WWaTo"}), None
    )
    assert resp["statusCode"] == 200
    body = json.loads(resp["body"])
    assert body["success"] is True
    assert body["video_id"] == "Pzfle5WWaTo"
    assert body["language_code"] == "en"
    assert body["transcript"][0]["text"] == "hello world"
    assert body["plain_text"] == "hello world second line"


def test_wrong_api_key():
    resp = handler.handler(
        make_event({"youtube_url": "https://youtu.be/Pzfle5WWaTo"}, api_key="bad"),
        None,
    )
    assert resp["statusCode"] == 401


def test_missing_url():
    resp = handler.handler(make_event({}), None)
    assert resp["statusCode"] == 400


@pytest.mark.parametrize(
    "exc,code",
    [
        (TranscriptsDisabled("Pzfle5WWaTo"), "TRANSCRIPTS_DISABLED"),
        (VideoUnavailable("Pzfle5WWaTo"), "VIDEO_UNAVAILABLE"),
        (IpBlocked("Pzfle5WWaTo"), "IP_BLOCKED"),
    ],
)
def test_error_mapping(monkeypatch, exc, code):
    def boom(vid, langs):
        raise exc

    monkeypatch.setattr(handler, "_fetch_transcript", boom)
    resp = handler.handler(
        make_event({"youtube_url": "https://youtu.be/Pzfle5WWaTo"}), None
    )
    body = json.loads(resp["body"])
    assert resp["statusCode"] == 200
    assert body["success"] is False
    assert body["error_code"] == code


def test_proxy_config_webshare(monkeypatch):
    monkeypatch.setenv("WEBSHARE_PROXY_USERNAME", "user")
    monkeypatch.setenv("WEBSHARE_PROXY_PASSWORD", "pass")
    cfg = handler.build_proxy_config()
    from youtube_transcript_api.proxies import WebshareProxyConfig

    assert isinstance(cfg, WebshareProxyConfig)


def test_proxy_config_generic(monkeypatch):
    monkeypatch.setenv("YTA_PROXY_URL", "http://proxy.example:8080")
    cfg = handler.build_proxy_config()
    from youtube_transcript_api.proxies import GenericProxyConfig

    assert isinstance(cfg, GenericProxyConfig)
    assert cfg.to_requests_dict()["https"] == "http://proxy.example:8080"


def test_proxy_config_none():
    assert handler.build_proxy_config() is None
```

NOTE: if instantiating the library exceptions in the parametrize block fails (some take extra constructor args in 1.2.4), instantiate inside a helper: `TranscriptsDisabled` and `VideoUnavailable` take `video_id`; `IpBlocked` may require a fake `response` — if a `TypeError` occurs, replace the instance with `exc_class.__new__(exc_class)` (bypasses `__init__`; the handler only catches by type, never reads attributes).

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /home/leon/projects/short-videos && .venv/bin/python -m pytest tests/test_handler.py -v 2>&1 | tail -20
```
Expected: `ModuleNotFoundError: No module named 'handler'` (or ImportError). If `.venv` lacks pytest: `.venv/bin/pip install pytest`.

- [ ] **Step 3: Commit**

```bash
git add tests/test_handler.py
git commit -m "test: add transcript Lambda handler contract tests"
```

---

## Task 3: Transcript Lambda — implementation

**Files:**
- Create: `lamba-function/handler.py`

- [ ] **Step 1: Write the handler**

```python
# lamba-function/handler.py
import json
import os
import re

from youtube_transcript_api import YouTubeTranscriptApi
from youtube_transcript_api.proxies import GenericProxyConfig, WebshareProxyConfig
from youtube_transcript_api._errors import (
    AgeRestricted,
    CouldNotRetrieveTranscript,
    InvalidVideoId,
    IpBlocked,
    NoTranscriptFound,
    RequestBlocked,
    TranscriptsDisabled,
    VideoUnavailable,
)

_VIDEO_ID_RE = re.compile(r"^[A-Za-z0-9_-]{11}$")
_URL_PATTERNS = [
    re.compile(r"[?&]v=([A-Za-z0-9_-]{11})"),
    re.compile(r"youtu\.be/([A-Za-z0-9_-]{11})"),
    re.compile(r"/live/([A-Za-z0-9_-]{11})"),
    re.compile(r"/embed/([A-Za-z0-9_-]{11})"),
    re.compile(r"/shorts/([A-Za-z0-9_-]{11})"),
]

_ERROR_CODES = [
    (TranscriptsDisabled, "TRANSCRIPTS_DISABLED"),
    (NoTranscriptFound, "NO_TRANSCRIPT_FOUND"),
    (VideoUnavailable, "VIDEO_UNAVAILABLE"),
    ((RequestBlocked, IpBlocked), "IP_BLOCKED"),
    (InvalidVideoId, "INVALID_VIDEO_ID"),
    (AgeRestricted, "AGE_RESTRICTED"),
]


def extract_video_id(url_or_id):
    if not url_or_id:
        return None
    candidate = url_or_id.strip()
    if _VIDEO_ID_RE.match(candidate):
        return candidate
    for pattern in _URL_PATTERNS:
        match = pattern.search(candidate)
        if match:
            return match.group(1)
    return None


def build_proxy_config():
    webshare_user = os.environ.get("WEBSHARE_PROXY_USERNAME")
    webshare_pass = os.environ.get("WEBSHARE_PROXY_PASSWORD")
    if webshare_user and webshare_pass:
        locations = os.environ.get("WEBSHARE_IP_LOCATIONS", "")
        return WebshareProxyConfig(
            proxy_username=webshare_user,
            proxy_password=webshare_pass,
            filter_ip_locations=(
                [c.strip() for c in locations.split(",") if c.strip()] or None
            ),
        )
    generic_url = os.environ.get("YTA_PROXY_URL")
    if generic_url:
        return GenericProxyConfig(http_url=generic_url, https_url=generic_url)
    return None


def _fetch_transcript(video_id, languages):
    api = YouTubeTranscriptApi(proxy_config=build_proxy_config())
    return api.fetch(video_id, languages=languages)


def _response(status, body):
    return {
        "statusCode": status,
        "headers": {"Content-Type": "application/json"},
        "body": json.dumps(body),
    }


def handler(event, context):
    headers = {k.lower(): v for k, v in (event.get("headers") or {}).items()}
    expected_key = os.environ.get("TRANSCRIPT_API_KEY", "")
    if not expected_key or headers.get("x-api-key") != expected_key:
        return _response(401, {"success": False, "error_code": "UNAUTHORIZED",
                               "error_message": "missing or invalid x-api-key"})

    raw_body = event.get("body") or "{}"
    if event.get("isBase64Encoded"):
        import base64
        raw_body = base64.b64decode(raw_body).decode("utf-8")
    try:
        payload = json.loads(raw_body)
    except json.JSONDecodeError:
        return _response(400, {"success": False, "error_code": "BAD_REQUEST",
                               "error_message": "body is not valid JSON"})

    video_id = extract_video_id(payload.get("youtube_url", ""))
    if not video_id:
        return _response(400, {"success": False, "error_code": "INVALID_VIDEO_ID",
                               "error_message": "could not extract video id from youtube_url"})

    languages = payload.get("language_preferences") or ["en", "en-US", "en-GB", "sw"]

    try:
        fetched = _fetch_transcript(video_id, languages)
    except Exception as exc:  # mapped below; Lambda must not 500 on expected errors
        for exc_types, code in _ERROR_CODES:
            if isinstance(exc, exc_types):
                return _response(200, {
                    "success": False, "video_id": video_id,
                    "error_code": code, "error_message": str(exc)[:500],
                })
        if isinstance(exc, CouldNotRetrieveTranscript):
            return _response(200, {
                "success": False, "video_id": video_id,
                "error_code": "FETCH_FAILED", "error_message": str(exc)[:500],
            })
        return _response(200, {
            "success": False, "video_id": video_id,
            "error_code": "FETCH_FAILED",
            "error_message": f"{type(exc).__name__}: {str(exc)[:400]}",
        })

    raw = fetched.to_raw_data()
    plain_text = " ".join(s["text"].strip() for s in raw if s.get("text"))
    return _response(200, {
        "success": True,
        "video_id": video_id,
        "language_code": fetched.language_code,
        "is_generated": fetched.is_generated,
        "transcript": raw,
        "plain_text": plain_text,
    })
```

- [ ] **Step 2: Run tests to verify they pass**

```bash
cd /home/leon/projects/short-videos && .venv/bin/python -m pytest tests/test_handler.py -v
```
Expected: all PASS. If exception-instantiation TypeErrors appear, apply the `__new__` workaround documented in Task 2 Step 1 to the TEST file only.

- [ ] **Step 3: Commit**

```bash
git add lamba-function/handler.py
git commit -m "feat: transcript Lambda handler with proxy support and error mapping"
```

---

## Task 4: Lambda packaging + deployment

**Files:**
- Create: `lamba-function/build.sh`

- [ ] **Step 1: Write build script**

```bash
#!/usr/bin/env bash
# lamba-function/build.sh — rebuild function.zip from vendored deps + handler
set -euo pipefail
cd "$(dirname "$0")"
rm -f function.zip
zip -r function.zip . \
  -x "build.sh" -x "function.zip" -x "*.dist-info/*" -x "bin/*" -x "__pycache__/*" -x "*/__pycache__/*"
echo "Built: $(du -h function.zip | cut -f1)"
```

- [ ] **Step 2: Build**

```bash
chmod +x lamba-function/build.sh && ./lamba-function/build.sh
```
Expected: `Built: <size>` — roughly 1–3 MB.

- [ ] **Step 3: Deploy (manual — needs your AWS account; run these yourself or via configured AWS CLI)**

```bash
# One-time: execution role (skip if you have one)
aws iam create-role --role-name transcript-lambda-role \
  --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]}'
aws iam attach-role-policy --role-name transcript-lambda-role \
  --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole

# Create function (ACCOUNT_ID = your AWS account id)
aws lambda create-function --function-name yt-transcript \
  --runtime python3.12 --handler handler.handler \
  --zip-file fileb://lamba-function/function.zip \
  --role arn:aws:iam::ACCOUNT_ID:role/transcript-lambda-role \
  --timeout 30 --memory-size 256

# Secrets: TRANSCRIPT_API_KEY required; choose ONE proxy option
aws lambda update-function-configuration --function-name yt-transcript \
  --environment "Variables={TRANSCRIPT_API_KEY=$(openssl rand -hex 16),WEBSHARE_PROXY_USERNAME=YOUR_USER,WEBSHARE_PROXY_PASSWORD=YOUR_PASS}"
# (generic proxy alternative: YTA_PROXY_URL=http://user:pass@host:port)

# Function URL, open auth but key-gated inside the handler
aws lambda create-function-url-config --function-name yt-transcript --auth-type NONE
aws lambda add-permission --function-name yt-transcript \
  --action lambda:InvokeFunctionUrl --principal "*" \
  --function-url-auth-type NONE --statement-id url-public
```
Record the printed Function URL → this is `TRANSCRIPT_SERVICE_URL`. Record the random key → `TRANSCRIPT_API_KEY`.

Redeploys after code changes: `./lamba-function/build.sh && aws lambda update-function-code --function-name yt-transcript --zip-file fileb://lamba-function/function.zip`

**Proxy decision (user said proxy WILL be used):** Webshare rotating residential is the library author's recommended setup (`WebshareProxyConfig`, auto-retries 10× on blocked IPs, keep-alive disabled automatically). Buy the "Residential" package — NOT "Proxy Server" or "Static Residential". Generic fallback supported via `YTA_PROXY_URL` for any other provider.

- [ ] **Step 4: Verify end-to-end**

```bash
curl -s -X POST "$TRANSCRIPT_SERVICE_URL" -H "x-api-key: $TRANSCRIPT_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"youtube_url":"https://www.youtube.com/watch?v=Pzfle5WWaTo"}' | head -c 400
```
Expected: `{"success": true, "video_id": "Pzfle5WWaTo", ...`. A `{"success": false, "error_code": "IP_BLOCKED"...}` response means the proxy env vars are missing/wrong.

- [ ] **Step 5: Commit**

```bash
git add lamba-function/build.sh
git commit -m "feat: Lambda packaging script and deploy procedure"
```

---

## Task 5: Google Sheets workbook bootstrap

**Files:**
- Verify: `docs/google-sheets-structure.md` (exists — column source of truth)

- [ ] **Step 1: Create workbook manually** — new Google Sheet named `Shorts Pipeline Control`, create the 8 tabs with exact names from `docs/google-sheets-structure.md`, paste each tab-separated header row into A1 of its tab.

- [ ] **Step 2: Seed Source_Channels** — add 2–3 rows per niche. Minimum viable row: `source_id` (e.g. `SRC-001`), `niche` (one of the 5 enums), `source_name`, `youtube_channel_url`, `source_type`, `priority=1`, `risk_level=low|medium|high`, `active_status=TRUE`. Leave `youtube_channel_id`/`uploads_playlist_id` empty — WF1 fills them.

- [ ] **Step 3: Record document ID** from the sheet URL → `GOOGLE_SHEETS_DOCUMENT_ID`.

- [ ] **Step 4: Google Drive folders** — create folder `Shorts-Clips` with 5 subfolders named after the niches; record each subfolder's ID from its URL → the 5 `GOOGLE_DRIVE_FOLDER_<NICHE>` placeholders.

- [ ] **Step 5: n8n credentials** (UI, local first): `Google Sheets account` (OAuth2), `Google Drive account` (OAuth2), `Gmail account` (OAuth2), `OpenAI API` (Header Auth: name `Authorization`, value `Bearer sk-...`), `Ssemble API` (Header Auth: name `X-API-Key`, value your Ssemble key).

No commit (no repo files changed).

---

## Task 6: WF10 — Error Handler workflow

**Files:**
- Create: `n8n/workflows/10-error-handler.json`

Built first: every later workflow points to it (n8n UI → Workflow Settings → Error Workflow).

- [ ] **Step 1: Write the workflow file** — name `WF10 Error Handler`, 3 nodes wired linearly `Error Trigger → Normalize Error → Log To Error_Log`.

Node 1 — `Error Trigger` (`n8n-nodes-base.errorTrigger`, typeVersion 1):
```json
{ }
```

Node 2 — `Normalize Error` (Code, per C5):
```javascript
const e = $input.first().json;
const exec = e.execution || {};
const err = exec.error || {};
return [{
  json: {
    error_id: `ERR-${Date.now()}`,
    workflow_name: (e.workflow && e.workflow.name) || 'unknown',
    node_name: exec.lastNodeExecuted || (err.node && err.node.name) || 'unknown',
    related_video_id: '',
    error_type: err.name || 'WorkflowError',
    error_message: (err.message || JSON.stringify(e)).slice(0, 1000),
    raw_payload: JSON.stringify(e).slice(0, 40000),
    created_at: new Date().toISOString(),
  },
  pairedItem: { item: 0 },
}];
```

Node 3 — `Log To Error_Log` (Google Sheets append per C3, `sheetName` value `Error_Log`).

Connections:
```json
{ "Error Trigger": { "main": [[{ "node": "Normalize Error", "type": "main", "index": 0 }]] },
  "Normalize Error": { "main": [[{ "node": "Log To Error_Log", "type": "main", "index": 0 }]] } }
```

- [ ] **Step 2: Validate JSON**

```bash
python3 -m json.tool n8n/workflows/10-error-handler.json > /dev/null && echo OK
```
Expected: `OK`

- [ ] **Step 3: Import + smoke test** — import into local n8n, attach `Google Sheets account` to the Sheets node. Test: create a throwaway workflow with a Code node `throw new Error('test')`, set its Error Workflow to WF10, run it, confirm a row lands in `Error_Log`. Delete the throwaway. Record WF10's workflow ID (URL) for all later imports.

- [ ] **Step 4: Commit**

```bash
git add n8n/workflows/10-error-handler.json
git commit -m "feat(n8n): WF10 error handler logging to Error_Log"
```

---

## Task 7: WF1 — Source Channel Registry workflow

**Files:**
- Create: `n8n/workflows/01-source-channel-registry.json`

Resolves `youtube_channel_id` + `uploads_playlist_id` for rows where they're empty. Manual trigger (run after adding new source rows).

- [ ] **Step 1: Write the workflow file** — name `WF1 Source Channel Registry`, linear: `Manual Trigger → Read Source_Channels → Pick Unresolved → Resolve Channel → Parse Channel Response → Update Source Row`.

Node 1 — `Manual Trigger` (`n8n-nodes-base.manualTrigger`, typeVersion 1): `{}`

Node 2 — `Read Source_Channels` (Sheets read per C3, tab `Source_Channels`).

Node 3 — `Pick Unresolved` (Code):
```javascript
// Rows with a URL but no resolved channel id; build the YouTube API lookup URL per row.
const KEY = 'YOUTUBE_API_KEY';
const out = [];
for (const item of $input.all()) {
  const row = item.json;
  if (!row.youtube_channel_url || row.youtube_channel_id) continue;
  const url = String(row.youtube_channel_url).trim();
  let lookupUrl = null;
  const channelMatch = url.match(/\/channel\/(UC[A-Za-z0-9_-]{22})/);
  const handleMatch = url.match(/\/@([A-Za-z0-9._-]+)/);
  if (channelMatch) {
    lookupUrl = `https://www.googleapis.com/youtube/v3/channels?part=id,contentDetails&id=${channelMatch[1]}&key=${KEY}`;
  } else if (handleMatch) {
    lookupUrl = `https://www.googleapis.com/youtube/v3/channels?part=id,contentDetails&forHandle=${encodeURIComponent(handleMatch[1])}&key=${KEY}`;
  } else {
    continue; // legacy /c/ or /user/ URLs: paste the @handle URL instead
  }
  out.push({ json: { ...row, lookup_url: lookupUrl }, pairedItem: { item: 0 } });
}
return out;
```

Node 4 — `Resolve Channel` (HTTP Request, `n8n-nodes-base.httpRequest`, typeVersion 4.2 — runs once per item):
```json
{ "method": "GET", "url": "={{ $json.lookup_url }}", "options": {} }
```

Node 5 — `Parse Channel Response` (Code):
```javascript
// Pair API responses back with source rows (same order, 1:1).
const rows = $('Pick Unresolved').all();
const out = [];
$input.all().forEach((item, i) => {
  const row = rows[i].json;
  const api = item.json;
  const ch = api.items && api.items[0];
  if (!ch) {
    out.push({ json: { source_id: row.source_id, notes: `RESOLVE_FAILED: no channel for ${row.youtube_channel_url}` }, pairedItem: { item: i } });
    return;
  }
  out.push({
    json: {
      source_id: row.source_id,
      youtube_channel_id: ch.id,
      uploads_playlist_id: ch.contentDetails.relatedPlaylists.uploads,
      last_checked_at: new Date().toISOString(),
    },
    pairedItem: { item: i },
  });
});
return out;
```

Node 6 — `Update Source Row` (Sheets appendOrUpdate per C3, tab `Source_Channels`, `matchingColumns: ["source_id"]`).

Connections: linear chain in node order (same shape as Task 6's connections object, one entry per node pointing to the next).

- [ ] **Step 2: Validate JSON**

```bash
python3 -m json.tool n8n/workflows/01-source-channel-registry.json > /dev/null && echo OK
```

- [ ] **Step 3: Replace `YOUTUBE_API_KEY`** in the `Pick Unresolved` code (it appears once, as `const KEY = 'YOUTUBE_API_KEY'`) — do this in the n8n UI after import, not in the committed file.

- [ ] **Step 4: Import + run** — import, attach Sheets credential, execute manually. Confirm `youtube_channel_id` (starts `UC`) and `uploads_playlist_id` (starts `UU`) populate for seeded rows.

- [ ] **Step 5: Commit**

```bash
git add n8n/workflows/01-source-channel-registry.json
git commit -m "feat(n8n): WF1 source channel registry resolves channel + uploads playlist IDs"
```

---

## Task 8: WF2 — Video Fetch workflow

**Files:**
- Create: `n8n/workflows/02-video-fetch.json`

Every 6h: per active channel, fetch 10 newest uploads, enrich with `videos.list`, dedup against `Candidate_Videos`, append new rows. ~2 YouTube quota units per channel per run.

- [ ] **Step 1: Write the workflow file** — name `WF2 Video Fetch`. Nodes and wiring:

```
Schedule 6h → Read Source_Channels → Read Candidate_Videos → Init Run
  → Channel Loop (SplitInBatches, batchSize 1)
      main[1] (each) → Fetch Uploads → Build Videos Lookup → Fetch Video Details
                      → Build Candidate Rows → Append Candidates → (back to Channel Loop)
      main[0] (done) → Emit Touched Channels → Update last_checked_at
```

Node 1 — `Schedule 6h` (`n8n-nodes-base.scheduleTrigger`, typeVersion 1.2):
```json
{ "rule": { "interval": [ { "field": "hours", "hoursInterval": 6 } ] } }
```

Node 2 — `Read Source_Channels` (Sheets read, tab `Source_Channels`).

Node 3 — `Read Candidate_Videos` (Sheets read, tab `Candidate_Videos`). Set node setting `alwaysOutputData: true` (top-level node key, sibling of `parameters`) so an empty tab doesn't halt the run.

Node 4 — `Init Run` (Code):
```javascript
// Build dedup set + select active channels. staticData survives across loop iterations.
const sd = $getWorkflowStaticData('global');
sd.existingIds = {};
for (const item of $('Read Candidate_Videos').all()) {
  const id = item.json.youtube_video_id;
  if (id) sd.existingIds[id] = true;
}
sd.touchedSources = [];
const channels = $('Read Source_Channels').all()
  .filter(i => String(i.json.active_status).toUpperCase() === 'TRUE' && i.json.uploads_playlist_id)
  .map((i, idx) => ({ json: i.json, pairedItem: { item: idx } }));
return channels;
```

Node 5 — `Channel Loop` (`n8n-nodes-base.splitInBatches`, typeVersion 3): `{ "batchSize": 1, "options": {} }`

Node 6 — `Fetch Uploads` (HTTP Request 4.2):
```json
{ "method": "GET",
  "url": "=https://www.googleapis.com/youtube/v3/playlistItems?part=contentDetails&maxResults=10&playlistId={{ $json.uploads_playlist_id }}&key=YOUTUBE_API_KEY",
  "options": {} }
```

Node 7 — `Build Videos Lookup` (Code):
```javascript
const channel = $('Channel Loop').first().json;
const api = $input.first().json;
const ids = (api.items || []).map(i => i.contentDetails.videoId).filter(Boolean);
if (ids.length === 0) {
  // nothing new — still must reach the loop input; emit marker handled downstream
  return [{ json: { __empty: true, ...channelMeta(channel) }, pairedItem: { item: 0 } }];
}
return [{ json: { video_ids: ids.join(','), ...channelMeta(channel) }, pairedItem: { item: 0 } }];

function channelMeta(c) {
  return { source_id: c.source_id, source_name: c.source_name, niche: c.niche, risk_level: c.risk_level };
}
```

Node 8 — `Fetch Video Details` (HTTP Request 4.2) — set top-level node key `"alwaysOutputData": true`:
```json
{ "method": "GET",
  "url": "=https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails,statistics,liveStreamingDetails&id={{ $json.video_ids || 'dQw4w9WgXcQ' }}&key=YOUTUBE_API_KEY",
  "options": {} }
```
(The `|| fallback` keeps the URL valid on the `__empty` marker; its response is discarded next node.)

Node 9 — `Build Candidate Rows` (Code) — ALWAYS returns ≥ 1 item (noop marker keeps the loop alive):
```javascript
const sd = $getWorkflowStaticData('global');
const meta = $('Build Videos Lookup').first().json;
sd.touchedSources.push(meta.source_id);
if (meta.__empty) return [{ json: { __noop: true }, pairedItem: { item: 0 } }];
const api = $input.first().json;
const out = [];
const now = new Date().toISOString();
for (const v of api.items || []) {
  if (sd.existingIds[v.id]) continue;
  sd.existingIds[v.id] = true; // dedup within run too
  out.push({
    json: {
      video_id: `VID-${v.id}`,
      niche: meta.niche,
      source_id: meta.source_id,
      source_name: meta.source_name,
      video_title: v.snippet.title,
      video_url: `https://www.youtube.com/watch?v=${v.id}`,
      youtube_video_id: v.id,
      duration_seconds: isoDurationToSeconds(v.contentDetails.duration),
      published_at: v.snippet.publishedAt,
      view_count: Number((v.statistics || {}).viewCount || 0),
      like_count: Number((v.statistics || {}).likeCount || 0),
      comment_count: Number((v.statistics || {}).commentCount || 0),
      transcript_available: '',
      language: v.snippet.defaultAudioLanguage || v.snippet.defaultLanguage || '',
      validity_status: '',
      validity_score: '',
      rejection_reason: '',
      duplicate_status: 'UNIQUE',
      processing_status: 'NEW',
      created_at: now,
      // extras consumed by WF3's rule engine, must exist as columns? NO — keep out of sheet:
      __category_id: v.snippet.categoryId || '',
      __is_live: v.snippet.liveBroadcastContent || 'none',
      __title_lower: (v.snippet.title || '').toLowerCase(),
    },
    pairedItem: { item: 0 },
  });
}
if (out.length === 0) return [{ json: { __noop: true }, pairedItem: { item: 0 } }];
return out;

function isoDurationToSeconds(iso) {
  const m = String(iso || '').match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return 0;
  return (Number(m[1] || 0) * 3600) + (Number(m[2] || 0) * 60) + Number(m[3] || 0);
}
```
The `__`-prefixed extras never reach the sheet — Node 10 consumes them (Sheets `autoMapInputData` would otherwise create bogus columns).

Node 10 — `Strip Internal Fields` (Code) — applies the YouTube-metadata rejections (category 10 = Music; live/upcoming streams) and strips internals. Always passes the `__noop` marker through so the loop never stalls:
```javascript
return $input.all().map((item, i) => {
  if (item.json.__noop) return { json: { __noop: true }, pairedItem: { item: i } };
  const { __category_id, __is_live, __title_lower, ...row } = item.json;
  if (__category_id === '10') { row.validity_status = 'REJECTED'; row.rejection_reason = 'MUSIC_VIDEO'; row.processing_status = 'SKIPPED'; }
  if (__is_live === 'live' || __is_live === 'upcoming') { row.validity_status = 'REJECTED'; row.rejection_reason = 'LIVE_STREAM'; row.processing_status = 'SKIPPED'; }
  return { json: row, pairedItem: { item: i } };
});
```

Node 11 — `Filter Real Rows` (Code) — append side-branch guard; may legitimately return zero items:
```javascript
return $input.all().filter(i => !i.json.__noop);
```

Node 12 — `Append Candidates` (Sheets append, tab `Candidate_Videos`).

Node 13 — `Emit Touched Channels` (Code; fed from Channel Loop done output):
```javascript
const sd = $getWorkflowStaticData('global');
const now = new Date().toISOString();
const ids = [...new Set(sd.touchedSources || [])];
sd.touchedSources = [];
sd.existingIds = {};
return ids.map((id, i) => ({ json: { source_id: id, last_checked_at: now }, pairedItem: { item: i } }));
```

Node 14 — `Update last_checked_at` (Sheets appendOrUpdate, tab `Source_Channels`, matching `source_id`).

Connections — **loop-back comes from `Strip Internal Fields`** (always ≥ 1 item, so the loop never stalls on a no-new-videos channel); the append path is a side-branch that may legitimately go empty:
```json
{ "Schedule 6h": { "main": [[{ "node": "Read Source_Channels", "type": "main", "index": 0 }]] },
  "Read Source_Channels": { "main": [[{ "node": "Read Candidate_Videos", "type": "main", "index": 0 }]] },
  "Read Candidate_Videos": { "main": [[{ "node": "Init Run", "type": "main", "index": 0 }]] },
  "Init Run": { "main": [[{ "node": "Channel Loop", "type": "main", "index": 0 }]] },
  "Channel Loop": { "main": [
    [{ "node": "Emit Touched Channels", "type": "main", "index": 0 }],
    [{ "node": "Fetch Uploads", "type": "main", "index": 0 }]
  ] },
  "Fetch Uploads": { "main": [[{ "node": "Build Videos Lookup", "type": "main", "index": 0 }]] },
  "Build Videos Lookup": { "main": [[{ "node": "Fetch Video Details", "type": "main", "index": 0 }]] },
  "Fetch Video Details": { "main": [[{ "node": "Build Candidate Rows", "type": "main", "index": 0 }]] },
  "Build Candidate Rows": { "main": [[{ "node": "Strip Internal Fields", "type": "main", "index": 0 }]] },
  "Strip Internal Fields": { "main": [[
    { "node": "Filter Real Rows", "type": "main", "index": 0 },
    { "node": "Channel Loop", "type": "main", "index": 0 }
  ]] },
  "Filter Real Rows": { "main": [[{ "node": "Append Candidates", "type": "main", "index": 0 }]] },
  "Emit Touched Channels": { "main": [[{ "node": "Update last_checked_at", "type": "main", "index": 0 }]] } }
```

- [ ] **Step 2: Validate JSON**

```bash
python3 -m json.tool n8n/workflows/02-video-fetch.json > /dev/null && echo OK
```

- [ ] **Step 3: Import + run** — replace both `YOUTUBE_API_KEY` occurrences (UI), run manually. Confirm: `Candidate_Videos` fills with rows, `processing_status=NEW`, durations are integers, music/live videos pre-rejected. Run AGAIN — confirm zero duplicate rows appended.

- [ ] **Step 4: Commit**

```bash
git add n8n/workflows/02-video-fetch.json
git commit -m "feat(n8n): WF2 video fetch with dedup and per-channel loop"
```

---

## Task 9: WF3 — Validity Check workflow

**Files:**
- Create: `n8n/workflows/03-validity-check.json`

Hourly deterministic rule engine — zero AI cost. Music/live already rejected by WF2; this handles the rest of the spec's rejection list.

- [ ] **Step 1: Write the workflow file** — name `WF3 Validity Check`, linear: `Schedule Hourly → Read Source_Channels → Read Candidate_Videos → Apply Rules → Update Candidate Rows`.

Node 1 — `Schedule Hourly` (scheduleTrigger 1.2): `{ "rule": { "interval": [ { "field": "hours", "hoursInterval": 1 } ] } }`

Node 2 — `Read Source_Channels` (Sheets read).

Node 3 — `Read Candidate_Videos` (Sheets read).

Node 4 — `Apply Rules` (Code):
```javascript
const riskBySource = {};
for (const s of $('Read Source_Channels').all()) {
  riskBySource[s.json.source_id] = String(s.json.risk_level || 'low').toLowerCase();
}

const REJECT_PATTERNS = [
  [/(official\s+)?(trailer|teaser)\b/i, 'TRAILER_OR_PROMO'],
  [/\bpromo(tion)?\b/i, 'TRAILER_OR_PROMO'],
  [/\b(official (music )?video|lyric video|audio)\b/i, 'MUSIC_VIDEO'],
  [/\b(compilation|best of|top \d+ moments|highlights)\b/i, 'COMPILATION'],
  [/\b(news bulletin|breaking news|live news)\b/i, 'NEWS_CLIP'],
  [/#shorts/i, 'SHORTS_UPLOAD'],
];
const PREFER_PATTERNS = [
  /podcast/i, /interview/i, /sermon/i, /teaching/i, /lesson/i, /masterclass/i,
  /conversation/i, /keynote/i, /q\s*&\s*a/i, /panel/i, /testimony/i,
];

const out = [];
for (const item of $input.all()) {
  const v = item.json;
  if (String(v.processing_status) !== 'NEW' || String(v.validity_status || '') !== '') continue;

  const title = String(v.video_title || '');
  const dur = Number(v.duration_seconds || 0);
  let status = 'VALID';
  let reason = '';

  if (dur > 0 && dur <= 60) { status = 'REJECTED'; reason = 'SHORTS_UPLOAD'; }
  else if (dur > 0 && dur < 180) { status = 'REJECTED'; reason = 'TOO_SHORT'; }
  else {
    for (const [re, code] of REJECT_PATTERNS) {
      if (re.test(title)) { status = 'REJECTED'; reason = code; break; }
    }
  }

  const lang = String(v.language || '').toLowerCase();
  if (status === 'VALID' && lang && !lang.startsWith('en') && !lang.startsWith('sw')) {
    status = 'FLAGGED'; reason = 'LANGUAGE_CHECK';
  }

  // Heuristic score 0–10: duration band + preferred keywords + traction
  let score = 5;
  if (dur >= 900 && dur <= 7200) score += 2;        // 15min–2h sweet spot
  else if (dur >= 300) score += 1;
  if (PREFER_PATTERNS.some(re => re.test(title))) score += 2;
  const views = Number(v.view_count || 0);
  if (views >= 10000) score += 1;
  score = Math.min(10, score);

  if (status === 'VALID' && riskBySource[v.source_id] === 'high') {
    status = 'FLAGGED'; reason = 'MANUAL_APPROVAL_REQUIRED';
  }

  out.push({
    json: {
      video_id: v.video_id,
      validity_status: status,
      validity_score: score,
      rejection_reason: reason,
      processing_status: status === 'REJECTED' ? 'SKIPPED' : v.processing_status,
    },
    pairedItem: { item: 0 },
  });
}
return out;
```
Note: transcript availability is deliberately NOT checked here (WF4's job — avoids paying double Lambda/proxy calls). `FLAGGED` rows wait for you to manually set `validity_status=VALID` in the sheet.

Node 5 — `Update Candidate Rows` (Sheets appendOrUpdate, tab `Candidate_Videos`, matching `video_id`).

Connections: linear chain in node order.

- [ ] **Step 2: Validate JSON**

```bash
python3 -m json.tool n8n/workflows/03-validity-check.json > /dev/null && echo OK
```

- [ ] **Step 3: Import + run** — execute manually after WF2 has populated rows. Confirm: long podcasts → `VALID` with score ≥ 7; a trailer/short → `REJECTED` with the right reason; high-risk source rows → `FLAGGED MANUAL_APPROVAL_REQUIRED`.

- [ ] **Step 4: Commit**

```bash
git add n8n/workflows/03-validity-check.json
git commit -m "feat(n8n): WF3 deterministic validity rule engine"
```

---

## Task 10: WF4 — Transcript Fetch workflow

**Files:**
- Create: `n8n/workflows/04-transcript-fetch.json`

Hourly: rows with `validity_status=VALID` and empty `transcript_available` → Lambda → `Transcript_Analysis`. Caps at 10 videos/run; 3s spacing protects the proxy budget.

- [ ] **Step 1: Write the workflow file** — name `WF4 Transcript Fetch`. Wiring:

```
Schedule Hourly → Read Candidate_Videos → Pick Pending Transcripts
  → Video Loop (SplitInBatches, 1)
      main[1] → Call Transcript Service → Route On Success (IF)
          true  → Build Analysis Row → Append Transcript_Analysis → Mark Transcript OK → Wait 3s → (loop)
          false → Mark Transcript Failed → Wait 3s b → (loop)
      main[0] → (no done-path work; ends)
```

Node 1 — `Schedule Hourly` (scheduleTrigger 1.2): `{ "rule": { "interval": [ { "field": "hours", "hoursInterval": 1 } ] } }`

Node 2 — `Read Candidate_Videos` (Sheets read).

Node 3 — `Pick Pending Transcripts` (Code):
```javascript
const pending = $input.all()
  .filter(i => String(i.json.validity_status) === 'VALID'
            && String(i.json.transcript_available || '') === '')
  .slice(0, 10);
return pending.map((i, idx) => ({ json: i.json, pairedItem: { item: idx } }));
```

Node 4 — `Video Loop` (splitInBatches 3): `{ "batchSize": 1, "options": {} }`

Node 5 — `Call Transcript Service` (HTTP Request 4.2). Set top-level node key `"onError": "continueRegularOutput"` (error JSON flows into the IF instead of killing the run):
```json
{ "method": "POST",
  "url": "TRANSCRIPT_SERVICE_URL",
  "sendHeaders": true,
  "headerParameters": { "parameters": [ { "name": "x-api-key", "value": "TRANSCRIPT_API_KEY" } ] },
  "sendBody": true,
  "specifyBody": "json",
  "jsonBody": "={{ JSON.stringify({ youtube_url: $json.video_url, language_preferences: ['en','en-US','en-GB','sw'] }) }}",
  "options": { "timeout": 60000 } }
```

Node 6 — `Route On Success` (`n8n-nodes-base.if`, typeVersion 2):
```json
{ "conditions": {
    "options": { "caseSensitive": true, "typeValidation": "loose" },
    "conditions": [ { "leftValue": "={{ $json.success }}", "rightValue": true, "operator": { "type": "boolean", "operation": "equals" } } ],
    "combinator": "and" } }
```

Node 7 — `Build Analysis Row` (Code):
```javascript
const video = $('Video Loop').first().json;
const resp = $input.first().json;
const snippets = resp.transcript || [];

// Timestamped transcript lines: "[MM:SS] text"
const lines = snippets.map(s => {
  const t = Math.floor(Number(s.start) || 0);
  const mm = String(Math.floor(t / 60)).padStart(2, '0');
  const ss = String(t % 60).padStart(2, '0');
  return `[${mm}:${ss}] ${s.text}`;
});
let transcriptText = lines.join('\n');
let status = 'FETCHED';
const LIMIT = 45000; // Sheets cell hard limit is 50k chars
if (transcriptText.length > LIMIT) {
  transcriptText = transcriptText.slice(0, LIMIT) + '\n...[TRUNCATED]';
  status = 'TRUNCATED';
}
const words = (resp.plain_text || '').split(/\s+/).filter(Boolean).length;

return [{
  json: {
    analysis_id: `AN-${video.youtube_video_id}`,
    video_id: video.video_id,
    niche: video.niche,
    video_title: video.video_title,
    video_url: video.video_url,
    transcript_status: status,
    transcript_text: transcriptText,
    transcript_length_words: words,
    ai_episode_score: '',
    recommended_strategy: '',
    recommended_start_sec: '',
    recommended_end_sec: '',
    reason_for_strategy: '',
    rights_risk: '',
    permission_risk: '',
    monetization_risk: '',
    originality_potential: '',
    kenya_relevance: '',
    ai_json_output: '',
    created_at: new Date().toISOString(),
  },
  pairedItem: { item: 0 },
}];
```

Node 8 — `Append Transcript_Analysis` (Sheets appendOrUpdate, tab `Transcript_Analysis`, matching `analysis_id` — deterministic key `AN-<youtube_video_id>` makes reruns idempotent).

Node 9 — `Mark Transcript OK` (Code):
```javascript
const video = $('Video Loop').first().json;
const resp = $('Call Transcript Service').first().json;
return [{ json: {
  video_id: video.video_id,
  transcript_available: 'TRUE',
  language: resp.language_code || video.language,
}, pairedItem: { item: 0 } }];
```
→ then `Update Candidate OK` (Sheets appendOrUpdate, `Candidate_Videos`, matching `video_id`).

Node 10 — `Mark Transcript Failed` (Code, false branch):
```javascript
const video = $('Video Loop').first().json;
const resp = $input.first().json;
const code = resp.error_code || (resp.error ? 'HTTP_ERROR' : 'UNKNOWN');
// IP_BLOCKED / FETCH_FAILED are infrastructure problems, not video problems — leave retryable
const infra = code === 'IP_BLOCKED' || code === 'FETCH_FAILED' || code === 'HTTP_ERROR';
return [{ json: {
  video_id: video.video_id,
  transcript_available: infra ? '' : 'FALSE',
  validity_status: infra ? video.validity_status : 'REJECTED',
  rejection_reason: infra ? '' : `TRANSCRIPT_${code}`,
  processing_status: infra ? video.processing_status : 'SKIPPED',
}, pairedItem: { item: 0 } }];
```
→ then `Update Candidate Failed` (Sheets appendOrUpdate, `Candidate_Videos`, matching `video_id`).

Nodes 11/12 — `Wait 3s` and `Wait 3s b` (`n8n-nodes-base.wait`, typeVersion 1.1): `{ "amount": 3 }` each.

Connections:
```json
{ "Schedule Hourly": { "main": [[{ "node": "Read Candidate_Videos", "type": "main", "index": 0 }]] },
  "Read Candidate_Videos": { "main": [[{ "node": "Pick Pending Transcripts", "type": "main", "index": 0 }]] },
  "Pick Pending Transcripts": { "main": [[{ "node": "Video Loop", "type": "main", "index": 0 }]] },
  "Video Loop": { "main": [ [], [{ "node": "Call Transcript Service", "type": "main", "index": 0 }] ] },
  "Call Transcript Service": { "main": [[{ "node": "Route On Success", "type": "main", "index": 0 }]] },
  "Route On Success": { "main": [
    [{ "node": "Build Analysis Row", "type": "main", "index": 0 }],
    [{ "node": "Mark Transcript Failed", "type": "main", "index": 0 }]
  ] },
  "Build Analysis Row": { "main": [[{ "node": "Append Transcript_Analysis", "type": "main", "index": 0 }]] },
  "Append Transcript_Analysis": { "main": [[{ "node": "Mark Transcript OK", "type": "main", "index": 0 }]] },
  "Mark Transcript OK": { "main": [[{ "node": "Update Candidate OK", "type": "main", "index": 0 }]] },
  "Update Candidate OK": { "main": [[{ "node": "Wait 3s", "type": "main", "index": 0 }]] },
  "Wait 3s": { "main": [[{ "node": "Video Loop", "type": "main", "index": 0 }]] },
  "Mark Transcript Failed": { "main": [[{ "node": "Update Candidate Failed", "type": "main", "index": 0 }]] },
  "Update Candidate Failed": { "main": [[{ "node": "Wait 3s b", "type": "main", "index": 0 }]] },
  "Wait 3s b": { "main": [[{ "node": "Video Loop", "type": "main", "index": 0 }]] } }
```

- [ ] **Step 2: Validate JSON**

```bash
python3 -m json.tool n8n/workflows/04-transcript-fetch.json > /dev/null && echo OK
```

- [ ] **Step 3: Import + run** — replace `TRANSCRIPT_SERVICE_URL` + `TRANSCRIPT_API_KEY` in the HTTP node (UI). Run manually with ≥1 VALID candidate. Confirm: `Transcript_Analysis` row appears with `[MM:SS]`-formatted text and word count; `Candidate_Videos.transcript_available=TRUE`. Force a failure (temporarily set a bogus video_url in the sheet) → row gets `REJECTED / TRANSCRIPT_INVALID_VIDEO_ID`.

- [ ] **Step 4: Commit**

```bash
git add n8n/workflows/04-transcript-fetch.json
git commit -m "feat(n8n): WF4 transcript fetch via Lambda with infra-vs-video error split"
```

---

## Task 11: WF5 — AI Transcript Analysis workflow

**Files:**
- Create: `n8n/workflows/05-ai-transcript-analysis.json`

The credit-saving brain. Hourly, max 5 analyses/run (~$0.01–0.03 each on gpt-4o-mini). Deterministic Code gates OVERRIDE the LLM: episode score < 7 → forced SKIP; window only if ≥ 3 clips score ≥ 7; max 3 exact clips.

- [ ] **Step 1: Write the workflow file** — name `WF5 AI Transcript Analysis`. Wiring:

```
Schedule Hourly → Read Transcript_Analysis → Read Source_Channels → Read Candidate_Videos → Pick Unanalyzed
  → Analysis Loop (SplitInBatches, 1)
      main[1] → Build OpenAI Request → Call OpenAI → Parse And Gate
                → Update Analysis Row → Update Candidate Status
                    ├─(conn 0)→ Explode Clip Moments → Append Clip_Moments   [side branch]
                    └─(conn 1)→ Analysis Loop                                 [loop-back]
```

Node 1 — `Schedule Hourly` (scheduleTrigger 1.2): `{ "rule": { "interval": [ { "field": "hours", "hoursInterval": 1 } ] } }`

Node 2 — `Read Transcript_Analysis` (Sheets read).

Node 3 — `Read Source_Channels` (Sheets read).

Node 3b — `Read Candidate_Videos` (Sheets read) — bridge for source risk: `Transcript_Analysis` lacks `source_id`, but `Candidate_Videos` maps `video_id → source_id` and `Source_Channels` maps `source_id → risk_level`.

Node 4 — `Pick Unanalyzed` (Code):
```javascript
const riskBySource = {};
for (const s of $('Read Source_Channels').all()) {
  riskBySource[s.json.source_id] = String(s.json.risk_level || 'low').toLowerCase();
}
const sourceByVideo = {};
for (const c of $('Read Candidate_Videos').all()) {
  sourceByVideo[c.json.video_id] = c.json.source_id;
}
const rows = $('Read Transcript_Analysis').all()
  .filter(i => ['FETCHED', 'TRUNCATED'].includes(String(i.json.transcript_status))
            && String(i.json.ai_episode_score || '') === '')
  .slice(0, 5);
return rows.map((i, idx) => ({
  json: { ...i.json, source_risk: riskBySource[sourceByVideo[i.json.video_id]] || 'low' },
  pairedItem: { item: idx },
}));
```

Node 5 — `Analysis Loop` (splitInBatches 3): `{ "batchSize": 1, "options": {} }`

Node 6 — `Build OpenAI Request` (Code). Contains the full MASTER_ANALYSIS_PROMPT — single source of truth:
```javascript
const row = $input.first().json;

const NICHE_RULES = {
  CHRISTIAN_CONTENT: `Prioritize biblical truth connected to daily life, work, discipline, money, relationships, identity, prayer, obedience, forgiveness, wisdom, and purpose. Suggest Bible verses only when genuinely relevant. Avoid taking Scripture out of context, attacking denominations unnecessarily, emotional manipulation, or extreme theological claims without context.`,
  MOTIVATION_DISCIPLINE: `Prioritize habits, focus, procrastination, consistency, routines, self-control, confidence, resilience, work ethic, and execution. Avoid vague hype, luxury flexing, alpha-male posturing, and generic "just work hard" advice. Every clip should include a practical action step.`,
  FINANCE_BUSINESS: `Prioritize saving, debt, budgeting, investing basics, business ideas, pricing, sales, income, entrepreneurship, wealth habits, cash flow, and money mistakes. Localize using KSh, M-Pesa, SACCOs, MMFs, Nairobi rent, side hustles, and SME realities. Avoid risky investment advice, get-rich-quick claims, or U.S.-only advice that does not translate to Kenya.`,
  LIFE_VALUES_RELATIONSHIPS: `Prioritize boundaries, communication, trust, self-worth, dating, marriage, emotional maturity, family values, and healthy conflict. Avoid gender-war content, manipulative dating advice, private therapy-style content, and rage-bait.`,
  AFRICAN_KENYAN_SUCCESS: `Prioritize founder lessons, practical wisdom, African business realities, Kenyan entrepreneurship, career growth, market realities, mistakes, resilience, and execution. Add context around M-Pesa culture, cost of capital, unemployment, family obligations, Nairobi business reality, and local customer behavior.`,
};

const SYSTEM_PROMPT = `You are a short-form video content strategist for a Kenya-based commentary brand.

Your job is not to simply find emotional or viral moments. Your job is to find moments that can become original, valuable short-form videos through narration, commentary, African/Kenyan context, lesson breakdowns, visual examples, Bible verses where relevant, and practical action steps.

The goal is to save Ssemble credits. Ssemble uses 1 credit per YouTube video request and can process a maximum 20-minute window (minimum 60 seconds). It can receive either:
1. One 20-minute timestamp window and generate multiple clips from that section
2. Exact timestamp ranges for specific clips (each range costs 1 credit)

Your job is to decide the most credit-efficient extraction strategy.

Analyze the transcript and identify the best short-form content opportunities.

Prioritize moments that are:
- Useful and educational
- Clear without needing too much context
- Easy to transform into original commentary
- Relevant to Kenya/Africa where possible
- Brand-safe
- Not purely controversial
- Not purely emotional
- Not dependent on celebrity gossip
- Not likely to create high copyright/reused-content risk
- Strong enough to support narration, B-roll, examples, and action steps

Avoid moments that are:
- Too vague
- Too dependent on the full conversation
- Mostly jokes or banter
- Mostly personal/private pain without a clear lesson
- Too controversial without educational value
- Likely to be copyright-risky if used as the main content
- Only valuable because of the speaker's fame

Choose one extraction strategy:
A. USE_20_MIN_WINDOW — choose this if there is a dense section with at least 3-5 strong clip opportunities inside one 20-minute span.
B. USE_EXACT_CLIPS_ONLY — choose this if the best moments are scattered across the episode.
C. SKIP_THIS_VIDEO — choose this if the transcript does not contain enough valuable, transformable moments.

Scoring rules — score each clip 1-10 using: Value (teaches something useful), Clarity (stands alone), Hook strength (first 2 seconds stop scrolling), Transformation potential (commentary + local examples), Brand safety (long-term monetization), Kenya/Africa relevance, Clip efficiency (worth a Ssemble credit).
Only recommend a clip if clip_score is 7 or higher.
Only recommend a 20-minute window if the window contains at least 3 strong clips with scores of 7 or higher.
If no clips score 7 or higher, recommend SKIP_THIS_VIDEO.

Important originality rule: the final video should not feel like a reposted podcast clip with captions. The clip is supporting material; original narration, framing, lesson breakdown, Kenyan/African application, visual examples, and action steps carry the value. For risky sources, recommend use_as_idea_only instead of clip.

Niche rules for this video's niche are provided in the user message.

Return VALID JSON ONLY, exactly matching this schema:
{
  "video_title": "", "video_url": "", "source_channel": "", "niche": "",
  "overall_episode_score": 0,
  "recommended_strategy": "USE_20_MIN_WINDOW | USE_EXACT_CLIPS_ONLY | SKIP_THIS_VIDEO",
  "reason_for_strategy": "",
  "best_20_min_window": { "use_this": true, "start_time": "00:00:00", "end_time": "00:20:00", "start_sec": 0, "end_sec": 1200, "why_this_window": "", "estimated_number_of_good_clips": 0 },
  "exact_clips": [ { "rank": 1, "start_time": "00:00:00", "end_time": "00:00:45", "start_sec": 0, "end_sec": 45, "clip_length_seconds": 45, "clip_score": 0, "hook_first_2_seconds": "", "core_idea": "", "why_it_is_valuable": "", "best_target_audience": "", "best_video_length": "under_30_sec | 30_60_sec | 60_90_sec | 3_5_min", "suggested_title": "", "suggested_caption": "", "on_screen_text": "", "suggested_b_roll": [], "my_original_commentary_angle": "", "kenyan_african_application": "", "bible_verse_if_relevant": null, "monetization_risk": "low | medium | high", "copyright_or_reused_content_risk": "low | medium | high", "does_it_need_extra_context": true, "extra_context_needed": "", "originality_score": 0, "final_recommendation": "clip | use_as_idea_only | skip" } ],
  "best_3_clips_to_produce_first": [],
  "clips_to_avoid": [ { "timestamp": "", "reason_to_avoid": "" } ],
  "overall_transformation_plan": "", "editor_notes": "", "narration_notes": "", "b_roll_notes": "", "risk_notes": ""
}`;

// gpt-4o-mini context = 128k tokens; transcripts arrive pre-truncated at 45k chars (~12k tokens) — safe.
const userContent = [
  `Video title: ${row.video_title}`,
  `Video URL: ${row.video_url}`,
  `Channel/source: (see Source_Channels tab)`,
  `Niche: ${row.niche}`,
  `Niche rules: ${NICHE_RULES[row.niche] || 'General educational value.'}`,
  `Transcript with timestamps:`,
  String(row.transcript_text || '').slice(0, 100000),
].join('\n');

return [{
  json: {
    ...row,
    openai_body: JSON.stringify({
      model: 'gpt-4o-mini',
      response_format: { type: 'json_object' },
      temperature: 0.4,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userContent },
      ],
    }),
  },
  pairedItem: { item: 0 },
}];
```

Node 7 — `Call OpenAI` (HTTP Request per C4, `jsonBody: "={{ $json.openai_body }}"`, credential `OpenAI API`).

Node 8 — `Parse And Gate` (Code) — THE credit gate; never trust the LLM's strategy blindly:
```javascript
const row = $('Build OpenAI Request').first().json;
const resp = $input.first().json;
let ai;
try {
  ai = JSON.parse(resp.choices[0].message.content);
} catch (err) {
  throw new Error(`AI returned unparseable JSON for ${row.video_id}: ${String(err)}`);
}

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, Number(n) || 0));
const episodeScore = clamp(ai.overall_episode_score, 0, 10);

// Gate 1: keep only clips scoring >= 7 with sane timestamps, ranked by score, top 3
let clips = (ai.exact_clips || [])
  .filter(c => clamp(c.clip_score, 0, 10) >= 7)
  .filter(c => Number(c.end_sec) > Number(c.start_sec) && Number(c.start_sec) >= 0)
  .sort((a, b) => clamp(b.clip_score, 0, 10) - clamp(a.clip_score, 0, 10))
  .slice(0, 3);

// Gate 2: strategy enforcement
let strategy = String(ai.recommended_strategy || 'SKIP_THIS_VIDEO');
if (episodeScore < 7) strategy = 'SKIP_THIS_VIDEO';
if (strategy === 'USE_20_MIN_WINDOW') {
  const w = ai.best_20_min_window || {};
  const winLen = Number(w.end_sec) - Number(w.start_sec);
  const strongInWindow = clips.filter(c => Number(c.start_sec) >= Number(w.start_sec) && Number(c.end_sec) <= Number(w.end_sec)).length;
  if (!(winLen >= 60 && winLen <= 1200) || strongInWindow < 3) {
    strategy = clips.length > 0 ? 'USE_EXACT_CLIPS_ONLY' : 'SKIP_THIS_VIDEO';
  }
}
if (strategy === 'USE_EXACT_CLIPS_ONLY' && clips.length === 0) strategy = 'SKIP_THIS_VIDEO';

const w = ai.best_20_min_window || {};
const riskMax = arr => arr.includes('high') ? 'high' : (arr.includes('medium') ? 'medium' : 'low');
const clipRisks = clips.map(c => String(c.copyright_or_reused_content_risk || 'low'));
const highRiskSource = String(row.source_risk) === 'high'; // per-credit manual gate for risky sources
const now = new Date().toISOString();

const analysisUpdate = {
  analysis_id: row.analysis_id,
  ai_episode_score: episodeScore,
  recommended_strategy: strategy,
  recommended_start_sec: strategy === 'USE_20_MIN_WINDOW' ? Number(w.start_sec) : '',
  recommended_end_sec: strategy === 'USE_20_MIN_WINDOW' ? Number(w.end_sec) : '',
  reason_for_strategy: String(ai.reason_for_strategy || '').slice(0, 1000),
  rights_risk: riskMax(clipRisks),
  monetization_risk: riskMax(clips.map(c => String(c.monetization_risk || 'low'))),
  originality_potential: clips.length ? Math.max(...clips.map(c => clamp(c.originality_score, 0, 10))) : 0,
  kenya_relevance: String(ai.risk_notes || '').slice(0, 300),
  ai_json_output: JSON.stringify(ai).slice(0, 40000),
};

const candidateUpdate = {
  video_id: row.video_id,
  processing_status: strategy === 'SKIP_THIS_VIDEO' ? 'SKIPPED' : 'ANALYZED',
};

// Clip_Moments rows: window strategy synthesizes ONE rank-0 row; exact = one per clip
let momentRows = [];
if (strategy === 'USE_20_MIN_WINDOW') {
  momentRows = [{
    clip_moment_id: `CM-${row.video_id}-W0`,
    video_id: row.video_id, niche: row.niche, rank: 0,
    start_sec: Number(w.start_sec), end_sec: Number(w.end_sec),
    clip_length_seconds: Number(w.end_sec) - Number(w.start_sec),
    hook_first_2_seconds: '', core_idea: String(w.why_this_window || '').slice(0, 500),
    why_valuable: `window with ~${w.estimated_number_of_good_clips} strong clips`,
    target_audience: '', suggested_title: '', suggested_caption: '', on_screen_text: '',
    suggested_broll: '', commentary_angle: '', kenyan_african_application: '',
    bible_verse_if_relevant: '', needs_extra_context: 'FALSE',
    originality_score: '', clip_score: episodeScore, rights_risk: riskMax(clipRisks),
    final_recommendation: 'clip',
    ssemble_status: highRiskSource ? 'AWAITING_MANUAL_APPROVAL' : 'PENDING',
    ssemble_job_id: '',
    strategy, source_video_url: row.video_url, created_at: now,
  }];
} else if (strategy === 'USE_EXACT_CLIPS_ONLY') {
  momentRows = clips
    .filter(c => String(c.final_recommendation) === 'clip')
    .map((c, i) => ({
      clip_moment_id: `CM-${row.video_id}-${i + 1}`,
      video_id: row.video_id, niche: row.niche, rank: i + 1,
      start_sec: Number(c.start_sec), end_sec: Number(c.end_sec),
      clip_length_seconds: Number(c.end_sec) - Number(c.start_sec),
      hook_first_2_seconds: String(c.hook_first_2_seconds || ''),
      core_idea: String(c.core_idea || '').slice(0, 500),
      why_valuable: String(c.why_it_is_valuable || '').slice(0, 500),
      target_audience: String(c.best_target_audience || ''),
      suggested_title: String(c.suggested_title || ''),
      suggested_caption: String(c.suggested_caption || '').slice(0, 500),
      on_screen_text: String(c.on_screen_text || ''),
      suggested_broll: JSON.stringify(c.suggested_b_roll || []),
      commentary_angle: String(c.my_original_commentary_angle || '').slice(0, 500),
      kenyan_african_application: String(c.kenyan_african_application || '').slice(0, 500),
      bible_verse_if_relevant: c.bible_verse_if_relevant || '',
      needs_extra_context: c.does_it_need_extra_context ? 'TRUE' : 'FALSE',
      originality_score: clamp(c.originality_score, 0, 10),
      clip_score: clamp(c.clip_score, 0, 10),
      rights_risk: String(c.copyright_or_reused_content_risk || 'low'),
      final_recommendation: String(c.final_recommendation),
      ssemble_status: (highRiskSource || String(c.copyright_or_reused_content_risk) === 'high') ? 'AWAITING_MANUAL_APPROVAL' : 'PENDING',
      ssemble_job_id: '', strategy, source_video_url: row.video_url, created_at: now,
    }));
  if (momentRows.length === 0) candidateUpdate.processing_status = 'SKIPPED';
}

return [{ json: { analysisUpdate, candidateUpdate, momentRows }, pairedItem: { item: 0 } }];
```

Node 9 — `Update Analysis Row` (Code → Sheets pair). Code `Shape Analysis Update`: `return [{ json: $input.first().json.analysisUpdate, pairedItem: { item: 0 } }];` then Sheets appendOrUpdate `Transcript_Analysis` matching `analysis_id`.

Node 10 — `Shape Candidate Update` (Code): `return [{ json: $('Parse And Gate').first().json.candidateUpdate, pairedItem: { item: 0 } }];` then Sheets appendOrUpdate `Candidate_Videos` matching `video_id` (name it `Update Candidate Status`).

Node 11 — `Explode Clip Moments` (Code, side branch — may return zero items):
```javascript
const rows = $('Parse And Gate').first().json.momentRows || [];
return rows.map((r, i) => ({ json: r, pairedItem: { item: i } }));
```

Node 12 — `Append Clip_Moments` (Sheets appendOrUpdate, tab `Clip_Moments`, matching `clip_moment_id` — deterministic `CM-<video_id>-<n>` keys make reruns idempotent).

Connections (loop-back from `Update Candidate Status`, side-branch order: explode first, loop second — n8n executes connection index order):
```json
{ "Schedule Hourly": { "main": [[{ "node": "Read Transcript_Analysis", "type": "main", "index": 0 }]] },
  "Read Transcript_Analysis": { "main": [[{ "node": "Read Source_Channels", "type": "main", "index": 0 }]] },
  "Read Source_Channels": { "main": [[{ "node": "Read Candidate_Videos", "type": "main", "index": 0 }]] },
  "Read Candidate_Videos": { "main": [[{ "node": "Pick Unanalyzed", "type": "main", "index": 0 }]] },
  "Pick Unanalyzed": { "main": [[{ "node": "Analysis Loop", "type": "main", "index": 0 }]] },
  "Analysis Loop": { "main": [ [], [{ "node": "Build OpenAI Request", "type": "main", "index": 0 }] ] },
  "Build OpenAI Request": { "main": [[{ "node": "Call OpenAI", "type": "main", "index": 0 }]] },
  "Call OpenAI": { "main": [[{ "node": "Parse And Gate", "type": "main", "index": 0 }]] },
  "Parse And Gate": { "main": [[{ "node": "Shape Analysis Update", "type": "main", "index": 0 }]] },
  "Shape Analysis Update": { "main": [[{ "node": "Update Analysis Row", "type": "main", "index": 0 }]] },
  "Update Analysis Row": { "main": [[{ "node": "Shape Candidate Update", "type": "main", "index": 0 }]] },
  "Shape Candidate Update": { "main": [[{ "node": "Update Candidate Status", "type": "main", "index": 0 }]] },
  "Update Candidate Status": { "main": [[
    { "node": "Explode Clip Moments", "type": "main", "index": 0 },
    { "node": "Analysis Loop", "type": "main", "index": 0 }
  ]] },
  "Explode Clip Moments": { "main": [[{ "node": "Append Clip_Moments", "type": "main", "index": 0 }]] } }
```

- [ ] **Step 2: Validate JSON**

```bash
python3 -m json.tool n8n/workflows/05-ai-transcript-analysis.json > /dev/null && echo OK
```

- [ ] **Step 3: Import + run** — attach `OpenAI API` Header Auth + Sheets credentials. Run with 1–2 FETCHED transcripts. Verify: `Transcript_Analysis` gets score/strategy/full `ai_json_output`; `Clip_Moments` rows appear only for non-SKIP strategies, max 3, all `clip_score >= 7`, timestamps within video duration; a low-value video (e.g. music chatter) gets `SKIPPED`.

- [ ] **Step 4: Gate unit check (no n8n needed)** — paste the `Parse And Gate` body into a scratch Node REPL with stubbed `$input`/`$('...')` returning a fake AI response with `overall_episode_score: 5` → expect strategy forced to `SKIP_THIS_VIDEO`. With score 8 + only 2 window clips ≥ 7 → expect downgrade to `USE_EXACT_CLIPS_ONLY`.

- [ ] **Step 5: Commit**

```bash
git add n8n/workflows/05-ai-transcript-analysis.json
git commit -m "feat(n8n): WF5 AI analysis with deterministic Ssemble credit gates"
```

---

## Task 12: WF6 — Ssemble Dispatch workflow

**Files:**
- Create: `n8n/workflows/06-ssemble-dispatch.json`

The ONLY workflow that spends money. Every 2h. Hard daily budget (default 10 credits) counted from today's `Ssemble_Jobs` rows. Enforces verified constraints: 60 ≤ range ≤ 1200s, `noClipping:true` for exact clips, padding for sub-60s moments.

- [ ] **Step 1: Write the workflow file** — name `WF6 Ssemble Dispatch`. Wiring:

```
Schedule 2h → Read Clip_Moments → Read Ssemble_Jobs → Plan Requests
  → Dispatch Loop (SplitInBatches, 1)
      main[1] → Call Ssemble Create → Route On Created (IF)
          true  → Build Job Row → Append Ssemble_Jobs → Mark Moment Submitted → Wait 5s → (loop)
          false → Mark Moment Error → Wait 5s b → (loop)
```

Node 1 — `Schedule 2h` (scheduleTrigger 1.2): `{ "rule": { "interval": [ { "field": "hours", "hoursInterval": 2 } ] } }`

Node 2 — `Read Clip_Moments` (Sheets read).

Node 3 — `Read Ssemble_Jobs` (Sheets read, `alwaysOutputData: true`).

Node 4 — `Plan Requests` (Code):
```javascript
const DAILY_BUDGET = 10; // credits/day — operational knob
const WEBHOOK_URL = 'https://YOUR_N8N_DOMAIN/webhook/ssemble-callback?secret=SSEMBLE_WEBHOOK_SECRET';

// Budget day = Nairobi calendar day (created_at is stored as UTC ISO)
const nairobiDay = d => new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Nairobi' }).format(new Date(d));
const today = nairobiDay(new Date());
const jobs = $('Read Ssemble_Jobs').all().map(i => i.json);
// SUBMIT_FAILED rows consumed no credit — exclude from spend
const spentToday = jobs.filter(j => j.created_at && nairobiDay(j.created_at) === today
  && String(j.job_status) !== 'SUBMIT_FAILED').length;
let remaining = Math.max(0, DAILY_BUDGET - spentToday);
console.log(`Ssemble budget: ${spentToday} spent today, ${remaining} remaining`);
if (remaining === 0) return [];

// Duplicate-dispatch guard: a moment with ANY real job row (submitted/completed/failed-processing)
// is never re-sent, even if the Clip_Moments status write failed after a successful API call.
const dispatched = {};
for (const j of jobs) {
  if (j.clip_moment_id && String(j.job_status) !== 'SUBMIT_FAILED') dispatched[j.clip_moment_id] = true;
}

const pending = $('Read Clip_Moments').all()
  .map(i => i.json)
  .filter(m => String(m.ssemble_status) === 'PENDING' && !dispatched[m.clip_moment_id]);

// Group by video; windows first (best credit value), then exact clips by clip_score
const byVideo = {};
for (const m of pending) (byVideo[m.video_id] = byVideo[m.video_id] || []).push(m);

const requests = [];
for (const videoId of Object.keys(byVideo)) {
  const moments = byVideo[videoId].sort((a, b) => Number(b.clip_score || 0) - Number(a.clip_score || 0));
  for (const m of moments) {
    if (remaining === 0) break;
    let start = Math.max(0, Math.floor(Number(m.start_sec)));
    let end = Math.floor(Number(m.end_sec));
    // Pad sub-60s ranges (Ssemble minimum window = 60s): extend symmetrically
    if (end - start < 60) {
      const pad = Math.ceil((60 - (end - start)) / 2);
      start = Math.max(0, start - pad);
      end = start + 60;
    }
    if (end - start > 1200) end = start + 1200; // hard max
    const isWindow = String(m.strategy) === 'USE_20_MIN_WINDOW';
    requests.push({
      clip_moment_id: m.clip_moment_id,
      video_id: m.video_id,
      niche: m.niche,
      source_video_url: m.source_video_url,
      start_sec: start,
      end_sec: end,
      ssemble_body: JSON.stringify({
        url: m.source_video_url,
        start,
        end,
        preferredLength: 'under60sec',
        language: 'en',
        music: false,
        layout: 'auto',
        ...(isWindow ? {} : { noClipping: true }),
        webhookUrl: WEBHOOK_URL,
      }),
    });
    remaining -= 1;
  }
}
console.log(`Dispatching ${requests.length} Ssemble requests (${requests.length} credits)`);
return requests.map((r, i) => ({ json: r, pairedItem: { item: i } }));
```

Node 5 — `Dispatch Loop` (splitInBatches 3): `{ "batchSize": 1, "options": {} }`

Node 6 — `Call Ssemble Create` (HTTP Request 4.2, top-level `"onError": "continueRegularOutput"`, credential `Ssemble API` — Header Auth `X-API-Key`):
```json
{ "method": "POST",
  "url": "https://aiclipping.ssemble.com/api/v1/shorts/create",
  "authentication": "genericCredentialType",
  "genericAuthType": "httpHeaderAuth",
  "sendBody": true,
  "specifyBody": "json",
  "jsonBody": "={{ $json.ssemble_body }}",
  "options": { "timeout": 60000 } }
```

Node 7 — `Route On Created` (IF v2, loose):
```json
{ "conditions": {
    "options": { "caseSensitive": true, "typeValidation": "loose" },
    "conditions": [ { "leftValue": "={{ $json.data && $json.data.requestId }}", "rightValue": "", "operator": { "type": "string", "operation": "notEmpty", "singleValue": true } } ],
    "combinator": "and" } }
```

Node 8 — `Build Job Row` (Code):
```javascript
const req = $('Dispatch Loop').first().json;
const resp = $input.first().json;
return [{ json: {
  ssemble_job_id: resp.data.requestId,
  video_id: req.video_id,
  clip_moment_id: req.clip_moment_id,
  niche: req.niche,
  source_video_url: req.source_video_url,
  start_sec: req.start_sec,
  end_sec: req.end_sec,
  request_payload: req.ssemble_body,
  response_payload: JSON.stringify(resp).slice(0, 40000),
  job_status: 'SUBMITTED',
  webhook_received: 'FALSE',
  error_message: '',
  created_at: new Date().toISOString(),
  completed_at: '',
}, pairedItem: { item: 0 } }];
```

Node 9 — `Append Ssemble_Jobs` (Sheets append, tab `Ssemble_Jobs`).

Node 10 — `Mark Moment Submitted` (Code):
```javascript
const req = $('Dispatch Loop').first().json;
const resp = $('Call Ssemble Create').first().json;
return [{ json: {
  clip_moment_id: req.clip_moment_id,
  ssemble_status: 'SUBMITTED',
  ssemble_job_id: resp.data.requestId,
}, pairedItem: { item: 0 } }];
```
→ then `Update Moment Submitted` (Sheets appendOrUpdate, `Clip_Moments`, matching `clip_moment_id`).

Node 11 — `Build Failed Job Row` (Code, false branch) — persists soft API failures to `Ssemble_Jobs` so they never vanish into execution logs. `SUBMIT_FAILED` rows are excluded from both the budget count and the duplicate-dispatch guard, so resetting the moment to `PENDING` in the sheet retries it cleanly:
```javascript
const req = $('Dispatch Loop').first().json;
const resp = $input.first().json;
const msg = (resp.error && resp.error.message) || resp.message || JSON.stringify(resp).slice(0, 500);
return [{ json: {
  ssemble_job_id: `SUBMITFAIL-${req.clip_moment_id}-${Date.now()}`,
  video_id: req.video_id,
  clip_moment_id: req.clip_moment_id,
  niche: req.niche,
  source_video_url: req.source_video_url,
  start_sec: req.start_sec,
  end_sec: req.end_sec,
  request_payload: req.ssemble_body,
  response_payload: JSON.stringify(resp).slice(0, 40000),
  job_status: 'SUBMIT_FAILED',
  webhook_received: 'FALSE',
  error_message: String(msg),
  created_at: new Date().toISOString(),
  completed_at: '',
}, pairedItem: { item: 0 } }];
```
→ then `Append Failed Job` (Sheets append, tab `Ssemble_Jobs`) → `Mark Moment Error` (Code):
```javascript
const req = $('Dispatch Loop').first().json;
return [{ json: { clip_moment_id: req.clip_moment_id, ssemble_status: 'ERROR' }, pairedItem: { item: 0 } }];
```
→ then `Update Moment Error` (Sheets appendOrUpdate, `Clip_Moments`, matching `clip_moment_id`).

Nodes 12/13 — `Wait 5s` / `Wait 5s b` (wait 1.1): `{ "amount": 5 }`.

Connections (same branch pattern as WF4):
```json
{ "Schedule 2h": { "main": [[{ "node": "Read Clip_Moments", "type": "main", "index": 0 }]] },
  "Read Clip_Moments": { "main": [[{ "node": "Read Ssemble_Jobs", "type": "main", "index": 0 }]] },
  "Read Ssemble_Jobs": { "main": [[{ "node": "Plan Requests", "type": "main", "index": 0 }]] },
  "Plan Requests": { "main": [[{ "node": "Dispatch Loop", "type": "main", "index": 0 }]] },
  "Dispatch Loop": { "main": [ [], [{ "node": "Call Ssemble Create", "type": "main", "index": 0 }] ] },
  "Call Ssemble Create": { "main": [[{ "node": "Route On Created", "type": "main", "index": 0 }]] },
  "Route On Created": { "main": [
    [{ "node": "Build Job Row", "type": "main", "index": 0 }],
    [{ "node": "Build Failed Job Row", "type": "main", "index": 0 }]
  ] },
  "Build Failed Job Row": { "main": [[{ "node": "Append Failed Job", "type": "main", "index": 0 }]] },
  "Append Failed Job": { "main": [[{ "node": "Mark Moment Error", "type": "main", "index": 0 }]] },
  "Build Job Row": { "main": [[{ "node": "Append Ssemble_Jobs", "type": "main", "index": 0 }]] },
  "Append Ssemble_Jobs": { "main": [[{ "node": "Mark Moment Submitted", "type": "main", "index": 0 }]] },
  "Mark Moment Submitted": { "main": [[{ "node": "Update Moment Submitted", "type": "main", "index": 0 }]] },
  "Update Moment Submitted": { "main": [[{ "node": "Wait 5s", "type": "main", "index": 0 }]] },
  "Wait 5s": { "main": [[{ "node": "Dispatch Loop", "type": "main", "index": 0 }]] },
  "Mark Moment Error": { "main": [[{ "node": "Update Moment Error", "type": "main", "index": 0 }]] },
  "Update Moment Error": { "main": [[{ "node": "Wait 5s b", "type": "main", "index": 0 }]] },
  "Wait 5s b": { "main": [[{ "node": "Dispatch Loop", "type": "main", "index": 0 }]] } }
```

- [ ] **Step 2: Validate JSON**

```bash
python3 -m json.tool n8n/workflows/06-ssemble-dispatch.json > /dev/null && echo OK
```

- [ ] **Step 3: DRY RUN before spending a credit** — import, replace `YOUR_N8N_DOMAIN` + `SSEMBLE_WEBHOOK_SECRET` in `Plan Requests` (UI). **Disable the `Call Ssemble Create` node** (right-click → Deactivate), run manually, inspect `Plan Requests` output: payload fields correct, sub-60s ranges padded to exactly 60, budget math right (`console.log` lines in browser console). Re-enable only when WF7 is deployed and reachable.

- [ ] **Step 4: Commit**

```bash
git add n8n/workflows/06-ssemble-dispatch.json
git commit -m "feat(n8n): WF6 Ssemble dispatch with daily credit budget and 60s padding"
```

---

## Task 13: WF7 — Ssemble Webhook Receiver workflow

**Files:**
- Create: `n8n/workflows/07-ssemble-webhook-receiver.json`

Ssemble retries only 3× with 10s timeouts → webhook must ACK instantly (`responseMode: onReceived`) and do NO heavy work (Drive downloads live in WF8). No signature headers exist → secret query param is the only auth.

- [ ] **Step 1: Write the workflow file** — name `WF7 Ssemble Webhook Receiver`. Wiring:

```
Webhook → Verify And Parse → Read Ssemble_Jobs → Attach Moment → Route On Completed (IF)
   true  → Shape Job Completed → Update Job Completed → Shape Moment Completed → Update Moment Completed
           → Explode Shorts → Append Created_Clips
   false → Shape Job Failed → Update Job Failed → Shape Moment Failed → Update Moment Failed
```
(Webhook ACKs instantly via `responseMode: onReceived`, so the extra Sheets read costs nothing on the Ssemble side.)

Node 1 — `Webhook` (`n8n-nodes-base.webhook`, typeVersion 2):
```json
{ "httpMethod": "POST", "path": "ssemble-callback", "responseMode": "onReceived", "options": {} }
```

Node 2 — `Verify And Parse` (Code):
```javascript
const SECRET = 'SSEMBLE_WEBHOOK_SECRET';
const input = $input.first().json;
const query = input.query || {};
if (query.secret !== SECRET) {
  throw new Error('Webhook secret mismatch — dropping payload');
}
const p = input.body || {};
const completed = p.event === 'shorts.completed';
return [{ json: {
  completed,
  requestId: p.requestId || '',
  timestamp: p.timestamp || new Date().toISOString(),
  shorts: (completed && p.data && p.data.shorts) || [],
  failureReason: (!completed && p.data && p.data.failureReason) || '',
  raw: JSON.stringify(p).slice(0, 40000),
}, pairedItem: { item: 0 } }];
```

Node 2b — `Read Ssemble_Jobs` (Sheets read, `alwaysOutputData: true`).

Node 2c — `Attach Moment` (Code) — resolves `clip_moment_id`/`video_id`/`niche` from the job row so both branches can update `Clip_Moments` and `Created_Clips` rows carry their lineage:
```javascript
const d = $('Verify And Parse').first().json;
const job = $('Read Ssemble_Jobs').all().map(i => i.json)
  .find(j => String(j.ssemble_job_id) === String(d.requestId)) || {};
return [{ json: {
  ...d,
  clip_moment_id: job.clip_moment_id || '',
  video_id: job.video_id || '',
  niche: job.niche || '',
}, pairedItem: { item: 0 } }];
```

Node 3 — `Route On Completed` (IF v2):
```json
{ "conditions": {
    "options": { "caseSensitive": true, "typeValidation": "strict" },
    "conditions": [ { "leftValue": "={{ $json.completed }}", "rightValue": true, "operator": { "type": "boolean", "operation": "equals" } } ],
    "combinator": "and" } }
```

Node 4 — `Update Job Completed` (Code → Sheets pair). Code `Shape Job Completed`:
```javascript
const d = $input.first().json;
return [{ json: {
  ssemble_job_id: d.requestId,
  job_status: 'COMPLETED',
  webhook_received: 'TRUE',
  response_payload: d.raw,
  completed_at: d.timestamp,
}, pairedItem: { item: 0 } }];
```
→ Sheets appendOrUpdate `Ssemble_Jobs` matching `ssemble_job_id` (node name `Update Job Completed`).

Node 4b — `Shape Moment Completed` (Code) — closes the `Clip_Moments` state machine (`SUBMITTED → COMPLETED`):
```javascript
const d = $('Attach Moment').first().json;
// Orphan webhooks (e.g. curl test payloads with no matching job) update a single harmless
// NOOP-ORPHAN row instead of returning [] — keeps the chain to Explode Shorts alive.
const id = d.clip_moment_id || 'NOOP-ORPHAN';
return [{ json: { clip_moment_id: id, ssemble_status: 'COMPLETED' }, pairedItem: { item: 0 } }];
```
→ Sheets appendOrUpdate `Clip_Moments` matching `clip_moment_id` (node name `Update Moment Completed`).

Node 5 — `Explode Shorts` (Code) — one `Created_Clips` staging row per generated short, lineage from `Attach Moment`:
```javascript
const d = $('Attach Moment').first().json;
const now = new Date().toISOString();
return (d.shorts || []).map((s, i) => ({ json: {
  created_clip_id: `CC-${s.id}`,
  ssemble_job_id: d.requestId,
  video_id: d.video_id || '',
  niche: d.niche || '',
  clip_title: String(s.title || ''),
  clip_url: String(s.video_url || ''),
  local_file_name: '',
  google_drive_file_id: '',
  google_drive_url: '',
  duration_seconds: Number(s.duration || 0),
  transcript_excerpt: '',
  suggested_title: '',
  suggested_caption: '',
  transformation_plan: '',
  review_status: 'AWAITING_DOWNLOAD',
  reviewer_notes: `viral_score=${s.viral_score}`,
  created_at: now,
}, pairedItem: { item: i } }));
```

Node 6 — `Append Created_Clips` (Sheets appendOrUpdate, tab `Created_Clips`, matching `created_clip_id` — deterministic `CC-<short id>` keys absorb Ssemble's up-to-3 webhook retries without duplicate rows).

Node 7 — `Shape Job Failed` (Code, false branch):
```javascript
const d = $input.first().json;
return [{ json: {
  ssemble_job_id: d.requestId,
  job_status: 'FAILED',
  webhook_received: 'TRUE',
  error_message: String(d.failureReason || '').slice(0, 1000),
  completed_at: d.timestamp,
}, pairedItem: { item: 0 } }];
```
→ Sheets appendOrUpdate `Ssemble_Jobs` matching `ssemble_job_id` (node name `Update Job Failed`).

Node 7b — `Shape Moment Failed` (Code):
```javascript
const d = $('Attach Moment').first().json;
const id = d.clip_moment_id || 'NOOP-ORPHAN';
return [{ json: { clip_moment_id: id, ssemble_status: 'ERROR' }, pairedItem: { item: 0 } }];
```
→ Sheets appendOrUpdate `Clip_Moments` matching `clip_moment_id` (node name `Update Moment Failed`).

Connections:
```json
{ "Webhook": { "main": [[{ "node": "Verify And Parse", "type": "main", "index": 0 }]] },
  "Verify And Parse": { "main": [[{ "node": "Read Ssemble_Jobs", "type": "main", "index": 0 }]] },
  "Read Ssemble_Jobs": { "main": [[{ "node": "Attach Moment", "type": "main", "index": 0 }]] },
  "Attach Moment": { "main": [[{ "node": "Route On Completed", "type": "main", "index": 0 }]] },
  "Route On Completed": { "main": [
    [{ "node": "Shape Job Completed", "type": "main", "index": 0 }],
    [{ "node": "Shape Job Failed", "type": "main", "index": 0 }]
  ] },
  "Shape Job Completed": { "main": [[{ "node": "Update Job Completed", "type": "main", "index": 0 }]] },
  "Update Job Completed": { "main": [[{ "node": "Shape Moment Completed", "type": "main", "index": 0 }]] },
  "Shape Moment Completed": { "main": [[{ "node": "Update Moment Completed", "type": "main", "index": 0 }]] },
  "Update Moment Completed": { "main": [[{ "node": "Explode Shorts", "type": "main", "index": 0 }]] },
  "Explode Shorts": { "main": [[{ "node": "Append Created_Clips", "type": "main", "index": 0 }]] },
  "Shape Job Failed": { "main": [[{ "node": "Update Job Failed", "type": "main", "index": 0 }]] },
  "Update Job Failed": { "main": [[{ "node": "Shape Moment Failed", "type": "main", "index": 0 }]] },
  "Shape Moment Failed": { "main": [[{ "node": "Update Moment Failed", "type": "main", "index": 0 }]] } }
```
Orphan webhooks (curl tests) touch only the single reusable `NOOP-ORPHAN` row in `Clip_Moments` — delete it whenever; it never matches WF6's `PENDING` filter.

- [ ] **Step 2: Validate JSON**

```bash
python3 -m json.tool n8n/workflows/07-ssemble-webhook-receiver.json > /dev/null && echo OK
```

- [ ] **Step 3: Simulated webhook test** — import, replace `SSEMBLE_WEBHOOK_SECRET` (UI), ACTIVATE the workflow (webhooks need active state; in local n8n use the Test URL while listening):

```bash
curl -s -X POST "http://localhost:5678/webhook/ssemble-callback?secret=YOUR_SECRET" \
  -H 'Content-Type: application/json' -d '{
  "event": "shorts.completed", "requestId": "TEST-REQ-1", "status": "completed",
  "timestamp": "2026-06-11T12:00:00.000Z",
  "data": { "shorts": [ { "id": "abc123", "title": "Test Clip", "video_url": "https://storage.googleapis.com/test.mp4", "duration": 45, "viral_score": 8.5 } ] } }'
```
Expected: 200 response; `Created_Clips` gains a `CC-abc123` row with `AWAITING_DOWNLOAD`; `Ssemble_Jobs` update is a no-op (no TEST-REQ-1 row) — appendOrUpdate will APPEND an orphan row; delete it after the test. Repeat with `"event":"shorts.failed"` + `"data":{"failureReason":"test"}` → expect FAILED row. Wrong secret → workflow errors (visible in executions), no sheet writes.

- [ ] **Step 4: One real end-to-end credit test** — with WF7 active on the PROD n8n (public domain), re-enable WF6's `Call Ssemble Create`, set `DAILY_BUDGET = 1` temporarily, run WF6 manually with exactly one PENDING moment. Within ~5–30 min the webhook fires: `Ssemble_Jobs → COMPLETED`, `Created_Clips` rows appear. Restore `DAILY_BUDGET = 10`.

- [ ] **Step 5: Commit**

```bash
git add n8n/workflows/07-ssemble-webhook-receiver.json
git commit -m "feat(n8n): WF7 fast-ACK Ssemble webhook receiver with secret check"
```

---

## Task 14: WF8 — Drive Storage + Transformation Planner workflow

**Files:**
- Create: `n8n/workflows/08-drive-storage-transform.json`

Every 30 min (clip URLs on `storage.googleapis.com` may expire — undocumented; short polling keeps the window tight). Downloads clip → uploads to niche Drive folder → runs TRANSFORMATION_PLANNER prompt → marks `NEEDS_REVIEW`.

- [ ] **Step 1: Write the workflow file** — name `WF8 Drive Storage Transform`. Wiring:

```
Schedule 30m → Read Created_Clips → Read Ssemble_Jobs → Read Clip_Moments → Pick Awaiting Download
  → Clip Loop (SplitInBatches, 1)
      main[1] → Already Uploaded? (IF)
          false → Download Clip → Upload To Drive → Shape Drive Ids → Save Drive Ids → Build Planner Request
          true  → Build Planner Request                       [rerun after partial failure: reuse, no re-upload]
          → Call OpenAI Planner → Parse Plan → Update Created Clip → (loop)
```

Node 1 — `Schedule 30m` (scheduleTrigger 1.2): `{ "rule": { "interval": [ { "field": "minutes", "minutesInterval": 30 } ] } }`

Nodes 2–4 — Sheets reads: `Read Created_Clips`, `Read Ssemble_Jobs` (`alwaysOutputData: true`), `Read Clip_Moments` (`alwaysOutputData: true`).

Node 5 — `Pick Awaiting Download` (Code) — joins clip → job → moment, resolves niche folder:
```javascript
const FOLDERS = {
  CHRISTIAN_CONTENT: 'GOOGLE_DRIVE_FOLDER_CHRISTIAN_CONTENT',
  MOTIVATION_DISCIPLINE: 'GOOGLE_DRIVE_FOLDER_MOTIVATION_DISCIPLINE',
  FINANCE_BUSINESS: 'GOOGLE_DRIVE_FOLDER_FINANCE_BUSINESS',
  LIFE_VALUES_RELATIONSHIPS: 'GOOGLE_DRIVE_FOLDER_LIFE_VALUES_RELATIONSHIPS',
  AFRICAN_KENYAN_SUCCESS: 'GOOGLE_DRIVE_FOLDER_AFRICAN_KENYAN_SUCCESS',
};
const jobs = {};
for (const j of $('Read Ssemble_Jobs').all()) jobs[j.json.ssemble_job_id] = j.json;
const moments = {};
for (const m of $('Read Clip_Moments').all()) moments[m.json.clip_moment_id] = m.json;

const out = [];
for (const item of $('Read Created_Clips').all()) {
  const c = item.json;
  if (String(c.review_status) !== 'AWAITING_DOWNLOAD') continue;
  const job = jobs[c.ssemble_job_id] || {};
  const moment = moments[job.clip_moment_id] || {};
  const niche = c.niche || job.niche || 'AFRICAN_KENYAN_SUCCESS';
  out.push({ json: {
    ...c,
    niche,
    video_id: c.video_id || job.video_id || '',
    drive_folder_id: FOLDERS[niche],
    file_name: `${niche}_${c.created_clip_id}.mp4`,
    moment_core_idea: moment.core_idea || '',
    moment_commentary_angle: moment.commentary_angle || '',
    moment_kenyan_application: moment.kenyan_african_application || '',
    moment_bible_verse: moment.bible_verse_if_relevant || '',
    moment_hook: moment.hook_first_2_seconds || '',
    moment_suggested_title: moment.suggested_title || '',
  }, pairedItem: { item: 0 } });
}
return out.slice(0, 5);
```

Node 6 — `Clip Loop` (splitInBatches 3): `{ "batchSize": 1, "options": {} }`

Node 6b — `Already Uploaded?` (IF v2) — idempotency guard: if a previous run uploaded but died before the final sheet update, `google_drive_file_id` is already persisted (by `Save Drive Ids`) and the file must NOT be uploaded again:
```json
{ "conditions": {
    "options": { "caseSensitive": true, "typeValidation": "loose" },
    "conditions": [ { "leftValue": "={{ $json.google_drive_file_id }}", "rightValue": "", "operator": { "type": "string", "operation": "notEmpty", "singleValue": true } } ],
    "combinator": "and" } }
```
true → `Build Planner Request` directly; false → `Download Clip`.

Node 7 — `Download Clip` (HTTP Request 4.2) — binary response:
```json
{ "method": "GET", "url": "={{ $json.clip_url }}",
  "options": { "timeout": 300000, "response": { "response": { "responseFormat": "file", "outputPropertyName": "data" } } } }
```

Node 8 — `Upload To Drive` (`n8n-nodes-base.googleDrive`, typeVersion 3):
```json
{ "resource": "file", "operation": "upload",
  "name": "={{ $('Clip Loop').first().json.file_name }}",
  "driveId": { "__rl": true, "mode": "list", "value": "My Drive" },
  "folderId": { "__rl": true, "mode": "id", "value": "={{ $('Clip Loop').first().json.drive_folder_id }}" },
  "inputDataFieldName": "data",
  "options": {} }
```

Node 8b — `Shape Drive Ids` (Code) — persist Drive ids IMMEDIATELY after upload, before the planner can fail:
```javascript
const c = $('Clip Loop').first().json;
const drive = $input.first().json;
return [{ json: {
  created_clip_id: c.created_clip_id,
  local_file_name: c.file_name,
  google_drive_file_id: drive.id,
  google_drive_url: drive.webViewLink || `https://drive.google.com/file/d/${drive.id}/view`,
}, pairedItem: { item: 0 } }];
```
→ `Save Drive Ids` (Sheets appendOrUpdate, `Created_Clips`, matching `created_clip_id`).

Node 9 — `Build Planner Request` (Code) — full TRANSFORMATION_PLANNER_PROMPT. Reached from BOTH branches; resolves Drive info from the sheet row (reuse path) or the just-saved ids (fresh-upload path):
```javascript
const c = $('Clip Loop').first().json;
let drive;
if (c.google_drive_file_id) {
  drive = { id: c.google_drive_file_id, webViewLink: c.google_drive_url };
} else {
  const saved = $('Shape Drive Ids').first().json;
  drive = { id: saved.google_drive_file_id, webViewLink: saved.google_drive_url };
}

const TITLE_FORMULAS = {
  CHRISTIAN_CONTENT: ['God Is Not Asking You to Ignore This', 'This Is What Waiting on God Really Means', 'A Biblical Lesson Most People Miss', 'Before You Give Up, Remember This', 'Faith Without This Becomes Confusion'],
  MOTIVATION_DISCIPLINE: ["The Real Reason You Can't Stay Consistent", 'Motivation Is Not Your Problem', 'This Habit Will Expose Your Excuses', 'Stop Waiting to Feel Ready', 'Discipline Starts Here'],
  FINANCE_BUSINESS: ['Why High Income Still Feels Like Poverty', 'This Money Mistake Keeps People Broke', 'The Business Lesson Most Founders Learn Too Late', 'Income Is Not Wealth', 'This Advice Changes When You Live in Kenya'],
  LIFE_VALUES_RELATIONSHIPS: ["This Is Not Love, It's Fear", 'Healthy Boundaries Sound Like This', 'Stop Calling This Loyalty', 'This Communication Mistake Looks Like Love', 'A Healthy Relationship Should Not Feel Like War'],
  AFRICAN_KENYAN_SUCCESS: ['Every Young Kenyan Builder Should Hear This', 'This Advice Works Differently in Africa', 'The Reality of Building in Kenya', 'What African Founders Learn the Hard Way', 'This Is Practical Wisdom, Not Motivation'],
};

const SYSTEM_PROMPT = `You are an originality-first short-form video editor, scriptwriter, and monetization-safety reviewer.

Transform the selected clip into a video that clearly adds original value. The final output must not look like a reposted podcast clip. It must look like original commentary content that uses the clip as supporting material.

For the selected clip, create: 1. Content thesis 2. Best title 3. 5 alternative titles 4. Hook 5. Narration script 6. Commentary angle 7. Kenyan/African localization 8. Bible verse if relevant 9. On-screen text by timestamp 10. B-roll plan 11. Editing style 12. Caption 13. Hashtags 14. CTA 15. Copyright/reused-content risk warning 16. Final originality checklist

Title rules: prefer these niche formulas as style guides: ${JSON.stringify(TITLE_FORMULAS)}. Keep titles under 60 characters where possible, clear, emotional but not clickbait, specific to the topic, brand-safe, not misleading, not overly negative, no fake urgency.

Return JSON only, exactly this schema:
{
  "content_thesis": "", "best_title": "", "alternative_titles": [], "hook": "",
  "narration_script": "", "commentary_angle": "", "kenyan_african_localization": "",
  "bible_verse_if_relevant": { "reference": null, "reason": null },
  "on_screen_text_beats": [ { "time_range": "0-3s", "text": "" } ],
  "broll_plan": [], "editing_style": "", "caption": "", "hashtags": [], "cta": "",
  "risk_warning": "",
  "originality_checklist": { "has_original_narration": true, "has_context": true, "has_lesson_breakdown": true, "has_local_application": true, "has_visual_transformation": true, "does_not_depend_only_on_source_clip": true }
}`;

const userContent = [
  `Niche: ${c.niche}`,
  `Clip title (AI-generated by clipper): ${c.clip_title}`,
  `Clip duration: ${c.duration_seconds}s`,
  `Core idea: ${c.moment_core_idea}`,
  `Planned commentary angle: ${c.moment_commentary_angle}`,
  `Kenyan/African application: ${c.moment_kenyan_application}`,
  `Bible verse hint: ${c.moment_bible_verse || 'none'}`,
  `Original hook idea: ${c.moment_hook}`,
  `Suggested title from analysis: ${c.moment_suggested_title}`,
].join('\n');

return [{ json: {
  created_clip_id: c.created_clip_id,
  video_id: c.video_id,
  niche: c.niche,
  drive_file_id: drive.id,
  drive_url: drive.webViewLink || `https://drive.google.com/file/d/${drive.id}/view`,
  file_name: c.file_name,
  openai_body: JSON.stringify({
    model: 'gpt-4o-mini',
    response_format: { type: 'json_object' },
    temperature: 0.6,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userContent },
    ],
  }),
}, pairedItem: { item: 0 } }];
```

Node 10 — `Call OpenAI Planner` (HTTP Request per C4, credential `OpenAI API`).

Node 11 — `Parse Plan` (Code):
```javascript
const meta = $('Build Planner Request').first().json;
const resp = $input.first().json;
let plan = {};
try { plan = JSON.parse(resp.choices[0].message.content); } catch (e) { plan = { parse_error: String(e) }; }
return [{ json: {
  created_clip_id: meta.created_clip_id,
  video_id: meta.video_id,
  niche: meta.niche,
  local_file_name: meta.file_name,
  google_drive_file_id: meta.drive_file_id,
  google_drive_url: meta.drive_url,
  suggested_title: String(plan.best_title || ''),
  suggested_caption: String(plan.caption || '').slice(0, 500),
  transformation_plan: JSON.stringify(plan).slice(0, 40000),
  review_status: 'NEEDS_REVIEW',
}, pairedItem: { item: 0 } }];
```

Node 12 — `Update Created Clip` (Sheets appendOrUpdate, `Created_Clips`, matching `created_clip_id`).

Connections: linear chain `Schedule 30m → Read Created_Clips → Read Ssemble_Jobs → Read Clip_Moments → Pick Awaiting Download → Clip Loop`; `Clip Loop` main[1] → `Already Uploaded?`; IF true → `Build Planner Request`, IF false → `Download Clip → Upload To Drive → Shape Drive Ids → Save Drive Ids → Build Planner Request`; then `Build Planner Request → Call OpenAI Planner → Parse Plan → Update Created Clip → Clip Loop` (loop-back); main[0] empty.

Failure note: if `Download Clip` 403s (expired URL), the run errors → WF10 logs it. Manual recovery: `GET https://aiclipping.ssemble.com/api/v1/shorts/<ssemble_job_id>` (X-API-Key header) returns fresh URLs; paste the new `clip_url` into the sheet and rerun. Automate only if it actually happens (YAGNI).

- [ ] **Step 2: Validate JSON**

```bash
python3 -m json.tool n8n/workflows/08-drive-storage-transform.json > /dev/null && echo OK
```

- [ ] **Step 3: Import + run** — attach Drive + Sheets + OpenAI credentials; replace the 5 folder IDs in `Pick Awaiting Download` (UI). Seed one `AWAITING_DOWNLOAD` row pointing `clip_url` at any small public mp4 to test without Ssemble. Confirm: file lands in the right niche folder; `Created_Clips` row gets Drive URL + JSON plan + `NEEDS_REVIEW`.

- [ ] **Step 4: Commit**

```bash
git add n8n/workflows/08-drive-storage-transform.json
git commit -m "feat(n8n): WF8 Drive storage with transformation planner"
```

---

## Task 15: WF9 — Review Queue Digest workflow

**Files:**
- Create: `n8n/workflows/09-review-queue-digest.json`

Daily 08:00 Africa/Nairobi: email digest of clips awaiting review.

- [ ] **Step 1: Write the workflow file** — name `WF9 Review Queue Digest`, linear: `Schedule Daily → Read Created_Clips → Build Digest → Send Digest`.

Node 1 — `Schedule Daily` (scheduleTrigger 1.2):
```json
{ "rule": { "interval": [ { "field": "cronExpression", "expression": "0 8 * * *" } ] } }
```
Also set workbook timezone: in the workflow `settings` add `"timezone": "Africa/Nairobi"`.

Node 2 — `Read Created_Clips` (Sheets read).

Node 3 — `Build Digest` (Code):
```javascript
const pending = $input.all().map(i => i.json)
  .filter(c => String(c.review_status) === 'NEEDS_REVIEW');
if (pending.length === 0) return []; // no email on empty queue

const byNiche = {};
for (const c of pending) (byNiche[c.niche || 'UNKNOWN'] = byNiche[c.niche || 'UNKNOWN'] || []).push(c);

let html = `<h2>Clips awaiting review: ${pending.length}</h2>`;
for (const niche of Object.keys(byNiche).sort()) {
  html += `<h3>${niche} (${byNiche[niche].length})</h3><ul>`;
  for (const c of byNiche[niche]) {
    html += `<li><a href="${c.google_drive_url}">${c.suggested_title || c.clip_title || c.created_clip_id}</a>` +
            ` — ${c.duration_seconds}s — ${c.reviewer_notes || ''}</li>`;
  }
  html += '</ul>';
}
html += '<p>Approve: set review_status=APPROVED in Created_Clips, then copy to Approved_For_Posting.</p>';
return [{ json: { subject: `Shorts review queue: ${pending.length} clips`, html }, pairedItem: { item: 0 } }];
```

Node 4 — `Send Digest` (`n8n-nodes-base.gmail`, typeVersion 2.1):
```json
{ "resource": "message", "operation": "send",
  "sendTo": "njihialeon00@gmail.com",
  "subject": "={{ $json.subject }}",
  "message": "={{ $json.html }}",
  "options": {} }
```

Connections: linear chain.

- [ ] **Step 2: Validate + import + run** — `python3 -m json.tool ... && echo OK`; attach Gmail credential; run manually with ≥1 `NEEDS_REVIEW` row → email arrives with working Drive links; with zero rows → no email sent.

- [ ] **Step 3: Commit**

```bash
git add n8n/workflows/09-review-queue-digest.json
git commit -m "feat(n8n): WF9 daily review queue digest email"
```

---

## Task 16: Documentation

**Files:**
- Create: `docs/credentials-setup.md`
- Create: `docs/architecture.md`

- [ ] **Step 1: Write `docs/credentials-setup.md`** — content: the C6 placeholder table verbatim, plus per-credential creation walkthroughs: Google Cloud project → enable Sheets API, Drive API, YouTube Data API v3, Gmail API → OAuth consent (external, test users: njihialeon00@gmail.com) → OAuth client (redirect `https://YOUR_N8N_DOMAIN/rest/oauth2-credential/callback` and `http://localhost:5678/rest/oauth2-credential/callback`) → API key for YouTube (restrict to YouTube Data API). OpenAI: platform.openai.com key → n8n Header Auth. Ssemble: dashboard profile settings → API key → n8n Header Auth named `Ssemble API`, header `X-API-Key`. Webshare: Residential package → username/password → Lambda env vars. Lambda: env vars `TRANSCRIPT_API_KEY`, `WEBSHARE_PROXY_USERNAME`, `WEBSHARE_PROXY_PASSWORD` (or `YTA_PROXY_URL`), optional `WEBSHARE_IP_LOCATIONS`. Per-workflow table: which credential attaches to which nodes.

- [ ] **Step 2: Write `docs/architecture.md`** — content: the workflow chain diagram (Architecture section of this plan), the state machine from `docs/google-sheets-structure.md`, credit-economics summary (verified facts section), operational knobs table: `DAILY_BUDGET` (WF6 Plan Requests, default 10), per-run caps (WF4: 10, WF5: 5, WF8: 5), score threshold 7 (WF5 Parse And Gate), schedule cadences, and the automation boundary: automated = discovery→validation→transcripts→analysis→clipping→storage→planning; human = FLAGGED approvals, AWAITING_MANUAL_APPROVAL moments, all review_status transitions past NEEDS_REVIEW, Approved_For_Posting curation. Posting workflows (YouTube/TikTok/IG/FB) explicitly out of scope — future plan.

- [ ] **Step 3: Commit**

```bash
git add docs/credentials-setup.md docs/architecture.md
git commit -m "docs: credentials setup and pipeline architecture"
```

---

## Task 17: Final validation sweep

- [ ] **Step 1: JSON validity, all workflows**

```bash
for f in n8n/workflows/*.json; do python3 -m json.tool "$f" > /dev/null && echo "OK $f" || echo "FAIL $f"; done
```
Expected: 10 × `OK`.

- [ ] **Step 2: Placeholder audit**

```bash
grep -rn "GOOGLE_SHEETS_DOCUMENT_ID\|YOUTUBE_API_KEY\|TRANSCRIPT_SERVICE_URL\|SSEMBLE_WEBHOOK_SECRET\|YOUR_N8N_DOMAIN\|GOOGLE_DRIVE_FOLDER_" n8n/workflows/ | wc -l
```
Expected: nonzero (placeholders ARE committed; real values live only in the n8n instance + Lambda env). Confirm no real secrets leaked: `grep -rn "sk-\|AIza" n8n/workflows/ docs/` → empty.

- [ ] **Step 3: Lambda tests still green**

```bash
.venv/bin/python -m pytest tests/test_handler.py -q
```

- [ ] **Step 4: Full pipeline rehearsal (prod)** — import all 10 into prod n8n, set Error Workflow = WF10 on WF1–WF9, attach credentials, replace placeholders per C6, activate WF7 + schedules. Watch one video flow: WF2 discovers → WF3 validates → WF4 transcript → WF5 analysis + moments → WF6 dispatch (1 credit) → WF7 webhook → WF8 Drive + plan → WF9 digest next morning.

- [ ] **Step 5: Commit anything outstanding + final commit**

```bash
git add -A docs/ n8n/workflows/ && git commit -m "chore: pipeline validation sweep"
```

---

## Spec Coverage Self-Review (done at planning time)

- 10 requested workflows → delivered as 10 files (Transformation Planner merged into WF8 — operationally one unit; Clip Review Queue = WF9 digest + manual sheet workflow; combination allowed by spec).
- 8 Sheets tabs → `docs/google-sheets-structure.md` (pre-existing, authoritative).
- Duplicate detection → WF2 `Init Run` dedup set on `youtube_video_id`, in-run dedup included.
- Validity rules → WF2 (music/live via API metadata) + WF3 (duration, title patterns, language, shorts, risk flag). "Too dependent on visuals / no clear lesson" rules are NOT deterministically checkable → handled by WF5 AI scoring (by design).
- Credit-saving rules → WF5 gates (score < 7 skip, ≥3 strong clips for window, top-3 cap) + WF6 budget/padding/`noClipping` + high-risk `AWAITING_MANUAL_APPROVAL`.
- Both AI prompts embedded verbatim-with-schema in WF5/WF8 Code nodes; title formulas in WF8.
- Placeholders centralized (C6); manual-edit points called out per task step.
- Webhook security: secret query param (Ssemble sends no signatures — verified).
- Proxy: Webshare primary (`WebshareProxyConfig`), generic fallback (`YTA_PROXY_URL`), per user requirement.
- Re-run safety: WF2 dedup set; WF4/WF5/WF7 use appendOrUpdate on deterministic keys (`analysis_id`, `clip_moment_id`, `created_clip_id`); WF6 guards against re-dispatch via existing `Ssemble_Jobs` rows; WF8 reuses already-uploaded Drive files (`Already Uploaded?` + `Save Drive Ids`).
- Failure persistence: Ssemble submit failures land in `Ssemble_Jobs` as `SUBMIT_FAILED` (excluded from credit budget + dispatch guard); processing failures arrive via webhook as `FAILED`; WF7 closes `Clip_Moments` to `COMPLETED`/`ERROR`.
- Known accepted gaps: `Pexels/ElevenLabs/Creatomate` optional integrations deferred to posting-phase plan; legacy `/c/`+`/user/` channel URLs unsupported in WF1 (paste @handle URLs); `lamba-function/` directory-name typo blessed (see File Structure).





