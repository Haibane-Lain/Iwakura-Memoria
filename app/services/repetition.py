"""Repetition analysis: overused words, nearby echoes, repeated phrases and sentences.

Pure stdlib — this is a local writing aid, and the project deliberately carries
no NLP dependency for it. :func:`app.services.documents.iter_documents` resolves
the scope; this module only turns bodies into findings.

Word pass
    Tokens are lowercased and stripped of inline HTML/Markdown noise. A token
    is *content* when it is long enough, is not an English stopword, is not in
    the project dictionary and (optionally) is not a proper noun. *Overuse*
    counts content tokens across the whole scope; *echoes* are the same content
    token reappearing within ``proximity_window`` tokens of itself.

Phrase pass
    Within each sentence, word n-grams of ``phrase_min_words`` to
    ``phrase_max_words`` words are counted; stopword-only runs are dropped.
    A repeated family is reported once, as its longest form: a shorter phrase
    survives only when it repeats more often on its own than the longer phrase
    that contains it.

Sentence pass
    Sentences are split on ``.!?…`` (plus the CJK ``。！？``), tolerating common
    abbreviations and decimals. Only exact duplicates after normalizing case,
    whitespace and outer punctuation are reported, and only for sentences of at
    least ``sentence_min_words`` words.
"""
from __future__ import annotations

import re
from collections.abc import Iterable
from typing import Any

from app.services import documents as documents_service

# ---------------------------------------------------------------------------
# Markup cleanup + tokenizing
# ---------------------------------------------------------------------------

_FENCE_RE = re.compile(r"```.*?```", re.DOTALL)
_INLINE_CODE_RE = re.compile(r"`[^`\n]*`")
_HTML_TAG_RE = re.compile(r"<[^>]+>")
_MD_IMAGE_RE = re.compile(r"!\[[^\]]*\]\([^)]*\)")
_MD_LINK_RE = re.compile(r"\[([^\]]*)\]\([^)]*\)")
_WIKILINK_RE = re.compile(r"\[\[([^\]|]+)(?:\|([^\]]+))?\]\]")
_HEADING_RE = re.compile(r"^[ \t]{0,3}#{1,6}[ \t]*", re.MULTILINE)
_EMPHASIS_RE = re.compile(r"[*_~]+")

# A word starts with a letter and may continue with letters, apostrophes and
# hyphens, so "don't" and "well-known" stay one token.
_TOKEN_RE = re.compile(r"[A-Za-z][A-Za-z'\u2019-]*")

# Curly quotes/dashes normalized to their ASCII form before comparisons.
_QUOTES = str.maketrans({"\u2018": "'", "\u2019": "'", "\u201c": '"', "\u201d": '"'})

# Compact English stopword list. Kept inline (no data dependency): these are
# function words whose repetition a writer never cares about. The length filter
# drops the rest, so this only needs the frequent ones a threshold would miss.
STOPWORDS = frozenset(
    ["a", "about", "above", "after", "again", "against", "all", "also", "am", "an", "and", "any", "are", "aren't", "as", "at", "be", "because", "been", "before", "being", "below", "between", "both", "but", "by", "can", "cannot", "could", "couldn't", "did", "didn't", "do", "does", "doesn't", "doing", "don't", "down", "during", "each", "either", "else", "few", "for", "from", "further", "had", "hadn't", "has", "hasn't", "have", "haven't", "having", "he", "her", "here", "hers", "herself", "him", "himself", "his", "how", "however", "i", "if", "in", "into", "is", "isn't", "it", "its", "itself", "just", "me", "might", "more", "most", "must", "my", "myself", "nor", "not", "now", "of", "off", "on", "once", "only", "or", "other", "ought", "our", "ours", "ourselves", "out", "over", "own", "same", "shan't", "she", "should", "shouldn't", "so", "some", "such", "than", "that", "the", "their", "theirs", "them", "themselves", "then", "there", "these", "they", "this", "those", "through", "to", "too", "under", "until", "up", "very", "was", "wasn't", "we", "were", "weren't", "what", "when", "where", "which", "while", "who", "whom", "why", "will", "with", "won't", "would", "wouldn't", "you", "your", "yours", "yourself", "yourselves"]
)

_MAX_OVERUSED = 200
_MAX_ECHOES = 200
_MAX_PHRASES = 200
_MAX_SENTENCES = 200
_MAX_DOCS = 8
_MAX_OCCURRENCES = 20

