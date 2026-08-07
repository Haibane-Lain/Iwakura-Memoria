"""Lore templates for wiki entries (stored per project).

Each template is a JSON file ``data/<project>/templates/<id>.json``:
``{"id": ..., "name": ..., "type": ..., "sections": [...]}``. The five
defaults are seeded automatically on first access.
"""
from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

from app import config

DEFAULT_TEMPLATES: list[dict[str, Any]] = [
    {
        "id": "character",
        "name": "Character",
        "type": "character",
        "sections": [
            "Appearance",
            "Personality",
            "History",
            "Goals",
            "Abilities",
            "Relationships",
        ],
    },
    {
        "id": "location",
        "name": "Location",
        "type": "location",
        "sections": ["Description", "History"],
    },
    {
        "id": "organization",
        "name": "Organization",
        "type": "organization",
        "sections": ["Description", "History", "Members", "Goals"],
    },
    {
        "id": "nation",
        "name": "Nation",
        "type": "nation",
        "sections": ["Description", "Geography", "History"],
    },
    {
        "id": "lore-concept",
        "name": "Lore Concept",
        "type": "lore-concept",
        "sections": ["Description"],
    },
]


class TemplateError(ValueError):
    pass


def _templates_dir(project_id: str) -> Path:
    folder = config.DATA_DIR / project_id
    if not (folder / config.PROJECT_META_FILENAME).exists():
        raise FileNotFoundError(f"Project '{project_id}' not found")
    return folder / config.TEMPLATES_DIRNAME


def _seed(project_id: str) -> None:
    tdir = _templates_dir(project_id)
    tdir.mkdir(parents=True, exist_ok=True)
    for tpl in DEFAULT_TEMPLATES:
        path = tdir / f"{tpl['id']}.json"
        if not path.exists():
            config._write_atomic(
                path, json.dumps(tpl, ensure_ascii=False, indent=2)
            )


def _slug_id(name: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
    return slug or "template"


def list_templates(project_id: str) -> list[dict[str, Any]]:
    _seed(project_id)
    templates: list[dict[str, Any]] = []
    for path in sorted(_templates_dir(project_id).glob("*.json")):
        try:
            templates.append(json.loads(path.read_text(encoding="utf-8")))
        except (json.JSONDecodeError, OSError):
            continue
    return templates


def create_template(
    project_id: str, name: str, sections: list[str]
) -> dict[str, Any]:
    _seed(project_id)
    name = (name or "").strip()
    if not name:
        raise TemplateError("A template name is required")
    sections = [s.strip() for s in (sections or []) if s and s.strip()]
    tpl_id = _slug_id(name)
    tdir = _templates_dir(project_id)
    path = tdir / f"{tpl_id}.json"
    if path.exists():
        raise TemplateError(f"Template '{name}' already exists")
    data = {"id": tpl_id, "name": name, "type": tpl_id, "sections": sections}
    config._write_atomic(path, json.dumps(data, ensure_ascii=False, indent=2))
    return data


def update_template(
    project_id: str,
    tpl_id: str,
    name: str | None = None,
    sections: list[str] | None = None,
) -> dict[str, Any]:
    tdir = _templates_dir(project_id)
    path = tdir / f"{tpl_id}.json"
    if not path.exists():
        raise FileNotFoundError("Template not found")
    data = json.loads(path.read_text(encoding="utf-8"))
    if name is not None and name.strip():
        data["name"] = name.strip()
    if sections is not None:
        data["sections"] = [s.strip() for s in sections if s and s.strip()]
    config._write_atomic(path, json.dumps(data, ensure_ascii=False, indent=2))
    return data


def delete_template(project_id: str, tpl_id: str) -> None:
    path = _templates_dir(project_id) / f"{tpl_id}.json"
    if not path.exists():
        raise FileNotFoundError("Template not found")
    path.unlink()
