"""Per-document snapshots: point-in-time copies of a document, restorable later.

Snapshots live at the *data root* -- ``<data>/.snapshots/<project_id>/`` -- not
inside the project, exactly like the trash, so they can never appear in the
document tree, word counts, wikilink scans, exports, repetition checks, or
whole-library backups. Each document gets a folder named by a hash of its id
(ids are paths, so ``a`` and ``a/b`` would collide as raw folder names), and
each snapshot inside it is its own folder:

    .snapshots/<project>/<doc-key>/<snapshot_id>/
        content      # the whole Markdown file at capture time
        meta.json    # {id, docId, title, kind, createdAt, reason, words, hash, manual, size}

Automatic snapshots are deduplicated by content hash and throttled so an
800 ms autosave does not produce a snapshot per keystroke; the newest
``_KEEP_PER_DOC`` automatic snapshots are kept. Manual snapshots are pinned
until deleted. Capturing is best-effort at the call site: it never fails a
save.

This module deliberately imports only ``app.config`` -- ``documents.py``
imports it, so importing documents back would create a cycle.
"""
from __future__ import annotations

import hashlib
import json
import re
import shutil
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any

from app import config

_SNAPSHOT_ID_RE = re.compile(r"^[0-9a-f]{32}$")
_CONTENT_NAME = "content"
_META_NAME = "meta.json"

# An automatic snapshot is taken at most this often per document, so writing
# steadily produces periodic checkpoints rather than one per autosave.
_AUTO_MIN_INTERVAL_S = 300
# Automatic snapshots kept per document (manual ones are pinned).
_KEEP_PER_DOC = 30

# Reasons recorded in meta.json; the UI maps them to labels.
REASON_AUTO = "auto"
REASON_MANUAL = "manual"
REASON_BEFORE_RESTORE = "before-restore"
REASON_AI = "ai"

_PUBLIC_KEYS = ("id", "docId", "title", "kind", "createdAt", "reason", "words", "manual", "size")


def snapshots_root() -> Path:
    return config.DATA_DIR / config.SNAPSHOTS_DIRNAME


def _project_dir(project_id: str) -> Path:
    """Validated snapshots folder for a project (may not exist yet)."""
    if not config.is_safe_project_id(project_id):
        raise FileNotFoundError(f"Project '{project_id}' not found")
    return snapshots_root() / project_id


def _require_project(project_id: str) -> None:
    """Raise FileNotFoundError unless the project itself exists."""
    if not config.is_safe_project_id(project_id):
        raise FileNotFoundError(f"Project '{project_id}' not found")
    folder = config.DATA_DIR / project_id
    if not (folder / config.PROJECT_META_FILENAME).exists():
        raise FileNotFoundError(f"Project '{project_id}' not found")


def _doc_key(doc_id: str) -> str:
    """A flat, filesystem-safe folder name for a (possibly nested) document id."""
    return hashlib.sha1(doc_id.encode("utf-8")).hexdigest()[:20]


def _doc_dir(project_id: str, doc_id: str) -> Path:
    return _project_dir(project_id) / _doc_key(doc_id)


def _entry_dir(project_id: str, doc_id: str, snapshot_id: str) -> Path:
    if not _SNAPSHOT_ID_RE.match(snapshot_id or ""):
        raise FileNotFoundError("Snapshot not found")
    return _doc_dir(project_id, doc_id) / snapshot_id


def _now() -> str:
    # Milliseconds: precise enough to order rapid captures, while staying a
    # format JavaScript's ``new Date(...)`` parses (microseconds would not be).
    return datetime.now().isoformat(timespec="milliseconds")


def _parse_dt(value: Any) -> datetime | None:
    try:
        return datetime.fromisoformat(str(value))
    except (TypeError, ValueError):
        return None


def _public_meta(meta: dict[str, Any]) -> dict[str, Any]:
    return {key: meta.get(key) for key in _PUBLIC_KEYS if key in meta}


