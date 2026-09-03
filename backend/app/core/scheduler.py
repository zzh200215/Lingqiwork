"""Single APScheduler instance shared by every background job.

Jobs register themselves from config via `reschedule_all()`, which the
settings router calls after any prefs change so schedule edits apply live.
"""
import asyncio
import logging
from collections.abc import Callable

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.cron import CronTrigger

log = logging.getLogger(__name__)

scheduler = AsyncIOScheduler()
LOOP: asyncio.AbstractEventLoop | None = None  # main loop, for threads that need to fire coroutines


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
    scheduler.add_job(func, trigger, id=job_id)
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
    scheduler.add_job(func, trigger, id=job_id, args=args or [])
    log.info("job %s scheduled with cron '%s'", job_id, cron_expr)


def prune_jobs(prefix: str, keep: set[str]) -> None:
    """Drop jobs whose id starts with `prefix` and is not in `keep`."""
    for job in scheduler.get_jobs():
        if job.id.startswith(prefix) and job.id not in keep:
            scheduler.remove_job(job.id)
