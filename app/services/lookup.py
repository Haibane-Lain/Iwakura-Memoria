"""Offline word lookup: definitions and synonyms from WordNet 3.0.

WordNet is not a conventional dictionary. A *synset* is a set of synonymous
words that share one meaning, carrying a gloss (the definition, often with
example sentences) and typed pointers to related synsets. The thesaurus falls
out of that shape: the words in a synset are its synonyms, and the antonym
pointer (``!``) reaches the opposite sense.

The data is located the way LanguageTool is: ``IWAKURA_DICT_DIR`` points at a
WordNet folder (a packaged build passes ``extraResources``), and in development
it falls back to a ``WordNet 3.0`` folder beside the code. Nothing is vendored
in git, so the folder can be absent — the service then reports "not installed"
and the API answers 503, exactly as grammar does when its server is missing.

This module deliberately imports only the standard library and ``app.config``
so it stays a leaf.
"""
from __future__ import annotations

import os
import re
import threading
from pathlib import Path
from typing import Any, NamedTuple

from app import config

SOURCE = "wordnet"
FALLBACK_DIRNAME = "WordNet 3.0"

# WordNet part-of-speech codes: n(oun), v(erb), a(djective), r(adverb). The
# data files also carry ``s`` for adjective satellites, which map onto ``a``.
_POS_FILES = {
    "noun": ("data.noun", "index.noun"),
    "verb": ("data.verb", "index.verb"),
    "adj": ("data.adj", "index.adj"),
    "adv": ("data.adv", "index.adv"),
}
_POS_ORDER = ("noun", "verb", "adj", "adv")
_POS_LABEL = {"noun": "noun", "verb": "verb", "adj": "adjective", "adv": "adverb"}
_CODE_TO_POS = {"n": "noun", "v": "verb", "a": "adj", "s": "adj", "r": "adv"}

_MAX_WORD = 80


class DictionaryUnavailable(RuntimeError):
    """WordNet data is not installed (or is incomplete)."""


class _Synset(NamedTuple):
    lemmas: tuple[str, ...]
    definition: str
    examples: tuple[str, ...]
    # (target pos file, target synset offset, target word index within it)
    antonyms: tuple[tuple[str, int, int], ...]


class _Dataset(NamedTuple):
    # (pos file, synset offset) -> synset
    synsets: dict[tuple[str, int], _Synset]
    # (lemma, pos file) -> synset offsets
    index: dict[tuple[str, str], list[int]]
    # pos file -> {inflected form: lemma}
    exceptions: dict[str, dict[str, str]]


_lock = threading.Lock()
_cache: _Dataset | None = None
_cache_dir: Path | None = None


# --- locating the data ------------------------------------------------------


def _resolve_dict_dir(root: Path) -> Path | None:
    """Accept either the WordNet root or its ``dict/`` subfolder."""
    if (root / "data.noun").is_file():
        return root
    if (root / "dict" / "data.noun").is_file():
        return root / "dict"
    return None


def _dict_dir() -> Path | None:
    env = os.environ.get("IWAKURA_DICT_DIR")
    if env:
        found = _resolve_dict_dir(Path(env))
        if found:
            return found
    return _resolve_dict_dir(config.PROJECT_ROOT / FALLBACK_DIRNAME)


def is_available() -> bool:
    return _dict_dir() is not None


# --- parsing ----------------------------------------------------------------


def _unescape(token: str) -> str:
    # WordNet escapes spaces as ``_`` and parentheses as ``\(`` / ``\)``.
    return token.replace("\\(", "(").replace("\\)", ")").replace("_", " ")


def _split_gloss(gloss: str) -> tuple[str, tuple[str, ...]]:
    """Split a synset gloss into its definition and any quoted examples."""
    if not gloss:
        return "", ()
    parts = re.split(r';\s*"', gloss.strip())
    definition = parts[0].strip()
    examples = []
    for part in parts[1:]:
        example = part[:-1].strip() if part.endswith('"') else part.strip()
        if example:
            examples.append(example)
    return definition, tuple(examples)


