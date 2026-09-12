"""复盘（把散落的记录合成一次「最近」）HTTP layer. Every rule lives in `app/core/recap.py`.

照 `routers/research.py` 的形态：`/recap` 是 SSE（gathering → sources → writing →
report → saved）。校验必须在建流之前做完——SSE 一旦开流就没有状态码可改了
（`routers/tutor.py` 顶部记过这个坑）。

**没有 `/save`**：复盘自成文后就落盘（`core/recap.py::run` 最后发的 `saved` 事件），
它没有「先看再决定存不存」的环节——内容就是你自己的记录。`days` 只在 drill / 测试里
用，页面上没有这个选择（不加设置开关）。
"""

import json
import logging

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from app.core import inflight
from app.core import recap as core

router = APIRouter(prefix="/api/recap", tags=["recap"])
log = logging.getLogger(__name__)


class RecapIn(BaseModel):
    days: int = core.DAYS


def _sse(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


@router.post("")
async def recap_run(body: RecapIn | None = None):
    """One recap run, streamed. 校验在建流前：有默认模型。"""
    from app.core import providers

    if not (providers.default_model_id() or ""):
        raise HTTPException(503, "没有已启用的 provider，请先在设置页配置模型")

    days = max(1, min(int((body.days if body else core.DAYS) or core.DAYS), 365))

    if not inflight.try_acquire("recap"):
        raise HTTPException(409, "上一次复盘还在跑——等它结束再开新的")

    async def gen():
        try:
            async for event, data in core.run(days=days):
                yield _sse(event, data)
        except Exception as e:  # noqa: BLE001 - mid-stream, so report as an event
            log.exception("recap failed")
            yield _sse("error", {"message": f"{type(e).__name__}: {e}"})
        finally:
            inflight.release("recap")

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
