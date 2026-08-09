"""Lain: the agent loop, confirmation continuation, and context compression.

The client owns the user-visible ``history`` (text only). ``agentState`` only
exists while a confirmation is pending — it holds the exact message list and
deferred tool calls needed to resume the loop after the user decides.
"""
from __future__ import annotations

import json
import threading
from typing import Any

from app.ai import providers, sessions, tools
from app.services import settings as settings_service

KEEP_ON_COMPRESS = 8
MAX_COMPRESS_CHARS = 12000
# Ceiling for a single request's input. The model window is much larger, but
# this fails gracefully (with a compress hint) instead of an opaque API error
# or runaway spend if a turn accumulates a huge amount of tool output.
MAX_CONTEXT_TOKENS = 600_000
# How many times to re-send an identical request when the model returns an
# empty completion (no text, no tool calls). DeepSeek occasionally returns an
# empty turn; retrying usually succeeds. Only fires on genuinely empty turns.
EMPTY_RESPONSE_RETRIES = 2
# When a turn's estimated context exceeds this, auto-compress the session
# history first so the request stays cheap (best-effort; skips on failure).
AUTO_COMPRESS_TOKENS = 50_000
# Number of recent tool calls to report when the iteration ceiling is hit.
LAST_ACTIONS_REPORTED = 5

# Tool types whose rounds are free (don't count toward the iteration ceiling).
# Pure information-gathering rounds can number in the dozens for bulk-read tasks.
_READ_TOOLS = {"list_tree", "read_entry", "read_attachment"}


class AgentError(Exception):
    pass


class StepCallback:
    """Optional hooks into the agent loop for live progress streaming.

    All methods are no-ops so synchronous usage is unaffected; subclasses
    override the ones they care about. Methods run on whatever thread executes
    the loop, so implementations must be thread-safe.
    """

    def on_tool_start(self, name: str, args: dict[str, Any]) -> None:
        pass

    def on_tool_result(self, name: str, args: dict[str, Any], summary: str) -> None:
        pass

    def on_tool_error(self, name: str, args: dict[str, Any], error: str) -> None:
        pass


def system_prompt(
    scope: list[str] | None,
    current_doc_id: str | None,
    summary: str | None,
    attachments: list[dict[str, Any]] | None = None,
    read_set: list[str] | None = None,
) -> str:
    """Build Lain's system prompt.

    The fixed instruction block must stay identical across every session and
    turn so DeepSeek's automatic prefix cache can hit it. All variable content
    (scope, attachments, summary, facesheet, viewing doc) is appended at the
    end, after the fixed block.
    """
    lines = [
        "You are Lain, a diligent, professional, and concise assistant for a writer's project.",
        "Your job is to help organize the project, keep lore consistent, and suggest improvements.",
        "You are NOT a ghost-writer: the user writes the prose. Never write full narrative passages on the user's behalf; offer outlines, summaries, and suggestions instead.",
        "Be concise. Prefer short sentences and bullet lists. In your replies, refer to entries and folders by their names and titles — ids are only for tool calls, never quote them.",
        "Entries and folders carry hidden ordering numbers in their ids (e.g. '01-') that the user never sees. Never mention, quote, or explain those numbers.",
        "You can create, read, edit, move, rename, and delete entries and folders using the provided tools.",
        "Use list_tree with 'search' to find entries by title (case-insensitive), 'depth' to limit nesting, "
        "'entry_type' to filter by lore type (e.g. character), and 'titles_only' to save context.",
        "Use edit_entry with 'append': true to safely add content to long wiki entries instead of replacing the full body. "
        "Pass a 'heading' (without ##) to append under a specific section.",
        "For editing, renaming, moving, or deleting, the app will show the user a confirmation and pause before acting. Plan your change and request the tool; do not claim it happened until the user confirms.",
        "After an action is confirmed and executed, briefly state what changed.",
        "If a requested change is outside your allowed folders, say so and suggest an alternative.",
        "Be economical with context: read only what you actually need (pass a small 'limit' for targeted questions), never re-read an entry or attachment whose content you already have in this conversation, batch independent tool calls into a single response, and avoid repeating a call whose result you already saw.",
        "For large multi-part jobs, handle as much as fits comfortably in one reply — a dozen or more entries is fine. "
        "Only if a job is genuinely too large to finish in one turn, work in batches: finish a good chunk, then explicitly "
        "tell the user you are still working and will finish the rest after they say 'continue' (for example: \"I've done 12 of 30 — "
        "say 'continue' and I'll do the next batch\"). Never stop silently mid-job.",
        f"You may only access these folders (and their contents): {_describe_scope(scope)}. The app enforces this.",
    ]
    if attachments:
        names = ", ".join(a["name"] for a in attachments)
        lines.append(
            f"Reference files attached to this session: {names}. Read their extracted text with the "
            "read_attachment tool (by the exact file name) when they are relevant. Treat them as "
            "read-only source material; you cannot edit or move them."
        )
    if summary:
        lines.append("A compressed summary of the earlier conversation follows:\n" + summary)
    if read_set:
        paths = ", ".join(tools._display_path(r) for r in read_set)
        if len(paths) > 400:
            paths = paths[:400] + "…"
        lines.append(
            "Entries already read this session (do not re-read them — you know their content; "
            "if you need a specific detail, use read_entry with a small 'limit' to refresh just "
            f"that part): {paths}"
        )
    if current_doc_id:
        lines.append(f"The user is currently viewing: {current_doc_id}")
    return "\n".join(lines)


