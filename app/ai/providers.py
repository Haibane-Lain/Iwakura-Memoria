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

    def _check_http(self, resp: httpx.Response, label: str) -> None:
        """Raise ``AIError`` for common non-2xx statuses."""
        if resp.status_code == 401:
            raise AIError(f"Invalid {label} API key")
        if resp.status_code == 429:
            raise AIError(f"{label} rate limit exceeded — try again shortly")
        if resp.status_code >= 400:
            raise AIError(f"{label} API error {resp.status_code}: {resp.text[:300]}")

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
            usage["cache_hit"] = usage.get("prompt_cache_hit_tokens", 0) or (
                (usage.get("prompt_tokens_details") or {}).get("cached_tokens", 0)
            )
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
        usage["cache_hit"] = usage.get("prompt_cache_hit_tokens", 0) or (
            (usage.get("prompt_tokens_details") or {}).get("cached_tokens", 0)
        )
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


# ---------------------------------------------------------------------------
# OpenCode Go gateway (https://opencode.ai/zen/go/v1)
#
# Routes each model to the dialect the gateway serves it with:
#   /chat/completions  DeepSeek, GLM, Kimi, LongCat, MiMo, Hy
#   /responses         Grok, GPT, Muse Spark            (OpenAI Responses API)
#   /messages          MiniMax, Qwen3.x                 (Anthropic Messages API)
# Every dialect is normalized back to the message shape the rest of the app
# expects (see AIClient.chat), so the agent loop and routes are unchanged.
# ---------------------------------------------------------------------------


def _error_message(err: Any) -> str:
    """Human-readable text from the gateway's ``{"type":"error","error":{…}}`` envelope."""
    if isinstance(err, dict):
        return str(err.get("message") or err)
    if err is None:
        return "unknown error"
    return str(err)


def _usage_dict(prompt: int, completion: int, total: int | None = None, cache_hit: int = 0) -> dict[str, int]:
    """Build the app-shaped usage dict (prompt/completion/total + cache keys)."""
    prompt = int(prompt)
    completion = int(completion)
    hit = int(cache_hit)
    return {
        "prompt_tokens": prompt,
        "completion_tokens": completion,
        "total_tokens": int(total) if total is not None else prompt + completion,
        "cache_hit": hit,
        "cache_miss": max(0, prompt - hit),
    }


# --- /responses (OpenAI Responses API) conversion helpers ------------------


