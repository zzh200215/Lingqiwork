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
