"""Import documents into a project from foreign formats.

The frontend sends a *bundle*: a flat list of ``(relative_path, bytes)`` pairs
gathered from a file picker, a folder picker, or a zip. Everything here works on
that shape, so a browser upload, a ``webkitdirectory`` pick, and an unpacked
archive all take exactly the same road.

Two halves, deliberately separate:

- **readers** turn a bundle into a neutral *outline* — a tree of folders and
  documents carrying Markdown bodies — dispatched by :func:`detect`;
- :func:`write_outline` turns that outline into the project, reusing
  ``documents.py``'s naming/uniqueness rules and ``assets.py``'s image store.

Adding a format means adding a reader, not touching the writer. Phase 1 ships
Markdown and plain text; DOCX, EPUB, Obsidian and Scrivener slot in behind the
same contract.

Invariants (they are what makes importing safe):

- nothing is ever overwritten — the bundle gets a fresh, uniquely-named folder
  (a single file becomes one uniquely-named document);
- archive entry names are only ever *labels* for titles, never paths, so a
  crafted ``../../evil`` in a zip cannot escape the project;
- images go through ``assets_service.save_image``, so they are content-validated
  and deduplicated, exactly like a picture dropped into the editor;
- imported words are recorded with a zero delta, so an import never shows up as
  words written today in the stats.
"""
from __future__ import annotations

import io
import re
import zipfile
from pathlib import Path
from typing import Any

from app import config
from app.services import assets as assets_service
from app.services import documents as documents_service

# A bundle this large is far past any real manuscript (a novel is ~1 MB of
# text); the request itself is already capped at MAX_REQUEST_BYTES by the
# body-size middleware, so this is the service-level backstop.
MAX_BUNDLE_BYTES = 25 * 1024 * 1024
MAX_ENTRIES = 5000
MAX_IMAGES = 2000

# Extensions that are text we can read as a document body.
TEXT_EXTS = {".md", ".markdown", ".txt", ".text"}

# Directories that are never part of the writing, wherever they appear.
SKIP_DIRS = {".obsidian", ".git", "__macosx", ".trash", ".snapshots", ".comments", "node_modules"}
SKIP_FILES = {".ds_store", "thumbs.db"}


class ImportDocsError(ValueError):
    """A bundle that cannot be turned into documents."""


class ImportLimitError(ImportDocsError):
    """A bundle past one of the import caps."""


# --------------------------------------------------------------------------
# bundle helpers
# --------------------------------------------------------------------------


def normalize_path(raw: str) -> str:
    """A bundle entry's path as a clean, relative, ``/``-separated label.

    Backslashes (a Windows folder picker) become separators, a leading drive or
    absolute root is dropped, and any ``..`` segment is removed — the result is
    only ever used to build *titles*, but keeping it a plain relative path means
    folder detection can never be fooled by an archive entry.
    """
    text = (raw or "").replace("\\", "/")
    parts = [p for p in text.split("/") if p and p not in (".", "..")]
    return "/".join(parts)


def is_skipped(path: str) -> bool:
    """Whether a bundle entry is tooling junk rather than writing."""
    parts = [p.lower() for p in normalize_path(path).split("/")]
    if not parts:
        return True
    if any(p in SKIP_DIRS for p in parts[:-1]):
        return True
    return parts[-1] in SKIP_FILES


def _decode(raw: bytes) -> str:
    """Text bytes as UTF-8, falling back to a lossy decode.

    Exporters write UTF-8; a stray cp1252 letter in a decades-old file should
    still import rather than abort the whole bundle.
    """
    if raw[:3] == b"\xef\xbb\xbf":  # BOM from a Windows editor
        raw = raw[3:]
    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError:
        return raw.decode("utf-8", errors="replace")


def _title_from_name(name: str) -> str:
    """A human title from a file name: ``03-the-old-house.md`` -> ``The Old House``."""
    stem = Path(name).stem
    stem = re.sub(r"^\d+[-_. ]*", "", stem)
    stem = stem.replace("-", " ").replace("_", " ").strip()
    return stem.title() or "Untitled"


