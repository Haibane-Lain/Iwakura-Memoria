"""Whole-library backups: zip creation, retention, listing, and deletion."""
from __future__ import annotations

import zipfile
from datetime import datetime

import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from app.services import backup as backup_service


class _FakeDatetime:
    """Deterministic clock. ``now()`` starts at a fixed time and advances by
    ``_step`` seconds per call; ``_step = 0`` reproduces the same second (the
    -N name-suffix path). ``fromtimestamp`` delegates to the real datetime."""

    _current = None
    _step = 1
    _real = datetime

    @classmethod
    def now(cls):
        if cls._current is None:
            cls._current = cls._real(2026, 9, 6, 12, 0, 0)
        cls._current = cls._current.replace(second=cls._current.second + cls._step)
        return cls._current

    @classmethod
    def fromtimestamp(cls, ts):
        return cls._real.fromtimestamp(ts)


@pytest.fixture(autouse=True)
def _fixed_clock(monkeypatch):
    _FakeDatetime._current = None
    _FakeDatetime._step = 1
    monkeypatch.setattr(backup_service, "datetime", _FakeDatetime)


def test_create_backup_zips_data_and_skips_junk(data_dir, make_project):
    make_project("proj")
    (data_dir / "proj" / "01-a.md").write_text("# A\n", encoding="utf-8")
    (data_dir / "settings.json").write_text('{"theme": "paper"}', encoding="utf-8")
    (data_dir / "proj" / ".hidden.md").write_text("x", encoding="utf-8")
    (data_dir / "proj" / "junk.tmp").write_text("x", encoding="utf-8")

    res = backup_service.create_backup()

    assert res["ok"] is True
    assert res["name"].startswith("backup-")
    with zipfile.ZipFile(backup_service.backups_dir() / res["name"]) as zf:
        names = set(zf.namelist())
    assert "data/proj/project.json" in names
    assert "data/proj/01-a.md" in names
    assert "data/settings.json" in names
    assert not any("hidden" in n for n in names)
    assert not any(n.endswith(".tmp") for n in names)


def _names():
    return [b["name"] for b in backup_service.list_backups()]


def test_same_second_creates_do_not_clobber(data_dir, make_project):
    _FakeDatetime._step = 0  # both creates land in the same fake second
    make_project("proj")
    first = backup_service.create_backup()
    second = backup_service.create_backup()

    assert first["name"] != second["name"]
    assert second["name"].endswith("-2.zip")
    assert set(_names()) == {first["name"], second["name"]}


def test_list_newest_first_and_delete(data_dir, make_project):
    make_project("proj")
    backup_service.create_backup()
    first = backup_service.create_backup()

    items = backup_service.list_backups()
    assert len(items) == 2
    assert items[0]["name"] == first["name"]  # newest first
    assert items[0]["size"] > 0

    assert backup_service.delete_backup(first["name"]) is True
    assert backup_service.delete_backup("not-a-backup.zip") is False
    assert backup_service.delete_backup("../escape.zip") is False
    assert len(backup_service.list_backups()) == 1


def test_retention_prunes_oldest(data_dir, make_project, monkeypatch):
    monkeypatch.setattr(backup_service, "_BACKUP_KEEP", 2)
    make_project("proj")
    created = []
    for _ in range(3):
        created.append(backup_service.create_backup())

    remaining = _names()
    newest = [c["name"] for c in created[-2:]]
    assert sorted(remaining) == sorted(newest)  # the two newest survive, oldest pruned


def test_backup_routes(tmp_path, monkeypatch):
    monkeypatch.setenv("IWAKURA_DATA_DIR", str(tmp_path / "data"))
    client = TestClient(create_app())
    _H = {"host": "127.0.0.1"}

    r = client.get("/api/backups", headers=_H)
    assert r.status_code == 200
    assert r.json() == []

    r = client.post("/api/backups", json={}, headers=_H)
    assert r.status_code == 201
    body = r.json()
    assert body["ok"] and body["name"]

    r = client.get("/api/backups", headers=_H)
    assert [b["name"] for b in r.json()] == [body["name"]]

    r = client.delete(f"/api/backups/{body['name']}", headers=_H)
    assert r.status_code == 200
    assert client.delete("/api/backups/missing.zip", headers=_H).status_code == 404