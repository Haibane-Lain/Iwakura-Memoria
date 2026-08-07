"""Project management: one folder per project on disk."""
from __future__ import annotations

import json
import re
import shutil
import unicodedata
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from app import config
from app.services import documents as documents_service


def _slugify(name: str) -> str:
    """Return a filesystem-safe slug from a display name."""
    normalized = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode("ascii")
    normalized = re.sub(r"[^A-Za-z0-9]+", "-", normalized).strip("-").lower()
    return normalized or "project"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def project_dir(project_id: str) -> Path:
    return config.DATA_DIR / project_id


def _safe_id(project_id: str) -> str:
    if not re.fullmatch(r"[A-Za-z0-9._-]+", project_id):
        raise ValueError("Invalid project id")
    return project_id


def _read_meta(path: Path) -> dict[str, Any]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        data = {}
    return {
        "title": data.get("title", path.parent.name),
        "goal": data.get("goal", {"wordsPerDay": 500, "enabled": False}),
        "createdAt": data.get("createdAt", ""),
        "updatedAt": data.get("updatedAt", ""),
        **data,
    }


def _write_meta(project: Path, meta: dict[str, Any]) -> None:
    (project / config.PROJECT_META_FILENAME).write_text(
        json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8"
    )


def list_projects() -> list[dict[str, Any]]:
    results: list[dict[str, Any]] = []
    if not config.DATA_DIR.exists():
        return results
    for folder in sorted(config.DATA_DIR.iterdir(), key=lambda p: p.name.lower()):
        meta_path = folder / config.PROJECT_META_FILENAME
        if not folder.is_dir() or not meta_path.exists():
            continue
        meta = _read_meta(meta_path)
        stats = documents_service.project_word_stats(folder.name)
        results.append(
            {
                "id": folder.name,
                "title": meta["title"],
                "goal": meta["goal"],
                "createdAt": meta["createdAt"],
                "updatedAt": meta["updatedAt"],
                "words": stats["words"],
                "documents": stats["documents"],
            }
        )
    return results


def get_project(project_id: str) -> dict[str, Any]:
    pid = _safe_id(project_id)
    folder = project_dir(pid)
    meta_path = folder / config.PROJECT_META_FILENAME
    if not meta_path.exists():
        raise FileNotFoundError(f"Project '{project_id}' not found")
    meta = _read_meta(meta_path)
    stats = documents_service.project_word_stats(pid)
    return {
        "id": pid,
        "title": meta["title"],
        "goal": meta["goal"],
        "createdAt": meta["createdAt"],
        "updatedAt": meta["updatedAt"],
        "words": stats["words"],
        "documents": stats["documents"],
    }


def create_project(name: str) -> dict[str, Any]:
    slug = _slugify(name)
    folder = project_dir(slug)
    if folder.exists():
        raise ValueError(f"Project '{name}' already exists")
    folder.mkdir(parents=True, exist_ok=True)
    (folder / config.STATS_DIRNAME).mkdir(exist_ok=True)
    (folder / config.WIKI_DIRNAME).mkdir(exist_ok=True)
    now = _now()
    meta = {
        "title": name.strip() or slug,
        "goal": {"wordsPerDay": 500, "enabled": False},
        "createdAt": now,
        "updatedAt": now,
    }
    _write_meta(folder, meta)
    return get_project(slug)


def rename_project(project_id: str, new_name: str) -> dict[str, Any]:
    pid = _safe_id(project_id)
    folder = project_dir(pid)
    if not folder.exists():
        raise FileNotFoundError(f"Project '{project_id}' not found")
    new_slug = _slugify(new_name)
    new_folder = project_dir(new_slug)
    if new_folder.exists() and new_folder != folder:
        raise ValueError(f"Project '{new_name}' already exists")
    meta = _read_meta(folder / config.PROJECT_META_FILENAME)
    meta["title"] = new_name.strip() or meta["title"]
    meta["updatedAt"] = _now()
    if new_folder != folder:
        folder.rename(new_folder)
        folder = new_folder
    _write_meta(folder, meta)
    return get_project(new_folder.name)


def set_goal(project_id: str, words_per_day: int, enabled: bool) -> dict[str, Any]:
    pid = _safe_id(project_id)
    folder = project_dir(pid)
    meta_path = folder / config.PROJECT_META_FILENAME
    if not meta_path.exists():
        raise FileNotFoundError(f"Project '{project_id}' not found")
    meta = _read_meta(meta_path)
    meta["goal"] = {
        "wordsPerDay": max(1, int(words_per_day)),
        "enabled": bool(enabled),
    }
    meta["updatedAt"] = _now()
    _write_meta(folder, meta)
    return get_project(pid)


def delete_project(project_id: str) -> None:
    pid = _safe_id(project_id)
    folder = project_dir(pid)
    if not folder.exists():
        raise FileNotFoundError(f"Project '{project_id}' not found")
    shutil.rmtree(folder)


def get_document_tree(project_id: str, scope: str = "write") -> dict[str, Any]:
    return documents_service.get_tree(project_id, scope=scope)


def export_zip(project_id: str) -> bytes:
    """Return the project folder (Markdown files + metadata) as a zip archive.

    The hidden ``NN-`` order prefixes are stripped from file/folder names in
    the archive; if two entries would collide after stripping, the later one
    gets a ``-2``/``-3``… suffix so nothing is overwritten.
    """
    import io
    import zipfile

    pid = _safe_id(project_id)
    folder = project_dir(pid)
    if not folder.exists():
        raise FileNotFoundError(f"Project '{project_id}' not found")

    buffer = io.BytesIO()
    used: set[str] = set()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as zf:
        for path in sorted(folder.rglob("*")):
            if not path.is_file() or ".reorder-tmp" in path.parts:
                continue
            parts = path.relative_to(folder).as_posix().split("/")
            arcname = "/".join(documents_service._display_name(p) for p in parts)
            if arcname in used:
                dot = arcname.rfind(".")
                base, ext = (arcname[:dot], arcname[dot:]) if dot > 0 else (arcname, "")
                n = 2
                while f"{base}-{n}{ext}" in used:
                    n += 1
                arcname = f"{base}-{n}{ext}"
            used.add(arcname)
            zf.write(path, arcname=arcname)
    buffer.seek(0)
    return buffer.getvalue()
