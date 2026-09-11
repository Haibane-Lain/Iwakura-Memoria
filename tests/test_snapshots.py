"""Per-document snapshots: capture, dedup/throttle, retention, restore, routes.

Service-level coverage runs against a throwaway project; the route test pins
the request/response wiring and restore's safety capture.
"""
from __future__ import annotations

import zipfile

from fastapi.testclient import TestClient

from app.main import create_app
from app.services import backup as backup_service
from app.services import documents as documents_service
from app.services import projects as projects_service
from app.services import snapshots as snapshots_service


def _capture(project_id="proj", doc_id="doc", raw="hello", **kwargs):
    kwargs.setdefault("min_interval_s", 0)
    return snapshots_service.capture(project_id, doc_id, raw, **kwargs)


# --- capture / read ---------------------------------------------------------


def test_capture_stores_content_and_meta(data_dir, make_project):
    make_project("proj")
    meta = snapshots_service.capture(
        "proj",
        "01-scene",
        "# Scene\n\nbody\n",
        reason=snapshots_service.REASON_MANUAL,
        manual=True,
        title="Scene",
        kind="chapter",
        words=2,
        min_interval_s=0,
    )
    assert meta["docId"] == "01-scene"
    assert meta["manual"] is True

    listed = snapshots_service.list_snapshots("proj", "01-scene")
    assert [s["id"] for s in listed] == [meta["id"]]
    assert "content" not in listed[0]  # listings carry metadata only

    snap = snapshots_service.read_snapshot("proj", "01-scene", meta["id"])
    assert snap["content"] == "# Scene\n\nbody\n"
    assert snap["meta"]["title"] == "Scene"


def test_capture_dedupes_identical_content(data_dir, make_project):
    make_project("proj")
    assert _capture(raw="same") is not None
    assert _capture(raw="same") is None
    assert len(snapshots_service.list_snapshots("proj", "doc")) == 1


def test_auto_capture_is_throttled(data_dir, make_project):
    make_project("proj")
    first = snapshots_service.capture("proj", "doc", "one", reason="auto")
    assert first is not None
    # A different body seconds later is inside the interval, so it is skipped.
    assert snapshots_service.capture("proj", "doc", "two", reason="auto") is None
    # Manual capture ignores the throttle.
    assert (
        snapshots_service.capture("proj", "doc", "two", reason="manual", manual=True)
        is not None
    )


def test_read_unknown_snapshot_raises(data_dir, make_project):
    make_project("proj")
    try:
        snapshots_service.read_snapshot("proj", "doc", "deadbeef")
    except FileNotFoundError:
        pass
    else:
        raise AssertionError("expected FileNotFoundError")


def test_retention_prunes_old_automatic_but_keeps_manual(data_dir, make_project, monkeypatch):
    monkeypatch.setattr(snapshots_service, "_KEEP_PER_DOC", 2)
    make_project("proj")
    ids = [_capture(raw=f"v{i}")["id"] for i in range(3)]
    remaining = [s["id"] for s in snapshots_service.list_snapshots("proj", "doc")]
    assert len(remaining) == 2
    assert ids[-1] in remaining and ids[-2] in remaining
    assert ids[0] not in remaining

    manual = snapshots_service.capture(
        "proj", "doc", "pinned", reason="manual", manual=True, min_interval_s=0
    )
    for i in range(3, 8):
        _capture(raw=f"v{i}")
    remaining = [s["id"] for s in snapshots_service.list_snapshots("proj", "doc")]
    assert manual["id"] in remaining  # manual snapshots are pinned


def test_list_order_is_newest_first(data_dir, make_project, monkeypatch):
    make_project("proj")
    clock = iter(
        ["2026-01-01T00:00:00", "2026-01-01T00:01:00", "2026-01-01T00:02:00"]
    )
    monkeypatch.setattr(snapshots_service, "_now", lambda: next(clock))
    a = _capture(raw="a")
    b = _capture(raw="b")
    c = _capture(raw="c")
    assert [s["id"] for s in snapshots_service.list_snapshots("proj", "doc")] == [
        c["id"],
        b["id"],
        a["id"],
    ]


def test_delete_and_clear(data_dir, make_project):
    make_project("proj")
    a = _capture(raw="a")
    b = _capture(raw="b")
    assert snapshots_service.delete_snapshot("proj", "doc", a["id"]) is True
    assert snapshots_service.delete_snapshot("proj", "doc", a["id"]) is False
    assert [s["id"] for s in snapshots_service.list_snapshots("proj", "doc")] == [b["id"]]
    assert snapshots_service.clear_doc("proj", "doc") == 1
    assert snapshots_service.list_snapshots("proj", "doc") == []


# --- rekey / move -----------------------------------------------------------


def test_rekey_map_moves_snapshots(data_dir, make_project):
    make_project("proj")
    snap = _capture(doc_id="Part/one", raw="text", reason="manual", manual=True)
    assert snapshots_service.list_snapshots("proj", "Part/one")
    moved = snapshots_service.rekey_map("proj", {"Part/one": "Part/01-one"})
    assert moved == 1
    assert snapshots_service.list_snapshots("proj", "Part/one") == []
    listed = snapshots_service.list_snapshots("proj", "Part/01-one")
    assert [s["id"] for s in listed] == [snap["id"]]
    assert listed[0]["docId"] == "Part/01-one"
    assert (
        snapshots_service.read_snapshot("proj", "Part/01-one", snap["id"])["content"]
        == "text"
    )


