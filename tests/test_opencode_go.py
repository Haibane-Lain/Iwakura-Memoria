"""OpenCode Go requires identity headers on every request.

Go's gateway answers ``400 MissingSessionID`` unless each conversation sends a
stable ``x-opencode-session`` and a non-generic ``User-Agent``. These tests pin
that behaviour for every dialect the client speaks (chat/completions,
responses, messages) and for the connection-test path.
"""
from __future__ import annotations

from app.ai import providers


def _patch_client(monkeypatch, payload):
    """Replace ``httpx.Client`` with a stub that captures request headers."""
    captured: dict[str, object] = {}

    class _FakeResponse:
        status_code = 200
        text = ""

        def json(self):
            return payload

    class _FakeClient:
        def __init__(self, *args, **kwargs):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def post(self, url, headers=None, json=None):
            captured["url"] = url
            captured["headers"] = headers
            return _FakeResponse()

    monkeypatch.setattr(providers.httpx, "Client", _FakeClient)
    return captured


def test_request_headers_include_session_and_user_agent():
    client = providers.OpenCodeGoClient(api_key="k", session_id="abc123")
    headers = client.request_headers()
    assert headers["x-opencode-session"] == "abc123"
    assert headers["User-Agent"] == providers.USER_AGENT
    assert headers["Authorization"] == "Bearer k"


def test_anthropic_headers_include_session_and_user_agent():
    client = providers.OpenCodeGoClient(api_key="k", session_id="abc123")
    headers = client._headers(bearer=False)
    assert headers["x-opencode-session"] == "abc123"
    assert headers["User-Agent"] == providers.USER_AGENT
    assert headers["x-api-key"] == "k"


def test_no_session_header_without_session_id():
    client = providers.OpenCodeGoClient(api_key="k")
    assert "x-opencode-session" not in client.request_headers()


def test_chat_route_sends_session_header(monkeypatch):
    captured = _patch_client(
        monkeypatch,
        {"choices": [{"message": {"role": "assistant", "content": "ok"}, "finish_reason": "stop"}]},
    )
    client = providers.OpenCodeGoClient(
        api_key="k", model="deepseek-v4-flash", session_id="sess-1"
    )
    client.chat([{"role": "user", "content": "hi"}])
    assert captured["url"].endswith("/chat/completions")
    assert captured["headers"]["x-opencode-session"] == "sess-1"
    assert captured["headers"]["User-Agent"] == providers.USER_AGENT


def test_responses_route_sends_session_header(monkeypatch):
    captured = _patch_client(monkeypatch, {"output": [], "status": "completed"})
    client = providers.OpenCodeGoClient(api_key="k", model="grok-4.6", session_id="sess-2")
    client.chat([{"role": "user", "content": "hi"}])
    assert captured["url"].endswith("/responses")
    assert captured["headers"]["x-opencode-session"] == "sess-2"


def test_messages_route_sends_session_header(monkeypatch):
    captured = _patch_client(
        monkeypatch, {"content": [], "usage": {}, "stop_reason": "end_turn"}
    )
    client = providers.OpenCodeGoClient(api_key="k", model="minimax-m3", session_id="sess-3")
    client.chat([{"role": "user", "content": "hi"}])
    assert captured["url"].endswith("/messages")
    assert captured["headers"]["x-opencode-session"] == "sess-3"
    assert captured["headers"]["User-Agent"] == providers.USER_AGENT


def test_get_client_forwards_session_id():
    settings = {
        "ai": {
            "provider": "opencode_go",
            "opencode_go": {"apiKey": "k", "model": "deepseek-v4-flash"},
        }
    }
    client = providers.get_client(settings, session_id="sess-xyz")
    assert client.session_id == "sess-xyz"


def test_other_providers_do_not_send_session_header():
    """Only OpenCode Go consumes the session id; other clients stay unchanged."""
    settings = {
        "ai": {
            "provider": "deepseek",
            "deepseek": {"apiKey": "k", "model": "deepseek-v4-flash"},
        }
    }
    client = providers.get_client(settings, session_id="sess-xyz")
    assert "x-opencode-session" not in client.request_headers()
