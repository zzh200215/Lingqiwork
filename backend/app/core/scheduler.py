"""Single APScheduler instance shared by every background job.

Jobs register themselves from config via `reschedule_all()`, which the
settings router calls after any prefs change so schedule edits apply live.

Every registered job is wrapped by `_recorded()` so its outcome lands in
`job_runs`. The wrapping happens HERE rather than in the eight job functions on
purpose: they all swallow their own exceptions by design (a failing digest must
not kill the scheduler), which on 2026-09-04 meant every automated feature failed
silently for days against a quota-exhausted model. Recording at the registration
point cost zero changes to the jobs.
"""
import asyncio
import inspect
import logging
import time
from collections.abc import Callable

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.cron import CronTrigger

log = logging.getLogger(__name__)

scheduler = AsyncIOScheduler()
LOOP: asyncio.AbstractEventLoop | None = None  # main loop, for threads that need to fire coroutines

KEEP_RUNS = 20  # per job_id, matching the per-task run log in core/tasks.py

# job_id -> the prefs flag that turns it on. Known-but-unregistered jobs are still
# reported (as disabled) instead of vanishing from the report, because a job that
# silently is not there is exactly the failure this module exists to surface: on
# 2026-09-04 `cards_remind` and `cards_remediate` were off and nothing said so —
# they simply did not appear anywhere.
#
# Those two are now deliberately absent from this table: PLAN.md 第 3 节 封存了
# 复习提醒，`cards.reschedule()` 永远不再注册它们。留在表里的话 `self_check` 会一直把
# 它们算进 `jobs_missing`（「应该在跑但没注册」），而那正是第 9 节唯一在乎的信号 ——
# 一个永远亮着的假警报会把真故障淹掉。
KNOWN_JOBS = {
    "daily_digest": "digest_enabled",
    "auto_backup": "backup_enabled",
    "feeds_sync": "feeds_enabled",
    "memory_tidy": "memory_tidy_enabled",
    "pet_morning": "pet_greet_enabled",
    "pet_evening": "pet_greet_enabled",
}


async def _record(job_id: str, seconds: float, ok: bool, message: str) -> None:
    """Append one run and prune old ones. Never raises into the job."""
    try:
        from sqlalchemy import delete, select

        from app.db import SessionLocal
        from app.models import JobRun

        async with SessionLocal() as db:
            db.add(
                JobRun(job_id=job_id, seconds=round(seconds, 2), ok=ok, message=message[:2000])
            )
            await db.commit()
            keep = (
                (
                    await db.execute(
                        select(JobRun.id)
                        .where(JobRun.job_id == job_id)
                        .order_by(JobRun.id.desc())
                        .limit(KEEP_RUNS)
                    )
                )
                .scalars()
                .all()
            )
            if len(keep) >= KEEP_RUNS:
                await db.execute(
                    delete(JobRun).where(JobRun.job_id == job_id, JobRun.id < min(keep))
                )
                await db.commit()
    except Exception:  # noqa: BLE001 - observability must never break the thing observed
        log.debug("job_runs write failed for %s", job_id, exc_info=True)


def _recorded(job_id: str, func: Callable) -> Callable:
    """Wrap a job so every run is timed and its outcome stored.

    All eight jobs are `async def` today; the awaitable check keeps a future sync
    job working rather than silently recording a coroutine object as success. A
    dict result with `ok: False` counts as a failure even when nothing was raised —
    that is how `cards.remediate` and friends report trouble.
    """

    async def runner(*args):
        t0 = time.time()
        ok, message = True, ""
        try:
            result = func(*args)
            if inspect.isawaitable(result):
                result = await result
            if isinstance(result, dict):
                if result.get("ok") is False:
                    ok = False
                    message = str(result.get("error") or result.get("message") or "")
                else:
                    message = str(result.get("message") or "")
        except Exception as e:  # noqa: BLE001
            ok, message = False, f"{type(e).__name__}: {e}"
            log.exception("scheduled job %s failed", job_id)
        await _record(job_id, time.time() - t0, ok, message)

    runner.__name__ = f"recorded_{job_id}"
    return runner


def start() -> None:
    global LOOP
    LOOP = asyncio.get_running_loop()
    reschedule_all()
    if not scheduler.running:
        scheduler.start()


def shutdown() -> None:
    if scheduler.running:
        scheduler.shutdown(wait=False)


