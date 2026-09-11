"""Settings API persistence.

Regression: the toolbar's grammar toggle PUT ``grammarEnabled`` but the
``SettingsPatch`` request model had no such field, so pydantic silently dropped
it and the preference never survived a restart.
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.main import create_app

# The localhost guard rejects a foreign Host, and TestClient's default is one.
HOST = {"host": "127.0.0.1"}


@pytest.fixture
def client(tmp_path, monkeypatch):
    """A TestClient whose data dir is a throwaway folder, so exercising the
    app never touches real user data."""
    monkeypatch.setenv("IWAKURA_DATA_DIR", str(tmp_path / "data"))
    return TestClient(create_app())


def test_grammar_toggle_persists_across_reads(client):
    assert client.get("/api/settings", headers=HOST).json()["grammarEnabled"] is True

    written = client.put("/api/settings", json={"grammarEnabled": False}, headers=HOST)
    assert written.status_code == 200
    assert written.json()["grammarEnabled"] is False

    assert client.get("/api/settings", headers=HOST).json()["grammarEnabled"] is False
