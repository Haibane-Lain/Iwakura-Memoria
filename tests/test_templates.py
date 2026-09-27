"""Templates service and route tests.

The five defaults are seeded on first access; create/update/delete are plain
per-project JSON files under the reserved ``templates/`` folder. These pin the
seeding, the slug/duplicate rules and the route status codes.
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from app.services import templates as templates_service

HOST = {"host": "127.0.0.1"}
DEFAULT_IDS = {"character", "location", "organization", "nation", "lore-concept"}


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("IWAKURA_DATA_DIR", str(tmp_path / "data"))
    return TestClient(create_app())


# --- service ----------------------------------------------------------------


def test_list_seeds_the_defaults(make_project, data_dir):
    make_project("p1")
    templates = templates_service.list_templates("p1")
    assert {t["id"] for t in templates} == DEFAULT_IDS
    assert all(set(t) == {"id", "name", "type", "sections"} for t in templates)
    # …as real files under the project's reserved templates/ folder
    files = {p.name for p in (data_dir / "p1" / "templates").glob("*.json")}
    assert files == {f"{tid}.json" for tid in DEFAULT_IDS}


def test_list_is_idempotent(make_project):
    make_project("p1")
    assert templates_service.list_templates("p1") == templates_service.list_templates("p1")


def test_list_missing_project_raises(make_project):
    with pytest.raises(FileNotFoundError):
        templates_service.list_templates("nope")


def test_create_template_slugs_and_cleans_sections(make_project):
    make_project("p1")
    data = templates_service.create_template(
        "p1", "Faction", ["Purpose", "  ", "Rivals"]
    )
    assert data == {
        "id": "faction",
        "name": "Faction",
        "type": "faction",
        "sections": ["Purpose", "Rivals"],
    }
    assert "faction" in {t["id"] for t in templates_service.list_templates("p1")}


def test_create_template_rejects_duplicates(make_project):
    make_project("p1")
    templates_service.create_template("p1", "Faction", [])
    with pytest.raises(templates_service.TemplateError):
        templates_service.create_template("p1", "Faction", [])
    # the seeded defaults count too
    with pytest.raises(templates_service.TemplateError):
        templates_service.create_template("p1", "Character", [])


def test_create_template_requires_a_name(make_project):
    make_project("p1")
    with pytest.raises(templates_service.TemplateError):
        templates_service.create_template("p1", "   ", [])


def test_update_template_replaces_name_and_sections(make_project):
    make_project("p1")
    templates_service.list_templates("p1")  # seed the defaults first
    updated = templates_service.update_template(
        "p1", "character", name="Hero", sections=["Origin"]
    )
    assert updated["name"] == "Hero"
    assert updated["sections"] == ["Origin"]
    # a blank name is ignored; a sections list replaces wholesale and is cleaned
    again = templates_service.update_template(
        "p1", "character", name="  ", sections=["A", " "]
    )
    assert again["name"] == "Hero"
    assert again["sections"] == ["A"]


def test_update_template_missing_raises(make_project):
    make_project("p1")
    templates_service.list_templates("p1")  # seed, so the folder exists
    with pytest.raises(FileNotFoundError):
        templates_service.update_template("p1", "nope", name="X")


def test_delete_template_removes_it_then_raises(make_project):
    make_project("p1")
    templates_service.create_template("p1", "Faction", [])
    templates_service.delete_template("p1", "faction")
    # list_templates re-seeds only the defaults, so a deleted custom one stays gone
    assert "faction" not in {t["id"] for t in templates_service.list_templates("p1")}
    with pytest.raises(FileNotFoundError):
        templates_service.delete_template("p1", "faction")


# --- route ------------------------------------------------------------------


def _make_project(client, name="P1") -> str:
    resp = client.post("/api/projects", json={"name": name}, headers=HOST)
    assert resp.status_code == 201, resp.text
    return resp.json()["id"]


def test_templates_route_crud(client):
    pid = _make_project(client)

    listed = client.get(f"/api/projects/{pid}/templates", headers=HOST)
    assert listed.status_code == 200, listed.text
    assert {t["id"] for t in listed.json()} == DEFAULT_IDS

    created = client.post(
        f"/api/projects/{pid}/templates",
        json={"name": "Faction", "sections": ["Purpose"]},
        headers=HOST,
    )
    assert created.status_code == 201, created.text
    assert created.json()["id"] == "faction"

    updated = client.put(
        f"/api/projects/{pid}/templates/faction",
        json={"name": "Factions", "sections": ["A", "B"]},
        headers=HOST,
    )
    assert updated.status_code == 200, updated.text
    assert updated.json()["name"] == "Factions"
    assert updated.json()["sections"] == ["A", "B"]

    deleted = client.delete(f"/api/projects/{pid}/templates/faction", headers=HOST)
    assert deleted.status_code == 200, deleted.text
    assert deleted.json() == {"ok": True}
    remaining = client.get(f"/api/projects/{pid}/templates", headers=HOST).json()
    assert "faction" not in {t["id"] for t in remaining}


def test_templates_route_errors(client):
    pid = _make_project(client)
    assert (
        client.post(
            f"/api/projects/{pid}/templates", json={"name": "Character"}, headers=HOST
        ).status_code
        == 400
    )
    assert (
        client.post(
            f"/api/projects/{pid}/templates", json={"name": "   "}, headers=HOST
        ).status_code
        == 400
    )
    assert (
        client.put(
            f"/api/projects/{pid}/templates/nope", json={"name": "X"}, headers=HOST
        ).status_code
        == 404
    )
    assert (
        client.delete(f"/api/projects/{pid}/templates/nope", headers=HOST).status_code
        == 404
    )


def test_templates_route_missing_project_is_404(client):
    assert client.get("/api/projects/nope/templates", headers=HOST).status_code == 404
    assert (
        client.post(
            "/api/projects/nope/templates", json={"name": "X"}, headers=HOST
        ).status_code
        == 404
    )
