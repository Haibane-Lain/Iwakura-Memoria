"""AI provider abstraction.

Providers are OpenAI-compatible chat-completions services. Config for each
provider lives in ``settings.json`` under ``ai.<name>`` with ``apiKey``,
``model`` and optional ``baseUrl``. The active provider is chosen by the
``ai.provider`` key; if unset, the first provider with a configured API key
is used. Nothing calls the network from this module at import time.
"""
from __future__ import annotations

import json
from typing import Any

import httpx

MAX_OUTPUT_TOKENS = 65536
TIMEOUT_SECONDS = 300.0


class AIError(Exception):
    """Raised when a provider request fails (bad key, timeout, HTTP error)."""


class AIClient:
    """Base OpenAI-compatible chat client."""

    name = "base"
    default_base_url = ""
    default_model = ""
    default_max_iterations = 20
    # Whether the endpoint supports ``stream_options.include_usage`` so
    # streaming responses report token usage. Left off by default because
    # some local servers (LM Studio, llama.cpp) reject unknown fields.
    supports_stream_usage = False

    def __init__(
        self,
        api_key: str,
        model: str = "",
        base_url: str = "",
        max_iterations: int | None = None,
    ) -> None:
        self.api_key = api_key
        self.model = model or self.default_model
        self.base_url = (base_url or self.default_base_url).rstrip("/")
        self.max_iterations = (
            max_iterations
            if max_iterations is not None
            else self.default_max_iterations
        )

    def chat(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]] | None = None,
        temperature: float = 0.3,
        max_tokens: int | None = None,
    ) -> dict[str, Any]:
        """One chat-completions round trip.

        Returns the raw ``message`` object (``content`` may be None when the
        model requested tool calls; ``tool_calls`` may be absent). A ceiling
        on output tokens is sent so long generations aren't cut at the
        provider default.
        """
        body: dict[str, Any] = {
            "model": self.model,
            "messages": messages,
            "temperature": temperature,
            "stream": False,
            "max_tokens": max_tokens if max_tokens is not None else MAX_OUTPUT_TOKENS,
        }
        if tools:
            body["tools"] = tools
            body["tool_choice"] = "auto"
        label = self.label()
        try:
            with httpx.Client(timeout=TIMEOUT_SECONDS) as client:
                resp = client.post(
                    f"{self.base_url}/chat/completions",
                    headers={
                        "Authorization": f"Bearer {self.api_key}",
                        "Content-Type": "application/json",
                    },
                    json=body,
                )
        except httpx.HTTPError as exc:
            raise AIError(f"{label} request failed: {exc}") from exc
        if resp.status_code == 401:
            raise AIError(f"Invalid {label} API key")
        if resp.status_code == 429:
            raise AIError(f"{label} rate limit exceeded — try again shortly")
        if resp.status_code >= 400:
            raise AIError(f"{label} API error {resp.status_code}: {resp.text[:300]}")
        try:
            data = resp.json()
        except ValueError as exc:
            raise AIError(f"{label} returned an unparseable response") from exc
        try:
            message = data["choices"][0]["message"]
        except (KeyError, IndexError, TypeError) as exc:
            raise AIError(f"{label} returned an unexpected response shape") from exc
        usage = data.get("usage")
        if usage:
            usage["cache_hit"] = usage.get("prompt_cache_hit_tokens", 0)
            usage["cache_miss"] = usage.get("prompt_cache_miss_tokens", 0)
        message["usage"] = usage
        message["finish_reason"] = data["choices"][0].get("finish_reason")
        return message

    def stream_chat(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]] | None = None,
        temperature: float = 0.3,
        max_tokens: int | None = None,
    ) -> Any:
        """Stream one chat-completions round trip over SSE.

        Yields ``{"type": "delta", "text": str}`` for each content token and
        finally ``{"type": "message", "message": dict}`` with the assembled
        message in the same shape :meth:`chat` returns (``content``,
        ``tool_calls``, ``usage``, ``finish_reason``). Raises :class:`AIError`
        on transport, HTTP, or stream errors.
        """
        body: dict[str, Any] = {
            "model": self.model,
            "messages": messages,
            "temperature": temperature,
            "stream": True,
            "max_tokens": max_tokens if max_tokens is not None else MAX_OUTPUT_TOKENS,
        }
        if tools:
            body["tools"] = tools
            body["tool_choice"] = "auto"
        if self.supports_stream_usage:
            body["stream_options"] = {"include_usage": True}
        label = self.label()
        state: dict[str, Any] = {
            "content": [],
            "tool_calls": {},
            "usage": None,
            "finish_reason": None,
        }
        try:
            with httpx.Client(timeout=TIMEOUT_SECONDS) as client:
                with client.stream(
                    "POST",
                    f"{self.base_url}/chat/completions",
                    headers={
                        "Authorization": f"Bearer {self.api_key}",
                        "Content-Type": "application/json",
                    },
                    json=body,
                ) as resp:
                    if resp.status_code == 401:
                        raise AIError(f"Invalid {label} API key")
                    if resp.status_code == 429:
                        raise AIError(f"{label} rate limit exceeded — try again shortly")
                    if resp.status_code >= 400:
                        raise AIError(f"{label} API error {resp.status_code}: {resp.text[:300]}")
                    for line in resp.iter_lines():
                        if not line or not line.startswith("data:"):
                            continue
                        payload = line[5:].strip()
                        if not payload or payload == "[DONE]":
                            break
                        try:
                            chunk = json.loads(payload)
                        except json.JSONDecodeError:
                            continue
                        if isinstance(chunk, dict) and chunk.get("error"):
                            raise AIError(f"{label} stream error: {chunk['error']}")
                        for delta in _apply_stream_chunk(chunk, state):
                            yield {"type": "delta", "text": delta}
        except httpx.HTTPError as exc:
            raise AIError(f"{label} request failed: {exc}") from exc
        yield {"type": "message", "message": _assemble_message(state)}

    def label(self) -> str:
        return self.name.title()