def _doc_kind(meta: dict[str, Any], fallback: str) -> str:
    kind = str(meta.get("type", "")).strip().lower()
    return kind if kind in ("chapter", "note") else fallback


def _sort_key(path: str) -> tuple:
    name = path.split("/")[-1].lower()
    match = re.match(r"^(\d+)", name)
    return (0, int(match.group(1)), name) if match else (1, 0, name)


def pack_zip(raw: bytes) -> list[tuple[str, bytes]]:
    """An uploaded zip as bundle entries, in archive order.

    Directory entries are dropped, macOS ``__MACOSX`` cruft is filtered by
    :func:`is_skipped`, and the total uncompressed size is capped so a zip bomb
    is refused before anything is written.
    """
    files: list[tuple[str, bytes]] = []
    total = 0
    try:
        archive = zipfile.ZipFile(io.BytesIO(raw))
    except zipfile.BadZipFile as exc:
        raise ImportDocsError("That file is not a readable zip archive") from exc
    with archive:
        for info in archive.infolist():
            if info.is_dir():
                continue
            total += info.file_size
            if total > MAX_BUNDLE_BYTES:
                raise ImportLimitError(
                    f"The archive expands past the {MAX_BUNDLE_BYTES // (1024 * 1024)} MB import limit"
                )
            if len(files) >= MAX_ENTRIES:
                raise ImportLimitError(f"The archive holds more than {MAX_ENTRIES} files")
            try:
                data = archive.read(info)
            except (zipfile.BadZipFile, OSError) as exc:
                raise ImportDocsError(f"Could not read '{info.filename}' from the archive") from exc
            files.append((normalize_path(info.filename), data))
    return files


def unpack(files: list[tuple[str, bytes]]) -> list[tuple[str, bytes]]:
    """Expand any zips in *files* and drop skipped entries.

    A single uploaded zip is the common way to bring a Scrivener project or a
    vault across, so zips are transparently unpacked wherever they appear.
    """
    out: list[tuple[str, bytes]] = []
    for raw_path, data in files:
        path = normalize_path(raw_path)
        if is_skipped(path):
            continue
        if path.lower().endswith(".zip") and data[:2] == b"PK":
            out.extend((entry, blob) for entry, blob in pack_zip(data) if not is_skipped(entry))
        else:
            out.append((path, data))
    return out


# --------------------------------------------------------------------------
# detection
# --------------------------------------------------------------------------


def detect(files: list[tuple[str, bytes]]) -> str:
    """The source kind of a bundle: ``"markdown"``, ``"text"``, or ``"empty"``.

    Phase 1 knows the two plain-text families. Later phases extend this (DOCX,
    EPUB, a Scrivener ``.scrivx``, an Obsidian vault) — the dialog shows the
    label so the user can see which reader will take it.
    """
    files = unpack(files)
    if not files:
        return "empty"
    names = [path.lower() for path, _ in files]
    if any(n.endswith((".md", ".markdown")) for n in names):
        return "markdown"
    if any(n.endswith((".txt", ".text")) for n in names):
        return "text"
    return "unsupported"


SOURCE_LABELS = {
    "markdown": "Markdown",
    "text": "plain text",
    "empty": "empty",
    "unsupported": "unrecognised files",
}


# --------------------------------------------------------------------------
# readers -> outline
# --------------------------------------------------------------------------


def _document(path: str, body: str, fallback_kind: str, meta: dict[str, Any] | None = None) -> dict[str, Any]:
    meta = meta or {}
    title = str(meta.get("title") or "").strip() or _title_from_name(path)
    doc = {
        "kind": "doc",
        "title": title,
        "docKind": _doc_kind(meta, fallback_kind),
        "body": body,
        "children": [],
        "images": [],
    }
    tags = meta.get("tags")
    if isinstance(tags, list):
        doc["tags"] = [str(t) for t in tags if str(t).strip()]
    return doc


def _folder(title: str) -> dict[str, Any]:
    return {"kind": "folder", "title": title, "docKind": "note", "body": "", "children": [], "images": []}


