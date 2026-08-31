"""Local-folder indexing endpoints (ROADMAP V5.3)."""
import asyncio

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.core import dirs

router = APIRouter(prefix="/api/dirs", tags=["dirs"])


class DirIn(BaseModel):
    name: str
    path: str


class DirToggle(BaseModel):
    enabled: bool


@router.get("")
async def list_dirs():
    return {
        "dirs": dirs.list_dirs(),
        "max_files": dirs.MAX_FILES,
        "max_file_bytes": dirs.MAX_FILE_BYTES,
        "watcher": dirs.watcher.status,
    }


@router.post("")
async def add_dir(body: DirIn):
    try:
        # walking + embedding a fresh folder is CPU-bound; keep the loop free
        return await asyncio.to_thread(dirs.add, body.name.strip(), body.path.strip())
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    except Exception as e:  # noqa: BLE001 - fs/embedding failures
        raise HTTPException(502, f"{type(e).__name__}: {e}") from e


@router.post("/{name}/sync")
async def sync_dir(name: str):
    try:
        return await asyncio.to_thread(dirs.sync, name)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"{type(e).__name__}: {e}") from e


@router.put("/{name}")
async def toggle_dir(name: str, body: DirToggle):
    try:
        return await asyncio.to_thread(dirs.set_enabled, name, body.enabled)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"{type(e).__name__}: {e}") from e


@router.delete("/{name}")
async def delete_dir(name: str):
    try:
        return await asyncio.to_thread(dirs.remove, name)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