def _apply_stream_chunk(chunk: dict[str, Any], state: dict[str, Any]) -> list[str]:
    """Merge one SSE ``data`` chunk into ``state``; return content deltas.

    ``state`` accumulates ``content`` (list of str), ``tool_calls`` (dict
    keyed by call index -> ``{id, name, arguments}``), ``usage`` and
    ``finish_reason``. Tool-call fields arrive split across chunks and are
    concatenated by index. Malformed chunks are ignored.
    """
    if not isinstance(chunk, dict):
        return []
    if chunk.get("usage"):
        state["usage"] = chunk["usage"]
    choices = chunk.get("choices")
    if not isinstance(choices, list) or not choices:
        return []
    choice = choices[0]
    if not isinstance(choice, dict):
        return []
    if choice.get("finish_reason"):
        state["finish_reason"] = choice["finish_reason"]
    delta = choice.get("delta")
    if not isinstance(delta, dict):
        return []
    deltas: list[str] = []
    content = delta.get("content")
    if content:
        state["content"].append(content)
        deltas.append(content)
    for tc in delta.get("tool_calls") or []:
        if not isinstance(tc, dict):
            continue
        idx = tc.get("index", 0)
        entry = state["tool_calls"].setdefault(idx, {"id": "", "name": "", "arguments": ""})
        if tc.get("id"):
            entry["id"] = tc["id"]
        fn = tc.get("function")
        if not isinstance(fn, dict):
            continue
        if fn.get("name"):
            entry["name"] = fn["name"]
        if fn.get("arguments"):
            entry["arguments"] += fn["arguments"]
    return deltas


def _assemble_message(state: dict[str, Any]) -> dict[str, Any]:
    """Build the final message dict from accumulated stream state, matching
    the shape :meth:`AIClient.chat` returns."""
    content = "".join(state["content"]) or None
    message: dict[str, Any] = {"role": "assistant", "content": content}
    tool_calls: list[dict[str, Any]] = []
    for idx in sorted(state["tool_calls"]):
        entry = state["tool_calls"][idx]
        if not entry["name"]:
            continue
        tool_calls.append(
            {
                "id": entry["id"] or f"call_{idx}",
                "type": "function",
                "function": {"name": entry["name"], "arguments": entry["arguments"]},
            }
        )
    if tool_calls:
        message["tool_calls"] = tool_calls
    usage = state.get("usage")
    if usage:
        usage["cache_hit"] = usage.get("prompt_cache_hit_tokens", 0)
        usage["cache_miss"] = usage.get("prompt_cache_miss_tokens", 0)
        message["usage"] = usage
    message["finish_reason"] = state.get("finish_reason")
    return message


class DeepSeekClient(AIClient):
    name = "deepseek"
    default_base_url = "https://api.deepseek.com"
    default_model = "deepseek-v4-flash"
    default_max_iterations = 20
    supports_stream_usage = True


class LMStudioClient(AIClient):
    name = "lmstudio"
    default_base_url = "http://localhost:1234/v1"
    default_model = ""
    default_max_iterations = 50

    def label(self) -> str:
        return "LM Studio"


class OpenAICompatibleClient(AIClient):
    name = "openai_compatible"
    default_base_url = ""
    default_model = ""
    default_max_iterations = 50

    def label(self) -> str:
        return "OpenAI Compatible"


PROVIDERS: dict[str, type[AIClient]] = {
    DeepSeekClient.name: DeepSeekClient,
    LMStudioClient.name: LMStudioClient,
    OpenAICompatibleClient.name: OpenAICompatibleClient,
}

PROVIDER_LABELS: dict[str, str] = {
    "deepseek": "DeepSeek",
    "lmstudio": "LM Studio",
    "openai_compatible": "OpenAI Compatible",
}


def configured_providers(settings: dict[str, Any]) -> list[str]:
    """Return names of providers that have an API key configured."""
    ai_cfg = settings.get("ai") or {}
    return [name for name, _cls in PROVIDERS.items() if ai_cfg.get(name, {}).get("apiKey")]


def get_active_provider(settings: dict[str, Any]) -> str | None:
    """Return the name of the provider that should be used for requests.

    If ``ai.provider`` is set to a configured provider, use it. Otherwise
    fall back to the first configured provider. Returns ``None`` when no
    provider has an API key.
    """
    ai_cfg = settings.get("ai") or {}
    configured = configured_providers(settings)
    if not configured:
        return None
    explicit = ai_cfg.get("provider", "")
    if explicit in configured:
        return explicit
    return configured[0]


def get_client(settings: dict[str, Any]) -> AIClient:
    """Return a configured client for the active provider.

    Raises ``AIError`` when no provider has an API key configured.
    """
    provider = get_active_provider(settings)
    if not provider:
        raise AIError(
            "No AI provider configured — add an API key in Settings"
        )
    cls = PROVIDERS[provider]
    cfg = (settings.get("ai") or {}).get(provider) or {}
    max_iter = cfg.get("maxIterations")
    return cls(
        api_key=cfg["apiKey"],
        model=str(cfg.get("model") or ""),
        base_url=str(cfg.get("baseUrl") or ""),
        max_iterations=int(max_iter) if max_iter is not None else None,
    )
