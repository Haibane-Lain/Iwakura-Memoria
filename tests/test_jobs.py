"""Long-job engine: planner, strict records, resume, invalidation, renderer."""
from __future__ import annotations

import json
import re

import pytest

from app.ai import jobs, sessions
from app.services import documents as documents_service

_ENTRY_RE = re.compile(r'<entry id="([^"]+)"')


class FakeClient:
    supports_json_mode = False

    def __init__(self, responder):
        self.responder = responder
        self.calls = 0

    def chat(self, messages, tools=None, temperature=0.3, max_tokens=None, response_format=None):
        self.calls += 1
        return {
            "content": self.responder(messages),
            "usage": {"prompt_tokens": 5, "completion_tokens": 2, "total_tokens": 7},
        }


def _entry_ids(messages):
    return _ENTRY_RE.findall(messages[-1]["content"])


def _extract_responder(messages):
    return json.dumps(
        {
            "entries": [
                {"entryId": eid, "items": [{"label": f"L {eid}", "detail": "d"}]}
                for eid in _entry_ids(messages)
            ]
        }
    )


def _timeline_responder(messages):
    return json.dumps(
        {
            "entries": [
                {
                    "entryId": eid,
                    "items": [{"date": "TA 1", "event": f"E {eid}", "chronology": "TA 1"}],
                }
                for eid in _entry_ids(messages)
            ]
        }
    )


def _patch(monkeypatch, client):
    monkeypatch.setattr(jobs.providers, "get_client", lambda settings, session_id="": client)
    return client


def _project(make_project, n=3):
    make_project("proj")
    ids = []
    for i in range(n):
        doc = documents_service.create_document("proj", f"Ch {i}", content=f"Body {i}.")
        ids.append(doc["id"])
    return ids


def _session(access="write"):
    session = sessions.create("proj")
    if access == "write":
        session = sessions.set_access("proj", session["sessionId"], "write")
    return session


# --- planner -----------------------------------------------------------------


def test_plan_chunks_packs_whole_entries():
    entries = [{"id": "a", "body": "x" * 10}, {"id": "b", "body": "y" * 10}]
    chunks = jobs.plan_chunks(entries, chunk_chars=25)
    assert len(chunks) == 1
    assert [item["id"] for item in chunks[0]["items"]] == ["a", "b"]


def test_plan_chunks_breaks_when_full():
    entries = [{"id": "a", "body": "x" * 20}, {"id": "b", "body": "y" * 20}]
    chunks = jobs.plan_chunks(entries, chunk_chars=25)
    assert [item["id"] for chunk in chunks for item in chunk["items"]] == ["a", "b"]
    assert len(chunks) == 2


def test_plan_chunks_splits_oversized_entry_with_overlap():
    chunks = jobs.plan_chunks([{"id": "a", "body": "x" * 1200}], chunk_chars=600)
    assert len(chunks) >= 2
    assert all(chunk["items"][0]["id"] == "a" for chunk in chunks)
    assert chunks[1]["items"][0]["start"] == 600 - jobs.JOB_CHUNK_OVERLAP


def test_resolve_entries_respects_scope(make_project):
    _project(make_project, 2)
    # Root documents are not in the wiki-only scope.
    assert jobs.resolve_entries("proj", ["worldbuilding"], folders=[""]) == []


# --- strict JSON --------------------------------------------------------------


def test_parse_skips_unknown_ids_and_empty_items():
    recipe = jobs.RECIPES["extract"]
    raw = json.dumps(
        {
            "entries": [
                {
                    "entryId": "a",
                    "items": [{"label": "", "detail": ""}, {"label": "ok", "detail": "d"}],
                },
                {"entryId": "zzz", "items": [{"label": "x", "detail": "y"}]},
            ]
        }
    )
    records = recipe.parse(raw, {"a"})
    assert len(records) == 1
    assert [item.label for item in records[0].items] == ["ok"]


def test_parse_accepts_fenced_json():
    recipe = jobs.RECIPES["extract"]
    raw = '```json\n{"entries": [{"entryId": "a", "items": [{"label": "x", "detail": ""}]}]}\n```'
    records = recipe.parse(raw, {"a"})
    assert len(records[0].items) == 1


def test_parse_raises_on_non_json():
    with pytest.raises(jobs.RecordError):
        jobs.RECIPES["extract"].parse("not json at all", {"a"})


def test_repair_call_recovers(monkeypatch, make_project, data_dir):
    _project(make_project, 1)
    state = {"n": 0}

    def responder(messages):
        state["n"] += 1
        if state["n"] == 1:
            return "sorry, here is prose instead of json"
        return _extract_responder(messages)

    _patch(monkeypatch, FakeClient(responder))
    session = _session("write")
    job = jobs.create_job("proj", session, "extract", folders=[""], instruction="x")
    events = list(jobs.run_job("proj", session, job))
    assert events[-1]["type"] == "job_done"
    assert state["n"] == 2  # one bad reply, one repaired


# --- execution ----------------------------------------------------------------


def test_extract_job_runs_and_writes(make_project, monkeypatch, data_dir):
    _project(make_project, 3)
    client = _patch(monkeypatch, FakeClient(_extract_responder))
    session = _session("write")
    job = jobs.create_job("proj", session, "extract", folders=[""], instruction="list facts")
    events = list(jobs.run_job("proj", session, job))
    assert events[0]["type"] == "job_start"
    assert events[-1]["type"] == "job_done"
    assert job["status"] == "done"
    assert client.calls == len(job["chunks"])
    assert job["output"]["status"] == "written"
    doc = documents_service.get_document("proj", job["output"]["entryId"])
    assert "Ch 0" in doc["content"] or "L " in doc["content"]