def _describe_scope(scope: list[str] | None) -> str:
    if not scope:
        return "nothing — no folders are selected. Ask the user to open the 'Lain can access' panel and check some folders."
    names = []
    for root in scope:
        if root == "":
            names.append("the project root (everything outside worldbuilding/)")
        elif root == "worldbuilding":
            names.append("the wiki (worldbuilding/)")
        else:
            names.append(f"'{tools._display_path(root)}' and its subfolders")
    return ", ".join(names)


def _history_messages(session: dict[str, Any]) -> list[dict[str, Any]]:
    return [
        {"role": m["role"], "content": str(m.get("content", ""))}
        for m in session.get("history", [])
        if m.get("role") in ("user", "assistant")
    ]


def _build_messages(session: dict[str, Any], user_message: str) -> list[dict[str, Any]]:
    messages: list[dict[str, Any]] = [
        {
            "role": "system",
            "content": system_prompt(
                session.get("scope"),
                session.get("currentDocId"),
                session.get("compressedSummary"),
                session.get("attachments"),
                session.get("readSet"),
            ),
        }
    ]
    messages.extend(_history_messages(session))
    if user_message:
        messages.append({"role": "user", "content": user_message})
    return messages


def _usage_dict() -> dict[str, int]:
    return {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0, "cache_hit": 0, "cache_miss": 0}


def _accumulate_usage(target: dict[str, int], usage: dict[str, Any] | None) -> None:
    if not usage:
        return
    for key in ("prompt_tokens", "completion_tokens", "total_tokens"):
        target[key] = target.get(key, 0) + int(usage.get(key) or 0)
    target["cache_hit"] = target.get("cache_hit", 0) + int(
        usage.get("cache_hit") or usage.get("prompt_cache_hit_tokens") or 0
    )
    target["cache_miss"] = target.get("cache_miss", 0) + int(
        usage.get("cache_miss") or usage.get("prompt_cache_miss_tokens") or 0
    )


def _effective_tokens(usage: dict[str, Any]) -> int:
    """Token-equivalent of a turn's billed cost: cache hits count at 1/50th of
    a cache miss (DeepSeek bills hits at ~1/50 the rate of misses), so the
    number tracks spend instead of raw input size. Accepts both the usage-dict
    keys (``completion_tokens``) and the tokensUsed keys (``completion``)."""
    return (
        int(usage.get("cache_miss") or 0)
        + int(usage.get("completion") or usage.get("completion_tokens") or 0)
        + int(usage.get("cache_hit") or 0) // 50
    )


def _estimated_input_tokens(messages: list[dict[str, Any]]) -> int:
    """Rough chars/4 estimate of a request, including tool-call arguments."""
    total = len(messages) * 4
    for m in messages:
        content = m.get("content")
        if isinstance(content, str):
            total += len(content) // 4
        for call in m.get("tool_calls") or []:
            total += len(call.get("function", {}).get("arguments") or "") // 4
    return total


