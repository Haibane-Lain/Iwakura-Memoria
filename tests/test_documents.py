"""Service-level tests: word-stats invalidation (B3), reorder-tmp crash
recovery (R1), and a PDF export smoke test (R5)."""
from __future__ import annotations

import os
import time

from app.services import documents as documents_service
from app.services import projects as projects_service

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


# --- R5: PDF export smoke ---------------------------------------------------


def test_export_pdf_produces_pdf(data_dir, make_project):
    make_project("proj")
    documents_service.create_document("proj", "Chapter One", content="Hello world.")
    data = projects_service.export_pdf("proj")
    assert data[:4] == b"%PDF"
    assert len(data) > 1000
