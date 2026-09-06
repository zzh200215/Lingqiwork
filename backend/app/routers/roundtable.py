"""学习小组圆桌端点：一个卡点（或自定话题）→ 三 persona 笔谈纪要 → 可做播客。

拉取式：你点「开圆桌」它才跑一次 LLM（第 2 节）。没有可用 provider 返回 503
说人话；topic 缺席时回落到最近的卡点，连卡点都没有就 422 指路。
"""
import logging
from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from app.core import roundtable

log = logging.getLogger(__name__)

router = APIRouter(prefix="/api/roundtable", tags=["roundtable"])


class RoundtableIn(BaseModel):
    topic: str = Field(default="", max_length=200)
    days: int = Field(default=90, ge=1, le=365)


class PodcastIn(BaseModel):
    file: str = Field(min_length=1)


@router.post("")
async def start_roundtable(body: RoundtableIn):
    from app.core import tutor as tutor_core

    topic = body.topic.strip()
    context = ""
    if not topic:
        blocks = await tutor_core.stuck_blocks(days=body.days, cap=1)
        if not blocks:
            raise HTTPException(422, "没有可讨论的卡点：给个 topic，或先在教学里攒一个卡点")
        title, context = blocks[0]
        topic = title.removeprefix("卡点：")
    try:
        return await roundtable.run(topic, context)
    except RuntimeError as e:  # 没有可用 provider / 一句发言都没产生
        raise HTTPException(503, str(e)) from e
    except ValueError as e:
        raise HTTPException(422, str(e)) from e
    except Exception as e:  # noqa: BLE001 - LLM/IO failure
        log.exception("roundtable failed")
        raise HTTPException(502, f"{type(e).__name__}: {e}") from e


@router.get("")
async def list_roundtables():
    return {"items": roundtable.recent()}


@router.post("/podcast")
async def roundtable_podcast(body: PodcastIn):
    """把一份圆桌纪要变成播客：复用卡点播客的整条管线。"""
    path = Path(body.file)
    if not path.is_file():
        raise HTTPException(404, "纪要文件不存在")
    try:
        topic, turns = roundtable.parse_file(path)
    except OSError as e:
        raise HTTPException(400, f"读不了纪要：{e}") from e
    if not turns:
        raise HTTPException(422, "纪要里没有可朗读的发言")
    blocks = [(f"圆桌·{t['name']}", t["text"]) for t in turns]
    from datetime import datetime as _dt

    from app.core import podcast

    title = f"圆桌讨论 · {topic or _dt.now().strftime('%Y-%m-%d')}"
    try:
        result = await podcast.generate_from_blocks(blocks, title=title)
    except Exception as e:  # noqa: BLE001 - LLM/TTS/IO failures
        raise HTTPException(502, f"{type(e).__name__}: {e}") from e
    if not result.get("ok"):
        raise HTTPException(400, result.get("error") or "生成失败")
    return result
