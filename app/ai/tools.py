"""Agent tools: read/manage the project tree via the document services.

Every tool enforces the session's ``scope`` (a list of allowed folder roots)
server-side, independent of the model. Destructive tools (edit/rename/move/
delete) are planned by :func:`dispatch` and executed only once the user
confirms; :class:`PendingAction` marks that a plan was returned.
"""
from __future__ import annotations

import difflib
import re
from typing import Any

from app.ai import attachments as attachments_service
from app.services import documents as documents_service

CONFIRM_TOOLS = {
    "edit_entry",
    "rename_entry",
    "move_entry",
    "move_folder",
    "delete_entry",
    "delete_folder",
}

READ_CONTENT_CAP = 8_000
DIFF_LINE_CAP = 60
TREE_TEXT_CAP = 8_000


class ToolError(Exception):
    pass


class PendingAction:
    def __init__(self, payload: dict[str, Any]) -> None:
        self.payload = payload


def _scope_ok(scope: list[str] | None, path: str) -> bool:
    """True when ``path`` (a project-relative id) is inside an allowed root."""
    if not scope:
        return False
    for root in scope:
        if root == "":
            if path != "worldbuilding" and not path.startswith("worldbuilding/"):
                return True
        elif path == root or path.startswith(root + "/"):
            return True
    return False


def _require_scope(scope: list[str] | None, *paths: str) -> None:
    for path in paths:
        if not _scope_ok(scope, path):
            raise ToolError(f"'{path}' is outside the folders Lain may access")


def _doc_folder(doc_id: str) -> str:
    return "/".join(doc_id.split("/")[:-1])


def _display_path(entry_id: str) -> str:
    """Human-readable id with the hidden ``NN-`` order prefixes removed."""
    return "/".join(
        re.sub(r"^\d+-", "", segment) for segment in (entry_id or "").split("/") if segment
    )


def _tree_text(project_id: str, scope: list[str] | None, folder: str | None = None) -> str:
    tree = documents_service.get_tree(project_id, scope="all")

    def prune(node: dict[str, Any]) -> dict[str, Any]:
        folders = []
        for f in node.get("folders", []):
            if _scope_ok(scope, f["id"]) and (not folder or f["id"] == folder or f["id"].startswith(folder + "/")):
                folders.append({"name": f["name"], "id": f["id"], **prune(f)})
        docs = [
            d for d in node.get("documents", [])
            if _scope_ok(scope, d["id"]) and (not folder or _doc_folder(d["id"]) == folder or d["id"].startswith(folder + "/"))
        ]
        return {"folders": folders, "documents": docs}

    def lines(node: dict[str, Any], prefix: str = "") -> list[str]:
        out: list[str] = []
        for d in node.get("documents", []):
            out.append(f"- [{d['id']}] {d['title']} ({d.get('kind', 'note')}, {d.get('words', 0)} words)")
        for f in node.get("folders", []):
            out.append(f"- [folder:{f['id']}] {f['name']}")
            out.extend(lines(f))
        return out

    text = "\n".join(lines(prune(tree)))
    if not text:
        text = "(no entries in the allowed folders)"
    if len(text) > TREE_TEXT_CAP:
        text = text[:TREE_TEXT_CAP] + "\n… (truncated)"
    return text


# ---------------------------------------------------------------------------
# Tool implementations
# ---------------------------------------------------------------------------

def _list_tree(project_id: str, scope: list[str] | None, args: dict[str, Any], session_id: str | None = None) -> tuple[str, dict[str, Any] | None]:
    folder = args.get("folder") or None
    return _tree_text(project_id, scope, folder), None


