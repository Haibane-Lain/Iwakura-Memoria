"""Tests for the full-text search service and route.

The service is pure-Python, so most coverage is service-level on a throwaway
project; the route test pins the request/response wiring and the 404/400s.
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from app.services import search as search_service


def _doc(root, rel, body, title=None, doc_type="note"):
    path = root / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    meta = f"---\ntitle: {title}\ntype: {doc_type}\n---\n" if title else ""
    path.write_text(meta + body, encoding="utf-8")
    return path


def _hits(result, doc_id=0):
    return result["results"][doc_id]["matches"]


# --- matching ---------------------------------------------------------------


def test_search_is_case_insensitive_by_default(data_dir, make_project):
    make_project("proj")
    _doc(data_dir / "proj", "01.md", "The Wolf ran through the forest.", title="Chapter One")

    result = search_service.search("proj", "wolf")
    assert result["totalMatches"] == 1
    assert result["documentsMatched"] == 1
    assert result["results"][0]["docId"] == "01"
    assert _hits(result)[0]["match"] == "Wolf"


def test_case_sensitive_option(data_dir, make_project):
    make_project("proj")
    _doc(data_dir / "proj", "01.md", "Wolf and wolf.", title="A")

    assert search_service.search("proj", "wolf", case_sensitive=True)["totalMatches"] == 1
    assert search_service.search("proj", "Wolf", case_sensitive=True)["totalMatches"] == 1
    assert search_service.search("proj", "wolf")["totalMatches"] == 2


def test_whole_word_option(data_dir, make_project):
    make_project("proj")
    _doc(data_dir / "proj", "01.md", "A cat in a category.", title="A")

    assert search_service.search("proj", "cat")["totalMatches"] == 2
    assert search_service.search("proj", "cat", whole_word=True)["totalMatches"] == 1


def test_search_matches_cleaned_prose_not_markup(data_dir, make_project):
    make_project("proj")
    _doc(
        data_dir / "proj",
        "01.md",
        "She met [[Mara]] near the picture ![alt](assets/secret-map.png)",
        title="A",
    )

    assert search_service.search("proj", "Mara")["totalMatches"] == 1
    assert search_service.search("proj", "secret-map")["totalMatches"] == 0


def test_cjk_text_is_searchable(data_dir, make_project):
    make_project("proj")
    _doc(data_dir / "proj", "01.md", "他是英雄。他是英雄。", title="A")

    assert search_service.search("proj", "英雄")["totalMatches"] == 2


# --- snippets and ordinals --------------------------------------------------


def test_snippets_include_context_and_ellipses(data_dir, make_project):
    make_project("proj")
    body = "x" * 80 + " needle " + "y" * 80
    _doc(data_dir / "proj", "01.md", body, title="A")

    hit = _hits(search_service.search("proj", "needle"))[0]
    assert hit["match"] == "needle"
    assert hit["before"].startswith("\u2026")
    assert hit["after"].endswith("\u2026")


def test_occurrence_ordinals_increment_per_document(data_dir, make_project):
    make_project("proj")
    _doc(data_dir / "proj", "01.md", "cat dog cat dog cat", title="A")

    assert [hit["occurrence"] for hit in _hits(search_service.search("proj", "cat"))] == [0, 1, 2]


# --- scope ------------------------------------------------------------------


def test_scope_splits_write_and_wiki(data_dir, make_project):
    make_project("proj")
    root = data_dir / "proj"
    _doc(root, "01.md", "dragon", title="Chapter")
    _doc(root, "worldbuilding/characters/01-mara.md", "dragon", title="Mara")

    everything = search_service.search("proj", "dragon")
    assert everything["documentsMatched"] == 2

    write = search_service.search("proj", "dragon", scope="write")
    assert [group["docId"] for group in write["results"]] == ["01"]

    wiki = search_service.search("proj", "dragon", scope="wiki")
    assert [group["docId"] for group in wiki["results"]] == ["worldbuilding/characters/01-mara"]


def test_document_scope_via_selection(data_dir, make_project):
    make_project("proj")
    root = data_dir / "proj"
    _doc(root, "01.md", "dragon", title="A")
    _doc(root, "02.md", "dragon", title="B")

    result = search_service.search("proj", "dragon", scope="document", documents=["01"])
    assert [group["docId"] for group in result["results"]] == ["01"]


# --- caps -------------------------------------------------------------------


def test_matches_are_capped(data_dir, make_project):
    make_project("proj")
    _doc(data_dir / "proj", "01.md", "x " * 300, title="A")

    result = search_service.search("proj", "x")
    assert result["totalMatches"] == 300
    assert result["results"][0]["count"] == 300
    assert len(result["results"][0]["matches"]) == 50  # per-document cap
    assert result["truncated"] is True


# --- validation -------------------------------------------------------------


def test_empty_query_raises(data_dir, make_project):
    make_project("proj")
    with pytest.raises(ValueError):
        search_service.search("proj", "   ")


def test_overlong_query_raises(data_dir, make_project):
    make_project("proj")
    with pytest.raises(ValueError):
        search_service.search("proj", "a" * 201)


# --- route ------------------------------------------------------------------


def test_search_route(tmp_path, monkeypatch):
    monkeypatch.setenv("IWAKURA_DATA_DIR", str(tmp_path / "data"))
    client = TestClient(create_app())
    headers = {"host": "127.0.0.1"}

    missing = client.post("/api/projects/nope/search", json={"query": "x"}, headers=headers)
    assert missing.status_code == 404

    client.post("/api/projects", json={"name": "Demo"}, headers=headers)
    client.post(
        "/api/projects/demo/documents",
        json={"title": "Alpha", "kind": "chapter", "content": "The wolf ran."},
        headers=headers,
    )

    ok = client.post("/api/projects/demo/search", json={"query": "wolf"}, headers=headers)
    assert ok.status_code == 200
    assert ok.json()["totalMatches"] == 1

    empty = client.post("/api/projects/demo/search", json={"query": "  "}, headers=headers)
    assert empty.status_code == 400
