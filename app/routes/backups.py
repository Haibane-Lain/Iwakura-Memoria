"""Whole-library backups API."""
from __future__ import annotations

from fastapi import APIRouter, HTTPException

from app.services import backup as backup_service

router = APIRouter(prefix="/api/backups", tags=["backups"])


@router.get("")
def list_backups():
    return backup_service.list_backups()


@router.post("", status_code=201)
def create_backup():
    try:
        return backup_service.create_backup()
    except OSError as exc:
        raise HTTPException(status_code=503, detail=f"Backup failed: {exc}") from exc


@router.delete("/{name}")
def delete_backup(name: str):
    try:
        removed = backup_service.delete_backup(name)
    except OSError as exc:
        raise HTTPException(status_code=503, detail=f"Delete failed: {exc}") from exc
    if not removed:
        raise HTTPException(status_code=404, detail="Backup not found")
    return {"ok": True}