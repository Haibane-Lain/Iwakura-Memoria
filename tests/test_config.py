"""Tests for app.config path resolution and the legacy data migration.

These are the project's first tests. Run from the workspace root:

    .venv\\Scripts\\python.exe -m pytest tests/ -q
"""
from __future__ import annotations

from pathlib import Path

import pytest

from app import config


# --- _default_data_dir ----------------------------------------------------


def test_default_data_dir_prefers_env_override(tmp_path, monkeypatch):
    monkeypatch.setenv("IWAKURA_DATA_DIR", str(tmp_path / "custom"))
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path / "local"))
    assert config._default_data_dir() == tmp_path / "custom"


def test_default_data_dir_uses_localappdata(tmp_path, monkeypatch):
    monkeypatch.delenv("IWAKURA_DATA_DIR", raising=False)
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path / "local"))
    assert config._default_data_dir() == (
        tmp_path / "local" / config.APP_DATA_DIR_NAME / config.DATA_DIR_NAME
    )


def test_default_data_dir_falls_back_to_home(tmp_path, monkeypatch):
    monkeypatch.delenv("IWAKURA_DATA_DIR", raising=False)
    monkeypatch.delenv("LOCALAPPDATA", raising=False)
    monkeypatch.setattr(Path, "home", staticmethod(lambda: tmp_path))
    assert config._default_data_dir() == tmp_path / ".iwakura" / config.DATA_DIR_NAME


# --- _migrate_legacy_data ------------------------------------------------


@pytest.fixture
def legacy(tmp_path, monkeypatch) -> Path:
    legacy_dir = tmp_path / "legacy-data"
    legacy_dir.mkdir()
    (legacy_dir / "project.json").write_text("{}", encoding="utf-8")
    (legacy_dir / "settings.json").write_text("{}", encoding="utf-8")
    (legacy_dir / "soul-sovereign").mkdir()
    (legacy_dir / "soul-sovereign" / "chapter-one.md").write_text("# One", encoding="utf-8")
    monkeypatch.setattr(config, "LEGACY_DATA_DIR", legacy_dir)
    return legacy_dir


def test_migrate_moves_legacy_into_target(tmp_path, legacy):
    target = tmp_path / "target"
    assert config._migrate_legacy_data(target) is True
    assert target.is_dir()
    assert (target / "project.json").exists()
    assert (target / "soul-sovereign" / "chapter-one.md").exists()
    assert (target / config._MIGRATION_MARKER).exists()
    assert not legacy.exists()  # moved, never copied


def test_migrate_already_done_is_noop(tmp_path, monkeypatch):
    target = tmp_path / "target"
    target.mkdir()
    (target / config._MIGRATION_MARKER).write_text("migrated\n", encoding="utf-8")
    (target / "notes.md").write_text("x", encoding="utf-8")
    legacy_dir = tmp_path / "legacy-data"
    legacy_dir.mkdir()
    (legacy_dir / "stray.md").write_text("y", encoding="utf-8")
    monkeypatch.setattr(config, "LEGACY_DATA_DIR", legacy_dir)
    assert config._migrate_legacy_data(target) is True
    assert legacy_dir.exists()  # legacy untouched once migration is done
    assert (target / "notes.md").exists()


def test_migrate_keeps_legacy_when_target_populated(tmp_path, legacy):
    target = tmp_path / "target"
    target.mkdir()
    (target / "existing.md").write_text("y", encoding="utf-8")
    assert config._migrate_legacy_data(target) is False
    assert legacy.exists()
    assert (legacy / "project.json").exists()
    assert not (target / "project.json").exists()  # never merged


def test_migrate_nothing_to_do_for_fresh_install(tmp_path, monkeypatch):
    empty = tmp_path / "empty"
    empty.mkdir()
    monkeypatch.setattr(config, "LEGACY_DATA_DIR", empty)
    target = tmp_path / "target"
    assert config._migrate_legacy_data(target) is True
    assert not target.exists()  # nothing created


def test_ensure_dirs_migrates_and_points_data_dir(tmp_path, monkeypatch):
    legacy_dir = tmp_path / "legacy-data"
    legacy_dir.mkdir()
    (legacy_dir / "settings.json").write_text("{}", encoding="utf-8")
    monkeypatch.setattr(config, "LEGACY_DATA_DIR", legacy_dir)
    monkeypatch.delenv("IWAKURA_DATA_DIR", raising=False)
    target = tmp_path / "local" / config.APP_DATA_DIR_NAME / config.DATA_DIR_NAME
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path / "local"))
    monkeypatch.setattr(config, "STATIC_DIR", tmp_path / "static")
    config.ensure_dirs()
    assert config.DATA_DIR == target
    assert (target / "settings.json").exists()
    assert config.DATA_DIR.is_dir()


# --- settings read cache (R2) ----------------------------------------------


def test_settings_cache_tracks_file_changes(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "DATA_DIR", tmp_path / "data")
    assert config.load_settings()["theme"] == "paper"

    config.save_settings({**config.load_settings(), "theme": "dark"})
    assert config.load_settings()["theme"] == "dark"

    # The cache is keyed to the file's existence/mtime: deleting the file
    # yields fresh defaults, never a stale cached value.
    (config.get_settings_path()).unlink()
    assert config.load_settings()["theme"] == "paper"


def test_settings_cache_isolated_per_path(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "DATA_DIR", tmp_path / "a" / "data")
    config.save_settings({**config.load_settings(), "theme": "dark"})
    monkeypatch.setattr(config, "DATA_DIR", tmp_path / "b" / "data")
    assert config.load_settings()["theme"] == "paper"  # different file → no bleed


def test_settings_cache_returns_copies(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "DATA_DIR", tmp_path / "data")
    loaded = config.load_settings()
    loaded["editorFont"] = "mono"  # mutate the caller's copy
    assert config.load_settings()["editorFont"] == "serif"  # cache untouched