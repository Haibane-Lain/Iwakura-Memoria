"""Worlds / series / books API, plus cover image serving."""
from __future__ import annotations

from fastapi import APIRouter, File, HTTPException, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel

from app.services import covers as covers_service
from app.services import worlds as worlds_service
from app.services.assets import MAX_IMAGE_BYTES, AssetError

router = APIRouter(prefix="/api/worlds", tags=["worlds"])
covers_router = APIRouter(prefix="/api/covers", tags=["covers"])


def _read_upload(file: UploadFile) -> bytes:
    """Read a picture in chunks, refusing an oversized body without holding it."""
    raw = b""
    while True:
        chunk = file.file.read(1024 * 1024)
        if not chunk:
            break
        raw += chunk
        if len(raw) > MAX_IMAGE_BYTES:
            raise HTTPException(
                status_code=413,
                detail=f"Image exceeds the {MAX_IMAGE_BYTES // (1024 * 1024)} MB limit",
            )
    return raw


class WorldCreate(BaseModel):
    title: str


class WorldPatch(BaseModel):
    title: str | None = None


class SeriesCreate(BaseModel):
    title: str


class SeriesPatch(BaseModel):
    title: str | None = None


class BookCreate(BaseModel):
    title: str
    seriesId: str | None = None


class BookMove(BaseModel):
    seriesId: str | None = None


class ReorderPatch(BaseModel):
    orderedIds: list[str]


class BookReorderPatch(BaseModel):
    orderedIds: list[str]
    seriesId: str | None = None


def _http_error(exc: Exception) -> HTTPException:
    if isinstance(exc, FileNotFoundError):
        return HTTPException(status_code=404, detail=str(exc))
    return HTTPException(status_code=400, detail=str(exc))


# --- worlds -----------------------------------------------------------------


@router.get("")
def list_worlds():
    return worlds_service.list_worlds()


@router.post("", status_code=201)
def create_world(payload: WorldCreate):
    try:
        return worlds_service.create_world(payload.title)
    except (FileNotFoundError, ValueError) as exc:
        raise _http_error(exc) from exc


# Registered before ``/{world_id}`` so the literal path never reads as an id.
@router.put("/reorder")
def reorder_worlds(payload: ReorderPatch):
    return worlds_service.reorder_worlds(payload.orderedIds)


@router.get("/{world_id}")
def get_world(world_id: str):
    try:
        return worlds_service.get_world(world_id)
    except (FileNotFoundError, ValueError) as exc:
        raise _http_error(exc) from exc


@router.patch("/{world_id}")
def patch_world(world_id: str, payload: WorldPatch):
    try:
        if payload.title is not None:
            return worlds_service.rename_world(world_id, payload.title)
        return worlds_service.get_world(world_id)
    except (FileNotFoundError, ValueError) as exc:
        raise _http_error(exc) from exc


@router.delete("/{world_id}")
def delete_world(world_id: str):
    try:
        return worlds_service.delete_world(world_id)
    except (FileNotFoundError, ValueError) as exc:
        raise _http_error(exc) from exc


@router.post("/{world_id}/cover")
def upload_world_cover(world_id: str, file: UploadFile = File(...)):
    raw = _read_upload(file)
    try:
        return worlds_service.set_world_cover(world_id, raw)
    except AssetError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except (FileNotFoundError, ValueError) as exc:
        raise _http_error(exc) from exc


@router.delete("/{world_id}/cover")
def delete_world_cover(world_id: str):
    try:
        return worlds_service.clear_world_cover(world_id)
    except (FileNotFoundError, ValueError) as exc:
        raise _http_error(exc) from exc


# --- series -----------------------------------------------------------------


@router.post("/{world_id}/series", status_code=201)
def create_series(world_id: str, payload: SeriesCreate):
    try:
        return worlds_service.create_series(world_id, payload.title)
    except (FileNotFoundError, ValueError) as exc:
        raise _http_error(exc) from exc


@router.patch("/{world_id}/series/{series_id}")
def patch_series(world_id: str, series_id: str, payload: SeriesPatch):
    try:
        if payload.title is not None:
            return worlds_service.rename_series(world_id, series_id, payload.title)
        return worlds_service.get_world(world_id)
    except (FileNotFoundError, ValueError) as exc:
        raise _http_error(exc) from exc


@router.delete("/{world_id}/series/{series_id}")
def delete_series(world_id: str, series_id: str):
    try:
        return worlds_service.delete_series(world_id, series_id)
    except (FileNotFoundError, ValueError) as exc:
        raise _http_error(exc) from exc


# --- books ------------------------------------------------------------------


@router.post("/{world_id}/books", status_code=201)
def add_book(world_id: str, payload: BookCreate):
    try:
        return worlds_service.add_book(world_id, payload.title, payload.seriesId)
    except (FileNotFoundError, ValueError) as exc:
        raise _http_error(exc) from exc


# Before ``/books/{project_id}`` so the literal segment wins.
@router.put("/{world_id}/books/reorder")
def reorder_books(world_id: str, payload: BookReorderPatch):
    try:
        return worlds_service.reorder_books(world_id, payload.orderedIds, payload.seriesId)
    except (FileNotFoundError, ValueError) as exc:
        raise _http_error(exc) from exc


@router.put("/{world_id}/books/{project_id}")
def move_book(world_id: str, project_id: str, payload: BookMove):
    try:
        return worlds_service.move_book(project_id, world_id, payload.seriesId)
    except (FileNotFoundError, ValueError) as exc:
        raise _http_error(exc) from exc


@router.put("/{world_id}/series/reorder")
def reorder_series(world_id: str, payload: ReorderPatch):
    try:
        return worlds_service.reorder_series(world_id, payload.orderedIds)
    except (FileNotFoundError, ValueError) as exc:
        raise _http_error(exc) from exc


# --- covers -----------------------------------------------------------------


@covers_router.get("/{name}")
def get_cover(name: str):
    try:
        path = covers_service.path(name)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except OSError as exc:
        raise HTTPException(status_code=503, detail=f"File busy or locked: {exc}") from exc
    return FileResponse(
        path, media_type=covers_service.media_type(name) or "application/octet-stream"
    )
