"""Body-size guard tests: the global ceiling must not cap attachments early.

The app allows 25 MB attachments (app.ai.attachments.MAX_FILE_BYTES). The
global request-body guard must sit *above* that so a full-size upload is
expressible and the route's own 25 MB check stays authoritative.
"""
from __future__ import annotations

import asyncio

from fastapi.testclient import TestClient

from app.ai import attachments
from app.main import MAX_REQUEST_BYTES, BodySizeLimitMiddleware, create_app


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


def _chunked_app(tmp_path, monkeypatch, max_bytes: int):
    """A TestClient whose global body ceiling is small, for chunked tests."""
    import app.main as main

    monkeypatch.setattr(main, "MAX_REQUEST_BYTES", max_bytes)
    monkeypatch.setenv("IWAKURA_DATA_DIR", str(tmp_path / "data"))
    return TestClient(create_app())


def test_chunked_body_over_the_cap_is_rejected(tmp_path, monkeypatch):
    """A chunked request sends no Content-Length, so the streaming guard — not
    the header fast path — must stop it. ``/documents`` takes a JSON body, so
    FastAPI reads it before the route runs."""
    client = _chunked_app(tmp_path, monkeypatch, max_bytes=1024)
    _H = {"host": "127.0.0.1"}

    def chunks():
        for _ in range(4):
            yield b"x" * 512  # 2 KB total, over the 1 KB cap

    r = client.post("/api/projects/nope/documents", content=chunks(), headers=_H)
    assert r.status_code == 413
    assert "25 MB" in r.json()["detail"]


def test_chunked_body_under_the_cap_reaches_the_route(tmp_path, monkeypatch):
    client = _chunked_app(tmp_path, monkeypatch, max_bytes=1024)
    _H = {"host": "127.0.0.1"}

    def chunks():
        yield b'{"title":'
        yield b'"small"}'

    r = client.post("/api/projects/nope/documents", content=chunks(), headers=_H)
    # Not 413 — the guard let it through; the missing project is a later error.
    assert r.status_code != 413


def test_middleware_counts_streamed_bytes_with_no_content_length():
    """Pure-ASGI unit check: a body arriving in chunks (as a chunked request
    does, with no Content-Length) is cut off as soon as the running total
    crosses the cap. The middleware writes the 413 itself and the app only
    sees a disconnect, so nothing downstream can relabel it."""

    async def app(scope, receive, send):
        while True:
            message = await receive()
            if message["type"] == "http.disconnect":
                return
            if not message.get("more_body", False):
                break
        await send({"type": "http.response.start", "status": 200, "headers": []})
        await send({"type": "http.response.body", "body": b"ok"})

    middleware = BodySizeLimitMiddleware(app, max_bytes=10, detail="too big")
    scope = {"type": "http", "method": "POST", "path": "/", "headers": []}
    chunks = [b"123456", b"789012", b"345"]  # 15 bytes across three chunks
    events = []

    async def receive():
        if chunks:
            body = chunks.pop(0)
            return {"type": "http.request", "body": body, "more_body": bool(chunks)}
        return {"type": "http.disconnect"}

    async def send(message):
        events.append(message)

    asyncio.run(middleware(scope, receive, send))

    assert events and events[0]["type"] == "http.response.start"
    assert events[0]["status"] == 413
