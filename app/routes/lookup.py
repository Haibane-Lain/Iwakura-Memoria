"""Lookup API: definitions and synonyms for a word.

Global, not project-scoped: a wordlist belongs to the language, not to one
project, so this mirrors ``/api/grammar`` rather than the project routers.
"""
from __future__ import annotations

from fastapi import APIRouter, HTTPException

from app.services import lookup as lookup_service

router = APIRouter(prefix="/api/lookup", tags=["lookup"])


@router.get("/status")
def lookup_status():
    return {"available": lookup_service.is_available()}


@router.get("")
def lookup_word(word: str = ""):
    try:
        return lookup_service.lookup(word)
    except lookup_service.DictionaryUnavailable as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