def test_moving_a_document_moves_its_snapshots(data_dir, make_project):
    make_project("proj")
    folder = documents_service.create_folder("proj", "Archive")
    doc = documents_service.create_document("proj", "Alpha", content="x")
    snap = snapshots_service.capture(
        "proj", doc["id"], "x", reason="manual", manual=True, min_interval_s=0
    )

    moved = documents_service.move_document("proj", doc["id"], folder)
    new_id = moved["id"]
    assert new_id != doc["id"]
    assert snapshots_service.list_snapshots("proj", doc["id"]) == []
    assert [s["id"] for s in snapshots_service.list_snapshots("proj", new_id)] == [
        snap["id"]
    ]


# --- best-effort / lifecycle ------------------------------------------------


def test_snapshot_failure_does_not_fail_save(data_dir, make_project, monkeypatch):
    make_project("proj")
    doc = documents_service.create_document("proj", "Alpha", content="one")

    def boom(*_args, **_kwargs):
        raise OSError("disk full")

    monkeypatch.setattr(snapshots_service, "capture", boom)
    saved = documents_service.save_document("proj", doc["id"], "two")
    assert saved["content"] == "two"


def test_before_reason_captures_pre_change_state(data_dir, make_project):
    make_project("proj")
    doc = documents_service.create_document("proj", "Alpha", content="original")
    saved = documents_service.save_document(
        "proj",
        doc["id"],
        "replacement",
        snapshot=False,
        before_reason=snapshots_service.REASON_BEFORE_RESTORE,
    )
    assert saved["content"] == "replacement"
    listed = snapshots_service.list_snapshots("proj", doc["id"])
    assert [s["reason"] for s in listed] == [snapshots_service.REASON_BEFORE_RESTORE]
    snap = snapshots_service.read_snapshot("proj", doc["id"], listed[0]["id"])
    assert "original" in snap["content"]
    assert "replacement" not in snap["content"]


def test_ai_rewrite_is_captured_under_its_own_reason(data_dir, make_project):
    make_project("proj")
    doc = documents_service.create_document("proj", "Alpha", content="before lain")
    documents_service.save_document(
        "proj",
        doc["id"],
        "after lain",
        snapshot=False,
        before_reason=snapshots_service.REASON_AI,
    )
    listed = snapshots_service.list_snapshots("proj", doc["id"])
    assert [s["reason"] for s in listed] == [snapshots_service.REASON_AI]


def test_delete_project_clears_snapshots(data_dir, make_project):
    make_project("proj")
    _capture()
    assert (data_dir / ".snapshots" / "proj").is_dir()
    projects_service.delete_project("proj")
    assert not (data_dir / ".snapshots" / "proj").exists()


def test_backup_skips_snapshots(data_dir, make_project):
    make_project("proj")
    snapshots_service.capture("proj", "doc", "a version", min_interval_s=0)
    result = backup_service.create_backup()
    with zipfile.ZipFile(result["path"]) as zf:
        names = zf.namelist()
    assert not any(".snapshots" in name for name in names)


# --- routes -----------------------------------------------------------------


def _project_client(tmp_path, monkeypatch):
    monkeypatch.setenv("IWAKURA_DATA_DIR", str(tmp_path / "data"))
    client = TestClient(create_app())
    return client, {"host": "127.0.0.1"}


def test_snapshot_routes(tmp_path, monkeypatch):
    client, headers = _project_client(tmp_path, monkeypatch)

    assert (
        client.get("/api/projects/nope/snapshots?docId=x", headers=headers).status_code
        == 404
    )

    client.post("/api/projects", json={"name": "Demo"}, headers=headers)
    created = client.post(
        "/api/projects/demo/documents",
        json={"title": "Scene", "kind": "chapter", "content": "first"},
        headers=headers,
    )
    doc_id = created.json()["id"]

    # A save captures an automatic snapshot.
    client.put(
        f"/api/projects/demo/documents/{doc_id}",
        json={"content": "second"},
        headers=headers,
    )
    listed = client.get(f"/api/projects/demo/snapshots?docId={doc_id}", headers=headers)
    assert listed.status_code == 200
    items = listed.json()
    assert len(items) >= 1
    snap_id = items[0]["id"]

    # A manual snapshot can be made without changing the document.
    made = client.post(
        "/api/projects/demo/snapshots", json={"docId": doc_id}, headers=headers
    )
    assert made.status_code == 201
    assert made.json()["ok"] is True

    detail = client.get(
        f"/api/projects/demo/snapshots/{snap_id}?docId={doc_id}", headers=headers
    )
    assert detail.status_code == 200
    assert detail.json()["body"] == "second"

    # Move past the snapshot so restoring it is a real change.
    client.put(
        f"/api/projects/demo/documents/{doc_id}",
        json={"content": "third"},
        headers=headers,
    )
    restored = client.post(
        f"/api/projects/demo/snapshots/{snap_id}/restore",
        json={"docId": doc_id},
        headers=headers,
    )
    assert restored.status_code == 200
    assert restored.json()["doc"]["content"] == "second"

    # The pre-restore state was captured, so the restore is reversible.
    after = client.get(
        f"/api/projects/demo/snapshots?docId={doc_id}", headers=headers
    ).json()
    assert "before-restore" in [s["reason"] for s in after]

    assert (
        client.delete(
            f"/api/projects/demo/snapshots/{snap_id}?docId={doc_id}", headers=headers
        ).status_code
        == 200
    )
    assert (
        client.delete(
            f"/api/projects/demo/snapshots/deadbeef?docId={doc_id}", headers=headers
        ).status_code
        == 404
    )
    assert (
        client.delete(f"/api/projects/demo/snapshots?docId={doc_id}", headers=headers).status_code
        == 200
    )
    assert (
        client.get(f"/api/projects/demo/snapshots?docId={doc_id}", headers=headers).json()
        == []
    )
