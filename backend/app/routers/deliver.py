"""交付（把材料改写成能交出去的体裁）HTTP layer. Every rule lives in `app/core/deliver.py`.

照 `routers/compose.py` 的形态：`/deliver` 是 SSE（gathering → sources → writing →
report），`/deliver/save` 落 `vault/deliver/` + 进索引，另加一个只读的 `/deliver/genres`
把体裁与读者的定义交给界面（前端不硬编码）。校验必须在建流之前做完——SSE 一旦开流就没有
状态码可改了（`routers/tutor.py` 顶部记过这个坑）。
"""

import json
import logging

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from app.core import deliver as core
from app.core import inflight
from app.core.deliver import Report, Section

router = APIRouter(prefix="/api/deliver", tags=["deliver"])
log = logging.getLogger(__name__)


class DeliverIn(BaseModel):
    topic: str
    genre: str = core.DEFAULT_GENRE
    audience: str = core.AUDIENCE_DEFAULT


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


@router.get("/genres")
async def genres():
    """体裁与读者（含界面文案）——唯一真值在 `core.deliver`。"""
    return core.catalogue()


@router.post("")
async def deliver_run(body: DeliverIn):
    """One deliverable run, streamed. 校验在建流前：话题非空 + 体裁/读者合法 + 有默认模型。"""
    topic = (body.topic or "").strip()
    if not topic:
        raise HTTPException(400, "话题不能为空")
    try:
        core.synth_prompt(body.genre, body.audience)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e

    from app.core import providers

    if not (providers.default_model_id() or ""):
        raise HTTPException(503, "没有已启用的 provider，请先在设置页配置模型")

    if not inflight.try_acquire("deliver"):
        raise HTTPException(409, "上一次交付还在跑——等它结束再开新的")

    async def gen():
        try:
            async for event, data in core.run(body.genre, topic, body.audience):
                yield _sse(event, data)
        except Exception as e:  # noqa: BLE001 - mid-stream, so report as an event
            log.exception("deliver failed")
            yield _sse("error", {"message": f"{type(e).__name__}: {e}"})
        finally:
            inflight.release("deliver")

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.post("/save")
async def save(body: SaveIn):
    """把上一次的交付落成 `vault/deliver/` 里的一篇 md 并进索引。"""
    rep = Report(title=body.title.strip(), sections=body.sections, used=body.used)
    if not rep.title and not rep.sections:
        raise HTTPException(422, "没有可保存的交付结果")
    return await core.save(rep, [s.model_dump() for s in body.sources])
