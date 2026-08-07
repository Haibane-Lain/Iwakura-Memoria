"""AI provider abstraction.

Providers are OpenAI-compatible chat-completions services. Config for each
provider lives in ``settings.json`` under ``ai.<name>`` with ``apiKey``,
``model`` and optional ``baseUrl``. Nothing calls the network from this
module at import time.
"""
from __future__ import annotations

from typing import Any

import httpx

DEFAULT_MODEL = "deepseek-v4-flash"
MAX_OUTPUT_TOKENS = 65536
TIMEOUT_SECONDS = 300.0


class AIError(Exception):
    """Raised when a provider request fails (bad key, timeout, HTTP error)."""


class AIClient:
    """Base OpenAI-compatible chat client."""

    name = "base"
    default_base_url = ""

    def __init__(self, api_key: str, model: str = "", base_url: str = "") -> None:
        self.api_key = api_key
        self.model = model or DEFAULT_MODEL
        self.base_url = (base_url or self.default_base_url).rstrip("/")

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
            raise AIError(f"DeepSeek request failed: {exc}") from exc
        if resp.status_code == 401:
            raise AIError("Invalid DeepSeek API key")
        if resp.status_code == 429:
            raise AIError("DeepSeek rate limit exceeded — try again shortly")
        if resp.status_code >= 400:
            raise AIError(f"DeepSeek API error {resp.status_code}: {resp.text[:300]}")
        try:
            data = resp.json()
        except ValueError as exc:
            raise AIError("DeepSeek returned an unparseable response") from exc
        try:
            message = data["choices"][0]["message"]
        except (KeyError, IndexError, TypeError) as exc:
            raise AIError("DeepSeek returned an unexpected response shape") from exc
        usage = data.get("usage")
        if usage:
            usage["cache_hit"] = usage.get("prompt_cache_hit_tokens", 0)
            usage["cache_miss"] = usage.get("prompt_cache_miss_tokens", 0)
        message["usage"] = usage
        message["finish_reason"] = data["choices"][0].get("finish_reason")
        return message


class DeepSeekClient(AIClient):
    name = "deepseek"
    default_base_url = "https://api.deepseek.com"


PROVIDERS: dict[str, type[AIClient]] = {
    DeepSeekClient.name: DeepSeekClient,
}


def configured_providers(settings: dict[str, Any]) -> list[str]:
    """Return names of providers that have an API key configured."""
    ai_cfg = settings.get("ai") or {}
    return [name for name, _cls in PROVIDERS.items() if ai_cfg.get(name, {}).get("apiKey")]


def get_client(settings: dict[str, Any]) -> AIClient:
    """Return a configured client for the first provider with credentials."""
    ai_cfg = settings.get("ai") or {}
    for name, cls in PROVIDERS.items():
        cfg = ai_cfg.get(name) or {}
        if cfg.get("apiKey"):
            return cls(
                api_key=cfg["apiKey"],
                model=str(cfg.get("model") or ""),
                base_url=str(cfg.get("baseUrl") or ""),
            )
    raise AIError("No AI provider configured — add a DeepSeek API key in Settings")