def _track_action(last_tool_labels: list[str], name: str, args: dict[str, Any]) -> None:
    """Record a short label for the tool call, deduplicating consecutive repeats."""
    label = tools._tool_label(name, args)
    if not last_tool_labels or last_tool_labels[-1] != label:
        last_tool_labels.append(label)
    if len(last_tool_labels) > LAST_ACTIONS_REPORTED:
        last_tool_labels[:] = last_tool_labels[-LAST_ACTIONS_REPORTED:]


def _run_loop(
    project_id: str,
    session: dict[str, Any],
    messages: list[dict[str, Any]],
    callback: StepCallback | None = None,
    cancelled: threading.Event | None = None,
) -> dict[str, Any]:
    """Run the agent loop. Returns done/pending result, mutating ``messages``."""
    scope = session.get("scope")
    session_id = session.get("sessionId")
    client = providers.get_client(settings_service.get_settings())
    actions: list[dict[str, Any]] = []
    usage = _usage_dict()
    new_read_ids: list[str] = []
    last_tool_labels: list[str] = []
    iterations = 0
    while True:
        if cancelled and cancelled.is_set():
            return {
                "done": True,
                "reply": "",
                "actions": actions,
                "usage": usage,
                "readIds": new_read_ids,
            }
        if iterations >= client.max_iterations:
            detail = ""
            if last_tool_labels:
                detail = " Last " + (
                    "action" if len(last_tool_labels) == 1 else "actions"
                ) + ": " + ", ".join(last_tool_labels) + "."
            return {
                "done": True,
                "reply": (
                    f"Lain took too many steps without finishing.{detail} The conversation "
                    "may be stuck in a loop. Increase the iteration limit (currently "
                    f"{client.max_iterations}) in Settings, or compress (⟲) / start a "
                    "new session, then say 'continue'."
                ),
                "actions": actions,
                "usage": usage,
                "readIds": new_read_ids,
            }
        if _estimated_input_tokens(messages) > MAX_CONTEXT_TOKENS:
            return {
                "done": True,
                "reply": (
                    "I've hit this session's context budget — the conversation has grown too large "
                    "to keep going reliably. Use the compress button (⟲) above to replace the older "
                    "messages with a summary, then say 'continue'."
                ),
                "actions": actions,
                "usage": usage,
                "readIds": new_read_ids,
            }
        response = client.chat(messages, tools=tools.schemas())
        _accumulate_usage(usage, response.get("usage"))
        tool_calls = response.get("tool_calls") or []
        content = (response.get("content") or "").strip()
        empty_attempts = 0
        while (
            not content
            and not tool_calls
            and empty_attempts < EMPTY_RESPONSE_RETRIES
            and response.get("finish_reason") != "length"
        ):
            # Re-sending the identical request when the model hit the output
            # ceiling is guaranteed to fail again — stop and report instead.
            empty_attempts += 1
            response = client.chat(messages, tools=tools.schemas())
            _accumulate_usage(usage, response.get("usage"))
            tool_calls = response.get("tool_calls") or []
            content = (response.get("content") or "").strip()
        if not content and not tool_calls:
            finish_reason = response.get("finish_reason")
            if finish_reason == "length":
                reply = (
                    "Lain's reply hit the output length limit. Say 'continue' and it will "
                    "finish what it was saying or doing."
                )
            else:
                reply = (
                    f"Lain returned an empty response {empty_attempts + 1} time"
                    f"{'s' if empty_attempts != 0 else ''} (context about "
                    f"{_estimated_input_tokens(messages):,} tokens) — this usually means the "
                    "conversation is too large for a reliable reply. Use the compress button "
                    "(⟲) above or start a new session, then say 'continue'."
                )
            return {
                "done": True,
                "reply": reply,
                "actions": actions,
                "usage": usage,
                "readIds": new_read_ids,
            }
        assistant = {
            "role": "assistant",
            "content": content or None,
            "tool_calls": tool_calls or None,
        }
        messages.append(assistant)
        if not tool_calls:
            iterations += 1
            return {
                "done": True,
                "reply": content,
                "actions": actions,
                "usage": usage,
                "readIds": new_read_ids,
            }
        pending = None
        deferred: list[dict[str, Any]] = []
        had_write = False
        for index, call in enumerate(tool_calls):
            name = call["function"]["name"]
            try:
                args = json.loads(call["function"].get("arguments") or "{}")
            except (json.JSONDecodeError, TypeError):
                args = {}
            _track_action(last_tool_labels, name, args)
            if name not in _READ_TOOLS:
                had_write = True
            if name not in tools.TOOLS:
                messages.append(
                    {"role": "tool", "tool_call_id": call["id"], "content": f"Unknown tool '{name}'"}
                )
                continue
            if callback:
                callback.on_tool_start(name, args)
            try:
                result = tools.dispatch(
                    name, args, project_id, scope, session_id=session_id
                )
            except Exception as exc:  # noqa: BLE001 — a tool error must not crash the turn
                if callback:
                    callback.on_tool_error(name, args, str(exc))
                messages.append(
                    {"role": "tool", "tool_call_id": call["id"], "content": f"Error: {exc}"}
                )
                continue
            if isinstance(result, tools.PendingAction):
                pending = {
                    "name": name,
                    "args": args,
                    "payload": result.payload,
                    "toolCallId": call["id"],
                    "message": content or None,
                }
                deferred = list(tool_calls[index + 1 :])
                break
            content, action = result
            if callback:
                callback.on_tool_result(name, args, content)
            if name == "read_entry" and args.get("entryId"):
                new_read_ids.append(str(args["entryId"]))
            if action:
                actions.append(action)
            messages.append({"role": "tool", "tool_call_id": call["id"], "content": content})
        if pending or had_write:
            iterations += 1
        if pending:
            return {
                "done": False,
                "reply": None,
                "pending": pending,
                "deferred": deferred,
                "actions": actions,
                "usage": usage,
                "readIds": new_read_ids,
            }


