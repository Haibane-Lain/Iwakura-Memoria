"""Global settings read/write.

API keys stay in ``settings.json`` (plaintext, like every other setting) but
the API never echoes them: responses are masked by the route layer, and
:func:`update_settings` preserves a stored key whenever the incoming patch
carries the :data:`app.security.MASK` sentinel or omits ``apiKey``
entirely. To *clear* a key a client must send ``apiKey: ""`` explicitly.
"""
from __future__ import annotations

from typing import Any

from app import config
from app.security import MASK


def get_settings() -> dict[str, Any]:
    return config.load_settings()


def _merge_ai(current_ai: dict[str, Any], patch_ai: dict[str, Any]) -> dict[str, Any]:
    """Merge the incoming ``ai`` block over the current one, keeping stored
    API keys unless the patch explicitly replaces or clears them.

    - ``apiKey == MASK`` or omitted  -> carry the stored key forward,
    - ``apiKey == ""``               -> clear (stored key removed),
    - anything else                  -> replace.
    """
    out: dict[str, Any] = {}
    for name, raw in patch_ai.items():
        if not isinstance(raw, dict):
            out[name] = raw
            continue
        cfg = dict(raw)
        prev = current_ai.get(name)
        prev_cfg = prev if isinstance(prev, dict) else {}
        key = cfg.get("apiKey")
        if key == MASK or "apiKey" not in cfg:
            if prev_cfg.get("apiKey"):
                cfg["apiKey"] = prev_cfg["apiKey"]
            else:
                cfg.pop("apiKey", None)
        out[name] = cfg
    return out


def update_settings(patch: dict[str, Any]) -> dict[str, Any]:
    current = config.load_settings()
    if isinstance(patch.get("ai"), dict):
        patch["ai"] = _merge_ai(current.get("ai") or {}, patch["ai"])
    current.update(patch)
    return config.save_settings(current)
