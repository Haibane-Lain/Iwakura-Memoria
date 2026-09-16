"""Import tests: bundles in, project tree out.

The service takes a flat list of ``(relative_path, bytes)`` — exactly what a
file picker, a folder picker, or a zip produces — and writes it as a new,
uniquely-named subtree. Everything here is about the pieces that make that
safe: folder structure, ordering, frontmatter, never overwriting, archive paths
that cannot escape, and an import that does not count as words written today.
"""
from __future__ import annotations

import io
import zipfile

import pytest
from PIL import Image

from app import config
from app.services import documents as documents_service
from app.services import import_docs as import_service


def png_bytes(width: int = 8, height: int = 6) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (width, height), (10, 120, 200)).save(buf, "PNG")
    return buf.getvalue()


def make_zip(entries: dict[str, bytes | str]) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as archive:
        for name, data in entries.items():
            archive.writestr(name, data if isinstance(data, bytes) else data.encode("utf-8"))
    return buf.getvalue()


def tree_ids(project_id: str) -> list[str]:
    """Every document id in the write tree, in on-disk order."""
    return [doc["id"] for doc in documents_service.iter_documents(project_id)]


# ---------------------------------------------------------------------------
# bundle plumbing
# ---------------------------------------------------------------------------


def test_paths_are_normalised_to_relative_labels():
    assert import_service.normalize_path("C:\\Vault\\Notes\\a.md") == "C:/Vault/Notes/a.md"
    assert import_service.normalize_path("../../etc/passwd") == "etc/passwd"
    assert import_service.normalize_path("./a/./b.md") == "a/b.md"


def test_tooling_folders_and_files_are_skipped():
    assert import_service.is_skipped(".obsidian/workspace.json")
    assert import_service.is_skipped("Vault/.git/config")
    assert import_service.is_skipped("__MACOSX/._a.md")
    assert import_service.is_skipped("Notes/.DS_Store")
    assert not import_service.is_skipped("Notes/Chapter One.md")


def test_zip_entries_are_unpacked_and_junk_dropped():
    raw = make_zip(
        {
            "Vault/Chapter One.md": "# One",
            "Vault/.obsidian/app.json": "{}",
            "__MACOSX/._Chapter One.md": b"\x00\x01",
        }
    )
    files = import_service.unpack([("vault.zip", raw)])
    assert [path for path, _ in files] == ["Vault/Chapter One.md"]
    assert import_service.detect([("vault.zip", raw)]) == "markdown"


def test_directory_entries_in_a_zip_are_ignored():
    raw = make_zip({"Act One/": b"", "Act One/a.md": "hi"})
    files = import_service.pack_zip(raw)
    assert [path for path, _ in files] == ["Act One/a.md"]


def test_a_zip_bomb_is_refused(monkeypatch):
    monkeypatch.setattr(import_service, "MAX_BUNDLE_BYTES", 10)
    raw = make_zip({"a.txt": "x" * 64})
    with pytest.raises(import_service.ImportLimitError):
        import_service.pack_zip(raw)


def test_detect_labels_the_families():
    assert import_service.detect([]) == "empty"
    assert import_service.detect([("a.md", b"")]) == "markdown"
    assert import_service.detect([("a.txt", b"")]) == "text"
    assert import_service.detect([("a.docx", b"")]) == "unsupported"


def test_an_unreadable_bundle_is_reported(make_project):
    make_project("p1")
    with pytest.raises(import_service.ImportDocsError):
        import_service.import_bundle("p1", None, [])
    with pytest.raises(import_service.ImportDocsError):
        import_service.import_bundle("p1", None, [("a.docx", b"PK\x03\x04")])


# ---------------------------------------------------------------------------
# Markdown and text
# ---------------------------------------------------------------------------


def test_markdown_bundle_becomes_folders_and_documents(make_project):
    make_project("p1")
    files = [
        ("Novel/01-open.md", b"---\ntitle: The Opening\ntype: chapter\n---\n\nIt began."),
        ("Novel/02-part/01-scene.md", b"---\ntitle: A Scene\ntags: [draft, act-one]\n---\n\nScene body."),
        ("Novel/02-part/02-scene.md", b"Just a body with no title."),
    ]
    summary = import_service.import_bundle("p1", None, files, {"name": "Novel"})

    assert summary["documents"] == 3
    assert summary["isFolder"] is True
    ids = tree_ids("p1")
    assert ids == [
        "01-Novel/01-the-opening",
        "01-Novel/02-Part/01-a-scene",
        "01-Novel/02-Part/02-scene",
    ]

    first = documents_service.get_document("p1", ids[0])
    assert first["title"] == "The Opening"
    assert first["kind"] == "chapter"
    assert "It began." in first["content"]

    nested = documents_service.get_document("p1", ids[1])
    assert nested["title"] == "A Scene"
    assert nested["tags"] == ["draft", "act-one"]

    # No frontmatter: the title comes from the file name.
    assert documents_service.get_document("p1", ids[2])["title"] == "Scene"


