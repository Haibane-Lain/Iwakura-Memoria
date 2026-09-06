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
_LT_DIR = Path(__file__).resolve().parent.parent.parent / "LanguageTool 6.9"
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


def check(text: str, language: str = "en-US", dictionary_words: list[str] | None = None) -> list[dict[str, Any]] | None:
    """Run grammar check. Returns list of match dicts, or None if unavailable.

    If *dictionary_words* is provided, any match whose matched text
    (case-insensitive) appears in the list is excluded from results.
    """
    if not is_available():
        return None
    if not _concurrency.acquire(blocking=False):
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
    finally:
        _concurrency.release()

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
