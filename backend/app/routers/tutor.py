"""对话式教学 HTTP layer. Every rule lives in `app/core/tutor.py`.

Its own router rather than a branch inside `chat.py`: this step needs none of
chat's RAG / tools / compare / image machinery, and PLAN.md 第 5 节 says the tutor
must be removable in one piece — deleting one router file and two tables should
be the whole job.

`/say` validates what it can BEFORE the stream opens; once an SSE response has
started there is no way to set a status code (same lesson as
smoke_podcast_stream.py).
"""
import json
import logging

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from app.core import tutor as core

router = APIRouter(prefix="/api/tutor", tags=["tutor"])
log = logging.getLogger(__name__)


class StartIn(BaseModel):
    topic: str


class SayIn(BaseModel):
    session_id: int
    text: str


class EndIn(BaseModel):
    session_id: int
    verdict: str  # got | half | useless


def _sse(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


@router.post("/start")
async def start(body: StartIn):
    """Open a session. Reports `model_ok` so a dead model is visible up front
    instead of on the first reply (PLAN.md 第 9 节)."""
    try:
        return await core.start(body.topic)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e


@router.post("/say")
async def say(body: SayIn):
    """One exchange, streamed: recall → deltas → done."""
    if not body.text.strip():
        raise HTTPException(400, "说点什么")

    async def gen():
        try:
            async for event, data in core.say(body.session_id, body.text):
                yield _sse(event, data)
        except Exception as e:  # noqa: BLE001 - mid-stream, so report as an event
            log.exception("tutor say failed")
            yield _sse("error", {"message": f"{type(e).__name__}: {e}"})

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.post("/end")
async def end(body: EndIn):
    """Record 懂了 / 半懂 / 没用, then extract 概念 + 卡点."""
    try:
        return await core.end(body.session_id, body.verdict)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e


@router.get("/sessions")
async def list_sessions(limit: int = 50):
    return {"sessions": await core.sessions(limit)}


@router.get("/stuck")
async def list_stuck(limit: int = 200):
    """全量卡点：不受右栏会话列表 50 条的显示上限约束。"""
    return {"stuck": await core.stuck_points(limit)}


@router.get("/profile")
async def get_profile():
    """学习画像：按概念聚合的派生结果，设置页只读展示。"""
    from app.core import memory as _memory

    prof = await core.profile()
    mems = await _memory.list_memories()
    return {
        "known": prof["known"],
        "half": prof["half"],
        "preferences": [
            {"kind": m.kind, "content": m.content}
            for m in mems
            if getattr(m, "kind", None) in ("preference", "habit")
        ],
    }


@router.get("/stats")
async def get_stats(days: int = 14):
    return await core.stats(days)


@router.get("/sessions/{session_id}")
async def get_session(session_id: int):
    row = await core.detail(session_id)
    if row is None:
        raise HTTPException(404, f"会话 {session_id} 不存在")
    return row
