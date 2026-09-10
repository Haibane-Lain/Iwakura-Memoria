"""Project image assets: upload, validate, store, serve.

Pictures inserted into documents (the Write tab and the Wiki tab alike) live in
a visible ``assets/`` folder at the project root:

    <project>/assets/mara-portrait-3f9c2a41b7.png

Documents reference them **project-root-relative** (``assets/<name>``) rather
than per-document-relative, because document ids change on every move, reorder
and folder rename while this path never does — so nothing has to be rewritten
when the app moves a chapter around.

The folder name is reserved (``config.RESERVED_FOLDER_NAMES``) and every tree,
ordering and stats walk skips it, so pictures can never show up as a folder in
the sidebar, and a user folder can never collide with it.

Validation is content-based, never extension-based: Pillow identifies the real
format, which also rejects a text file renamed to ``.png``. SVG is deliberately
refused — it can carry script, and it is served from the app's own origin.
"""
from __future__ import annotations

import hashlib
import io
import os
import re
import secrets
from pathlib import Path
from typing import Any

from app import config
from app.services import documents as documents_service

MAX_IMAGE_BYTES = 10 * 1024 * 1024
# A 50 MP cap keeps a decompression bomb (huge header, tiny file) from being
# decoded, and 12000 px per edge keeps a single dimension from being absurd.
MAX_IMAGE_PIXELS = 50_000_000
MAX_IMAGE_EDGE = 12_000

# Pillow's format name -> the extension we store. ``JPG`` is normalised to
# ``JPEG`` before the lookup because Pillow reports both.
FORMAT_EXT = {
    "PNG": ".png",
    "JPEG": ".jpg",
    "GIF": ".gif",
    "WEBP": ".webp",
}
EXT_MEDIA = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
}
# One path segment, no separators, no leading dot (which would hide the file
# from backups) and no ``..``.
NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$")

ALLOWED_LABEL = "png, jpeg, gif, webp"


class AssetError(ValueError):
    """A rejected upload (bad format, too large, unreadable)."""


def assets_dir(project_id: str, create: bool = False) -> Path:
    """The project's ``assets/`` folder (``FileNotFoundError`` if no project)."""
    folder = documents_service._project_folder(project_id) / config.ASSETS_DIRNAME
    if create:
        folder.mkdir(parents=True, exist_ok=True)
    return folder


def media_type(name: str) -> str | None:
    return EXT_MEDIA.get(Path(name or "").suffix.lower())


def _probe(raw: bytes) -> tuple[str, int, int]:
    """Return ``(extension, width, height)`` for image bytes, or raise."""
    if not raw:
        raise AssetError("The image file is empty")
    # Imported here, not at module scope: Pillow is heavy and only picture
    # uploads need it (fpdf2 already depends on it, so it is always present).
    from PIL import Image

    try:
        with Image.open(io.BytesIO(raw)) as im:
            fmt = (im.format or "").upper()
            if fmt == "JPG":
                fmt = "JPEG"
            width, height = im.size
            im.verify()
    except Image.DecompressionBombError as exc:  # pragma: no cover - guard only
        raise AssetError("That image is too large to use") from exc
    except Exception as exc:  # UnidentifiedImageError, OSError, truncated data…
        raise AssetError(
            f"That file is not a readable image — allowed: {ALLOWED_LABEL}"
        ) from exc
    if fmt not in FORMAT_EXT:
        raise AssetError(
            f"Unsupported image format '{fmt or 'unknown'}' — allowed: {ALLOWED_LABEL}"
        )
    if width < 1 or height < 1:
        raise AssetError("That image has no pixels")
    if width > MAX_IMAGE_EDGE or height > MAX_IMAGE_EDGE:
        raise AssetError(f"Images larger than {MAX_IMAGE_EDGE} px per side are not supported")
    if width * height > MAX_IMAGE_PIXELS:
        raise AssetError("That image has too many pixels to use")
    return FORMAT_EXT[fmt], width, height


def _write_bytes_atomic(path: Path, raw: bytes) -> None:
    """Write *raw* so a reader never sees a half-written image.

    Same shape as ``config._write_atomic`` (a dotted ``.tmp`` sibling swapped
    in with ``os.replace``), which also means ``config._sweep_orphan_tmp``
    cleans up after an interrupted write.
    """
    tmp = path.with_name(f".{path.name}.{os.getpid()}.{secrets.token_hex(4)}.tmp")
    tmp.write_bytes(raw)
    os.replace(tmp, path)


def _item(project_id: str, name: str, size: int, width: int, height: int) -> dict[str, Any]:
    return {
        "name": name,
        "path": f"{config.ASSETS_DIRNAME}/{name}",
        "url": f"/api/projects/{project_id}/{config.ASSETS_DIRNAME}/{name}",
        "size": size,
        "width": width,
        "height": height,
    }


def save_image(project_id: str, filename: str, raw: bytes) -> dict[str, Any]:
    """Validate and store one uploaded image; return its metadata.

    The stored name is ``<slug-of-original-stem>-<sha256[:10]><ext>``: readable,
    collision-free, and derived from the bytes — so dragging the same picture in
    twice reuses one file instead of piling up copies. The client's file name is
    never used as the path, so a crafted name cannot escape ``assets/``.
    """
    if len(raw) > MAX_IMAGE_BYTES:
        raise AssetError(f"Image exceeds the {MAX_IMAGE_BYTES // (1024 * 1024)} MB limit")
    ext, width, height = _probe(raw)

    directory = assets_dir(project_id, create=True)
    stem = documents_service._slugify(Path(filename or "").stem or "image")
    digest = hashlib.sha256(raw).hexdigest()
    suffix = f"-{digest[:10]}"

    # The same picture is stored once whatever it is called the second time:
    # the digest comes from the bytes, so a file carrying this digest *is* this
    # image, and reusing it keeps the first (already referenced) name stable.
    for existing in sorted(directory.glob(f"*{suffix}{ext}")):
        try:
            if existing.read_bytes() == raw:
                return _item(project_id, existing.name, len(raw), width, height)
        except OSError:
            continue

    base = f"{stem}{suffix}"
    name = f"{base}{ext}"
    target = directory / name
    counter = 2
    while target.exists():  # a hand-placed file squatting on the name
        name = f"{base}-{counter}{ext}"
        target = directory / name
        counter += 1

    _write_bytes_atomic(target, raw)
    return _item(project_id, name, len(raw), width, height)


def image_path(project_id: str, name: str) -> Path:
    """Resolve a stored image name to a file inside ``assets/``.

    Raises ``FileNotFoundError`` for anything that is not a plain stored image
    name, so the route answers 404 without hinting at what exists.
    """
    name = (name or "").strip()
    if not NAME_RE.match(name) or ".." in name or media_type(name) is None:
        raise FileNotFoundError(f"Image '{name}' not found")
    directory = assets_dir(project_id)
    path = (directory / name).resolve()
    if not path.is_relative_to(directory.resolve()) or not path.is_file():
        raise FileNotFoundError(f"Image '{name}' not found")
    return path