def _read_meta(entry_dir: Path) -> dict[str, Any] | None:
    try:
        data = json.loads((entry_dir / _META_NAME).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    if not isinstance(data, dict):
        return None
    data.setdefault("id", entry_dir.name)
    return data


def _write_meta(entry_dir: Path, meta: dict[str, Any]) -> None:
    config._write_atomic(
        entry_dir / _META_NAME,
        json.dumps(meta, ensure_ascii=False, indent=2),
    )


def _list_entries(doc_dir: Path) -> list[tuple[Path, dict[str, Any]]]:
    """Existing snapshots for one document, newest first. Corrupt ones skipped.

    ``createdAt`` only has millisecond resolution, so rapid captures can tie;
    the folder's ``st_mtime_ns`` breaks those ties in true creation order.
    """
    if not doc_dir.is_dir():
        return []
    out: list[tuple[Path, dict[str, Any], int]] = []
    for child in doc_dir.iterdir():
        if not child.is_dir() or not _SNAPSHOT_ID_RE.match(child.name):
            continue
        meta = _read_meta(child)
        if meta is None:
            continue
        try:
            mtime = child.stat().st_mtime_ns
        except OSError:
            mtime = 0
        out.append((child, meta, mtime))
    out.sort(
        key=lambda item: (str(item[1].get("createdAt") or ""), item[2]),
        reverse=True,
    )
    return [(child, meta) for child, meta, _mtime in out]


def _prune(doc_dir: Path) -> int:
    """Drop automatic snapshots beyond ``_KEEP_PER_DOC`` (oldest first)."""
    entries = _list_entries(doc_dir)
    automatic = [entry for entry in entries if not entry[1].get("manual")]
    removed = 0
    for child, _meta in automatic[_KEEP_PER_DOC:]:
        shutil.rmtree(child, ignore_errors=True)
        removed += 1
    return removed


def capture(
    project_id: str,
    doc_id: str,
    raw: str,
    *,
    reason: str = REASON_AUTO,
    title: str | None = None,
    kind: str | None = None,
    words: int | None = None,
    manual: bool = False,
    min_interval_s: int = _AUTO_MIN_INTERVAL_S,
) -> dict[str, Any] | None:
    """Store ``raw`` as a snapshot unless it duplicates the newest one.

    ``reason="auto"`` snapshots are throttled to one per ``min_interval_s``;
    manual and safety captures (before a restore, after an AI rewrite) always
    store when the content differs. Returns the new metadata, or ``None`` when
    nothing was captured.
    """
    content_hash = hashlib.sha256(raw.encode("utf-8")).hexdigest()
    doc_dir = _doc_dir(project_id, doc_id)
    entries = _list_entries(doc_dir)
    newest = entries[0] if entries else None
    newest_hash = newest[1].get("hash") if newest else None
    if newest_hash == content_hash:
        return None
    if not manual and reason == REASON_AUTO and newest is not None:
        created = _parse_dt(newest[1].get("createdAt"))
        if created is not None and (datetime.now() - created).total_seconds() < min_interval_s:
            return None

    snapshot_id = uuid.uuid4().hex
    dest = doc_dir / snapshot_id
    meta = {
        "id": snapshot_id,
        "docId": doc_id,
        "title": title or "",
        "kind": kind or "",
        "createdAt": _now(),
        "reason": reason,
        "words": words,
        "hash": content_hash,
        "manual": bool(manual),
        "size": len(raw.encode("utf-8")),
    }
    try:
        dest.mkdir(parents=True, exist_ok=False)
        config._write_atomic(dest / _CONTENT_NAME, raw)
        _write_meta(dest, meta)
    except OSError:
        shutil.rmtree(dest, ignore_errors=True)
        raise
    _prune(doc_dir)
    return meta


def list_snapshots(project_id: str, doc_id: str) -> list[dict[str, Any]]:
    """Snapshot metadata for one document, newest first."""
    _require_project(project_id)
    return [_public_meta(meta) for _child, meta in _list_entries(_doc_dir(project_id, doc_id))]


def read_snapshot(project_id: str, doc_id: str, snapshot_id: str) -> dict[str, Any]:
    """One snapshot: its metadata and the whole Markdown file it captured."""
    _require_project(project_id)
    entry_dir = _entry_dir(project_id, doc_id, snapshot_id)
    meta = _read_meta(entry_dir)
    content_path = entry_dir / _CONTENT_NAME
    if meta is None or not content_path.is_file():
        raise FileNotFoundError("Snapshot not found")
    return {
        "meta": _public_meta(meta),
        "content": content_path.read_text(encoding="utf-8"),
    }


def delete_snapshot(project_id: str, doc_id: str, snapshot_id: str) -> bool:
    """Permanently delete one snapshot. False when it doesn't exist."""
    _require_project(project_id)
    entry_dir = _entry_dir(project_id, doc_id, snapshot_id)
    if not entry_dir.is_dir():
        return False
    shutil.rmtree(entry_dir)
    _prune_empty(_doc_dir(project_id, doc_id))
    return True


def clear_doc(project_id: str, doc_id: str) -> int:
    """Delete every snapshot for one document. Returns the number removed."""
    _require_project(project_id)
    doc_dir = _doc_dir(project_id, doc_id)
    if not doc_dir.is_dir():
        return 0
    removed = 0
    for child in list(doc_dir.iterdir()):
        if child.is_dir():
            shutil.rmtree(child, ignore_errors=True)
            removed += 1
    shutil.rmtree(doc_dir, ignore_errors=True)
    return removed


def rekey_map(project_id: str, id_map: dict[str, str]) -> int:
    """Move a document's snapshots when a move/rename changes its id.

    ``id_map`` is the same expanded ``old id -> new id`` map used to rewrite
    wikilinks, so nested documents carried along by a folder change are
    included. Returns the number of documents whose snapshots moved.
    """
    if not id_map or not config.is_safe_project_id(project_id):
        return 0
    project_dir = _project_dir(project_id)
    if not project_dir.is_dir():
        return 0
    moved = 0
    for old_id, new_id in id_map.items():
        if not old_id or not new_id or old_id == new_id:
            continue
        old_dir = project_dir / _doc_key(old_id)
        if not old_dir.is_dir():
            continue
        new_dir = project_dir / _doc_key(new_id)
        if new_dir.exists():
            # A hash collision, or snapshots already filed under the new id.
            # The moved document is authoritative; drop the stale target.
            shutil.rmtree(new_dir, ignore_errors=True)
        try:
            shutil.move(str(old_dir), str(new_dir))
        except OSError:
            continue
        # Keep the stored docId honest so the history is self-describing.
        for child, meta in _list_entries(new_dir):
            meta["docId"] = new_id
            try:
                _write_meta(child, meta)
            except OSError:
                continue
        moved += 1
    return moved


def delete_project_snapshots(project_id: str) -> None:
    """Drop a project's snapshot tree, for when the whole project is deleted."""
    if not config.is_safe_project_id(project_id):
        return
    shutil.rmtree(_project_dir(project_id), ignore_errors=True)


def _prune_empty(doc_dir: Path) -> None:
    try:
        doc_dir.rmdir()
    except OSError:
        pass
