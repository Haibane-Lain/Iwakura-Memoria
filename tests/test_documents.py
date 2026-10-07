"""Service-level tests: word-stats invalidation (B3), reorder-tmp crash
recovery (R1), and a PDF export smoke test (R5)."""
from __future__ import annotations

import os
import time

import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from app.services import documents as documents_service
from app.services import projects as projects_service


@pytest.fixture
def client(tmp_path, monkeypatch):
    """TestClient whose data dir is a throwaway folder (like test_security)."""
    monkeypatch.setenv("IWAKURA_DATA_DIR", str(tmp_path / "data"))
    return TestClient(create_app())


# --- B3: word-stats cache invalidation --------------------------------------


def test_word_stats_not_inflated_after_move(data_dir, make_project):
    make_project("proj")
    (data_dir / "proj" / "One").mkdir()
    d1 = documents_service.create_document("proj", "Alpha", content="x")
    documents_service.create_document("proj", "Beta", content="x")
    assert documents_service.project_word_stats("proj")["words"] == 2

    # Moving renumbers ids; the stats cache must not keep stale entries.
    moved = documents_service.move_document("proj", d1["id"], "One")
    assert moved["id"] == "One/01-alpha"
    assert documents_service.project_word_stats("proj")["words"] == 2

    # Editing the moved doc under its NEW id must not double-count it.
    documents_service.save_document("proj", moved["id"], "x")
    assert documents_service.project_word_stats("proj")["words"] == 2


def test_word_stats_after_delete_folder(data_dir, make_project):
    make_project("proj")
    folder = (data_dir / "proj" / "Scenes")
    folder.mkdir()
    documents_service.create_document("proj", "Alpha", folder="Scenes", content="x")
    documents_service.create_document("proj", "Beta", content="x")
    assert documents_service.project_word_stats("proj")["words"] == 2

    documents_service.delete_folder("proj", "Scenes")
    assert documents_service.project_word_stats("proj")["words"] == 1


# --- R1: .reorder-tmp crash recovery ----------------------------------------


def test_recover_reorder_tmp_restores_stale_staging(data_dir, make_project):
    make_project("proj")
    (data_dir / "proj" / "sub").mkdir()
    tmp = data_dir / "proj" / "sub" / ".reorder-tmp"
    tmp.mkdir()
    (tmp / "01-alpha.md").write_text("# x", encoding="utf-8")
    now = time.time()
    os.utime(tmp, (now - 3600, now - 3600))  # 1 h old = crash artifact

    assert documents_service.recover_reorder_tmp() == 1
    assert (data_dir / "proj" / "sub" / "01-alpha.md").exists()
    assert not tmp.exists()


def test_recover_reorder_tmp_leaves_fresh_staging(data_dir, make_project):
    make_project("proj")
    tmp = data_dir / "proj" / ".reorder-tmp"
    tmp.mkdir()
    (tmp / "01-alpha.md").write_text("# x", encoding="utf-8")  # fresh — still renumbering

    assert documents_service.recover_reorder_tmp() == 0
    assert (tmp / "01-alpha.md").exists()


def test_recover_reorder_tmp_noop_when_absent(data_dir, make_project):
    make_project("proj")
    assert documents_service.recover_reorder_tmp() == 0


def test_failed_reorder_keeps_every_document(data_dir, make_project, monkeypatch):
    """A move that fails mid-renumber must not delete the staged documents.

    Regression for the unconditional `rmtree` that used to wipe whatever was
    still sitting in .reorder-tmp when a move raised.
    """
    make_project("proj")
    documents_service.create_document("proj", "Alpha", content="aaa")
    documents_service.create_document("proj", "Beta", content="bbb")
    documents_service.create_document("proj", "Gamma", content="ccc")

    real_move = documents_service.shutil.move
    calls = {"n": 0}

    def flaky(src, dst, *args, **kwargs):
        calls["n"] += 1
        # Moves 1-3 stage into .reorder-tmp, 4-6 move back out. Fail on the
        # second unstage, leaving two documents still staged.
        if calls["n"] == 5:
            raise OSError("locked by another process")
        return real_move(src, dst, *args, **kwargs)

    project = data_dir / "proj"
    monkeypatch.setattr(documents_service.shutil, "move", flaky)
    with pytest.raises(OSError):
        documents_service.reorder_documents("proj", ["03-gamma", "01-alpha", "02-beta"])

    # Nothing was deleted: all three bodies survive, in the folder or staged.
    in_place = {p.name for p in project.glob("*.md")}
    tmp = project / ".reorder-tmp"
    staged = {p.name for p in tmp.glob("*.md")} if tmp.is_dir() else set()
    assert len(in_place | staged) == 3, (in_place, staged)
    assert len(in_place) == 1 and len(staged) == 2

    # The startup recovery puts the staged entries back. Restore only the
    # patched move (undoing the whole monkeypatch would also drop the test's
    # IWAKURA_DATA_DIR override).
    monkeypatch.setattr(documents_service.shutil, "move", real_move)
    old = time.time() - 3600
    os.utime(tmp, (old, old))
    documents_service.recover_reorder_tmp()
    restored = list(project.glob("*.md"))
    assert len(restored) == 3
    text = "".join(p.read_text(encoding="utf-8") for p in restored)
    for body in ("aaa", "bbb", "ccc"):
        assert body in text


# --- R5: PDF export smoke ---------------------------------------------------


