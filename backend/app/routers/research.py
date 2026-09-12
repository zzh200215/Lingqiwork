"""研究（学习闭环的中间两跳）HTTP layer. Every rule lives in `app/core/research.py`.

照 `routers/tutor.py` 的形态：`/research` 是 SSE（plan → gathering → sources →
writing → report），`/research/save` 落盘 + 进索引。校验必须在建流之前做完——
SSE 一旦开流就没有状态码可改了（`routers/tutor.py` 顶部记过这个坑）。
"""
import json
import logging

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from app.core import inflight
from app.core import research as core
from app.core.research import ResearchReport, Section

router = APIRouter(prefix="/api/research", tags=["research"])
log = logging.getLogger(__name__)


class ResearchIn(BaseModel):
    topic: str


class SourceRef(BaseModel):
    n: int = 0
    kind: str = "web"
    title: str = ""
    ref: str = ""


class SaveIn(BaseModel):
    title: str = ""
    sections: list[Section] = Field(default_factory=list)
    used: list[int] = Field(default_factory=list)
    sources: list[SourceRef] = Field(default_factory=list)


def _sse(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


@router.post("")
async def research(body: ResearchIn):
    """One research run, streamed. 校验在建流前：话题非空 + 有默认模型。"""
    topic = (body.topic or "").strip()
    if not topic:
        raise HTTPException(400, "话题不能为空")

    from app.core import providers

    if not (providers.default_model_id() or ""):
        raise HTTPException(503, "没有已启用的 provider，请先在设置页配置模型")

    if not inflight.try_acquire("research"):
        raise HTTPException(409, "上一次研究还在跑——等它结束再开新的")

    async def gen():
        try:
            async for event, data in core.run(topic):
                yield _sse(event, data)
        except Exception as e:  # noqa: BLE001 - mid-stream, so report as an event
            log.exception("research failed")
            yield _sse("error", {"message": f"{type(e).__name__}: {e}"})
        finally:
            inflight.release("research")

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.post("/save")
async def save(body: SaveIn):
    """把上一次的 report 载荷落成 `vault/research/` 里的一篇 md 并进索引。"""
    report = ResearchReport(title=body.title.strip(), sections=body.sections, used=body.used)
    if not report.title and not report.sections:
        raise HTTPException(422, "没有可保存的研究结果")
    return await core.save(report, [s.model_dump() for s in body.sources])
