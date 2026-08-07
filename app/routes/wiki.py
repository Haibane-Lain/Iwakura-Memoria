"""Wiki and stats APIs."""
from __future__ import annotations

from fastapi import APIRouter, HTTPException

from app import config
from app.services import stats as stats_service
from app.services import wiki as wiki_service

wiki_router = APIRouter(prefix="/api/projects", tags=["wiki"])
stats_router = APIRouter(prefix="/api/projects", tags=["stats"])


def _mode() -> str:
    return config.load_settings().get("wordCountMode", "auto")


@wiki_router.get("/{project_id}/wiki")
def get_wiki(project_id: str):
    try:
        return wiki_service.get_wiki(project_id)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc))


@stats_router.get("/{project_id}/stats")
def get_stats(project_id: str):
    try:
        return stats_service.get_stats(project_id, _mode())
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
