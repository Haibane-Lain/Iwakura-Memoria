"""Import API: bring a bundle of foreign files into a project.

The client gathers ``(relative_path, bytes)`` pairs — from a file picker, a
folder picker (``webkitRelativePath``) or a single zip — and posts them as
multipart. ``paths`` carries the relative paths in the same order as ``files``;
multipart alone would lose a folder pick's directory structure.

The size cap is enforced while reading, so an oversized body is refused before
it is held in memory, exactly like the image and attachment uploads.
"""
from __future__ import annotations

import json

from fastapi import APIRouter, File, Form, HTTPException, UploadFile

from app import config
from app.services import import_docs as import_service

router = APIRouter(prefix="/api/projects", tags=["imports"])


def _mode() -> str:
    return config.load_settings().get("wordCountMode", "auto")


def _limit_label() -> str:
    return f"{import_service.MAX_BUNDLE_BYTES // (1024 * 1024)} MB"


def _read_upload(upload: UploadFile, budget: int) -> bytes:
    """Read one part in chunks, refusing anything past *budget* total bytes."""
    chunks: list[bytes] = []
    total = 0
    while True:
        chunk = upload.file.read(1024 * 1024)
        if not chunk:
            break
        total += len(chunk)
        if total > budget:
            raise HTTPException(status_code=413, detail=f"The import exceeds the {_limit_label()} limit")
        chunks.append(chunk)
    return b"".join(chunks)


def _paths(raw: str, count: int) -> list[str]:
    """The ``paths`` form field as a list of length *count* (blank when absent)."""
    try:
        parsed = json.loads(raw) if raw else []
    except json.JSONDecodeError:
        parsed = []
    if not isinstance(parsed, list):
        parsed = []
    out = [str(p) for p in parsed[:count]]
    out.extend([""] * (count - len(out)))
    return out


@router.post("/{project_id}/import", status_code=201)
def import_bundle(
    project_id: str,
    files: list[UploadFile] = File(...),
    paths: str = Form("[]"),
    folder: str = Form(""),
    source: str = Form("auto"),
    name: str = Form(""),
    import_as: str = Form("chapter", alias="as"),
):
    if not files:
        raise HTTPException(status_code=400, detail="No files were uploaded")

    rel_paths = _paths(paths, len(files))
    bundle: list[tuple[str, bytes]] = []
    remaining = import_service.MAX_BUNDLE_BYTES
    for index, upload in enumerate(files):
        raw = _read_upload(upload, remaining)
        remaining -= len(raw)
        label = rel_paths[index] or upload.filename or f"file-{index}"
        bundle.append((label, raw))

    try:
        return import_service.import_bundle(
            project_id,
            folder or None,
            bundle,
            {"source": source or "auto", "as": import_as, "name": name or None},
            _mode(),
        )
    except import_service.ImportLimitError as exc:
        raise HTTPException(status_code=413, detail=str(exc)) from exc
    except (import_service.ImportDocsError, ValueError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except OSError as exc:
        raise HTTPException(status_code=503, detail=f"File busy or locked: {exc}") from exc
