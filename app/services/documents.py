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
import yaml

import re
import shutil
from datetime import datetime
from pathlib import Path
from typing import Any

from app import config

_SAFE_ID_RE = re.compile(r"^[^\\\x00-\x1f]+$")
_FRONTMATTER_RE = re.compile(r"^---\s*\n(.*?)\n---\s*\n?", re.DOTALL)
_CJK_RE = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff]")
_WORD_RE = re.compile(r"\S+")
_HTML_TAG_RE = re.compile(r"<[^>]+>")
_PREFIX_RE = re.compile(r"^(\d+)-")


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
        try:
            meta = yaml.safe_load(m.group(1)) or {}
        except yaml.YAMLError:
            meta = {}
        body = text[m.end():]
        return dict(meta), body
    return {}, text


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
    raw = meta.get("styles", "")
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


def build_frontmatter(meta: dict[str, Any]) -> str:
    if not meta:
        return ""
    lines = ["---"]
    for key, value in meta.items():
        lines.append(f"{key}: {value}")
    lines.append("---")
    return "\n".join(lines) + "\n\n"


def _project_folder(project_id: str) -> Path:
    folder = config.DATA_DIR / project_id
    if not (folder / config.PROJECT_META_FILENAME).exists():
        raise FileNotFoundError(f"Project '{project_id}' not found")
    return folder


def _validate_id(doc_id: str) -> str:
    if not isinstance(doc_id, str) or not _SAFE_ID_RE.match(doc_id):
        raise DocumentError("Invalid id")
    return doc_id


def _doc_path(folder: Path, doc_id: str) -> Path:
    doc_id = _validate_id(doc_id)
    relative = doc_id if doc_id.endswith(".md") else doc_id + ".md"
    path = (folder / relative).resolve()
    if not str(path).startswith(str(folder.resolve())):
        raise DocumentError("Invalid document path")
    return path


def _folder_path(folder: Path, folder_id: str | None, create: bool = False) -> Path:
    folder_id = (folder_id or "").strip().strip("/")
    if not folder_id:
        return folder
    _validate_id(folder_id)
    path = (folder / folder_id).resolve()
    if not str(path).startswith(str(folder.resolve())):
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
    return rel[: -len(".md")] if path.is_file() and rel.endswith(".md") else rel


def _is_orderable_entry(path: Path, project_folder: Path) -> bool:
    """Whether an entry participates in ordering (mirrors ``_children``)."""
    name = path.name
    if path.is_dir():
        if name.startswith(".") or name in (config.STATS_DIRNAME, config.TEMPLATES_DIRNAME):
            return False
        if path.parent == project_folder and name.lower() == config.WIKI_DIRNAME:
            return False
        return True
    return path.is_file() and path.suffix == ".md" and not name.startswith(".")


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
        elif child.suffix == ".md" and not name.startswith("."):
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
    with history.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(entry, ensure_ascii=False) + "\n")


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
        entries = _ordered_entry_ids(target_dir, project_folder)
        entries.remove(folder_id)
        index = min(index, len(entries))
        entries.insert(index, folder_id)
        renamed = _renumber(target_dir, project_folder, entries)
        return renamed.get(folder_id, folder_id), renamed
    if target_dir == path or target_dir.is_relative_to(path):
        raise DocumentError("Cannot move a folder into itself or one of its subfolders")
    new_path = target_dir / path.name
    if new_path.exists():
        raise DocumentError(f"Folder '{path.name}' already exists in the destination")

    path.rename(new_path)
    moved_id = _entry_id(new_path, project_folder)
    entries = _ordered_entry_ids(target_dir, project_folder)
    entries.remove(moved_id)
    index = len(entries) if index is None else min(index, len(entries))
    entries.insert(index, moved_id)
    renamed = _renumber(target_dir, project_folder, entries)
    return renamed.get(moved_id, moved_id), renamed


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
    path.rename(new_path)
    return _entry_id(new_path, project_folder)


def delete_folder(project_id: str, folder_id: str) -> None:
    project_folder = _project_folder(project_id)
    path = _folder_path(project_folder, folder_id)
    if path == project_folder:
        raise DocumentError("Cannot delete the project root")
    if path.parent == project_folder and path.name.lower() == config.WIKI_DIRNAME:
        raise DocumentError("Cannot delete the wiki root")
    shutil.rmtree(path)


def _prune_empty(start: Path, stop: Path) -> None:
    parent = start
    while parent != stop and parent.is_dir() and not any(parent.iterdir()):
        if (
            parent.name == config.STATS_DIRNAME
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
    raw = path.read_text(encoding="utf-8")
    old_meta, _ = parse_frontmatter(raw)
    old_words = count_words(raw, mode)

    frontmatter = build_frontmatter(old_meta)
    config._write_atomic(path, frontmatter + content)

    new_words = count_words(content, mode)
    _record_save(project_id, doc_id, new_words - old_words)
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
        if isinstance(meta.get("styles"), str) and meta["styles"].strip():
            try:
                parsed = json.loads(meta["styles"])
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
    meta["title"] = new_title.strip() or meta.get("title", "Untitled")
    config._write_atomic(path, build_frontmatter(meta) + body)
    return get_document(project_id, doc_id, mode)


def delete_document(project_id: str, doc_id: str) -> None:
    folder = _project_folder(project_id)
    path = _doc_path(folder, doc_id)
    if not path.exists():
        raise FileNotFoundError(f"Document '{doc_id}' not found")
    path.unlink()


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
    for entry_id, (_, new) in zip(ordered_ids, staged):
        new_id = _entry_id(new, project_folder)
        if new_id != entry_id:
            renamed[entry_id] = new_id
    return renamed


def reorder_documents(
    project_id: str,
    ordered_ids: list[str],
    folder: str | None = None,
    mode: str = "auto",
) -> dict[str, Any]:
    project_folder = _project_folder(project_id)
    directory = _folder_path(project_folder, folder or "")
    renamed = _renumber(directory, project_folder, ordered_ids)
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
        entries = _ordered_entry_ids(target_dir, project_folder)
        entries.remove(doc_id)
        index = min(index, len(entries))
        entries.insert(index, doc_id)
        renamed = _renumber(target_dir, project_folder, entries)
        new_doc_id = renamed.get(doc_id, doc_id)
        return get_document(project_id, new_doc_id, mode), renamed

    moved = _ensure_unique(target_dir, target_dir / path.name)
    shutil.move(str(path), str(moved))

    moved_id = _entry_id(moved, project_folder)
    entries = _ordered_entry_ids(target_dir, project_folder)
    entries.remove(moved_id)
    index = len(entries) if index is None else min(index, len(entries))
    entries.insert(index, moved_id)
    renamed = _renumber(target_dir, project_folder, entries)

    new_doc_id = renamed.get(moved_id, moved_id)
    return get_document(project_id, new_doc_id, mode), renamed


def project_word_stats(project_id: str, mode: str = "auto") -> dict[str, int]:
    folder = config.DATA_DIR / project_id
    if not folder.exists():
        return {"words": 0, "documents": 0}
    total = 0
    count = 0
    for path in _md_files_recursive(folder):
        if config.STATS_DIRNAME in path.parts:
            continue
        raw = path.read_text(encoding="utf-8")
        _, body = parse_frontmatter(raw)
        total += count_words(body, mode)
        count += 1
    return {"words": total, "documents": count}
