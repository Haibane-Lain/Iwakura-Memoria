"""Application configuration and paths.

Data lives in the project's ``data/`` directory:
- ``settings.json``     global settings (theme, word-count mode)
- ``<project>/``        one folder per project (see README for layout)
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
STATIC_DIR = Path(__file__).resolve().parent.parent / "static"

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


def ensure_dirs() -> None:
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
    get_settings_path().write_text(
        json.dumps(merged, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    return merged
