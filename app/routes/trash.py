"""Trash API: list deleted entries, restore them, or purge them for good."""
from __future__ import annotations

from fastapi import APIRouter, HTTPException

from app.services import documents as documents_service
from app.services import trash as trash_service

router = APIRouter(prefix="/api/projects", tags=["trash"])


def _http_error(exc: Exception) -> HTTPException:
    status = 404 if isinstance(exc, FileNotFoundError) else 400
    return HTTPException(status_code=status, detail=str(exc))


@router.get("/{project_id}/trash")
def list_trash(project_id: str):
    try:
        return trash_service.list_trash(project_id)
    except (FileNotFoundError, ValueError) as exc:
        raise _http_error(exc) from exc


@router.post("/{project_id}/trash/{trash_id}/restore")
def restore_trash(project_id: str, trash_id: str):
    try:
        result = trash_service.restore(project_id, trash_id)
        documents_service._invalidate_word_stats(project_id)
    except (FileNotFoundError, ValueError) as exc:
        raise _http_error(exc) from exc
    return result


@router.delete("/{project_id}/trash/{trash_id}")
def purge_trash(project_id: str, trash_id: str):
    try:
        if not trash_service.purge(project_id, trash_id):
            raise FileNotFoundError("Trash entry not found")
    except (FileNotFoundError, ValueError) as exc:
        raise _http_error(exc) from exc
    return {"ok": True}


@router.delete("/{project_id}/trash")
def empty_trash(project_id: str):
    try:
        removed = trash_service.empty(project_id)
    except (FileNotFoundError, ValueError) as exc:
        raise _http_error(exc) from exc
    return {"ok": True, "removed": removed}
