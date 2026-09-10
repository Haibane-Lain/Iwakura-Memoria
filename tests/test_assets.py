"""Image asset tests: validation, storage, serving, and tree exclusion.

Pictures live in a visible ``assets/`` folder per project and are referenced
project-root-relative from documents. Everything here is about the pieces that
make that safe: content-based validation, collision-free naming, a serving
route that cannot be walked out of its folder, and a folder that never shows up
as a user folder or in the sidebar tree.
"""
from __future__ import annotations

import io

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app import config
from app.main import create_app
from app.services import assets as assets_service
from app.services import documents as documents_service

HOST = {"host": "127.0.0.1"}


def png_bytes(width: int = 8, height: int = 6, color=(200, 30, 30)) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (width, height), color).save(buf, "PNG")
    return buf.getvalue()


@pytest.fixture
def api_data_dir(tmp_path):
    """A throwaway data dir owned by the API tests.

    Deliberately not the ``data_dir`` fixture: ``create_app()`` runs
    ``ensure_dirs()``, which creates the data dir itself, and the shared fixture
    insists on creating it too.
    """
    d = tmp_path / "data"
    d.mkdir(parents=True, exist_ok=True)
    return d


@pytest.fixture
def client(api_data_dir, monkeypatch):
    monkeypatch.setenv("IWAKURA_DATA_DIR", str(api_data_dir))
    with TestClient(create_app()) as test_client:
        yield test_client


def _make_project(data_dir, project_id: str = "p1"):
    folder = data_dir / project_id
    (folder / "stats").mkdir(parents=True, exist_ok=True)
    (folder / "project.json").write_text("{}", encoding="utf-8")
    (folder / config.WIKI_DIRNAME).mkdir(exist_ok=True)
    return folder


# ---------------------------------------------------------------------------
# Service level
# ---------------------------------------------------------------------------


def test_save_and_read_back(make_project):
    make_project("p1")
    raw = png_bytes()
    item = assets_service.save_image("p1", "Mara Portrait.png", raw)

    assert item["path"].startswith(f"{config.ASSETS_DIRNAME}/")
    assert item["path"].endswith(".png")
    assert "Mara" not in item["path"]
    assert "mara-portrait" in item["path"]
    assert item["width"] == 8 and item["height"] == 6
    assert item["size"] == len(raw)

    path = assets_service.image_path("p1", item["name"])
    assert path.read_bytes() == raw
    assert assets_service.media_type(item["name"]) == "image/png"
    assert path.parent.name == config.ASSETS_DIRNAME


def test_identical_bytes_dedupe(make_project):
    make_project("p1")
    raw = png_bytes()
    first = assets_service.save_image("p1", "one.png", raw)
    second = assets_service.save_image("p1", "two.png", raw)

    assert first["name"] == second["name"]
    stored = list((config.DATA_DIR / "p1" / config.ASSETS_DIRNAME).iterdir())
    assert len(stored) == 1


def test_different_bytes_get_distinct_names(make_project):
    make_project("p1")
    a = assets_service.save_image("p1", "same.png", png_bytes(color=(10, 10, 10)))
    b = assets_service.save_image("p1", "same.png", png_bytes(color=(250, 250, 250)))
    assert a["name"] != b["name"]
    assert assets_service.image_path("p1", a["name"]).read_bytes() != assets_service.image_path("p1", b["name"]).read_bytes()


@pytest.mark.parametrize(
    "filename,raw",
    [
        ("notes.png", b"just some text, honestly"),
        ("empty.png", b""),
        ("truncated.png", png_bytes()[:20]),
        ("vector.svg", b"<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>"),
    ],
)
def test_non_images_are_rejected(make_project, filename, raw):
    make_project("p1")
    with pytest.raises(assets_service.AssetError):
        assets_service.save_image("p1", filename, raw)
    # Nothing was left behind by a rejected upload.
    assert not (config.DATA_DIR / "p1" / config.ASSETS_DIRNAME).exists()


def test_oversized_image_is_rejected(make_project, monkeypatch):
    make_project("p1")
    monkeypatch.setattr(assets_service, "MAX_IMAGE_BYTES", 32)
    with pytest.raises(assets_service.AssetError, match="MB limit"):
        assets_service.save_image("p1", "big.png", png_bytes())


def test_absurd_dimensions_are_rejected(make_project, monkeypatch):
    make_project("p1")
    monkeypatch.setattr(assets_service, "MAX_IMAGE_EDGE", 4)
    with pytest.raises(assets_service.AssetError, match="px per side"):
        assets_service.save_image("p1", "wide.png", png_bytes(width=8, height=6))


