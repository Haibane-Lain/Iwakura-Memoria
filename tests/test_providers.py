"""Message-shape normalization for strict local chat templates.

LM Studio / llama.cpp render the model's own Jinja chat template, and the
Qwen-family templates raise ``System message must be at the beginning`` for any
system message that is not first. Every request therefore has to carry a single
leading system message; these tests pin that contract for the base client, both
for the plain and the streaming path (the critique pass streams).
"""
from __future__ import annotations

from app.ai import providers


def _patch_chat(monkeypatch):
    """Replace ``httpx.Client`` with a stub that captures the posted body."""
    captured: dict[str, object] = {}

    class _FakeResponse:
        status_code = 200
        text = ""

        def json(self):
            return {
                "choices": [
                    {"message": {"role": "assistant", "content": "ok"}, "finish_reason": "stop"}
                ]
            }

    class _FakeClient:
        def __init__(self, *args, **kwargs):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def post(self, url, headers=None, json=None):
            captured["body"] = json
            return _FakeResponse()

    monkeypatch.setattr(providers.httpx, "Client", _FakeClient)
    return captured


def _patch_stream(monkeypatch):
    """Replace ``httpx.Client`` with a stub that captures the streamed body."""
    captured: dict[str, object] = {}

    class _FakeStream:
        status_code = 200
        text = ""

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def iter_lines(self):
            yield 'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}'
            yield "data: [DONE]"

    class _FakeClient:
        def __init__(self, *args, **kwargs):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def stream(self, method, url, headers=None, json=None):
            captured["body"] = json
            return _FakeStream()

    monkeypatch.setattr(providers.httpx, "Client", _FakeClient)
    return captured


# --- the guard itself -------------------------------------------------------


def test_coalesce_merges_leading_system_messages():
    out = providers._coalesce_system_messages(
        [
            {"role": "system", "content": "prompt"},
            {"role": "system", "content": "context"},
            {"role": "user", "content": "hi"},
        ]
    )
    assert [m["role"] for m in out] == ["system", "user"]
    assert out[0]["content"] == "prompt\n\ncontext"
    assert out[1]["content"] == "hi"


def test_coalesce_is_a_no_op_for_a_single_system_message():
    """The OpenAI-compatible happy path must be untouched (same object)."""
    messages = [
        {"role": "system", "content": "prompt"},
        {"role": "user", "content": "hi"},
    ]
    assert providers._coalesce_system_messages(messages) is messages


def test_coalesce_hoists_a_later_system_message():
    """A system message that is not first would fail the template wherever it
    sits, so it is folded into the leading one instead of left in place."""
    out = providers._coalesce_system_messages(
        [
            {"role": "system", "content": "prompt"},
            {"role": "user", "content": "hi"},
            {"role": "system", "content": "reminder"},
        ]
    )
    assert [m["role"] for m in out] == ["system", "user"]
    assert out[0]["content"] == "prompt\n\nreminder"


def test_coalesce_drops_empty_system_messages():
    out = providers._coalesce_system_messages(
        [
            {"role": "system", "content": ""},
            {"role": "system", "content": None},
            {"role": "user", "content": "hi"},
        ]
    )
    assert [m["role"] for m in out] == ["user"]


# --- wiring into the client -------------------------------------------------


def test_chat_sends_one_leading_system_message(monkeypatch):
    captured = _patch_chat(monkeypatch)
    client = providers.LMStudioClient(api_key="k", model="qwen3")
    client.chat(
        [
            {"role": "system", "content": "prompt"},
            {"role": "system", "content": "context"},
            {"role": "user", "content": "hi"},
        ]
    )
    sent = captured["body"]["messages"]
    assert [m["role"] for m in sent] == ["system", "user"]
    assert sent[0]["content"] == "prompt\n\ncontext"


def test_stream_chat_sends_one_leading_system_message(monkeypatch):
    """The critique pass streams, so the streaming path needs the guard too."""
    captured = _patch_stream(monkeypatch)
    client = providers.LMStudioClient(api_key="k", model="qwen3")
    events = list(
        client.stream_chat(
            [
                {"role": "system", "content": "prompt"},
                {"role": "system", "content": "context"},
                {"role": "user", "content": "hi"},
            ]
        )
    )
    sent = captured["body"]["messages"]
    assert [m["role"] for m in sent] == ["system", "user"]
    assert sent[0]["content"] == "prompt\n\ncontext"
    assert events[-1]["type"] == "message"
    assert events[-1]["message"]["content"] == "ok"
