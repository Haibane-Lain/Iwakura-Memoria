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

import copy
import json
import os
import re
import secrets
import shutil
import sys
import threading
import time
from pathlib import Path
from typing import Any

PROJECT_ROOT = Path(__file__).resolve().parent.parent
LEGACY_DATA_DIR = PROJECT_ROOT / "data"
APP_DATA_DIR_NAME = "IwakuraMemoria"
DATA_DIR_NAME = "data"
_MIGRATION_MARKER = ".migration-done"

DEFAULT_SETTINGS: dict[str, Any] = {
    # First launch only: a stored theme always wins, so changing this never
    # restyles an existing install.
    "theme": "gothic",
    "wordCountMode": "auto",
    "autosaveMs": 800,
    "editorFont": "serif",
    "editorSize": 18,
    "editorAlign": "left",
    # Percent of the comfortable reading baseline: 100% renders at CSS zoom 2
    # (documents.rebase_zoom_scale halved the older factor-based numbers once).
    # Zoom is the one preference with a default *per tab*: the Write tab reads
    # like a manuscript page at 100%, the Wiki tab is a reference page and is
    # meant to be scanned, so it starts one step down. Font, size and alignment
    # stay shared.
    "editorZoom": 100,
    "wikiZoom": 75,
    "grammarEnabled": True,
    "ai": {},
}

PROJECT_META_FILENAME = "project.json"
STATS_DIRNAME = "stats"
HISTORY_FILENAME = "history.jsonl"
REORDER_TMP_DIRNAME = ".reorder-tmp"
# Recycle bin for deleted documents/folders. It lives at the data root (a
# sibling of the projects) rather than inside a project, so it can never show
# up in a tree, an export, a word count, or a wikilink scan. Restore it from
# Settings -> Trash.
TRASH_DIRNAME = ".trash"
WIKI_DIRNAME = "worldbuilding"
TEMPLATES_DIRNAME = "templates"
# Uploaded pictures for inline images, one folder per project. Deliberately a
# visible name: the files are real images the user may want to open in an
# image editor, and they are included in zip exports and backups.
ASSETS_DIRNAME = "assets"

# Names that can't be used as user folders (reserved by the app).
RESERVED_FOLDER_NAMES = {
    PROJECT_META_FILENAME,
    STATS_DIRNAME,
    REORDER_TMP_DIRNAME,
    WIKI_DIRNAME,
    ASSETS_DIRNAME,
}

_PROJECT_ID_RE = re.compile(r"^[A-Za-z0-9._-]+$")


def is_safe_project_id(project_id: str) -> bool:
    """True when ``project_id`` is a safe folder name inside the data dir.

    The pattern allows letters/digits/``._-`` (so slugs and dotted names keep
    working) but rejects empty ids and anything that could escape the data
    root: ``.``, ``..``, hidden dot-prefixed names, and any path separator.
    """
    if not _PROJECT_ID_RE.fullmatch(project_id or ""):
        return False
    return not project_id.startswith(".")


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


def _sweep_orphan_tmp(root: Path) -> int:
    """Delete stray ``*.tmp`` files under *root* that are older than a day.

    Atomic writes leave ``.<name>.<pid>.<token>.tmp`` files that live for
    milliseconds; anything still present after a day is a leftover from an
    interrupted write (crash, kill, disk error). Only files older than
    ``_TMP_SWEEP_MAX_AGE_S`` are removed, so in-flight writes are never
    touched. Returns the number of files deleted. Best-effort.
    """
    removed = 0
    now = time.time()
    try:
        walker = os.walk(root)
    except OSError:
        return 0
    for dirpath, _dirnames, filenames in walker:
        for name in filenames:
            if not name.endswith(".tmp"):
                continue
            path = Path(dirpath) / name
            try:
                if now - path.stat().st_mtime > _TMP_SWEEP_MAX_AGE_S:
                    path.unlink()
                    removed += 1
            except OSError:
                continue
    if removed:
        print(f"[config] removed {removed} orphaned temp file(s) under {root}", file=sys.stderr)
    return removed


