"""今日页建议：一条纯规则的「下一步」，现在只报后台故障。

Facts come from health.self_check (the same source SelfCheckLine reads, so the
suggestion and the self-check line can never disagree about the backend being
down). No model call anywhere: the suggestion must render even when the default
model is broken — that is the entire point.

卡片队列与习惯的事实按 PLAN.md 第 3 节封存，不再取 —— 顺带省掉了每次打开都跑一遍
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

    return today_core.next_suggestion(
        {
            "default_model_broken": bool(check.get("default_model_broken")),
            "jobs_failing": len(check.get("jobs_failing") or []),
        }
    )
