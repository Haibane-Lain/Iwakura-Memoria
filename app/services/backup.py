"""Whole-library backups: timestamped zips of the data dir with retention.

A backup captures every project (documents, wiki, stats, templates,
dictionary), the global settings, and the AI chat sessions as a plain zip that
extracts back to the ``data/`` layout. Backups live next to the data dir
(``<data-dir-parent>/backups``) so they are never backed up themselves.

Transient junk is skipped: staged ``.reorder-tmp`` renumbers, atomic-write
``*.tmp`` leftovers, the ``.trash`` recycle bin, the ``.snapshots`` version
history, and hidden files. Old backups beyond ``_BACKUP_KEEP`` are pruned
automatically after each new one.
"""
from __future__ import annotations

import re
import zipfile
from datetime import datetime
from pathlib import Path

from app import config

BACKUPS_DIRNAME = "backups"
_BACKUP_KEEP = 10
_STAMP = "%Y-%m-%dT%H-%M-%S"
# backup-2026-09-06T20-30-00.zip, with an optional -N suffix when two backups
# are created within the same second (tests, rapid clicks).
_BACKUP_NAME_RE = re.compile(r"^backup-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(?:-\d+)?\.zip$")


def backups_dir() -> Path:
    return config.DATA_DIR.parent / BACKUPS_DIRNAME


def _iter_backup_paths() -> list[Path]:
    """Existing backup zips, oldest first (names sort by timestamp)."""
    d = backups_dir()
    if not d.is_dir():
        return []
    return sorted(
        (p for p in d.iterdir() if p.is_file() and _BACKUP_NAME_RE.match(p.name)),
        key=lambda p: p.name,
    )


def _skip_entry(path: Path) -> bool:
    return (
        config.REORDER_TMP_DIRNAME in path.parts
        or config.TRASH_DIRNAME in path.parts
        or config.SNAPSHOTS_DIRNAME in path.parts
        or path.name.endswith(".tmp")
        or path.name.startswith(".")
    )


def _unique_name(d: Path, stamp: str) -> str:
    name = f"backup-{stamp}.zip"
    counter = 2
    while (d / name).exists():
        name = f"backup-{stamp}-{counter}.zip"
        counter += 1
    return name


def create_backup() -> dict:
    """Zip the whole data dir; prune old backups. Returns backup metadata."""
    # NOTE: deliberately not config.ensure_dirs() — that re-derives DATA_DIR
    # from the environment and would clobber a test/manual override; the app
    # already ensured the data dir at startup.
    config.DATA_DIR.mkdir(parents=True, exist_ok=True)
    d = backups_dir()
    d.mkdir(parents=True, exist_ok=True)
    name = _unique_name(d, datetime.now().strftime(_STAMP))
    out = d / name
    root = config.DATA_DIR
    parent = root.parent
    written = 0
    try:
        with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as zf:
            for path in sorted(root.rglob("*"), key=lambda p: p.as_posix().lower()):
                if _skip_entry(path):
                    continue
                # Extractable layout: the zip root is called "data/" so a
                # restore means unzipping over the app-data folder.
                zf.write(path, arcname=path.relative_to(parent).as_posix())
                written += 1
    except OSError:
        out.unlink(missing_ok=True)
        raise
    kept = _prune_old(d)
    return {
        "ok": True,
        "name": name,
        "path": str(out),
        "size": out.stat().st_size,
        "entries": written,
        "kept": kept,
    }


def _prune_old(d: Path) -> int:
    """Delete backups beyond ``_BACKUP_KEEP`` (oldest first). Returns count kept."""
    paths = _iter_backup_paths()
    for old in paths[: max(0, len(paths) - _BACKUP_KEEP)]:
        try:
            old.unlink()
        except OSError:
            pass
    return len(_iter_backup_paths())


def list_backups() -> list[dict]:
    """Existing backups, newest first."""
    out: list[dict] = []
    for p in _iter_backup_paths():
        try:
            created = datetime.fromtimestamp(p.stat().st_mtime).isoformat(
                timespec="seconds"
            )
            size = p.stat().st_size
        except OSError:
            created = None
            size = None
        out.append({"name": p.name, "size": size, "created": created})
    out.reverse()
    return out


def delete_backup(name: str) -> bool:
    """Delete one named backup. Returns False when it doesn't exist."""
    if not _BACKUP_NAME_RE.match(name or ""):
        return False
    path = backups_dir() / name
    try:
        path.unlink()
    except FileNotFoundError:
        return False
    except OSError:
        raise
    return True
