"""Recycle bin for deleted documents and folders.

Deleting an entry moves it here instead of erasing it, so a mis-click (or a
bad Lain move) is recoverable. The bin lives at the *data root* --
``<data>/.trash/<project_id>/`` -- not inside the project, so it is invisible
to the document tree, word counts, exports, wikilink scans, and repetition
checks. Each deleted entry gets its own folder:

    .trash/<project>/<trash_id>/
        entry        # the moved file or folder, contents intact
        meta.json    # {id, name, kind, originalId, deletedAt, words}

``originalId`` is the entry's project-relative id at deletion time, so a
restore puts it back where it was (rewritten to a unique name if something
already occupies that spot). Restoring never touches wikilinks: a delete does
not rewrite them either, so any ``[[...]]`` links resolve again the moment the
entry returns.
"""
from __future__ import annotations

import json
import re
import shutil
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any

from app import config

_TRASH_ID_RE = re.compile(r"^[0-9a-f]{32}$")
_ENTRY_NAME = "entry"
_META_NAME = "meta.json"


def _trash_root() -> Path:
    return config.DATA_DIR / config.TRASH_DIRNAME


def _project_folder(project_id: str) -> Path:
    """Validate ``project_id`` and return its project folder."""
    if not config.is_safe_project_id(project_id):
        raise FileNotFoundError(f"Project '{project_id}' not found")
    folder = config.DATA_DIR / project_id
    if not (folder / config.PROJECT_META_FILENAME).exists():
        raise FileNotFoundError(f"Project '{project_id}' not found")
    return folder


def _project_trash(project_id: str) -> Path:
    return _trash_root() / project_id


def _entry_dir(project_id: str, trash_id: str) -> Path:
    if not _TRASH_ID_RE.match(trash_id or ""):
        raise FileNotFoundError("Trash entry not found")
    return _project_trash(project_id) / trash_id


def _read_meta(entry_dir: Path) -> dict[str, Any] | None:
    try:
        data = json.loads((entry_dir / _META_NAME).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    if not isinstance(data, dict):
        return None
    data.setdefault("id", entry_dir.name)
    return data


def _unique_target(target: Path) -> Path:
    """A free path near ``target`` (``name-2.md``, ``name-2/``, ...)."""
    if not target.exists():
        return target
    stem, suffix = target.stem, target.suffix
    counter = 2
    while True:
        candidate = target.with_name(f"{stem}-{counter}{suffix}")
        if not candidate.exists():
            return candidate
        counter += 1


def move_to_trash(
    project_id: str,
    path: Path,
    *,
    name: str,
    kind: str,
    original_id: str,
    words: int | None = None,
) -> dict[str, Any]:
    """Move ``path`` into the project's trash and return its metadata."""
    _project_folder(project_id)  # validates the id and the project's presence
    trash_id = uuid.uuid4().hex
    dest = _project_trash(project_id) / trash_id
    dest.mkdir(parents=True, exist_ok=False)
    meta: dict[str, Any] = {
        "id": trash_id,
        "name": name or original_id,
        "kind": kind,  # "document" | "folder"
        "originalId": original_id,
        "deletedAt": datetime.now().isoformat(timespec="seconds"),
        "words": words,
    }
    try:
        shutil.move(str(path), str(dest / _ENTRY_NAME))
        (dest / _META_NAME).write_text(
            json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8"
        )
    except OSError:
        shutil.rmtree(dest, ignore_errors=True)
        raise
    return meta


def list_trash(project_id: str) -> list[dict[str, Any]]:
    """Trashed entries, newest first. Corrupt entries are skipped."""
    _project_folder(project_id)
    root = _project_trash(project_id)
    if not root.is_dir():
        return []
    out: list[dict[str, Any]] = []
    for child in root.iterdir():
        if not child.is_dir() or not _TRASH_ID_RE.match(child.name):
            continue
        meta = _read_meta(child)
        if meta is None:
            continue
        meta["name"] = str(meta.get("name") or meta.get("originalId") or "Untitled")
        meta["kind"] = str(meta.get("kind") or "document")
        out.append(meta)
    out.sort(key=lambda m: str(m.get("deletedAt") or ""), reverse=True)
    return out


def restore(project_id: str, trash_id: str) -> dict[str, Any]:
    """Put a trashed entry back where it was. Returns its new id/name."""
    project_folder = _project_folder(project_id)
    entry_dir = _entry_dir(project_id, trash_id)
    meta = _read_meta(entry_dir)
    source = entry_dir / _ENTRY_NAME
    if meta is None or not source.exists():
        raise FileNotFoundError("Trash entry not found")

    kind = str(meta.get("kind") or "document")
    original_id = str(meta.get("originalId") or "")
    if not original_id:
        raise FileNotFoundError("Trash entry is malformed")

    relative = original_id.replace("\\", "/").lstrip("/")
    if kind == "document" and not relative.lower().endswith(".md"):
        relative += ".md"
    target = project_folder / relative
    base = project_folder.resolve()
    if not target.resolve().is_relative_to(base):
        raise FileNotFoundError("Trash entry is malformed")

    target.parent.mkdir(parents=True, exist_ok=True)
    renamed = target.exists()
    target = _unique_target(target)
    shutil.move(str(source), str(target))
    shutil.rmtree(entry_dir, ignore_errors=True)

    new_id = target.relative_to(project_folder).as_posix()
    if kind == "document" and new_id.lower().endswith(".md"):
        new_id = new_id[: -len(".md")]
    result = dict(meta)
    result.update({"newId": new_id, "renamed": renamed})
    return result


def purge(project_id: str, trash_id: str) -> bool:
    """Permanently delete one trashed entry. False when it doesn't exist."""
    _project_folder(project_id)
    entry_dir = _entry_dir(project_id, trash_id)
    if not entry_dir.is_dir():
        return False
    shutil.rmtree(entry_dir)
    return True


def empty(project_id: str) -> int:
    """Permanently delete every trashed entry. Returns the number removed."""
    _project_folder(project_id)
    root = _project_trash(project_id)
    if not root.is_dir():
        return 0
    removed = 0
    for child in list(root.iterdir()):
        if child.is_dir():
            shutil.rmtree(child, ignore_errors=True)
            removed += 1
    try:
        root.rmdir()
    except OSError:
        pass
    return removed


def delete_project_trash(project_id: str) -> None:
    """Drop a project's bin, for when the whole project is deleted."""
    if not config.is_safe_project_id(project_id):
        return
    shutil.rmtree(_project_trash(project_id), ignore_errors=True)