def _parse_data(path: Path, pos_file: str) -> dict[tuple[str, int], _Synset]:
    synsets: dict[tuple[str, int], _Synset] = {}
    with path.open(encoding="utf-8", errors="replace") as handle:
        for line in handle:
            if not line.strip() or line[0].isspace():
                continue  # the license header is indented
            head, _, gloss = line.partition("|")
            tokens = head.split()
            try:
                offset = int(tokens[0])
                word_count = int(tokens[3], 16)
            except (IndexError, ValueError):
                continue
            cursor = 4
            lemmas = []
            for _ in range(word_count):
                if cursor >= len(tokens):
                    break
                lemmas.append(_unescape(tokens[cursor]))
                cursor += 2  # skip the lex_id
            antonyms: list[tuple[str, int, int]] = []
            if cursor < len(tokens):
                try:
                    pointer_count = int(tokens[cursor])
                except ValueError:
                    pointer_count = 0
                cursor += 1
                for _ in range(pointer_count):
                    if cursor + 3 >= len(tokens):
                        break
                    symbol = tokens[cursor]
                    target_offset = int(tokens[cursor + 1])
                    target_pos = _CODE_TO_POS.get(tokens[cursor + 2], pos_file)
                    source_target = tokens[cursor + 3]
                    cursor += 4
                    # A ``!`` with a non-zero source/target pair is an antonym
                    # between two *word senses*; ``0000`` is a synset pointer.
                    if symbol != "!" or source_target == "0000" or len(source_target) < 4:
                        continue
                    try:
                        target_index = int(source_target[2:4], 16) - 1
                    except ValueError:
                        continue
                    antonyms.append((target_pos, target_offset, target_index))
            definition, examples = _split_gloss(gloss)
            synsets[(pos_file, offset)] = _Synset(
                tuple(lemmas), definition, examples, tuple(antonyms)
            )
    return synsets


def _parse_index(path: Path, pos_file: str) -> dict[tuple[str, str], list[int]]:
    index: dict[tuple[str, str], list[int]] = {}
    with path.open(encoding="utf-8", errors="replace") as handle:
        for line in handle:
            if not line.strip() or line[0].isspace():
                continue
            tokens = line.split()
            if len(tokens) < 6:
                continue
            lemma = _unescape(tokens[0])
            try:
                pointer_count = int(tokens[3])
                cursor = 4 + pointer_count + 2  # skip symbols + sense/tag counts
                offsets = [int(t) for t in tokens[cursor:]]
            except ValueError:
                continue
            if offsets:
                index[(lemma, pos_file)] = offsets
    return index


def _parse_exc(path: Path) -> dict[str, str]:
    exceptions: dict[str, str] = {}
    if not path.is_file():
        return exceptions
    with path.open(encoding="utf-8", errors="replace") as handle:
        for line in handle:
            if not line.strip() or line[0].isspace():
                continue
            tokens = line.split()
            if len(tokens) >= 2:
                exceptions[_unescape(tokens[0])] = _unescape(tokens[1])
    return exceptions


def _build(root: Path) -> _Dataset:
    synsets: dict[tuple[str, int], _Synset] = {}
    index: dict[tuple[str, str], list[int]] = {}
    for pos_file, (data_name, index_name) in _POS_FILES.items():
        data_path = root / data_name
        index_path = root / index_name
        if data_path.is_file():
            synsets.update(_parse_data(data_path, pos_file))
        if index_path.is_file():
            index.update(_parse_index(index_path, pos_file))
    exceptions = {pf: _parse_exc(root / f"{pf}.exc") for pf in _POS_FILES}
    return _Dataset(synsets, index, exceptions)


def _load() -> _Dataset | None:
    global _cache, _cache_dir
    root = _dict_dir()
    if root is None:
        return None
    with _lock:
        if _cache is None or _cache_dir != root:
            _cache = _build(root)
            _cache_dir = root
        return _cache


