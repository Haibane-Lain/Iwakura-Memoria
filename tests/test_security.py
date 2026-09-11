"""Tests for the localhost request guard and AI-key masking.

Run from the workspace root:

    .venv\\Scripts\\python.exe -m pytest tests/ -q
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app import config
from app.main import create_app
from app.security import MASK, check_local_request, mask_settings


@pytest.fixture
def client(tmp_path, monkeypatch):
    """A TestClient whose data dir is a throwaway folder, so exercising the
    app never touches real user data."""
    monkeypatch.setenv("IWAKURA_DATA_DIR", str(tmp_path / "data"))
    return TestClient(create_app())


def test_static_responses_never_heuristic_cached(client):
    """Static assets must carry Cache-Control so Chromium can't serve a stale
    copy of a changed JS/CSS file from its heuristic cache (the 'no button
    after an update' bug)."""
    for path in ("/", "/js/api.js", "/css/app.css", "/dist/editor.bundle.js"):
        r = client.get(path, headers={"host": "127.0.0.1"})
        assert r.status_code < 400, path
        assert r.headers.get("cache-control") == "no-cache", path


def _api(method: str, path: str, host: str = "127.0.0.1", origin: str | None = None, **kwargs):
    headers = {"host": host}
    if origin is not None:
        headers["origin"] = origin
    kwargs.setdefault("headers", {})
    kwargs["headers"] = {**headers, **kwargs["headers"]}
    return method, path, kwargs


# --- check_local_request (pure function) -----------------------------------


def test_host_loopback_variants_allowed():
    for host in ("127.0.0.1", "127.0.0.1:8000", "localhost", "LOCALHOST:9001", "[::1]:8000", "localhost."):
        assert check_local_request(host, "GET", None) is None, host


def test_host_rejects_non_loopback():
    for host in ("evil.com", "127.0.0.1.evil.com", "127.0.0.1:8000.evil.com", "10.0.0.5:8000", "example.org:8000"):
        assert check_local_request(host, "GET", None) is not None, host


def test_origin_checked_only_for_state_changing_methods():
    assert check_local_request("127.0.0.1", "GET", "http://evil.com") is None
    assert check_local_request("127.0.0.1", "POST", "http://evil.com") is not None
    assert check_local_request("127.0.0.1", "PUT", "http://evil.com") is not None
    assert check_local_request("127.0.0.1", "DELETE", "http://evil.com") is not None


def test_origin_loopback_variants_allowed():
    for origin in ("http://127.0.0.1", "http://127.0.0.1:8000", "http://localhost:9999", "http://[::1]:8000"):
        assert check_local_request("127.0.0.1", "POST", origin) is None, origin


def test_origin_rejects_non_http_or_foreign_host():
    for origin in ("https://127.0.0.1", "http://evil.com", "null", "", "http://127.0.0.1.evil.com"):
        assert check_local_request("127.0.0.1", "POST", origin) is not None, origin


def test_missing_origin_allowed_for_state_changing():
    assert check_local_request("127.0.0.1", "DELETE", None) is None


def test_escape_hatch_disables_checks(monkeypatch):
    monkeypatch.setenv("IWAKURA_INSECURE_LOCALHOST", "1")
    assert check_local_request("evil.com", "POST", "http://evil.com") is None


# --- guard middleware over HTTP ---------------------------------------------


def test_foreign_host_rejected_even_for_reads(client):
    method, path, kwargs = _api("GET", "/api/projects", host="evil.com")
    assert client.request(method, path, **kwargs).status_code == 403


def test_foreign_origin_rejected_for_state_changes(client):
    method, path, kwargs = _api("POST", "/api/projects", origin="http://evil.com", json={"name": "x"})
    assert client.request(method, path, **kwargs).status_code == 403


def test_same_origin_state_change_reaches_routing(client):
    # 404 (project missing) proves the guard let a loopback-origin DELETE through.
    method, path, kwargs = _api("DELETE", "/api/projects/does-not-exist", origin="http://127.0.0.1:8000")
    assert client.request(method, path, **kwargs).status_code == 404


def test_missing_origin_state_change_allowed(client):
    method, path, kwargs = _api("PUT", "/api/settings", json={"theme": "paper"})
    assert client.request(method, path, **kwargs).status_code == 200


def test_foreign_origin_read_allowed(client):
    method, path, kwargs = _api("GET", "/api/projects", origin="http://evil.com")
    assert client.request(method, path, **kwargs).status_code == 200


def test_escape_hatch_allows_foreign_host(client, monkeypatch):
    monkeypatch.setenv("IWAKURA_INSECURE_LOCALHOST", "1")
    client2 = TestClient(create_app())
    method, path, kwargs = _api("GET", "/api/projects", host="evil.com")
    assert client2.request(method, path, **kwargs).status_code == 200


# --- API key masking --------------------------------------------------------


def _put_ai(client, ai: dict):
    method, path, kwargs = _api("PUT", "/api/settings", json={"ai": ai})
    return client.request(method, path, **kwargs)


def test_get_settings_masks_keys(client):
    r = _put_ai(client, {"opencode_go": {"apiKey": "sk-secret", "model": "muse-1"}})
    assert r.status_code == 200
    assert r.json()["ai"]["opencode_go"]["apiKey"] == MASK  # PUT response masked too
    assert "sk-secret" not in r.text

    g = client.get("/api/settings", headers={"host": "127.0.0.1"})
    assert g.status_code == 200
    body = g.json()
    assert body["ai"]["opencode_go"]["apiKey"] == MASK
    assert "sk-secret" not in g.text


def test_put_mask_preserves_stored_key(client):
    _put_ai(client, {"opencode_go": {"apiKey": "sk-secret", "model": "muse-1"}})
    _put_ai(client, {"opencode_go": {"apiKey": MASK, "model": "muse-2"}})
    real = config.load_settings()["ai"]["opencode_go"]
    assert real["apiKey"] == "sk-secret"  # preserved on disk
    assert real["model"] == "muse-2"  # other fields still applied


def test_put_omitted_key_preserves_stored_key(client):
    _put_ai(client, {"opencode_go": {"apiKey": "sk-secret"}})
    _put_ai(client, {"opencode_go": {"model": "muse-2"}})
    assert config.load_settings()["ai"]["opencode_go"]["apiKey"] == "sk-secret"


def test_put_empty_key_clears(client):
    _put_ai(client, {"opencode_go": {"apiKey": "sk-secret"}})
    _put_ai(client, {"opencode_go": {"apiKey": ""}})
    assert config.load_settings()["ai"]["opencode_go"].get("apiKey") == ""


def test_mask_settings_is_non_destructive_copy():
    original = {"theme": "paper", "ai": {"deepseek": {"apiKey": "sk-1", "model": "m"}}}
    masked = mask_settings(original)
    assert masked["ai"]["deepseek"]["apiKey"] == MASK
    assert original["ai"]["deepseek"]["apiKey"] == "sk-1"  # input untouched
    assert masked["theme"] == "paper"
