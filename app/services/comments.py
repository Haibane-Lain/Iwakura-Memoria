"""Per-document comments, kept out of the document body.

A comment is anchored in the Markdown by a bare inline marker -- an
``<span data-cid="...">...</span>`` the editor writes -- while the comment
itself (text, author, resolved flag) lives here, at the data root:

    <data>/.comments/<project_id>/<doc-key>.json

Like the trash and the snapshots, this folder lives as a sibling of the
projects so it can never show up in the document tree, a word count, a
wikilink scan, a search, or an export. The marker carries only the id; this
file carries the words.

``doc-key`` is a hash of the document id (ids are paths, so ``a`` and ``a/b``
would collide as raw file names), matching the snapshots layout. A move or
rename re-keys the file; a project delete drops the whole folder.

This module deliberately imports only ``app.config`` -- ``documents.py``
imports it for the lifecycle hooks, so importing documents back would create a
cycle.
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

_COMMENT_ID_RE = re.compile(r"^c_[0-9a-f]{12}$")

# Sanity caps so a runaway client (or a pasted novel) cannot grow a sidecar
# without bound. Generous for real review notes.
_MAX_BODY = 4000
_MAX_QUOTE = 500
_MAX_AUTHOR = 40

PUBLIC_KEYS = (
    "id",
    "docId",
    "body",
    "author",
    "createdAt",
    "updatedAt",
    "resolved",
    "resolvedAt",
    "quote",
)


def comments_root() -> Path:
    return config.DATA_DIR / config.COMMENTS_DIRNAME


def _project_dir(project_id: str) -> Path:
    """Validated comments folder for a project (may not exist yet)."""
    if not config.is_safe_project_id(project_id):
        raise FileNotFoundError(f"Project '{project_id}' not found")
    return comments_root() / project_id


def _require_project(project_id: str) -> None:
    """Raise FileNotFoundError unless the project itself exists."""
    if not config.is_safe_project_id(project_id):
        raise FileNotFoundError(f"Project '{project_id}' not found")
    folder = config.DATA_DIR / project_id
    if not (folder / config.PROJECT_META_FILENAME).exists():
        raise FileNotFoundError(f"Project '{project_id}' not found")


def _doc_key(doc_id: str) -> str:
    """A flat, filesystem-safe file name for a (possibly nested) document id."""
    return hashlib.sha1(doc_id.encode("utf-8")).hexdigest()[:20]


def _doc_file(project_id: str, doc_id: str) -> Path:
    return _project_dir(project_id) / f"{_doc_key(doc_id)}.json"


def _now() -> str:
    # Milliseconds: orderable for rapid creates, and parseable by
    # JavaScript's ``new Date(...)`` (microseconds would not be).
    return datetime.now().isoformat(timespec="milliseconds")


def _clean_body(body: str) -> str:
    text = str(body or "").strip()
    if not text:
        raise ValueError("A comment needs some text")
    if len(text) > _MAX_BODY:
        raise ValueError(f"A comment can be at most {_MAX_BODY} characters")
    return text


def _clean_quote(quote: str) -> str:
    return str(quote or "").strip()[: _MAX_QUOTE]


def _clean_author(author: str) -> str:
    return (str(author or "").strip() or "you")[: _MAX_AUTHOR]


def _public(comment: dict[str, Any]) -> dict[str, Any]:
    return {key: comment.get(key) for key in PUBLIC_KEYS if key in comment}


def _read_doc(project_id: str, doc_id: str) -> list[dict[str, Any]]:
    """Every comment for one document, in creation order. Corrupt data is skipped."""
    path = _doc_file(project_id, doc_id)
    if not path.is_file():
        return []
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return []
    if not isinstance(data, list):
        return []
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for item in data:
        if not isinstance(item, dict):
            continue
        comment_id = item.get("id")
        if not isinstance(comment_id, str) or comment_id in seen:
            continue
        seen.add(comment_id)
        out.append(item)
    return out


def _write_doc(project_id: str, doc_id: str, comments: list[dict[str, Any]]) -> None:
    path = _doc_file(project_id, doc_id)
    if not comments:
        path.unlink(missing_ok=True)
        _prune_empty(path.parent)
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    config._write_atomic(
        path,
        json.dumps(comments, ensure_ascii=False, indent=2),
    )


def list_doc(project_id: str, doc_id: str) -> list[dict[str, Any]]:
    """Comment records for one document, in creation order."""
    _require_project(project_id)
    return [_public(comment) for comment in _read_doc(project_id, doc_id)]


def create(
    project_id: str,
    doc_id: str,
    body: str,
    *,
    quote: str = "",
    author: str = "you",
) -> dict[str, Any]:
    """Add a comment and return its record.

    The caller (the editor) is responsible for writing the matching
    ``data-cid`` marker into the document; this only stores the body.
    """
    _require_project(project_id)
    if not doc_id:
        raise ValueError("A document id is required")
    text = _clean_body(body)
    now = _now()
    comment = {
        "id": f"c_{uuid.uuid4().hex[:12]}",
        "docId": doc_id,
        "body": text,
        "author": _clean_author(author),
        "createdAt": now,
        "updatedAt": now,
        "resolved": False,
        "resolvedAt": None,
        "quote": _clean_quote(quote),
    }
    comments = _read_doc(project_id, doc_id)
    comments.append(comment)
    _write_doc(project_id, doc_id, comments)
    return _public(comment)


def update(
    project_id: str,
    doc_id: str,
    comment_id: str,
    *,
    body: str | None = None,
    resolved: bool | None = None,
) -> dict[str, Any]:
    """Edit a comment's body and/or its resolved flag."""
    _require_project(project_id)
    comments = _read_doc(project_id, doc_id)
    for comment in comments:
        if comment.get("id") != comment_id:
            continue
        if body is not None:
            comment["body"] = _clean_body(body)
        if resolved is not None:
            comment["resolved"] = bool(resolved)
            comment["resolvedAt"] = _now() if resolved else None
        comment["updatedAt"] = _now()
        _write_doc(project_id, doc_id, comments)
        return _public(comment)
    raise FileNotFoundError("Comment not found")


