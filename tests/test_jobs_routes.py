"""Long-job routes: create, list, stream, pause, apply, delete."""
from __future__ import annotations

import json
import re

import pytest
from fastapi.testclient import TestClient

from app import config
from app.ai import jobs, sessions
from app.main import create_app
from app.services import documents as documents_service

_ENTRY_RE = re.compile(r'<entry id="([^"]+)"')


class FakeClient:
    supports_json_mode = False

    def __init__(self, responder):
        self.responder = responder

    def chat(self, messages, tools=None, temperature=0.3, max_tokens=None, response_format=None):
        return {
            "content": self.responder(messages),
            "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
        }


def _responder(messages):
    ids = _ENTRY_RE.findall(messages[-1]["content"])
    return json.dumps(
        {
            "entries": [
                {"entryId": eid, "items": [{"label": f"L {eid}", "detail": "d"}]}
                for eid in ids
            ]
        }
    )


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("IWAKURA_DATA_DIR", str(tmp_path / "data"))
    return TestClient(create_app(), base_url="http://127.0.0.1")


def _seed(name="proj"):
    """Create a project folder + a few documents in the (env-derived) data dir."""
    folder = config.DATA_DIR / name
    (folder / "stats").mkdir(parents=True, exist_ok=True)
    (folder / "project.json").write_text("{}", encoding="utf-8")
    for i in range(3):
        documents_service.create_document(name, f"Ch {i}", content=f"Body {i}.")


def _patch_client(monkeypatch):
    monkeypatch.setattr(
        jobs.providers, "get_client", lambda settings, session_id="": FakeClient(_responder)
    )


def _new_session(client, access=None):
    sid = client.post("/api/projects/proj/ai/sessions").json()["sessionId"]
    if access:
        resp = client.patch(f"/api/projects/proj/ai/sessions/{sid}", json={"access": access})
        assert resp.status_code == 200
    return sid


def _create_job(client, sid, **overrides):
    payload = {"kind": "extract", "folders": [""], "instruction": "list facts"}
    payload.update(overrides)
    return client.post(f"/api/projects/proj/ai/sessions/{sid}/jobs", json=payload)


def test_create_list_and_delete(client, monkeypatch):
    _seed()
    _patch_client(monkeypatch)
    sid = _new_session(client)
    resp = _create_job(client, sid)
    assert resp.status_code == 201
    job = resp.json()
    assert job["status"] == "pending"
    assert job["progress"]["chunksTotal"] >= 1

    listed = client.get(f"/api/projects/proj/ai/sessions/{sid}/jobs").json()
    assert [j["jobId"] for j in listed] == [job["jobId"]]

    assert client.delete(f"/api/projects/proj/ai/sessions/{sid}/jobs/{job['jobId']}").status_code == 200
    assert client.get(f"/api/projects/proj/ai/sessions/{sid}/jobs").json() == []


def test_run_stream_writes_output(client, monkeypatch):
    _seed()
    _patch_client(monkeypatch)
    sid = _new_session(client, access="write")
    job = _create_job(client, sid).json()
    url = f"/api/projects/proj/ai/sessions/{sid}/jobs/{job['jobId']}/stream"
    with client.stream("POST", url) as resp:
        assert resp.status_code == 200
        text = "".join(resp.iter_text())
    assert "event: job_chunk_done" in text
    assert "event: job_done" in text

    after = client.get(f"/api/projects/proj/ai/sessions/{sid}/jobs/{job['jobId']}").json()
    assert after["status"] == "done"
    assert after["output"]["status"] == "written"
    doc = documents_service.get_document("proj", after["output"]["entryId"])
    assert "Ch 0" in doc["content"] or "L " in doc["content"]


def test_plan_access_job_defers_and_apply_is_refused(client, monkeypatch):
    _seed()
    _patch_client(monkeypatch)
    sid = _new_session(client)  # default access is plan
    job = _create_job(client, sid).json()
    url = f"/api/projects/proj/ai/sessions/{sid}/jobs/{job['jobId']}/stream"
    with client.stream("POST", url):
        pass
    after = client.get(f"/api/projects/proj/ai/sessions/{sid}/jobs/{job['jobId']}").json()
    assert after["reduce"]["status"] == "done"
    assert after["output"]["status"] == "pending_access"

    apply_url = f"/api/projects/proj/ai/sessions/{sid}/jobs/{job['jobId']}/apply"
    assert client.post(apply_url).status_code == 409


def test_create_rejects_bad_kind_and_empty_selection(client, monkeypatch):
    _seed()
    _patch_client(monkeypatch)
    sid = _new_session(client)
    assert _create_job(client, sid, kind="nonsense").status_code == 400
    assert _create_job(client, sid, folders=[], entries=["missing"]).status_code == 400


def test_jobs_blocked_while_confirmation_pending(client, monkeypatch):
    _seed()
    _patch_client(monkeypatch)
    sid = _new_session(client)
    session = sessions.load("proj", sid)
    session["agentState"] = {"pending": {"name": "delete_entry", "args": {}}, "deferred": []}
    sessions.save("proj", session)
    assert _create_job(client, sid).status_code == 409


def test_pause_when_not_running_is_ok(client, monkeypatch):
    _seed()
    _patch_client(monkeypatch)
    sid = _new_session(client)
    job = _create_job(client, sid).json()
    resp = client.post(f"/api/projects/proj/ai/sessions/{sid}/jobs/{job['jobId']}/pause")
    assert resp.status_code == 200
    assert resp.json()["ok"] is True


def test_unknown_job_is_404(client):
    sid = _new_session(client)
    assert client.get(f"/api/projects/proj/ai/sessions/{sid}/jobs/{'a' * 32}").status_code == 404