def _opencode_responses_input(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Convert OpenAI chat history to Responses API ``input`` items."""
    items: list[dict[str, Any]] = []
    for m in messages:
        role = m.get("role")
        content = m.get("content")
        if role in ("system", "developer", "user"):
            items.append(
                {
                    "type": "message",
                    "role": "developer" if role == "system" else role,
                    "content": [{"type": "input_text", "text": str(content or "")}],
                }
            )
        elif role == "assistant":
            text = str(content or "")
            if text:
                items.append(
                    {
                        "type": "message",
                        "role": "assistant",
                        "content": [{"type": "output_text", "text": text}],
                    }
                )
            for call in m.get("tool_calls") or []:
                fn = call.get("function") or {}
                items.append(
                    {
                        "type": "function_call",
                        "call_id": call.get("id") or f"call_{len(items)}",
                        "name": fn.get("name") or "",
                        "arguments": fn.get("arguments") or "",
                    }
                )
        elif role == "tool":
            items.append(
                {
                    "type": "function_call_output",
                    "call_id": m.get("tool_call_id") or "",
                    "output": str(content or ""),
                }
            )
    return items


def _opencode_responses_tools(tools: list[dict[str, Any]] | None) -> list[dict[str, Any]] | None:
    """Convert chat-form tools to the Responses API tool shape."""
    if not tools:
        return None
    out: list[dict[str, Any]] = []
    for t in tools:
        fn = t.get("function") if isinstance(t, dict) else None
        if not isinstance(fn, dict):
            continue
        out.append(
            {
                "type": "function",
                "name": fn.get("name") or "",
                "description": fn.get("description") or "",
                "parameters": fn.get("parameters") or {"type": "object", "properties": {}},
                "strict": False,
            }
        )
    return out or None


def _responses_message(resp: dict[str, Any]) -> dict[str, Any]:
    """Normalize a Responses API response to the app's message shape."""
    text: list[str] = []
    calls: list[dict[str, Any]] = []
    for item in resp.get("output") or []:
        if not isinstance(item, dict):
            continue
        if item.get("type") == "message":
            for part in item.get("content") or []:
                if isinstance(part, dict) and part.get("type") == "output_text" and part.get("text"):
                    text.append(part["text"])
        elif item.get("type") == "function_call" and item.get("name"):
            calls.append(
                {
                    "id": item.get("call_id") or item.get("id") or f"call_{len(calls)}",
                    "type": "function",
                    "function": {"name": item["name"], "arguments": item.get("arguments") or ""},
                }
            )
    message: dict[str, Any] = {"role": "assistant", "content": "".join(text) or None}
    if calls:
        message["tool_calls"] = calls
    usage = resp.get("usage")
    if isinstance(usage, dict):
        cached = (usage.get("input_tokens_details") or {}).get("cached_tokens") or 0
        message["usage"] = _usage_dict(
            usage.get("input_tokens") or 0,
            usage.get("output_tokens") or 0,
            usage.get("total_tokens"),
            cached,
        )
    message["finish_reason"] = "length" if resp.get("status") == "incomplete" else "stop"
    return message


# --- /messages (Anthropic Messages API) conversion helpers -----------------


def _opencode_anthropic_messages(messages: list[dict[str, Any]]) -> tuple[str, list[dict[str, Any]]]:
    """Convert OpenAI chat history to the Anthropic Messages API format.

    Returns ``(system, messages)``: system messages are hoisted into the
    top-level ``system`` field, assistant tool calls become ``tool_use``
    blocks, and the ``tool`` results that follow them become one
    ``tool_result`` user turn. Empty assistant turns are dropped (Anthropic
    rejects them).
    """
    system: list[str] = []
    out: list[dict[str, Any]] = []
    i, n = 0, len(messages)
    while i < n:
        m = messages[i]
        role = m.get("role")
        if role == "system" and m.get("content"):
            system.append(str(m["content"]))
            i += 1
            continue
        if role == "user":
            out.append({"role": "user", "content": [{"type": "text", "text": str(m.get("content") or "")}]})
            i += 1
            continue
        if role == "assistant":
            blocks: list[dict[str, Any]] = []
            text = str(m.get("content") or "")
            if text:
                blocks.append({"type": "text", "text": text})
            call_ids: set[str] = set()
            for call in m.get("tool_calls") or []:
                fn = call.get("function") or {}
                call_id = call.get("id") or ""
                name = fn.get("name") or ""
                if not call_id or not name:
                    continue
                args_raw = fn.get("arguments") or ""
                try:
                    args = json.loads(args_raw) if args_raw.strip() else {}
                except (json.JSONDecodeError, TypeError):
                    args = {"raw": args_raw}
                call_ids.add(call_id)
                blocks.append({"type": "tool_use", "id": call_id, "name": name, "input": args})
            if blocks:
                out.append({"role": "assistant", "content": blocks})
            results: list[dict[str, Any]] = []
            j = i + 1
            while j < n and messages[j].get("role") == "tool":
                tm = messages[j]
                cid = tm.get("tool_call_id") or ""
                if cid in call_ids:
                    results.append(
                        {
                            "type": "tool_result",
                            "tool_use_id": cid,
                            "content": str(tm.get("content") or ""),
                        }
                    )
                j += 1
            if results:
                out.append({"role": "user", "content": results})
            i = j
            continue
        i += 1
    return "\n\n".join(system), out


def _opencode_anthropic_tools(tools: list[dict[str, Any]] | None) -> list[dict[str, Any]] | None:
    """Convert chat-form tools to the Anthropic Messages API tool shape."""
    if not tools:
        return None
    out: list[dict[str, Any]] = []
    for t in tools:
        fn = t.get("function") if isinstance(t, dict) else None
        if not isinstance(fn, dict) or not fn.get("name"):
            continue
        out.append(
            {
                "name": fn.get("name"),
                "description": fn.get("description") or "",
                "input_schema": fn.get("parameters") or {"type": "object", "properties": {}},
            }
        )
    return out or None


def _anthropic_blocks_to_message(
    content: list[Any],
    usage: dict[str, Any] | None = None,
    stop_reason: str | None = None,
) -> dict[str, Any]:
    """Normalize an Anthropic ``content`` block list to the app's message shape."""
    text: list[str] = []
    calls: list[dict[str, Any]] = []
    for block in content:
        if not isinstance(block, dict):
            continue
        if block.get("type") == "text" and block.get("text"):
            text.append(block["text"])
        elif block.get("type") == "tool_use" and block.get("name"):
            calls.append(
                {
                    "id": block.get("id") or f"tool_use_{len(calls)}",
                    "type": "function",
                    "function": {
                        "name": block["name"],
                        "arguments": json.dumps(block.get("input") or {}, ensure_ascii=False),
                    },
                }
            )
    message: dict[str, Any] = {"role": "assistant", "content": "".join(text) or None}
    if calls:
        message["tool_calls"] = calls
    if isinstance(usage, dict):
        message["usage"] = _usage_dict(
            usage.get("input_tokens") or 0,
            usage.get("output_tokens") or 0,
            None,
            usage.get("cache_read_input_tokens") or 0,
        )
    if stop_reason == "max_tokens":
        message["finish_reason"] = "length"
    elif stop_reason == "tool_use":
        message["finish_reason"] = "tool_calls"
    else:
        message["finish_reason"] = "stop"
    return message


class OpenCodeGoClient(AIClient):
    """OpenCode Go subscription gateway (OpenAI-compatible, multi-dialect)."""

    name = "opencode_go"
    default_base_url = "https://opencode.ai/zen/go/v1"
    default_model = "deepseek-v4-flash"
    default_max_iterations = 20
    supports_stream_usage = True

    _RESPONSES_MODEL_PREFIXES = ("grok-", "gpt-", "muse-")
    _MESSAGES_MODEL_PREFIXES = ("minimax-", "qwen3")

    def label(self) -> str:
        return "OpenCode Go"

    def _route(self) -> str:
        model = (self.model or "").lower()
        if model.startswith(self._RESPONSES_MODEL_PREFIXES):
            return "responses"
        if model.startswith(self._MESSAGES_MODEL_PREFIXES):
            return "messages"
        return "chat"

    def _headers(self, bearer: bool) -> dict[str, str]:
        headers = {"Content-Type": "application/json"}
        if bearer:
            headers["Authorization"] = f"Bearer {self.api_key}"
        else:
            headers["x-api-key"] = self.api_key
            headers["anthropic-version"] = "2023-06-01"
        return headers

    def _post_json(self, url: str, body: dict[str, Any], bearer: bool = True) -> dict[str, Any]:
        label = self.label()
        try:
            with httpx.Client(timeout=TIMEOUT_SECONDS) as client:
                resp = client.post(url, headers=self._headers(bearer), json=body)
        except httpx.HTTPError as exc:
            raise AIError(f"{label} request failed: {exc}") from exc
        self._check_http(resp, label)
        try:
            return resp.json()
        except ValueError as exc:
            raise AIError(f"{label} returned an unparseable response") from exc

    def chat(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]] | None = None,
        temperature: float = 0.3,
        max_tokens: int | None = None,
    ) -> dict[str, Any]:
        route = self._route()
        if route == "responses":
            return self._chat_responses(messages, tools, temperature, max_tokens)
        if route == "messages":
            return self._chat_messages(messages, tools, temperature, max_tokens)
        return super().chat(messages, tools=tools, temperature=temperature, max_tokens=max_tokens)

    def stream_chat(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]] | None = None,
        temperature: float = 0.3,
        max_tokens: int | None = None,
    ) -> Any:
        route = self._route()
        if route == "responses":
            yield from self._stream_responses(messages, tools, temperature, max_tokens)
            return
        if route == "messages":
            yield from self._stream_messages(messages, tools, temperature, max_tokens)
            return
        yield from super().stream_chat(messages, tools=tools, temperature=temperature, max_tokens=max_tokens)

    # --- /responses -------------------------------------------------------

    def _chat_responses(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]] | None,
        temperature: float,
        max_tokens: int | None,
    ) -> dict[str, Any]:
        body: dict[str, Any] = {
            "model": self.model,
            "input": _opencode_responses_input(messages),
            "temperature": temperature,
            "max_output_tokens": max_tokens if max_tokens is not None else MAX_OUTPUT_TOKENS,
            "stream": False,
        }
        rtools = _opencode_responses_tools(tools)
        if rtools:
            body["tools"] = rtools
        data = self._post_json(f"{self.base_url}/responses", body, bearer=True)
        if isinstance(data, dict) and data.get("type") == "error":
            raise AIError(f"{self.label()} API error: {_error_message(data.get('error'))}")
        return _responses_message(data)

    def _stream_responses(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]] | None,
        temperature: float,
        max_tokens: int | None,
    ) -> Any:
        body: dict[str, Any] = {
            "model": self.model,
            "input": _opencode_responses_input(messages),
            "temperature": temperature,
            "max_output_tokens": max_tokens if max_tokens is not None else MAX_OUTPUT_TOKENS,
            "stream": True,
        }
        rtools = _opencode_responses_tools(tools)
        if rtools:
            body["tools"] = rtools
        label = self.label()
        final: dict[str, Any] | None = None
        try:
            with httpx.Client(timeout=TIMEOUT_SECONDS) as client:
                with client.stream(
                    "POST",
                    f"{self.base_url}/responses",
                    headers=self._headers(bearer=True),
                    json=body,
                ) as resp:
                    self._check_http(resp, label)
                    for line in resp.iter_lines():
                        if not line or not line.startswith("data:"):
                            continue
                        payload = line[5:].strip()
                        if not payload:
                            continue
                        try:
                            chunk = json.loads(payload)
                        except json.JSONDecodeError:
                            continue
                        if not isinstance(chunk, dict):
                            continue
                        etype = chunk.get("type")
                        if etype == "response.output_text.delta" and chunk.get("delta"):
                            yield {"type": "delta", "text": chunk["delta"]}
                        elif etype == "response.failed":
                            raise AIError(f"{label} stream failed: {_error_message(chunk.get('error'))}")
                        elif etype == "response.completed":
                            final = chunk.get("response")
                        elif etype == "error":
                            raise AIError(f"{label} stream error: {_error_message(chunk.get('error'))}")
        except httpx.HTTPError as exc:
            raise AIError(f"{label} request failed: {exc}") from exc
        if final:
            yield {"type": "message", "message": _responses_message(final)}

    # --- /messages (Anthropic) -------------------------------------------

    def _chat_messages(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]] | None,
        temperature: float,
        max_tokens: int | None,
    ) -> dict[str, Any]:
        system, anth = _opencode_anthropic_messages(messages)
        body: dict[str, Any] = {
            "model": self.model,
            "messages": anth,
            "max_tokens": max_tokens if max_tokens is not None else MAX_OUTPUT_TOKENS,
            "temperature": temperature,
            "stream": False,
        }
        if system:
            body["system"] = system
        atools = _opencode_anthropic_tools(tools)
        if atools:
            body["tools"] = atools
        data = self._post_json(f"{self.base_url}/messages", body, bearer=False)
        if isinstance(data, dict) and data.get("type") == "error":
            raise AIError(f"{self.label()} API error: {_error_message(data.get('error'))}")
        return _anthropic_blocks_to_message(data.get("content") or [], data.get("usage"), data.get("stop_reason"))

    def _stream_messages(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]] | None,
        temperature: float,
        max_tokens: int | None,
    ) -> Any:
        system, anth = _opencode_anthropic_messages(messages)
        body: dict[str, Any] = {
            "model": self.model,
            "messages": anth,
            "max_tokens": max_tokens if max_tokens is not None else MAX_OUTPUT_TOKENS,
            "temperature": temperature,
            "stream": True,
        }
        if system:
            body["system"] = system
        atools = _opencode_anthropic_tools(tools)
        if atools:
            body["tools"] = atools
        label = self.label()
        state: dict[str, Any] = {"blocks": {}, "order": [], "usage": None, "stop_reason": None}
        try:
            with httpx.Client(timeout=TIMEOUT_SECONDS) as client:
                with client.stream(
                    "POST",
                    f"{self.base_url}/messages",
                    headers=self._headers(bearer=False),
                    json=body,
                ) as resp:
                    self._check_http(resp, label)
                    for line in resp.iter_lines():
                        if not line or not line.startswith("data:"):
                            continue
                        payload = line[5:].strip()
                        if not payload:
                            continue
                        try:
                            chunk = json.loads(payload)
                        except json.JSONDecodeError:
                            continue
                        if not isinstance(chunk, dict):
                            continue
                        etype = chunk.get("type")
                        if etype == "message_start":
                            msg = chunk.get("message") or {}
                            if isinstance(msg.get("usage"), dict):
                                state["usage"] = msg["usage"]
                        elif etype == "content_block_start":
                            idx = chunk.get("index")
                            block = chunk.get("content_block") or {}
                            state["blocks"][idx] = {
                                "type": block.get("type"),
                                "tool": (
                                    {"id": block.get("id"), "name": block.get("name")}
                                    if block.get("type") == "tool_use"
                                    else None
                                ),
                                "text": [],
                                "json": [],
                                "input": None,
                            }
                            state["order"].append(idx)
                        elif etype == "content_block_delta":
                            idx = chunk.get("index")
                            entry = state["blocks"].get(idx)
                            if not entry:
                                continue
                            delta = chunk.get("delta") or {}
                            dtype = delta.get("type")
                            if dtype == "text_delta" and delta.get("text"):
                                entry["text"].append(delta["text"])
                                if entry["type"] == "text":
                                    yield {"type": "delta", "text": delta["text"]}
                            elif dtype == "input_json_delta":
                                entry["json"].append(delta.get("partial_json") or "")
                        elif etype == "content_block_stop":
                            idx = chunk.get("index")
                            entry = state["blocks"].get(idx)
                            if entry and entry["type"] == "tool_use":
                                raw = "".join(entry["json"])
                                try:
                                    entry["input"] = json.loads(raw) if raw.strip() else {}
                                except (json.JSONDecodeError, TypeError):
                                    entry["input"] = {"raw": raw}
                        elif etype == "message_delta":
                            d = chunk.get("delta") or {}
                            if isinstance(d.get("stop_reason"), str):
                                state["stop_reason"] = d["stop_reason"]
                            usage = chunk.get("usage")
                            if isinstance(usage, dict):
                                state["usage"] = usage
                        elif etype == "error":
                            raise AIError(f"{label} stream error: {_error_message(chunk.get('error'))}")
        except httpx.HTTPError as exc:
            raise AIError(f"{label} request failed: {exc}") from exc
        yield {"type": "message", "message": self._assemble_anthropic_stream(state)}

    def _assemble_anthropic_stream(self, state: dict[str, Any]) -> dict[str, Any]:
        """Rebuild an Anthropic ``content`` block list from streamed events."""
        blocks: list[dict[str, Any]] = []
        for idx in state["order"]:
            entry = state["blocks"].get(idx)
            if not entry:
                continue
            if entry["type"] == "text":
                blocks.append({"type": "text", "text": "".join(entry["text"])})
            elif entry["type"] == "tool_use":
                tool = entry["tool"] or {}
                inp = entry["input"]
                if not isinstance(inp, dict):
                    raw = "".join(entry["json"])
                    try:
                        inp = json.loads(raw) if raw.strip() else {}
                    except (json.JSONDecodeError, TypeError):
                        inp = {"raw": raw}
                blocks.append(
                    {"type": "tool_use", "id": tool.get("id"), "name": tool.get("name"), "input": inp}
                )
        return _anthropic_blocks_to_message(blocks, state.get("usage"), state.get("stop_reason"))