def test_plan_access_defers_the_write(make_project, monkeypatch, data_dir):
    _project(make_project, 2)
    _patch(monkeypatch, FakeClient(_extract_responder))
    session = _session("plan")
    job = jobs.create_job("proj", session, "extract", folders=[""], instruction="x")
    list(jobs.run_job("proj", session, job))
    assert job["reduce"]["status"] == "done"
    assert job["output"]["status"] == "pending_access"
    assert job["output"]["entryId"] is None


def test_timeline_job_renders_contract(make_project, monkeypatch, data_dir):
    _project(make_project, 2)
    _patch(monkeypatch, FakeClient(_timeline_responder))
    session = _session("write")
    job = jobs.create_job(
        "proj", session, "timeline", folders=[""],
        options={"outputTitle": "The War"},
    )
    list(jobs.run_job("proj", session, job))
    doc = documents_service.get_document("proj", job["output"]["entryId"])
    assert '<aside class="timeline">' in doc["content"]
    assert '<tr class="tl-title"><th colspan="2">The War</th></tr>' in doc["content"]
    assert "E " in doc["content"]
    assert "\n\n" not in doc["content"]


def test_resume_skips_completed_chunks(make_project, monkeypatch, data_dir):
    _project(make_project, 2)
    session = _session("write")
    job = jobs.create_job("proj", session, "extract", folders=[""], instruction="x")
    for chunk in job["chunks"]:
        job["chunkResults"][str(chunk["index"])] = {
            "status": "done",
            "records": [{"entryId": "x", "items": []}],
        }

    class Boom:
        supports_json_mode = False

        def chat(self, *args, **kwargs):
            raise AssertionError("the model must not be called for completed chunks")

    monkeypatch.setattr(jobs.providers, "get_client", lambda settings, session_id="": Boom())
    events = list(jobs.run_job("proj", session, job))
    assert events[-1]["type"] == "job_done"


def test_changed_entry_invalidates_its_chunk(make_project, monkeypatch, data_dir):
    ids = _project(make_project, 1)
    client = _patch(monkeypatch, FakeClient(_extract_responder))
    session = _session("write")
    job = jobs.create_job("proj", session, "extract", entries=ids, instruction="x")
    list(jobs.run_job("proj", session, job))
    assert client.calls == 1

    documents_service.save_document("proj", ids[0], "A much longer replacement body with more words now.")
    list(jobs.run_job("proj", session, job))
    assert client.calls == 2


def test_chunk_failure_does_not_kill_the_job(make_project, monkeypatch, data_dir):
    _project(make_project, 1)
    client = FakeClient(lambda messages: "not json")
    _patch(monkeypatch, client)
    session = _session("write")
    job = jobs.create_job("proj", session, "extract", folders=[""], instruction="x")
    events = list(jobs.run_job("proj", session, job))
    assert any(event["type"] == "job_chunk_failed" for event in events)
    assert events[-1]["type"] == "job_done"


def test_create_job_rejects_empty_selection(make_project, data_dir):
    make_project("proj")
    session = _session("write")
    with pytest.raises(jobs.JobError):
        jobs.create_job("proj", session, "extract", entries=["nope"], instruction="x")


def test_create_job_requires_instruction_for_extract(make_project, data_dir):
    _project(make_project, 1)
    session = _session("write")
    with pytest.raises(jobs.JobError):
        jobs.create_job("proj", session, "extract", folders=[""])


# --- timeline reduce / renderer ----------------------------------------------


def test_timeline_reduce_dedupes_and_orders():
    recipe = jobs.RECIPES["timeline"]
    records = [
        {
            "entryId": "a",
            "items": [
                {"date": "TA 300", "event": "Battle", "section": "War", "chronology": "TA 300"},
                {"date": "TA 100", "event": "Prophecy", "section": "War", "chronology": "TA 100"},
            ],
        },
        {
            "entryId": "b",
            "items": [{"date": "TA 300", "event": "battle", "section": "War", "chronology": "TA 300"}],
        },
    ]
    artifact = recipe.reduce({"kind": "timeline", "options": {"chronological": True}}, records)
    section = artifact["sections"][0]
    assert [event["body"] for event in section["events"]] == ["Prophecy", "Battle"]


def test_render_timeline_matches_editor_contract():
    artifact = {
        "title": "War",
        "sections": [
            {"name": "Act I", "events": [{"date": "TA 1", "body": "A <b> & c"}]},
            {"name": "", "events": [{"date": "", "body": "Undated"}]},
        ],
    }
    html = jobs.render_timeline(artifact)
    assert html.startswith('<aside class="timeline">\n<table class="tl-rows">')
    assert html.endswith("</table>\n</aside>")
    assert '<tr class="tl-title"><th colspan="2">War</th></tr>' in html
    assert '<tr class="tl-section"><th colspan="2">Act I</th></tr>' in html
    assert '<tr class="tl-event"><td class="tl-date">TA 1</td><td class="tl-body">A &lt;b&gt; &amp; c</td></tr>' in html
    assert "Undated" in html
    assert html.count('<tr class="tl-section">') == 1  # empty section name is skipped
    assert "\n\n" not in html  # a blank line would terminate the raw block
