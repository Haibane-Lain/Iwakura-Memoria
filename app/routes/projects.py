"""Projects API."""
from __future__ import annotations

from fastapi import APIRouter, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel

from app.services import projects as projects_service

router = APIRouter(prefix="/api/projects", tags=["projects"])


class ProjectCreate(BaseModel):
    name: str


class ProjectPatch(BaseModel):
    title: str | None = None


class GoalPatch(BaseModel):
    wordsPerDay: int
    enabled: bool


@router.get("")
def list_projects():
    return projects_service.list_projects()


@router.post("", status_code=201)
def create_project(payload: ProjectCreate):
    try:
        return projects_service.create_project(payload.name)
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc))


@router.get("/{project_id}")
def get_project(project_id: str):
    try:
        return projects_service.get_project(project_id)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc))


@router.patch("/{project_id}")
def patch_project(project_id: str, payload: ProjectPatch):
    try:
        if payload.title is not None:
            return projects_service.rename_project(project_id, payload.title)
        return projects_service.get_project(project_id)
    except (FileNotFoundError, ValueError) as exc:
        raise HTTPException(status_code=404, detail=str(exc))


@router.delete("/{project_id}")
def delete_project(project_id: str):
    try:
        projects_service.delete_project(project_id)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    return {"ok": True}


@router.get("/{project_id}/tree")
def get_tree(project_id: str, scope: str = "write"):
    try:
        return projects_service.get_document_tree(project_id, scope)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc))


@router.put("/{project_id}/goal")
def put_goal(project_id: str, payload: GoalPatch):
    try:
        return projects_service.set_goal(project_id, payload.wordsPerDay, payload.enabled)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc))


@router.get("/{project_id}/export")
def export_project(project_id: str):
    try:
        data = projects_service.export_zip(project_id)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    filename = f"{project_id}-writing.zip"
    return Response(
        data,
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
