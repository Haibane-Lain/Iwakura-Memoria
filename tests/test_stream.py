"""Tests for the per-session AI run guard (R3)."""
from __future__ import annotations

import asyncio
import threading

import pytest

from app.ai import stream


def test_begin_run_rejects_concurrent_run():
    ev = stream.begin_run("sess-1")
    assert ev is not None
    try:
        assert stream.begin_run("sess-1") is None  # already active
    finally:
        stream.end_run("sess-1", ev)
    ev2 = stream.begin_run("sess-1")
    assert ev2 is not None  # free again after end_run
    stream.end_run("sess-1", ev2)


def test_end_run_only_clears_its_own_event():
    ev = stream.begin_run("sess-2")
    assert ev is not None
    stream.end_run("sess-2", threading.Event())  # wrong event → no-op
    assert stream._active_runs.get("sess-2") is ev
    stream.end_run("sess-2", ev)
    assert "sess-2" not in stream._active_runs


def test_cancel_run_signals_the_active_event():
    ev = stream.begin_run("sess-3")
    assert ev is not None
    try:
        assert stream.cancel_run("sess-3") is True
        assert ev.is_set()
    finally:
        stream.end_run("sess-3", ev)
    assert stream.cancel_run("sess-3") is False


def test_stream_chat_conflict_when_session_busy():
    ev = stream.begin_run("sess-4")
    assert ev is not None
    try:
        async def consume():
            async for _event in stream.stream_chat("proj", {"sessionId": "sess-4"}, "hi"):
                pass

        with pytest.raises(stream.RunConflictError):
            asyncio.run(consume())
    finally:
        stream.end_run("sess-4", ev)
