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
    # 状态机（方案 §8.4）：open / done。**「停滞」不在这里**——它是算出来的。
    status: str | None = None
    # 截止日 `YYYY-MM-DD`；空串 = 清掉。`None` 表示「这次不改它」——
    # 所以「清掉」不能用 None 表达，那是 `clear_deadline` 的活。
    deadline: str | None = None
    clear_deadline: bool = False


class ItemRef(BaseModel):
    kind: str
    ref: str


class DeliverIn(BaseModel):
    genre: str = "briefing"
    audience: str = "self"


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
    """收件箱：还没挂到任何事、也没被忽略过的条目。"""
    return await core.unclassified(limit)


@router.post("/inbox/ignore")
async def ignore(body: ItemRef):
    """从收件箱里划掉一条（§8.4）。幂等。**东西一件都不动**——只是不再出现在收件箱里。"""
    try:
        return await core.ignore(body.kind, body.ref)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e


@router.delete("/inbox/ignore")
async def unignore(kind: str, ref: str):
    """撤销忽略——它回到收件箱里。找不到也算成功（幂等）。"""
    return await core.unignore(kind, ref)


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
            thread_id,
            name=body.name,
            note=body.note,
            archived=body.archived,
            status=body.status,
            deadline=body.deadline,
            clear_deadline=body.clear_deadline,
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


@router.post("/{thread_id}/deliver")
async def deliver_into(thread_id: int, body: DeliverIn):
    """就这件事写一份交付（§4-16）。**这一路的模型用量记在这件事头上。**

    **占 `inflight` 锁**（2026-09-26 补）：这是一次完整交付（取材 + 成文），分钟级、花钱、
    还会落一份文件。原来没占——两个标签页同时点就是两份产出、两笔账，而挂到这件事上的
    只会是后写的那份。与 `routers/deliver.py` 共用 `deliver` 这个 key：那一页正在写的时候
    这里如实回 409，而不是各写各的。

    **停止走的是请求取消**：客户端断开 → Starlette 取消这个请求 → 取消沿 await 链传到
    `llm.stream_chat`，那里有 `finally` 显式关上游流（`core/llm.py`）。所以界面上的
    「停止」在这条路上是真的停，不是「不等了」。
    """
    from app.core import inflight

    if not inflight.try_acquire("deliver"):
        raise HTTPException(
            409,
            "已经有一份正在写（可能是报告页那一次）——等它写完再点。"
            "并发两次 = 两份产出、两笔账，而挂到这件事上的只会是后写的那份。",
        )
    try:
        return await core.deliver_into(thread_id, body.genre, body.audience)
    except LookupError as e:
        raise HTTPException(404, str(e)) from e
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    finally:
        inflight.release("deliver")
