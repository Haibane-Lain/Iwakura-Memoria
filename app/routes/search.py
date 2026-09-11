"""Full-text project search API."""
from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from app.services import search as search_service

router = APIRouter(prefix="/api/projects", tags=["search"])


class SearchSelection(BaseModel):
    folders: list[str] = Field(default_factory=list)
    documents: list[str] = Field(default_factory=list)


class SearchOptions(BaseModel):
    caseSensitive: bool = False
    wholeWord: bool = False


class SearchRequest(BaseModel):
    query: str = ""
    scope: str = "all"  # "all" | "write" | "wiki" | "document"
    selection: SearchSelection | None = None
    options: SearchOptions = Field(default_factory=SearchOptions)


@router.post("/{project_id}/search")
def project_search(project_id: str, payload: SearchRequest):
    selection = payload.selection
    try:
        return search_service.search(
            project_id,
            payload.query,
            scope=payload.scope,
            folders=None if selection is None else selection.folders,
            documents=None if selection is None else selection.documents,
            case_sensitive=payload.options.caseSensitive,
            whole_word=payload.options.wholeWord,
        )
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
