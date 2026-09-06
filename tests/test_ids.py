"""Tests for project/doc id safety (B1, B2) and rename behavior (B4, B5)."""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app import config
from app.ai import sessions as sessions_service
from app.main import create_app
from app.services import documents as documents_service
from app.services import projects as projects_service


@pytest.fixture
def client(tmp_path, monkeypatch):
    """TestClient whose data dir is a throwaway folder (like test_security)."""
    monkeypatch.setenv("IWAKURA_DATA_DIR", str(tmp_path / "data"))
    return TestClient(create_app())


_H = {"host": "127.0.0.1"}


# --- B1: project id safety --------------------------------------------------


def test_is_safe_project_id_rejects_escape_ids():
    for bad in ("", ".", "..", ".hidden", "a/b", "a\\b", "..x"):
        assert config.is_safe_project_id(bad) is False, bad


def test_is_safe_project_id_accepts_real_names():
    for good in ("soul-sovereign", "proj.v1", "a..b", "2323", "MotherOfHorrors"):
        assert config.is_safe_project_id(good) is True, good


def test_api_rejects_dotdot_project_id(client, tmp_path):
    created = client.post("/api/projects", json={"name": "Soul"}, headers=_H)
    assert created.status_code == 201

    # %2E%2E decodes to ".." — must be rejected before touching the filesystem
    r = client.delete("/api/projects/%2E%2E", headers=_H)
    assert r.status_code == 400
    assert (tmp_path / "data" / "soul").is_dir()  # data dir untouched

    r = client.get("/api/projects/%2E%2E", headers=_H)
    assert r.status_code == 400

    r = client.get("/api/projects/%2E%2E/ai/sessions", headers=_H)
    assert r.status_code == 400


def test_sessions_dir_rejects_dotdot(data_dir):
    with pytest.raises(ValueError):
        sessions_service._sessions_dir("..")


# --- B2: document/folder containment ----------------------------------------


def test_doc_path_rejects_escapes(tmp_path):
    folder = tmp_path / "rasha"
    folder.mkdir()
    (tmp_path / "rasha-2").mkdir()
    for bad in ("../rasha-2/x", "../x", "../../evil"):
        with pytest.raises(documents_service.DocumentError):
            documents_service._doc_path(folder, bad)
    with pytest.raises(documents_service.DocumentError):
        documents_service._folder_path(folder, "..")
    # legitimate ids still resolve
    assert documents_service._doc_path(folder, "01-intro") == folder / "01-intro.md"
    (folder / "Part One").mkdir()
    assert documents_service._folder_path(folder, "Part One") == folder / "Part One"
    # a bare ".." doc id appends ".md", resolving to "...md" *inside* the
    # folder — contained (harmless oddity, not an escape)
    assert documents_service._doc_path(folder, "..") == folder / "...md"


# --- B4: project rename migrates ai sessions --------------------------------


def test_rename_project_migrates_sessions(data_dir, make_project):
    make_project("proj")
    sessions_service.create("proj")
    renamed = projects_service.rename_project("proj", "New Name")
    assert renamed["id"] == "new-name"
    assert (data_dir / "ai-sessions" / "new-name").is_dir()
    assert not (data_dir / "ai-sessions" / "proj").exists()


def test_rename_project_works_without_sessions(data_dir, make_project):
    make_project("proj")
    renamed = projects_service.rename_project("proj", "Renamed")
    assert renamed["id"] == "renamed"


# --- B5: rename conflict is a 409 -------------------------------------------


def test_rename_conflict_returns_409(client):
    assert client.post("/api/projects", json={"name": "Alpha"}, headers=_H).status_code == 201
    assert client.post("/api/projects", json={"name": "Beta"}, headers=_H).status_code == 201
    r = client.patch("/api/projects/alpha", json={"title": "Beta"}, headers=_H)
    assert r.status_code == 409


def test_rename_to_same_case_variant_ok(client):
    assert client.post("/api/projects", json={"name": "Alpha"}, headers=_H).status_code == 201
    r = client.patch("/api/projects/alpha", json={"title": "Alpha"}, headers=_H)
    assert r.status_code == 200