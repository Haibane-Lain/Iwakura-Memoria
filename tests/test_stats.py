"""Tests for history.jsonl compaction, the orphan-tmp sweep, and the full
daily-history endpoint.

Run from the workspace root:

    .venv\\Scripts\\python.exe -m pytest tests/ -q
"""
from __future__ import annotations

import json
import os
import time
from datetime import date, datetime, timedelta
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app import config
from app.main import create_app
from app.services import documents
from app.services import stats as stats_service


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


def test_compact_history_sums_days_and_keeps_old_ones(tmp_path):
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
    # per-day sums, all days kept (even years-old ones) — only per-save
    # detail (doc id, timestamp) is dropped so the full history stays visible
    assert _read_compact(path) == {old: 500, yesterday: 150, today.isoformat(): 25}


def test_compact_ignores_garbage_but_keeps_valid_old_entries(tmp_path):
    path = tmp_path / "history.jsonl"
    stale = (date.today() - timedelta(days=800)).isoformat()
    path.write_text(
        'not json\n'
        f'{{"date": "{stale}", "delta": 10}}\n'
        f'{{"date": "{stale}", "delta": "oops"}}\n',
        encoding="utf-8",
    )
    # The valid old entry survives (summed); garbage and invalid deltas drop.
    assert documents._compact_history(path) is True
    assert _read_compact(path) == {stale: 10}
    assert "not json" not in path.read_text(encoding="utf-8")


def test_compact_leaves_garbage_only_file_untouched(tmp_path):
    path = tmp_path / "history.jsonl"
    path.write_text("not json\n{}\n", encoding="utf-8")
    assert documents._compact_history(path) is False
    assert "not json" in path.read_text(encoding="utf-8")


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
    parsed = [
        json.loads(line)
        for line in history.read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]
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


# --- get_daily_history -------------------------------------------------------


def _make_project_meta(data_dir: Path, project_id: str, created_at: str) -> Path:
    folder = data_dir / project_id
    (folder / "stats").mkdir(parents=True)
    (folder / "project.json").write_text(
        json.dumps({"title": project_id, "createdAt": created_at}),
        encoding="utf-8",
    )
    return folder


def test_daily_history_spans_from_creation_to_today(data_dir):
    created = (datetime.now() - timedelta(days=10)).astimezone()
    since = created.astimezone().date()
    folder = _make_project_meta(data_dir, "proj", created.isoformat())
    today = date.today()
    _write_history(folder / "stats" / "history.jsonl", [
        {"date": since.isoformat(), "delta": 200},
        {"date": today.isoformat(), "delta": 50},
        {"date": today.isoformat(), "delta": -5},
    ])
    result = stats_service.get_daily_history("proj")
    assert result["projectId"] == "proj"
    assert result["since"] == since.isoformat()
    assert len(result["days"]) == (today - since).days + 1
    # ascending, oldest first
    assert result["days"][0] == {"date": since.isoformat(), "words": 200}
    assert result["days"][-1] == {"date": today.isoformat(), "words": 45}
    # dense zero-fill on days with no entries
    gap = (today - timedelta(days=5)).isoformat()
    assert {"date": gap, "words": 0} in result["days"]


def test_daily_history_starts_at_earliest_entry_when_history_predates_meta(data_dir):
    today = date.today()
    # meta says created two days ago, but the log has older entries (a
    # project that was renamed/recreated — the real mother-of-horrors case)
    created = (datetime.now() - timedelta(days=2)).astimezone()
    folder = _make_project_meta(data_dir, "proj", created.isoformat())
    earliest = (today - timedelta(days=6)).isoformat()
    _write_history(folder / "stats" / "history.jsonl", [
        {"date": earliest, "delta": 100},
        {"date": today.isoformat(), "delta": 7},
    ])
    result = stats_service.get_daily_history("proj")
    assert result["since"] == earliest
    assert result["days"][0]["words"] == 100
    assert len(result["days"]) == 7
    # dense ascending across the gap
    assert result["days"][1] == {"date": (today - timedelta(days=5)).isoformat(), "words": 0}


def test_daily_history_falls_back_to_earliest_entry_without_created_at(data_dir):
    today = date.today()
    folder = _make_project_meta(data_dir, "proj", "")
    earliest = (today - timedelta(days=3)).isoformat()
    _write_history(folder / "stats" / "history.jsonl", [
        {"date": earliest, "delta": 25},
    ])
    result = stats_service.get_daily_history("proj")
    assert result["since"] == earliest
    assert len(result["days"]) == 4


def test_daily_history_clamps_future_created_at_and_handles_empty_log(data_dir):
    future = (datetime.now() + timedelta(days=5)).astimezone()
    _make_project_meta(data_dir, "proj", future.isoformat())
    result = stats_service.get_daily_history("proj")
    assert result["since"] == date.today().isoformat()
    assert result["days"] == [{"date": date.today().isoformat(), "words": 0}]


def test_stats_daily_route_full_history_and_404(tmp_path, monkeypatch):
    monkeypatch.setenv("IWAKURA_DATA_DIR", str(tmp_path / "data"))
    client = TestClient(create_app())
    _H = {"host": "127.0.0.1"}
    r = client.get("/api/projects/nope/stats/daily", headers=_H)
    assert r.status_code == 404
    created = client.post("/api/projects", json={"name": "Demo"}, headers=_H)
    assert created.status_code == 201
    today = date.today()
    _write_history(tmp_path / "data" / "demo" / "stats" / "history.jsonl", [
        {"date": (today - timedelta(days=2)).isoformat(), "delta": 300},
        {"date": today.isoformat(), "delta": 12},
    ])
    r = client.get("/api/projects/demo/stats/daily", headers=_H)
    assert r.status_code == 200
    body = r.json()
    assert body["projectId"] == "demo"
    assert body["days"][-1] == {"date": today.isoformat(), "words": 12}
    # full span since the earliest recorded day, not a 30-day slice
    assert body["since"] == (today - timedelta(days=2)).isoformat()
    assert len(body["days"]) == 3