def _read_entry(project_id: str, scope: list[str] | None, args: dict[str, Any], session_id: str | None = None) -> tuple[str, dict[str, Any] | None]:
    entry_id = str(args["entryId"])
    _require_scope(scope, entry_id)
    try:
        doc = documents_service.get_document(project_id, entry_id)
    except (FileNotFoundError, ValueError) as exc:
        raise ToolError(str(exc)) from exc
    content = doc.get("content", "")
    total = len(content)
    try:
        offset = max(0, int(args.get("offset") or 0))
    except (TypeError, ValueError):
        offset = 0
    limit = READ_CONTENT_CAP
    if args.get("limit") is not None:
        try:
            limit = max(1, min(int(args["limit"]), READ_CONTENT_CAP))
        except (TypeError, ValueError):
            limit = READ_CONTENT_CAP
    capped = content[offset : offset + limit]
    more = offset + len(capped) < total
    head = (
        f"Entry: [{doc['id']}] \"{doc['title']}\" (kind: {doc.get('kind', 'note')}, "
        f"type: {doc.get('type') or 'note'}, words: {doc.get('words', 0)}, chars: {total})\n"
    )
    if not capped:
        return head + "---\n(end of entry reached)\n---", None
    tail = f"\n---\n(chars {offset}–{offset + len(capped)} of {total}"
    tail += "; call read_entry again with a larger offset to continue)" if more else "; end of entry)"
    return head + f"---\n{capped}\n{tail}", None


def _read_attachment(project_id: str, scope: list[str] | None, args: dict[str, Any], session_id: str | None = None) -> tuple[str, dict[str, Any] | None]:
    if not session_id:
        raise ToolError("No active session to read attachments from")
    name = str(args.get("name") or "").strip()
    if not name:
        raise ToolError("An attachment name is required")
    try:
        offset = max(0, int(args.get("offset") or 0))
    except (TypeError, ValueError):
        offset = 0
    items = attachments_service.list_attachments(project_id, session_id)
    item = next((a for a in items if a["name"].lower() == name.lower()), None)
    if item is None:
        raise ToolError(f"Attachment '{name}' is not attached to this session")
    if item.get("error"):
        return (
            f"Attachment \"{item['name']}\" could not be parsed: {item['error']}",
            None,
        )
    text = attachments_service.get_text(project_id, session_id, item["id"])
    if offset >= len(text):
        return (
            f"Attachment \"{item['name']}\" ({item['chars']} chars): offset {offset} "
            "is past the end of the text.",
            None,
        )
    capped = text[offset : offset + READ_CONTENT_CAP]
    truncated = offset + len(capped) < len(text)
    tail = (
        "\n(truncated — call read_attachment again with a larger offset to continue)"
        if truncated
        else ""
    )
    return (
        f"Attachment \"{item['name']}\" ({item['chars']} chars total, "
        f"showing chars {offset}–{offset + len(capped)})\n"
        f"---\n{capped}\n---\n{tail}",
        None,
    )


def _create_entry(project_id: str, scope: list[str] | None, args: dict[str, Any], session_id: str | None = None) -> tuple[str, dict[str, Any] | None]:
    folder = (args.get("folder") or "").strip() or None
    _require_scope(scope, folder or "")
    kind = args.get("kind") or "note"
    title = str(args.get("title", "")).strip()
    if not title:
        raise ToolError("A title is required to create an entry")
    try:
        doc = documents_service.create_document(
            project_id,
            title,
            kind=kind,
            folder=folder,
            content=str(args.get("content") or ""),
            doc_type=args.get("docType") or None,
        )
    except (FileNotFoundError, ValueError) as exc:
        raise ToolError(str(exc)) from exc
    action = {"tool": "create_entry", "summary": f"Created '{doc['title']}' in {_display_path(_doc_folder(doc['id'])) or '(project root)'}", "id": doc["id"], "ok": True}
    return f"Created entry [{doc['id']}] \"{doc['title']}\".", action


def _create_folder(project_id: str, scope: list[str] | None, args: dict[str, Any], session_id: str | None = None) -> tuple[str, dict[str, Any] | None]:
    parent = (args.get("parent") or "").strip() or None
    _require_scope(scope, parent or "")
    try:
        folder_id = documents_service.create_folder(project_id, str(args.get("name", "")).strip(), parent)
    except (FileNotFoundError, ValueError) as exc:
        raise ToolError(str(exc)) from exc
    action = {"tool": "create_folder", "summary": f"Created folder {_display_path(folder_id)}", "id": folder_id, "ok": True}
    return f"Created folder [{folder_id}].", action


