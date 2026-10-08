"""Themes and the appearance overrides.

The palette entries live in ``static/css/themes.css`` and are listed in
``static/js/themes.js``; a mismatch shows up as a theme that can be selected
but paints nothing (or a palette nothing can select). The appearance keys are
stored in ``settings.json`` and whitelisted by the settings route, so a value
the frontend sends must survive a round trip.

Run from the workspace root:

    .venv\\Scripts\\python.exe -m pytest tests/ -q
"""
from __future__ import annotations

import re

import pytest
from fastapi.testclient import TestClient

from app import config
from app.main import create_app
from app.routes.settings import SettingsPatch

THEMES_JS = config.PROJECT_ROOT / "static" / "js" / "themes.js"
THEMES_CSS = config.PROJECT_ROOT / "static" / "css" / "themes.css"

# The localhost guard rejects a foreign Host, and TestClient's default is one.
HOST = {"host": "127.0.0.1"}

APPEARANCE_DEFAULTS = {
    "accentColor": "",
    "cornerStyle": "default",
    "uiFont": "",
    "texturesEnabled": True,
    "reducedMotion": False,
    "editorWidth": "medium",
}


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("IWAKURA_DATA_DIR", str(tmp_path / "data"))
    return TestClient(create_app())


def _js_theme_ids() -> set[str]:
    source = THEMES_JS.read_text(encoding="utf-8")
    return set(re.findall(r'\{\s*id:\s*"([^"]+)"', source))


def _css_theme_ids() -> set[str]:
    source = THEMES_CSS.read_text(encoding="utf-8")
    return set(re.findall(r'\[data-theme="([^"]+)"\]', source))


def test_every_registered_theme_has_a_palette_and_vice_versa():
    assert _js_theme_ids() == _css_theme_ids()
    # The expressive themes are present alongside the original seven.
    assert {"sepia", "vellum", "terminal", "noir", "amber"} <= _js_theme_ids()


def test_default_theme_is_still_gothic():
    assert config.DEFAULT_SETTINGS["theme"] == "gothic"


def test_appearance_defaults_are_in_settings():
    for key, value in APPEARANCE_DEFAULTS.items():
        assert config.DEFAULT_SETTINGS[key] == value


def test_the_settings_patch_accepts_every_appearance_key():
    fields = set(SettingsPatch.model_fields)
    assert set(APPEARANCE_DEFAULTS) <= fields


def test_appearance_round_trips_through_the_api(client):
    fresh = client.get("/api/settings", headers=HOST).json()
    for key, value in APPEARANCE_DEFAULTS.items():
        assert fresh[key] == value

    stored = client.put(
        "/api/settings",
        json={
            "accentColor": "#ff8800",
            "cornerStyle": "sharp",
            "uiFont": "mono",
            "texturesEnabled": False,
            "reducedMotion": True,
            "editorWidth": "wide",
        },
        headers=HOST,
    )
    assert stored.status_code == 200
    body = stored.json()
    assert body["accentColor"] == "#ff8800"
    assert body["cornerStyle"] == "sharp"
    assert body["editorWidth"] == "wide"

    after = client.get("/api/settings", headers=HOST).json()
    assert after["reducedMotion"] is True
    assert after["texturesEnabled"] is False


def test_the_css_declares_the_override_hooks():
    source = THEMES_CSS.read_text(encoding="utf-8")
    for hook in (
        "body[data-accent]",
        'body[data-corners="rounded"]',
        'body[data-corners="sharp"]',
        "body.no-texture",
        "body.reduced-motion",
    ):
        assert hook in source, hook
