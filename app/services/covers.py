"""Cover images for worlds and books.

Covers are uploaded like document pictures — content-validated with Pillow and
served back by name — but they live once for the whole library in a hidden
``.covers/`` folder at the data root, because a world is not a project and a
book's cover belongs to the library's presentation rather than to the prose.

The stored name carries a short content digest, so replacing a cover writes a
new name and the browser can never serve a stale image from its cache. The
previous file is removed on replace.
"""
from __future__ import annotations

import hashlib
import os
import re
import secrets
from pathlib import Path

from app import config
from app.services.assets import (
    EXT_MEDIA,
    MAX_IMAGE_BYTES,
    AssetError,
    _probe,
)

# One path segment, no separators, and a media extension we produced ourselves.
NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,180}$")

KIND_WORLD = "world"
KIND_BOOK = "book"
_KINDS = (KIND_WORLD, KIND_BOOK)


def covers_dir(create: bool = False) -> Path:
    folder = config.DATA_DIR / config.COVERS_DIRNAME
    if create:
        folder.mkdir(parents=True, exist_ok=True)
    return folder


def media_type(name: str) -> str | None:
    return EXT_MEDIA.get(Path(name or "").suffix.lower())


def url(name: str | None) -> str | None:
    """The route a stored cover is served from, or None when unset."""
    return f"/api/covers/{name}" if name else None


def _safe_owner(owner_id: str) -> str:
    # Owner ids are already safe slugs, but this is the last line of defence
    # before the value becomes a file name.
    return re.sub(r"[^A-Za-z0-9._-]+", "-", owner_id or "").strip("-")[:80]


def save(kind: str, owner_id: str, raw: bytes) -> str:
    """Validate and store a cover; return its file name. Replaces any old one."""
    if kind not in _KINDS:
        raise AssetError(f"Unknown cover kind '{kind}'")
    if len(raw) > MAX_IMAGE_BYTES:
        raise AssetError(f"Image exceeds the {MAX_IMAGE_BYTES // (1024 * 1024)} MB limit")
    ext, _width, _height = _probe(raw)

    owner = _safe_owner(owner_id)
    if not owner:
        raise AssetError("Invalid cover owner")

    remove(kind, owner_id)
    digest = hashlib.sha256(raw).hexdigest()[:8]
    name = f"{kind}-{owner}-{digest}{ext}"
    directory = covers_dir(create=True)
    tmp = directory / f".{name}.{os.getpid()}.{secrets.token_hex(4)}.tmp"
    tmp.write_bytes(raw)
    os.replace(tmp, directory / name)
    return name


def remove(kind: str, owner_id: str) -> None:
    """Delete every stored cover for one owner. Best-effort."""
    owner = _safe_owner(owner_id)
    if not owner:
        return
    directory = covers_dir()
    if not directory.is_dir():
        return
    for existing in directory.glob(f"{kind}-{owner}-*"):
        try:
            if existing.is_file():
                existing.unlink()
        except OSError:
            continue


def path(name: str) -> Path:
    """Resolve a stored cover name to a file, or raise ``FileNotFoundError``.

    Anything that is not a plain stored cover name is refused, so the route
    answers 404 without hinting at what exists on disk.
    """
    name = (name or "").strip()
    if not NAME_RE.match(name) or ".." in name or media_type(name) is None:
        raise FileNotFoundError(f"Cover '{name}' not found")
    directory = covers_dir()
    full = (directory / name).resolve()
    if not full.is_relative_to(directory.resolve()) or not full.is_file():
        raise FileNotFoundError(f"Cover '{name}' not found")
    return full
