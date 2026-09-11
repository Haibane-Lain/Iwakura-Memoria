"""Lookup service and route: WordNet parsing, morphology, and the API.

The tests build a tiny fake WordNet folder so they never need the real ~10 MB
dataset, and they pin the two things most likely to break: the pointer/gloss
parsing and the graceful "not installed" path.
"""
from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app import config
from app.main import create_app
from app.services import lookup as lookup_service


@pytest.fixture(autouse=True)
def _clean_lookup_cache():
    lookup_service._cache = None
    lookup_service._cache_dir = None
    yield
    lookup_service._cache = None
    lookup_service._cache_dir = None


def _write_wordnet(root: Path) -> Path:
    root.mkdir(parents=True, exist_ok=True)
    (root / "data.noun").write_text(
        "\n".join([
            "  This indented line stands in for the license header.",
            "",
            "00001740 03 n 01 entity 0 000 | that which is perceived or known",
            "00001930 03 n 01 physical_entity 0 001 @ 00001740 n 0000 | an entity that has physical existence",
            '00002000 03 n 02 dog 0 canine 0 001 @ 00001930 n 0000 | a domesticated carnivore; "the dog barked"',
        ]),
        encoding="utf-8",
    )
    (root / "index.noun").write_text(
        "\n".join([
            "  fake index header",
            "dog n 1 1 @ 1 0 00002000",
            "canine n 1 1 @ 1 0 00002000",
            "entity n 1 0 1 0 00001740",
            "physical_entity n 1 1 @ 1 0 00001930",
        ]),
        encoding="utf-8",
    )
    (root / "data.adj").write_text(
        "\n".join([
            '00001740 00 a 01 good 0 001 ! 00001800 a 0101 | morally admirable; "a good person"',
            "00001800 00 a 01 bad 0 001 ! 00001740 a 0101 | morally reprehensible",
        ]),
        encoding="utf-8",
    )
    (root / "index.adj").write_text(
        "\n".join([
            "good a 1 1 ! 1 1 00001740",
            "bad a 1 1 ! 1 1 00001800",
        ]),
        encoding="utf-8",
    )
    (root / "data.verb").write_text(
        "00002000 02 v 01 run 0 000 | move fast by using one's feet\n",
        encoding="utf-8",
    )
    (root / "index.verb").write_text("run v 1 0 1 0 00002000\n", encoding="utf-8")
    (root / "verb.exc").write_text("ran run\nrunning run\n", encoding="utf-8")
    return root


def _installed(tmp_path, monkeypatch) -> Path:
    root = _write_wordnet(tmp_path / "wordnet")
    monkeypatch.setenv("IWAKURA_DICT_DIR", str(root))
    return root


# --- service ----------------------------------------------------------------


def test_finds_definitions_synonyms_and_examples(tmp_path, monkeypatch):
    _installed(tmp_path, monkeypatch)

    result = lookup_service.lookup("dog")

    assert result["found"] is True
    assert result["source"] == "wordnet"
    assert result["headword"] == "dog"
    noun = next(entry for entry in result["entries"] if entry["pos"] == "noun")
    sense = noun["senses"][0]
    assert sense["definition"] == "a domesticated carnivore"
    assert sense["examples"] == ["the dog barked"]
    assert sense["synonyms"] == ["canine"]


def test_finds_antonyms_through_the_pointer(tmp_path, monkeypatch):
    _installed(tmp_path, monkeypatch)

    result = lookup_service.lookup("good")

    adjective = next(entry for entry in result["entries"] if entry["pos"] == "adjective")
    sense = adjective["senses"][0]
    assert sense["definition"] == "morally admirable"
    assert sense["examples"] == ["a good person"]
    assert sense["antonyms"] == ["bad"]


def test_resolves_inflections_via_exceptions_and_suffixes(tmp_path, monkeypatch):
    _installed(tmp_path, monkeypatch)

    assert lookup_service.lookup("running")["headword"] == "run"
    assert lookup_service.lookup("ran")["headword"] == "run"
    # No exception entry for "dogs", so the suffix rule has to reach "dog".
    assert lookup_service.lookup("dogs")["headword"] == "dog"


def test_unknown_word_is_a_result_not_an_error(tmp_path, monkeypatch):
    _installed(tmp_path, monkeypatch)

    result = lookup_service.lookup("zzzzz")

    assert result["found"] is False
    assert result["entries"] == []


def test_reports_unavailable_when_data_is_missing(tmp_path, monkeypatch):
    monkeypatch.delenv("IWAKURA_DICT_DIR", raising=False)
    monkeypatch.setattr(config, "PROJECT_ROOT", tmp_path / "nowhere")

    assert lookup_service.is_available() is False
    with pytest.raises(lookup_service.DictionaryUnavailable):
        lookup_service.lookup("dog")


def test_accepts_the_wordnet_root_or_its_dict_subfolder(tmp_path, monkeypatch):
    root = _write_wordnet(tmp_path / "wordnet")
    nested = root / "dict"
    nested.mkdir()
    for name in ("data.noun", "index.noun", "data.adj", "index.adj", "data.verb", "index.verb", "verb.exc"):
        (nested / name).write_text((root / name).read_text(encoding="utf-8"), encoding="utf-8")
    for path in root.glob("data.*"):
        path.unlink()
    for path in root.glob("index.*"):
        path.unlink()
    (root / "verb.exc").unlink()

    monkeypatch.setenv("IWAKURA_DICT_DIR", str(root))
    assert lookup_service.is_available() is True
    assert lookup_service.lookup("dog")["found"] is True


# --- route ------------------------------------------------------------------


def _client(tmp_path, monkeypatch, dict_root: Path | None):
    monkeypatch.setenv("IWAKURA_DATA_DIR", str(tmp_path / "data"))
    if dict_root is not None:
        monkeypatch.setenv("IWAKURA_DICT_DIR", str(dict_root))
    else:
        monkeypatch.delenv("IWAKURA_DICT_DIR", raising=False)
        monkeypatch.setattr(config, "PROJECT_ROOT", tmp_path / "nowhere")
    return TestClient(create_app()), {"host": "127.0.0.1"}


def test_lookup_route_returns_entries(tmp_path, monkeypatch):
    root = _write_wordnet(tmp_path / "wordnet")
    client, headers = _client(tmp_path, monkeypatch, root)

    assert client.get("/api/lookup/status", headers=headers).json() == {"available": True}

    found = client.get("/api/lookup?word=dog", headers=headers)
    assert found.status_code == 200
    assert found.json()["found"] is True
    assert found.json()["headword"] == "dog"

    inflected = client.get("/api/lookup?word=dogs", headers=headers)
    assert inflected.json()["headword"] == "dog"

    missing = client.get("/api/lookup?word=zzzzz", headers=headers)
    assert missing.status_code == 200
    assert missing.json()["found"] is False

    empty = client.get("/api/lookup?word=", headers=headers)
    assert empty.status_code == 400


def test_lookup_route_503_when_data_missing(tmp_path, monkeypatch):
    client, headers = _client(tmp_path, monkeypatch, None)

    assert client.get("/api/lookup/status", headers=headers).json() == {"available": False}
    response = client.get("/api/lookup?word=dog", headers=headers)
    assert response.status_code == 503
