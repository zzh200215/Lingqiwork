"""决策日志 + 校准分 HTTP layer. Every rule lives in `app/core/decision_log.py`.

`GET /api/decisions` 给全部条目 + 校准分；`POST` 记一条判断；`PUT /{id}/review` 记应验
结果；`DELETE /{id}` 删一条。`GET /witness` 是**唯一一处主动开口**（到点的那条判断，
宠物气泡的第 5 个来源）——它是拉取式规矩唯一一次让开，理由写在核心模块开篇，
这里只是把它挂出去。
"""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.core import decision_log as core

router = APIRouter(prefix="/api/decisions", tags=["decisions"])


class DecisionIn(BaseModel):
    text: str
    basis: str = ""
    topic: str = ""
    confidence: int = 70
    # 多久之后值得回头看一眼（天）。默认 90——见 `core/decision_log.WITNESS_DAYS`
    witness_days: int = core.WITNESS_DAYS


class ReviewIn(BaseModel):
    outcome: str  # hit | miss | unclear | ""（撤销回看）
    note: str = ""


@router.get("")
async def list_decisions():
    return await core.list_decisions()


@router.post("")
async def add_decision(body: DecisionIn):
    try:
        return await core.add(body.text, body.basis, body.topic, body.confidence, body.witness_days)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e


@router.get("/witness")
async def decision_witness():
    """到点的那条判断（**只回一条** + 还在等的条数）。

    刻意不给「全部到点」的列表：那会变成一张待办清单，而这个仓库封存过那套机制。
    只给一条，念不念、什么时候念，是前端那条 nudge 管线的事（一天一条、可关）。
    """
    return await core.witness()


@router.put("/{decision_id}/review")
async def review_decision(decision_id: int, body: ReviewIn):
    try:
        return await core.review(decision_id, body.outcome, body.note)
    except LookupError as e:
        raise HTTPException(404, str(e)) from e
    except ValueError as e:
        raise HTTPException(400, str(e)) from e


@router.delete("/{decision_id}")
async def delete_decision(decision_id: int):
    try:
        await core.remove(decision_id)
    except LookupError as e:
        raise HTTPException(404, str(e)) from e
    return {"ok": True}
