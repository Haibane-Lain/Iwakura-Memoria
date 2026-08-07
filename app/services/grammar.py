"""LanguageTool integration — server lifecycle and text checking."""
from __future__ import annotations

import atexit
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

import httpx

_LT_PORT = 8081
_LT_URL = f"http://127.0.0.1:{_LT_PORT}"
_LT_DIR = Path(__file__).resolve().parent.parent.parent / "LanguageTool 6.9"
_LT_JAR = _LT_DIR / "languagetool-server.jar"
_LT_JAVA = "java"

_lt_process: subprocess.Popen | None = None
_client: httpx.Client | None = None


def _find_java() -> str | None:
    import shutil
    java = shutil.which("java")
    if java:
        return java
    for home in ("JAVA_HOME", "JDK_HOME"):
        val = __import__("os").environ.get(home)
        if val:
            candidate = Path(val) / "bin" / "java.exe"
            if candidate.is_file():
                return str(candidate)
    return None


def start_lt_server() -> bool:
    """Launch LanguageTool server from the bundled folder. Returns True if ready."""
    global _lt_process, _client

    if not _LT_JAR.exists():
        print(f"[Grammar] LanguageTool JAR not found at {_LT_JAR}", file=sys.stderr)
        return False

    java = _find_java()
    if not java:
        print("[Grammar] Java not found — LanguageTool requires Java 17+.", file=sys.stderr)
        return False

    print(f"[Grammar] Starting LanguageTool server on port {_LT_PORT}…")
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
                _client = httpx.Client(timeout=30)
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


def check(text: str, language: str = "en-US", dictionary_words: list[str] | None = None) -> list[dict[str, Any]] | None:
    """Run grammar check. Returns list of match dicts, or None if unavailable.

    If *dictionary_words* is provided, any match whose matched text
    (case-insensitive) appears in the list is excluded from results.
    """
    if not is_available():
        return None
    try:
        resp = _client.post(
            f"{_LT_URL}/v2/check",
            data={"language": language, "text": text},
        )
        resp.raise_for_status()
        data = resp.json()
    except Exception:
        return None

    ignore = {w.strip().lower() for w in (dictionary_words or []) if w.strip()}

    matches: list[dict[str, Any]] = []
    for m in data.get("matches", []):
        offset = m.get("offset", 0)
        length = m.get("length", 0)
        matched_text = text[offset : offset + length]
        if ignore and matched_text.lower() in ignore:
            continue
        matches.append({
            "offset": offset,
            "length": length,
            "message": m.get("message", ""),
            "replacements": [r.get("value", "") for r in m.get("replacements", [])],
            "rule_id": (m.get("rule") or {}).get("id", ""),
            "category": (m.get("rule") or {}).get("category", {}).get("name", ""),
            "context_text": (m.get("context") or {}).get("text", ""),
            "context_offset": (m.get("context") or {}).get("offset", 0),
        })
    return matches
