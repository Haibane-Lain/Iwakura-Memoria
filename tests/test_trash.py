"""Trash (recycle bin): deletes move entries aside instead of erasing them.

Coverage is mostly service-level on a throwaway project; the route test pins
the request/response wiring and the 404s.
"""
from __future__ import annotations

import zipfile

import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from app.services import backup as backup_service
from app.services import documents as documents_service
from app.services import projects as projects_service
from app.services import trash as trash_service


def _entry_path(data_dir, project_id, trash_id):
    return data_dir / ".trash" / project_id / trash_id / "entry"


# --- move to trash ----------------------------------------------------------


def test_delete_document_moves_to_trash(data_dir, make_project):
    make_project("proj")
    doc = documents_service.create_document("proj", "Alpha", content="hello world")
    entry = documents_service.delete_document("proj", doc["id"])

    assert entry["id"]
    assert entry["kind"] == "document"
    assert entry["name"] == "Alpha"
    # Gone from the tree and from word counts...
    assert documents_service.iter_documents("proj") == []
    assert documents_service.project_word_stats("proj")["words"] == 0
    # ...but the file is intact in the bin.
    listed = trash_service.list_trash("proj")
    assert [t["id"] for t in listed] == [entry["id"]]
    assert "hello world" in _entry_path(data_dir, "proj", entry["id"]).read_text(encoding="utf-8")


def test_delete_folder_moves_it_whole(data_dir, make_project):
    make_project("proj")
    folder = documents_service.create_folder("proj", "Scenes")
    doc = documents_service.create_document("proj", "Alpha", folder=folder, content="x")

    entry = documents_service.delete_folder("proj", folder)
    assert entry["kind"] == "folder"
    assert documents_service.iter_documents("proj") == []
    # The child rode along inside the trashed folder.
    child = _entry_path(data_dir, "proj", entry["id"]) / "01-alpha.md"
    assert child.is_file()
    assert doc["id"].startswith(folder)


# --- restore ----------------------------------------------------------------


def test_restore_document_roundtrip(data_dir, make_project):
    make_project("proj")
    doc = documents_service.create_document("proj", "Alpha", content="hello world")
    entry = documents_service.delete_document("proj", doc["id"])

    restored = trash_service.restore("proj", entry["id"])
    assert restored["newId"] == doc["id"]
    assert restored["renamed"] is False
    assert trash_service.list_trash("proj") == []
    assert "hello world" in documents_service.get_document("proj", doc["id"])["content"]
    assert documents_service.project_word_stats("proj")["words"] == 2


def test_restore_folder_brings_children_back(data_dir, make_project):
    make_project("proj")
    folder = documents_service.create_folder("proj", "Scenes")
    doc = documents_service.create_document("proj", "Alpha", folder=folder, content="x")
    entry = documents_service.delete_folder("proj", folder)

    restored = trash_service.restore("proj", entry["id"])
    assert restored["newId"] == folder
    assert restored["renamed"] is False
    assert documents_service.get_document("proj", doc["id"])["id"] == doc["id"]


def test_restore_collision_renames(data_dir, make_project):
    make_project("proj")
    doc = documents_service.create_document("proj", "Alpha", content="original")
    entry = documents_service.delete_document("proj", doc["id"])
    # The freed id is taken again before the restore.
    replacement = documents_service.create_document("proj", "Alpha", content="replacement")
    assert replacement["id"] == doc["id"]

    restored = trash_service.restore("proj", entry["id"])
    assert restored["renamed"] is True
    assert restored["newId"] != doc["id"]
    assert "original" in documents_service.get_document("proj", restored["newId"])["content"]
    assert "replacement" in documents_service.get_document("proj", doc["id"])["content"]


def test_restore_unknown_id_raises(data_dir, make_project):
    make_project("proj")
    with pytest.raises(FileNotFoundError):
        trash_service.restore("proj", "deadbeef")


# --- purge / empty ----------------------------------------------------------


def test_purge_and_empty(data_dir, make_project):
    make_project("proj")
    a = documents_service.create_document("proj", "A", content="a")
    b = documents_service.create_document("proj", "B", content="b")
    entry_a = documents_service.delete_document("proj", a["id"])
    entry_b = documents_service.delete_document("proj", b["id"])

    assert trash_service.purge("proj", entry_a["id"]) is True
    assert trash_service.purge("proj", entry_a["id"]) is False
    assert [t["id"] for t in trash_service.list_trash("proj")] == [entry_b["id"]]

    assert trash_service.empty("proj") == 1
    assert trash_service.list_trash("proj") == []
    assert not (data_dir / ".trash" / "proj" / entry_b["id"]).exists()


# --- integration ------------------------------------------------------------


def test_deleting_project_clears_its_trash(data_dir, make_project):
    make_project("proj")
    doc = documents_service.create_document("proj", "A", content="a")
    documents_service.delete_document("proj", doc["id"])
    assert (data_dir / ".trash" / "proj").is_dir()

    projects_service.delete_project("proj")
    assert not (data_dir / ".trash" / "proj").exists()


def test_backup_skips_the_trash(data_dir, make_project):
    make_project("proj")
    doc = documents_service.create_document("proj", "A", content="a")
    documents_service.delete_document("proj", doc["id"])

    result = backup_service.create_backup()
    with zipfile.ZipFile(result["path"]) as zf:
        names = zf.namelist()
    assert not any(".trash" in name for name in names)
    # The live document is gone, so no copy of it should be in the backup.
    assert not any(name.endswith("01-a.md") for name in names)


# --- route ------------------------------------------------------------------


def test_trash_routes(tmp_path, monkeypatch):
    monkeypatch.setenv("IWAKURA_DATA_DIR", str(tmp_path / "data"))
    client = TestClient(create_app())
    headers = {"host": "127.0.0.1"}

    assert client.get("/api/projects/nope/trash", headers=headers).status_code == 404

    client.post("/api/projects", json={"name": "Demo"}, headers=headers)
    created = client.post(
        "/api/projects/demo/documents",
        json={"title": "Alpha", "kind": "chapter", "content": "hello world"},
        headers=headers,
    )
    doc_id = created.json()["id"]

    deleted = client.delete(f"/api/projects/demo/documents/{doc_id}", headers=headers)
    assert deleted.status_code == 200
    trash_id = deleted.json()["trashId"]

    listed = client.get("/api/projects/demo/trash", headers=headers)
    assert listed.status_code == 200
    assert [t["id"] for t in listed.json()] == [trash_id]

    restored = client.post(f"/api/projects/demo/trash/{trash_id}/restore", headers=headers)
    assert restored.status_code == 200
    assert restored.json()["newId"] == doc_id

    assert client.delete("/api/projects/demo/trash/deadbeef", headers=headers).status_code == 404
