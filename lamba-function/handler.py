import base64
import json
import os
import re

from youtube_transcript_api import YouTubeTranscriptApi
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
from youtube_transcript_api.proxies import GenericProxyConfig, WebshareProxyConfig


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
        return _response(
            401,
            {
                "success": False,
                "error_code": "UNAUTHORIZED",
                "error_message": "missing or invalid x-api-key",
            },
        )

    raw_body = event.get("body") or "{}"
    if event.get("isBase64Encoded"):
        raw_body = base64.b64decode(raw_body).decode("utf-8")

    try:
        payload = json.loads(raw_body)
    except json.JSONDecodeError:
        return _response(
            400,
            {
                "success": False,
                "error_code": "BAD_REQUEST",
                "error_message": "body is not valid JSON",
            },
        )

    video_id = extract_video_id(payload.get("youtube_url", ""))
    if not video_id:
        return _response(
            400,
            {
                "success": False,
                "error_code": "INVALID_VIDEO_ID",
                "error_message": "could not extract video id from youtube_url",
            },
        )

    languages = payload.get("language_preferences") or ["en", "en-US", "en-GB", "sw"]

    try:
        fetched = _fetch_transcript(video_id, languages)
    except Exception as exc:
        for exc_types, code in _ERROR_CODES:
            if isinstance(exc, exc_types):
                return _response(
                    200,
                    {
                        "success": False,
                        "video_id": video_id,
                        "error_code": code,
                        "error_message": str(exc)[:500],
                    },
                )
        if isinstance(exc, CouldNotRetrieveTranscript):
            return _response(
                200,
                {
                    "success": False,
                    "video_id": video_id,
                    "error_code": "FETCH_FAILED",
                    "error_message": str(exc)[:500],
                },
            )
        return _response(
            200,
            {
                "success": False,
                "video_id": video_id,
                "error_code": "FETCH_FAILED",
                "error_message": f"{type(exc).__name__}: {str(exc)[:400]}",
            },
        )

    transcript = fetched.to_raw_data()
    plain_text = " ".join(s["text"].strip() for s in transcript if s.get("text"))
    return _response(
        200,
        {
            "success": True,
            "video_id": video_id,
            "language_code": fetched.language_code,
            "is_generated": fetched.is_generated,
            "transcript": transcript,
            "plain_text": plain_text,
        },
    )
