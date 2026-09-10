"""后台自检：定时作业的执行结果 + 模型可用性。

`GET /api/health` itself stays in `main.py` — that one is the liveness probe the
desktop shell polls before opening a window, and it must answer even if this
module is broken. Everything here is the deeper check that 2026-09-04 showed was
missing: eight background jobs that swallow their own exceptions, and no surface
anywhere saying whether last night's run actually worked.
"""
import logging

from fastapi import APIRouter

router = APIRouter(prefix="/api/health", tags=["health"])
log = logging.getLogger(__name__)


@router.get("/jobs")
async def jobs():
    """Every scheduled job: next run, last outcome, consecutive failures."""
    from app.core import scheduler as sched

    return {"jobs": await sched.job_report(), "keep_runs": sched.KEEP_RUNS}


@router.get("/self")
async def self_check():
    """One line's worth of truth for the 今日 page.

    Best-effort by design: a self-check that can 500 is worse than none, so every
    part degrades to a neutral value rather than failing the request.
    """
    from app.core import providers as prov
    from app.core import scheduler as sched

    try:
        report = await sched.job_report()
    except Exception:  # noqa: BLE001
        log.debug("job report failed", exc_info=True)
        report = []
    failing = [j for j in report if j["consecutive_failures"] > 0]
    # "should be running but is not" — previously indistinguishable from healthy
    missing = [j for j in report if not j["registered"] and not j["disabled"]]
    off = [j for j in report if j["disabled"]]

    cache = prov.health()
    models = prov.enabled_models()
    broken = [m for m in models if prov.is_unhealthy(m, cache)]
    default = prov.default_model_id()
    return {
        "jobs_total": len(report),
        "jobs_live": len([j for j in report if j["registered"]]),
        "jobs_off": [j["job_id"] for j in off],
        "jobs_missing": [j["job_id"] for j in missing],
        "jobs_failing": [
            {
                "job_id": j["job_id"],
                "fails": j["consecutive_failures"],
                "message": ((j["last"] or {}).get("message") or "")[:160],
            }
            for j in failing
        ],
        "models_total": len(models),
        "models_broken": [{"model_id": m, "code": (cache.get(m) or {}).get("code", "")} for m in broken],
        "default_model": default,
        # true only when the model every automated feature would reach is the broken
        # one — that is the exact shape of the 2026-09-04 incident
        "default_model_broken": bool(default and prov.is_unhealthy(default, cache)),
        "never_probed": not cache,
    }


@router.get("/report")
async def report():
    """体检报告：自检 + 备份年龄 + 索引规模 + 用户任务失败 + 整理员状态。

    self_check 只看定时作业和模型；这里把「系统还能不能信」剩下的几块拼齐。
    每一块都 best-effort——体检本身坏掉比哪一项都糟。"""
    base = await self_check()

    backups: dict = {}
    try:
        from app.core import backup as backup_core

        items = backup_core.list_backups().get("backups") or []
        backups = {
            "count": len(items),
            "latest_at": items[0]["created_at"] if items else None,
        }
    except Exception:  # noqa: BLE001
        log.debug("backup listing failed", exc_info=True)

    kb: dict = {}
    try:
        from app.core import indexer
        from app.core.watcher import watcher

        kb = {"indexer": indexer.stats(), "watcher": watcher.status}
    except Exception:  # noqa: BLE001
        log.debug("kb stats failed", exc_info=True)

    tasks_failing: list[dict] = []
    try:
        from sqlalchemy import select

        from app.db import SessionLocal
        from app.models import ScheduledTask

        async with SessionLocal() as db:
            rows = (
                await db.execute(
                    select(ScheduledTask).where(
                        ScheduledTask.enabled.is_(True), ScheduledTask.last_status == "error"
                    )
                )
            ).scalars().all()
        tasks_failing = [{"id": t.id, "name": t.name} for t in rows[:5]]
    except Exception:  # noqa: BLE001
        log.debug("task status read failed", exc_info=True)

    tidy: dict = {}
    try:
        from app.core import memory_tidy

        tidy = memory_tidy.last_report()
    except Exception:  # noqa: BLE001
        log.debug("tidy report failed", exc_info=True)

    # 结构化输出（模型吐 JSON 的地方）的成功/降级/失败次数。这些调用此前失败
    # 是静默的，这里让「抽取是不是一直在悄悄失败」变成可回答的问题。
    structured: dict = {}
    try:
        from app.core import structured as st

        structured = st.stats()
    except Exception:  # noqa: BLE001
        log.debug("structured stats failed", exc_info=True)

    # 提示词注册中心：数量 + 登记漂移（某模块 import 失败 / 常量缺失）。
    prompts: dict = {}
    try:
        from app.core import prompts as pr

        prompts = pr.summary()
    except Exception:  # noqa: BLE001
        log.debug("prompts summary failed", exc_info=True)

    # 成本预算护栏：月度预算状态（0 预算 = 未启用，零成本返回）。
    cost: dict = {}
    try:
        from app.core import cost as cost_core

        cost = await cost_core.monthly_budget_status()
    except Exception:  # noqa: BLE001
        log.debug("cost budget status failed", exc_info=True)

    return {
        "self": base,
        "backups": backups,
        "kb": kb,
        "tasks_failing": tasks_failing,
        "tidy": tidy,
        "structured": structured,
        "prompts": prompts,
        "cost": cost,
    }
