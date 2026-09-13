"""Scene metadata: frontmatter round-trip, normalization, locking and the API.

Scene metadata (synopsis / status / pov / label / tags / target / beat) lives
in the same frontmatter block as title/type/styles. These tests pin that it
round-trips, that clearing a field removes the key, that unknown fields are
ignored, and that a metadata write can never clobber a concurrent autosave.
"""
from __future__ import annotations

import threading

import pytest
from fastapi.testclient import TestClient

from app import config
from app.main import create_app
from app.services import documents as documents_service


def _raw(data_dir, doc_id="01-alpha"):
    return (data_dir / "proj" / f"{doc_id}.md").read_text(encoding="utf-8")


# --- service: read / write / clear ------------------------------------------


def test_update_metadata_sets_and_reads_fields(data_dir, make_project):
    make_project("proj")
    doc = documents_service.create_document("proj", "Alpha", content="Body text")

    updated = documents_service.update_metadata(
        "proj",
        doc["id"],
        {
            "synopsis": "  A short summary.  ",
            "status": "drafted",
            "pov": "Mara",
            "label": "red",
            "tags": ["act-one", " act-one ", "mara"],
            "target": 1200,
            "beat": "opening-image",
        },
    )

    assert updated["synopsis"] == "A short summary."
    assert updated["status"] == "drafted"
    assert updated["pov"] == "Mara"
    assert updated["label"] == "red"
    assert updated["tags"] == ["act-one", "mara"]  # trimmed + deduped
    assert updated["target"] == 1200
    assert updated["beat"] == "opening-image"
    assert updated["content"] == "Body text"


def test_clearing_scene_fields_removes_the_keys(data_dir, make_project):
    make_project("proj")
    doc = documents_service.create_document("proj", "Alpha", content="x")
    documents_service.update_metadata(
        "proj", doc["id"], {"status": "draft", "synopsis": "s", "tags": ["a"]}
    )

    cleared = documents_service.update_metadata(
        "proj", doc["id"], {"status": "", "synopsis": None, "tags": []}
    )

    assert cleared["status"] == ""
    assert cleared["synopsis"] == ""
    assert cleared["tags"] == []
    raw = _raw(data_dir)
    assert "status" not in raw
    assert "synopsis" not in raw
    assert "tags" not in raw


def test_unknown_fields_are_ignored(data_dir, make_project):
    make_project("proj")
    doc = documents_service.create_document("proj", "Alpha", content="x")

    updated = documents_service.update_metadata(
        "proj", doc["id"], {"author": "nobody", "target": 0, "status": "idea"}
    )

    assert "author" not in updated
    assert updated["target"] is None  # non-positive clears
    assert updated["status"] == "idea"
    assert "author" not in _raw(data_dir)


def test_tags_are_capped(data_dir, make_project):
    make_project("proj")
    doc = documents_service.create_document("proj", "Alpha", content="x")
    tags = [f"tag-{i}" for i in range(80)]
    updated = documents_service.update_metadata("proj", doc["id"], {"tags": tags})
    assert len(updated["tags"]) == documents_service._SCENE_TAG_MAX


def test_metadata_write_preserves_styles_and_body(data_dir, make_project):
    make_project("proj")
    doc = documents_service.create_document("proj", "Alpha", content="Keep me")
    documents_service.update_style("proj", doc["id"], "document", font="serif", size=20)

    documents_service.update_metadata("proj", doc["id"], {"status": "revised"})

    again = documents_service.get_document("proj", doc["id"])
    assert again["content"] == "Keep me"
    assert again["style"]["font"] == "serif"
    assert again["style"]["size"] == 20
    assert again["status"] == "revised"


def test_tree_summary_includes_scene_metadata(data_dir, make_project):
    make_project("proj")
    doc = documents_service.create_document("proj", "Alpha", content="one two")
    documents_service.update_metadata(
        "proj", doc["id"], {"status": "final", "label": "blue", "target": 500}
    )

    summary = documents_service.get_tree("proj")["documents"][0]

    assert summary["status"] == "final"
    assert summary["label"] == "blue"
    assert summary["target"] == 500
    assert summary["words"] == 2


def test_metadata_does_not_clobber_a_concurrent_save(data_dir, make_project, monkeypatch):
    make_project("proj")
    doc = documents_service.create_document("proj", "Alpha", content="one")

    original = config._write_atomic
    meta_writing = threading.Event()
    save_written = threading.Event()

    def gated_write(path, content):
        if "two" in content:
            original(path, content)
            save_written.set()
            return
        # The metadata write: pause between its read and write so the save can
        # land. Without the lock this loses the save; with it the save waits.
        meta_writing.set()
        save_written.wait(1.0)
        original(path, content)

    monkeypatch.setattr(config, "_write_atomic", gated_write)

    meta_thread = threading.Thread(
        target=documents_service.update_metadata,
        args=("proj", doc["id"], {"status": "draft"}),
    )
    meta_thread.start()
    assert meta_writing.wait(2.0), "the metadata write was reached"

    save_thread = threading.Thread(
        target=documents_service.save_document,
        args=("proj", doc["id"], "two"),
        kwargs={"snapshot": False},
    )
    save_thread.start()
    save_thread.join(5)
    meta_thread.join(5)

    final = documents_service.get_document("proj", doc["id"])
    assert final["content"] == "two", "the newer body survived"
    assert final["status"] == "draft", "the metadata survived"


# --- route ------------------------------------------------------------------


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("IWAKURA_DATA_DIR", str(tmp_path / "data"))
    return TestClient(create_app())


_H = {"host": "127.0.0.1"}


def test_patch_route_updates_metadata_and_title(client):
    project = client.post("/api/projects", json={"name": "Proj"}, headers=_H).json()
    pid = project["id"]
    doc = client.post(
        f"/api/projects/{pid}/documents",
        json={"title": "Alpha", "kind": "chapter"},
        headers=_H,
    ).json()
    doc_id = doc["id"]

    patched = client.patch(
        f"/api/projects/{pid}/documents/{doc_id}",
        json={"status": "draft", "pov": "Mara", "title": "Renamed"},
        headers=_H,
    )
    assert patched.status_code == 200, patched.text
    body = patched.json()
    assert body["title"] == "Renamed"
    assert body["status"] == "draft"
    assert body["pov"] == "Mara"

    # An omitted field is left alone; an explicit value updates only itself.
    again = client.patch(
        f"/api/projects/{pid}/documents/{doc_id}",
        json={"label": "gold"},
        headers=_H,
    ).json()
    assert again["label"] == "gold"
    assert again["status"] == "draft"
    assert again["title"] == "Renamed"


def test_patch_route_clears_a_field(client):
    project = client.post("/api/projects", json={"name": "Proj"}, headers=_H).json()
    pid = project["id"]
    doc = client.post(
        f"/api/projects/{pid}/documents",
        json={"title": "Alpha", "kind": "note"},
        headers=_H,
    ).json()

    client.patch(
        f"/api/projects/{pid}/documents/{doc['id']}",
        json={"status": "draft"},
        headers=_H,
    )
    cleared = client.patch(
        f"/api/projects/{pid}/documents/{doc['id']}",
        json={"status": ""},
        headers=_H,
    ).json()
    assert cleared["status"] == ""
