"""Backup & restore: create/list/download/delete local archives.

Restore is deliberately manual — the API never writes into vault/ or data/.
"""
import asyncio

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse

from app.core import backup

router = APIRouter(prefix="/api/backup", tags=["backup"])


@router.get("")
async def list_backups():
    return await asyncio.to_thread(backup.list_backups)


@router.post("/run")
async def run_backup():
    try:
        return await asyncio.to_thread(backup.create_backup, "manual")
    except OSError as e:
        raise HTTPException(500, f"备份失败: {e}") from e


@router.get("/download/{name}")
async def download_backup(name: str):
    try:
        p = await asyncio.to_thread(backup.resolve, name)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    except FileNotFoundError as e:
        raise HTTPException(404, "备份不存在") from e
    return FileResponse(p, media_type="application/zip", filename=p.name)


@router.delete("/{name}")
async def delete_backup(name: str):
    try:
        await asyncio.to_thread(backup.delete_backup, name)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    except FileNotFoundError as e:
        raise HTTPException(404, "备份不存在") from e
    return {"ok": True}