def test_export_pdf_produces_pdf(data_dir, make_project):
    make_project("proj")
    documents_service.create_document("proj", "Chapter One", content="Hello world.")
    data = projects_service.export_pdf("proj")
    assert data[:4] == b"%PDF"
    assert len(data) > 1000


# --- Word-stats document count ----------------------------------------------


def test_word_stats_doc_count_stable_after_first_save(data_dir, make_project):
    """Writing into a previously-empty doc must not count it a second time.

    The full scan counts every document (chapters & notes), and the incremental
    update used to add one again on the 0-word -> words transition.
    """
    make_project("proj")
    doc = documents_service.create_document("proj", "Empty")
    # Build the cache from disk: the empty document is already counted.
    assert documents_service.project_word_stats("proj")["documents"] == 1

    documents_service.save_document("proj", doc["id"], "one two")
    stats = documents_service.project_word_stats("proj")
    assert stats["documents"] == 1
    assert stats["words"] == 2


def test_word_stats_counts_a_document_new_to_the_cache(data_dir, make_project):
    """A document that appears after the cache was built still adds one."""
    # A unique project id: the word-stats cache is a module global that outlives
    # a test, so reusing "proj" could observe another test's cached count.
    make_project("newdocproj")
    assert documents_service.project_word_stats("newdocproj")["documents"] == 0

    (data_dir / "newdocproj" / "01-alpha.md").write_text(
        "---\ntitle: Alpha\n---\n\n", encoding="utf-8"
    )
    documents_service.save_document("newdocproj", "01-alpha", "hello")

    stats = documents_service.project_word_stats("newdocproj")
    assert stats["documents"] == 1
    assert stats["words"] == 1


# --- Non-UTF-8 files ---------------------------------------------------------


def test_tree_and_stats_tolerate_non_utf8(data_dir, make_project):
    """A hand-edited cp1252 byte must not 400 the tree or 500 the library.

    Reads that only display or count decode with ``errors="replace"``, the same
    as ``iter_documents``; the read-modify-write paths stay strict on purpose so
    a save never rewrites the bad byte as U+FFFD.
    """
    make_project("proj")
    (data_dir / "proj" / "01-cafe.md").write_bytes(
        b"---\ntitle: Caf\xe9\n---\nCaf\xe9 body\n"
    )

    tree = documents_service.get_tree("proj")
    assert [d["id"] for d in tree["documents"]] == ["01-cafe"]

    doc = documents_service.get_document("proj", "01-cafe")
    assert "body" in doc["content"]

    stats = documents_service.project_word_stats("proj")
    assert stats["documents"] == 1


# --- HTTP status for a missing document --------------------------------------


def test_missing_document_is_404_not_503(client):
    headers = {"host": "127.0.0.1"}
    created = client.post("/api/projects", json={"name": "Demo"}, headers=headers)
    assert created.status_code in (200, 201)

    missing = client.get("/api/projects/demo/documents/nope", headers=headers)
    assert missing.status_code == 404

    # A missing project is a 404 too, not a "file busy" 503.
    assert (
        client.get("/api/projects/ghost/documents/nope", headers=headers).status_code
        == 404
    )


# --- Chapter review colors ---------------------------------------------------


def test_chapter_color_round_trips(data_dir, make_project):
    make_project("proj")
    doc = documents_service.create_document("proj", "Alpha", kind="chapter", content="x")
    assert doc["color"] is None

    updated = documents_service.update_color("proj", doc["id"], "red")
    assert updated["color"] == "red"

    # The tree summary carries it too, so the sidebar can render the mark.
    tree = documents_service.get_tree("proj")
    assert tree["documents"][0]["color"] == "red"

    # It lives in frontmatter, not in memory.
    raw = (data_dir / "proj" / f"{doc['id']}.md").read_text(encoding="utf-8")
    assert "color: red" in raw


def test_chapter_color_clears_and_rejects_unknown(data_dir, make_project):
    make_project("proj")
    doc = documents_service.create_document("proj", "Alpha", kind="chapter")
    documents_service.update_color("proj", doc["id"], "yellow")
    assert documents_service.get_document("proj", doc["id"])["color"] == "yellow"

    cleared = documents_service.update_color("proj", doc["id"], None)
    assert cleared["color"] is None
    raw = (data_dir / "proj" / f"{doc['id']}.md").read_text(encoding="utf-8")
    assert "color" not in raw

    with pytest.raises(ValueError):
        documents_service.update_color("proj", doc["id"], "green")


def test_chapter_color_survives_rename(data_dir, make_project):
    make_project("proj")
    doc = documents_service.create_document("proj", "Alpha", kind="chapter")
    documents_service.update_color("proj", doc["id"], "red")
    renamed = documents_service.rename_document("proj", doc["id"], "Beta")
    assert renamed["color"] == "red"


def test_document_color_route(client):
    headers = {"host": "127.0.0.1"}
    client.post("/api/projects", json={"name": "Demo"}, headers=headers)
    created = client.post(
        "/api/projects/demo/documents",
        json={"title": "Opening", "kind": "chapter"},
        headers=headers,
    )
    assert created.status_code in (200, 201)
    doc_id = created.json()["id"]

    resp = client.put(
        f"/api/projects/demo/documents/{doc_id}/color",
        json={"color": "yellow"},
        headers=headers,
    )
    assert resp.status_code == 200
    assert resp.json()["color"] == "yellow"

    bad = client.put(
        f"/api/projects/demo/documents/{doc_id}/color",
        json={"color": "green"},
        headers=headers,
    )
    assert bad.status_code == 400
