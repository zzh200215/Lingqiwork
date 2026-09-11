"""产出（从你自己的材料成文）HTTP layer. Every rule lives in `app/core/compose.py`.

照 `routers/research.py` 的形态：`/compose` 是 SSE（gathering → sources → writing →
report），`/compose/save` 落 `vault/notes/` + 进索引。校验必须在建流之前做完——
SSE 一旦开流就没有状态码可改了（`routers/tutor.py` 顶部记过这个坑）。
"""

import json
import logging

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from app.core import compose as core
from app.core.compose import Report, Section

router = APIRouter(prefix="/api/compose", tags=["compose"])
log = logging.getLogger(__name__)


class ComposeIn(BaseModel):
    topic: str


class SourceRef(BaseModel):
    n: int = 0
    kind: str = "kb"
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
async def compose_run(body: ComposeIn):
    """One produce run, streamed. 校验在建流前：话题非空 + 有默认模型。"""
    topic = (body.topic or "").strip()
    if not topic:
        raise HTTPException(400, "话题不能为空")

    from app.core import providers

    if not (providers.default_model_id() or ""):
        raise HTTPException(503, "没有已启用的 provider，请先在设置页配置模型")

    async def gen():
        try:
            async for event, data in core.run(topic):
                yield _sse(event, data)
        except Exception as e:  # noqa: BLE001 - mid-stream, so report as an event
            log.exception("compose failed")
            yield _sse("error", {"message": f"{type(e).__name__}: {e}"})

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.post("/save")
async def save(body: SaveIn):
    """把上一次的 report 载荷落成 `vault/notes/` 里的一篇 md 并进索引。"""
    rep = Report(title=body.title.strip(), sections=body.sections, used=body.used)
    if not rep.title and not rep.sections:
        raise HTTPException(422, "没有可保存的产出结果")
    return await core.save(rep, [s.model_dump() for s in body.sources])
