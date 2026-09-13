"""Access (Plan/Write) and Mode (Simple/Advanced), and the Simple context picker.

Both are enforced server-side: Simple withholds the read tools and limits writes
to the entries the user selected; Plan withholds every write tool.
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.ai import agent, sessions, tools
from app.main import create_app

WRITE_TOOL_NAMES = {
    "create_entry",
    "create_folder",
    "edit_entry",
    "rename_entry",
    "move_entry",
    "move_folder",
    "delete_entry",
    "delete_folder",
}
READ_TOOL_NAMES = {"list_tree", "read_entry", "read_attachment"}


def _schema_names(mode, access):
    return {s["function"]["name"] for s in tools.schemas(mode, access)}


# --- schema matrix ----------------------------------------------------------


def test_advanced_plan_advertises_read_tools_only():
    assert _schema_names("advanced", "plan") == READ_TOOL_NAMES


def test_advanced_write_advertises_everything():
    assert _schema_names("advanced", "write") == READ_TOOL_NAMES | WRITE_TOOL_NAMES


def test_simple_plan_advertises_nothing():
    assert _schema_names("simple", "plan") == set()


def test_simple_write_advertises_write_tools_only():
    names = _schema_names("simple", "write")
    assert names == tools.SIMPLE_WRITE_TOOLS
    assert not (names & READ_TOOL_NAMES)
    # Folder moves/deletes need a picked entry to authorize them.
    assert "move_folder" not in names
    assert "delete_folder" not in names


# --- dispatch enforcement ---------------------------------------------------


@pytest.mark.parametrize("name", sorted(WRITE_TOOL_NAMES))
def test_advanced_plan_refuses_writes(name):
    with pytest.raises(tools.ToolError):
        tools.dispatch(name, {"entryId": "x"}, "proj", [""], mode="advanced", access="plan")


def test_simple_refuses_reads_and_plan_refuses_everything(make_project):
    make_project("proj")
    with pytest.raises(tools.ToolError):
        tools.dispatch("list_tree", {}, "proj", [""], mode="simple", access="write")
    with pytest.raises(tools.ToolError):
        tools.dispatch("list_tree", {}, "proj", [""], mode="simple", access="plan")
    with pytest.raises(tools.ToolError):
        tools.dispatch("create_entry", {"title": "x"}, "proj", [""], mode="simple", access="plan")


def test_simple_refuses_folder_moves_and_deletes():
    with pytest.raises(tools.ToolError):
        tools.dispatch("move_folder", {"folderId": "a", "targetFolder": ""}, "proj", [""],
                       mode="simple", access="write")
    with pytest.raises(tools.ToolError):
        tools.dispatch("delete_folder", {"folderId": "a"}, "proj", [""],
                       mode="simple", access="write")


def test_simple_writes_are_limited_to_selected_entries(make_project):
    make_project("proj")
    args = {"entryId": "Part/01-a", "content": "new"}
    with pytest.raises(tools.ToolError):
        tools.dispatch("edit_entry", args, "proj", [""], mode="simple", access="write",
                       selected_entries=["Part/01-b"])
    # A selected id passes the mode gate (the file then fails to open, which is
    # fine — the point is that it is not refused for being unselected).
    with pytest.raises(tools.ToolError) as exc:
        tools.dispatch("edit_entry", args, "proj", [""], mode="simple", access="write",
                       selected_entries=["Part/01-a"])
    assert "not one of the entries selected" not in str(exc.value)


def test_simple_allows_creating_in_accessible_folders(make_project):
    make_project("proj")
    created, action = tools.dispatch(
        "create_entry", {"title": "New note"}, "proj", [""],
        mode="simple", access="write", selected_entries=[],
    )
    assert created and action["tool"] == "create_entry"


# --- session state ----------------------------------------------------------


def test_new_session_defaults(data_dir):
    session = sessions.create("proj")
    assert session["access"] == "plan"
    assert session["mode"] == "advanced"
    assert session["selectedEntries"] == []


def test_access_and_mode_fall_back_for_old_sessions():
    # A session written before the split stored plan/write under ``mode``.
    assert sessions.session_access({"mode": "write"}) == "write"
    assert sessions.session_access({"mode": "plan"}) == "plan"
    assert sessions.session_mode({"mode": "plan"}) == "advanced"
    assert sessions.session_access({}) == "plan"
    assert sessions.session_mode({"mode": "simple"}) == "simple"


def test_set_access_and_mode_persist_and_validate(data_dir):
    sid = sessions.create("proj")["sessionId"]
    assert sessions.set_access("proj", sid, "write")["access"] == "write"
    assert sessions.set_mode("proj", sid, "simple")["mode"] == "simple"
    assert sessions.load("proj", sid)["mode"] == "simple"
    with pytest.raises(ValueError):
        sessions.set_access("proj", sid, "advanced")
    with pytest.raises(ValueError):
        sessions.set_mode("proj", sid, "write")


def test_set_selected_entries_dedupes_and_caps(data_dir):
    sid = sessions.create("proj")["sessionId"]
    out = sessions.set_selected_entries("proj", sid, ["a", "a", " b ", ""])
    assert out["selectedEntries"] == ["a", "b"]
    many = [f"e{i}" for i in range(sessions.MAX_SELECTED_ENTRIES + 10)]
    out = sessions.set_selected_entries("proj", sid, many)
    assert len(out["selectedEntries"]) == sessions.MAX_SELECTED_ENTRIES


# --- prompt + injected context ---------------------------------------------


def test_system_prompt_describes_each_combination():
    simple_write = agent.system_prompt([""], None, None, mode="simple", access="write")
    assert "SIMPLE mode" in simple_write
    assert "Access is WRITE" in simple_write
    simple_plan = agent.system_prompt([""], None, None, mode="simple", access="plan")
    assert "Access is PLAN" in simple_plan
    advanced_plan = agent.system_prompt([""], None, None, mode="advanced", access="plan")
    assert "Access is PLAN" in advanced_plan
    advanced_write = agent.system_prompt([""], None, None, mode="advanced", access="write")
    assert "SIMPLE mode" not in advanced_write
    assert "Access is PLAN" not in advanced_write


def test_selected_context_injects_picked_entries_and_outline(make_project):
    from app.services import documents as documents_service

    make_project("proj")
    doc = documents_service.create_document("proj", "Mara", content="Mara is the captain.")
    session = {
        "sessionId": "a" * 32,
        "scope": [""],
        "mode": "simple",
        "selectedEntries": [doc["id"]],
    }
    context = agent._selected_context("proj", session)
    assert "Mara is the captain." in context
    assert doc["id"] in context
    assert "Accessible folders and entries" in context


def test_selected_context_skips_entries_outside_scope(make_project):
    from app.services import documents as documents_service

    make_project("proj")
    doc = documents_service.create_document(
        "proj", "Hidden", folder="worldbuilding", content="secret"
    )
    session = {"scope": [""], "selectedEntries": [doc["id"]]}
    context = agent._selected_context("proj", session)
    assert "secret" not in context


def test_read_digest_extracts_title_and_snippet():
    content = (
        'Entry: [Part/01-x] "Mara" (kind: note, type: character, words: 5, chars: 21)\n'
        "---\nMara is the captain.\n---\n(chars 0–21 of 21; end of entry)"
    )
    digest = agent._read_digest("Part/01-x", content)
    assert digest["title"] == "Mara"
    assert "captain" in digest["snippet"]


def test_system_prompt_uses_read_digests_not_the_stale_claim():
    digests = [{"id": "a", "title": "Mara", "snippet": "the captain"}]
    prompt = agent.system_prompt([""], None, None, read_digests=digests)
    assert "Mara" in prompt
    assert "the captain" in prompt
    assert "you know their content" not in prompt


def test_system_prompt_accepts_dict_read_digests():
    """Regression: session readDigests are stored as a dict, not a list.

    Slicing a dict raised ``KeyError: slice(None, 20, None)`` on Python 3.12+
    (hashable slices), which aborted every turn after a read.
    """
    digests = {"a": {"id": "a", "title": "Mara", "snippet": "the captain"}}
    prompt = agent.system_prompt([""], None, None, read_digests=digests)
    assert "Mara" in prompt


def test_build_messages_handles_stored_read_digests():
    session = {
        "scope": [""],
        "readDigests": {"a": {"id": "a", "title": "Mara", "snippet": "the captain"}},
        "history": [],
    }
    messages = agent._build_messages("proj", session, "hi")
    assert "Mara" in messages[0]["content"]


# --- routes -----------------------------------------------------------------


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("IWAKURA_DATA_DIR", str(tmp_path / "data"))
    return TestClient(create_app(), base_url="http://127.0.0.1")


def test_session_create_and_patch_round_trip(client):
    session = client.post("/api/projects/proj/ai/sessions").json()
    sid = session["sessionId"]
    assert session["access"] == "plan"
    assert session["mode"] == "advanced"
    assert session["selectedEntries"] == []

    r = client.patch(
        f"/api/projects/proj/ai/sessions/{sid}",
        json={"access": "write", "mode": "simple", "selectedEntries": ["x", "x", "y"]},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["access"] == "write"
    assert body["mode"] == "simple"
    assert body["selectedEntries"] == ["x", "y"]


@pytest.mark.parametrize(
    "patch",
    [
        {"access": "advanced"},
        {"mode": "write"},
    ],
)
def test_patch_rejects_invalid_values(client, patch):
    sid = client.post("/api/projects/proj/ai/sessions").json()["sessionId"]
    r = client.patch(f"/api/projects/proj/ai/sessions/{sid}", json=patch)
    assert r.status_code == 400


def test_patch_access_blocked_while_pending(client):
    sid = client.post("/api/projects/proj/ai/sessions").json()["sessionId"]
    session = sessions.load("proj", sid)
    session["agentState"] = {"pending": {"name": "delete_entry", "args": {}}, "deferred": []}
    sessions.save("proj", session)
    r = client.patch(f"/api/projects/proj/ai/sessions/{sid}", json={"mode": "simple"})
    assert r.status_code == 409
    assert sessions.load("proj", sid)["mode"] == "advanced"


def test_chat_rejects_invalid_controls_before_calling_model(client):
    for payload in ({"message": "hi", "access": "bogus"}, {"message": "hi", "mode": "bogus"}):
        r = client.post("/api/projects/proj/ai/chat", json=payload)
        assert r.status_code == 400
