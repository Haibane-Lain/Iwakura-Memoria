"""Lifecycle tests for the bundled LanguageTool integration.

These exercise ``app/services/grammar.py`` without a real JVM: httpx and
subprocess calls are faked so we can pin down the adopt-or-spawn decisions.
"""
from __future__ import annotations

import httpx
import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from app.services import grammar as grammar_service


class _FakeResponse:
    status_code = 200


class _FakePopen:
    """Minimal stand-in for subprocess.Popen with a poll() override."""

    def __init__(self, poll_result=None, cmd=None):
        self.cmd = cmd
        self._poll = poll_result
        self.killed = False

    def poll(self):
        return self._poll

    def terminate(self):
        self.killed = True

    def wait(self, timeout=None):
        return 0

    def kill(self):
        self.killed = True

    def __repr__(self):
        return f"<FakePopen poll={self._poll!r}>"


@pytest.fixture(autouse=True)
def _clean_grammar_state():
    grammar_service._lt_process = None
    grammar_service._client = None
    yield
    proc = grammar_service._lt_process
    if proc is not None and proc.poll() is None:
        proc.terminate()
    grammar_service._lt_process = None
    grammar_service._client = None


def _never_answers(*args, **kwargs):
    raise httpx.ConnectError("connection refused")


def _always_answers(*args, **kwargs):
    return _FakeResponse()


def test_adopts_existing_server_without_spawning(monkeypatch, capsys):
    """A healthy LanguageTool already on the port is reused, not duplicated."""
    calls = []
    monkeypatch.setattr(grammar_service.httpx, "get", lambda url, timeout=2: (calls.append(url), _FakeResponse())[1])

    spawned = []
    monkeypatch.setattr(
        grammar_service.subprocess,
        "Popen",
        lambda *a, **kw: (spawned.append(a), _FakePopen(poll_result=None))[1],
    )
    # JAR on disk is irrelevant when adopting — prove by pointing at a missing jar.
    monkeypatch.setattr(grammar_service, "_LT_JAR", __import__("pathlib").Path("nope") / "missing.jar")

    assert grammar_service.start_lt_server() is True
    assert spawned == []
    assert grammar_service._lt_process is None
    assert grammar_service._client is not None
    assert calls and calls[0].endswith("/v2/languages")
    assert "Reusing existing" in capsys.readouterr().out


def test_spawns_when_port_is_free(monkeypatch, tmp_path, capsys):
    """Nothing on the port yet -> the bundled JAR is launched and awaited."""
    probe_calls = []

    def flaky_probe(url, timeout=2):
        probe_calls.append(url)
        if len(probe_calls) == 1:
            raise httpx.ConnectError("connection refused")
        return _FakeResponse()

    monkeypatch.setattr(grammar_service.httpx, "get", flaky_probe)
    jar = tmp_path / "languagetool-server.jar"
    jar.write_text("fake jar")
    monkeypatch.setattr(grammar_service, "_LT_JAR", jar)
    monkeypatch.setattr(grammar_service, "_find_java", lambda: "java")

    spawned = []
    monkeypatch.setattr(
        grammar_service.subprocess,
        "Popen",
        lambda *a, **kw: (spawned.append(a), _FakePopen(poll_result=None))[1],
    )

    assert grammar_service.start_lt_server() is True
    assert len(spawned) == 1
    assert grammar_service._lt_process is not None
    assert grammar_service._client is not None
    assert "ready on port" in capsys.readouterr().out


def test_returns_false_when_spawned_process_dies(monkeypatch, tmp_path, capsys):
    """Spawned JVM crashes (e.g. port was taken after all) -> clear failure."""
    monkeypatch.setattr(grammar_service.httpx, "get", _never_answers)
    jar = tmp_path / "languagetool-server.jar"
    jar.write_text("fake jar")
    monkeypatch.setattr(grammar_service, "_LT_JAR", jar)
    monkeypatch.setattr(grammar_service, "_find_java", lambda: "java")
    monkeypatch.setattr(
        grammar_service.subprocess, "Popen", lambda *a, **kw: _FakePopen(poll_result=1)
    )

    assert grammar_service.start_lt_server() is False
    assert grammar_service._client is None
    assert "exited early" in capsys.readouterr().err