@pytest.mark.parametrize(
    "name",
    [
        "../project.json",
        "..%2Fproject.json",
        "sub/dir/x.png",
        "x.svg",
        "x.txt",
        ".hidden.png",
        "",
        "no-such-image.png",
    ],
)
def test_unreachable_names_404(make_project, name):
    make_project("p1")
    with pytest.raises(FileNotFoundError):
        assets_service.image_path("p1", name)


def test_unknown_project_is_not_found(make_project):
    make_project("p1")
    with pytest.raises(FileNotFoundError):
        assets_service.save_image("nope", "x.png", png_bytes())


# ---------------------------------------------------------------------------
# Reserved folder behaviour
# ---------------------------------------------------------------------------


def test_assets_is_reserved_as_a_folder_name(make_project):
    make_project("p1")
    for name in ("assets", "Assets", "ASSETS"):
        with pytest.raises(documents_service.DocumentError):
            documents_service.create_folder("p1", name)


def test_assets_folder_never_appears_in_a_tree(make_project):
    make_project("p1")
    raw = png_bytes()
    assets_service.save_image("p1", "mara.png", raw)
    documents_service.create_document("p1", "Chapter One", "chapter", content="Words.")
    documents_service.create_folder("p1", "Part One")

    for scope in ("write", "wiki", "all"):
        tree = documents_service.get_tree("p1", scope=scope)
        names = [folder["name"] for folder in tree["folders"]]
        assert "assets" not in names
        ids = [folder["id"] for folder in tree["folders"]]
        assert config.ASSETS_DIRNAME not in ids

    # …and the pictures really are on disk while being invisible to the tree.
    assert (config.DATA_DIR / "p1" / config.ASSETS_DIRNAME).is_dir()


def test_word_stats_ignore_assets(make_project):
    make_project("p1")
    documents_service.create_document("p1", "Chapter", "chapter", content="one two three")
    assets_service.save_image("p1", "mara.png", png_bytes())
    stats = documents_service.project_word_stats("p1")
    assert stats["documents"] == 1
    assert stats["words"] == 3


# ---------------------------------------------------------------------------
# HTTP surface
# ---------------------------------------------------------------------------


def test_upload_then_serve(client, api_data_dir):
    _make_project(api_data_dir)
    raw = png_bytes()
    res = client.post(
        "/api/projects/p1/assets",
        files={"file": ("mara.png", raw, "image/png")},
        headers=HOST,
    )
    assert res.status_code == 201, res.text
    item = res.json()
    assert item["path"] == f"{config.ASSETS_DIRNAME}/{item['name']}"
    assert item["url"] == f"/api/projects/p1/assets/{item['name']}"

    served = client.get(item["url"], headers=HOST)
    assert served.status_code == 200
    assert served.content == raw
    assert served.headers["content-type"] == "image/png"


def test_upload_rejects_a_non_image(client, api_data_dir):
    _make_project(api_data_dir)
    res = client.post(
        "/api/projects/p1/assets",
        files={"file": ("notes.png", b"not an image", "image/png")},
        headers=HOST,
    )
    assert res.status_code == 400
    assert "not a readable image" in res.json()["detail"]


def test_upload_rejects_an_oversized_body(client, api_data_dir, monkeypatch):
    _make_project(api_data_dir)
    monkeypatch.setattr(assets_service, "MAX_IMAGE_BYTES", 16)
    res = client.post(
        "/api/projects/p1/assets",
        files={"file": ("mara.png", png_bytes(), "image/png")},
        headers=HOST,
    )
    assert res.status_code == 413
    assert "MB limit" in res.json()["detail"]


def test_upload_to_unknown_project_404s(client, api_data_dir):
    _make_project(api_data_dir)
    res = client.post(
        "/api/projects/nope/assets",
        files={"file": ("mara.png", png_bytes(), "image/png")},
        headers=HOST,
    )
    assert res.status_code == 404


def test_serving_a_traversal_name_404s(client, api_data_dir):
    _make_project(api_data_dir)
    (api_data_dir / "p1" / "project.json").write_text('{"title": "Secret"}', encoding="utf-8")
    for name in ("..%2Fproject.json", "x.svg", "missing.png"):
        res = client.get(f"/api/projects/p1/assets/{name}", headers=HOST)
        assert res.status_code == 404, f"{name} -> {res.status_code}"
