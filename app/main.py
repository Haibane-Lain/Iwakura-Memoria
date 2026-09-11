"""FastAPI application factory."""
from __future__ import annotations

import json
import sys
import time

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from app import config
from app.routes import ai as ai_routes
from app.routes import assets as assets_routes
from app.routes import backups as backup_routes
from app.routes import documents as documents_routes
from app.routes import grammar as grammar_routes
from app.routes import projects as projects_routes
from app.routes import repetition as repetition_routes
from app.routes import settings as settings_routes
from app.routes import templates as templates_routes
from app.routes import trash as trash_routes
from app.routes import wiki as wiki_routes
from app.security import check_local_request
from app.services import documents as documents_service

MAX_REQUEST_BYTES = 27 * 1024 * 1024
_MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024  # must match app.ai.attachments.MAX_FILE_BYTES
_SLOW_REQUEST_THRESHOLD_S = 1.0
_BODY_TOO_LARGE_DETAIL = (
    f"Request body exceeds maximum size ({_MAX_ATTACHMENT_BYTES // (1024 * 1024)} MB)"
)


def _content_length(scope: Scope) -> int | None:
    """The declared ``Content-Length`` as an int, or None when absent/invalid."""
    for name, value in scope.get("headers", []):
        if name == b"content-length":
            try:
                return int(value)
            except ValueError:
                return None
    return None


async def _send_too_large(send: Send, detail: str) -> None:
    body = json.dumps({"detail": detail}).encode("utf-8")
    await send(
        {
            "type": "http.response.start",
            "status": 413,
            "headers": [
                (b"content-type", b"application/json"),
                (b"content-length", str(len(body)).encode("ascii")),
                (b"cache-control", b"no-cache"),
            ],
        }
    )
    await send({"type": "http.response.body", "body": body})


class BodySizeLimitMiddleware:
    """Reject request bodies over ``max_bytes``, chunked uploads included.

    The ``Content-Length`` header is checked first (cheap, and catches honest
    clients). A chunked request has no length to check, so the ASGI ``receive``
    callable is also wrapped and the running byte total is enforced as the body
    streams — before a route can buffer the whole thing into memory. This is a
    pure ASGI middleware on purpose: ``BaseHTTPMiddleware`` hands the downstream
    app a different receive callable, so a wrapped ``request._receive`` there
    would never be consulted.

    When the cap is crossed mid-read the middleware writes the 413 itself and
    hands the app a disconnect, swallowing whatever response it then tries to
    send. Raising an exception instead does not work: the app is inside
    FastAPI's body parser (which relabels any non-``HTTPException`` error as a
    generic 400) and inside anyio task groups that wrap it in an
    ``ExceptionGroup``, so the original status is lost.
    """

    def __init__(self, app: ASGIApp, max_bytes: int, detail: str) -> None:
        self.app = app
        self.max_bytes = max_bytes
        self.detail = detail

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        declared = _content_length(scope)
        if declared is not None and declared > self.max_bytes:
            await _send_too_large(send, self.detail)
            return

        received = 0
        rejected = False

        async def limited_receive() -> Message:
            nonlocal received, rejected
            if rejected:
                return {"type": "http.disconnect"}
            message = await receive()
            if message["type"] == "http.request":
                received += len(message.get("body", b"") or b"")
                if received > self.max_bytes:
                    rejected = True
                    await _send_too_large(send, self.detail)
                    return {"type": "http.disconnect"}
            return message

        async def guarded_send(message: Message) -> None:
            # After our 413 has gone out, drop the error response the app
            # produces in reaction to the disconnect.
            if rejected:
                return
            await send(message)

        await self.app(scope, limited_receive, guarded_send)


def create_app() -> FastAPI:
    config.ensure_dirs()
    # Rewrite any overgrown history.jsonl into its compact per-day form,
    # restore entries stranded in stale .reorder-tmp folders after a crash, and
    # rebase stored zoom values onto the new 100% reading baseline (once).
    # Runs for every launch (pywebview, browser, --server-only/Electron).
    try:
        documents_service.compact_overgrown_histories()
        documents_service.recover_reorder_tmp()
        documents_service.rebase_zoom_scale()
    except Exception as exc:  # never block startup on housekeeping
        print(f"[startup] housekeeping skipped: {exc}", file=sys.stderr)
    app = FastAPI(title="Iwakura Memoria", docs_url="/api/docs", openapi_url="/api/openapi.json")

    # Every response must revalidate. With no Cache-Control at all, Chromium's
    # *heuristic* caching may serve an old copy of a changed JS/CSS file (or
    # API payload) from a previous session without ever revalidating — the
    # classic "still no button after an update" stale-UI bug. no-cache forces a
    # revalidation round-trip, which is a cheap 304 while the file is unchanged
    # (ETag/Last-Modified come from StaticFiles) and fresh bytes the moment it is.
    @app.middleware("http")
    async def _no_cache(request: Request, call_next):
        response = await call_next(request)
        response.headers["Cache-Control"] = "no-cache"
        return response

    # Outermost middleware: every request crosses the localhost guard first.
    @app.middleware("http")
    async def _local_request_guard(request: Request, call_next):
        reason = check_local_request(
            request.headers.get("host", ""),
            request.method,
            request.headers.get("origin") or None,
        )
        if reason:
            return JSONResponse(
                {"detail": f"Rejected: {reason}"},
                status_code=403,
            )
        return await call_next(request)

    # The global ceiling sits just above the 25 MB attachment limit so a
    # full-size upload is expressible; the route-level check (413) enforces
    # the exact attachment cap. JSON requests are far smaller than this.
    app.add_middleware(
        BodySizeLimitMiddleware,
        max_bytes=MAX_REQUEST_BYTES,
        detail=_BODY_TOO_LARGE_DETAIL,
    )

    @app.middleware("http")
    async def _request_timer(request: Request, call_next):
        t0 = time.perf_counter()
        response = await call_next(request)
        elapsed = time.perf_counter() - t0
        if elapsed > _SLOW_REQUEST_THRESHOLD_S:
            print(
                f"[timing] SLOW ({elapsed:.1f}s) {request.method} {request.url.path}",
                file=sys.stderr,
            )
        return response

    app.include_router(settings_routes.router)
    app.include_router(projects_routes.router)
    app.include_router(assets_routes.router)
    app.include_router(documents_routes.router)
    app.include_router(wiki_routes.wiki_router)
    app.include_router(wiki_routes.stats_router)
    app.include_router(templates_routes.router)
    app.include_router(ai_routes.router)
    app.include_router(grammar_routes.router)
    app.include_router(repetition_routes.router)
    app.include_router(trash_routes.router)
    app.include_router(backup_routes.router)

    config.STATIC_DIR.mkdir(parents=True, exist_ok=True)
    app.mount("/", StaticFiles(directory=str(config.STATIC_DIR), html=True), name="static")
    return app
