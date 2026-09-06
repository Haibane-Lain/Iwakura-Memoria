"""Tests for history.jsonl compaction and the orphan-tmp sweep.

Run from the workspace root:

    .venv\\Scripts\\python.exe -m pytest tests/ -q
"""
from __future__ import annotations

import json
import os
import time
from datetime import date, timedelta
from pathlib import Path

import pytest

from app import config
from app.services import documents


@pytest.fixture
def data_dir(tmp_path, monkeypatch):
    d = tmp_path / "data"
    d.mkdir()
    monkeypatch.setattr(config, "DATA_DIR", d)
    return d


def _write_history(path: Path, entries: list[dict]) -> None:
    path.write_text(
        "".join(json.dumps(e, ensure_ascii=False) + "\n" for e in entries),
        encoding="utf-8",
    )


def _read_compact(path: Path) -> dict[str, int]:
    return {
        json.loads(line)["date"]: json.loads(line)["delta"]
        for line in path.read_text(encoding="utf-8").splitlines()
        if line.strip()
    }


# --- _compact_history -------------------------------------------------------


def test_compact_history_sums_recent_days_and_drops_old(tmp_path):
    path = tmp_path / "history.jsonl"
    today = date.today()
    old = (today - timedelta(days=400)).isoformat()
    yesterday = (today - timedelta(days=1)).isoformat()
    _write_history(path, [
        {"date": old, "doc": "a", "delta": 500, "at": "t"},
        {"date": yesterday, "doc": "a", "delta": 100, "at": "t"},
        {"date": yesterday, "doc": "b", "delta": 50, "at": "t"},
        {"date": today.isoformat(), "doc": "a", "delta": 30, "at": "t"},
        {"date": today.isoformat(), "doc": "a", "delta": -5, "at": "t"},
    ])
    assert documents._compact_history(path) is True
    # exactly two kept days, sums correct, old day dropped
    assert _read_compact(path) == {yesterday: 150, today.isoformat(): 25}


def test_compact_ignores_garbage_and_leaves_file_when_all_stale(tmp_path):
    path = tmp_path / "history.jsonl"
    stale = (date.today() - timedelta(days=800)).isoformat()
    path.write_text(
        'not json\n'
        f'{{"date": "{stale}", "delta": 10}}\n'
        f'{{"date": "{stale}", "delta": "oops"}}\n',
        encoding="utf-8",
    )
    assert documents._compact_history(path) is False  # nothing worth keeping → untouched
    assert stale in path.read_text(encoding="utf-8")


def test_compact_missing_file_is_noop(tmp_path):
    assert documents._compact_history(tmp_path / "nope.jsonl") is False


# --- _record_save trigger + startup pass ------------------------------------


def _make_project(data_dir: Path, project_id: str) -> Path:
    folder = data_dir / project_id
    (folder / "stats").mkdir(parents=True)
    (folder / "project.json").write_text("{}", encoding="utf-8")
    return folder


def test_record_save_compacts_when_over_threshold(data_dir, monkeypatch):
    monkeypatch.setattr(documents, "_COMPACT_SIZE_BYTES", 256)
    _make_project(data_dir, "proj")
    for i in range(30):
        documents._record_save("proj", f"doc{i}", 1)
    history = data_dir / "proj" / "stats" / "history.jsonl"
    parsed = [json.loads(l) for l in history.read_text(encoding="utf-8").splitlines() if l.strip()]
    # Threshold was crossed mid-run: the log folded once into a per-day sum,
    # then the remaining appends continued. Total daily delta is preserved.
    assert len(parsed) <= 3
    assert sum(e.get("delta", 0) for e in parsed) == 30
    assert any("doc" not in e for e in parsed)  # the folded per-day line exists


def test_record_save_small_file_untouched(data_dir, monkeypatch):
    monkeypatch.setattr(documents, "_COMPACT_SIZE_BYTES", 1024 * 1024)
    _make_project(data_dir, "proj")
    documents._record_save("proj", "doc1", 5)
    history = data_dir / "proj" / "stats" / "history.jsonl"
    lines = history.read_text(encoding="utf-8").splitlines()
    assert len(lines) == 1  # no rewrite happened (still the raw single entry)


def test_compact_overgrown_histories_scans_all_projects(data_dir, monkeypatch):
    monkeypatch.setattr(documents, "_COMPACT_SIZE_BYTES", 200)
    (data_dir / "a" / "stats").mkdir(parents=True)
    (data_dir / "b" / "stats").mkdir(parents=True)
    big = data_dir / "a" / "stats" / "history.jsonl"
    small = data_dir / "b" / "stats" / "history.jsonl"
    today = date.today().isoformat()
    _write_history(big, [{"date": today, "doc": f"d{i}", "delta": 1} for i in range(10)])
    _write_history(small, [{"date": today, "doc": "d1", "delta": 1}])

    assert documents.compact_overgrown_histories() == 1
    assert len(big.read_text(encoding="utf-8").splitlines()) == 1  # compacted
    assert len(small.read_text(encoding="utf-8").splitlines()) == 1  # untouched


def test_compact_history_can_run_after_upgrade(data_dir, monkeypatch):
    """A pre-existing large log shrinks on the next launch pass."""
    monkeypatch.setattr(documents, "_COMPACT_SIZE_BYTES", 200)
    (data_dir / "legacy" / "stats").mkdir(parents=True)
    history = data_dir / "legacy" / "stats" / "history.jsonl"
    today = date.today().isoformat()
    _write_history(history, [{"date": today, "doc": f"d{i}", "delta": 2} for i in range(8)])
    assert documents.compact_overgrown_histories() == 1
    assert _read_compact(history) == {today: 16}


# --- _sweep_orphan_tmp ------------------------------------------------------


def test_sweep_removes_only_old_tmp_files(tmp_path):
    now = time.time()
    fresh = tmp_path / "fresh.md.tmp"
    fresh.write_text("x")
    old = tmp_path / "old.md.tmp"
    old.write_text("x")
    deep_dir = tmp_path / "sub"
    deep_dir.mkdir()
    deep_old = deep_dir / ".c.md.123.tmp"
    deep_old.write_text("x")
    deep_fresh = deep_dir / "d.md.tmp"
    deep_fresh.write_text("x")
    real_doc = tmp_path / "chapter-1.md"
    real_doc.write_text("# x")
    for p in (old, deep_old):
        os.utime(p, (now - 36 * 3600, now - 36 * 3600))

    assert config._sweep_orphan_tmp(tmp_path) == 2
    assert not old.exists()
    assert not deep_old.exists()
    assert fresh.exists()
    assert deep_fresh.exists()
    assert real_doc.exists()


def test_sweep_does_not_raise_on_missing_root(tmp_path):
    assert config._sweep_orphan_tmp(tmp_path / "missing") == 0