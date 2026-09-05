"""今日页建议：一条纯规则的「今天下一步」。(PLAN 第0周)

Facts are assembled from functions that already exist — cards.queue/stats,
habits.today_view, and health.self_check (the same source SelfCheckLine reads,
so the suggestion and the self-check line can never disagree about the backend
being down). No model call anywhere: the suggestion must render even when the
default model is broken — that is the entire point.
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
    """One line + one action for the 今日 page. Best-effort, degrades to idle."""
    try:
        from app.core import habits
        from app.core import cards as card_core
        from app.routers.health import self_check

        q = await card_core.queue()
        st = await card_core.stats()
        habits_view = await habits.today_view()
        check = await self_check()
    except Exception:  # noqa: BLE001 - a suggestion that 500s is worse than none
        log.exception("today_next fact assembly failed")
        return today_core.next_suggestion({})

    facts = {
        "default_model_broken": bool(check.get("default_model_broken")),
        "jobs_failing": len(check.get("jobs_failing") or []),
        "queue_total": len(q.get("due") or []) + len(q.get("fresh") or []),
        "total_cards": int(st.get("total") or 0),
        "streak": int(st.get("streak") or 0),
        "habits_pending": len(habits_view.get("pending") or []),
    }
    return today_core.next_suggestion(facts)