def reschedule_all() -> None:
    """Re-register every config-driven job. Safe to call anytime."""
    from app.core import backup, cards, digest, feeds, memory_tidy, pet, tasks

    for fn in (
        digest.reschedule,
        backup.reschedule,
        tasks.reschedule,
        feeds.reschedule,
        memory_tidy.reschedule,
        pet.reschedule,
        cards.reschedule,
    ):
        try:
            fn()
        except Exception:  # noqa: BLE001 - one bad schedule must not kill the others
            log.exception("reschedule failed for %s", fn.__module__)


def set_daily(job_id: str, func: Callable, enabled: bool, hhmm: str, default_hour: int = 9) -> None:
    """(Re)register a daily job at HH:MM local time; remove it when disabled."""
    if scheduler.get_job(job_id):
        scheduler.remove_job(job_id)
    if not enabled:
        return
    hh, _, mm = (hhmm or "").partition(":")
    try:
        trigger = CronTrigger(hour=int(hh), minute=int(mm or 0))
    except ValueError:
        trigger = CronTrigger(hour=default_hour, minute=0)
    scheduler.add_job(_recorded(job_id, func), trigger, id=job_id)
    log.info("job %s scheduled daily at %s", job_id, hhmm)


def next_run(job_id: str) -> str | None:
    job = scheduler.get_job(job_id)
    run_at = getattr(job, "next_run_time", None) if job else None
    return run_at.isoformat(timespec="seconds") if run_at else None


def set_cron(job_id: str, func: Callable, cron_expr: str, args: list | None = None) -> None:
    """(Re)register a job from a 5-field crontab string. Raises ValueError if invalid."""
    trigger = CronTrigger.from_crontab(cron_expr.strip())
    if scheduler.get_job(job_id):
        scheduler.remove_job(job_id)
    scheduler.add_job(_recorded(job_id, func), trigger, id=job_id, args=args or [])
    log.info("job %s scheduled with cron '%s'", job_id, cron_expr)


def prune_jobs(prefix: str, keep: set[str]) -> None:
    """Drop jobs whose id starts with `prefix` and is not in `keep`."""
    for job in scheduler.get_jobs():
        if job.id.startswith(prefix) and job.id not in keep:
            scheduler.remove_job(job.id)


async def job_report() -> list[dict]:
    """Every job we know about, with its next run and its last outcome.

    The set is registered ∪ has-history ∪ KNOWN_JOBS, so a feature whose job is not
    running is visible either way: `disabled` when you turned it off, and
    `registered: false` with `disabled: false` when it should be running but is not
    — that second case is a bug, and previously it looked identical to "fine".

    Consecutive failures count from the newest run backwards: one bad night is
    noise, four in a row is a broken feature.
    """
    from sqlalchemy import select

    from app.db import SessionLocal
    from app.models import JobRun, iso_utc

    rows: list = []
    try:
        async with SessionLocal() as db:
            rows = (
                (await db.execute(select(JobRun).order_by(JobRun.id.desc()).limit(400)))
                .scalars()
                .all()
            )
    except Exception:  # noqa: BLE001
        log.debug("job_report read failed", exc_info=True)

    by_job: dict[str, list] = {}
    for r in rows:
        by_job.setdefault(r.job_id, []).append(r)

    try:
        from app.core.prefs import load_config

        cfg = load_config()
    except Exception:  # noqa: BLE001
        cfg = {}

    live = {j.id for j in scheduler.get_jobs()}
    out = []
    for job_id in sorted(live | set(by_job) | set(KNOWN_JOBS)):
        runs = by_job.get(job_id, [])
        fails = 0
        for r in runs:  # already newest-first
            if r.ok:
                break
            fails += 1
        last = runs[0] if runs else None
        flag = KNOWN_JOBS.get(job_id)
        out.append(
            {
                "job_id": job_id,
                "registered": job_id in live,
                "enabled_by": flag or "",
                "disabled": bool(flag) and not cfg.get(flag, True),
                "next_run": next_run(job_id),
                "runs": len(runs),
                "consecutive_failures": fails,
                "last": None
                if last is None
                else {
                    "at": iso_utc(last.started_at),
                    "ok": last.ok,
                    "seconds": last.seconds,
                    "message": last.message[:400],
                },
            }
        )
    return out
