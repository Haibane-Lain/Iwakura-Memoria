"""Persistent AI chat sessions (one JSON file per session).

Sessions live under ``data/ai-sessions/<project_id>/`` — a global app
directory, never inside the project tree, so it can't collide with user
folders. Every chat/confirm/compress turn is persisted; a pending
confirmation is stored so it survives a server restart.
"""
from __future__ import annotations

import json
import re
import shutil
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from app import config

_SESSION_ID_RE = re.compile(r"^[a-f0-9]{32}$")
_MAX_SESSIONS = 50


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _sessions_dir(project_id: str) -> Path:
    if not re.fullmatch(r"[A-Za-z0-9._-]+", project_id):
        raise ValueError("Invalid project id")
    path = config.DATA_DIR / "ai-sessions" / project_id
    return path


def _path(project_id: str, session_id: str) -> Path:
    if not _SESSION_ID_RE.match(session_id):
        raise ValueError("Invalid session id")
    return _sessions_dir(project_id) / f"{session_id}.json"


def session_dir(project_id: str, session_id: str) -> Path:
    """Return the per-session storage directory (sibling of its JSON file)."""
    if not _SESSION_ID_RE.match(session_id):
        raise ValueError("Invalid session id")
    return _sessions_dir(project_id) / session_id


def estimate_tokens(text: str) -> int:
    """Rough token estimate (chars ÷ 4), good enough for the UI."""
    return max(1, len(text or "") // 4)


def create(project_id: str) -> dict[str, Any]:
    now = _now()
    session: dict[str, Any] = {
        "sessionId": uuid.uuid4().hex,
        "projectId": project_id,
        "title": "New session",
        "createdAt": now,
        "updatedAt": now,
        "history": [],
        "scope": ["", "worldbuilding"],
        "currentDocId": None,
        "compressedSummary": None,
        "archived": [],
        "attachments": [],
        "tokensUsed": {"prompt": 0, "completion": 0, "total": 0, "cache_hit": 0, "cache_miss": 0, "effective": 0},
        "agentState": None,
    }
    save(project_id, session)
    return session


def save(project_id: str, session: dict[str, Any]) -> None:
    session["updatedAt"] = _now()
    path = _path(project_id, session["sessionId"])
    path.parent.mkdir(parents=True, exist_ok=True)
    config._write_atomic(path, json.dumps(session, ensure_ascii=False, indent=2))


def load(project_id: str, session_id: str) -> dict[str, Any] | None:
    path = _path(project_id, session_id)
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return None


def delete(project_id: str, session_id: str) -> bool:
    path = _path(project_id, session_id)
    if not path.exists():
        return False
    path.unlink()
    return True


def rename(project_id: str, session_id: str, title: str) -> dict[str, Any] | None:
    session = load(project_id, session_id)
    if session is None:
        return None
    session["title"] = (title or "").strip() or session["title"]
    save(project_id, session)
    return session


def set_title(project_id: str, session: dict[str, Any]) -> None:
    first_user = next((m for m in session.get("history", []) if m.get("role") == "user"), None)
    if first_user:
        title = " ".join(str(first_user.get("content", "")).split())[:40] or "New session"
        session["title"] = title
        save(project_id, session)


def list_sessions(project_id: str) -> list[dict[str, Any]]:
    directory = _sessions_dir(project_id)
    if not directory.exists():
        return []
    results: list[dict[str, Any]] = []
    for path in sorted(directory.glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True):
        try:
            session = json.loads(path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            continue
        history = session.get("history") or []
        summary = session.get("compressedSummary") or ""
        used = session.get("tokensUsed") or {}
        tokens = int(used.get("effective") or used.get("total") or 0)
        if not tokens:
            tokens = estimate_tokens(summary) + sum(
                estimate_tokens(str(m.get("content", ""))) for m in history
            )
        results.append(
            {
                "sessionId": session.get("sessionId"),
                "title": session.get("title") or "New session",
                "createdAt": session.get("createdAt", ""),
                "updatedAt": session.get("updatedAt", ""),
                "messageCount": len(history),
                "tokens": tokens,
                "hasPending": bool(session.get("agentState") and session["agentState"].get("pending")),
            }
        )
    _cleanup(project_id)
    return results


def _cleanup(project_id: str) -> None:
    directory = _sessions_dir(project_id)
    if not directory.exists():
        return
    paths = sorted(directory.glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True)
    for path in paths[_MAX_SESSIONS:]:
        try:
            path.unlink()
        except OSError:
            pass
    if not any(directory.iterdir()):
        shutil.rmtree(directory, ignore_errors=True)
