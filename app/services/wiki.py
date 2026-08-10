"""Wiki: parse [[wikilinks]] across a project and compute backlinks.

Wikilinks are resolved against document ids (path form) and, failing that,
document titles (case-insensitive). Missing targets are reported as broken
links so the frontend can offer to create them.
"""
from __future__ import annotations

import re
from typing import Any

from app.services import documents as documents_service

_WIKILINK_RE = re.compile(r"\[\[([^\]|]+)(?:\|[^\]]*)?\]\]")


def _all_docs(project_id: str) -> list[dict[str, Any]]:
    def walk(node: dict[str, Any], parent: str = "") -> list[dict[str, Any]]:
        docs: list[dict[str, Any]] = []
        for doc in node.get("documents", []):
            entry = dict(doc)
            entry["category"] = parent
            docs.append(entry)
        for folder in node.get("folders", []):
            folder_id = folder["id"]
            docs.extend(walk(folder, folder["name"]))
        return docs

    tree = documents_service.get_tree(project_id, scope="all")
    return walk(tree)


def _normalize(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip().lower()


def resolve_wikilink(project_id: str, target: str) -> str | None:
    """Resolve a wikilink target to a document id, or None if missing."""
    docs = _all_docs(project_id)
    target = target.strip()
    for doc in docs:
        if doc["id"] == target:
            return doc["id"]
    target_norm = _normalize(target)
    matches = [d for d in docs if _normalize(d["title"]) == target_norm]
    if not matches:
        matches = [d for d in docs if _normalize(d["id"]) == target_norm]
    return matches[0]["id"] if matches else None


def get_wiki(project_id: str) -> dict[str, Any]:
    docs = _all_docs(project_id)
    by_id = {d["id"]: d for d in docs}
    _title_norm = {_normalize(d["title"]): d["id"] for d in docs if d["title"]}
    _id_norm = {_normalize(d["id"]): d["id"] for d in docs}

    def _resolve(target: str) -> str | None:
        target = target.strip()
        if target in by_id:
            return target
        norm = _normalize(target)
        return _title_norm.get(norm) or _id_norm.get(norm)

    links: list[dict[str, str]] = []
    broken: dict[str, list[str]] = {}
    backlinks: dict[str, list[str]] = {d["id"]: [] for d in docs}
    link_counts: dict[str, int] = {}
    seen_links: set[tuple[str, str]] = set()

    for doc in docs:
        body = documents_service.get_document(project_id, doc["id"])["content"]
        targets = _WIKILINK_RE.findall(body)
        for raw_target in targets:
            target = raw_target.strip()
            resolved = _resolve(target)
            pair = (doc["id"], resolved)
            if resolved and resolved in by_id and pair not in seen_links:
                seen_links.add(pair)
                links.append({"from": doc["id"], "to": resolved})
                backlinks[resolved].append(doc["id"])
                link_counts[resolved] = link_counts.get(resolved, 0) + 1
            elif not resolved:
                broken.setdefault(doc["id"], [])
                if target not in broken[doc["id"]]:
                    broken[doc["id"]].append(target)

    return {
        "notes": [
            {
                "id": d["id"],
                "title": d["title"],
                "kind": d["kind"],
                "category": d.get("category"),
            }
            for d in docs
        ],
        "links": links,
        "backlinks": backlinks,
        "broken": broken,
        "linkCounts": link_counts,
    }
