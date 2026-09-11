"""Tests for the repetition check service and route.

The analyser is pure-Python, so most coverage is service-level on a throwaway
project; the route test only pins the request/response wiring and 404.
"""
from __future__ import annotations

from fastapi.testclient import TestClient

from app.main import create_app
from app.services import documents as documents_service
from app.services import repetition as repetition_service

SENTENCE = "He walked into the silent room and looked around carefully."


def _doc(root, rel, body, title=None, doc_type="note"):
    path = root / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    meta = f"---\ntitle: {title}\ntype: {doc_type}\n---\n" if title else ""
    path.write_text(meta + body, encoding="utf-8")
    return path


def _words(result):
    return {item["word"]: item for item in result["overused"]}


def _echoes(result):
    return {item["word"]: item for item in result["echoes"]}


def _phrases(result):
    return {item["phrase"].lower(): item for item in result["phrases"]}


# --- words ------------------------------------------------------------------


def test_overused_words_count_and_threshold(data_dir, make_project):
    make_project("proj")
    root = data_dir / "proj"
    _doc(root, "01.md", "The wolf ran. The wolf slept. The wolf howled. The wolf ate. A horse stood.")

    result = repetition_service.analyze("proj")
    words = _words(result)
    assert words["wolf"]["count"] == 4
    assert words["wolf"]["per10k"] > 0
    assert "horse" not in words  # used once, below the default threshold of 4


def test_stopwords_and_min_length_are_configurable(data_dir, make_project):
    make_project("proj")
    _doc(data_dir / "proj" / "01.md", "", "that that that that that")

    default = repetition_service.analyze("proj", word_min_length=1)
    assert "that" not in _words(default)  # "that" is a stopword

    raw = repetition_service.analyze("proj", word_min_length=1, ignore_stopwords=False)
    assert _words(raw)["that"]["count"] == 5


def test_nearby_echoes_respect_the_window(data_dir, make_project):
    make_project("proj")
    _doc(
        data_dir / "proj" / "01.md",
        "",
        "She sighed and then later he sighed again after many more words passed quietly.",
    )

    wide = repetition_service.analyze("proj", proximity_window=50)
    assert "sighed" in _echoes(wide)
    assert _echoes(wide)["sighed"]["minGap"] < 20

    narrow = repetition_service.analyze("proj", proximity_window=2)
    assert "sighed" not in _echoes(narrow)


def test_proper_nouns_can_be_ignored(data_dir, make_project):
    make_project("proj")
    _doc(data_dir / "proj" / "01.md", "", "Kael spoke. Then Kael left. Later Kael returned. Finally Kael slept.")

    filtered = repetition_service.analyze("proj", ignore_proper_nouns=True)
    assert "kael" not in _words(filtered)

    kept = repetition_service.analyze("proj", ignore_proper_nouns=False)
    assert _words(kept)["kael"]["count"] == 4


def test_dictionary_words_can_be_ignored(data_dir, make_project):
    make_project("proj")
    _doc(data_dir / "proj" / "01.md", "", "Vortex Vortex Vortex Vortex Vortex")

    ignored = repetition_service.analyze("proj", dictionary=["Vortex"], ignore_proper_nouns=False)
    assert "vortex" not in _words(ignored)

    kept = repetition_service.analyze(
        "proj", dictionary=["Vortex"], ignore_dictionary=False, ignore_proper_nouns=False
    )
    assert _words(kept)["vortex"]["count"] == 5


# --- sentences --------------------------------------------------------------


def test_exact_sentence_duplicates_across_documents(data_dir, make_project):
    make_project("proj")
    root = data_dir / "proj"
    _doc(root, "01.md", SENTENCE)
    _doc(root, "02.md", SENTENCE)

    result = repetition_service.analyze("proj")
    assert len(result["sentences"]) == 1
    group = result["sentences"][0]
    assert group["count"] == 2
    assert {occ["docId"] for occ in group["occurrences"]} == {"01", "02"}


def test_sentence_min_words_filters_short_lines(data_dir, make_project):
    make_project("proj")
    _doc(data_dir / "proj" / "01.md", "", "Hello there. Hello there.")

    assert repetition_service.analyze("proj", sentence_min_words=6)["sentences"] == []
    assert repetition_service.analyze("proj", sentence_min_words=2)["sentences"][0]["count"] == 2


def test_sentence_splitter_handles_abbreviations_and_decimals(data_dir, make_project):
    sentences = repetition_service._split_sentences(
        "Mr. Smith arrived at 3.14 pm. He left. Dr. Jones stayed."
    )
    assert sentences == ["Mr. Smith arrived at 3.14 pm.", "He left.", "Dr. Jones stayed."]


def test_cjk_sentences_are_split_and_deduplicated(data_dir, make_project):
    make_project("proj")
    _doc(data_dir / "proj" / "01.md", "", "\u4ed6\u662f\u82f1\u96c4\u3002\u4ed6\u662f\u82f1\u96c4\u3002")

    result = repetition_service.analyze("proj", sentence_min_words=4)
    assert len(result["sentences"]) == 1
    assert result["sentences"][0]["count"] == 2


# --- phrases ----------------------------------------------------------------


