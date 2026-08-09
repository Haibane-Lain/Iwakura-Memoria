"""AI API: status, test, sessions, chat, confirm, and compress."""
from __future__ import annotations

import json
from typing import Any

from fastapi import APIRouter, File, HTTPException, UploadFile
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from app.ai import agent, attachments, providers, sessions, stream
from app.services import settings as settings_service

router = APIRouter(prefix="/api", tags=["ai"])


class ChatPayload(BaseModel):
    sessionId: str | None = None
    message: str = ""
    folders: list[str] | None = None
    currentDocId: str | None = None


class ConfirmPayload(BaseModel):
    sessionId: str
    decision: str


class CompressPayload(BaseModel):
    keepMessages: int | None = None


class SessionRename(BaseModel):
    title: str


def _session_or_404(project_id: str, session_id: str) -> dict[str, Any]:
    session = sessions.load(project_id, session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="Session not found")
    return session


def _public_pending(pending: dict[str, Any] | None, deferred: list[Any] | None) -> dict[str, Any] | None:
    if not pending:
        return None
    out = dict(pending.get("payload") or {})
    out["deferredCount"] = len(deferred or [])
    if pending.get("message"):
        out["message"] = pending["message"]
    return out


def _public_session(session: dict[str, Any]) -> dict[str, Any]:
    agent_state = session.get("agentState") or {}
    pending = _public_pending(
        agent_state.get("pending") if agent_state.get("pending") else None,
        agent_state.get("deferred"),
    )
    return {
        "sessionId": session["sessionId"],
        "title": session.get("title", "New session"),
        "history": session.get("history", []),
        "scope": session.get("scope", []),
        "currentDocId": session.get("currentDocId"),
        "compressedSummary": session.get("compressedSummary"),
        "archivedCount": len(session.get("archived", [])),
        "attachments": session.get("attachments", []),
        "tokensUsed": session.get("tokensUsed", {"prompt": 0, "completion": 0, "total": 0}),
        "pending": pending,
    }


@router.get("/ai/status")
def ai_status():
    settings = settings_service.get_settings()
    active = providers.get_active_provider(settings)
    if active:
        cfg = (settings.get("ai") or {}).get(active) or {}
        cls = providers.PROVIDERS.get(active)
        return {
            "enabled": True,
            "provider": active,
            "providerLabel": providers.PROVIDER_LABELS.get(active, active),
            "model": cfg.get("model") or (cls.default_model if cls else ""),
            "baseUrl": cfg.get("baseUrl") or (cls.default_base_url if cls else ""),
            "configured": providers.configured_providers(settings),
        }
    return {
        "enabled": False,
        "provider": None,
        "providerLabel": None,
        "model": "",
        "baseUrl": "",
        "configured": [],
    }


@router.post("/ai/test")
def ai_test():
    try:
        client = providers.get_client(settings_service.get_settings())
        content = client.chat(
            [{"role": "user", "content": "Reply with exactly: ok"}],
            temperature=0,
        ).get("content") or ""
        return {"ok": True, "model": client.model, "reply": content.strip()[:50]}
    except providers.AIError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.get("/projects/{project_id}/ai/sessions")