def _read_markdown(path: str, raw: bytes, fallback_kind: str) -> dict[str, Any]:
    meta, body = documents_service.parse_frontmatter(_decode(raw))
    return _document(path, body, fallback_kind, meta)


def _read_text(path: str, raw: bytes, fallback_kind: str) -> dict[str, Any]:
    text = _decode(raw).replace("\r\n", "\n").replace("\r", "\n").strip()
    return _document(path, text, fallback_kind)


def build_outline(
    files: list[tuple[str, bytes]],
    options: dict[str, Any] | None = None,
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """Read a bundle into an outline: ``(root, flat_documents)``.

    ``root`` is a folder node whose children mirror the bundle's directory
    structure (a flat bundle becomes a root with document children). Document
    order follows the bundle's numeric ``NN-`` prefixes, then file name — the
    same ordering the tree itself uses.

    ``flat_documents`` is every document in creation order, so the caller can
    report counts without walking the tree.
    """
    options = options or {}
    files = unpack(files)
    if not files:
        raise ImportDocsError("No importable files were found")
    if len(files) > MAX_ENTRIES:
        raise ImportLimitError(f"The import holds more than {MAX_ENTRIES} files")

    source = options.get("source") or "auto"
    if source in ("auto", "", None):
        source = detect(files)
    if source == "empty" or source == "unsupported":
        raise ImportDocsError(
            "Nothing in that selection can be imported yet — expected Markdown or plain-text files"
        )
    if source not in ("markdown", "text"):
        raise ImportDocsError(f"Importing {SOURCE_LABELS.get(source, source)} is not supported yet")

    fallback_kind = "chapter" if str(options.get("as", "chapter")).lower() == "chapter" else "note"

    root = _folder(str(options.get("name") or "Imported"))
    folders: dict[str, dict[str, Any]] = {"": root}
    flat: list[dict[str, Any]] = []

    for path, raw in sorted(files, key=lambda f: _sort_key(f[0])):
        parts = path.split("/")
        name = parts[-1]
        ext = Path(name).suffix.lower()
        if ext not in TEXT_EXTS:
            continue  # a stray image, pdf or project file: not a document
        # Frontmatter is a Markdown idea; a .txt body is read as-is.
        read = _read_markdown if ext in (".md", ".markdown") else _read_text
        current = root
        for depth, segment in enumerate(parts[:-1]):
            key = "/".join(parts[: depth + 1])
            nxt = folders.get(key)
            if nxt is None:
                nxt = _folder(_title_from_name(segment))
                folders[key] = nxt
                current["children"].append(nxt)
            current = nxt
        node = read(path, raw, fallback_kind)
        current["children"].append(node)
        flat.append(node)

    if not flat:
        raise ImportDocsError("No importable documents were found in that selection")
    return root, flat


# --------------------------------------------------------------------------
# outline -> project
# --------------------------------------------------------------------------


def _write_images(project_id: str, node: dict[str, Any], counts: dict[str, int]) -> None:
    """Save a node's images and swap their tokens into the body.

    A reader writes ordinary Markdown with an opaque token as the target —
    ``![cover](@@img1@@)`` — and here the token becomes the stored path, so the
    body ends up pointing at ``assets/<name>`` like a picture inserted in the
    editor does. A picture the store refuses (not really an image, too large)
    loses its whole ``![…](…)`` reference rather than failing the import.
    """
    for image in node.get("images") or []:
        if counts["images"] >= MAX_IMAGES:
            break
        try:
            item = assets_service.save_image(project_id, image.get("name") or "image", image["bytes"])
        except (assets_service.AssetError, OSError):
            # Drop the whole reference, not just its target: "![](token)" left
            # behind would render as an empty broken image.
            node["body"] = re.sub(
                r"!\[[^\]]*\]\(" + re.escape(image["key"]) + r"\)", "", node["body"]
            ).replace(image["key"], "")
            continue
        node["body"] = node["body"].replace(image["key"], item["path"])
        counts["images"] += 1


def _write_node(
    project_id: str,
    container: Path,
    project_folder: Path,
    node: dict[str, Any],
    mode: str,
    counts: dict[str, int],
) -> str:
    """Create the entry for *node* inside *container*; return its id."""
    if node.get("kind") == "folder":
        name = documents_service._validate_folder_name(node.get("title") or "Imported")
        target = documents_service._ensure_unique(
            container, container / f"{documents_service._next_index(container):02d}-{name}"
        )
        target.mkdir()
        folder_id = documents_service._entry_id(target, project_folder)
        for child in node.get("children") or []:
            _write_node(project_id, target, project_folder, child, mode, counts)
        return folder_id

    _write_images(project_id, node, counts)
    title = str(node.get("title") or "Untitled").strip() or "Untitled"
    slug = documents_service._slugify(title)
    target = documents_service._ensure_unique(
        container, container / f"{documents_service._next_index(container):02d}-{slug}.md"
    )
    meta: dict[str, Any] = {"title": title, "type": node.get("docKind") or "chapter"}
    if node.get("tags"):
        meta["tags"] = node["tags"]
    config._write_atomic(target, documents_service.build_frontmatter(meta) + str(node.get("body") or ""))
    doc_id = target.relative_to(project_folder).as_posix()[: -len(".md")]
    # A zero delta: the words are in the project, but nobody typed them today.
    documents_service._record_save(project_id, doc_id, 0)
    counts["documents"] += 1
    counts["words"] += documents_service.count_words(str(node.get("body") or ""), mode)
    return doc_id


def write_outline(
    project_id: str,
    target_folder: str | None,
    outline: dict[str, Any],
    mode: str = "auto",
) -> dict[str, Any]:
    """Write an outline into *target_folder* as a new, uniquely-named subtree."""
    project_folder = documents_service._project_folder(project_id)
    parent = documents_service._folder_path(project_folder, target_folder or "", create=True)
    counts = {"documents": 0, "words": 0, "images": 0}
    folder_id = _write_node(project_id, parent, project_folder, outline, mode, counts)
    documents_service._invalidate_word_stats(project_id)
    return {
        "folder": folder_id,
        "folderTitle": outline.get("title"),
        # Whether the created entry is a folder (undo trashes the right thing).
        "isFolder": outline.get("kind") == "folder",
        **counts,
    }


def import_bundle(
    project_id: str,
    target_folder: str | None,
    files: list[tuple[str, bytes]],
    options: dict[str, Any] | None = None,
    mode: str = "auto",
) -> dict[str, Any]:
    """Read *files* and import them into *target_folder*. Returns a summary."""
    options = options or {}
    total = sum(len(data) for _, data in files)
    if total > MAX_BUNDLE_BYTES:
        raise ImportLimitError(
            f"The selection is larger than the {MAX_BUNDLE_BYTES // (1024 * 1024)} MB import limit"
        )
    root, flat = build_outline(files, options)
    children = root.get("children") or []
    # A bundle that is really one folder — a picked folder, or a zip whose
    # entries share a single top directory — becomes that folder, so the import
    # does not gain a redundant level of nesting. A name typed in the dialog
    # renames it.
    if len(children) == 1 and children[0].get("kind") == "folder":
        root = {**children[0], "title": str(options.get("name") or children[0]["title"])}
        children = root.get("children") or []
    # A single document needs no wrapper folder: it lands straight in the target,
    # which is what someone importing one chapter expects.
    if len(flat) == 1 and children and children[0].get("kind") == "doc":
        root = flat[0]
    elif not options.get("name"):
        root = {**root, "title": _default_import_name(files) or root["title"]}
    summary = write_outline(project_id, target_folder, root, mode)
    requested = options.get("source")
    summary["source"] = requested if requested not in (None, "", "auto") else detect(files)
    return summary


def _default_import_name(files: list[tuple[str, bytes]]) -> str:
    """A folder name for a bundle: its single shared top directory, if any."""
    paths = [path for path, _ in files if path]
    if not paths:
        return ""
    tops = {p.split("/")[0] for p in paths}
    if len(tops) == 1:
        return _title_from_name(tops.pop())
    return ""