# -- planned (confirm) tools -------------------------------------------------

def _diff_lines(before: str, after: str) -> list[dict[str, str]]:
    lines = list(
        difflib.unified_diff(
            before.splitlines(), after.splitlines(), lineterm="", n=2
        )
    )
    # drop the "---/+++" and "@@" headers, keep context/add/del lines
    out: list[dict[str, str]] = []
    for line in lines[2:]:
        if line.startswith("@@"):
            continue
        if line.startswith("-"):
            out.append({"type": "del", "text": line[1:]})
        elif line.startswith("+"):
            out.append({"type": "add", "text": line[1:]})
        else:
            out.append({"type": "ctx", "text": line[1:] if line.startswith(" ") else line})
    if len(out) > DIFF_LINE_CAP:
        out = out[:DIFF_LINE_CAP] + [{"type": "ctx", "text": f"… {len(out) - DIFF_LINE_CAP} more lines"}]
    return out


def _plan_edit_entry(project_id: str, args: dict[str, Any]) -> dict[str, Any]:
    entry_id = str(args["entryId"])
    try:
        doc = documents_service.get_document(project_id, entry_id)
    except (FileNotFoundError, ValueError) as exc:
        raise ToolError(str(exc)) from exc
    proposed = str(args.get("content") or "")
    diff = _diff_lines(doc.get("content", ""), proposed)
    changed = sum(1 for d in diff if d["type"] in ("add", "del"))
    return {
        "tool": "edit_entry",
        "summary": f"Edit \"{doc['title']}\" ({changed} changed lines)",
        "details": {
            "entryId": entry_id,
            "title": doc["title"],
            "folder": _doc_folder(entry_id),
            "words": doc.get("words", 0),
            "diff": diff,
        },
    }


def _plan_rename_entry(project_id: str, args: dict[str, Any]) -> dict[str, Any]:
    entry_id = str(args["entryId"])
    try:
        doc = documents_service.get_document(project_id, entry_id)
    except (FileNotFoundError, ValueError) as exc:
        raise ToolError(str(exc)) from exc
    new_title = str(args.get("newTitle", "")).strip()
    if not new_title:
        raise ToolError("A new title is required")
    return {
        "tool": "rename_entry",
        "summary": f"Rename \"{doc['title']}\" to \"{new_title}\"",
        "details": {"entryId": entry_id, "oldTitle": doc["title"], "newTitle": new_title},
    }


def _plan_move_entry(project_id: str, args: dict[str, Any]) -> dict[str, Any]:
    entry_id = str(args["entryId"])
    target = (args.get("targetFolder") or "").strip()
    try:
        doc = documents_service.get_document(project_id, entry_id)
    except (FileNotFoundError, ValueError) as exc:
        raise ToolError(str(exc)) from exc
    source = _doc_folder(entry_id)
    return {
        "tool": "move_entry",
        "summary": f"Move \"{doc['title']}\" from {_display_path(source) or '(project root)'} to {_display_path(target) or '(project root)'}",
        "details": {
            "entryId": entry_id,
            "title": doc["title"],
            "from": _display_path(source),
            "to": _display_path(target),
        },
    }


def _find_folder(project_id: str, folder_id: str) -> str:
    """Return the folder's display name, raising ToolError if it doesn't exist."""
    tree = documents_service.get_tree(project_id, scope="all")
    stack: list[dict[str, Any]] = [tree]
    while stack:
        node = stack.pop()
        for f in node.get("folders", []):
            if f["id"] == folder_id:
                return f["name"]
            stack.append(f)
    raise ToolError(f"Folder '{folder_id}' not found")


def _plan_move_folder(project_id: str, args: dict[str, Any]) -> dict[str, Any]:
    folder_id = str(args["folderId"])
    target = (args.get("targetFolder") or "").strip()
    name = _find_folder(project_id, folder_id)
    parent = "/".join(folder_id.split("/")[:-1])
    return {
        "tool": "move_folder",
        "summary": f"Move folder \"{name}\" from {_display_path(parent) or '(project root)'} to {_display_path(target) or '(project root)'}",
        "details": {
            "folderId": folder_id,
            "name": name,
            "from": _display_path(parent),
            "to": _display_path(target),
        },
    }


