"""LanguageTool integration — server lifecycle and text checking."""
from __future__ import annotations

import atexit
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Any

import httpx

_LT_PORT = 8081
_LT_URL = f"http://127.0.0.1:{_LT_PORT}"


def _lt_dir() -> Path:
    """LanguageTool directory. A packaged build passes it via IWAKURA_LT_DIR
    (Electron's extraResources/languagetool); dev falls back to the gitignored
    LanguageTool 6.9/ next to the code."""
    env = __import__("os").environ.get("IWAKURA_LT_DIR")
    if env and Path(env).is_dir():
        return Path(env)
    return Path(__file__).resolve().parent.parent.parent / "LanguageTool 6.9"


_LT_DIR = _lt_dir()
_LT_JAR = _LT_DIR / "languagetool-server.jar"
_LT_JAVA = "java"
# LanguageTool is a single JVM; checking long texts is slow. Capping in-flight
# checks keeps a handful of slow requests from occupying every FastAPI sync
# threadpool slot, which would otherwise starve doc saves during heavy typing.
# The per-request cap is generous (30 s) because a freshly spawned JVM can take
# that long on its first check while it loads its grammar models.
_LT_TIMEOUT_SECONDS = 30.0
_LT_CONCURRENCY = 2

_lt_process: subprocess.Popen | None = None
_client: httpx.Client | None = None
_concurrency = threading.Semaphore(_LT_CONCURRENCY)


def _find_java() -> str | None:
    import os
    import shutil
    # A bundled JRE (packaged build) is the first choice — the end user likely
    # has no system Java. Electron passes IWAKURA_JRE_DIR = resources/jre.
    bundled = os.environ.get("IWAKURA_JRE_DIR")
    if bundled:
        candidate = Path(bundled) / "bin" / "java.exe"
        if candidate.is_file():
            return str(candidate)
    java = shutil.which("java")
    if java:
        return java
    for home in ("JAVA_HOME", "JDK_HOME"):
        val = os.environ.get(home)
        if val:
            candidate = Path(val) / "bin" / "java.exe"
            if candidate.is_file():
                return str(candidate)
    return None


