"""决策日志 + 校准分 HTTP layer. Every rule lives in `app/core/decision_log.py`.

`GET /api/decisions` 给全部条目 + 校准分；`POST` 记一条判断；`PUT /{id}/review` 记应验
结果；`DELETE /{id}` 删一条。拉取式——没有任何定时任务或提醒碰这张表。
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


class ReviewIn(BaseModel):
    outcome: str  # hit | miss | unclear | ""（撤销回看）
    note: str = ""


@router.get("")
async def list_decisions():
    return await core.list_decisions()


@router.post("")
async def add_decision(body: DecisionIn):
    try:
        return await core.add(body.text, body.basis, body.topic, body.confidence)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e


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
