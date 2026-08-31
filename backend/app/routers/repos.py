"""Git repository indexing endpoints (ROADMAP V5.1)."""
import asyncio

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.core import repos

router = APIRouter(prefix="/api/repos", tags=["repos"])


class CloneRequest(BaseModel):
    url: str
    name: str | None = None


@router.get("")
async def list_repos():
    return {
        "repos": repos.list_repos(),
        "dir": str(repos.REPOS_DIR),
        "max_files": repos.MAX_FILES,
        "max_file_bytes": repos.MAX_FILE_BYTES,
    }


@router.post("")
async def clone_repo(body: CloneRequest):
    try:
        # clone + embed is CPU/IO heavy; keep the event loop free
        return await asyncio.to_thread(repos.clone, body.url, body.name)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    except Exception as e:  # noqa: BLE001 - git/network failures
        raise HTTPException(502, f"{type(e).__name__}: {e}") from e


@router.post("/{name}/sync")
async def sync_repo(name: str):
    try:
        return await asyncio.to_thread(repos.sync, name)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"{type(e).__name__}: {e}") from e


@router.delete("/{name}")
async def delete_repo(name: str, keep_files: bool = False):
    try:
        return await asyncio.to_thread(repos.remove, name, not keep_files)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
