"""Documents and folders.

A project is a free-form tree on disk:
- every directory is a *folder* (except reserved names),
- every ``.md`` file is a *document* (chapter or note, from frontmatter
  ``type``), and documents can live at the project root too.

Document ids are relative paths without the ``.md`` extension, e.g.
``Part One/01-first``. Folder ids are relative directory paths, e.g.
``Part One`` or ``Part One/Scenes`` (``""`` means the project root).
Within a folder, documents are ordered by a numeric ``NN-`` filename prefix.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import threading
import time
from collections import defaultdict
from datetime import datetime
from pathlib import Path
from typing import Any

import yaml

from app import config

_SAFE_ID_RE = re.compile(r"^[^\\\x00-\x1f]+$")
_FRONTMATTER_RE = re.compile(r"^---\s*\n(.*?)\n---\s*\n?", re.DOTALL)
_FRONTMATTER_KEY_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_-]*$")
_CJK_RE = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff]")
_WORD_RE = re.compile(r"\S+")
_HTML_TAG_RE = re.compile(r"<[^>]+>")
_PREFIX_RE = re.compile(r"^(\d+)-")
_history_lock = threading.Lock()

# history.jsonl grows one line per save; once a project's log is over this
# size it is compacted into one summed line per day (all days are kept, so
# the full writing history survives; only per-save detail is lost).
# ~60 bytes/line means the threshold is already well past the "4000 lines"
# mark, so size alone is the trigger.
_COMPACT_SIZE_BYTES = 384 * 1024

# ``_renumber`` stages entries in ``<dir>/.reorder-tmp`` for milliseconds; if
# the app dies mid-renumber they can sit there indefinitely (hidden from the
# tree/export/stats). A leftover folder older than this is treated as a crash
# artifact and its contents are moved back on startup.
_REORDER_RECOVERY_MIN_AGE_S = 300

# Wikilink rewrite pattern: ``[[target]]`` / ``[[target|alias]]`` — the same
# shape the resolver in app/services/wiki.py parses, kept here because
# documents.py cannot import wiki.py without a cycle.
_LINK_REWRITE_RE = re.compile(r"(\[\[)([^\]|]+)(\|[^\]]*)?(\]\])")


def recover_reorder_tmp() -> int:
    """Move any entries still staged in a stale ``.reorder-tmp`` folder back
    into their parent directory (crash recovery for interrupted renumbers).

    Scans every project tree for ``.reorder-tmp`` directories older than
    ``_REORDER_RECOVERY_MIN_AGE_S`` (a live renumber finishes in seconds, so
    younger ones are left alone — a renumber may still be in flight). Returns
    the number of entries restored. Best-effort, never raises.
    """
    restored = 0
    try:
        projects = [p for p in config.DATA_DIR.iterdir() if p.is_dir()]
    except OSError:
        return 0
    for project in projects:
        for dirpath, dirnames, _filenames in os.walk(project):
            dirnames[:] = [d for d in dirnames if not d.startswith(".")]
            tmp = Path(dirpath) / config.REORDER_TMP_DIRNAME
            try:
                if not tmp.is_dir():
                    continue
                if time.time() - tmp.stat().st_mtime < _REORDER_RECOVERY_MIN_AGE_S:
                    continue
            except OSError:
                continue
            for child in list(tmp.iterdir()):
                try:
                    target = _ensure_unique(tmp.parent, tmp.parent / child.name)
                    shutil.move(str(child), str(target))
                    restored += 1
                except OSError:
                    continue
            try:
                shutil.rmtree(tmp, ignore_errors=True)
            except OSError:
                pass
    return restored
_save_locks: dict[str, threading.Lock] = {}
_save_locks_guard = threading.Lock()
# {(project_id, mode): {total_words: int, doc_count: int, docs: {doc_id: int}}}
_word_stats_cache: dict[tuple[str, str], dict[str, Any]] = {}
_word_stats_cache_lock = threading.Lock()


def _invalidate_word_stats(project_id: str) -> None:
    with _word_stats_cache_lock:
        keys = [k for k in _word_stats_cache if k[0] == project_id]
        for k in keys:
            del _word_stats_cache[k]


def _word_stats_update(
    project_id: str, mode: str, doc_id: str, old_words: int, new_words: int
) -> None:
    key = (project_id, mode)
    with _word_stats_cache_lock:
        entry = _word_stats_cache.get(key)
        if entry is None:
            return
        prev = entry["docs"].get(doc_id, 0)
        entry["docs"][doc_id] = new_words
        entry["total_words"] += new_words - prev
        if prev == 0 and new_words > 0:
            entry["doc_count"] += 1


def _word_stats_remove_doc(project_id: str, mode: str, doc_id: str) -> None:
    key = (project_id, mode)
    with _word_stats_cache_lock:
        entry = _word_stats_cache.get(key)
        if entry is None:
            return
        prev = entry["docs"].pop(doc_id, 0)
        if prev > 0:
            entry["total_words"] -= prev
            entry["doc_count"] -= 1


def _save_lock_for(doc_path: Path) -> threading.Lock:
    key = str(doc_path.resolve())
    with _save_locks_guard:
        lock = _save_locks.get(key)
        if lock is None:
            lock = _save_locks[key] = threading.Lock()
        return lock


class DocumentError(ValueError):
    pass


def _slugify(title: str) -> str:
    slug = re.sub(r"[^A-Za-z0-9]+", "-", title).strip("-").lower()
    return slug or "untitled"


def _now() -> str:
    return datetime.now().isoformat(timespec="seconds")


def count_words(text: str, mode: str = "auto") -> int:
    """Count words in a body of text.

    ``mode`` is one of "auto", "words", "chars". In auto mode, whitespace-
    separated words plus CJK characters are counted, so both English prose
    and CJK (Chinese/Japanese/Korean) text produce sensible counts. Inline
    HTML (e.g. ``<span style="...">`` styling) is stripped before counting.
    """
    text = _HTML_TAG_RE.sub(" ", text)
    if mode == "chars":
        return len(re.sub(r"\s+", "", text))
    words = len(_WORD_RE.findall(text))
    if mode == "words":
        return words
    return words + len(_CJK_RE.findall(text))


def parse_frontmatter(text: str) -> tuple[dict[str, Any], str]:
    m = _FRONTMATTER_RE.match(text)
    if m:
        block = m.group(1)
        try:
            meta = yaml.safe_load(block)
        except yaml.YAMLError:
            meta = None
        if not isinstance(meta, dict):
            # Strict YAML failed or the block isn't a mapping — try a lenient
            # recovery so legacy files (written before values were quoted)
            # still expose their metadata instead of silently dropping it.
            meta = _parse_frontmatter_lenient(block)
        body = text[m.end():]
        return meta, body
    return {}, text


def _parse_frontmatter_lenient(block: str) -> dict[str, Any]:
    """Best-effort recovery for a frontmatter block that failed strict YAML.

    Old files can contain unquoted values that are invalid YAML, most
    commonly a value with ``: `` (e.g. ``title: Part 1: The Beginning``).
    Each line is split on the first ``: `` and the remainder is kept as a
    raw string, so titles and other metadata survive until the file is next
    rewritten (the writer quotes values, fixing the block for good).
    """
    meta: dict[str, Any] = {}
    for line in block.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        key, sep, value = stripped.partition(":")
        if not sep:
            continue
        key = key.strip()
        value = value.strip()
        if not _FRONTMATTER_KEY_RE.match(key) or key in meta:
            continue
        meta[key] = value
    return meta


def build_frontmatter(meta: dict[str, Any]) -> str:
    """Serialize document metadata as YAML frontmatter.

    Values are emitted through ``yaml.safe_dump`` so titles and other
    metadata containing YAML-significant characters (``: `` inside the value,
    a leading ``#``, quotes, …) round-trip cleanly instead of corrupting the
    frontmatter block. Simple values keep their existing unquoted form, so
    already-valid files are rewritten byte-identically.
    """
    if not meta:
        return ""
    body = yaml.safe_dump(
        meta,
        allow_unicode=True,
        sort_keys=False,
        default_flow_style=False,
        width=10**9,  # never wrap long plain scalars
    )
    return f"---\n{body}---\n\n"


def _headings(body: str) -> list[str]:
    result = []
    for line in body.splitlines():
        m = _HEADING_RE.match(line)
        if m:
            result.append(m.group(1).strip())
            continue
        h = _HTML_HEADING_RE.match(line)
        if h:
            result.append(re.sub(r"<[^>]+>", "", h.group(2)).strip())
    return result


_HEADING_RE = re.compile(r"^#{1,6}\s+(.*)$")
_HTML_HEADING_RE = re.compile(r"^<h([1-6])(?:\s[^>]*)?>(.*?)</h\1>$", re.IGNORECASE)


def _style_from_meta(meta: dict[str, Any]) -> dict[str, Any]:
    def to_int(value: Any, default: int | None) -> int | None:
        try:
            return int(value)
        except (TypeError, ValueError):
            return default

    sections: dict[str, Any] = {}
    raw = meta.get("styles")
    if isinstance(raw, dict):
        # Legacy files stored styles as an unquoted YAML mapping
        # (``styles: {"Appearance": {...}}``); newer files carry a JSON string.
        parsed = raw
    else:
        parsed = None
        if isinstance(raw, str) and raw.strip():
            try:
                parsed = json.loads(raw)
            except json.JSONDecodeError:
                parsed = None
    if isinstance(parsed, dict):
        for key, value in parsed.items():
                if not isinstance(value, dict):
                    continue
                section: dict[str, Any] = {}
                if value.get("font"):
                    section["font"] = str(value["font"])
                size = to_int(value.get("size"), None)
                if size is not None:
                    section["size"] = size
                if value.get("align"):
                    section["align"] = str(value["align"])
                if section:
                    sections[str(key)] = section
    return {
        "font": str(meta["font"]) if meta.get("font") else None,
        "size": to_int(meta.get("size"), None),
        "align": str(meta["align"]) if meta.get("align") else None,
        "zoom": to_int(meta.get("zoom"), None),
        "sections": sections,
    }


def _project_folder(project_id: str) -> Path:
    if not config.is_safe_project_id(project_id):
        raise FileNotFoundError(f"Project '{project_id}' not found")
    folder = config.DATA_DIR / project_id
    if not (folder / config.PROJECT_META_FILENAME).exists():
        raise FileNotFoundError(f"Project '{project_id}' not found")
    return folder


def _validate_id(doc_id: str) -> str:
    doc_id = doc_id.replace("\\", "/")
    if not isinstance(doc_id, str) or not _SAFE_ID_RE.match(doc_id):
        raise DocumentError("Invalid id")
    return doc_id


def _doc_path(folder: Path, doc_id: str) -> Path:
    doc_id = _validate_id(doc_id)
    relative = doc_id if doc_id.lower().endswith(".md") else doc_id + ".md"
    base = folder.resolve()
    path = (folder / relative).resolve()
    if not path.is_relative_to(base):
        raise DocumentError("Invalid document path")
    return path


def _folder_path(folder: Path, folder_id: str | None, create: bool = False) -> Path:
    folder_id = (folder_id or "").strip().strip("/")
    if not folder_id:
        return folder
    _validate_id(folder_id)
    base = folder.resolve()
    path = (folder / folder_id).resolve()
    if not path.is_relative_to(base):
        raise DocumentError("Invalid folder path")
    if create:
        path.mkdir(parents=True, exist_ok=True)
    elif not path.is_dir():
        raise FileNotFoundError(f"Folder '{folder_id}' not found")
    return path


def _default_meta(doc_id: str) -> dict[str, Any]:
    name = doc_id.split("/")[-1]
    name = re.sub(r"^\d+-", "", name).replace("-", " ").strip().title()
    return {"title": name or "Untitled"}


def _sort_key(name: str) -> tuple:
    m = _PREFIX_RE.match(name)
    if m:
        return (0, int(m.group(1)), name.lower())
    return (1, 0, name.lower())


def _display_name(name: str) -> str:
    """Strip the numeric order prefix (``NN-``) from a file/folder name."""
    return re.sub(r"^\d+-", "", name)


def _entry_id(path: Path, project_folder: Path) -> str:
    """Id of any entry (folder or document) relative to the project."""
    rel = path.relative_to(project_folder).as_posix()
    return rel[: -len(".md")] if path.is_file() and rel.lower().endswith(".md") else rel


def _is_orderable_entry(path: Path, project_folder: Path) -> bool:
    """Whether an entry participates in ordering (mirrors ``_children``)."""
    name = path.name
    if path.is_dir():
        if name.startswith(".") or name.lower() in (
            config.STATS_DIRNAME,
            config.TEMPLATES_DIRNAME,
            config.ASSETS_DIRNAME,
        ):
            return False
        return not (path.parent == project_folder and name.lower() == config.WIKI_DIRNAME)
    return path.is_file() and path.suffix.lower() == ".md" and not name.startswith(".")


def _md_files(folder: Path) -> list[Path]:
    if not folder.is_dir():
        return []
    return sorted(
        (p for p in folder.iterdir() if p.is_file() and p.suffix == ".md"),
        key=lambda p: _sort_key(p.name),
    )


def _md_files_recursive(folder: Path) -> list[Path]:
    return sorted(folder.rglob("*.md"), key=lambda p: p.as_posix().lower())


def _doc_kind(raw: str) -> str:
    meta, _ = parse_frontmatter(raw)
    kind = str(meta.get("type", "")).lower()
    return kind if kind in ("chapter", "note") else "note"


def _doc_summary(folder: Path, doc_id: str, mode: str = "auto") -> dict[str, Any]:
    path = _doc_path(folder, doc_id)
    if not path.exists():
        raise FileNotFoundError(f"Document '{doc_id}' not found")
    raw = path.read_text(encoding="utf-8")
    meta, body = parse_frontmatter(raw)
    merged = dict(_default_meta(doc_id))
    merged.update(meta)
    stat = path.stat()
    return {
        "id": doc_id,
        "title": str(merged.get("title", "")),
        "type": str(merged.get("type", "")),
        "kind": _doc_kind(raw),
        "words": count_words(body, mode),
        "updatedAt": datetime.fromtimestamp(stat.st_mtime).isoformat(timespec="seconds"),
    }


def _children(
    folder: Path,
    project_folder: Path,
    mode: str,
    exclude_wiki: bool = False,
) -> dict[str, Any]:
    """Build a recursive tree node for ``folder`` (name/id are omitted at root).

    ``entries`` records the full display order of folders and documents mixed
    together (both kinds are ordered by the ``NN-`` prefix).
    """
    folders: list[dict[str, Any]] = []
    documents: list[dict[str, Any]] = []
    entries: list[dict[str, Any]] = []
    for child in sorted(folder.iterdir(), key=lambda p: _sort_key(p.name)):
        name = child.name
        if child.is_dir():
            if (
                name.startswith(".")
                or name == config.STATS_DIRNAME
                or name == config.TEMPLATES_DIRNAME
                # The image store is internal: it must never appear as a folder
                # in the Write, Wiki or "all" tree.
                or name.lower() == config.ASSETS_DIRNAME
            ):
                continue
            if exclude_wiki and name.lower() == config.WIKI_DIRNAME:
                continue
            sub = _children(child, project_folder, mode, exclude_wiki)
            node = {
                "name": _display_name(name),
                "id": _entry_id(child, project_folder),
                **sub,
            }
            folders.append(node)
            entries.append({"kind": "folder", "id": node["id"]})
        elif child.suffix.lower() == ".md" and not name.startswith("."):
            doc_id = _entry_id(child, project_folder)
            doc = _doc_summary(project_folder, doc_id, mode)
            documents.append(doc)
            entries.append({"kind": "doc", "id": doc_id})
    return {"folders": folders, "documents": documents, "entries": entries}


def get_tree(
    project_id: str,
    mode: str = "auto",
    scope: str = "write",
) -> dict[str, Any]:
    folder = _project_folder(project_id)
    _migrate_legacy(project_id)
    _migrate_folder_order(project_id)
    if scope == "wiki":
        wiki_dir = folder / config.WIKI_DIRNAME
        if not wiki_dir.is_dir():
            return {"folders": [], "documents": []}
        return _children(wiki_dir, folder, mode)
    if scope == "all":
        return _children(folder, folder, mode)
    return _children(folder, folder, mode, exclude_wiki=True)


def iter_documents(
    project_id: str,
    folders: list[str] | None = None,
    documents: list[str] | None = None,
) -> list[dict[str, Any]]:
    """Selected documents with their parsed bodies, in on-disk order.

    Used by the analysis tools (not the tree). Selection is ``(folders,
    documents)``:

    - both ``None`` -> the whole project, wiki entries included;
    - otherwise a document is included when its id is in ``documents``, when
      any of its ancestor folders is in ``folders``, or when ``"."`` is in
      ``folders`` and it sits at the project root.

    Ids use the same form as the tree (``Part One/01-scene``), so a selection
    taken straight from ``get_tree`` works unchanged. Hidden files and the
    ``.reorder-tmp`` staging area are skipped.
    """
    project = _project_folder(project_id)
    select_all = folders is None and documents is None
    selected_folders = {
        f.strip().strip("/").replace("\\", "/") for f in (folders or []) if f.strip() and f.strip() != "."
    }
    include_root = any(f.strip() == "." for f in (folders or []))
    selected_docs = {d.strip().replace("\\", "/") for d in (documents or []) if d.strip()}

    results: list[dict[str, Any]] = []
    for path in _md_files_recursive(project):
        rel = path.relative_to(project)
        if config.REORDER_TMP_DIRNAME in rel.parts or rel.name.startswith("."):
            continue
        doc_id = _entry_id(path, project)
        parents = list(rel.parent.parts) if rel.parent != Path(".") else []
        if not select_all:
            chosen = doc_id in selected_docs
            if not chosen and parents:
                chosen = any("/".join(parents[:i]) in selected_folders for i in range(1, len(parents) + 1))
            if not chosen and include_root and not parents:
                chosen = True
            if not chosen:
                continue
        raw = path.read_text(encoding="utf-8", errors="replace")
        meta, body = parse_frontmatter(raw)
        title = meta.get("title")
        if title is None:
            title = _display_name(path.stem).replace("-", " ").title()
        results.append(
            {
                "id": doc_id,
                "title": str(title),
                "kind": _doc_kind(raw),
                "folder": "/".join(_display_name(p) for p in parents),
                "body": body,
            }
        )
    return results


def _migrate_legacy(project_id: str) -> None:
    """One-time migration from the old fixed layout.

    ``chapters/*.md`` moves to the project root. The legacy ``worldbuilding``
    directory is left in place; it is now the wiki root and is excluded from
    the write tree.
    """
    project_folder = _project_folder(project_id)
    legacy_chapters = project_folder / "chapters"

    if legacy_chapters.is_dir():
        for path in _md_files(legacy_chapters):
            target = _ensure_unique(project_folder, project_folder / path.name)
            shutil.move(str(path), str(target))
        _prune_empty(legacy_chapters, project_folder)


def _migrate_folder_order(project_id: str) -> None:
    """One-time migration to unified folder/document ordering.

    Folders used to carry no ``NN-`` prefix and were always shown grouped
    before the documents. This migration densely renumbers every directory
    that contains an unprefixed folder or document, preserving the current
    visible order, so folders and documents can then be interleaved. The wiki
    root (``worldbuilding``) keeps its literal name; the app relies on it
    (folders *inside* the wiki are still migrated).
    """
    project_folder = _project_folder(project_id)

    def _walkable(directory: Path) -> bool:
        name = directory.name
        return (
            directory.is_dir()
            and not name.startswith(".")
            and name not in (config.STATS_DIRNAME, config.TEMPLATES_DIRNAME)
            and name.lower() != config.ASSETS_DIRNAME
        )

    def _needs_rename(directory: Path) -> bool:
        for child in directory.iterdir():
            if not _is_orderable_entry(child, project_folder):
                continue
            if not _PREFIX_RE.match(child.name):
                return True
        return False

    def _visit(directory: Path) -> None:
        if _needs_rename(directory):
            ordered = [
                _entry_id(p, project_folder)
                for p in sorted(
                    (p for p in directory.iterdir() if _is_orderable_entry(p, project_folder)),
                    key=lambda p: (p.is_file(), _sort_key(p.name)),
                )
            ]
            _renumber(directory, project_folder, ordered)
        for child in sorted(directory.iterdir()):
            if _walkable(child):
                _visit(child)

    _visit(project_folder)


# The zoom percentage is a *reading* size now: 100% renders at CSS
# ``zoom: 2``, the size the old numbering called 200%. Stored values are
# halved exactly once so every existing document keeps the size it had.
# The marker that records this is a *file*, not a settings key: settings.json
# is rewritten from an in-process cache by whichever instance is running, so a
# key there can be dropped by a stale writer — which would let the rebase run
# a second time and halve every document again.
ZOOM_SCALE = 2
ZOOM_MARKER = ".zoom-rebased"


def _rebased_zoom(value: Any) -> int | None:
    """``value`` halved onto the new zoom baseline, or ``None`` if unusable."""
    try:
        current = int(value)
    except (TypeError, ValueError):
        return None
    return max(1, round(current / ZOOM_SCALE)) if current > 0 else None


def rebase_zoom_scale() -> int:
    """One-time halving of every stored editor zoom value.

    An editor percentage used to be a raw CSS factor (200% meant ``zoom: 2``);
    it is a reading size now, so the comfortable size the user picked is 100
    and everything already stored has to be halved to keep looking the same.
    ``editorZoom`` in settings.json and the flat ``zoom`` key in each
    document's frontmatter are rebased; document bodies are never touched, and
    a document without a ``zoom`` key is not written at all. Returns the number
    of documents rewritten.

    Idempotent: the ``.zoom-rebased`` marker is written last, so an
    interrupted pass is retried on the next launch rather than silently left
    half-done.
    """
    marker = config.DATA_DIR / ZOOM_MARKER
    if marker.exists():
        return 0  # already rebased

    changed = _rebase_document_zooms()
    _rebase_global_zoom()
    marker.write_text("rebased\n", encoding="utf-8")
    return changed


def _rebase_global_zoom() -> bool:
    """Halve ``editorZoom`` in settings.json, preserving every other key."""
    path = config.get_settings_path()
    if not path.exists():
        return False
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return False
    if not isinstance(raw, dict):
        return False
    zoom = _rebased_zoom(raw.get("editorZoom"))
    if zoom is None:
        return False
    raw["editorZoom"] = zoom
    # Written directly rather than through config.save_settings(), which would
    # materialise every default into the file.
    config._write_atomic(path, json.dumps(raw, ensure_ascii=False, indent=2))
    return True


def _rebase_document_zooms() -> int:
    """Halve the frontmatter ``zoom`` of every document in every project."""
    changed = 0
    try:
        projects = sorted(config.DATA_DIR.iterdir())
    except OSError:
        return 0
    for project in projects:
        if not project.is_dir() or project.name.startswith("."):
            continue
        if not (project / config.PROJECT_META_FILENAME).exists():
            continue  # not a project (ai-sessions, stats, a stray folder)
        for path in _md_files_recursive(project):
            if any(part.startswith(".") for part in path.relative_to(project).parts):
                continue  # crash-staging and other hidden folders
            try:
                text = path.read_text(encoding="utf-8")
            except OSError:
                continue
            meta, body = parse_frontmatter(text)
            zoom = _rebased_zoom(meta.get("zoom"))
            if zoom is None or zoom == meta.get("zoom"):
                continue
            meta["zoom"] = zoom
            config._write_atomic(path, build_frontmatter(meta) + body)
            changed += 1
    return changed


def get_document(project_id: str, doc_id: str, mode: str = "auto") -> dict[str, Any]:
    folder = _project_folder(project_id)
    path = _doc_path(folder, doc_id)
    if not path.exists():
        raise FileNotFoundError(f"Document '{doc_id}' not found")
    raw = path.read_text(encoding="utf-8")
    meta, body = parse_frontmatter(raw)
    merged = dict(_default_meta(doc_id))
    merged.update(meta)
    stat = path.stat()
    return {
        "id": doc_id,
        "title": str(merged.get("title", "")),
        "type": str(merged.get("type", "")),
        "kind": _doc_kind(raw),
        "tags": merged.get("tags", []),
        "content": body,
        "style": _style_from_meta(meta),
        "words": count_words(body, mode),
        "updatedAt": datetime.fromtimestamp(stat.st_mtime).isoformat(timespec="seconds"),
    }


def _ensure_unique(folder: Path, target: Path) -> Path:
    if not target.exists():
        return target
    stem, suffix = target.stem, target.suffix
    counter = 2
    while True:
        candidate = target.with_name(f"{stem}-{counter}{suffix}")
        if not candidate.exists():
            return candidate
        counter += 1


# --- wikilink rewriting on structural changes ------------------------------
#
# Document ids are paths, so reorders, moves, and folder renames change ids.
# Links written as ``[[folder/doc]]`` (path form) would silently break when
# that happens; app-inserted links use titles, which survive moves/reorders
# but not document renames. These helpers patch document bodies accordingly.


def _project_doc_map(project_folder: Path) -> dict[str, Path]:
    """Map document id -> path for every document in the project tree."""
    mapping: dict[str, Path] = {}
    for path in _md_files_recursive(project_folder):
        if config.REORDER_TMP_DIRNAME in path.parts or path.name.startswith("."):
            continue
        mapping[_entry_id(path, project_folder)] = path
    return mapping


def _expand_folder_maps(
    before: dict[str, Path],
    id_map: dict[str, str],
) -> dict[str, str]:
    """Expand folder-level old->new id pairs to every document inside them.

    Renumbers/moves re-id only top-level *entries*; documents nested inside a
    folder whose id changed change id too (their folder segment changed), even
    though the app only reports the folder's own new id. ``before`` is a
    pre-change snapshot of all document ids/paths.
    """
    expanded = dict(id_map)
    for old, new in id_map.items():
        prefix = f"{old}/"
        for doc_id in before:
            if doc_id.startswith(prefix):
                new_id = f"{new}/{doc_id[len(prefix):]}"
                if new_id != doc_id:
                    expanded[doc_id] = new_id
    return expanded


def _link_lookup(id_map: dict[str, str]) -> dict[str, str]:
    """Case-insensitive target lookup, tolerating a trailing ``.md``."""
    lookup: dict[str, str] = {}
    for old, new in id_map.items():
        lookup[old.lower()] = new
        lookup[f"{old}.md".lower()] = new
    return lookup


def _normalize_link_target(target: str) -> str:
    return " ".join(target.strip().split()).lower()


def rewrite_wikilink_ids(project_id: str, id_map: dict[str, str]) -> int:
    """Rewrite path-form ``[[...]]`` targets across the project to new ids.

    Any target matching an old id (case-insensitive, with an optional trailing
    ``.md``) is replaced; title-form links and aliases are untouched. Returns
    the number of files rewritten. Runs while holding each document's save
    lock so it never clobbers a concurrent autosave.
    """
    if not id_map:
        return 0
    lookup = _link_lookup(id_map)
    folder = _project_folder(project_id)
    rewritten = 0
    for path in _md_files_recursive(folder):
        if config.REORDER_TMP_DIRNAME in path.parts or path.name.startswith("."):
            continue
        with _save_lock_for(path):
            raw = path.read_text(encoding="utf-8")

            def _sub(match: re.Match[str]) -> str:
                new_target = lookup.get(match.group(2).strip().lower())
                if new_target is None:
                    return match.group(0)
                return f"{match.group(1)}{new_target}{match.group(3) or ''}{match.group(4)}"

            updated = _LINK_REWRITE_RE.sub(_sub, raw)
            if updated != raw:
                config._write_atomic(path, updated)
                rewritten += 1
    return rewritten


def rewrite_wikilink_titles(project_id: str, old_title: str, new_title: str) -> int:
    """Rewrite title-form ``[[...]]`` links after a document rename.

    Resolution falls back to document titles (case-insensitive), so renaming a
    document breaks links that point at it by title; those are rewritten to
    the new title. Path-form links are unaffected (the path didn't change).
    Returns the number of files rewritten.
    """
    old_norm = _normalize_link_target(old_title)
    new_title = (new_title or "").strip()
    if not old_norm or not new_title or old_norm == _normalize_link_target(new_title):
        return 0
    folder = _project_folder(project_id)
    rewritten = 0
    for path in _md_files_recursive(folder):
        if config.REORDER_TMP_DIRNAME in path.parts or path.name.startswith("."):
            continue
        with _save_lock_for(path):
            raw = path.read_text(encoding="utf-8")

            def _sub(match: re.Match[str]) -> str:
                if _normalize_link_target(match.group(2)) != old_norm:
                    return match.group(0)
                return f"{match.group(1)}{new_title}{match.group(3) or ''}{match.group(4)}"

            updated = _LINK_REWRITE_RE.sub(_sub, raw)
            if updated != raw:
                config._write_atomic(path, updated)
                rewritten += 1
    return rewritten


def _compact_history(path: Path) -> bool:
    """Rewrite *path* (a project's ``history.jsonl``) as one summed line per
    day, retaining **every** day that appears in the log.

    The daily-total shape is exactly what :func:`app.services.stats.get_stats`
    derives, so compaction loses only per-save detail (doc id, timestamp) —
    never a day's total. Older days are preserved so the full writing history
    stays visible. Returns True when a rewrite happened. Best-effort: any
    read/parse/write failure leaves the file untouched.
    """
    try:
        raw = path.read_text(encoding="utf-8")
    except OSError:
        return False
    if not raw:
        return False
    totals: dict[str, int] = defaultdict(int)
    for line in raw.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            entry = json.loads(line)
        except json.JSONDecodeError:
            continue
        day = entry.get("date")
        if not isinstance(day, str):
            continue
        try:
            totals[day] += int(entry.get("delta", 0))
        except (TypeError, ValueError):
            continue
    if not totals:
        return False
    out = "".join(
        json.dumps({"date": day, "delta": totals[day]}, ensure_ascii=False) + "\n"
        for day in sorted(totals)
    )
    try:
        config._write_atomic(path, out)
    except OSError:
        return False
    return True


def _maybe_compact_history(path: Path) -> bool:
    """Compact *path* when it has grown past the threshold; False otherwise."""
    try:
        if not path.is_file() or path.stat().st_size <= _COMPACT_SIZE_BYTES:
            return False
    except OSError:
        return False
    return _compact_history(path)


def compact_overgrown_histories() -> int:
    """One-time startup pass: compact every project history over threshold.

    Runs on each launch so existing large logs (e.g. from before compaction
    existed) shrink on the first boot after an upgrade. Returns the number of
    files rewritten. Best-effort — never raises.
    """
    rewritten = 0
    try:
        projects = [p for p in config.DATA_DIR.iterdir() if p.is_dir()]
    except OSError:
        return 0
    for folder in projects:
        history = folder / config.STATS_DIRNAME / config.HISTORY_FILENAME
        if not history.is_file():
            continue
        with _history_lock:
            if _maybe_compact_history(history):
                rewritten += 1
    return rewritten


def _record_save(project_id: str, doc_id: str, delta: int) -> None:
    folder = _project_folder(project_id)
    history = folder / config.STATS_DIRNAME / config.HISTORY_FILENAME
    if not history.parent.exists():
        history.parent.mkdir(parents=True, exist_ok=True)
    entry = {
        "date": datetime.now().strftime("%Y-%m-%d"),
        "doc": doc_id,
        "delta": delta,
        "at": _now(),
    }
    with _history_lock:
        with history.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(entry, ensure_ascii=False) + "\n")
        # Keep the log bounded: once it crosses the threshold, fold it into
        # the compact per-day form while we hold the lock (never fails a save).
        _maybe_compact_history(history)


def _next_index(directory: Path) -> int:
    max_index = 0
    for child in directory.iterdir():
        m = _PREFIX_RE.match(child.name)
        if m:
            max_index = max(max_index, int(m.group(1)))
    return max_index + 1


def _validate_folder_name(name: str) -> str:
    name = (name or "").strip().strip("/")
    if not name or name in (".", ".."):
        raise DocumentError("Invalid folder name")
    if (
        name in config.RESERVED_FOLDER_NAMES
        # Case-insensitively too: Windows filesystems are case-insensitive, so
        # "Assets" and "assets" are the same directory.
        or name.lower() in {reserved.lower() for reserved in config.RESERVED_FOLDER_NAMES}
        or name.lower() == config.WIKI_DIRNAME
        or name.startswith(".")
    ):
        raise DocumentError(f"'{name}' is a reserved folder name")
    return name


def create_document(
    project_id: str,
    title: str,
    kind: str = "note",
    folder: str | None = None,
    mode: str = "auto",
    content: str | None = None,
    doc_type: str | None = None,
) -> dict[str, Any]:
    project_folder = _project_folder(project_id)
    target_dir = _folder_path(project_folder, folder or "", create=True)

    next_index = _next_index(target_dir)
    slug = _slugify(title)
    target = _ensure_unique(target_dir, target_dir / f"{next_index:02d}-{slug}.md")
    doc_kind = kind if kind in ("chapter", "note") else "note"
    body = content or ""
    config._write_atomic(
        target,
        build_frontmatter(
            {
                "title": title.strip() or slug,
                "type": doc_type or doc_kind,
            }
        )
        + body,
    )
    doc_id = target.relative_to(project_folder).as_posix()[: -len(".md")]
    _record_save(project_id, doc_id, 0)
    _invalidate_word_stats(project_id)
    return get_document(project_id, doc_id, mode)


def create_folder(
    project_id: str, name: str, parent: str | None = None
) -> str:
    project_folder = _project_folder(project_id)
    parent_dir = _folder_path(project_folder, parent or "", create=True)
    name = _validate_folder_name(_display_name(name))
    next_index = _next_index(parent_dir)
    target = _ensure_unique(parent_dir, parent_dir / f"{next_index:02d}-{name}")
    target.mkdir()
    return _entry_id(target, project_folder)


def move_folder(
    project_id: str,
    folder_id: str,
    target_folder: str | None = None,
    index: int | None = None,
) -> str:
    """Move a folder (with all its contents) into another folder.

    ``target_folder`` is the destination folder id (``""`` moves to the
    project root). ``index`` positions the folder within the destination's
    unified order (``None`` appends at the end). The destination is densely
    renumbered afterwards. Returns the folder's new id. Moving a folder into
    itself, one of its own subfolders, the project root, or the wiki root is
    refused.
    """
    new_id, _ = _move_folder_impl(project_id, folder_id, target_folder, index)
    return new_id


def _move_folder_impl(
    project_id: str,
    folder_id: str,
    target_folder: str | None,
    index: int | None,
) -> tuple[str, dict[str, str]]:
    project_folder = _project_folder(project_id)
    path = _folder_path(project_folder, folder_id)
    if path == project_folder:
        raise DocumentError("Cannot move the project root")
    if path.parent == project_folder and path.name.lower() == config.WIKI_DIRNAME:
        raise DocumentError("Cannot move the wiki root")

    target_dir = _folder_path(project_folder, target_folder or "")
    if path.parent == target_dir:
        if index is None:
            return _entry_id(path, project_folder), {}
        before = _project_doc_map(project_folder)
        entries = _ordered_entry_ids(target_dir, project_folder)
        entries.remove(folder_id)
        index = min(index, len(entries))
        entries.insert(index, folder_id)
        renamed = _renumber(target_dir, project_folder, entries)
        id_map = _expand_folder_maps(before, renamed)
        rewrite_wikilink_ids(project_id, id_map)
        return renamed.get(folder_id, folder_id), renamed
    if target_dir == path or target_dir.is_relative_to(path):
        raise DocumentError("Cannot move a folder into itself or one of its subfolders")
    new_path = target_dir / path.name
    if new_path.exists():
        raise DocumentError(f"Folder '{path.name}' already exists in the destination")

    before = _project_doc_map(project_folder)
    old_folder_id = _entry_id(path, project_folder)
    path.rename(new_path)
    moved_id = _entry_id(new_path, project_folder)
    entries = _ordered_entry_ids(target_dir, project_folder)
    entries.remove(moved_id)
    index = len(entries) if index is None else min(index, len(entries))
    entries.insert(index, moved_id)
    renamed = _renumber(target_dir, project_folder, entries)
    new_id = renamed.get(moved_id, moved_id)

    id_map = _expand_folder_maps(before, renamed)
    old_prefix = f"{old_folder_id}/"
    for doc_id in before:
        if doc_id.startswith(old_prefix):
            new_doc_id = f"{new_id}/{doc_id[len(old_prefix):]}"
            if new_doc_id != doc_id:
                id_map[doc_id] = new_doc_id
    rewrite_wikilink_ids(project_id, id_map)
    return new_id, renamed


def rename_folder(project_id: str, folder_id: str, new_name: str) -> str:
    project_folder = _project_folder(project_id)
    path = _folder_path(project_folder, folder_id)
    if path == project_folder:
        raise DocumentError("Cannot rename the project root")
    new_name = _validate_folder_name(_display_name(new_name))
    prefix = _PREFIX_RE.match(path.name)
    prefixed = f"{prefix.group(1)}-{new_name}" if prefix else new_name
    if prefixed == path.name:
        return _entry_id(path, project_folder)
    new_path = path.parent / prefixed
    if new_path.exists():
        raise DocumentError(f"Folder '{new_name}' already exists")
    before = _project_doc_map(project_folder)
    old_folder_id = _entry_id(path, project_folder)
    path.rename(new_path)
    # The folder's children (and their ids) moved with it.
    new_folder_id = _entry_id(new_path, project_folder)
    id_map: dict[str, str] = {}
    old_prefix = f"{old_folder_id}/"
    for doc_id in before:
        if doc_id.startswith(old_prefix):
            new_doc_id = f"{new_folder_id}/{doc_id[len(old_prefix):]}"
            if new_doc_id != doc_id:
                id_map[doc_id] = new_doc_id
    rewrite_wikilink_ids(project_id, id_map)
    _invalidate_word_stats(project_id)
    return new_folder_id


def delete_folder(project_id: str, folder_id: str) -> None:
    project_folder = _project_folder(project_id)
    path = _folder_path(project_folder, folder_id)
    if path == project_folder:
        raise DocumentError("Cannot delete the project root")
    if path.parent == project_folder and path.name.lower() == config.WIKI_DIRNAME:
        raise DocumentError("Cannot delete the wiki root")
    shutil.rmtree(path)
    _invalidate_word_stats(project_id)


def _prune_empty(start: Path, stop: Path) -> None:
    parent = start
    while parent != stop and parent.is_dir() and not any(parent.iterdir()):
        if (
            parent.name.lower() == config.STATS_DIRNAME
            or parent.name.lower() == config.WIKI_DIRNAME
        ):
            break
        parent.rmdir()
        parent = parent.parent


def save_document(
    project_id: str, doc_id: str, content: str, mode: str = "auto"
) -> dict[str, Any]:
    folder = _project_folder(project_id)
    path = _doc_path(folder, doc_id)
    if not path.exists():
        raise FileNotFoundError(f"Document '{doc_id}' not found")
    with _save_lock_for(path):
        raw = path.read_text(encoding="utf-8")

        fm_match = _FRONTMATTER_RE.match(raw)
        body_start = fm_match.end() if fm_match else 0
        old_words = count_words(raw[body_start:], mode)
        config._write_atomic(path, raw[:body_start] + content)

        new_words = count_words(content, mode)
        _record_save(project_id, doc_id, new_words - old_words)
        _word_stats_update(project_id, mode, doc_id, old_words, new_words)
        return get_document(project_id, doc_id, mode)


def update_style(
    project_id: str,
    doc_id: str,
    target: str,
    section: str | None = None,
    font: str | None = None,
    size: int | None = None,
    align: str | None = None,
    zoom: int | None = None,
    clear: bool = False,
    mode: str = "auto",
) -> dict[str, Any]:
    """Set or clear per-document / per-section text styling.

    ``target`` is ``"document"`` (the doc-wide base style) or ``"section"``
    (an override for the heading block named by ``section``). Styling is
    stored in frontmatter: flat ``font``/``size``/``align``/``zoom`` keys for
    the document base and a JSON ``styles`` map (heading text -> overrides)
    for sections.
    """
    folder = _project_folder(project_id)
    path = _doc_path(folder, doc_id)
    if not path.exists():
        raise FileNotFoundError(f"Document '{doc_id}' not found")
    raw = path.read_text(encoding="utf-8")
    meta, body = parse_frontmatter(raw)

    if target == "section":
        section_name = (section or "").strip()
        if not section_name:
            raise ValueError("A section name is required")
        styles: dict[str, Any] = {}
        raw_styles = meta.get("styles")
        if isinstance(raw_styles, dict):
            # Legacy unquoted YAML mapping (``styles: {"Appearance": {...}}``).
            styles = raw_styles
        elif isinstance(raw_styles, str) and raw_styles.strip():
            try:
                parsed = json.loads(raw_styles)
            except json.JSONDecodeError:
                parsed = None
            if isinstance(parsed, dict):
                styles = parsed
        entry = dict(styles.get(section_name, {}))
        if clear:
            styles.pop(section_name, None)
        else:
            if font:
                entry["font"] = str(font)
            if size is not None:
                entry["size"] = int(size)
            if align:
                entry["align"] = str(align)
            if entry:
                styles[section_name] = entry
            else:
                styles.pop(section_name, None)
        headings = _headings(body)
        for key in [k for k in styles if k not in headings]:
            styles.pop(key, None)
        if styles:
            meta["styles"] = json.dumps(styles, ensure_ascii=False)
        else:
            meta.pop("styles", None)
    else:
        if clear:
            for key in ("font", "size", "align", "zoom"):
                meta.pop(key, None)
        else:
            if font:
                meta["font"] = str(font)
            if size is not None:
                meta["size"] = int(size)
            if align:
                meta["align"] = str(align)
            if zoom is not None:
                meta["zoom"] = int(zoom)

    config._write_atomic(path, build_frontmatter(meta) + body)
    return get_document(project_id, doc_id, mode)


def rename_document(
    project_id: str, doc_id: str, new_title: str, mode: str = "auto"
) -> dict[str, Any]:
    folder = _project_folder(project_id)
    path = _doc_path(folder, doc_id)
    if not path.exists():
        raise FileNotFoundError(f"Document '{doc_id}' not found")
    raw = path.read_text(encoding="utf-8")
    meta, body = parse_frontmatter(raw)
    old_title = str(meta.get("title", "") or "")
    meta["title"] = new_title.strip() or meta.get("title", "Untitled")
    config._write_atomic(path, build_frontmatter(meta) + body)
    new_title = str(meta.get("title", "") or "")
    if old_title and old_title != new_title:
        rewrite_wikilink_titles(project_id, old_title, new_title)
    return get_document(project_id, doc_id, mode)


def delete_document(project_id: str, doc_id: str) -> None:
    folder = _project_folder(project_id)
    path = _doc_path(folder, doc_id)
    if not path.exists():
        raise FileNotFoundError(f"Document '{doc_id}' not found")
    path.unlink()
    _invalidate_word_stats(project_id)


def _entry_ids(directory: Path, project_folder: Path) -> dict[str, Path]:
    """Map entry id -> path for every orderable entry in ``directory``."""
    existing: dict[str, Path] = {}
    for child in directory.iterdir():
        if not _is_orderable_entry(child, project_folder):
            continue
        existing[_entry_id(child, project_folder)] = child
    return existing


def _ordered_entry_ids(directory: Path, project_folder: Path) -> list[str]:
    """Every orderable entry id in ``directory``, in display order."""
    return [
        _entry_id(p, project_folder)
        for p in sorted(directory.iterdir(), key=lambda p: _sort_key(p.name))
        if _is_orderable_entry(p, project_folder)
    ]


def _renumber(
    directory: Path, project_folder: Path, ordered_ids: list[str]
) -> dict[str, str]:
    """Reorder every orderable entry in ``directory`` to ``ordered_ids``.

    Assigns dense ``NN-`` prefixes preserving ``ordered_ids`` order, using a
    temp directory to avoid intermediate collisions. Returns a mapping of
    ``old id -> new id`` for every entry whose id changed.
    """
    existing = _entry_ids(directory, project_folder)
    if set(ordered_ids) != set(existing):
        raise DocumentError("Reorder list must include every entry in the folder")

    staged: list[tuple[Path, Path]] = []
    for index, entry_id in enumerate(ordered_ids, start=1):
        path = existing[entry_id]
        new_name = re.sub(r"^\d+-", "", path.name)
        new_name = f"{index:02d}-{new_name}"
        staged.append((path, path.with_name(new_name)))

    targets = {new for _, new in staged}
    if len(targets) != len(staged):
        raise DocumentError("Numbering collision while reordering")

    temp_dir = directory / config.REORDER_TMP_DIRNAME
    temp_dir.mkdir(exist_ok=True)
    try:
        for old, _ in staged:
            shutil.move(str(old), str(temp_dir / old.name))
        for old, new in staged:
            shutil.move(str(temp_dir / old.name), str(new))
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)

    renamed: dict[str, str] = {}
    for entry_id, (_, new) in zip(ordered_ids, staged, strict=True):
        new_id = _entry_id(new, project_folder)
        if new_id != entry_id:
            renamed[entry_id] = new_id
    # Renumbering changes entry ids — the word-stats cache is keyed by id.
    _invalidate_word_stats(project_folder.name)
    return renamed


def reorder_documents(
    project_id: str,
    ordered_ids: list[str],
    folder: str | None = None,
    mode: str = "auto",
) -> dict[str, Any]:
    project_folder = _project_folder(project_id)
    directory = _folder_path(project_folder, folder or "")
    before = _project_doc_map(project_folder)
    renamed = _renumber(directory, project_folder, ordered_ids)
    rewrite_wikilink_ids(project_id, _expand_folder_maps(before, renamed))
    return {"tree": get_tree(project_id, mode), "renamed": renamed}


def move_document(
    project_id: str,
    doc_id: str,
    target_folder: str | None = None,
    index: int | None = None,
    mode: str = "auto",
) -> dict[str, Any]:
    """Move a document into ``target_folder`` (service-level, Lain-compatible).

    ``index`` positions the document within the destination's unified order
    (folders + documents); ``None`` appends at the end. The destination is
    densely renumbered. Returns the moved document (with its new id).
    """
    doc, _ = _move_document_impl(project_id, doc_id, target_folder, index, mode)
    return doc


def _move_document_impl(
    project_id: str,
    doc_id: str,
    target_folder: str | None,
    index: int | None,
    mode: str,
) -> tuple[dict[str, Any], dict[str, str]]:
    project_folder = _project_folder(project_id)
    path = _doc_path(project_folder, doc_id)
    if not path.exists():
        raise FileNotFoundError(f"Document '{doc_id}' not found")
    target_dir = _folder_path(project_folder, target_folder or "")
    target_dir.mkdir(parents=True, exist_ok=True)

    if path.parent == target_dir:
        if index is None:
            return get_document(project_id, doc_id, mode), {}
        before = _project_doc_map(project_folder)
        entries = _ordered_entry_ids(target_dir, project_folder)
        entries.remove(doc_id)
        index = min(index, len(entries))
        entries.insert(index, doc_id)
        renamed = _renumber(target_dir, project_folder, entries)
        new_doc_id = renamed.get(doc_id, doc_id)
        rewrite_wikilink_ids(project_id, _expand_folder_maps(before, renamed))
        return get_document(project_id, new_doc_id, mode), renamed

    before = _project_doc_map(project_folder)
    moved = _ensure_unique(target_dir, target_dir / path.name)
    shutil.move(str(path), str(moved))

    moved_id = _entry_id(moved, project_folder)
    entries = _ordered_entry_ids(target_dir, project_folder)
    entries.remove(moved_id)
    index = len(entries) if index is None else min(index, len(entries))
    entries.insert(index, moved_id)
    renamed = _renumber(target_dir, project_folder, entries)

    new_doc_id = renamed.get(moved_id, moved_id)
    id_map = _expand_folder_maps(before, renamed)
    if new_doc_id != doc_id:
        id_map[doc_id] = new_doc_id
    rewrite_wikilink_ids(project_id, id_map)
    return get_document(project_id, new_doc_id, mode), renamed


def project_word_stats(project_id: str, mode: str = "auto") -> dict[str, int]:
    cache_key = (project_id, mode)
    with _word_stats_cache_lock:
        entry = _word_stats_cache.get(cache_key)
        if entry is not None:
            return {"words": entry["total_words"], "documents": entry["doc_count"]}
    folder = config.DATA_DIR / project_id
    if not folder.exists():
        return {"words": 0, "documents": 0}
    docs: dict[str, int] = {}
    total = 0
    count = 0
    for path in _md_files_recursive(folder):
        if config.STATS_DIRNAME in path.parts:
            continue
        doc_id = _entry_id(path, folder)
        raw = path.read_text(encoding="utf-8")
        _, body = parse_frontmatter(raw)
        words = count_words(body, mode)
        docs[doc_id] = words
        total += words
        count += 1
    with _word_stats_cache_lock:
        _word_stats_cache[cache_key] = {
            "total_words": total,
            "doc_count": count,
            "docs": docs,
        }
    return {"words": total, "documents": count}
