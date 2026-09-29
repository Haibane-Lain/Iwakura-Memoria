"""Grammar check API."""
from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.services import grammar as grammar_service

router = APIRouter(prefix="/api/grammar", tags=["grammar"])


class CheckRequest(BaseModel):
    text: str
    language: str = "en-US"
    dictionaryWords: list[str] | None = None
    # Forwarded to LanguageTool's /v2/check. "picky" turns on the style rules.
    level: str | None = None
    motherTongue: str | None = None
    preferredVariants: str | None = None
    enabledCategories: list[str] | None = None
    disabledCategories: list[str] | None = None
    enabledRules: list[str] | None = None
    disabledRules: list[str] | None = None


@router.get("/status")
def grammar_status():
    return {"available": grammar_service.is_available()}


@router.post("/check")
def grammar_check(body: CheckRequest):
    matches = grammar_service.check(
        body.text,
        body.language,
        body.dictionaryWords,
        level=body.level,
        mother_tongue=body.motherTongue,
        preferred_variants=body.preferredVariants,
        enabled_categories=body.enabledCategories,
        disabled_categories=body.disabledCategories,
        enabled_rules=body.enabledRules,
        disabled_rules=body.disabledRules,
    )
    if matches is None:
        raise HTTPException(status_code=503, detail="Grammar server not available")
    return {"matches": matches}