def _record_turn_usage(session: dict[str, Any], usage: dict[str, int] | None) -> None:
    if not usage:
        return
    current = session.get("tokensUsed") or {"prompt": 0, "completion": 0, "total": 0}
    current["prompt"] += usage.get("prompt_tokens", 0)
    current["completion"] += usage.get("completion_tokens", 0)
    current["total"] += usage.get("total_tokens", 0)
    current["cache_hit"] = current.get("cache_hit", 0) + usage.get("cache_hit", 0)
    current["cache_miss"] = current.get("cache_miss", 0) + usage.get("cache_miss", 0)
    current["effective"] = _effective_tokens(current)
    session["tokensUsed"] = current


def chat(
    project_id: str,
    session: dict[str, Any],
    user_message: str,
    callback: StepCallback | None = None,
    cancelled: threading.Event | None = None,
) -> dict[str, Any]:
    session["history"] = (session.get("history") or []) + [
        {"role": "user", "content": user_message}
    ]
    messages = _build_messages(session, "")
    if _estimated_input_tokens(messages) > AUTO_COMPRESS_TOKENS:
        try:
            compress(project_id, session, keep_messages=KEEP_ON_COMPRESS)
        except Exception:  # noqa: BLE001 — auto-compress is best-effort
            pass
        messages = _build_messages(session, "")
    result = _run_loop(project_id, session, messages, callback=callback, cancelled=cancelled)
    if result.get("readIds"):
        seen = set(session.get("readSet") or [])
        seen.update(str(r) for r in result["readIds"])
        session["readSet"] = list(seen)[-20:]
    _record_turn_usage(session, result.get("usage"))
    if result["done"]:
        reply: dict[str, Any] = {"role": "assistant", "content": result["reply"]}
        if result.get("usage"):
            reply["tokens"] = _effective_tokens(result["usage"])
        session["history"].append(reply)
        session["agentState"] = None
    else:
        session["agentState"] = {
            "messages": messages[1:],
            "pending": result["pending"],
            "deferred": result["deferred"],
        }
    sessions.save(project_id, session)
    sessions.set_title(project_id, session)
    return result