PROVIDERS: dict[str, type[AIClient]] = {
    DeepSeekClient.name: DeepSeekClient,
    LMStudioClient.name: LMStudioClient,
    OpenAICompatibleClient.name: OpenAICompatibleClient,
    OpenCodeGoClient.name: OpenCodeGoClient,
}

PROVIDER_LABELS: dict[str, str] = {
    "deepseek": "DeepSeek",
    "lmstudio": "LM Studio",
    "openai_compatible": "OpenAI Compatible",
    "opencode_go": "OpenCode Go",
}

# OpenCode Go catalog snapshot from https://opencode.ai/zen/go/v1/models
# (the docs note the list changes as models are added — users can still type
# any valid slug).
OPENCODE_GO_MODELS: list[str] = [
    "deepseek-v4-flash",
    "deepseek-v4-pro",
    "deepseek-v4-flash-vision-exp",
    "kimi-k3",
    "kimi-k2.7-code",
    "kimi-k2.6",
    "kimi-k2.5",
    "longcat-2.0",
    "glm-5.3-flash",
    "glm-5.3",
    "glm-5.2",
    "glm-5.1",
    "glm-5",
    "mimo-v2.5",
    "mimo-v2.5-pro",
    "mimo-v2-pro",
    "mimo-v2-omni",
    "hy4-preview",
    "hy3",
    "hy3-preview",
    "qwen3.8-max",
    "qwen3.8-flash",
    "qwen3.7-max",
    "qwen3.7-plus",
    "qwen3.6-plus",
    "qwen3.5-plus",
    "minimax-m3",
    "minimax-m2.7",
    "minimax-m2.5",
    "grok-4.6",
    "grok-4.5",
    "gpt-5.6-luna",
    "muse-spark-1.2-contributor",
]


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
