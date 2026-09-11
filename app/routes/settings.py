"""Settings API.

Responses never contain real AI API keys: every ``ai.<name>.apiKey`` is
replaced with the :data:`app.security.MASK` sentinel, and that sentinel is
the only value the frontend may send back for an unchanged key.
"""
from __future__ import annotations

from fastapi import APIRouter
from pydantic import BaseModel

from app.security import mask_settings
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
    wikiZoom: int | None = None
    grammarEnabled: bool | None = None
    ai: dict | None = None


@router.get("")
def get_settings():
    return mask_settings(settings_service.get_settings())


@router.put("")
def put_settings(patch: SettingsPatch):
    updated = settings_service.update_settings(patch.model_dump(exclude_none=True))
    return mask_settings(updated)
