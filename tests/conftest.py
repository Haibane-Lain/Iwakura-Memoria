"""Shared pytest fixtures."""
from __future__ import annotations

import pytest

from app import config


@pytest.fixture
def data_dir(tmp_path, monkeypatch):
    """Point config.DATA_DIR at a throwaway folder for service-level tests."""
    d = tmp_path / "data"
    d.mkdir()
    monkeypatch.setattr(config, "DATA_DIR", d)
    return d


@pytest.fixture
def make_project(data_dir):
    """Return a factory that creates a minimal project folder (with the
    project.json marker existing service functions require)."""

    def _make(project_id: str):
        folder = data_dir / project_id
        (folder / "stats").mkdir(parents=True, exist_ok=True)
        (folder / "project.json").write_text("{}", encoding="utf-8")
        return folder

    return _make
