import json
import sys
from pathlib import Path

import pytest

# handler.py lives in lamba-function/ next to the vendored deps
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "lamba-function"))

import handler  # noqa: E402
from youtube_transcript_api._errors import (  # noqa: E402
    IpBlocked,
    TranscriptsDisabled,
    VideoUnavailable,
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


def make_exception(exc_class, video_id="Pzfle5WWaTo"):
    try:
        return exc_class(video_id)
    except TypeError:
        return exc_class.__new__(exc_class)


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
        (make_exception(TranscriptsDisabled), "TRANSCRIPTS_DISABLED"),
        (make_exception(VideoUnavailable), "VIDEO_UNAVAILABLE"),
        (make_exception(IpBlocked), "IP_BLOCKED"),
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
