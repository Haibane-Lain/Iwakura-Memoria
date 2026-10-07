"""The library layer: worlds, series, books, reconciliation, and covers.

A book is an existing project; the grouping lives in ``worlds.json`` at the
data root. These tests drive the service directly (with a throwaway data dir)
and the HTTP surface (with a TestClient).
"""
from __future__ import annotations

import io
import json

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app import config
from app.main import create_app
from app.services import covers as covers_service
from app.services import projects as projects_service
from app.services import worlds as worlds_service

HOST = {"host": "127.0.0.1"}


def png_bytes(width: int = 12, height: int = 18, color=(40, 60, 120)) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (width, height), color).save(buf, "PNG")
    return buf.getvalue()


@pytest.fixture
def api_data_dir(tmp_path):
    d = tmp_path / "data"
    d.mkdir(parents=True, exist_ok=True)
    return d


@pytest.fixture
def client(api_data_dir, monkeypatch):
    monkeypatch.setenv("IWAKURA_DATA_DIR", str(api_data_dir))
    with TestClient(create_app()) as test_client:
        yield test_client


# ---------------------------------------------------------------------------
# Migration / reconciliation
# ---------------------------------------------------------------------------


def test_first_read_creates_a_world_and_adopts_projects(data_dir, make_project):
    make_project("alpha")
    make_project("beta")

    worlds = worlds_service.list_worlds()
    assert len(worlds) == 1
    assert worlds[0]["title"] == "My World"
    assert worlds[0]["books"] == 2
    assert worlds[0]["series"] == 0
    assert (data_dir / config.WORLDS_FILENAME).is_file()

    detail = worlds_service.get_world(worlds[0]["id"])
    assert {book["id"] for book in detail["books"]} == {"alpha", "beta"}


def test_a_fresh_library_has_no_worlds(data_dir):
    assert worlds_service.list_worlds() == []
    # Nothing to reconcile, so no manifest is created out of thin air.
    assert not (data_dir / config.WORLDS_FILENAME).exists()


def test_a_new_project_folder_is_adopted_by_the_first_world(data_dir, make_project):
    world = worlds_service.create_world("Main")
    make_project("orphan")

    detail = worlds_service.get_world(world["id"])
    assert [book["id"] for book in detail["books"]] == ["orphan"]


# ---------------------------------------------------------------------------
# Creating and renaming
# ---------------------------------------------------------------------------


def test_titles_are_required(data_dir):
    for factory in (worlds_service.create_world,):
        with pytest.raises(ValueError):
            factory("   ")


def test_create_world_series_and_book(data_dir):
    world = worlds_service.create_world("The Amber Kingdom")
    assert world["id"] == "the-amber-kingdom"

    world = worlds_service.create_series(world["id"], "Book One")
    assert world["series"][0]["id"] == "book-one"

    world = worlds_service.add_book(world["id"], "The Warden", world["series"][0]["id"])
    assert len(world["series"][0]["books"]) == 1
    book = world["series"][0]["books"][0]
    assert book["id"] == "the-warden"
    assert book["title"] == "The Warden"
    assert (data_dir / "the-warden" / config.PROJECT_META_FILENAME).is_file()


def test_renaming_keeps_ids(data_dir):
    world = worlds_service.create_world("Old")
    world = worlds_service.create_series(world["id"], "Series Old")
    sid = world["series"][0]["id"]

    renamed = worlds_service.rename_world(world["id"], "New Name")
    assert renamed["id"] == "old" and renamed["title"] == "New Name"
    renamed = worlds_service.rename_series(world["id"], sid, "Series New")
    assert renamed["series"][0]["id"] == sid
    assert renamed["series"][0]["title"] == "Series New"


# ---------------------------------------------------------------------------
# Moving and ungrouping
# ---------------------------------------------------------------------------