def test_repeated_phrases_are_counted(data_dir, make_project):
    make_project("proj")
    _doc(
        data_dir / "proj" / "01.md",
        "",
        "She walked to the old house. He walked to the old house. They walked to the old house.",
    )

    phrases = _phrases(repetition_service.analyze("proj"))
    assert phrases["walked to the old house"]["count"] == 3


def test_phrases_do_not_cross_sentence_boundaries(data_dir, make_project):
    make_project("proj")
    _doc(
        data_dir / "proj" / "01.md",
        "",
        "Alpha beta gamma. Delta epsilon zeta. Alpha beta gamma. Delta epsilon zeta.",
    )

    phrases = _phrases(repetition_service.analyze("proj", phrase_min_count=2))
    assert "gamma delta" not in phrases  # would only repeat if phrases spanned sentences
    assert phrases["alpha beta gamma"]["count"] == 2


def test_stopword_only_phrases_are_ignored(data_dir, make_project):
    make_project("proj")
    _doc(data_dir / "proj" / "01.md", "", "of the and a. the old house. the old house.")

    phrases = _phrases(repetition_service.analyze("proj", phrase_min_count=2))
    assert "of the and a" not in phrases
    assert phrases["the old house"]["count"] == 2


def test_phrase_length_bounds_are_honored(data_dir, make_project):
    make_project("proj")
    _doc(data_dir / "proj" / "01.md", "", "one two three four five six seven " * 2)

    result = repetition_service.analyze(
        "proj", phrase_min_words=4, phrase_max_words=4, phrase_min_count=2
    )
    assert result["phrases"]
    for item in result["phrases"]:
        assert len(item["phrase"].split()) == 4


def test_only_the_longest_form_of_a_phrase_family_is_reported(data_dir, make_project):
    make_project("proj")
    _doc(data_dir / "proj" / "01.md", "", "at the end of the day " * 3)

    phrases = _phrases(repetition_service.analyze("proj"))
    assert phrases["at the end of the"]["count"] == 3
    assert "the end of the" not in phrases  # subsumed by the longer repeat
    assert "end of the" not in phrases


def test_phrase_scope_limits_the_scan(data_dir, make_project):
    make_project("proj")
    root = data_dir / "proj"
    _doc(root, "Act 1/01-a.md", "Opened the ancient door quietly.")
    _doc(root, "Act 2/01-b.md", "Opened the ancient door quietly.")

    everything = repetition_service.analyze("proj", phrase_min_count=2)
    assert "opened the ancient door quietly" in _phrases(everything)

    act_one = repetition_service.analyze("proj", folders=["Act 1"], phrase_min_count=2)
    assert act_one["documents"] == 1
    assert act_one["phrases"] == []  # a single copy inside the scope


# --- selection --------------------------------------------------------------


def test_iter_documents_selection(data_dir, make_project):
    make_project("proj")
    root = data_dir / "proj"
    _doc(root, "root.md", "x")
    _doc(root, "Act 1/01-a.md", "x")
    _doc(root, "Act 1/02-b.md", "x")
    _doc(root, "Act 2/01-c.md", "x")

    everything = {d["id"] for d in documents_service.iter_documents("proj")}
    assert everything == {"root", "Act 1/01-a", "Act 1/02-b", "Act 2/01-c"}

    act_one = documents_service.iter_documents("proj", folders=["Act 1"])
    assert {d["id"] for d in act_one} == {"Act 1/01-a", "Act 1/02-b"}

    root_only = documents_service.iter_documents("proj", folders=["."])
    assert {d["id"] for d in root_only} == {"root"}

    explicit = documents_service.iter_documents("proj", documents=["Act 2/01-c"])
    assert {d["id"] for d in explicit} == {"Act 2/01-c"}

    assert documents_service.iter_documents("proj", folders=[], documents=[]) == []


def test_analyze_scope_limits_the_scan(data_dir, make_project):
    make_project("proj")
    root = data_dir / "proj"
    repeated = "The raven circled the tower and the raven called again and the raven left."
    _doc(root, "Act 1/01-a.md", repeated)
    _doc(root, "Act 2/01-b.md", repeated)

    act_one = repetition_service.analyze("proj", folders=["Act 1"])
    assert act_one["documents"] == 1
    assert act_one["sentences"] == []  # only one copy inside the scope


# --- route ------------------------------------------------------------------


def test_repetition_route_and_404(tmp_path, monkeypatch):
    monkeypatch.setenv("IWAKURA_DATA_DIR", str(tmp_path / "data"))
    client = TestClient(create_app())
    headers = {"host": "127.0.0.1"}

    assert client.post("/api/projects/nope/repetition/check", json={}, headers=headers).status_code == 404

    created = client.post("/api/projects", json={"name": "Demo"}, headers=headers)
    assert created.status_code == 201
    body = "The wolf ran. The wolf slept. The wolf howled. The wolf ate. The wolf left."
    written = client.post(
        "/api/projects/demo/documents",
        json={"title": "Alpha", "kind": "chapter", "content": body},
        headers=headers,
    )
    assert written.status_code == 201

    result = client.post("/api/projects/demo/repetition/check", json={}, headers=headers)
    assert result.status_code == 200
    payload = result.json()
    assert payload["documents"] == 1
    assert any(item["word"] == "wolf" for item in payload["overused"])
    assert any(item["phrase"].lower() == "the wolf" for item in payload["phrases"])
