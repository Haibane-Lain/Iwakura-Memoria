"""The two per-tab editor zooms, and the first-launch theme.

Zoom is the one editor preference with a default *per tab*: the Write tab reads
like a manuscript page (100%), the Wiki tab is a reference page meant to be
scanned (75%). They are stored separately in ``settings.json``
(``editorZoom`` / ``wikiZoom``) and a document's own frontmatter ``zoom`` still
beats either. The JS suite runs in jsdom, which has no layout engine, so the
wiring is pinned at the source the way tests/test_zoom_rebase.py pins the zoom
scale itself.

Run from the workspace root:

    .venv\\Scripts\\python.exe -m pytest tests/ -q
"""
from __future__ import annotations

import json
import re

import pytest
from fastapi.testclient import TestClient

from app import config
from app.main import create_app

PROJECT_JS = config.PROJECT_ROOT / "static" / "js" / "project.js"
ZOOM_JS = config.PROJECT_ROOT / "static" / "js" / "zoom.js"
THEMES_JS = config.PROJECT_ROOT / "static" / "js" / "themes.js"
INDEX_HTML = config.PROJECT_ROOT / "static" / "index.html"

# The localhost guard rejects a foreign Host, and TestClient's default is one.
HOST = {"host": "127.0.0.1"}


@pytest.fixture
def client(tmp_path, monkeypatch):
    """A TestClient whose data dir is a throwaway folder, so exercising the
    app never touches real user data."""
    monkeypatch.setenv("IWAKURA_DATA_DIR", str(tmp_path / "data"))
    return TestClient(create_app())


# --- the defaults -----------------------------------------------------------


def test_the_two_zoom_defaults_are_a_hundred_and_seventy_five():
    assert config.DEFAULT_SETTINGS["editorZoom"] == 100
    assert config.DEFAULT_SETTINGS["wikiZoom"] == 75


def test_zoom_js_agrees_with_the_server_defaults():
    """Two files hold these numbers: the server merges them into a fresh
    settings.json, the frontend needs them before (and without) that answer."""
    source = ZOOM_JS.read_text(encoding="utf-8")
    write_zoom = int(re.search(r"(?m)^export const DEFAULT_ZOOM = (\d+);", source).group(1))
    wiki_zoom = int(re.search(r"(?m)^export const DEFAULT_WIKI_ZOOM = (\d+);", source).group(1))
    assert write_zoom == config.DEFAULT_SETTINGS["editorZoom"]
    assert wiki_zoom == config.DEFAULT_SETTINGS["wikiZoom"]


def test_the_first_launch_theme_is_gothic_everywhere_it_is_decided():
    assert config.DEFAULT_SETTINGS["theme"] == "gothic"

    source = THEMES_JS.read_text(encoding="utf-8")
    assert re.search(r'export const DEFAULT_THEME = "gothic";', source)
    assert re.search(r"let current = DEFAULT_THEME;", source)
    assert re.search(r"return \{ theme: DEFAULT_THEME \};", source)
    # Only the palette entry itself may still mention paper: every fallback now
    # follows the same constant as the server default.
    assert source.count('"paper"') == 1, source

    # The body paints before themes.js has an answer, so its attribute has to
    # match the default or the first frame flashes the wrong palette.
    assert 'data-theme="gothic"' in INDEX_HTML.read_text(encoding="utf-8")


# --- the frontend wiring ----------------------------------------------------


def test_the_settings_tab_saves_a_zoom_per_tab():
    js = PROJECT_JS.read_text(encoding="utf-8")
    assert re.search(r'zoomSelect\("global", "write"\)', js), (
        "Settings must offer a Write tab zoom"
    )
    assert re.search(r'zoomSelect\("global", "wiki"\)', js), (
        "Settings must offer a Wiki tab zoom"
    )
    assert re.search(r'return scope === "wiki" \? "wikiZoom" : "editorZoom";', js), (
        "the tab must decide which settings key is written"
    )
    assert re.search(r"api\.settings\.update\(\{ \[zoomKey\(scope\)\]: zoom \}\)", js), (
        "the two rows must save to their own key"
    )
    # The Settings rows and the toolbar's per-document control share a class,
    # so the rows are marked with the tab they default.
    assert re.search(r"dataset: \{ zoomScope: scope \}", js), (
        "the global rows must be distinguishable from the toolbar control"
    )


def test_each_tab_falls_back_to_its_own_default():
    js = PROJECT_JS.read_text(encoding="utf-8")
    assert re.search(r"return docStyle\(\)\.zoom \|\| defaultZoomForScope\(\);", js), (
        "a document's own zoom wins, then the default of the tab it is in"
    )
    assert re.search(
        r'return \(wiki \? state\.settings\.wikiZoom : state\.settings\.editorZoom\) \|\|', js
    ), "the fallback must read the settings key for that tab"
    assert re.search(
        r"sel\.value = String\(scope \? defaultZoomForScope\(scope === \"wiki\"\) : currentZoom\(\)\);",
        js,
    ), "the Settings rows show their saved default, the toolbar shows the document"
    assert re.search(r"wikiZoom: settings\.wikiZoom \|\| DEFAULT_WIKI_ZOOM,", js), (
        "init() must load the wiki default"
    )


def test_the_empty_state_uses_the_tab_it_belongs_to():
    """With no document open there are no overrides to inherit, and the host
    would otherwise keep the previous document's zoom."""
    js = PROJECT_JS.read_text(encoding="utf-8")
    assert re.search(r"if \(!doc\) \{\n(?:.*\n)*?\s*state\.docStyle = \{\};\n\s*applyDocStyle\(\);", js), (
        "the empty editor must be styled for its own tab"
    )


# --- the API ----------------------------------------------------------------


def test_the_api_keeps_the_two_zooms_apart(client):
    fresh = client.get("/api/settings", headers=HOST).json()
    assert fresh["editorZoom"] == 100
    assert fresh["wikiZoom"] == 75
    assert fresh["theme"] == "gothic"

    stored = client.put("/api/settings", json={"wikiZoom": 125}, headers=HOST)
    assert stored.status_code == 200
    assert stored.json()["wikiZoom"] == 125

    after = client.get("/api/settings", headers=HOST).json()
    assert after["wikiZoom"] == 125
    assert after["editorZoom"] == 100, "the Write tab's default is not touched"


def test_an_older_settings_file_gains_the_wiki_default(client, monkeypatch):
    """An install from before this change has no ``wikiZoom``: it must read as
    75 without the file being rewritten behind the user's back."""
    path = config.get_settings_path()
    path.write_text('{"theme": "paper", "editorZoom": 100}', encoding="utf-8")

    settings = client.get("/api/settings", headers=HOST).json()
    assert settings["wikiZoom"] == 75
    assert settings["theme"] == "paper", "a stored theme always wins"

    assert json.loads(path.read_text(encoding="utf-8")) == {
        "theme": "paper",
        "editorZoom": 100,
    }, "reading settings must not rewrite them"