# Distinct n-grams are far more numerous than words; on a very large scope cap
# them so a pathological project cannot balloon memory. Normal projects never
# approach this.
_MAX_PHRASE_KEYS = 250_000


def _clean_markdown(text: str) -> str:
    """Strip the markup the editor writes so only prose words remain."""
    text = _FENCE_RE.sub(" ", text)
    text = _INLINE_CODE_RE.sub(" ", text)
    text = _HTML_TAG_RE.sub(" ", text)
    text = _MD_IMAGE_RE.sub(" ", text)
    text = _WIKILINK_RE.sub(lambda m: m.group(2) or m.group(1), text)
    text = _MD_LINK_RE.sub(r"\1", text)
    text = _HEADING_RE.sub("", text)
    return _EMPHASIS_RE.sub("", text)


# ---------------------------------------------------------------------------
# Sentence splitting
# ---------------------------------------------------------------------------

_SENTENCE_END = ".!?\u2026\u3002\uff01\uff1f"
_CJK_END = "\u3002\uff01\uff1f"
_CLOSERS = "\"'\u201d\u2019)]}\u00bb"
_ABBREVIATIONS = frozenset(
    ["mr", "mrs", "ms", "dr", "prof", "sr", "jr", "st", "vs", "etc", "e.g", "i.e", "fig", "no", "vol", "inc", "ltd", "mt", "gen", "col", "sgt", "capt", "lt", "rev", "hon", "approx", "dept", "est", "min", "max", "al"]
)


def _is_abbreviation(text: str, dot: int) -> bool:
    """Whether the token ending at ``dot`` is an abbreviation (so no split)."""
    match = re.search(r"([A-Za-z][A-Za-z.]*)$", text[:dot])
    if not match:
        return False
    token = match.group(1)
    if len(token) == 1:  # initials: "J. K. Rowling"
        return True
    return token.lower().rstrip(".") in _ABBREVIATIONS


def _split_paragraph(text: str) -> list[str]:
    out: list[str] = []
    start = 0
    i = 0
    n = len(text)
    while i < n:
        ch = text[i]
        if ch not in _SENTENCE_END:
            i += 1
            continue
        j = i
        while j + 1 < n and text[j + 1] in _SENTENCE_END:
            j += 1
        k = j + 1
        while k < n and text[k] in _CLOSERS:
            k += 1
        boundary = True if ch in _CJK_END else (k >= n or text[k].isspace())
        if not boundary or (ch == "." and _is_abbreviation(text, i)):
            i = j + 1
            continue
        segment = text[start:k].strip()
        if segment:
            out.append(segment)
        start = k
        i = k
    tail = text[start:].strip()
    if tail:
        out.append(tail)
    return out


def _split_sentences(text: str) -> list[str]:
    """Split prose into sentences, one paragraph at a time."""
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    sentences: list[str] = []
    for paragraph in text.split("\n"):
        paragraph = paragraph.strip()
        if paragraph:
            sentences.extend(_split_paragraph(paragraph))
    return sentences


def _sentence_key(text: str) -> str:
    """Case/whitespace/outer-punctuation-normalized key for exact matches."""
    text = text.translate(_QUOTES)
    text = re.sub(r"\s+", " ", text).strip()
    text = text.strip("\"'()[]{}")
    return text.rstrip(".!?\u2026\u3002\uff01\uff1f").strip().lower()


def _sentence_word_count(text: str) -> int:
    return documents_service.count_words(text, "auto")


# ---------------------------------------------------------------------------
# Analysis
# ---------------------------------------------------------------------------


def _clamp(value: int, low: int, high: int) -> int:
    return max(low, min(high, value))


def _collect_phrases(
    sentence_tokens: list[tuple[str, str]],
    doc: dict[str, Any],
    phrase_stats: dict[tuple[str, ...], dict[str, Any]],
    min_words: int,
    max_words: int,
) -> None:
    """Count word n-grams for one sentence (never across a sentence boundary)."""
    total = len(sentence_tokens)
    for size in range(min_words, max_words + 1):
        if size > total:
            break
        for start in range(total - size + 1):
            gram = sentence_tokens[start : start + size]
            key = tuple(token[0] for token in gram)
            if all(token in STOPWORDS for token in key):
                continue
            stat = phrase_stats.get(key)
            if stat is None:
                if len(phrase_stats) >= _MAX_PHRASE_KEYS:
                    continue
                stat = phrase_stats[key] = {
                    "count": 0,
                    "display": " ".join(token[1] for token in gram),
                    "docs": set(),
                    "occurrences": [],
                }
            stat["count"] += 1
            stat["docs"].add(doc["title"])
            if len(stat["occurrences"]) < _MAX_OCCURRENCES and all(
                occ["docId"] != doc["id"] for occ in stat["occurrences"]
            ):
                stat["occurrences"].append({"docId": doc["id"], "title": doc["title"]})


