"""Full-text project search.

Pure stdlib, like the repetition check: the filesystem is the source of truth
and :func:`documents.iter_documents` resolves the scope. Matching runs against
the *cleaned prose* (the same cleanup the repetition check uses), so snippets
read like text and Markdown, image paths and HTML attributes don't create
noise.

Matching is literal, case-insensitive by default, with an optional whole-word
mode. Results are grouped per document; each hit carries up to
:data:`_CONTEXT` characters of context on either side and a per-document
occurrence ordinal, so the UI can open a document and select the exact hit.
Output is capped to keep a pathological project bounded; the true totals are
still reported in ``totalMatches`` and flagged by ``truncated``.
"""
from __future__ import annotations

import re
from typing import Any

from app import config
from app.services import documents as documents_service
from app.services import repetition as repetition_service

_MAX_QUERY = 200
_MAX_MATCHES_PER_DOC = 50
_MAX_TOTAL_MATCHES = 500
_CONTEXT = 40
_ELLIPSIS = "\u2026"

# Whole-word boundaries that also work for scripts without ASCII word breaks
# (``\b`` does not treat CJK as word characters consistently).
_WORD_BEFORE = r"(?<![A-Za-z0-9_])"
_WORD_AFTER = r"(?![A-Za-z0-9_])"


def _build_pattern(query: str, case_sensitive: bool, whole_word: bool) -> re.Pattern[str]:
    pattern = re.escape(query)
    if whole_word:
        pattern = _WORD_BEFORE + pattern + _WORD_AFTER
    flags = 0 if case_sensitive else re.IGNORECASE
    return re.compile(pattern, flags)


def _collapse(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


def _snippet(text: str, start: int, end: int) -> dict[str, Any]:
    left = max(0, start - _CONTEXT)
    right = min(len(text), end + _CONTEXT)
    before = text[left:start]
    after = text[end:right]
    if left > 0:
        before = _ELLIPSIS + before
    if right < len(text):
        after = after + _ELLIPSIS
    return {"before": before, "match": text[start:end], "after": after}


def _in_scope(scope: str, doc_id: str) -> bool:
    wiki_prefix = config.WIKI_DIRNAME + "/"
    if scope == "write":
        return not doc_id.startswith(wiki_prefix)
    if scope == "wiki":
        return doc_id.startswith(wiki_prefix)
    return True


def search(
    project_id: str,
    query: str,
    *,
    scope: str = "all",
    folders: list[str] | None = None,
    documents: list[str] | None = None,
    case_sensitive: bool = False,
    whole_word: bool = False,
    max_per_doc: int = _MAX_MATCHES_PER_DOC,
    max_total: int = _MAX_TOTAL_MATCHES,
) -> dict[str, Any]:
    """Search the selected documents.

    ``scope`` is ``"all"`` (default), ``"write"``, ``"wiki"`` or ``"document"``;
    the last relies on ``documents``/``folders`` already naming the target.
    """
    needle = (query or "").strip()
    if not needle:
        raise ValueError("Enter something to search for")
    if len(needle) > _MAX_QUERY:
        raise ValueError(f"Search text is too long (max {_MAX_QUERY} characters)")

    pattern = _build_pattern(needle, case_sensitive, whole_word)
    docs = documents_service.iter_documents(project_id, folders=folders, documents=documents)
    if scope in ("write", "wiki"):
        docs = [doc for doc in docs if _in_scope(scope, doc["id"])]

    per_doc = max(1, min(int(max_per_doc), _MAX_MATCHES_PER_DOC))
    per_total = max(1, min(int(max_total), _MAX_TOTAL_MATCHES))

    results: list[dict[str, Any]] = []
    total = 0
    collected = 0
    matched_docs = 0

    for doc in docs:
        text = _collapse(repetition_service._clean_markdown(doc["body"]))
        if not text:
            continue
        hits: list[dict[str, Any]] = []
        count = 0
        for match in pattern.finditer(text):
            if len(hits) < per_doc and collected < per_total:
                snippet = _snippet(text, match.start(), match.end())
                snippet["occurrence"] = count
                hits.append(snippet)
                collected += 1
            count += 1
        if count == 0:
            continue
        matched_docs += 1
        total += count
        results.append(
            {
                "docId": doc["id"],
                "title": doc["title"],
                "folder": doc["folder"],
                "kind": doc["kind"],
                "count": count,
                "matches": hits,
            }
        )

    results.sort(key=lambda group: group["title"].lower())
    return {
        "query": needle,
        "scope": scope,
        "caseSensitive": case_sensitive,
        "wholeWord": whole_word,
        "documentsSearched": len(docs),
        "documentsMatched": matched_docs,
        "totalMatches": total,
        "truncated": total > collected,
        "results": results,
    }
