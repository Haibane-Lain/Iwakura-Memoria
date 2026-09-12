"""Concurrency tests for document writes.

A document save is read-modify-write (read the file, replace the body, write it
back), and structural operations (rename, reorder, move, delete) rename files
out from under open editors. Every one of those paths must serialize on the same
per-document lock or a well-timed autosave can clobber the newer body or
resurrect a file that was just moved away. These tests force the interleaving
with a gated ``config._write_atomic``.
"""
from __future__ import annotations

import threading

from app import config
from app.services import documents as documents_service


def _body(data_dir, project_id, doc_id):
    return documents_service.get_document(project_id, doc_id)["content"]


def test_update_style_does_not_clobber_a_concurrent_save(data_dir, make_project, monkeypatch):
    make_project("proj")
    doc = documents_service.create_document("proj", "Alpha", content="one")
    doc_id = doc["id"]

    original = config._write_atomic
    style_writing = threading.Event()
    save_written = threading.Event()

    def gated_write(path, content):
        if "two" in content:
            original(path, content)
            save_written.set()
            return
        # The style write: pause between its read and its write so the save can
        # land first. Without the lock this loses the save; with it the save is
        # blocked until the style write finishes.
        style_writing.set()
        save_written.wait(1.0)
        original(path, content)

    monkeypatch.setattr(config, "_write_atomic", gated_write)

    def do_style():
        documents_service.update_style("proj", doc_id, "document", font="serif")

    style_thread = threading.Thread(target=do_style)
    style_thread.start()
    assert style_writing.wait(2.0), "the style write was reached"

    save_thread = threading.Thread(
        target=documents_service.save_document,
        args=("proj", doc_id, "two"),
        kwargs={"snapshot": False},
    )
    save_thread.start()
    save_thread.join(5)
    style_thread.join(5)

    assert _body(data_dir, "proj", doc_id) == "two", "the newer body survived"
    assert documents_service.get_document("proj", doc_id)["style"]["font"] == "serif"


def test_rename_document_does_not_clobber_a_concurrent_save(data_dir, make_project, monkeypatch):
    make_project("proj")
    doc = documents_service.create_document("proj", "Alpha", content="one")
    doc_id = doc["id"]

    original = config._write_atomic
    rename_writing = threading.Event()
    save_written = threading.Event()

    def gated_write(path, content):
        if "two" in content:
            original(path, content)
            save_written.set()
            return
        rename_writing.set()
        save_written.wait(1.0)
        original(path, content)

    monkeypatch.setattr(config, "_write_atomic", gated_write)

    rename_thread = threading.Thread(
        target=documents_service.rename_document, args=("proj", doc_id, "Renamed")
    )
    rename_thread.start()
    assert rename_writing.wait(2.0), "the rename write was reached"

    save_thread = threading.Thread(
        target=documents_service.save_document,
        args=("proj", doc_id, "two"),
        kwargs={"snapshot": False},
    )
    save_thread.start()
    save_thread.join(5)
    rename_thread.join(5)

    document = documents_service.get_document("proj", doc_id)
    assert document["content"] == "two", "the newer body survived"
    assert document["title"] == "Renamed"


def test_reorder_does_not_resurrect_a_document_being_saved(data_dir, make_project, monkeypatch):
    make_project("proj")
    documents_service.create_document("proj", "Alpha", content="one")  # 01-alpha
    documents_service.create_document("proj", "Beta", content="b")  # 02-beta

    original = config._write_atomic
    save_writing = threading.Event()
    allow_save = threading.Event()

    def gated_write(path, content):
        if "two" in content:
            save_writing.set()
            allow_save.wait(3.0)
        original(path, content)

    monkeypatch.setattr(config, "_write_atomic", gated_write)

    save_errors: list[Exception] = []

    def do_save():
        try:
            documents_service.save_document("proj", "01-alpha", "two", snapshot=False)
        except Exception as exc:  # pragma: no cover - reported via the assertion
            save_errors.append(exc)

    def do_reorder():
        documents_service.reorder_documents("proj", ["02-beta", "01-alpha"])

    save_thread = threading.Thread(target=do_save)
    save_thread.start()
    assert save_writing.wait(2.0), "the save reached its write"

    reorder_thread = threading.Thread(target=do_reorder)
    reorder_thread.start()
    # Give the reorder a chance to run: with the lock it blocks on the save and
    # this wait just burns a moment; without it, it moves the file first.
    allow_save.wait(0.2)
    allow_save.set()
    save_thread.join(5)
    reorder_thread.join(5)

    assert save_errors == [], f"the save failed: {save_errors}"
    ids = {d["id"] for d in documents_service.iter_documents("proj")}
    # The saved document was renamed 01-alpha -> 02-alpha; the stale path must
    # not have been recreated as a duplicate.
    assert ids == {"02-alpha", "01-beta"}, ids
    assert _body(data_dir, "proj", "02-alpha") == "two"