def _plan_delete_entry(project_id: str, args: dict[str, Any]) -> dict[str, Any]:
    entry_id = str(args["entryId"])
    try:
        doc = documents_service.get_document(project_id, entry_id)
    except (FileNotFoundError, ValueError) as exc:
        raise ToolError(str(exc)) from exc
    return {
        "tool": "delete_entry",
        "summary": f"Delete \"{doc['title']}\" ({doc.get('words', 0)} words)",
        "details": {
            "entryId": entry_id,
            "title": doc["title"],
            "folder": _display_path(_doc_folder(entry_id)),
            "words": doc.get("words", 0),
        },
    }


def _plan_delete_folder(project_id: str, args: dict[str, Any]) -> dict[str, Any]:
    folder_id = str(args["folderId"])
    count = 0
    tree = documents_service.get_tree(project_id, scope="all")

    def walk(node: dict[str, Any]) -> int:
        total = len(node.get("documents", []))
        for f in node.get("folders", []):
            total += walk(f)
        return total

    found = False
    name = ""
    stack: list[dict[str, Any]] = [tree]
    while stack and not found:
        node = stack.pop()
        for f in node.get("folders", []):
            if f["id"] == folder_id:
                count = walk(f)
                name = f["name"]
                found = True
                break
            stack.append(f)
    if not found:
        raise ToolError(f"Folder '{folder_id}' not found")
    return {
        "tool": "delete_folder",
        "summary": f"Delete folder \"{name}\" ({count} entries)",
        "details": {"folderId": folder_id, "name": name, "count": count},
    }


# -- confirmed execution -----------------------------------------------------

def _exec_edit_entry(project_id: str, args: dict[str, Any]) -> tuple[str, dict[str, Any] | None]:
    entry_id = str(args["entryId"])
    content = str(args.get("content") or "")
    try:
        doc = documents_service.save_document(project_id, entry_id, content)
    except (FileNotFoundError, ValueError) as exc:
        raise ToolError(str(exc)) from exc
    action = {"tool": "edit_entry", "summary": f"Edited \"{doc['title']}\" ({doc.get('words', 0)} words)", "id": entry_id, "ok": True}
    return f"Edited [{doc['id']}] \"{doc['title']}\".", action


def _exec_rename_entry(project_id: str, args: dict[str, Any]) -> tuple[str, dict[str, Any] | None]:
    entry_id = str(args["entryId"])
    new_title = str(args.get("newTitle", "")).strip()
    try:
        doc = documents_service.rename_document(project_id, entry_id, new_title)
    except (FileNotFoundError, ValueError) as exc:
        raise ToolError(str(exc)) from exc
    action = {"tool": "rename_entry", "summary": f"Renamed to \"{doc['title']}\"", "id": entry_id, "ok": True}
    return f"Renamed [{doc['id']}] to \"{doc['title']}\".", action


def _exec_move_entry(project_id: str, args: dict[str, Any]) -> tuple[str, dict[str, Any] | None]:
    entry_id = str(args["entryId"])
    target = (args.get("targetFolder") or "").strip() or None
    try:
        doc = documents_service.move_document(project_id, entry_id, target)
    except (FileNotFoundError, ValueError) as exc:
        raise ToolError(str(exc)) from exc
    action = {
        "tool": "move_entry",
        "summary": f"Moved \"{doc['title']}\" to {_display_path(target) or '(project root)'}",
        "id": doc["id"],
        "ok": True,
    }
    return f"Moved entry to [{doc['id']}].", action


def _exec_move_folder(project_id: str, args: dict[str, Any]) -> tuple[str, dict[str, Any] | None]:
    folder_id = str(args["folderId"])
    target = (args.get("targetFolder") or "").strip() or None
    try:
        new_id = documents_service.move_folder(project_id, folder_id, target)
    except (FileNotFoundError, ValueError) as exc:
        raise ToolError(str(exc)) from exc
    action = {
        "tool": "move_folder",
        "summary": f"Moved folder to {_display_path(new_id)}",
        "id": new_id,
        "ok": True,
    }
    return f"Moved folder to [{new_id}].", action