def delete(project_id: str, doc_id: str, comment_id: str) -> bool:
    """Remove one comment. False when it doesn't exist."""
    _require_project(project_id)
    comments = _read_doc(project_id, doc_id)
    remaining = [c for c in comments if c.get("id") != comment_id]
    if len(remaining) == len(comments):
        return False
    _write_doc(project_id, doc_id, remaining)
    return True


def delete_many(project_id: str, doc_id: str, ids: list[str]) -> int:
    """Remove a set of comments. Returns the number removed."""
    _require_project(project_id)
    wanted = {str(i) for i in ids if i}
    if not wanted:
        return 0
    comments = _read_doc(project_id, doc_id)
    remaining = [c for c in comments if c.get("id") not in wanted]
    removed = len(comments) - len(remaining)
    if removed:
        _write_doc(project_id, doc_id, remaining)
    return removed


def clear_doc(project_id: str, doc_id: str, *, resolved_only: bool = False) -> int:
    """Delete every comment for a document (or only the resolved ones)."""
    _require_project(project_id)
    comments = _read_doc(project_id, doc_id)
    if resolved_only:
        remaining = [c for c in comments if not c.get("resolved")]
        removed = len(comments) - len(remaining)
        if removed:
            _write_doc(project_id, doc_id, remaining)
        return removed
    removed = len(comments)
    _write_doc(project_id, doc_id, [])
    return removed


def rekey_map(project_id: str, id_map: dict[str, str]) -> int:
    """Move comment files when a move/rename changes document ids.

    ``id_map`` is the same expanded ``old id -> new id`` map used to rewrite
    wikilinks and move snapshots, so nested documents carried along by a folder
    change are included. When both sides exist their comment lists are merged
    (by id), never dropped. Returns the number of documents whose comments
    moved.
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
        old_file = _doc_file(project_id, old_id)
        if not old_file.is_file():
            continue
        new_file = _doc_file(project_id, new_id)
        comments = _read_doc(project_id, old_id)
        if new_file.is_file():
            existing = _read_doc(project_id, new_id)
            seen = {c.get("id") for c in existing}
            comments = existing + [c for c in comments if c.get("id") not in seen]
        for comment in comments:
            comment["docId"] = new_id
        try:
            _write_doc(project_id, new_id, comments)
            old_file.unlink(missing_ok=True)
        except OSError:
            continue
        moved += 1
    return moved


def delete_project_comments(project_id: str) -> None:
    """Drop a project's comment folder, for when the whole project is deleted."""
    if not config.is_safe_project_id(project_id):
        return
    shutil.rmtree(_project_dir(project_id), ignore_errors=True)


def _prune_empty(folder: Path) -> None:
    try:
        folder.rmdir()
    except OSError:
        pass