# Age past which a *.tmp file is treated as an orphan.
_TMP_SWEEP_MAX_AGE_S = 24 * 60 * 60


def ensure_dirs() -> None:
    global DATA_DIR
    intended = _default_data_dir()
    try:
        DATA_DIR = intended if _migrate_legacy_data(intended) else LEGACY_DATA_DIR
        DATA_DIR.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        print(
            f"[config] cannot use {intended} ({exc}); falling back to {LEGACY_DATA_DIR}",
            file=sys.stderr,
        )
        DATA_DIR = LEGACY_DATA_DIR
        DATA_DIR.mkdir(parents=True, exist_ok=True)
    STATIC_DIR.mkdir(parents=True, exist_ok=True)
    _sweep_orphan_tmp(DATA_DIR)


def get_settings_path() -> Path:
    return DATA_DIR / "settings.json"


_settings_lock = threading.Lock()
_settings_cache: dict[str, Any] | None = None
_settings_cache_key: tuple[str, bool, float | None] | None = None


def load_settings() -> dict[str, Any]:
    """Read global settings, cached in-process between file changes.

    The cache key is ``(path, exists, mtime)`` so edits from any process (and
    tests pointed at different data dirs) are picked up, while the per-request
    ``_mode()`` read during 800 ms autosaves stops touching the disk every
    call. Callers receive a deep copy, so mutating the result never corrupts
    the cached value.
    """
    path = get_settings_path()
    exists = path.exists()
    mtime: float | None = None
    if exists:
        try:
            mtime = path.stat().st_mtime
        except OSError:
            exists = False
    key = (str(path), exists, mtime)
    global _settings_cache, _settings_cache_key
    with _settings_lock:
        if _settings_cache is not None and _settings_cache_key == key:
            return copy.deepcopy(_settings_cache)
    if not exists:
        merged = dict(DEFAULT_SETTINGS)
    else:
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            data = {}
        merged = dict(DEFAULT_SETTINGS)
        merged.update(data)
    with _settings_lock:
        _settings_cache = merged
        _settings_cache_key = key
        return copy.deepcopy(merged)


def save_settings(settings: dict[str, Any]) -> dict[str, Any]:
    merged = dict(DEFAULT_SETTINGS)
    merged.update(settings)
    # Deliberately ``mkdir`` rather than ``ensure_dirs()``: ensure_dirs()
    # re-derives DATA_DIR from the environment, so a caller that pointed
    # DATA_DIR somewhere of its own (a test, a tool) would silently have its
    # settings written into the real user data folder instead.
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    path = get_settings_path()
    _write_atomic(
        path,
        json.dumps(merged, ensure_ascii=False, indent=2),
    )
    try:
        mtime = path.stat().st_mtime
    except OSError:
        mtime = None
    global _settings_cache, _settings_cache_key
    with _settings_lock:
        # Refresh the cache so the value just written is served without
        # re-reading the file (and any concurrent load sees it consistently).
        _settings_cache = merged
        _settings_cache_key = (str(path), True, mtime)
    return merged


_WRITE_RETRY_COUNT = 10
_WRITE_RETRY_DELAY_S = 0.05


def _write_atomic(path: Path, content: str) -> None:
    tmp = path.with_name(f".{path.name}.{os.getpid()}.{secrets.token_hex(4)}.tmp")
    try:
        tmp.write_text(content, encoding="utf-8")
        for attempt in range(_WRITE_RETRY_COUNT):
            try:
                os.replace(tmp, path)
                return
            except OSError:
                if attempt == _WRITE_RETRY_COUNT - 1:
                    raise
                time.sleep(_WRITE_RETRY_DELAY_S)
    finally:
        # A successful replace consumed *tmp*; a failed write/replace leaves it
        # behind. Remove it now so a persistently locked target doesn't rely on
        # the once-a-day startup sweep to reclaim the disk space.
        try:
            tmp.unlink(missing_ok=True)
        except OSError:
            pass
