"""FastAPI application factory."""
from __future__ import annotations

import sys
import time

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from starlette.requests import Request
from starlette.responses import JSONResponse

from app import config
from app.routes import ai as ai_routes
from app.routes import assets as assets_routes
from app.routes import backups as backup_routes
from app.routes import documents as documents_routes
from app.routes import grammar as grammar_routes
from app.routes import projects as projects_routes
from app.routes import settings as settings_routes
from app.routes import templates as templates_routes
from app.routes import wiki as wiki_routes
from app.security import check_local_request
from app.services import documents as documents_service

MAX_REQUEST_BYTES = 27 * 1024 * 1024
_MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024  # must match app.ai.attachments.MAX_FILE_BYTES
_SLOW_REQUEST_THRESHOLD_S = 1.0


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

    @app.middleware("http")
    async def _limit_body_size(request: Request, call_next):
        # The global ceiling sits just above the 25 MB attachment limit so a
        # full-size upload is expressible; the route-level check (413) enforces
        # the exact attachment cap. JSON requests are far smaller than this.
        content_length = request.headers.get("content-length")
        if content_length:
            try:
                too_big = int(content_length) > MAX_REQUEST_BYTES
            except ValueError:
                too_big = False
            if too_big:
                return JSONResponse(
                    {"detail": f"Request body exceeds maximum size ({_MAX_ATTACHMENT_BYTES // (1024*1024)} MB)"},
                    status_code=413,
                )
        return await call_next(request)

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
    app.include_router(backup_routes.router)

    config.STATIC_DIR.mkdir(parents=True, exist_ok=True)
    app.mount("/", StaticFiles(directory=str(config.STATIC_DIR), html=True), name="static")
    return app
