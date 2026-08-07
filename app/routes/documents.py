"""Documents and folders API."""
from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app import config
from app.services import documents as documents_service

router = APIRouter(prefix="/api/projects", tags=["documents"])


def _mode() -> str:
    return config.load_settings().get("wordCountMode", "auto")


class DocumentCreate(BaseModel):
    title: str
    kind: str = "note"  # "chapter" | "note"
    folder: str | None = None
    content: str | None = None
    docType: str | None = None


class DocumentContent(BaseModel):
    content: str


class StylePayload(BaseModel):
    target: str = "document"  # "document" | "section"
    section: str | None = None
    font: str | None = None
    size: int | None = None
    align: str | None = None
    zoom: int | None = None
    clear: bool = False


class DocumentPatch(BaseModel):
    title: str | None = None


class DocumentMove(BaseModel):
    docId: str
    folder: str | None = None
    index: int | None = None


class ReorderPayload(BaseModel):
    orderedIds: list[str]
    folder: str | None = None


class FolderCreate(BaseModel):
    name: str
    parent: str | None = None


class FolderPatch(BaseModel):
    name: str


class FolderMove(BaseModel):
    folderId: str
    targetFolder: str | None = None
    index: int | None = None


def _http_error(exc: Exception) -> HTTPException:
    status = 404 if isinstance(exc, FileNotFoundError) else 400
    return HTTPException(status_code=status, detail=str(exc))


@router.post("/{project_id}/documents", status_code=201)
def create_document(project_id: str, payload: DocumentCreate):
    try:
        return documents_service.create_document(
            project_id,
            payload.title,
            payload.kind,
            payload.folder,
            _mode(),
            content=payload.content,
            doc_type=payload.docType,
        )
    except (FileNotFoundError, ValueError) as exc:
        raise _http_error(exc) from exc


@router.post("/{project_id}/folders", status_code=201)
def create_folder(project_id: str, payload: FolderCreate):
    try:
        folder_id = documents_service.create_folder(project_id, payload.name, payload.parent)
    except (FileNotFoundError, ValueError) as exc:
        raise _http_error(exc) from exc
    return {"id": folder_id}


@router.patch("/{project_id}/folders/{folder:path}")
def rename_folder(project_id: str, folder: str, payload: FolderPatch):
    try:
        folder_id = documents_service.rename_folder(project_id, folder, payload.name)
    except (FileNotFoundError, ValueError) as exc:
        raise _http_error(exc) from exc
    return {"id": folder_id}


@router.put("/{project_id}/folders/move")
def move_folder(project_id: str, payload: FolderMove):
    try:
        folder_id, renamed = documents_service._move_folder_impl(
            project_id, payload.folderId, payload.targetFolder, payload.index
        )
    except (FileNotFoundError, ValueError) as exc:
        raise _http_error(exc) from exc
    return {"id": folder_id, "renamed": renamed}


@router.delete("/{project_id}/folders/{folder:path}")
def delete_folder(project_id: str, folder: str):
    try:
        documents_service.delete_folder(project_id, folder)
    except (FileNotFoundError, ValueError) as exc:
        raise _http_error(exc) from exc
    return {"ok": True}


@router.put("/{project_id}/documents/move")
def move_document(project_id: str, payload: DocumentMove):
    try:
        doc, renamed = documents_service._move_document_impl(
            project_id, payload.docId, payload.folder, payload.index, _mode()
        )
    except (FileNotFoundError, ValueError) as exc:
        raise _http_error(exc) from exc
    return {"doc": doc, "renamed": renamed}


@router.put("/{project_id}/documents/reorder")
def reorder_documents(project_id: str, payload: ReorderPayload):
    try:
        return documents_service.reorder_documents(
            project_id, payload.orderedIds, payload.folder, _mode()
        )
    except (FileNotFoundError, ValueError) as exc:
        raise _http_error(exc) from exc


@router.get("/{project_id}/documents/{doc_id:path}")
def get_document(project_id: str, doc_id: str):
    try:
        return documents_service.get_document(project_id, doc_id, _mode())
    except (FileNotFoundError, ValueError) as exc:
        raise _http_error(exc) from exc


@router.put("/{project_id}/documents/{doc_id:path}/style")
def update_document_style(project_id: str, doc_id: str, payload: StylePayload):
    try:
        return documents_service.update_style(
            project_id,
            doc_id,
            payload.target,
            section=payload.section,
            font=payload.font,
            size=payload.size,
            align=payload.align,
            zoom=payload.zoom,
            clear=payload.clear,
            mode=_mode(),
        )
    except (FileNotFoundError, ValueError) as exc:
        raise _http_error(exc) from exc


@router.put("/{project_id}/documents/{doc_id:path}")
def save_document(project_id: str, doc_id: str, payload: DocumentContent):
    try:
        return documents_service.save_document(
            project_id, doc_id, payload.content, _mode()
        )
    except (FileNotFoundError, ValueError) as exc:
        raise _http_error(exc) from exc


@router.patch("/{project_id}/documents/{doc_id:path}")
def patch_document(project_id: str, doc_id: str, payload: DocumentPatch):
    try:
        if payload.title is not None:
            return documents_service.rename_document(
                project_id, doc_id, payload.title, _mode()
            )
        return documents_service.get_document(project_id, doc_id, _mode())
    except (FileNotFoundError, ValueError) as exc:
        raise _http_error(exc) from exc


@router.delete("/{project_id}/documents/{doc_id:path}")
def delete_document(project_id: str, doc_id: str):
    try:
        documents_service.delete_document(project_id, doc_id)
    except (FileNotFoundError, ValueError) as exc:
        raise _http_error(exc) from exc
    return {"ok": True}