def list_sessions(project_id: str):
    try:
        return sessions.list_sessions(project_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/projects/{project_id}/ai/sessions", status_code=201)
def create_session(project_id: str):
    try:
        return _public_session(sessions.create(project_id))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.get("/projects/{project_id}/ai/sessions/{session_id}")
def get_session(project_id: str, session_id: str):
    return _public_session(_session_or_404(project_id, session_id))


@router.patch("/projects/{project_id}/ai/sessions/{session_id}")
def rename_session(project_id: str, session_id: str, payload: SessionRename):
    session = sessions.rename(project_id, session_id, payload.title)
    if session is None:
        raise HTTPException(status_code=404, detail="Session not found")
    return _public_session(session)


@router.delete("/projects/{project_id}/ai/sessions/{session_id}")
def delete_session(project_id: str, session_id: str):
    if not sessions.delete(project_id, session_id):
        raise HTTPException(status_code=404, detail="Session not found")
    return {"ok": True}


@router.post("/projects/{project_id}/ai/sessions/{session_id}/attachments", status_code=201)
def upload_attachment(project_id: str, session_id: str, file: UploadFile = File(...)):
    session = _session_or_404(project_id, session_id)
    raw = b""
    while True:
        chunk = file.file.read(1024 * 1024)
        if not chunk:
            break
        raw += chunk
        if len(raw) > attachments.MAX_FILE_BYTES:
            raise HTTPException(status_code=413, detail="File exceeds the 25 MB limit")
    try:
        item = attachments.add(project_id, session_id, file.filename or "", raw)
    except attachments.AttachmentError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    session["attachments"] = attachments.list_attachments(project_id, session_id)
    sessions.save(project_id, session)
    return {"session": _public_session(session), "attachment": item}


@router.delete("/projects/{project_id}/ai/sessions/{session_id}/attachments/{attachment_id}")
def delete_attachment(project_id: str, session_id: str, attachment_id: str):
    session = _session_or_404(project_id, session_id)
    if not attachments.remove(project_id, session_id, attachment_id):
        raise HTTPException(status_code=404, detail="Attachment not found")
    session["attachments"] = attachments.list_attachments(project_id, session_id)
    sessions.save(project_id, session)
    return {"session": _public_session(session)}


@router.post("/projects/{project_id}/ai/sessions/{session_id}/compress")
def compress_session(project_id: str, session_id: str, payload: CompressPayload):
    session = _session_or_404(project_id, session_id)
    try:
        session = agent.compress(project_id, session, payload.keepMessages or 8)
    except (providers.AIError, agent.AgentError) as exc:
        raise HTTPException(status_code=409 if isinstance(exc, agent.AgentError) else 400, detail=str(exc)) from exc
    return _public_session(session)


@router.post("/projects/{project_id}/ai/chat")
def chat(project_id: str, payload: ChatPayload):
    message = payload.message.strip()
    if not message:
        raise HTTPException(status_code=400, detail="A message is required")
    if payload.sessionId:
        session = _session_or_404(project_id, payload.sessionId)
        agent_state = session.get("agentState") or {}
        if agent_state.get("pending"):
            raise HTTPException(
                status_code=409,
                detail="There is a pending confirmation for this session — decide it first.",
            )
    else:
        session = sessions.create(project_id)
    session["scope"] = payload.folders if payload.folders is not None else session.get("scope", [])
    session["currentDocId"] = payload.currentDocId or session.get("currentDocId")
    try:
        result = agent.chat(project_id, session, message)
    except providers.AIError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {
        "session": _public_session(session),
        "reply": result.get("reply"),
        "done": result["done"],
        "pending": _public_pending(result.get("pending"), result.get("deferred")) if not result["done"] else None,
        "actions": result.get("actions", []),
    }


@router.post("/projects/{project_id}/ai/chat/stream")
async def chat_stream(project_id: str, payload: ChatPayload):
    message = payload.message.strip()
    if not message:
        raise HTTPException(status_code=400, detail="A message is required")
    if payload.sessionId:
        session = _session_or_404(project_id, payload.sessionId)
        agent_state = session.get("agentState") or {}
        if agent_state.get("pending"):
            raise HTTPException(
                status_code=409,
                detail="There is a pending confirmation for this session — decide it first.",
            )
    else:
        session = sessions.create(project_id)
    session["scope"] = payload.folders if payload.folders is not None else session.get("scope", [])
    session["currentDocId"] = payload.currentDocId or session.get("currentDocId")

    async def sse():
        try:
            async for event in stream.stream_chat(
                project_id, session, message, build_public=lambda: _public_session(session)
            ):
                yield f"event: {event['type']}\ndata: {json.dumps(event)}\n\n"
        except providers.AIError as exc:
            yield f"event: error\ndata: {json.dumps({'message': str(exc)})}\n\n"
        except Exception as exc:  # noqa: BLE001 — surface any turn failure as an SSE event
            yield f"event: error\ndata: {json.dumps({'message': f'Lain failed: {exc}'})}\n\n"

    return StreamingResponse(
        sse(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.post("/projects/{project_id}/ai/confirm")
def confirm(project_id: str, payload: ConfirmPayload):
    if payload.decision not in ("confirm", "cancel", "confirm_all"):
        raise HTTPException(
            status_code=400, detail="decision must be 'confirm', 'cancel' or 'confirm_all'"
        )
    session = _session_or_404(project_id, payload.sessionId)
    try:
        result = agent.confirm(project_id, session, payload.decision)
    except (providers.AIError, agent.AgentError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {
        "session": _public_session(session),
        "reply": result.get("reply"),
        "done": result["done"],
        "pending": _public_pending(result.get("pending"), result.get("deferred")) if not result["done"] else None,
        "actions": result.get("actions", []),
    }
