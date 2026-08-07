"""Global settings read/write."""
from __future__ import annotations

from typing import Any

from app import config


def get_settings() -> dict[str, Any]:
    return config.load_settings()


def update_settings(patch: dict[str, Any]) -> dict[str, Any]:
    current = config.load_settings()
    current.update(patch)
    return config.save_settings(current)
