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


@router.get("/status")
def grammar_status():
    return {"available": grammar_service.is_available()}


@router.post("/check")
def grammar_check(body: CheckRequest):
    matches = grammar_service.check(body.text, body.language, body.dictionaryWords)
    if matches is None:
        raise HTTPException(status_code=503, detail="Grammar server not available")
    return {"matches": matches}
