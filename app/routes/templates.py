"""Lore templates API."""
from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.services import templates as templates_service

router = APIRouter(prefix="/api/projects", tags=["templates"])


class TemplateCreate(BaseModel):
    name: str
    sections: list[str] = []


class TemplateUpdate(BaseModel):
    name: str | None = None
    sections: list[str] | None = None


def _error(exc: Exception) -> HTTPException:
    status = 404 if isinstance(exc, FileNotFoundError) else 400
    return HTTPException(status_code=status, detail=str(exc))


@router.get("/{project_id}/templates")
def get_templates(project_id: str):
    try:
        return templates_service.list_templates(project_id)
    except FileNotFoundError as exc:
        raise _error(exc) from exc


@router.post("/{project_id}/templates", status_code=201)
def post_template(project_id: str, payload: TemplateCreate):
    try:
        return templates_service.create_template(
            project_id, payload.name, payload.sections
        )
    except (FileNotFoundError, ValueError) as exc:
        raise _error(exc) from exc


@router.put("/{project_id}/templates/{template_id}")
def put_template(project_id: str, template_id: str, payload: TemplateUpdate):
    try:
        return templates_service.update_template(
            project_id, template_id, payload.name, payload.sections
        )
    except (FileNotFoundError, ValueError) as exc:
        raise _error(exc) from exc


@router.delete("/{project_id}/templates/{template_id}")
def delete_template(project_id: str, template_id: str):
    try:
        templates_service.delete_template(project_id, template_id)
    except FileNotFoundError as exc:
        raise _error(exc) from exc
    return {"ok": True}