def _exec_delete_entry(project_id: str, args: dict[str, Any]) -> tuple[str, dict[str, Any] | None]:
    entry_id = str(args["entryId"])
    try:
        doc = documents_service.get_document(project_id, entry_id)
        documents_service.delete_document(project_id, entry_id)
    except (FileNotFoundError, ValueError) as exc:
        raise ToolError(str(exc)) from exc
    action = {"tool": "delete_entry", "summary": f"Deleted \"{doc['title']}\"", "id": entry_id, "ok": True}
    return f"Deleted entry [{entry_id}].", action


def _exec_delete_folder(project_id: str, args: dict[str, Any]) -> tuple[str, dict[str, Any] | None]:
    folder_id = str(args["folderId"])
    try:
        documents_service.delete_folder(project_id, folder_id)
    except (FileNotFoundError, ValueError) as exc:
        raise ToolError(str(exc)) from exc
    action = {"tool": "delete_folder", "summary": f"Deleted folder {_display_path(folder_id)}", "id": folder_id, "ok": True}
    return f"Deleted folder [{folder_id}].", action


# ---------------------------------------------------------------------------
# Registry
# ---------------------------------------------------------------------------

def _schema(name: str, description: str, props: dict[str, Any], required: list[str]) -> dict[str, Any]:
    return {
        "type": "function",
        "function": {
            "name": name,
            "description": description,
            "parameters": {"type": "object", "properties": props, "required": required},
        },
    }


_SCHEMAS: list[dict[str, Any]] = [
    _schema(
        "list_tree",
        "List the project's folders and entries the user has allowed Lain to access. "
        "Optionally pass 'folder' to list one folder's contents.",
        {
            "folder": {"type": "string", "description": "Optional folder id to list instead of everything"},
        },
        [],
    ),
    _schema(
        "read_entry",
        "Read an entry's content by id (id looks like 'Part One/01-intro' or 'worldbuilding/characters/01-mara'). "
        "Reads up to 8,000 characters per call; if the entry is longer, the reply says so — call again with an 'offset' to continue reading further. "
        "For targeted questions pass a small 'limit' (e.g. 500–2000) and read only the part you need — never dump the whole entry.",
        {
            "entryId": {"type": "string", "description": "Entry id to read"},
            "offset": {"type": "integer", "description": "Character offset to start reading from (default 0)"},
            "limit": {"type": "integer", "description": "Max characters to read in this call (default 8000, capped at 8000)"},
        },
        ["entryId"],
    ),
    _schema(
        "read_attachment",
        "Read the extracted text of a reference file attached to this chat session (pdf, docx, txt, md). "
        "Read by the file's exact name as listed in the system prompt; pass 'offset' to continue reading where a previous read was truncated.",
        {
            "name": {"type": "string", "description": "Attachment file name exactly as listed in the system prompt"},
            "offset": {"type": "integer", "description": "Character offset to start reading from (default 0)"},
        },
        ["name"],
    ),
    _schema(
        "create_entry",
        "Create a new entry (chapter, note, or wiki entry) with Markdown content.",
        {
            "title": {"type": "string", "description": "Display title"},
            "kind": {"type": "string", "enum": ["chapter", "note"], "description": "chapter or note"},
            "folder": {"type": "string", "description": "Folder id to create in (empty = project root, 'worldbuilding' = wiki root)"},
            "content": {"type": "string", "description": "Markdown body"},
            "docType": {"type": "string", "description": "Optional lore type, e.g. character"},
        },
        ["title"],
    ),
    _schema(
        "create_folder",
        "Create a new folder (directory).",
        {"name": {"type": "string"}, "parent": {"type": "string", "description": "Parent folder id (empty = project root)"}},
        ["name"],
    ),
    _schema(
        "edit_entry",
        "Replace an entry's full Markdown body with new content. The app will show a diff and ask the user to confirm. "
        "You may edit several entries per reply. For very large jobs, work in batches and tell the user you are still working "
        "and will continue after they say 'continue'.",
        {"entryId": {"type": "string"}, "content": {"type": "string", "description": "Complete new Markdown body"}},
        ["entryId", "content"],
    ),
    _schema(
        "rename_entry",
        "Change an entry's display title. The app will ask the user to confirm.",
        {"entryId": {"type": "string"}, "newTitle": {"type": "string"}},
        ["entryId", "newTitle"],
    ),
    _schema(
        "move_entry",
        "Move an entry into another folder. The app will show the destination and ask the user to confirm.",
        {"entryId": {"type": "string"}, "targetFolder": {"type": "string", "description": "Destination folder id (empty = project root, 'worldbuilding' = wiki root)"}},
        ["entryId", "targetFolder"],
    ),
    _schema(
        "move_folder",
        "Move a folder (and its contents) into another folder. The app will show the destination and ask the user to confirm.",
        {"folderId": {"type": "string"}, "targetFolder": {"type": "string", "description": "Destination folder id"}},
        ["folderId", "targetFolder"],
    ),
    _schema(
        "delete_entry",
        "Delete an entry permanently. The app will ask the user to confirm.",
        {"entryId": {"type": "string"}},
        ["entryId"],
    ),
    _schema(
        "delete_folder",
        "Delete a folder and everything inside it permanently. The app will ask the user to confirm.",
        {"folderId": {"type": "string"}},
        ["folderId"],
    ),
]

