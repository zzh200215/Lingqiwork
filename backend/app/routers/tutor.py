"""对话式教学 HTTP layer. Every rule lives in `app/core/tutor.py`.

Its own router rather than a branch inside `chat.py`: this step needs none of
chat's RAG / tools / compare / image machinery, and the tutor
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
    repo: str = ""  # 代码库陪读：非空则取材限定在该仓库
    mode: str = "socratic"  # socratic（老师问你答）| feynman（你讲它追问）
    origin_point_id: int | None = None  # 从「材料拆出的点」开场时带上，标记它已教


class SayIn(BaseModel):
    session_id: int
    text: str


class EndIn(BaseModel):
    session_id: int
    verdict: str  # got | half | useless


class DigestIn(BaseModel):
    source_path: str = ""  # vault 相对路径，或 `repo:` / `dir:` 规格
    text: str = ""  # 直接粘一段文字（与 source_path 二选一）


def _sse(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


@router.post("/start")
async def start(body: StartIn):
    """Open a session. Reports `model_ok` so a dead model is visible up front
    instead of on the first reply."""
    try:
        return await core.start(
            body.topic, repo=body.repo, mode=body.mode, origin_point_id=body.origin_point_id
        )
    except ValueError as e:
        raise HTTPException(400, str(e)) from e


@router.post("/digest")
async def digest(body: DigestIn):
    """一份材料 → 「要搞懂的点」。逐点去搞懂走 `/start`（话题就是那个点）。

    拆不出来时**不报错**：`points: []` + 一句人话的 `error`，材料本身还在。
    """
    try:
        return await core.digest(source_path=body.source_path, text=body.text)
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
    """全量卡点：不受右栏会话列表 50 条的显示上限约束。带 `resolved_at`。"""
    return {"stuck": await core.stuck_points(limit)}


class ResolveStuckIn(BaseModel):
    resolved: bool = True


@router.post("/stuck/{session_id}/resolve")
async def resolve_stuck(session_id: int, body: ResolveStuckIn):
    """手动把一条卡点标成已解 / 待解。主要出口是自动回写（同一概念后来说通了）。"""
    try:
        return await core.resolve_stuck(session_id, body.resolved)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e


@router.get("/concepts")
async def list_concepts():
    """按概念分组的学习轨迹（「我学到哪了」）：纯派生，无新表。"""
    return {"concepts": await core.concepts()}


@router.get("/map")
async def get_map():
    """学习地图：已掌握 / 在学 / 卡住 / 未触及 四档，纯派生（未触及读的是
    `digest_points` 建议日志）。"""
    return await core.learning_map()


@router.get("/mastery")
async def get_mastery():
    """成长事件：概念「学会了」的时刻（A3）。规则与学习地图「已掌握」同一条——
    纯派生，是零柒成长模型的原料。"""
    return await core.mastery_events()


@router.get("/starters")
async def get_starters():
    """开场建议：半懂概念 + 日记疑问句，纯派生（[] = 没有什么可建议的）。"""
    return {"starters": await core.starters()}


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
