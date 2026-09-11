"""Tests for AI session persistence and per-session cleanup."""
from __future__ import annotations

import os

from app.ai import sessions


def test_create_and_load_roundtrip(data_dir):
    s = sessions.create("proj")
    assert s["sessionId"]
    loaded = sessions.load("proj", s["sessionId"])
    assert loaded is not None
    assert loaded["sessionId"] == s["sessionId"]
    assert loaded["scope"] == ["", "worldbuilding"]
    assert loaded["history"] == []


def test_list_sessions_orders_newest_first(data_dir):
    a = sessions.create("proj")
    b = sessions.create("proj")
    listed = sessions.list_sessions("proj")
    assert [x["sessionId"] for x in listed] == [b["sessionId"], a["sessionId"]]


def test_rename_sets_title(data_dir):
    s = sessions.create("proj")
    out = sessions.rename("proj", s["sessionId"], "  My title  ")
    assert out["title"] == "My title"
    # blank rename keeps the current title
    out2 = sessions.rename("proj", s["sessionId"], "   ")
    assert out2["title"] == "My title"


def test_delete_removes_json_and_attachment_dir(data_dir):
    s = sessions.create("proj")
    sid = s["sessionId"]
    # Write a fake attachment directory next to the session JSON, as add()
    # would: raw file + extracted text + metadata.
    att = sessions.session_dir("proj", sid) / "attachments"
    att.mkdir(parents=True)
    (att / "abc123.pdf").write_bytes(b"%PDF-fake")
    (att / "abc123.txt").write_text("extracted", encoding="utf-8")
    (att / "metadata.json").write_text("[]", encoding="utf-8")

    assert sessions.delete("proj", sid) is True
    assert sessions.load("proj", sid) is None
    assert not sessions.session_dir("proj", sid).exists()


def test_cleanup_prunes_the_attachment_dir_with_the_session(data_dir, monkeypatch):
    """Auto-pruning past ``_MAX_SESSIONS`` must delete the session's sibling
    attachment directory too, not just its JSON. Regression: ``_cleanup``
    unlinked the JSON, so every pruned session leaked its raw uploads."""
    old = sessions.create("proj")
    new = sessions.create("proj")
    att = sessions.session_dir("proj", old["sessionId"]) / "attachments"
    att.mkdir(parents=True)
    (att / "abc123.pdf").write_bytes(b"%PDF-fake")

    # Force a deterministic age order so the session we gave storage to is the
    # one that overflows the (patched) cap.
    monkeypatch.setattr(sessions, "_MAX_SESSIONS", 1)
    os.utime(sessions._path("proj", old["sessionId"]), (1_000_000, 1_000_000))
    os.utime(sessions._path("proj", new["sessionId"]), (2_000_000, 2_000_000))
    sessions._cleanup("proj")

    assert sessions.load("proj", old["sessionId"]) is None
    assert not sessions.session_dir("proj", old["sessionId"]).exists()
    assert sessions.load("proj", new["sessionId"]) is not None


def test_cleanup_sweeps_orphaned_attachment_dirs(data_dir):
    """A session directory with no sibling JSON is a leak from an older version
    that pruned the JSON only; the next cleanup should reclaim it."""
    orphan = sessions.session_dir("proj", "a" * 32) / "attachments"
    orphan.mkdir(parents=True)
    (orphan / "old.pdf").write_bytes(b"%PDF-fake")

    sessions.create("proj")  # create() runs _cleanup()

    assert not sessions.session_dir("proj", "a" * 32).exists()


def test_delete_missing_returns_false(data_dir):
    assert sessions.delete("proj", "0" * 32) is False


def test_load_after_delete_is_none(data_dir):
    s = sessions.create("proj")
    sessions.delete("proj", s["sessionId"])
    assert sessions.load("proj", s["sessionId"]) is None
