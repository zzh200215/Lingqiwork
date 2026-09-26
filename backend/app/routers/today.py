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


@router.get("/summary")
async def today_summary() -> dict:
    """概览档位：失败任务 / 未消化 / 到期卡 / 到期事项 / 卡点 / 进行中产出。

    best-effort：每一档各自 try/except，坏一个不挡其余（照 health.report 的形状）。
    和 `/next` 完全两回事——那条是**一句会主动开口的建议**，由封存词表守着；这里只是计数
    与落点，所以「到期卡」「到期事项」「卡点」这些词只活在事实组装里，不在
    `next_suggestion` 的文案里。

    事实（degrees of honesty）：失败任务/到期卡/到期事项/卡点有真实数据源；未消化与进行中
    产出**没有状态字段**，用现成近似——躺着的录音 + 没开教的学习点，在跑的引擎 + 在跑的运行。
    """
    facts: dict = {}

    # 1) 失败任务：后台作业（scheduler）+ 用户定时任务（last_status=error）
    jobs = 0
    try:
        from app.routers.health import self_check

        jobs = len((await self_check()).get("jobs_failing") or [])
    except Exception:  # noqa: BLE001
        log.warning("summary: background job check failed", exc_info=True)
    failing_ids: list[int] = []
    try:
        from sqlalchemy import select

        from app.db import SessionLocal
        from app.models import ScheduledTask

        async with SessionLocal() as db:
            failing_ids = list(
                (
                    await db.execute(
                        select(ScheduledTask.id).where(
                            ScheduledTask.enabled.is_(True),
                            ScheduledTask.last_status == "error",
                        )
                    )
                ).scalars().all()
            )
    except Exception:  # noqa: BLE001
        log.warning("summary: failing task read failed", exc_info=True)
    if jobs + len(failing_ids):
        facts["tasks_failing"] = jobs + len(failing_ids)
        facts["tasks_failing_href"] = (
            f"/work?task={failing_ids[0]}"
            if len(failing_ids) == 1
            else "/work?tab=workflow"
            if failing_ids
            else "/settings"
        )

    # 2) 未消化 = 还没处理的会议录音 + 还没开成教学的学习点（近似，不是「欠着」）
    inbox = 0
    try:
        from app.config import VAULT_DIR

        inbox = sum(1 for p in (VAULT_DIR / "meetings" / "inbox").glob("*") if p.is_file())
    except Exception:  # noqa: BLE001
        log.warning("summary: inbox scan failed", exc_info=True)
    points = 0
    try:
        from app.core import tutor

        points = await tutor.untouched_count()
    except Exception:  # noqa: BLE001
        log.warning("summary: untouched count failed", exc_info=True)
    if inbox + points:
        facts["untouched"] = inbox + points
        facts["untouched_href"] = "/work?tab=workflow" if inbox else "/tutor"

    # 3) 到期卡
    try:
        from app.core import cards

        facts["due_cards"] = (await cards.stats())["due_now"]
    except Exception:  # noqa: BLE001
        log.warning("summary: card stats failed", exc_info=True)

    # 3b) 到期事项（§五-5）：截止日到了还没完成的「一件事」。
    #     与「到期卡」分开两档——卡片是知识该重看了，事情是**你自己设的期限到了**；
    #     合成一档之后「3 件到期」说不清是哪种，点了也不知道该去哪。
    try:
        from app.core import threads as threads_core

        due_rows = await threads_core.due()
        if due_rows:
            facts["due_threads"] = len(due_rows)
            # 只有一件事时直接深链到它（`ThreadsPage` 认 `?thread=`）；
            # 多过一件就落列表——指到其中一件会让另外几件看不见。
            facts["due_threads_href"] = (
                f"/work?tab=thread&thread={due_rows[0]['id']}"
                if len(due_rows) == 1
                else "/work?tab=thread"
            )
    except Exception:  # noqa: BLE001
        log.warning("summary: due thread read failed", exc_info=True)

    # 4) 卡点 = 停在人工卡点、等人点头的那几步
    try:
        from sqlalchemy import func, select

        from app.db import SessionLocal
        from app.models import TaskRun
        from app.core import tasks as tasks_core

        async with SessionLocal() as db:
            rows = (
                await db.execute(
                    select(TaskRun.task_id, func.count(TaskRun.id))
                    .where(TaskRun.status == tasks_core._GATE_STATUS)
                    .group_by(TaskRun.task_id)
                )
            ).all()
        n = sum(c for _, c in rows)
        if n:
            facts["awaiting"] = n
            facts["awaiting_href"] = (
                f"/work?task={rows[0][0]}" if n == 1 else "/work?tab=workflow"
            )
    except Exception:  # noqa: BLE001
        log.warning("summary: gate count failed", exc_info=True)

    # 5) 进行中产出 = 交互式引擎持有的 slot + 任务式引擎仍在 running 的运行
    live = 0
    try:
        from app.core import inflight

        live = len(inflight.running())
    except Exception:  # noqa: BLE001
        log.warning("summary: inflight read failed", exc_info=True)
    running = 0
    try:
        from sqlalchemy import func, select

        from app.db import SessionLocal
        from app.models import TaskRun

        async with SessionLocal() as db:
            running = (
                await db.execute(
                    select(func.count(TaskRun.id)).where(TaskRun.status == "running")
                )
            ).scalar() or 0
    except Exception:  # noqa: BLE001
        log.warning("summary: running task count failed", exc_info=True)
    if live + running:
        facts["inflight"] = live + running

    return {"rows": today_core.summary(facts)}
