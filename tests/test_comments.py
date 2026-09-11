"""Per-document comments: storage, rekey/lifecycle, backup, and routes.

A comment is anchored in the document by an inline ``data-cid`` marker and its
body lives in a data-root sidecar. Service coverage runs against a throwaway
project; the route test pins the request/response wiring.
"""
from __future__ import annotations

import zipfile

from fastapi.testclient import TestClient

from app.main import create_app
from app.services import backup as backup_service
from app.services import comments as comments_service
from app.services import documents as documents_service
from app.services import projects as projects_service


def _doc(project_id="proj", title="Scene", content="hello world"):
    return documents_service.create_document(project_id, title, content=content)


# --- create / list / update / delete ---------------------------------------


def test_create_list_update_delete(data_dir, make_project):
    make_project("proj")
    doc = _doc()
    comment = comments_service.create(
        "proj", doc["id"], "  Tighten this.  ", quote="hello world"
    )
    assert comment["id"].startswith("c_")
    assert comment["body"] == "Tighten this."
    assert comment["docId"] == doc["id"]
    assert comment["resolved"] is False
    assert comment["resolvedAt"] is None

    listed = comments_service.list_doc("proj", doc["id"])
    assert [c["id"] for c in listed] == [comment["id"]]

    resolved = comments_service.update("proj", doc["id"], comment["id"], resolved=True)
    assert resolved["resolved"] is True
    assert resolved["resolvedAt"]

    edited = comments_service.update("proj", doc["id"], comment["id"], body="Shorter.")
    assert edited["body"] == "Shorter."
    assert edited["resolved"] is True  # editing does not un-resolve

    unreolved = comments_service.update("proj", doc["id"], comment["id"], resolved=False)
    assert unreolved["resolved"] is False and unreolved["resolvedAt"] is None

    assert comments_service.delete("proj", doc["id"], comment["id"]) is True
    assert comments_service.delete("proj", doc["id"], comment["id"]) is False
    assert comments_service.list_doc("proj", doc["id"]) == []


def test_empty_body_is_rejected(data_dir, make_project):
    make_project("proj")
    try:
        comments_service.create("proj", "doc", "   ")
    except ValueError:
        pass
    else:
        raise AssertionError("expected ValueError")


def test_update_unknown_comment_raises(data_dir, make_project):
    make_project("proj")
    try:
        comments_service.update("proj", "doc", "c_deadbeef0000", body="x")
    except FileNotFoundError:
        pass
    else:
        raise AssertionError("expected FileNotFoundError")


def test_clear_resolved_only(data_dir, make_project):
    make_project("proj")
    first = comments_service.create("proj", "doc", "first")
    second = comments_service.create("proj", "doc", "second")
    comments_service.update("proj", "doc", first["id"], resolved=True)

    assert comments_service.clear_doc("proj", "doc", resolved_only=True) == 1
    assert [c["id"] for c in comments_service.list_doc("proj", "doc")] == [second["id"]]

    assert comments_service.clear_doc("proj", "doc") == 1
    assert comments_service.list_doc("proj", "doc") == []


# --- rekey / lifecycle ------------------------------------------------------


def test_rekey_map_moves_comments(data_dir, make_project):
    make_project("proj")
    comment = comments_service.create("proj", "Part/one", "note", quote="text")

    moved = comments_service.rekey_map("proj", {"Part/one": "Part/01-one"})

    assert moved == 1
    assert comments_service.list_doc("proj", "Part/one") == []
    listed = comments_service.list_doc("proj", "Part/01-one")
    assert [c["id"] for c in listed] == [comment["id"]]
    assert listed[0]["docId"] == "Part/01-one"


def test_moving_a_document_moves_its_comments(data_dir, make_project):
    make_project("proj")
    folder = documents_service.create_folder("proj", "Archive")
    doc = _doc()
    comment = comments_service.create("proj", doc["id"], "note")

    moved = documents_service.move_document("proj", doc["id"], folder)
    new_id = moved["id"]

    assert new_id != doc["id"]
    assert comments_service.list_doc("proj", doc["id"]) == []
    assert [c["id"] for c in comments_service.list_doc("proj", new_id)] == [comment["id"]]


def test_trash_keeps_comments(data_dir, make_project):
    """Deleting a document moves it to the bin; a restore must get its notes back."""
    make_project("proj")
    doc = _doc()
    comments_service.create("proj", doc["id"], "note")

    documents_service.delete_document("proj", doc["id"])

    assert comments_service.list_doc("proj", doc["id"]) != []


def test_delete_project_clears_comments(data_dir, make_project):
    make_project("proj")
    comments_service.create("proj", "doc", "note")
    assert (data_dir / ".comments" / "proj").is_dir()

    projects_service.delete_project("proj")

    assert not (data_dir / ".comments" / "proj").exists()


def test_backup_includes_comments(data_dir, make_project):
    make_project("proj")
    comments_service.create("proj", "doc", "keep me")
    result = backup_service.create_backup()

    with zipfile.ZipFile(result["path"]) as zf:
        names = zf.namelist()
    assert any(".comments" in name and name.endswith(".json") for name in names)


# --- routes -----------------------------------------------------------------


def _project_client(tmp_path, monkeypatch):
    monkeypatch.setenv("IWAKURA_DATA_DIR", str(tmp_path / "data"))
    client = TestClient(create_app())
    return client, {"host": "127.0.0.1"}


def test_comment_routes(tmp_path, monkeypatch):
    client, headers = _project_client(tmp_path, monkeypatch)

    assert (
        client.get("/api/projects/nope/comments?docId=x", headers=headers).status_code
        == 404
    )

    client.post("/api/projects", json={"name": "Demo"}, headers=headers)
    created = client.post(
        "/api/projects/demo/documents",
        json={"title": "Scene", "kind": "chapter", "content": "hello"},
        headers=headers,
    )
    doc_id = created.json()["id"]

    made = client.post(
        "/api/projects/demo/comments",
        json={"docId": doc_id, "body": "Trim this", "quote": "hello"},
        headers=headers,
    )
    assert made.status_code == 201
    comment_id = made.json()["id"]

    listed = client.get(
        f"/api/projects/demo/comments?docId={doc_id}", headers=headers
    )
    assert listed.status_code == 200
    assert len(listed.json()) == 1

    updated = client.put(
        f"/api/projects/demo/comments/{comment_id}",
        json={"docId": doc_id, "resolved": True},
        headers=headers,
    )
    assert updated.status_code == 200
    assert updated.json()["resolved"] is True

    # A comment on a missing document is refused.
    missing = client.post(
        "/api/projects/demo/comments",
        json={"docId": "nope", "body": "x"},
        headers=headers,
    )
    assert missing.status_code == 404

    assert (
        client.delete(
            f"/api/projects/demo/comments/{comment_id}?docId={doc_id}", headers=headers
        ).status_code
        == 200
    )
    assert (
        client.delete(
            "/api/projects/demo/comments/c_deadbeef0000?docId=" + doc_id, headers=headers
        ).status_code
        == 404
    )

    client.post(
        "/api/projects/demo/comments",
        json={"docId": doc_id, "body": "again"},
        headers=headers,
    )
    cleared = client.delete(
        f"/api/projects/demo/comments?docId={doc_id}", headers=headers
    )
    assert cleared.status_code == 200
    assert cleared.json()["removed"] == 1
    assert (
        client.get(
            f"/api/projects/demo/comments?docId={doc_id}", headers=headers
        ).json()
        == []
    )
