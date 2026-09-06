"""Wikilink rewrite on structural changes (reorders, moves, renames).

Documents are id'd by path, so any reorder/move/rename re-ids them; path-form
[[...]] links would silently break without a rewrite pass. These tests pin the
rewrite behavior of app/services/documents.py.

Note: folder ids keep their display case (``01-Sub``), document ids are
lowercased slugs (``01-alpha``).
"""
from __future__ import annotations

from app.services import documents as documents_service


def _body(project_id: str, doc_id: str) -> str:
    return documents_service.get_document(project_id, doc_id)["content"]


# --- reorder within one folder ----------------------------------------------


def test_reorder_rewrites_path_links(data_dir, make_project):
    make_project("proj")
    documents_service.create_document("proj", "Alpha", content="See [[02-beta]].")
    documents_service.create_document("proj", "Beta", content="b")
    documents_service.create_document("proj", "Gamma", content="g")

    documents_service.reorder_documents("proj", ["02-beta", "01-alpha", "03-gamma"])

    assert _body("proj", "02-alpha") == "See [[01-beta]]."


def test_reorder_rewrites_md_suffixed_links(data_dir, make_project):
    make_project("proj")
    documents_service.create_document("proj", "Alpha", content="See [[02-beta.md]].")
    documents_service.create_document("proj", "Beta", content="b")

    documents_service.reorder_documents("proj", ["02-beta", "01-alpha"])

    assert _body("proj", "02-alpha") == "See [[01-beta]]."


def test_reorder_rewrites_links_to_docs_inside_renumbered_folder(data_dir, make_project):
    make_project("proj")
    documents_service.create_folder("proj", "Sub")
    documents_service.create_document("proj", "Inner", folder="01-Sub", content="i")
    documents_service.create_document("proj", "Other", content="See [[01-Sub/01-inner]].")

    # Swap folder and doc in the root order: 01-Sub -> 02-Sub.
    documents_service.reorder_documents("proj", ["02-other", "01-Sub"])

    assert _body("proj", "01-other") == "See [[02-Sub/01-inner]]."


# --- document moves ----------------------------------------------------------


def test_cross_folder_move_rewrites_links(data_dir, make_project):
    make_project("proj")
    documents_service.create_folder("proj", "Scenes")  # consumes prefix 01
    documents_service.create_document("proj", "Alpha", content="See [[03-beta]].")
    documents_service.create_document("proj", "Beta", content="b")

    moved = documents_service.move_document("proj", "03-beta", "01-Scenes")

    assert moved["id"] == "01-Scenes/01-beta"
    assert _body("proj", "02-alpha") == "See [[01-Scenes/01-beta]]."


def test_same_folder_move_index_rewrites_links(data_dir, make_project):
    make_project("proj")
    documents_service.create_document("proj", "Alpha", content="See [[02-beta]].")
    documents_service.create_document("proj", "Beta", content="b")
    documents_service.create_document("proj", "Gamma", content="g")

    # Move Beta to the front of the root order.
    documents_service.move_document("proj", "02-beta", "", 0)

    assert _body("proj", "02-alpha") == "See [[01-beta]]."


def test_noop_move_rewrites_nothing(data_dir, make_project):
    make_project("proj")
    documents_service.create_document("proj", "Alpha", content="See [[02-beta]].")
    documents_service.create_document("proj", "Beta", content="b")

    documents_service.move_document("proj", "02-beta", "", None)

    assert _body("proj", "01-alpha") == "See [[02-beta]]."


# --- folder moves and renames ------------------------------------------------


def test_folder_move_rewrites_inner_doc_links(data_dir, make_project):
    make_project("proj")
    documents_service.create_folder("proj", "Sub")
    documents_service.create_document("proj", "Inner", folder="01-Sub", content="i")
    documents_service.create_folder("proj", "Scenes")
    documents_service.create_document(
        "proj", "Ref", content="See [[01-Sub/01-inner]]."
    )

    documents_service.move_folder("proj", "01-Sub", "02-Scenes")

    assert _body("proj", "03-ref") == "See [[02-Scenes/01-Sub/01-inner]]."


def test_rename_folder_rewrites_inner_doc_links(data_dir, make_project):
    make_project("proj")
    documents_service.create_folder("proj", "Sub")
    documents_service.create_document("proj", "Inner", folder="01-Sub", content="i")
    documents_service.create_document("proj", "Ref", content="See [[01-Sub/01-inner]].")

    documents_service.rename_folder("proj", "01-Sub", "Stories")

    assert _body("proj", "02-ref") == "See [[01-Stories/01-inner]]."


# --- document rename: title-form links ---------------------------------------


def test_rename_document_rewrites_title_links_but_not_path_links(data_dir, make_project):
    make_project("proj")
    documents_service.create_document("proj", "Alpha", content="a")
    documents_service.create_document(
        "proj", "Beta", content="See [[Alpha]] and [[01-alpha]]."
    )

    documents_service.rename_document("proj", "01-alpha", "Alpha Prime")

    assert _body("proj", "02-beta") == "See [[Alpha Prime]] and [[01-alpha]]."


def test_title_links_survive_move(data_dir, make_project):
    make_project("proj")
    documents_service.create_folder("proj", "Scenes")  # consumes prefix 01
    documents_service.create_document("proj", "Alpha", content="a")
    documents_service.create_document("proj", "Beta", content="See [[Alpha]].")

    moved = documents_service.move_document("proj", "02-alpha", "01-Scenes")

    assert moved["id"] == "01-Scenes/01-alpha"
    assert _body("proj", "03-beta") == "See [[Alpha]]."