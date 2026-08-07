"""Server-sent event streaming for Lain's agent loop.

Runs :func:`app.ai.agent.chat` on a background thread while forwarding live
tool-progress events to an ``asyncio`` queue, which an async generator drains
into a ``text/event-stream`` response. The synchronous chat path is untouched;
only the tool hooks differ.
"""
from __future__ import annotations

import asyncio
import re
import threading
from typing import Any, Awaitable, Callable

from app.ai import agent, tools


def _display_name(args: dict[str, Any], key: str = "entryId") -> str:
    eid = str(args.get(key) or "")
    path = tools._display_path(eid)
    return path or ""


def _short_name(args: dict[str, Any], key: str = "entryId") -> str:
    segments = _display_name(args, key).split("/")
    return segments[-1] if segments else ""


def _tool_start_label(name: str, args: dict[str, Any]) -> str:
    if name == "read_entry":
        return f"Reading '{_display_name(args)}'"
    if name == "read_attachment":
        return f"Reading attachment '{args.get('name', '')}'"
    if name == "list_tree":
        folder = args.get("folder")
        return "Listing project tree" if not folder else f"Listing folder '{folder}'"
    if name == "create_entry":
        return f"Creating '{args.get('title', '')}'"
    if name == "create_folder":
        return f"Creating folder '{args.get('name', '')}'"
    if name == "edit_entry":
        return f"Planning edit of '{_display_name(args)}'"
    if name == "rename_entry":
        return f"Renaming '{_short_name(args)}' → '{args.get('newTitle', '')}'"
    if name == "move_entry":
        return f"Planning move of '{_display_name(args)}'"
    if name == "move_folder":
        return f"Planning move of folder '{_short_name(args, 'folderId')}'"
    if name == "delete_entry":
        return f"Planning deletion of '{_display_name(args)}'"
    if name == "delete_folder":
        return f"Planning deletion of folder '{_short_name(args, 'folderId')}'"
    return f"Running {name}"


_CHARS_RE = re.compile(r"words: (\d+), chars: (\d+)")


def _tool_result_label(name: str, args: dict[str, Any], summary: str) -> str:
    if name == "read_entry":
        match = _CHARS_RE.search(summary or "")
        if match:
            return f"Read '{_display_name(args)}' — {match.group(2)} chars ({match.group(1)} words)"
        return f"Read '{_display_name(args)}'"
    if name == "read_attachment":
        return f"Read attachment '{args.get('name', '')}'"
    if name == "list_tree":
        return "Tree listed"
    if name == "create_entry":
        return f"Created '{args.get('title', '')}'"
    if name == "create_folder":
        return f"Created folder '{args.get('name', '')}'"
    first = next((ln.strip() for ln in (summary or "").splitlines() if ln.strip()), "")
    if len(first) > 80:
        first = first[:80] + "…"
    return first or f"{name} done"


class _StreamCallback(agent.StepCallback):
    def __init__(self, queue: asyncio.Queue, loop: asyncio.AbstractEventLoop) -> None:
        self._queue = queue
        self._loop = loop

    def _push(self, event: dict[str, Any]) -> None:
        self._loop.call_soon_threadsafe(self._queue.put_nowait, event)

    def on_tool_start(self, name: str, args: dict[str, Any]) -> None:
        self._push({"type": "tool_start", "tool": name, "label": _tool_start_label(name, args)})

    def on_tool_result(self, name: str, args: dict[str, Any], summary: str) -> None:
        self._push(
            {"type": "tool_result", "tool": name, "label": _tool_result_label(name, args, summary)}
        )

    def on_tool_error(self, name: str, args: dict[str, Any], error: str) -> None:
        self._push({"type": "tool_error", "tool": name, "label": error})


def _public_pending(pending: dict[str, Any] | None, deferred: list[Any] | None) -> dict[str, Any] | None:
    if not pending:
        return None
    out = dict(pending.get("payload") or {})
    out["deferredCount"] = len(deferred or [])
    if pending.get("message"):
        out["message"] = pending["message"]
    return out


async def stream_chat(
    project_id: str,
    session: dict[str, Any],
    user_message: str,
    build_public: Callable[[], dict[str, Any]] | None = None,
) -> Any:
    """Yield live progress dicts, then a final ``done`` dict.

    ``build_public`` (if given) produces the serialized public session after
    the turn finishes; it is called once for the ``done`` event.
    """
    loop = asyncio.get_running_loop()
    queue: asyncio.Queue = asyncio.Queue()
    callback = _StreamCallback(queue, loop)
    holder: dict[str, Any] = {}

    def _run() -> None:
        try:
            result = agent.chat(project_id, session, user_message, callback=callback)
            holder["result"] = result
            holder["error"] = None
        except Exception as exc:  # noqa: BLE001 — surfaced to the SSE stream
            holder["error"] = exc
        finally:
            loop.call_soon_threadsafe(queue.put_nowait, None)

    thread = threading.Thread(target=_run, name="lain-chat-stream", daemon=True)
    thread.start()
    while True:
        item = await queue.get()
        if item is None:
            break
        yield item
    thread.join()
    if holder.get("error"):
        raise holder["error"]
    result = holder.get("result") or {}
    pending = _public_pending(result.get("pending"), result.get("deferred"))
    yield {
        "type": "done",
        "session": build_public() if build_public else session,
        "reply": result.get("reply"),
        "done": bool(result.get("done")),
        "pending": pending,
        "actions": result.get("actions", []),
    }
