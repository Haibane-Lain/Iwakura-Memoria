"""Document snapshots API: list, create, preview, restore, and delete versions.

Routes hang off a dedicated ``/api/projects/{project_id}/snapshots`` prefix
rather than under ``/documents/{doc_id:path}``: the documents router's greedy
``:path`` converter would otherwise swallow the extra segments.
"""
from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app import config
from app.services import documents as documents_service
from app.services import snapshots as snapshots_service

router = APIRouter(prefix="/api/projects", tags=["snapshots"])


def _mode() -> str:
    return config.load_settings().get("wordCountMode", "auto")


class SnapshotCreate(BaseModel):
    docId: str


class SnapshotRestore(BaseModel):
    docId: str


def _http_error(exc: Exception) -> HTTPException:
    # FileNotFoundError is an OSError, so the 404 check has to come first.
    if isinstance(exc, FileNotFoundError):
        return HTTPException(status_code=404, detail=str(exc))
    if isinstance(exc, OSError):
        return HTTPException(status_code=503, detail=f"File busy or locked: {exc}")
    return HTTPException(status_code=400, detail=str(exc))


@router.get("/{project_id}/snapshots")
def list_snapshots(project_id: str, docId: str):
    try:
        return snapshots_service.list_snapshots(project_id, docId)
    except (FileNotFoundError, ValueError) as exc:
        raise _http_error(exc) from exc


@router.post("/{project_id}/snapshots", status_code=201)
def create_snapshot(project_id: str, payload: SnapshotCreate):
    try:
        raw = documents_service.read_document_raw(project_id, payload.docId)
        meta, body = documents_service.parse_frontmatter(raw)
        created = snapshots_service.capture(
            project_id,
            payload.docId,
            raw,
            reason=snapshots_service.REASON_MANUAL,
            title=str(meta.get("title") or ""),
            kind=documents_service._doc_kind(raw),
            words=documents_service.count_words(body, _mode()),
            manual=True,
        )
    except (FileNotFoundError, ValueError) as exc:
        raise _http_error(exc) from exc
    # ``None`` means the document is unchanged since the newest snapshot.
    return {"ok": True, "created": created is not None}


@router.get("/{project_id}/snapshots/{snapshot_id}")
def get_snapshot(project_id: str, snapshot_id: str, docId: str):
    try:
        snap = snapshots_service.read_snapshot(project_id, docId, snapshot_id)
        _, body = documents_service.parse_frontmatter(snap["content"])
    except (FileNotFoundError, ValueError) as exc:
        raise _http_error(exc) from exc
    # The preview shows the prose; frontmatter is metadata, not text.
    return {"meta": snap["meta"], "body": body}


@router.post("/{project_id}/snapshots/{snapshot_id}/restore")
def restore_snapshot(project_id: str, snapshot_id: str, payload: SnapshotRestore):
    doc_id = payload.docId
    try:
        snap = snapshots_service.read_snapshot(project_id, doc_id, snapshot_id)
        # Restore the body only: the document keeps its current title, tags,
        # and per-document styling. save_document captures the pre-restore file
        # under the save lock, so a restore can itself be undone.
        _, restored_body = documents_service.parse_frontmatter(snap["content"])
        saved = documents_service.save_document(
            project_id,
            doc_id,
            restored_body,
            _mode(),
            snapshot=False,
            before_reason=snapshots_service.REASON_BEFORE_RESTORE,
        )
    except (FileNotFoundError, ValueError, OSError) as exc:
        raise _http_error(exc) from exc
    return {"ok": True, "doc": saved}


@router.delete("/{project_id}/snapshots/{snapshot_id}")
def delete_snapshot(project_id: str, snapshot_id: str, docId: str):
    try:
        if not snapshots_service.delete_snapshot(project_id, docId, snapshot_id):
            raise FileNotFoundError("Snapshot not found")
    except (FileNotFoundError, ValueError) as exc:
        raise _http_error(exc) from exc
    return {"ok": True}


@router.delete("/{project_id}/snapshots")
def clear_snapshots(project_id: str, docId: str):
    try:
        removed = snapshots_service.clear_doc(project_id, docId)
    except (FileNotFoundError, ValueError) as exc:
        raise _http_error(exc) from exc
    return {"ok": True, "removed": removed}
