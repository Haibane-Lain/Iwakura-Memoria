"""Comments API: list, create, edit, resolve, and delete review notes.

Routes hang off a dedicated ``/api/projects/{project_id}/comments`` prefix, the
same way snapshots do: the documents router's greedy ``:path`` converter would
otherwise swallow the extra segments.
"""
from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app import config
from app.services import comments as comments_service
from app.services import documents as documents_service

router = APIRouter(prefix="/api/projects", tags=["comments"])


def _mode() -> str:
    return config.load_settings().get("wordCountMode", "auto")


class CommentCreate(BaseModel):
    docId: str
    body: str
    quote: str = ""
    author: str = "you"


class CommentUpdate(BaseModel):
    docId: str
    body: str | None = None
    resolved: bool | None = None


def _http_error(exc: Exception) -> HTTPException:
    # FileNotFoundError is an OSError, so the 404 check has to come first.
    if isinstance(exc, FileNotFoundError):
        return HTTPException(status_code=404, detail=str(exc))
    if isinstance(exc, OSError):
        return HTTPException(status_code=503, detail=f"File busy or locked: {exc}")
    return HTTPException(status_code=400, detail=str(exc))


@router.get("/{project_id}/comments")
def list_comments(project_id: str, docId: str):
    try:
        return comments_service.list_doc(project_id, docId)
    except (FileNotFoundError, ValueError) as exc:
        raise _http_error(exc) from exc


@router.post("/{project_id}/comments", status_code=201)
def create_comment(project_id: str, payload: CommentCreate):
    try:
        # Refuse a comment on a document that does not exist, so a bad id can't
        # leave an orphaned sidecar behind.
        documents_service.get_document(project_id, payload.docId, _mode())
        return comments_service.create(
            project_id,
            payload.docId,
            payload.body,
            quote=payload.quote,
            author=payload.author,
        )
    except (FileNotFoundError, ValueError) as exc:
        raise _http_error(exc) from exc


@router.put("/{project_id}/comments/{comment_id}")
def update_comment(project_id: str, comment_id: str, payload: CommentUpdate):
    try:
        return comments_service.update(
            project_id,
            payload.docId,
            comment_id,
            body=payload.body,
            resolved=payload.resolved,
        )
    except (FileNotFoundError, ValueError) as exc:
        raise _http_error(exc) from exc


@router.delete("/{project_id}/comments/{comment_id}")
def delete_comment(project_id: str, comment_id: str, docId: str):
    try:
        if not comments_service.delete(project_id, docId, comment_id):
            raise FileNotFoundError("Comment not found")
    except (FileNotFoundError, ValueError) as exc:
        raise _http_error(exc) from exc
    return {"ok": True}


@router.delete("/{project_id}/comments")
def clear_comments(project_id: str, docId: str, resolvedOnly: bool = False):
    try:
        removed = comments_service.clear_doc(project_id, docId, resolved_only=resolvedOnly)
    except (FileNotFoundError, ValueError) as exc:
        raise _http_error(exc) from exc
    return {"ok": True, "removed": removed}
