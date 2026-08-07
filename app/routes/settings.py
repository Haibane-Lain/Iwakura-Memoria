"""Settings API."""
from __future__ import annotations

from fastapi import APIRouter
from pydantic import BaseModel

from app.services import settings as settings_service

router = APIRouter(prefix="/api/settings", tags=["settings"])


class SettingsPatch(BaseModel):
    theme: str | None = None
    wordCountMode: str | None = None
    autosaveMs: int | None = None
    editorFont: str | None = None
    editorSize: int | None = None
    editorAlign: str | None = None
    editorZoom: int | None = None
    ai: dict | None = None


@router.get("")
def get_settings():
    return settings_service.get_settings()


@router.put("")
def put_settings(patch: SettingsPatch):
    return settings_service.update_settings(patch.model_dump(exclude_none=True))
