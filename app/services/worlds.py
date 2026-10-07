"""The library: worlds, their series, and the books (projects) inside them.

The structure lives in one manifest at the data root (``worlds.json``) so the
project folders stay flat and none of the existing document / stat / comment /
snapshot machinery has to move. A **book** is an existing project; a **series**
is just an ordered list of book ids; a **world** groups series and loose
("unsorted") books.

Reads reconcile the manifest with what is actually on disk: ids whose project is
gone are pruned, and a project that is not in any world (an import, a folder
restored by hand) is adopted by the first world — so the worst a lost or stale
manifest can do is shuffle books, never lose them. Writes take a lock and go
through ``config._write_atomic``, so a crash can never leave a half-written
manifest.
"""
from __future__ import annotations

import copy
import json
import threading
from pathlib import Path
from typing import Any

from app import config
from app.services import covers as covers_service
from app.services import projects as projects_service

# Title given to the world created when a library has books but no world yet.
DEFAULT_WORLD_TITLE = "My World"

_MANIFEST_VERSION = 1
_manifest_lock = threading.Lock()


# --- manifest storage -------------------------------------------------------


def _manifest_path() -> Path:
    return config.DATA_DIR / config.WORLDS_FILENAME


def _slugify(name: str) -> str:
    return projects_service._slugify(name)


def _unique_id(base: str, used: set[str]) -> str:
    base = base or "world"
    candidate = base
    counter = 2
    while candidate in used:
        candidate = f"{base}-{counter}"
        counter += 1
    return candidate


def _normalize_series(raw: Any) -> dict[str, Any]:
    raw = raw if isinstance(raw, dict) else {}
    books = raw.get("books")
    return {
        "id": str(raw.get("id") or ""),
        "title": str(raw.get("title") or "Series"),
        "books": [str(b) for b in books] if isinstance(books, list) else [],
    }


def _normalize_world(raw: Any) -> dict[str, Any]:
    raw = raw if isinstance(raw, dict) else {}
    series = raw.get("series")
    books = raw.get("books")
    return {
        "id": str(raw.get("id") or ""),
        "title": str(raw.get("title") or "World"),
        "cover": raw.get("cover") or None,
        "series": [_normalize_series(s) for s in series] if isinstance(series, list) else [],
        "books": [str(b) for b in books] if isinstance(books, list) else [],
    }