# --- lookup -----------------------------------------------------------------


def _suffix_candidates(word: str) -> list[str]:
    """Cheap English deflections for words the exception lists don't carry."""
    out: list[str] = []
    if word.endswith("ies") and len(word) > 4:
        out.append(word[:-3] + "y")
    if word.endswith("es") and len(word) > 3:
        out.append(word[:-2])
    if word.endswith("s") and len(word) > 2:
        out.append(word[:-1])
    if word.endswith("ing") and len(word) > 4:
        base = word[:-3]
        out.append(base)
        out.append(base + "e")
        if len(base) > 2 and base[-1] == base[-2]:
            out.append(base[:-1])
    if word.endswith("ed") and len(word) > 3:
        out.append(word[:-2])
        out.append(word[:-1])
    if word.endswith("est") and len(word) > 4:
        out.append(word[:-3])
        out.append(word[:-2])
    if word.endswith("er") and len(word) > 3:
        out.append(word[:-2])
        out.append(word[:-1])
    return out


def _candidates(data: _Dataset, word: str) -> list[str]:
    seen: set[str] = set()
    ordered: list[str] = []

    def add(candidate: str) -> None:
        if candidate and candidate not in seen:
            seen.add(candidate)
            ordered.append(candidate)

    add(word)
    for pos_file in _POS_ORDER:
        base = data.exceptions[pos_file].get(word)
        if base:
            add(base)
    for candidate in _suffix_candidates(word):
        add(candidate)
    return ordered


def _dedupe(values: list[str]) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for value in values:
        key = value.lower()
        if key in seen:
            continue
        seen.add(key)
        out.append(value)
    return out


def _senses(data: _Dataset, lemma: str) -> dict[str, list[dict[str, Any]]]:
    grouped: dict[str, list[dict[str, Any]]] = {}
    for pos_file in _POS_ORDER:
        offsets = data.index.get((lemma, pos_file))
        if not offsets:
            continue
        senses: list[dict[str, Any]] = []
        for offset in offsets:
            synset = data.synsets.get((pos_file, offset))
            if synset is None:
                continue
            synonyms = [w for w in synset.lemmas if w.lower() != lemma.lower()]
            antonyms: list[str] = []
            for target_pos, target_offset, target_index in synset.antonyms:
                target = data.synsets.get((target_pos, target_offset))
                if target is None:
                    continue
                if 0 <= target_index < len(target.lemmas):
                    antonyms.append(target.lemmas[target_index])
                else:
                    antonyms.extend(target.lemmas)
            senses.append({
                "definition": synset.definition,
                "examples": list(synset.examples),
                "synonyms": _dedupe(synonyms),
                "antonyms": _dedupe(antonyms),
            })
        if senses:
            grouped[pos_file] = senses
    return grouped


def lookup(word: str) -> dict[str, Any]:
    """Definitions and synonyms for *word*.

    Raises :class:`DictionaryUnavailable` when the data is not installed. A
    well-formed word that simply has no entry comes back with ``found: false``
    rather than an error.
    """
    data = _load()
    if data is None:
        raise DictionaryUnavailable(
            "WordNet data not installed — see the README's Lookup section"
        )
    raw = str(word or "").strip()
    if not raw:
        raise ValueError("A word is required")
    if len(raw) > _MAX_WORD:
        raise ValueError("That is too long to look up")
    headword = raw.lower()
    grouped: dict[str, list[dict[str, Any]]] = {}
    for candidate in _candidates(data, headword):
        grouped = _senses(data, candidate)
        if grouped:
            headword = candidate
            break
    entries = [
        {"pos": _POS_LABEL[pos_file], "senses": grouped[pos_file]}
        for pos_file in _POS_ORDER
        if pos_file in grouped
    ]
    return {
        "word": raw,
        "headword": headword,
        "found": bool(entries),
        "source": SOURCE,
        "entries": entries,
    }
