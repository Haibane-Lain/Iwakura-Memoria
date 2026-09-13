"""Project beat lists: defaults, normalization, persistence and the API."""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from app.services import projects as projects_service


def test_get_project_seeds_default_beats(data_dir, make_project):
    make_project("proj")
    project = projects_service.get_project("proj")
    assert project["beats"] == projects_service.DEFAULT_BEATS
    assert project["beats"][0]["id"] == "opening-image"


def test_set_beats_normalizes_and_persists(data_dir, make_project):
    make_project("proj")

    saved = projects_service.set_beats(
        "proj",
        [
            {"name": "  Act One  "},
            {"id": "mid", "name": "Midpoint", "description": "Turn"},
            {"name": "Act One"},  # duplicate id derived from the same name
            {"name": "   "},  # dropped
            "not-a-dict",  # dropped
        ],
    )

    assert [b["name"] for b in saved["beats"]] == ["Act One", "Midpoint", "Act One"]
    assert saved["beats"][0]["id"] == "act-one"
    assert saved["beats"][1]["id"] == "mid"
    assert saved["beats"][1]["description"] == "Turn"
    assert saved["beats"][2]["id"] == "act-one-2"

    # Persisted, not just returned.
    assert projects_service.get_project("proj")["beats"] == saved["beats"]
    assert projects_service.get_beats("proj") == saved


def test_set_beats_can_clear_to_default(data_dir, make_project):
    make_project("proj")
    projects_service.set_beats("proj", [{"name": "Only"}])
    assert len(projects_service.get_project("proj")["beats"]) == 1

    # An empty list is stored; get_project then falls back to the defaults.
    projects_service.set_beats("proj", [])
    assert projects_service.get_project("proj")["beats"] == projects_service.DEFAULT_BEATS


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("IWAKURA_DATA_DIR", str(tmp_path / "data"))
    return TestClient(create_app())


_H = {"host": "127.0.0.1"}


def test_beats_route_round_trip(client):
    project = client.post("/api/projects", json={"name": "Proj"}, headers=_H).json()
    pid = project["id"]
    assert project["beats"] == projects_service.DEFAULT_BEATS

    put = client.put(
        f"/api/projects/{pid}/beats",
        json={"beats": [{"id": "a", "name": "Alpha"}, {"name": "Beta"}]},
        headers=_H,
    )
    assert put.status_code == 200, put.text
    assert [b["name"] for b in put.json()["beats"]] == ["Alpha", "Beta"]

    got = client.get(f"/api/projects/{pid}/beats", headers=_H).json()
    assert got["beats"] == put.json()["beats"]
    assert client.get(f"/api/projects/{pid}", headers=_H).json()["beats"] == put.json()["beats"]