def start_lt_server() -> bool:
    """Make sure a LanguageTool server is running on the port. Returns True if ready.

    If a LanguageTool already answers on the port — e.g. an orphaned server
    left behind by a previous session that still holds the port — it is adopted
    instead of spawning a second JVM, which would crash on bind and leave
    ``is_available()`` permanently False.
    """
    global _lt_process, _client

    if _client is not None and is_available():
        return True
    if _lt_process is not None and _lt_process.poll() is not None:
        # Our previously spawned JVM died; forget it so we can adopt or respawn.
        _lt_process = None

    try:
        probe = httpx.get(f"{_LT_URL}/v2/languages", timeout=2)
        if probe.status_code == 200:
            _client = httpx.Client(timeout=_LT_TIMEOUT_SECONDS)
            _lt_process = None
            print(f"[Grammar] Reusing existing LanguageTool server on port {_LT_PORT}")
            return True
    except Exception:
        pass

    if not _LT_JAR.exists():
        print(f"[Grammar] LanguageTool JAR not found at {_LT_JAR}", file=sys.stderr)
        return False

    java = _find_java()
    if not java:
        print("[Grammar] Java not found — LanguageTool requires Java 17+.", file=sys.stderr)
        return False

    print(f"[Grammar] Starting LanguageTool server on port {_LT_PORT}...")
    try:
        _lt_process = subprocess.Popen(
            [java, "-cp", str(_LT_JAR), "org.languagetool.server.HTTPServer", "--port", str(_LT_PORT)],
            cwd=str(_LT_DIR),
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    except Exception as exc:
        print(f"[Grammar] Failed to launch LanguageTool: {exc}", file=sys.stderr)
        return False

    atexit.register(stop_lt_server)

    deadline = time.time() + 45
    while time.time() < deadline:
        if _lt_process.poll() is not None:
            print("[Grammar] LanguageTool process exited early.", file=sys.stderr)
            return False
        try:
            resp = httpx.get(f"{_LT_URL}/v2/languages", timeout=2)
            if resp.status_code == 200:
                _client = httpx.Client(timeout=_LT_TIMEOUT_SECONDS)
                print(f"[Grammar] LanguageTool ready on port {_LT_PORT}")
                return True
        except Exception:
            pass
        time.sleep(1)

    print("[Grammar] LanguageTool failed to start within timeout.", file=sys.stderr)
    return False


def stop_lt_server() -> None:
    global _lt_process, _client
    if _client is not None:
        _client.close()
        _client = None
    if _lt_process is not None and _lt_process.poll() is None:
        _lt_process.terminate()
        try:
            _lt_process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            _lt_process.kill()
        _lt_process = None


def is_available() -> bool:
    return _client is not None and (_lt_process is None or _lt_process.poll() is None)


# LanguageTool's ``rule.issueType`` is finer grained (misspelling, grammar,
# style, typographical, duplication, inconsistency, uncategorized). The UI only
# needs three buckets: red errors, amber warnings, and the style suggestions
# that the Language panel groups but the editor does not underline.
_STYLE_ISSUES = {"style"}
_ERROR_ISSUES = {"misspelling", "grammar", "duplication", "inconsistency"}
_RULE_DOCS_URL = "https://community.languagetool.org/rule/show/{rule_id}"


def _severity(issue_type: str) -> str:
    """Map a LanguageTool issue type onto the UI's error/warning/style bucket."""
    value = (issue_type or "").lower()
    if value in _STYLE_ISSUES:
        return "style"
    if value in _ERROR_ISSUES:
        return "error"
    return "warning"


def _match_payload(match: dict[str, Any]) -> dict[str, Any]:
    """Flatten one LanguageTool match into the shape the editor/panel consume.

    Everything the panel needs to filter, group and explain an issue is kept:
    the short and long message, the rule identity and docs link, the category,
    the issue type and its severity bucket, and the sentence it sits in. The
    client derives the flagged text from ``context_text``/``context_offset``,
    which is what keeps it valid when the writer edits before clicking.
    """
    rule = match.get("rule") or {}
    category = rule.get("category") or {}
    context = match.get("context") or {}
    rule_id = rule.get("id", "")
    urls = rule.get("urls") or []
    rule_url = urls[0].get("value", "") if urls else ""
    if not rule_url and rule_id:
        rule_url = _RULE_DOCS_URL.format(rule_id=rule_id)
    issue_type = rule.get("issueType", "")
    return {
        "offset": match.get("offset", 0),
        "length": match.get("length", 0),
        "message": match.get("message", ""),
        "short_message": match.get("shortMessage", ""),
        "replacements": [r.get("value", "") for r in match.get("replacements", [])],
        "rule_id": rule_id,
        "rule_description": rule.get("description", ""),
        "rule_url": rule_url,
        "category_id": category.get("id", ""),
        "category": category.get("name", ""),
        "issue_type": issue_type,
        "severity": _severity(issue_type),
        "tags": list(rule.get("tags") or []),
        "is_premium": bool(rule.get("isPremium")),
        "sentence": match.get("sentence", ""),
        "context_text": context.get("text", ""),
        "context_offset": context.get("offset", 0),
    }


def check(
    text: str,
    language: str = "en-US",
    dictionary_words: list[str] | None = None,
    *,
    level: str | None = None,
    mother_tongue: str | None = None,
    preferred_variants: str | None = None,
    enabled_categories: list[str] | None = None,
    disabled_categories: list[str] | None = None,
    enabled_rules: list[str] | None = None,
    disabled_rules: list[str] | None = None,
) -> list[dict[str, Any]] | None:
    """Run grammar check. Returns list of match dicts, or None if unavailable.

    If *dictionary_words* is provided, any match whose matched text
    (case-insensitive) appears in the list is excluded from results.

    The optional keyword arguments are forwarded to LanguageTool's ``/v2/check``
    endpoint. ``level="picky"`` turns on the style rules (passive voice and
    friends) that the default level leaves out; the category/rule lists let a
    caller widen or narrow the rule set without a second round trip.
    """
    if not is_available():
        return None
    if not _concurrency.acquire(blocking=False):
        return None
    try:
        data: dict[str, str] = {"language": language, "text": text}
        if level:
            data["level"] = level
        if mother_tongue:
            data["motherTongue"] = mother_tongue
        if preferred_variants:
            data["preferredVariants"] = preferred_variants
        if enabled_categories:
            data["enabledCategories"] = ",".join(enabled_categories)
        if disabled_categories:
            data["disabledCategories"] = ",".join(disabled_categories)
        if enabled_rules:
            data["enabledRules"] = ",".join(enabled_rules)
        if disabled_rules:
            data["disabledRules"] = ",".join(disabled_rules)
        resp = _client.post(f"{_LT_URL}/v2/check", data=data)
        resp.raise_for_status()
        payload = resp.json()
    except Exception:
        return None
    finally:
        _concurrency.release()

    ignore = {w.strip().lower() for w in (dictionary_words or []) if w.strip()}

    matches: list[dict[str, Any]] = []
    for m in payload.get("matches", []):
        offset = m.get("offset", 0)
        length = m.get("length", 0)
        matched_text = text[offset : offset + length]
        if ignore and matched_text.lower() in ignore:
            continue
        matches.append(_match_payload(m))
    return matches
