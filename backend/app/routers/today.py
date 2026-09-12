"""今日页建议：一条纯规则的「下一步」，现在只报后台故障。

Facts come from health.self_check (the same source SelfCheckLine reads, so the
suggestion and the self-check line can never disagree about the backend being
down). No model call anywhere: the suggestion must render even when the default
model is broken — that is the entire point.

卡片队列与习惯的事实已封存，不再取 —— 顺带省掉了每次打开都跑一遍
`cards.queue()` + `cards.stats()` + `habits.today_view()`。
"""
import logging

from fastapi import APIRouter

# pure rules, zero deps — imported at module level on purpose: the fallback path
# below needs it, and a degradation that itself raises NameError is exactly the
# failure this endpoint exists to survive
from app.core import today as today_core

router = APIRouter(prefix="/api/today", tags=["today"])
log = logging.getLogger(__name__)


@router.get("/next")
async def today_next():
    """One line + one action. Best-effort, degrades to idle."""
    try:
        from app.routers.health import self_check

        check = await self_check()
    except Exception:  # noqa: BLE001 - a suggestion that 500s is worse than none
        log.exception("today_next fact assembly failed")
        return today_core.next_suggestion({})

    # 「一件事」那一档（§4-17）：只读一张表、不碰模型，所以模型挂了它也照样出得来
    threads: list[dict] = []
    try:
        from app.core import threads as threads_core

        threads = await threads_core.recent()
    except Exception:  # noqa: BLE001 - 缺这一档不该拖垮整条建议
        log.warning("today_next thread lookup failed", exc_info=True)

    return today_core.next_suggestion(
        {
            "default_model_broken": bool(check.get("default_model_broken")),
            "jobs_failing": len(check.get("jobs_failing") or []),
            "threads": threads,
        }
    )
