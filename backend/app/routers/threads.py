"""「一件事」的 HTTP layer. Every rule lives in `app/core/threads.py`.

注意顺序：`/unclassified` 与 `/suggest` 必须**排在 `/{thread_id}` 前面**，否则后者会先
匹配上、拿 "unclassified" 去转 int 然后 422。
"""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.core import threads as core

router = APIRouter(prefix="/api/threads", tags=["threads"])


class ThreadIn(BaseModel):
    name: str
    note: str = ""


class ThreadPatch(BaseModel):
    """局部更新——全部可选。"""

    name: str | None = None
    note: str | None = None
    archived: bool | None = None


class ItemRef(BaseModel):
    kind: str
    ref: str


@router.get("")
async def list_threads(include_archived: bool = False):
    return await core.list_threads(include_archived)


@router.post("")
async def create(body: ThreadIn):
    try:
        return await core.create(body.name, body.note)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e


@router.get("/unclassified")
async def unclassified(limit: int = 60):
    """还没挂到任何事的条目。允许长期存在——不催。"""
    return await core.unclassified(limit)


@router.get("/suggest")
async def suggest(kind: str, ref: str):
    """这个条目该挂到哪件事上（按它自己的标签派生）。"""
    return await core.suggest_for_item(kind, ref)


@router.get("/{thread_id}")
async def detail(thread_id: int):
    try:
        return await core.detail(thread_id)
    except LookupError as e:
        raise HTTPException(404, str(e)) from e


@router.put("/{thread_id}")
async def update(thread_id: int, body: ThreadPatch):
    try:
        return await core.update(
            thread_id, name=body.name, note=body.note, archived=body.archived
        )
    except LookupError as e:
        raise HTTPException(404, str(e)) from e
    except ValueError as e:
        raise HTTPException(400, str(e)) from e


@router.delete("/{thread_id}")
async def delete(thread_id: int):
    try:
        return await core.delete(thread_id)
    except LookupError as e:
        raise HTTPException(404, str(e)) from e


@router.post("/{thread_id}/items")
async def attach(thread_id: int, body: ItemRef):
    try:
        return await core.attach(thread_id, body.kind, body.ref)
    except LookupError as e:
        raise HTTPException(404, str(e)) from e
    except ValueError as e:
        raise HTTPException(400, str(e)) from e


@router.delete("/{thread_id}/items")
async def detach(thread_id: int, kind: str, ref: str):
    return await core.detach(thread_id, kind, ref)
