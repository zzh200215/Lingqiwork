"""语音日记端点：转写文本 → vault/journal 按天落盘 + best-effort automemory。

前端聊天页已有完整的麦克风→/api/asr/transcribe 链路；这里只收转写好的
文本，保持单一职责。长期记忆提取复用聊天/任务同一套开关与 `auto_extract`
（automemory_enabled，默认关），在后台跑——写日记的响应不该等一次 LLM。
"""
import asyncio
import logging

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from app.core import journal
from app.core.prefs import load_config

log = logging.getLogger(__name__)

router = APIRouter(prefix="/api/journal", tags=["journal"])

_bg: set[asyncio.Task] = set()  # 持引用防 GC；done 后自清


class JournalIn(BaseModel):
    text: str = Field(min_length=1, max_length=20000)


async def _remember(text: str) -> None:
    """语音日记里往往有持久信息（在学什么、习惯），让模型自己挑。best-effort。"""
    if not load_config().get("automemory_enabled"):
        return
    try:
        from app.core import memory
        from app.core.tasks import _resolve

        provider, model = await _resolve("")
        info = memory.ProviderInfo(kind=provider.kind, base_url=provider.base_url, api_key=provider.api_key)
        facts = await asyncio.wait_for(
            memory.auto_extract(info, model, f"用户刚录了一条语音日记：{text}", ""),
            timeout=60,
        )
        if facts:
            log.info("journal remembered %d fact(s)", len(facts))
    except Exception:  # noqa: BLE001 - 记不住就算了，日记本身已落盘
        log.warning("journal automemory failed", exc_info=True)


@router.post("")
async def add_entry(payload: JournalIn):
    text = payload.text.strip()
    if not text:
        raise HTTPException(422, "日记内容为空")
    entry = journal.append(text)
    task = asyncio.create_task(_remember(text))
    _bg.add(task)
    task.add_done_callback(_bg.discard)
    return entry


@router.get("/recent")
async def recent_entries():
    return {"entries": journal.recent(), "today": journal.today_count()}
