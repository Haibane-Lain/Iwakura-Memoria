"""An exported project must import back in the same order.

The ZIP export keeps the hidden ``NN-`` order prefixes and the importer orders
by every path segment, so folders and root-level documents stay interleaved
instead of collapsing into alphabetical order.
"""
from __future__ import annotations

import io
import zipfile

from app.services import documents as documents_service
from app.services import import_docs as import_service
from app.services import projects as projects_service


def _write_doc(project, relative: str, title: str, kind: str = "chapter") -> None:
    path = project / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        documents_service.build_frontmatter({"title": title, "type": kind})
        + f"{title} body.",
        encoding="utf-8",
    )


def _entry_shape(node: dict) -> list[tuple[str, str]]:
    """Every entry in display order as ``(title/name, kind)``."""
    shape: list[tuple[str, str]] = []
    for entry in node.get("entries") or []:
        if entry["kind"] == "folder":
            folder = next(f for f in node["folders"] if f["id"] == entry["id"])
            shape.append((folder["name"], "folder"))
            shape.extend(_entry_shape(folder))
        else:
            doc = next(d for d in node["documents"] if d["id"] == entry["id"])
            shape.append((doc["title"], doc["kind"]))
    return shape


def test_import_keeps_root_documents_between_folders(make_project):
    make_project("p1")
    files = [
        ("01-Act One/01-scene-one.md", b"one"),
        ("01-Act One/02-scene-two.md", b"two"),
        ("02-interlude.md", b"three"),
        ("03-Act Two/01-scene-three.md", b"four"),
    ]

    root, _ = import_service.build_outline(files, {"name": "Novel"})

    assert [node["kind"] for node in root["children"]] == ["folder", "doc", "folder"]
    act_one, interlude, act_two = root["children"]
    assert act_one["title"] == "Act One"
    assert interlude["title"] == "Interlude"
    assert act_two["title"] == "Act Two"
    assert [node["title"] for node in act_one["children"]] == ["Scene One", "Scene Two"]
    assert [node["title"] for node in act_two["children"]] == ["Scene Three"]


def test_export_import_preserves_the_whole_layout(make_project):
    source = make_project("p1")
    _write_doc(source, "01-Act One/01-Chapter One.md", "Chapter One")
    _write_doc(source, "01-Act One/02-Chapter Two.md", "Chapter Two")
    _write_doc(source, "02-Interlude.md", "Interlude")
    _write_doc(source, "03-Act Two/01-Chapter Three.md", "Chapter Three")
    _write_doc(source, "03-Act Two/02-Notes.md", "Notes", "note")
    _write_doc(source, "03-Act Two/03-Extras/01-Bonus.md", "Bonus")

    data = projects_service.export_zip("p1")
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        names = set(archive.namelist())
    assert "01-Act One/01-Chapter One.md" in names
    assert "02-Interlude.md" in names
    assert "03-Act Two/03-Extras/01-Bonus.md" in names

    make_project("p2")
    summary = import_service.import_bundle(
        "p2", None, [("novel.zip", data)], {"name": "Novel"}
    )

    target = documents_service.get_tree("p2")
    wrapper = next(folder for folder in target["folders"] if folder["id"] == summary["folder"])
    source_shape = _entry_shape(documents_service.get_tree("p1"))
    assert _entry_shape(wrapper) == source_shape
    assert source_shape == [
        ("Act One", "folder"),
        ("Chapter One", "chapter"),
        ("Chapter Two", "chapter"),
        ("Interlude", "chapter"),
        ("Act Two", "folder"),
        ("Chapter Three", "chapter"),
        ("Notes", "note"),
        ("Extras", "folder"),
        ("Bonus", "chapter"),
    ]
