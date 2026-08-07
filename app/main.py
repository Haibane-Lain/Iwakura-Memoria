"""FastAPI application factory."""
from __future__ import annotations

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from starlette.requests import Request
from starlette.responses import JSONResponse

from app import config
from app.routes import ai as ai_routes
from app.routes import documents as documents_routes
from app.routes import grammar as grammar_routes
from app.routes import projects as projects_routes
from app.routes import settings as settings_routes
from app.routes import templates as templates_routes
from app.routes import wiki as wiki_routes

MAX_REQUEST_BYTES = 10 * 1024 * 1024


def create_app() -> FastAPI:
    config.ensure_dirs()
    app = FastAPI(title="Lain's Writing Tools", docs_url="/api/docs", openapi_url="/api/openapi.json")

    @app.middleware("http")
    async def _limit_body_size(request: Request, call_next):
        content_length = request.headers.get("content-length")
        if content_length and int(content_length) > MAX_REQUEST_BYTES:
            return JSONResponse(
                {"detail": f"Request body exceeds maximum size ({MAX_REQUEST_BYTES // (1024*1024)} MB)"},
                status_code=413,
            )
        return await call_next(request)

    app.include_router(settings_routes.router)
    app.include_router(projects_routes.router)
    app.include_router(documents_routes.router)
    app.include_router(wiki_routes.wiki_router)
    app.include_router(wiki_routes.stats_router)
    app.include_router(templates_routes.router)
    app.include_router(ai_routes.router)
    app.include_router(grammar_routes.router)

    config.STATIC_DIR.mkdir(parents=True, exist_ok=True)
    app.mount("/", StaticFiles(directory=str(config.STATIC_DIR), html=True), name="static")
    return app