def _ack_reply(decision: str, notes: list[str]) -> str:
    """Build the confirmation reply from action summaries, no model involved."""
    ok = [n for n in notes if not n.startswith("Could not")]
    bad = [n for n in notes if n.startswith("Could not")]
    lines: list[str] = []
    if decision == "confirm_all":
        lines.append(f"Applied {len(ok)} action{'s' if len(ok) != 1 else ''}.")
    else:
        lines.append("Confirmed.")
    lines.extend(f"- {n}" for n in ok)
    lines.extend(f"- {n}" for n in bad)
    return "\n".join(lines)


def confirm(project_id: str, session: dict[str, Any], decision: str) -> dict[str, Any]:
    """Resolve a pending confirmation without calling the model.

    ``decision`` is one of "confirm" (apply this action only), "confirm_all"
    (apply this action plus every deferred call from the same round), or
    "cancel" (apply nothing). The reply is built from the executed action
    summaries, so confirming is instant.
    """
    if decision not in ("confirm", "cancel", "confirm_all"):
        raise AgentError("Invalid decision")
    agent_state = session.get("agentState")
    if not agent_state or not agent_state.get("pending"):
        raise AgentError("No pending action to confirm")
    pending = agent_state["pending"]
    scope = session.get("scope")
    session_id = session.get("sessionId")
    actions: list[dict[str, Any]] = []
    notes: list[str] = []

    def _exec(name: str, args: dict[str, Any], confirmed: bool) -> None:
        try:
            _, action = tools.dispatch(
                name, args, project_id, scope, confirmed=confirmed, session_id=session_id
            )
        except Exception as exc:  # noqa: BLE001 — isolate failures; one bad call must not 500 the batch
            notes.append(f"Could not run {name}: {exc}")
            return
        if action:
            action["ok"] = True
            actions.append(action)
            notes.append(action["summary"])

    if decision != "cancel":
        _exec(pending["name"], pending["args"], confirmed=True)
        if decision == "confirm_all":
            for call in agent_state.get("deferred", []):
                name = call.get("function", {}).get("name", "")
                try:
                    args = json.loads(call.get("function", {}).get("arguments") or "{}")
                except json.JSONDecodeError:
                    args = {}
                confirmed = bool((tools.TOOLS.get(name) or {}).get("confirm"))
                _exec(name, args, confirmed)

    reply = "Cancelled — no changes were made." if decision == "cancel" else _ack_reply(decision, notes)
    session["agentState"] = None
    session["history"].append({"role": "assistant", "content": reply})
    sessions.save(project_id, session)
    return {
        "done": True,
        "reply": reply,
        "pending": None,
        "deferred": [],
        "actions": actions,
        "usage": _usage_dict(),
    }


def compress(
    project_id: str,
    session: dict[str, Any],
    keep_messages: int = KEEP_ON_COMPRESS,
) -> dict[str, Any]:
    """Summarize everything older than the last ``keep_messages`` messages."""
    agent_state = session.get("agentState")
    if agent_state and agent_state.get("pending"):
        raise AgentError("Cannot compress while a confirmation is pending")
    history = session.get("history") or []
    if len(history) <= keep_messages + 1:
        return session

    to_compress = history[: -keep_messages]
    kept = history[-keep_messages:]
    text = "\n\n".join(
        f"{'User' if m.get('role') == 'user' else 'Lain'}: {m.get('content', '')}"
        for m in to_compress
    )[:MAX_COMPRESS_CHARS]

    client = providers.get_client(settings_service.get_settings())
    response = client.chat(
        [
            {
                "role": "system",
                "content": (
                    "You are Lain's context compactor. Produce a dense summary of this "
                    "conversation: key facts, decisions, entries and folders mentioned or "
                    "changed, open threads, and the user's current intent. Use short bullet "
                    "points, max ~200 words. Do not invent anything not present."
                ),
            },
            {"role": "user", "content": text},
        ],
        temperature=0.2,
        max_tokens=500,
    )
    _record_turn_usage(session, response.get("usage"))
    summary = (response.get("content") or "(compression produced nothing)").strip()

    session["archived"] = (session.get("archived") or []) + to_compress
    session["compressedSummary"] = summary
    session["readSet"] = []
    session["history"] = kept
    sessions.save(project_id, session)
    return session
