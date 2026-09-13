"""Long-running Lain job routes: create, list, run (SSE), pause, apply, delete."""
from __future__ import annotations

import json
from typing import Any

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from app.ai import jobs, sessions, stream
from app.routes.ai import _public_session

router = APIRouter(prefix="/api", tags=["ai-jobs"])


class JobCreatePayload(BaseModel):
    kind: str
    folders: list[str] | None = None
    entries: list[str] | None = None
    instruction: str = ""
    options: dict[str, Any] | None = None


def _session_or_404(project_id: str, session_id: str) -> dict[str, Any]:
    session = sessions.load(project_id, session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="Session not found")
    return session


def _job_or_404(project_id: str, session_id: str, job_id: str) -> dict[str, Any]:
    job = jobs.load_job(project_id, session_id, job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Job not found")
    return job


def _guard_not_pending(session: dict[str, Any]) -> None:
    agent_state = session.get("agentState") or {}
    if agent_state.get("pending"):
        raise HTTPException(
            status_code=409,
            detail="There is a pending confirmation for this session — decide it first.",
        )


@router.post("/projects/{project_id}/ai/sessions/{session_id}/jobs", status_code=201)
def create_job(project_id: str, session_id: str, payload: JobCreatePayload):
    session = _session_or_404(project_id, session_id)
    _guard_not_pending(session)
    try:
        job = jobs.create_job(
            project_id,
            session,
            payload.kind,
            folders=payload.folders,
            entries=payload.entries,
            instruction=payload.instruction,
            options=payload.options,
        )
    except jobs.JobError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return jobs.public_job(job)


@router.get("/projects/{project_id}/ai/sessions/{session_id}/jobs")
def list_jobs(project_id: str, session_id: str):
    _session_or_404(project_id, session_id)
    return [jobs.public_job(job) for job in jobs.list_jobs(project_id, session_id)]


@router.get("/projects/{project_id}/ai/sessions/{session_id}/jobs/{job_id}")
def get_job(project_id: str, session_id: str, job_id: str):
    _session_or_404(project_id, session_id)
    return jobs.public_job(_job_or_404(project_id, session_id, job_id))


@router.delete("/projects/{project_id}/ai/sessions/{session_id}/jobs/{job_id}")
def delete_job(project_id: str, session_id: str, job_id: str):
    _session_or_404(project_id, session_id)
    if not jobs.delete_job(project_id, session_id, job_id):
        raise HTTPException(status_code=404, detail="Job not found")
    return {"ok": True}


@router.post("/projects/{project_id}/ai/sessions/{session_id}/jobs/{job_id}/apply")
def apply_job(project_id: str, session_id: str, job_id: str):
    session = _session_or_404(project_id, session_id)
    _guard_not_pending(session)
    job = _job_or_404(project_id, session_id, job_id)
    try:
        result = jobs.apply_job(project_id, session, job)
    except jobs.JobError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return {
        "session": _public_session(session),
        "job": result["job"],
        "pending": result["pending"],
        "actions": [result["action"]] if result["action"] else [],
    }


@router.post("/projects/{project_id}/ai/sessions/{session_id}/jobs/{job_id}/pause")
def pause_job(project_id: str, session_id: str, job_id: str):
    _session_or_404(project_id, session_id)
    job = _job_or_404(project_id, session_id, job_id)
    if stream.cancel_run(session_id):
        return {"ok": True, "job": jobs.public_job(job)}
    # Not currently running (or the run guard was lost on restart).
    if job.get("status") == "running":
        job["status"] = "paused"
        jobs.save_job(project_id, session_id, job)
    return {"ok": True, "job": jobs.public_job(job)}


@router.post("/projects/{project_id}/ai/sessions/{session_id}/jobs/{job_id}/stream")
async def stream_job(project_id: str, session_id: str, job_id: str):
    session = _session_or_404(project_id, session_id)
    _guard_not_pending(session)
    job = _job_or_404(project_id, session_id, job_id)
    if (job.get("reduce") or {}).get("status") == "done" and (job.get("output") or {}).get(
        "status"
    ) != "pending_access":
        raise HTTPException(status_code=409, detail="This job has already finished.")
    cancelled = stream.begin_run(session_id)
    if cancelled is None:
        raise HTTPException(
            status_code=409,
            detail="Lain is already working on this session — wait for the current run to finish.",
        )

    async def sse():
        try:
            async for event in stream.stream_job(
                project_id,
                session,
                job,
                build_public=lambda: _public_session(session),
                cancelled=cancelled,
            ):
                yield f"event: {event['type']}\ndata: {json.dumps(event)}\n\n"
        except Exception as exc:  # noqa: BLE001 — surface any job failure as an SSE event
            yield f"event: error\ndata: {json.dumps({'message': f'Job failed: {exc}'})}\n\n"
        finally:
            stream.end_run(session_id, cancelled)

    return StreamingResponse(
        sse(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
