"""Body-size guard tests: the global ceiling must not cap attachments early.

The app allows 25 MB attachments (app.ai.attachments.MAX_FILE_BYTES). The
global request-body guard must sit *above* that so a full-size upload is
expressible and the route's own 25 MB check stays authoritative.
"""
from __future__ import annotations

from fastapi.testclient import TestClient

from app.ai import attachments
from app.main import MAX_REQUEST_BYTES, create_app


def test_global_cap_sits_above_attachment_cap():
    # The middleware limit must not be a stricter barrier than the route-level
    # attachment check, or the documented 25 MB cap is unreachable.
    assert MAX_REQUEST_BYTES > attachments.MAX_FILE_BYTES


def test_body_limit_rejects_oversized_request(tmp_path, monkeypatch):
    monkeypatch.setenv("IWAKURA_DATA_DIR", str(tmp_path / "data"))
    client = TestClient(create_app())
    _H = {"host": "127.0.0.1"}

    # Inflate Content-Length past the global ceiling; the middleware 413s
    # before any route runs. (The project doesn't need to exist.)
    r = client.post(
        "/api/projects/nope/ai/sessions",
        content=b"",
        headers={**_H, "content-length": str(MAX_REQUEST_BYTES + 1)},
    )
    assert r.status_code == 413
    assert "25 MB" in r.json()["detail"]


def test_attachment_sized_request_passes_global_guard(tmp_path, monkeypatch):
    monkeypatch.setenv("IWAKURA_DATA_DIR", str(tmp_path / "data"))
    client = TestClient(create_app())
    _H = {"host": "127.0.0.1"}

    # A 25 MB upload body is under the global ceiling, so it is not rejected
    # by the middleware as a request (the project id is invalid, but that only
    # matters once the body guard has let it through — status != 413 proves it).
    r = client.post(
        "/api/projects/../nope/ai/sessions",
        content=b"x",
        headers={**_H, "content-length": str(attachments.MAX_FILE_BYTES)},
    )
    assert r.status_code != 413