def _maximal_phrases(
    phrase_stats: dict[tuple[str, ...], dict[str, Any]],
    min_count: int,
    min_words: int,
) -> list[tuple[str, ...]]:
    """Reduce each repeated family to its longest form.

    A phrase is dropped when a longer phrase containing it repeats at least as
    often; a shorter phrase that repeats more often on its own survives.
    """
    candidates = {key: stat for key, stat in phrase_stats.items() if stat["count"] >= min_count}
    covered: dict[tuple[str, ...], int] = {}
    kept: list[tuple[str, ...]] = []
    for key in sorted(candidates, key=lambda item: (-len(item), item)):
        count = candidates[key]["count"]
        if count <= covered.get(key, 0):
            continue
        kept.append(key)
        for size in range(min_words, len(key)):
            for start in range(len(key) - size + 1):
                sub = key[start : start + size]
                if count > covered.get(sub, 0):
                    covered[sub] = count
    return kept


def analyze(
    project_id: str,
    *,
    folders: list[str] | None = None,
    documents: list[str] | None = None,
    dictionary: Iterable[str] | None = None,
    word_min_count: int = 4,
    word_min_length: int = 4,
    proximity_window: int = 50,
    ignore_stopwords: bool = True,
    ignore_dictionary: bool = True,
    ignore_proper_nouns: bool = True,
    phrase_min_words: int = 2,
    phrase_max_words: int = 5,
    phrase_min_count: int = 3,
    sentence_min_words: int = 6,
) -> dict[str, Any]:
    """Run the repetition check over the selected documents.

    Returns ``overused`` (word counts at/above ``word_min_count``), ``echoes``
    (same word reappearing within ``proximity_window`` tokens), ``phrases``
    (repeated n-grams of ``phrase_min_words``–``phrase_max_words`` words, each
    family reduced to its longest form) and ``sentences`` (exact duplicates with
    at least ``sentence_min_words`` words).
    """
    docs = documents_service.iter_documents(project_id, folders=folders, documents=documents)
    dictionary_words = {w.strip().lower() for w in (dictionary or []) if w and w.strip()}
    min_length = _clamp(word_min_length, 1, 40)
    min_count = _clamp(word_min_count, 2, 1000)
    window = _clamp(proximity_window, 1, 1000)
    min_phrase_words = _clamp(phrase_min_words, 2, 10)
    max_phrase_words = _clamp(phrase_max_words, min_phrase_words, 12)
    min_phrase_count = _clamp(phrase_min_count, 2, 1000)
    min_sentence_words = _clamp(sentence_min_words, 1, 1000)

    total_words = 0
    word_stats: dict[str, dict[str, Any]] = {}
    echo_stats: dict[str, dict[str, Any]] = {}
    phrase_stats: dict[tuple[str, ...], dict[str, Any]] = {}
    sentence_groups: dict[str, dict[str, Any]] = {}

    for doc in docs:
        cleaned = _clean_markdown(doc["body"])
        total_words += documents_service.count_words(cleaned, "auto")
        sentences = _split_sentences(cleaned)

        for sentence in sentences:
            if _sentence_word_count(sentence) < min_sentence_words:
                continue
            key = _sentence_key(sentence)
            if not key:
                continue
            group = sentence_groups.get(key)
            if group is None:
                group = sentence_groups[key] = {"text": sentence, "occurrences": []}
            group["occurrences"].append(
                {"docId": doc["id"], "title": doc["title"], "text": sentence}
            )

        tokens: list[tuple[str, str, bool, bool]] = []
        for sentence in sentences:
            raw_tokens = _TOKEN_RE.findall(sentence)
            sentence_tokens: list[tuple[str, str]] = []
            for index, raw in enumerate(raw_tokens):
                norm = raw.translate(_QUOTES).lower().strip("'-")
                if not norm:
                    continue
                is_content = (
                    len(norm) >= min_length
                    and not (ignore_stopwords and norm in STOPWORDS)
                    and not (ignore_dictionary and norm in dictionary_words)
                )
                tokens.append((norm, raw, index == 0, is_content))
                sentence_tokens.append((norm, raw))
            _collect_phrases(sentence_tokens, doc, phrase_stats, min_phrase_words, max_phrase_words)

        last: dict[str, int] = {}
        for position, (norm, raw, is_initial, is_content) in enumerate(tokens):
            if not is_content:
                continue
            stat = word_stats.get(norm)
            if stat is None:
                stat = word_stats[norm] = {
                    "count": 0,
                    "capitalized": 0,
                    "initial": 0,
                    "docs": set(),
                    "proper": True,
                }
            stat["count"] += 1
            if raw[:1].isupper():
                stat["capitalized"] += 1
            else:
                stat["proper"] = False
            if is_initial:
                stat["initial"] += 1
            stat["docs"].add(doc["title"])

            # Echoes never cross a document boundary, so the map resets per doc.
            previous = last.get(norm)
            if previous is not None:
                gap = position - previous - 1
                if gap <= window:
                    echo = echo_stats.get(norm)
                    if echo is None:
                        echo_stats[norm] = {"minGap": gap, "count": 1, "docs": {doc["title"]}}
                    else:
                        echo["minGap"] = min(echo["minGap"], gap)
                        echo["count"] += 1
                        echo["docs"].add(doc["title"])
            last[norm] = position

    proper_words = {
        word
        for word, stat in word_stats.items()
        if stat["proper"] and stat["count"] > stat["initial"]
    }

    overused: list[dict[str, Any]] = []
    for word, stat in word_stats.items():
        if stat["count"] < min_count:
            continue
        if ignore_proper_nouns and word in proper_words:
            continue
        overused.append(
            {
                "word": word,
                "count": stat["count"],
                "per10k": round(stat["count"] / total_words * 10000, 1) if total_words else 0.0,
                "documents": sorted(stat["docs"])[:_MAX_DOCS],
                "proper": word in proper_words,
            }
        )
    overused.sort(key=lambda item: (-item["count"], item["word"]))
    truncated_overused = len(overused) > _MAX_OVERUSED
    overused = overused[:_MAX_OVERUSED]

    echoes: list[dict[str, Any]] = []
    for word, stat in echo_stats.items():
        if ignore_proper_nouns and word in proper_words:
            continue
        echoes.append(
            {
                "word": word,
                "count": stat["count"],
                "minGap": stat["minGap"],
                "documents": sorted(stat["docs"])[:_MAX_DOCS],
            }
        )
    echoes.sort(key=lambda item: (item["minGap"], item["word"]))
    truncated_echoes = len(echoes) > _MAX_ECHOES
    echoes = echoes[:_MAX_ECHOES]

    phrases: list[dict[str, Any]] = []
    for key in _maximal_phrases(phrase_stats, min_phrase_count, min_phrase_words):
        stat = phrase_stats[key]
        phrases.append(
            {
                "phrase": stat["display"],
                "count": stat["count"],
                "per10k": round(stat["count"] / total_words * 10000, 1) if total_words else 0.0,
                "documents": sorted(stat["docs"])[:_MAX_DOCS],
                "occurrences": stat["occurrences"][:_MAX_OCCURRENCES],
            }
        )
    phrases.sort(key=lambda item: (-item["count"], item["phrase"].lower()))
    truncated_phrases = len(phrases) > _MAX_PHRASES
    phrases = phrases[:_MAX_PHRASES]

    sentences: list[dict[str, Any]] = []
    for group in sentence_groups.values():
        if len(group["occurrences"]) < 2:
            continue
        sentences.append(
            {
                "text": group["text"],
                "count": len(group["occurrences"]),
                "occurrences": group["occurrences"][:_MAX_OCCURRENCES],
            }
        )
    sentences.sort(key=lambda item: (-item["count"], item["text"].lower()))
    truncated_sentences = len(sentences) > _MAX_SENTENCES
    sentences = sentences[:_MAX_SENTENCES]

    return {
        "documents": len(docs),
        "words": total_words,
        "overused": overused,
        "echoes": echoes,
        "phrases": phrases,
        "sentences": sentences,
        "truncated": {
            "overused": truncated_overused,
            "echoes": truncated_echoes,
            "phrases": truncated_phrases,
            "sentences": truncated_sentences,
        },
    }