def test_plain_text_is_read_as_is(make_project):
    make_project("p1")
    import_service.import_bundle("p1", None, [("notes.txt", b"line one\r\nline two\r\n")])
    doc = documents_service.iter_documents("p1")[0]
    assert doc["body"].strip() == "line one\nline two"


def test_notes_can_be_imported_as_notes(make_project):
    make_project("p1")
    import_service.import_bundle("p1", None, [("a.md", b"body"), ("b.md", b"body")], {"as": "note"})
    kinds = {doc["kind"] for doc in documents_service.iter_documents("p1")}
    assert kinds == {"note"}


def test_frontmatter_type_wins_over_the_import_setting(make_project):
    make_project("p1")
    files = [("a.md", b"---\ntype: note\n---\nbody"), ("b.md", b"body")]
    import_service.import_bundle("p1", None, files, {"as": "chapter"})
    kinds = sorted(doc["kind"] for doc in documents_service.iter_documents("p1"))
    assert kinds == ["chapter", "note"]


# ---------------------------------------------------------------------------
# shape of the import
# ---------------------------------------------------------------------------


def test_a_single_document_lands_directly_in_the_target(make_project):
    make_project("p1")
    summary = import_service.import_bundle("p1", None, [("Chapter One.md", b"body")], {"name": "Ignored"})
    assert summary["isFolder"] is False
    assert summary["folder"] == "01-chapter-one"
    assert tree_ids("p1") == ["01-chapter-one"]


def test_import_into_an_existing_folder(make_project):
    make_project("p1")
    folder_id = documents_service.create_folder("p1", "Act One")
    import_service.import_bundle("p1", folder_id, [("a.md", b"body"), ("b.md", b"body")])
    assert all(doc_id.startswith(folder_id + "/") for doc_id in tree_ids("p1"))


def test_importing_twice_never_overwrites(make_project):
    make_project("p1")
    bundle = [("Act One/01-a.md", b"first"), ("Act One/02-b.md", b"second")]
    first = import_service.import_bundle("p1", None, bundle, {"name": "Act One"})
    second = import_service.import_bundle("p1", None, bundle, {"name": "Act One"})

    assert first["folder"] != second["folder"]
    assert len(tree_ids("p1")) == 4


def test_a_missing_folder_name_falls_back_to_the_bundle_root(make_project):
    make_project("p1")
    summary = import_service.import_bundle("p1", None, [("Act One/a.md", b"x"), ("Act One/b.md", b"y")])
    assert summary["folderTitle"] == "Act One"


def test_an_archive_cannot_escape_the_project(make_project):
    make_project("p1")
    raw = make_zip({"../../evil.md": "nope", "ok.md": "fine"})
    import_service.import_bundle("p1", None, [("bundle.zip", raw)])
    ids = tree_ids("p1")
    assert all(".." not in doc_id for doc_id in ids)
    assert len(ids) == 2


# ---------------------------------------------------------------------------
# side effects
# ---------------------------------------------------------------------------


def test_imported_words_are_not_written_today(make_project):
    folder = make_project("p1")
    import_service.import_bundle("p1", None, [("a.md", b"one two three four"), ("b.md", b"five six")])
    entries = documents_service.iter_documents("p1")
    assert sum(documents_service.count_words(doc["body"]) for doc in entries) == 6

    history = folder / config.STATS_DIRNAME / config.HISTORY_FILENAME
    assert all('"delta": 0' in line for line in history.read_text(encoding="utf-8").splitlines())


def test_images_are_stored_and_linked(make_project):
    folder = make_project("p1")
    outline = {
        "kind": "doc",
        "title": "With a Picture",
        "docKind": "chapter",
        "body": "Before\n\n![cover](@@img1@@)\n\nAfter",
        "children": [],
        "images": [{"key": "@@img1@@", "name": "cover.png", "bytes": png_bytes()}],
    }
    summary = import_service.write_outline("p1", None, outline)
    assert summary["images"] == 1

    doc = documents_service.iter_documents("p1")[0]
    assert f"{config.ASSETS_DIRNAME}/" in doc["body"]
    assert "@@img1@@" not in doc["body"]
    name = doc["body"].split(f"{config.ASSETS_DIRNAME}/")[1].split(")")[0]
    assert (folder / config.ASSETS_DIRNAME / name).exists()


def test_an_unreadable_image_is_dropped_not_fatal(make_project):
    make_project("p1")
    outline = {
        "kind": "doc",
        "title": "Bad Picture",
        "docKind": "chapter",
        "body": "Before ![bad](@@img1@@) After",
        "children": [],
        "images": [{"key": "@@img1@@", "name": "not-an-image.png", "bytes": b"not an image"}],
    }
    summary = import_service.write_outline("p1", None, outline)
    assert summary["images"] == 0
    doc = documents_service.iter_documents("p1")[0]
    assert "@@img1@@" not in doc["body"]


def test_a_too_large_bundle_is_refused_before_writing(make_project, monkeypatch):
    make_project("p1")
    monkeypatch.setattr(import_service, "MAX_BUNDLE_BYTES", 4)
    with pytest.raises(import_service.ImportLimitError):
        import_service.import_bundle("p1", None, [("a.md", b"way too long")])
    assert tree_ids("p1") == []
