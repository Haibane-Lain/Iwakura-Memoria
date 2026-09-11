"""Project-wide find & replace.

The search service matches *cleaned prose*, so its offsets cannot be mapped
back to a document's Markdown. Replacement therefore runs on the stored file
directly -- but only inside prose. Fenced and inline code, HTML tags, image
syntax, link destinations, and whole wikilinks are protected, so a sweep can
never corrupt an ``assets/…`` path, the character-table markup, or a
``[[link]]``. Each changed document is snapshotted first (reason ``replace``),
so a bulk replace is reversible from **History**.

Literal matching, case-insensitive by default, with the same optional
whole-word boundaries as search. There is no preserve-case or regex mode.
"""
from __future__ import annotations

import re

from app import config
from app.services import documents as documents_service
from app.services import search as search_service
from app.services import snapshots as snapshots_service

# A runaway sweep (replacing a single letter, say) is refused rather than
# half-applied: the whole job is planned before anything is written.
_MAX_REPLACEMENTS = 5000

# The regions a replace must not touch, mirroring the cleanup search runs.
_PROTECTED_PATTERNS = (
    re.compile(r"```.*?```", re.DOTALL),  # fenced code
    re.compile(r"`[^`\n]*`"),  # inline code
    re.compile(r"<[^>]+>"),  # HTML tags / character-table markup
    re.compile(r"!\[[^\]]*\]\([^)]*\)"),  # a whole image
    re.compile(r"\[\[[^\]\n]*\]\]"),  # a whole wikilink (its target is live)
)
_LINK_RE = re.compile(r"\[([^\]]*)\]\([^)]*\)")


def _protected_spans(body: str) -> list[tuple[int, int]]:
    """Sorted ``[start, end)`` spans that a replacement must skip."""
    spans: list[tuple[int, int]] = []
    for pattern in _PROTECTED_PATTERNS:
        spans.extend((m.start(), m.end()) for m in pattern.finditer(body))
    # For a link, the label is prose but the destination is not: protect just
    # the ``](url)`` tail, leaving the label replaceable.
    for match in _LINK_RE.finditer(body):
        label_len = len(match.group(1) or "")
        spans.append((match.start() + 1 + label_len, match.end()))
    spans.sort()
    return spans


def _overlaps(spans: list[tuple[int, int]], start: int, end: int) -> bool:
    for span_start, span_end in spans:
        if span_start >= end:
            break
        if span_end > start:
            return True
    return False


def _replace_in_body(body: str, pattern: re.Pattern[str], replacement: str) -> tuple[str, int]:
    """Replace every unprotected match. Returns ``(body, count)``."""
    spans = _protected_spans(body)
    pieces: list[str] = []
    last = 0
    count = 0
    for match in pattern.finditer(body):
        start, end = match.start(), match.end()
        if end <= start or _overlaps(spans, start, end):
            continue
        pieces.append(body[last:start])
        pieces.append(replacement)
        last = end
        count += 1
    if count == 0:
        return body, 0
    pieces.append(body[last:])
    return "".join(pieces), count


def replace_in_documents(
    project_id: str,
    query: str,
    replacement: str,
    *,
    scope: str = "all",
    folders: list[str] | None = None,
    documents: list[str] | None = None,
    case_sensitive: bool = False,
    whole_word: bool = False,
    max_replacements: int = _MAX_REPLACEMENTS,
) -> dict:
    """Replace ``query`` with ``replacement`` across the selected documents.

    ``scope`` is ``"all"`` (default), ``"write"``, ``"wiki"`` or
    ``"document"``. Every document is planned first; nothing is written until
    the whole job is known to be under ``max_replacements``.
    """
    needle = (query or "").strip()
    if not needle:
        raise ValueError("Enter something to search for")
    if len(needle) > search_service._MAX_QUERY:
        raise ValueError(
            f"Search text is too long (max {search_service._MAX_QUERY} characters)"
        )

    pattern = search_service._build_pattern(needle, case_sensitive, whole_word)
    docs = documents_service.iter_documents(project_id, folders=folders, documents=documents)
    if scope in ("write", "wiki"):
        docs = [doc for doc in docs if search_service._in_scope(scope, doc["id"])]

    planned: list[tuple[dict, str, int]] = []
    total = 0
    for doc in docs:
        new_body, count = _replace_in_body(doc["body"], pattern, replacement)
        if count:
            planned.append((doc, new_body, count))
            total += count

    if total > max_replacements:
        raise ValueError(
            f"That would replace {total} occurrences; narrow the search first "
            f"(limit {max_replacements})"
        )

    mode = config.load_settings().get("wordCountMode", "auto")
    results: list[dict] = []
    for doc, new_body, count in planned:
        documents_service.save_document(
            project_id,
            doc["id"],
            new_body,
            mode,
            snapshot=False,
            before_reason=snapshots_service.REASON_REPLACE,
        )
        results.append(
            {
                "docId": doc["id"],
                "title": doc["title"],
                "folder": doc["folder"],
                "count": count,
            }
        )

    return {
        "query": needle,
        "replacement": replacement,
        "scope": scope,
        "caseSensitive": case_sensitive,
        "wholeWord": whole_word,
        "documentsChanged": len(results),
        "totalReplacements": total,
        "results": results,
    }