TOOLS: dict[str, dict[str, Any]] = {
    "list_tree": {"confirm": False, "fn": _list_tree},
    "read_entry": {"confirm": False, "fn": _read_entry},
    "read_attachment": {"confirm": False, "fn": _read_attachment},
    "create_entry": {"confirm": False, "fn": _create_entry},
    "create_folder": {"confirm": False, "fn": _create_folder},
    "edit_entry": {"confirm": True, "plan": _plan_edit_entry, "fn": _exec_edit_entry},
    "rename_entry": {"confirm": True, "plan": _plan_rename_entry, "fn": _exec_rename_entry},
    "move_entry": {"confirm": True, "plan": _plan_move_entry, "fn": _exec_move_entry},
    "move_folder": {"confirm": True, "plan": _plan_move_folder, "fn": _exec_move_folder},
    "delete_entry": {"confirm": True, "plan": _plan_delete_entry, "fn": _exec_delete_entry},
    "delete_folder": {"confirm": True, "plan": _plan_delete_folder, "fn": _exec_delete_folder},
}


def schemas() -> list[dict[str, Any]]:
    return _SCHEMAS


def dispatch(
    name: str,
    args: dict[str, Any],
    project_id: str,
    scope: list[str] | None,
    confirmed: bool = False,
    session_id: str | None = None,
) -> PendingAction | tuple[str, dict[str, Any] | None]:
    """Run a tool. Destructive tools without ``confirmed`` return a plan."""
    entry = TOOLS.get(name)
    if entry is None:
        raise ToolError(f"Unknown tool '{name}'")
    try:
        if entry["confirm"]:
            plan = entry["plan"](project_id, args)
            # validate scope for the planned action
            details = plan["details"]
            _validate_plan_scope(scope, name, details)
            if not confirmed:
                return PendingAction(plan)
            result = entry["fn"](project_id, args)
            if result[1] is not None:
                result[1]["ok"] = True
            return result
        return entry["fn"](project_id, scope, args, session_id)
    except ToolError:
        raise
    except Exception as exc:  # noqa: BLE001 — a malformed call or file error must surface as ToolError, never crash the request
        raise ToolError(f"{name} failed: {exc}") from exc


def _validate_plan_scope(scope: list[str] | None, name: str, details: dict[str, Any]) -> None:
    if name in ("edit_entry", "rename_entry", "move_entry", "delete_entry"):
        _require_scope(scope, details["entryId"])
    if name in ("move_entry", "move_folder"):
        _require_scope(scope, details["to"] or "")
    if name in ("move_folder", "delete_folder"):
        _require_scope(scope, details["folderId"])