def test_moving_a_book_between_series_and_unsorted(data_dir):
    world = worlds_service.create_world("W")
    wid = world["id"]
    world = worlds_service.create_series(wid, "S1")
    world = worlds_service.create_series(wid, "S2")
    s1, s2 = [s["id"] for s in world["series"]]
    world = worlds_service.add_book(wid, "Book", s1)
    bid = world["series"][0]["books"][0]["id"]

    world = worlds_service.move_book(bid, wid, s2)
    assert world["series"][0]["books"] == []
    assert [b["id"] for b in world["series"][1]["books"]] == [bid]

    world = worlds_service.move_book(bid, wid, None)
    assert [b["id"] for b in world["books"]] == [bid]
    assert world["series"][1]["books"] == []


def test_deleting_a_series_unfolds_its_books(data_dir):
    world = worlds_service.create_world("W")
    wid = world["id"]
    world = worlds_service.create_series(wid, "S1")
    s1 = world["series"][0]["id"]
    world = worlds_service.add_book(wid, "Book", s1)
    bid = world["series"][0]["books"][0]["id"]

    world = worlds_service.delete_series(wid, s1)
    assert world["series"] == []
    assert [b["id"] for b in world["books"]] == [bid]


def test_deleting_a_world_keeps_its_books(data_dir):
    world = worlds_service.create_world("Keep")
    book = worlds_service.add_book(world["id"], "Survivor")
    bid = book["books"][0]["id"]

    second = worlds_service.create_world("Second")
    worlds_service.move_book(bid, second["id"], None)
    worlds_service.delete_world(second["id"])

    remaining = worlds_service.list_worlds()
    assert len(remaining) == 1 and remaining[0]["title"] == "Keep"
    detail = worlds_service.get_world(remaining[0]["id"])
    assert [b["id"] for b in detail["books"]] == [bid]


def test_deleting_a_world_removes_its_cover(data_dir):
    world = worlds_service.create_world("Covered")
    updated = worlds_service.set_world_cover(world["id"], png_bytes())
    name = updated["cover"].rsplit("/", 1)[1]
    worlds_service.delete_world(world["id"])
    with pytest.raises(FileNotFoundError):
        covers_service.path(name)


# ---------------------------------------------------------------------------
# Ordering
# ---------------------------------------------------------------------------


def test_reorder_worlds_series_and_books(data_dir):
    a = worlds_service.create_world("A")
    b = worlds_service.create_world("B")
    assert [w["id"] for w in worlds_service.reorder_worlds([b["id"], a["id"]])] == ["b", "a"]

    world = worlds_service.create_series(a["id"], "One")
    world = worlds_service.create_series(a["id"], "Two")
    one, two = [s["id"] for s in world["series"]]
    world = worlds_service.reorder_series(a["id"], [two, one])
    assert [s["id"] for s in world["series"]] == [two, one]

    world = worlds_service.add_book(a["id"], "First", one)
    world = worlds_service.add_book(a["id"], "Second", one)
    ids = [b["id"] for b in world["series"][0]["books"]]
    world = worlds_service.reorder_books(a["id"], list(reversed(ids)), one)
    assert [b["id"] for b in world["series"][0]["books"]] == list(reversed(ids))


# ---------------------------------------------------------------------------
# Covers
# ---------------------------------------------------------------------------


def test_world_cover_round_trips(data_dir):
    world = worlds_service.create_world("W")
    assert world["cover"] is None

    updated = worlds_service.set_world_cover(world["id"], png_bytes())
    name = updated["cover"].rsplit("/", 1)[1]
    assert name.startswith("world-w-")
    assert covers_service.path(name).read_bytes() == png_bytes()

    # Replacing removes the previous file.
    replaced = worlds_service.set_world_cover(world["id"], png_bytes(color=(9, 9, 9)))
    assert replaced["cover"] != updated["cover"]
    with pytest.raises(FileNotFoundError):
        covers_service.path(name)

    cleared = worlds_service.clear_world_cover(world["id"])
    assert cleared["cover"] is None


def test_book_cover_lives_in_project_meta(data_dir):
    world = worlds_service.create_world("W")
    world = worlds_service.add_book(world["id"], "Book")
    bid = world["books"][0]["id"]

    project = projects_service.set_cover(bid, png_bytes())
    assert project["cover"].endswith(".png")
    meta = json.loads((data_dir / bid / config.PROJECT_META_FILENAME).read_text(encoding="utf-8"))
    assert meta["cover"] == project["cover"]

    detail = worlds_service.get_world(world["id"])
    assert detail["books"][0]["cover"] == f"/api/covers/{project['cover']}"

    cleared = projects_service.clear_cover(bid)
    assert cleared["cover"] is None


