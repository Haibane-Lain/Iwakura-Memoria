"""Tests for the project-wide find & replace service and route.

Replacement runs on the raw Markdown but only in prose, so the important
coverage is what it refuses to touch: code, HTML tags, image paths, link
destinations and wikilink targets. The route test pins the wiring and the
pre-change snapshot.
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from app.services import documents as documents_service
from app.services import replace as replace_service
from app.services import snapshots as snapshots_service


def _doc(root, rel, body, title=None, doc_type="note"):
    path = root / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    meta = f"---\ntitle: {title}\ntype: {doc_type}\n---\n" if title else ""
    path.write_text(meta + body, encoding="utf-8")
    return path


def _body(path):
    _meta, body = documents_service.parse_frontmatter(path.read_text(encoding="utf-8"))
    return body


def run_replace(query, replacement, **kwargs):
    return replace_service.replace_in_documents("proj", query, replacement, **kwargs)


# --- matching ---------------------------------------------------------------


def test_replace_changes_matching_documents(data_dir, make_project):
    make_project("proj")
    path = _doc(data_dir / "proj", "01.md", "The wolf ran. A wolf howled.", title="Alpha")

    result = run_replace("wolf", "fox")

    assert result["totalReplacements"] == 2
    assert result["documentsChanged"] == 1
    assert result["results"][0]["docId"] == "01"
    assert _body(path) == "The fox ran. A fox howled."
    assert "title: Alpha" in path.read_text(encoding="utf-8")  # frontmatter untouched


def test_replace_is_case_insensitive_by_default(data_dir, make_project):
    make_project("proj")
    path = _doc(data_dir / "proj", "01.md", "Wolf wolf wolves")
    run_replace("wolf", "fox")
    assert _body(path) == "fox fox wolves"


def test_case_sensitive_option(data_dir, make_project):
    make_project("proj")
    path = _doc(data_dir / "proj", "01.md", "Wolf wolf")
    run_replace("wolf", "fox", case_sensitive=True)
    assert _body(path) == "Wolf fox"


def test_whole_word_option(data_dir, make_project):
    make_project("proj")
    path = _doc(data_dir / "proj", "01.md", "cat category cat")
    run_replace("cat", "dog", whole_word=True)
    assert _body(path) == "dog category dog"


# --- protected regions ------------------------------------------------------


def test_replace_skips_code_markup_and_links(data_dir, make_project):
    make_project("proj")
    path = _doc(
        data_dir / "proj",
        "01.md",
        "target\n\n"
        "`target`\n\n"
        "```\ntarget\n```\n\n"
        '<aside data-x="target">target</aside>\n\n'
        "![target](assets/target.png)\n\n"
        "[target](https://example.com/target)\n\n"
        "[[target]]\n",
    )

    result = run_replace("target", "X")
    body = _body(path)

    assert body.startswith("X")
    assert "`target`" in body  # inline code untouched
    assert "```\ntarget\n```" in body  # fenced code untouched
    assert 'data-x="target"' in body  # tag attribute untouched
    assert ">X</aside>" in body  # the cell's text is prose
    assert "![target](assets/target.png)" in body  # image untouched
    assert "[X](https://example.com/target)" in body  # label replaced, URL not
    assert "[[target]]" in body  # wikilink target untouched
    # prose + link label + table cell text
    assert result["totalReplacements"] == 3


# --- safety -----------------------------------------------------------------


def test_replace_snapshots_before_change(data_dir, make_project):
    make_project("proj")
    doc = documents_service.create_document("proj", "Alpha", content="wolf wolf")

    run_replace("wolf", "fox")

    listed = snapshots_service.list_snapshots("proj", doc["id"])
    assert [snap["reason"] for snap in listed] == [snapshots_service.REASON_REPLACE]
    snap = snapshots_service.read_snapshot("proj", doc["id"], listed[0]["id"])
    assert "wolf wolf" in snap["content"]


def test_replace_writes_nothing_when_no_match(data_dir, make_project):
    make_project("proj")
    path = _doc(data_dir / "proj", "01.md", "no matches here", title="A")
    before = path.read_text(encoding="utf-8")

    result = run_replace("zebra", "horse")

    assert result["documentsChanged"] == 0
    assert result["totalReplacements"] == 0
    assert path.read_text(encoding="utf-8") == before


def test_cap_refuses_without_writing_anything(data_dir, make_project):
    make_project("proj")
    path = _doc(data_dir / "proj", "01.md", "x " * 10)

    with pytest.raises(ValueError):
        run_replace("x", "y", max_replacements=3)

    assert _body(path) == "x " * 10


# --- scope / validation -----------------------------------------------------


def test_replace_respects_scope(data_dir, make_project):
    make_project("proj")
    root = data_dir / "proj"
    write = _doc(root, "01.md", "dragon")
    wiki = _doc(root, "worldbuilding/characters/01-mara.md", "dragon")

    result = run_replace("dragon", "wyrm", scope="write")

    assert [entry["docId"] for entry in result["results"]] == ["01"]
    assert _body(write) == "wyrm"
    assert _body(wiki) == "dragon"


def test_empty_query_raises(data_dir, make_project):
    make_project("proj")
    with pytest.raises(ValueError):
        run_replace("   ", "x")


# --- route ------------------------------------------------------------------


def test_replace_route(tmp_path, monkeypatch):
    monkeypatch.setenv("IWAKURA_DATA_DIR", str(tmp_path / "data"))
    client = TestClient(create_app())
    headers = {"host": "127.0.0.1"}

    missing = client.post(
        "/api/projects/nope/replace",
        json={"query": "a", "replacement": "b"},
        headers=headers,
    )
    assert missing.status_code == 404

    client.post("/api/projects", json={"name": "Demo"}, headers=headers)
    created = client.post(
        "/api/projects/demo/documents",
        json={"title": "Alpha", "kind": "chapter", "content": "the wolf and the wolf"},
        headers=headers,
    )
    doc_id = created.json()["id"]

    ok = client.post(
        "/api/projects/demo/replace",
        json={"query": "wolf", "replacement": "fox"},
        headers=headers,
    )
    assert ok.status_code == 200
    assert ok.json()["totalReplacements"] == 2

    fetched = client.get(f"/api/projects/demo/documents/{doc_id}", headers=headers)
    assert fetched.json()["content"] == "the fox and the fox"

    # The pre-replace text is in the document's history, so it is reversible.
    history = client.get(f"/api/projects/demo/snapshots?docId={doc_id}", headers=headers)
    assert "replace" in [snap["reason"] for snap in history.json()]

    empty = client.post(
        "/api/projects/demo/replace",
        json={"query": "  ", "replacement": "x"},
        headers=headers,
    )
    assert empty.status_code == 400
