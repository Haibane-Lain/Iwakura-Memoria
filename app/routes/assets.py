"""Image assets API: upload a picture, and serve it back for inline display.

Documents reference assets as ``assets/<name>``; the editor resolves that to
``/api/projects/<id>/assets/<name>`` for the browser. Only stored image names
are reachable — anything else is a 404.
"""
from __future__ import annotations

from fastapi import APIRouter, File, HTTPException, UploadFile
from fastapi.responses import FileResponse

from app.services import assets as assets_service

router = APIRouter(prefix="/api/projects", tags=["assets"])


def _limit_label() -> str:
    return f"{assets_service.MAX_IMAGE_BYTES // (1024 * 1024)} MB"


@router.post("/{project_id}/assets", status_code=201)
def upload_asset(project_id: str, file: UploadFile = File(...)):
    # Read in chunks and stop at the cap, so an oversized body is refused
    # without ever being held in memory in full (mirrors the AI attachments).
    raw = b""
    while True:
        chunk = file.file.read(1024 * 1024)
        if not chunk:
            break
        raw += chunk
        if len(raw) > assets_service.MAX_IMAGE_BYTES:
            raise HTTPException(status_code=413, detail=f"Image exceeds the {_limit_label()} limit")
    try:
        return assets_service.save_image(project_id, file.filename or "", raw)
    except assets_service.AssetError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.get("/{project_id}/assets/{name}")
def get_asset(project_id: str, name: str):
    try:
        path = assets_service.image_path(project_id, name)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except OSError as exc:
        raise HTTPException(status_code=503, detail=f"File busy or locked: {exc}") from exc
    return FileResponse(path, media_type=assets_service.media_type(name) or "application/octet-stream")
