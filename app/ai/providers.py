"""AI provider abstraction.

Providers are OpenAI-compatible chat-completions services. Config for each
provider lives in ``settings.json`` under ``ai.<name>`` with ``apiKey``,
``model`` and optional ``baseUrl``. The active provider is chosen by the
``ai.provider`` key; if unset, the first provider with a configured API key
is used. Nothing calls the network from this module at import time.
"""
from __future__ import annotations

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

    def __init__(self, api_key: str, model: str = "", base_url: str = "") -> None:
        self.api_key = api_key
        self.model = model or self.default_model
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

    def label(self) -> str:
        return self.name.title()


class DeepSeekClient(AIClient):
    name = "deepseek"
    default_base_url = "https://api.deepseek.com"
    default_model = "deepseek-v4-flash"


class LMStudioClient(AIClient):
    name = "lmstudio"
    default_base_url = "http://localhost:1234/v1"
    default_model = ""

    def label(self) -> str:
        return "LM Studio"


class OpenAICompatibleClient(AIClient):
    name = "openai_compatible"
    default_base_url = ""
    default_model = ""

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
    return cls(
        api_key=cfg["apiKey"],
        model=str(cfg.get("model") or ""),
        base_url=str(cfg.get("baseUrl") or ""),
    )