def _read_manifest() -> dict[str, Any]:
    try:
        data = json.loads(_manifest_path().read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        data = {}
    worlds = data.get("worlds")
    return {
        "version": _MANIFEST_VERSION,
        "worlds": [_normalize_world(w) for w in worlds] if isinstance(worlds, list) else [],
    }


def _write_manifest(manifest: dict[str, Any]) -> None:
    config.DATA_DIR.mkdir(parents=True, exist_ok=True)
    config._write_atomic(
        _manifest_path(),
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
    )


def _reconcile(manifest: dict[str, Any], existing: set[str]) -> dict[str, Any]:
    """Drop dangling book ids and adopt books that aren't in any world."""
    seen: set[str] = set()
    for world in manifest["worlds"]:
        kept = [b for b in world["books"] if b in existing and b not in seen]
        seen.update(kept)
        world["books"] = kept
        for series in world["series"]:
            kept = [b for b in series["books"] if b in existing and b not in seen]
            seen.update(kept)
            series["books"] = kept
    orphans = sorted(existing - seen)
    if orphans:
        if not manifest["worlds"]:
            manifest["worlds"].append(_new_world(DEFAULT_WORLD_TITLE, set()))
        manifest["worlds"][0]["books"].extend(orphans)
    return manifest


def _snapshot() -> tuple[dict[str, Any], dict[str, dict[str, Any]]]:
    """Load + reconcile the manifest; also return projects by id.

    Caller must hold ``_manifest_lock``. ``list_projects`` is the single source
    of the real book set and the (cached) word/document stats the cards show.
    """
    projects = {p["id"]: p for p in projects_service.list_projects()}
    manifest = _read_manifest()
    before = copy.deepcopy(manifest)
    reconciled = _reconcile(manifest, set(projects))
    if reconciled != before:
        _write_manifest(reconciled)
    return reconciled, projects


# --- lookups ----------------------------------------------------------------


def _find_world(manifest: dict[str, Any], world_id: str) -> dict[str, Any] | None:
    for world in manifest["worlds"]:
        if world["id"] == world_id:
            return world
    return None


def _find_series(world: dict[str, Any], series_id: str) -> dict[str, Any] | None:
    for series in world["series"]:
        if series["id"] == series_id:
            return series
    return None


def _detach(manifest: dict[str, Any], project_id: str) -> None:
    """Remove a book id from every world and series (it may be in two lists)."""
    for world in manifest["worlds"]:
        world["books"] = [b for b in world["books"] if b != project_id]
        for series in world["series"]:
            series["books"] = [b for b in series["books"] if b != project_id]


def _new_world(title: str, used: set[str]) -> dict[str, Any]:
    return {
        "id": _unique_id(_slugify(title), used),
        "title": title.strip() or "World",
        "cover": None,
        "series": [],
        "books": [],
    }


def _book_summary(project: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": project["id"],
        "title": project["title"],
        "words": project.get("words", 0),
        "documents": project.get("documents", 0),
        "updatedAt": project.get("updatedAt", ""),
        "cover": covers_service.url(project.get("cover")),
    }


def _books_for(ids: list[str], projects: dict[str, dict[str, Any]]) -> list[dict[str, Any]]:
    return [_book_summary(projects[i]) for i in ids if i in projects]


def _required_title(title: str, noun: str) -> str:
    clean = (title or "").strip()
    if not clean:
        raise ValueError(f"A {noun} needs a title")
    return clean


# --- reads ------------------------------------------------------------------


def list_worlds() -> list[dict[str, Any]]:
    with _manifest_lock:
        manifest, _projects = _snapshot()
    out: list[dict[str, Any]] = []
    for world in manifest["worlds"]:
        book_ids = list(world["books"])
        for series in world["series"]:
            book_ids.extend(series["books"])
        out.append(
            {
                "id": world["id"],
                "title": world["title"],
                "cover": covers_service.url(world["cover"]),
                "series": len(world["series"]),
                "books": len(book_ids),
            }
        )
    return out


def get_world(world_id: str) -> dict[str, Any]:
    with _manifest_lock:
        manifest, projects = _snapshot()
    world = _find_world(manifest, world_id)
    if world is None:
        raise FileNotFoundError(f"World '{world_id}' not found")
    return {
        "id": world["id"],
        "title": world["title"],
        "cover": covers_service.url(world["cover"]),
        "series": [
            {
                "id": series["id"],
                "title": series["title"],
                "books": _books_for(series["books"], projects),
            }
            for series in world["series"]
        ],
        "books": _books_for(world["books"], projects),
    }


# --- worlds -----------------------------------------------------------------


def create_world(title: str) -> dict[str, Any]:
    clean = _required_title(title, "world")
    with _manifest_lock:
        manifest, _projects = _snapshot()
        used = {w["id"] for w in manifest["worlds"]}
        world = _new_world(clean, used)
        manifest["worlds"].append(world)
        _write_manifest(manifest)
    return get_world(world["id"])


def rename_world(world_id: str, title: str) -> dict[str, Any]:
    clean = _required_title(title, "world")
    with _manifest_lock:
        manifest, _projects = _snapshot()
        world = _find_world(manifest, world_id)
        if world is None:
            raise FileNotFoundError(f"World '{world_id}' not found")
        world["title"] = clean
        _write_manifest(manifest)
    return get_world(world_id)


def delete_world(world_id: str) -> dict[str, Any]:
    """Remove a world's grouping. Its books stay on disk (see ``_reconcile``)."""
    with _manifest_lock:
        manifest, _projects = _snapshot()
        world = _find_world(manifest, world_id)
        if world is None:
            raise FileNotFoundError(f"World '{world_id}' not found")
        manifest["worlds"].remove(world)
        _write_manifest(manifest)
    covers_service.remove(covers_service.KIND_WORLD, world_id)
    return {"ok": True}


# --- series -----------------------------------------------------------------


def create_series(world_id: str, title: str) -> dict[str, Any]:
    clean = _required_title(title, "series")
    with _manifest_lock:
        manifest, _projects = _snapshot()
        world = _find_world(manifest, world_id)
        if world is None:
            raise FileNotFoundError(f"World '{world_id}' not found")
        used = {s["id"] for s in world["series"]} | {world["id"]}
        world["series"].append(
            {"id": _unique_id(_slugify(clean), used), "title": clean, "books": []}
        )
        _write_manifest(manifest)
    return get_world(world_id)


def rename_series(world_id: str, series_id: str, title: str) -> dict[str, Any]:
    clean = _required_title(title, "series")
    with _manifest_lock:
        manifest, _projects = _snapshot()
        world = _find_world(manifest, world_id)
        series = _find_series(world, series_id) if world else None
        if series is None:
            raise FileNotFoundError(f"Series '{series_id}' not found")
        series["title"] = clean
        _write_manifest(manifest)
    return get_world(world_id)


def delete_series(world_id: str, series_id: str) -> dict[str, Any]:
    """Remove a series' grouping; its books fall back to the world's Unsorted."""
    with _manifest_lock:
        manifest, _projects = _snapshot()
        world = _find_world(manifest, world_id)
        series = _find_series(world, series_id) if world else None
        if series is None:
            raise FileNotFoundError(f"Series '{series_id}' not found")
        world["series"].remove(series)
        world["books"].extend(series["books"])
        _write_manifest(manifest)
    return get_world(world_id)


# --- books ------------------------------------------------------------------


def add_book(world_id: str, title: str, series_id: str | None = None) -> dict[str, Any]:
    """Create a project and file it into a world (optionally inside a series)."""
    clean = _required_title(title, "book")
    with _manifest_lock:
        manifest, _projects = _snapshot()
        world = _find_world(manifest, world_id)
        if world is None:
            raise FileNotFoundError(f"World '{world_id}' not found")
        if series_id and _find_series(world, series_id) is None:
            raise FileNotFoundError(f"Series '{series_id}' not found")
    # The project is created outside the manifest lock: it only needs the
    # world to still exist, which the check above established.
    project = projects_service.create_project(clean)
    with _manifest_lock:
        manifest, _projects = _snapshot()
        world = _find_world(manifest, world_id)
        series = _find_series(world, series_id) if (world and series_id) else None
        if world is None:
            raise FileNotFoundError(f"World '{world_id}' not found")
        # Reconciliation adopts the new project into the world before we get
        # here, so detach it first and then file it exactly once.
        _detach(manifest, project["id"])
        (series["books"] if series else world["books"]).append(project["id"])
        _write_manifest(manifest)
    return get_world(world_id)


def move_book(project_id: str, world_id: str, series_id: str | None = None) -> dict[str, Any]:
    """Move a book to a world / series (or its Unsorted list)."""
    with _manifest_lock:
        manifest, projects = _snapshot()
        if project_id not in projects:
            raise FileNotFoundError(f"Book '{project_id}' not found")
        world = _find_world(manifest, world_id)
        if world is None:
            raise FileNotFoundError(f"World '{world_id}' not found")
        series = _find_series(world, series_id) if series_id else None
        if series_id and series is None:
            raise FileNotFoundError(f"Series '{series_id}' not found")
        # Detach from wherever it currently lives, then append to the target.
        _detach(manifest, project_id)
        (series["books"] if series else world["books"]).append(project_id)
        _write_manifest(manifest)
    return get_world(world_id)


# --- ordering ---------------------------------------------------------------


def _reorder(items: list[Any], ordered_ids: list[str], key: str = "id") -> list[Any]:
    by_id = {item[key]: item for item in items}
    out = [by_id[i] for i in ordered_ids if i in by_id]
    out.extend(item for item in items if item not in out)
    return out


def _reorder_ids(ids: list[str], ordered_ids: list[str]) -> list[str]:
    allowed = set(ids)
    out = [i for i in ordered_ids if i in allowed]
    out.extend(i for i in ids if i not in out)
    return out


def reorder_worlds(ordered_ids: list[str]) -> list[dict[str, Any]]:
    with _manifest_lock:
        manifest, _projects = _snapshot()
        manifest["worlds"] = _reorder(manifest["worlds"], ordered_ids)
        _write_manifest(manifest)
    return list_worlds()


def reorder_series(world_id: str, ordered_ids: list[str]) -> dict[str, Any]:
    with _manifest_lock:
        manifest, _projects = _snapshot()
        world = _find_world(manifest, world_id)
        if world is None:
            raise FileNotFoundError(f"World '{world_id}' not found")
        world["series"] = _reorder(world["series"], ordered_ids)
        _write_manifest(manifest)
    return get_world(world_id)


def reorder_books(
    world_id: str, ordered_ids: list[str], series_id: str | None = None
) -> dict[str, Any]:
    with _manifest_lock:
        manifest, _projects = _snapshot()
        world = _find_world(manifest, world_id)
        if world is None:
            raise FileNotFoundError(f"World '{world_id}' not found")
        target = _find_series(world, series_id) if series_id else world
        if target is None:
            raise FileNotFoundError(f"Series '{series_id}' not found")
        target["books"] = _reorder_ids(target["books"], ordered_ids)
        _write_manifest(manifest)
    return get_world(world_id)


# --- covers -----------------------------------------------------------------


def set_world_cover(world_id: str, raw: bytes) -> dict[str, Any]:
    with _manifest_lock:
        manifest, _projects = _snapshot()
        if _find_world(manifest, world_id) is None:
            raise FileNotFoundError(f"World '{world_id}' not found")
    filename = covers_service.save(covers_service.KIND_WORLD, world_id, raw)
    with _manifest_lock:
        manifest, _projects = _snapshot()
        world = _find_world(manifest, world_id)
        if world is None:  # deleted while the bytes were being written
            covers_service.remove(covers_service.KIND_WORLD, world_id)
            raise FileNotFoundError(f"World '{world_id}' not found")
        world["cover"] = filename
        _write_manifest(manifest)
    return get_world(world_id)


def clear_world_cover(world_id: str) -> dict[str, Any]:
    with _manifest_lock:
        manifest, _projects = _snapshot()
        world = _find_world(manifest, world_id)
        if world is None:
            raise FileNotFoundError(f"World '{world_id}' not found")
        world["cover"] = None
        _write_manifest(manifest)
    covers_service.remove(covers_service.KIND_WORLD, world_id)
    return get_world(world_id)