def test_recovers_from_dead_previous_spawn_by_adopting(monkeypatch):
    """The exact failure from the field: previous JVM died on a busy port,
    but the real server is still answering. Restart must adopt, not stay down."""
    grammar_service._lt_process = _FakePopen(poll_result=1)
    grammar_service._client = None

    calls = []
    monkeypatch.setattr(grammar_service.httpx, "get", lambda url, timeout=2: (calls.append(url), _FakeResponse())[1])
    monkeypatch.setattr(grammar_service, "_LT_JAR", None)

    assert grammar_service.start_lt_server() is True
    assert grammar_service._lt_process is None
    assert grammar_service._client is not None
    assert grammar_service.is_available() is True


def test_stop_does_not_kill_adopted_server(monkeypatch, capsys):
    """Adopted servers belong to someone else (a previous session); stop only
    closes our client, never terminates the external JVM."""
    monkeypatch.setattr(grammar_service.httpx, "get", _always_answers)
    assert grammar_service.start_lt_server() is True
    assert grammar_service._lt_process is None

    grammar_service.stop_lt_server()
    assert grammar_service._client is None
    assert grammar_service._lt_process is None


# --- HTTP route -------------------------------------------------------------


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("IWAKURA_DATA_DIR", str(tmp_path / "data"))
    return TestClient(create_app())


_H = {"host": "127.0.0.1"}


def test_status_reports_availability(client, monkeypatch):
    monkeypatch.setattr(grammar_service, "is_available", lambda: False)
    assert client.get("/api/grammar/status", headers=_H).json() == {"available": False}
    monkeypatch.setattr(grammar_service, "is_available", lambda: True)
    assert client.get("/api/grammar/status", headers=_H).json() == {"available": True}


def test_check_forwards_arguments_and_returns_matches(client, monkeypatch):
    seen = {}

    def fake_check(text, language="en-US", dictionary_words=None):
        seen.update(text=text, language=language, dictionary_words=dictionary_words)
        return [
            {
                "offset": 0,
                "length": 3,
                "message": "Possible typo",
                "replacements": ["the"],
                "rule_id": "MORFOLOGIK_RULE_EN_GB",
                "category": "TYPOS",
                "context_text": "teh cat",
                "context_offset": 0,
            }
        ]

    monkeypatch.setattr(grammar_service, "check", fake_check)
    resp = client.post(
        "/api/grammar/check",
        json={"text": "teh cat", "language": "en-GB", "dictionaryWords": ["cat"]},
        headers=_H,
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["matches"][0]["rule_id"] == "MORFOLOGIK_RULE_EN_GB"
    assert seen == {"text": "teh cat", "language": "en-GB", "dictionary_words": ["cat"]}


def test_check_defaults_language_and_dictionary(client, monkeypatch):
    seen = {}

    def fake_check(text, language="en-US", dictionary_words=None):
        seen.update(text=text, language=language, dictionary_words=dictionary_words)
        return []

    monkeypatch.setattr(grammar_service, "check", fake_check)
    assert client.post("/api/grammar/check", json={"text": "hi"}, headers=_H).status_code == 200
    assert seen == {"text": "hi", "language": "en-US", "dictionary_words": None}


def test_check_returns_503_when_unavailable(client, monkeypatch):
    monkeypatch.setattr(grammar_service, "check", lambda *a, **k: None)
    resp = client.post("/api/grammar/check", json={"text": "teh"}, headers=_H)
    assert resp.status_code == 503
    assert "not available" in resp.json()["detail"]


def test_check_requires_text(client):
    assert client.post("/api/grammar/check", json={}, headers=_H).status_code == 422
