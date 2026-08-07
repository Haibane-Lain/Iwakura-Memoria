"""FastAPI application factory."""
from __future__ import annotations

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from app import config
from app.routes import ai as ai_routes
from app.routes import documents as documents_routes
from app.routes import projects as projects_routes
from app.routes import settings as settings_routes
from app.routes import templates as templates_routes
from app.routes import wiki as wiki_routes


def create_app() -> FastAPI:
    config.ensure_dirs()
    app = FastAPI(title="Lain's Writing Tools", docs_url="/api/docs", openapi_url="/api/openapi.json")

    app.include_router(settings_routes.router)
    app.include_router(projects_routes.router)
    app.include_router(documents_routes.router)
    app.include_router(wiki_routes.wiki_router)
    app.include_router(wiki_routes.stats_router)
    app.include_router(templates_routes.router)
    app.include_router(ai_routes.router)

    config.STATIC_DIR.mkdir(parents=True, exist_ok=True)
    app.mount("/", StaticFiles(directory=str(config.STATIC_DIR), html=True), name="static")
    return app
