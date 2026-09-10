"""Tests for the one-time zoom rebase (app.services.documents.rebase_zoom_scale).

The editor's zoom percentage used to be a raw CSS factor (200% meant
``zoom: 2``); it is now a reading size whose 100% renders at ``zoom: 2``, so
every value stored before the change is halved exactly once. These tests pin
the migration, its idempotence, and the frontend wiring it depends on.
"""
from __future__ import annotations

import json
from pathlib import Path

from app import config
from app.services import documents


def _doc(path: Path, body: str = "Body text.\n", **meta) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    lines = "".join(f"{key}: {value}\n" for key, value in meta.items())
    path.write_text(f"---\n{lines}---\n\n{body}", encoding="utf-8")
    return path


def _meta(path: Path) -> dict:
    parsed, _ = documents.parse_frontmatter(path.read_text(encoding="utf-8"))
    return parsed


def _body(path: Path) -> str:
    _, body = documents.parse_frontmatter(path.read_text(encoding="utf-8"))
    return body


def _write_settings(data_dir: Path, settings: dict) -> Path:
    path = data_dir / "settings.json"
    path.write_text(json.dumps(settings, indent=2), encoding="utf-8")
    return path


def test_halves_document_zoom_and_leaves_everything_else(data_dir, make_project):
    project = make_project("soul-sovereign")
    path = _doc(
        project / "01-Book 1" / "01-chapter-1.md",
        "Chapter body.\n",
        title="Chapter 1",
        type="chapter",
        size=14,
        align="justify",
        zoom=200,
    )
    before = path.read_text(encoding="utf-8")

    assert documents.rebase_zoom_scale() == 1

    after = path.read_text(encoding="utf-8")
    assert _meta(path)["zoom"] == 100
    assert _meta(path)["size"] == 14
    assert _meta(path)["align"] == "justify"
    assert _meta(path)["title"] == "Chapter 1"
    assert _body(path) == "Chapter body.\n"
    # Only the zoom line differs.
    assert before.replace("zoom: 200", "zoom: 100") == after


def test_halves_global_editor_zoom_and_preserves_other_keys(data_dir):
    _write_settings(
        data_dir,
        {"theme": "gothic", "editorSize": 14, "editorZoom": 200, "ai": {}},
    )

    assert documents.rebase_zoom_scale() == 0

    stored = json.loads((data_dir / "settings.json").read_text(encoding="utf-8"))
    assert stored == {"theme": "gothic", "editorSize": 14, "editorZoom": 100, "ai": {}}
    assert (data_dir / documents.ZOOM_MARKER).exists()


def test_marker_is_a_file_that_settings_writes_cannot_erase(data_dir, make_project):
    """The guard must survive settings.json being rewritten from a stale
    in-process cache, or the rebase would run twice and halve everything again."""
    project = make_project("aria")
    path = _doc(project / "01-note.md", "Note.\n", zoom=200)

    documents.rebase_zoom_scale()
    config.save_settings({**config.load_settings(), "theme": "dark"})

    assert documents.rebase_zoom_scale() == 0
    assert _meta(path)["zoom"] == 100  # not 50


def test_second_run_is_a_noop(data_dir, make_project):
    project = make_project("aria")
    path = _doc(project / "01-note.md", "Note.\n", zoom=150)

    assert documents.rebase_zoom_scale() == 1
    assert _meta(path)["zoom"] == 75

    assert documents.rebase_zoom_scale() == 0
    assert _meta(path)["zoom"] == 75  # not 37


def test_documents_without_zoom_are_not_rewritten(data_dir, make_project):
    project = make_project("aria")
    path = _doc(project / "01-note.md", "Note.\n", title="Note", size=20)
    before = path.read_text(encoding="utf-8")
    stamp = path.stat().st_mtime_ns

    documents.rebase_zoom_scale()

    assert path.read_text(encoding="utf-8") == before
    assert path.stat().st_mtime_ns == stamp


def test_covers_wiki_and_templates_but_skips_non_projects(data_dir, make_project):
    project = make_project("soul-sovereign")
    wiki = _doc(project / "worldbuilding" / "01-alice.md", "Alice.\n", zoom=150)
    template = _doc(project / "templates" / "01-blank.md", "T.\n", zoom=200)
    stray = _doc(data_dir / "not-a-project" / "01-loose.md", "Loose.\n", zoom=200)

    assert documents.rebase_zoom_scale() == 2

    assert _meta(wiki)["zoom"] == 75
    assert _meta(template)["zoom"] == 100
    assert _meta(stray)["zoom"] == 200  # untouched: no project.json


def test_odd_and_unusable_values(data_dir, make_project):
    project = make_project("aria")
    odd = _doc(project / "01-odd.md", "Odd.\n", zoom=55)
    text = _doc(project / "02-text.md", "Text.\n", title="Text", zoom="abc")
    zero = _doc(project / "03-zero.md", "Zero.\n", zoom=0)

    assert documents.rebase_zoom_scale() == 1

    assert _meta(odd)["zoom"] == 28
    assert _meta(text)["zoom"] == "abc"  # unusable: left alone
    assert _meta(zero)["zoom"] == 0


def test_fresh_install_writes_only_the_marker(data_dir):
    assert documents.rebase_zoom_scale() == 0

    # Nothing to halve and no reason to create settings.json: the default 100
    # is already on the new scale.
    assert not (data_dir / "settings.json").exists()
    assert (data_dir / documents.ZOOM_MARKER).read_text(encoding="utf-8") == "rebased\n"
    assert documents.rebase_zoom_scale() == 0


def test_startup_runs_the_rebase(data_dir, make_project, monkeypatch):
    from app.main import create_app

    # create_app() re-derives DATA_DIR through config.ensure_dirs(), so the env
    # override has to point at the throwaway folder too: the real library must
    # never be touched by a test.
    monkeypatch.setenv("IWAKURA_DATA_DIR", str(data_dir))
    project = make_project("aria")
    path = _doc(project / "01-note.md", "Note.\n", zoom=200)

    create_app()

    assert _meta(path)["zoom"] == 100


def test_project_js_maps_zoom_through_the_helper():
    """Both CSS writes go through zoomFactor, so the 2x baseline cannot be
    silently dropped from one of them. jsdom has no layout engine, so this is
    pinned at the source the way tests/test_ui_layout.py pins CSS."""
    source = (config.PROJECT_ROOT / "static" / "js" / "project.js").read_text(encoding="utf-8")
    writes = [line for line in source.splitlines() if '"--editor-zoom"' in line]
    assert len(writes) == 2
    assert all("zoomFactor(" in line for line in writes)
    assert "effectiveZoom() / 100" not in source
    assert "state.settings.editorZoom || 100" not in source
