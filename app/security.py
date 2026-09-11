"""Localhost request guard and AI-key masking.

The app is a single-user server bound to 127.0.0.1 with no authentication.
Anything that can reach the port can delete documents, so each request is
validated against two headers a web page cannot lie about:

- ``Host`` must be a loopback hostname. This defeats DNS-rebinding attacks:
  an attacker page whose domain resolves to 127.0.0.1 still sends its own
  hostname in ``Host`` and is rejected here.
- For state-changing methods (POST/PUT/DELETE) an explicit ``Origin`` must
  also be a loopback origin. The port check is permissive because the
  Electron shell uses dynamic ports (8000-8009); the host check is strict.
  The origin check only applies when the header is present, so curl,
  pywebview and other non-browser clients keep working unchanged. Read-only
  methods pass on the Host check alone: a cross-origin page cannot read
  responses anyway (the server never sends CORS headers, so browsers block
  the read), and a rebinding page is already stopped by the Host check.

No peer-address check is needed: uvicorn only ever accepts connections on
``127.0.0.1``, so every peer is loopback by construction.

Set ``IWAKURA_INSECURE_LOCALHOST=1`` to disable every check (for experiments
only — never for normal use).
"""
from __future__ import annotations

import copy
import os
from typing import Any
from urllib.parse import urlsplit

# Value returned by the settings API in place of a stored API key. The
# frontend treats it as "a key is saved here" and never sends it back.
MASK = "••••••••••••"

_LOOPBACK_HOSTS = {"127.0.0.1", "localhost", "::1"}
_STATE_CHANGING_METHODS = {"POST", "PUT", "DELETE"}


def _loopback_hostname(host: str) -> str | None:
    """Normalize a ``Host`` header value to a lowercased hostname, or None
    when it isn't a valid host[:port] form.

    Parsed manually (not with urlparse) so garbage like
    ``127.0.0.1:8000.evil.com`` is rejected: the optional port must be all
    digits. Handles ``127.0.0.1:8000``, ``[::1]:8000``, trailing dots and
    uppercase.
    """
    host = (host or "").strip()
    if not host:
        return None
    if host.startswith("["):
        end = host.find("]")
        if end == -1:
            return None
        hostname = host[1:end]
        rest = host[end + 1:]
        if rest and (not rest.startswith(":") or not rest[1:].isdigit()):
            return None
    else:
        if host.count(":") > 1:
            return None  # unbracketed IPv6 or malformed garbage
        if ":" in host:
            head, _, port = host.partition(":")
            if not port.isdigit():
                return None
            hostname = head
        else:
            hostname = host
    hostname = hostname.lower().rstrip(".")
    return hostname or None


def _parse_origin(origin: str) -> tuple[str, str] | None:
    """Parse an ``Origin`` header into ``(scheme, hostname)`` for loopback
    comparison, or None when it isn't a well-formed http origin."""
    try:
        parsed = urlsplit(origin)
    except ValueError:
        return None
    if parsed.scheme != "http":
        return None
    hostname = _loopback_hostname(parsed.netloc)
    if hostname is None:
        return None
    return parsed.scheme, hostname


def check_local_request(host: str, method: str, origin: str | None) -> str | None:
    """Return a rejection reason string, or None when the request is allowed.

    ``host`` is the ``Host`` header, ``method`` the HTTP method, ``origin``
    the ``Origin`` header (may be None). Not meant to be secret — it exists
    so the middleware and any debugging tool agree on the exact wording.
    """
    if os.environ.get("IWAKURA_INSECURE_LOCALHOST"):
        return None

    if _loopback_hostname(host or "") not in _LOOPBACK_HOSTS:
        return "non-loopback Host header"

    if method in _STATE_CHANGING_METHODS and origin is not None:
        parsed = _parse_origin(origin)
        if parsed is None or parsed[1] not in _LOOPBACK_HOSTS:
            return "non-loopback Origin header"

    return None


def mask_settings(settings: dict[str, Any]) -> dict[str, Any]:
    """Return a copy of *settings* with every ``ai.<name>.apiKey`` replaced
    by :data:`MASK`. Server-side AI code keeps using the unmasked settings
    via :func:`app.config.load_settings`; only API responses are masked."""
    out = copy.deepcopy(settings)
    ai = out.get("ai")
    if isinstance(ai, dict):
        for cfg in ai.values():
            if isinstance(cfg, dict) and cfg.get("apiKey"):
                cfg["apiKey"] = MASK
    return out
