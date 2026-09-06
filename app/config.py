"""Application configuration and paths.

User data lives in the local app-data directory, not next to the code:

- ``%LOCALAPPDATA%/IwakuraMemoria/data`` on Windows,
- ``~/.iwakura/data`` elsewhere.

An ``IWAKURA_DATA_DIR`` environment variable overrides the location (used by
tests and by a future portable mode). When the app first runs after an
upgrade, an existing ``data/`` folder next to the code is migrated to the new
location. The migration is idempotent and never destructive: the legacy
folder is only ever moved, never deleted in place, and is kept authoritative
when the new location is already populated or the move fails.

- ``settings.json``     global settings (theme, word-count mode)
- ``<project>/``        one folder per project (see README for layout)
"""
from __future__ import annotations

import json
import os
import secrets
import shutil
import sys
import time
from pathlib import Path
from typing import Any

PROJECT_ROOT = Path(__file__).resolve().parent.parent
LEGACY_DATA_DIR = PROJECT_ROOT / "data"
APP_DATA_DIR_NAME = "IwakuraMemoria"
DATA_DIR_NAME = "data"
_MIGRATION_MARKER = ".migration-done"

DEFAULT_SETTINGS: dict[str, Any] = {
    "theme": "paper",
    "wordCountMode": "auto",
    "autosaveMs": 800,
    "editorFont": "serif",
    "editorSize": 18,
    "editorAlign": "left",
    "editorZoom": 100,
    "grammarEnabled": True,
    "ai": {},
}

PROJECT_META_FILENAME = "project.json"
STATS_DIRNAME = "stats"
HISTORY_FILENAME = "history.jsonl"
REORDER_TMP_DIRNAME = ".reorder-tmp"
WIKI_DIRNAME = "worldbuilding"
TEMPLATES_DIRNAME = "templates"

# Names that can't be used as user folders (reserved by the app).
RESERVED_FOLDER_NAMES = {
    PROJECT_META_FILENAME,
    STATS_DIRNAME,
    REORDER_TMP_DIRNAME,
    WIKI_DIRNAME,
}


def _default_data_dir() -> Path:
    """Where user data lives: env override, else LOCALAPPDATA, else home."""
    override = os.environ.get("IWAKURA_DATA_DIR")
    if override:
        return Path(override).expanduser()
    local = os.environ.get("LOCALAPPDATA")
    if local:
        return Path(local) / APP_DATA_DIR_NAME / DATA_DIR_NAME
    return Path.home() / ".iwakura" / DATA_DIR_NAME


def _resolve_static_dir() -> Path:
    """Static web assets. Under PyInstaller they sit in the bundled _MEIPASS."""
    if getattr(sys, "frozen", False):
        base = Path(getattr(sys, "_MEIPASS", PROJECT_ROOT))
        return base / "static"
    return PROJECT_ROOT / "static"


# Static assets always ship with the app; data is per-user.
STATIC_DIR = _resolve_static_dir()

# The *intended* data location at import time. ``ensure_dirs()`` may redirect
# this to ``LEGACY_DATA_DIR`` if the migration cannot complete, so nothing
# should read ``DATA_DIR`` before ``ensure_dirs()`` has run (``create_app()``
# calls it on startup).
DATA_DIR = _default_data_dir()


def _legacy_has_content() -> bool:
    try:
        return LEGACY_DATA_DIR.is_dir() and any(LEGACY_DATA_DIR.iterdir())
    except OSError:
        return False


def _migrate_legacy_data(target: Path) -> bool:
    """Move the old code-adjacent ``data/`` folder into *target*.

    Returns ``True`` when *target* is authoritative (migrated now, or already
    migrated / nothing to migrate) and ``False`` when the legacy folder must
    stay authoritative. Idempotent via a marker file; never destructive — an
    aborted move leaves the legacy folder intact.
    """
    marker = target / _MIGRATION_MARKER
    if target.is_dir() and marker.exists():
        return True  # already migrated
    if not _legacy_has_content():
        return True  # fresh install — nothing to migrate
    if target.is_dir() and any(target.iterdir()):
        # Never merge or overwrite: the new location is already in use.
        print(
            f"[config] {target} already has content — keeping legacy data at {LEGACY_DATA_DIR}",
            file=sys.stderr,
        )
        return False
    target.parent.mkdir(parents=True, exist_ok=True)
    # An empty target dir would make shutil.move *nest* the legacy folder in it.
    if target.is_dir():
        try:
            target.rmdir()
        except OSError:
            return False
    try:
        shutil.move(str(LEGACY_DATA_DIR), str(target))
    except OSError as exc:
        print(
            f"[config] data migration failed ({exc}) — continuing with {LEGACY_DATA_DIR}",
            file=sys.stderr,
        )
        return False
    try:
        marker.write_text("migrated\n", encoding="utf-8")
    except OSError:
        pass
    print(f"[config] moved data folder to {target}", file=sys.stderr)
    return True


def ensure_dirs() -> None:
    global DATA_DIR
    intended = _default_data_dir()
    try:
        if _migrate_legacy_data(intended):
            DATA_DIR = intended
        else:
            DATA_DIR = LEGACY_DATA_DIR
        DATA_DIR.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        print(
            f"[config] cannot use {intended} ({exc}); falling back to {LEGACY_DATA_DIR}",
            file=sys.stderr,
        )
        DATA_DIR = LEGACY_DATA_DIR
        DATA_DIR.mkdir(parents=True, exist_ok=True)
    STATIC_DIR.mkdir(parents=True, exist_ok=True)


def get_settings_path() -> Path:
    return DATA_DIR / "settings.json"


def load_settings() -> dict[str, Any]:
    path = get_settings_path()
    if not path.exists():
        return dict(DEFAULT_SETTINGS)
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return dict(DEFAULT_SETTINGS)
    merged = dict(DEFAULT_SETTINGS)
    merged.update(data)
    return merged


def save_settings(settings: dict[str, Any]) -> dict[str, Any]:
    merged = dict(DEFAULT_SETTINGS)
    merged.update(settings)
    ensure_dirs()
    _write_atomic(
        get_settings_path(),
        json.dumps(merged, ensure_ascii=False, indent=2),
    )
    return merged


_WRITE_RETRY_COUNT = 10
_WRITE_RETRY_DELAY_S = 0.05


def _write_atomic(path: Path, content: str) -> None:
    tmp = path.with_name(f".{path.name}.{os.getpid()}.{secrets.token_hex(4)}.tmp")
    tmp.write_text(content, encoding="utf-8")
    for attempt in range(_WRITE_RETRY_COUNT):
        try:
            os.replace(tmp, path)
            return
        except OSError:
            if attempt == _WRITE_RETRY_COUNT - 1:
                raise
            time.sleep(_WRITE_RETRY_DELAY_S)