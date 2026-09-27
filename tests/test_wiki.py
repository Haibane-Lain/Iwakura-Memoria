"""Wiki resolution and backlink tests.

``get_wiki`` walks the whole project (Write + Wiki) and resolves ``[[wikilinks]]``
against document ids and, failing that, titles. These pin the graph it returns —
notes, links, backlinks, broken targets and link counts — plus the HTTP route.
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from app.services import documents as documents_service
from app.services import wiki as wiki_service

HOST = {"host": "127.0.0.1"}


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("IWAKURA_DATA_DIR", str(tmp_path / "data"))
    return TestClient(create_app())


def _doc(project_id, title, content="Body.", folder=None, kind="note"):
    return documents_service.create_document(
        project_id, title, kind, folder=folder, content=content
    )


# --- resolve_wikilink (service) ---------------------------------------------


def test_resolve_wikilink_by_id(make_project):
    make_project("p1")
    doc = _doc("p1", "Mara")
    assert wiki_service.resolve_wikilink("p1", doc["id"]) == doc["id"]


def test_resolve_wikilink_by_title_ignores_case_and_spacing(make_project):
    make_project("p1")
    _doc("p1", "Mara Venn")
    assert wiki_service.resolve_wikilink("p1", "mara venn") == "01-mara-venn"
    # runs of whitespace normalize too
    assert wiki_service.resolve_wikilink("p1", "Mara   Venn") == "01-mara-venn"


def test_resolve_wikilink_falls_back_to_normalized_id(make_project):
    make_project("p1")
    _doc("p1", "Unrelated")
    assert wiki_service.resolve_wikilink("p1", "01-UNRELATED") == "01-unrelated"


def test_resolve_wikilink_missing_target_is_none(make_project):
    make_project("p1")
    _doc("p1", "Mara")
    assert wiki_service.resolve_wikilink("p1", "Nobody") is None


def test_resolve_wikilink_missing_project_raises(make_project):
    with pytest.raises(FileNotFoundError):
        wiki_service.resolve_wikilink("nope", "Anyone")


# --- get_wiki (service) -----------------------------------------------------


def test_get_wiki_resolves_links_backlinks_and_counts(make_project):
    make_project("p1")
    mara = _doc("p1", "Mara", "See [[Kestrel]] and [[Kestrel]] again.")
    kestrel = _doc("p1", "Kestrel", "Back to [[Mara|the captain]].")

    wiki = wiki_service.get_wiki("p1")

    assert {"from": mara["id"], "to": kestrel["id"]} in wiki["links"]
    assert {"from": kestrel["id"], "to": mara["id"]} in wiki["links"]
    # Mara links Kestrel twice, but the (from, to) pair counts once.
    assert wiki["links"].count({"from": mara["id"], "to": kestrel["id"]}) == 1
    assert wiki["linkCounts"] == {kestrel["id"]: 1, mara["id"]: 1}
    assert wiki["backlinks"][kestrel["id"]] == [mara["id"]]
    assert wiki["backlinks"][mara["id"]] == [kestrel["id"]]
    assert wiki["broken"] == {}


def test_get_wiki_reports_broken_targets_once_per_doc(make_project):
    make_project("p1")
    alpha = _doc("p1", "Alpha", "See [[Ghost]] and [[Ghost]] and [[Missing]].")
    beta = _doc("p1", "Beta", "Also [[Ghost]].")

    wiki = wiki_service.get_wiki("p1")

    assert wiki["broken"] == {alpha["id"]: ["Ghost", "Missing"], beta["id"]: ["Ghost"]}
    # a broken target never becomes a link, a backlink or a count
    assert all(link["to"] != "Ghost" for link in wiki["links"])
    assert "Ghost" not in wiki["linkCounts"]
    assert "Ghost" not in wiki["backlinks"]


def test_get_wiki_self_link(make_project):
    make_project("p1")
    loop = _doc("p1", "Loop", "See [[Loop]].")
    wiki = wiki_service.get_wiki("p1")
    assert {"from": loop["id"], "to": loop["id"]} in wiki["links"]
    assert wiki["backlinks"][loop["id"]] == [loop["id"]]


def test_get_wiki_includes_wiki_docs_with_their_category(make_project):
    make_project("p1")
    _doc("p1", "Chapter One", kind="chapter")
    _doc("p1", "Mara", folder="worldbuilding")
    _doc("p1", "Kestrel", folder="worldbuilding/characters")

    wiki = wiki_service.get_wiki("p1")
    by_title = {note["title"]: note for note in wiki["notes"]}

    assert by_title["Chapter One"]["kind"] == "chapter"
    assert by_title["Chapter One"]["category"] == ""
    assert by_title["Mara"]["category"] == "worldbuilding"
    assert by_title["Kestrel"]["category"] == "characters"


def test_get_wiki_empty_project(make_project):
    make_project("p1")
    assert wiki_service.get_wiki("p1") == {
        "notes": [],
        "links": [],
        "backlinks": {},
        "broken": {},
        "linkCounts": {},
    }


# --- route ------------------------------------------------------------------


def _make_project(client, name="P1") -> str:
    resp = client.post("/api/projects", json={"name": name}, headers=HOST)
    assert resp.status_code == 201, resp.text
    return resp.json()["id"]


def test_wiki_route_returns_the_graph(client):
    pid = _make_project(client)
    for title, content in (("Mara", "See [[Kestrel]]."), ("Kestrel", "Body.")):
        created = client.post(
            f"/api/projects/{pid}/documents",
            json={"title": title, "content": content},
            headers=HOST,
        )
        assert created.status_code == 201, created.text

    resp = client.get(f"/api/projects/{pid}/wiki", headers=HOST)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert set(body) == {"notes", "links", "backlinks", "broken", "linkCounts"}
    assert len(body["notes"]) == 2
    assert len(body["links"]) == 1


def test_wiki_route_missing_project_is_404(client):
    assert client.get("/api/projects/nope/wiki", headers=HOST).status_code == 404