# ---------------------------------------------------------------------------
# HTTP surface
# ---------------------------------------------------------------------------


def test_worlds_http_flow(client):
    assert client.get("/api/worlds", headers=HOST).json() == []

    created = client.post("/api/worlds", json={"title": "Demo"}, headers=HOST)
    assert created.status_code == 201, created.text
    world = created.json()
    assert world["id"] == "demo"

    series = client.post(
        "/api/worlds/demo/series", json={"title": "Season One"}, headers=HOST
    )
    assert series.status_code == 201, series.text
    sid = series.json()["series"][0]["id"]

    added = client.post(
        "/api/worlds/demo/books",
        json={"title": "Opening", "seriesId": sid},
        headers=HOST,
    )
    assert added.status_code == 201, added.text
    pid = added.json()["series"][0]["books"][0]["id"]

    moved = client.put(
        f"/api/worlds/demo/books/{pid}", json={"seriesId": None}, headers=HOST
    )
    assert moved.status_code == 200, moved.text
    assert [b["id"] for b in moved.json()["books"]] == [pid]

    detail = client.get("/api/worlds/demo", headers=HOST)
    assert detail.status_code == 200
    assert detail.json()["books"][0]["words"] == 0

    assert client.get("/api/worlds/nope", headers=HOST).status_code == 404
    assert (
        client.post("/api/worlds", json={"title": "  "}, headers=HOST).status_code == 400
    )


def test_reorder_routes(client):
    client.post("/api/worlds", json={"title": "A"}, headers=HOST)
    client.post("/api/worlds", json={"title": "B"}, headers=HOST)
    res = client.put("/api/worlds/reorder", json={"orderedIds": ["b", "a"]}, headers=HOST)
    assert res.status_code == 200, res.text
    assert [w["id"] for w in res.json()] == ["b", "a"]


def test_cover_upload_and_serve(client):
    client.post("/api/worlds", json={"title": "Demo"}, headers=HOST)
    raw = png_bytes()
    res = client.post(
        "/api/worlds/demo/cover",
        files={"file": ("cover.png", raw, "image/png")},
        headers=HOST,
    )
    assert res.status_code == 200, res.text
    url = res.json()["cover"]
    assert url.startswith("/api/covers/")

    served = client.get(url, headers=HOST)
    assert served.status_code == 200
    assert served.content == raw
    assert served.headers["content-type"] == "image/png"

    assert client.delete("/api/worlds/demo/cover", headers=HOST).status_code == 200


def test_book_cover_upload_and_serve(client):
    world = client.post("/api/worlds", json={"title": "Demo"}, headers=HOST).json()
    added = client.post(
        "/api/worlds/demo/books", json={"title": "Opening"}, headers=HOST
    ).json()
    pid = added["books"][0]["id"]

    raw = png_bytes()
    res = client.post(
        f"/api/projects/{pid}/cover",
        files={"file": ("cover.png", raw, "image/png")},
        headers=HOST,
    )
    assert res.status_code == 200, res.text
    name = res.json()["cover"]
    assert client.get(f"/api/covers/{name}", headers=HOST).content == raw

    assert client.delete(f"/api/projects/{pid}/cover", headers=HOST).status_code == 200
    assert world["id"] == "demo"


def test_cover_upload_rejects_a_non_image(client):
    client.post("/api/worlds", json={"title": "Demo"}, headers=HOST)
    res = client.post(
        "/api/worlds/demo/cover",
        files={"file": ("notes.png", b"not an image", "image/png")},
        headers=HOST,
    )
    assert res.status_code == 400
    assert "not a readable image" in res.json()["detail"]


def test_cover_serving_rejects_traversal(client):
    for name in ("..%2Fworlds.json", "x.svg", "missing.png"):
        assert client.get(f"/api/covers/{name}", headers=HOST).status_code == 404
