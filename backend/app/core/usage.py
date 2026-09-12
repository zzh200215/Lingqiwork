"""Opening-count telemetry: 连续 7 天记录打开次数.

Sole job: answer "did the user open the app on which days". At most one row per
(page, day) — the unique index in models.py makes record_visit idempotent, so a
reload never inflates the count and the table stays bounded by design. Same
`day`-as-local-date-string discipline as `core/habits.py`; see models.UsageVisit.

Heavy dependencies are imported inside functions, same reason as the other core
modules: this is reached at startup through routers/usage.py.
"""
import logging
from datetime import date

log = logging.getLogger(__name__)

LIVE_DAYS = 30  # just enough for the weekly baseline the plan asks for

# the pages the frontend actually opens; anything unknown still counts, but the
# set keeps attestation honest when we're asked what these rows mean
PAGES = ("chat", "tutor", "review", "dashboard", "notes", "kb", "settings")


def valid_page(page: str) -> bool:
    return (page or "").strip() in PAGES


def _today() -> str:
    return date.today().isoformat()


async def record_visit(page: str) -> dict:
    """Count one page open. Idempotent per (page, day); never raises.

    Returns {recorded: bool, page, day} — recorded False when this page was
    already opened today (a reload), or when the page is not a known one.
    """
    if not valid_page(page):
        return {"recorded": False, "page": page, "day": _today()}
    day = _today()
    try:
        from sqlalchemy import select

        from app.db import SessionLocal
        from app.models import UsageVisit

        async with SessionLocal() as db:
            exists = (
                await db.execute(
                    select(UsageVisit.id).where(
                        UsageVisit.page == page, UsageVisit.day == day
                    )
                )
            ).scalar_one_or_none()
            if exists:
                return {"recorded": False, "page": page, "day": day}
            db.add(UsageVisit(page=page, day=day))
            await db.commit()
        return {"recorded": True, "page": page, "day": day}
    except Exception:  # noqa: BLE001 - telemetry must never break a page load
        log.debug("usage visit write failed for %s", page, exc_info=True)
        return {"recorded": False, "page": page, "day": day}


async def open_days(days: int = 7) -> list[str]:
    """Local calendar days (newest first) on which at least one page was opened.

    `date(visited_at,'localtime')` on the SQL side, not a Python-side local date
    compared against a UTC column — that combination is an off-by-timezone bug
    (`habits._review_days`, `cards._today_counts`).
    """
    from sqlalchemy import text as sql

    from app.db import SessionLocal

    rows = []
    try:
        async with SessionLocal() as db:
            rows = (
                await db.execute(
                    sql(
                        "SELECT DISTINCT date(visited_at, 'localtime') "
                        "FROM usage_visits "
                        f"WHERE visited_at >= datetime('now', '-{max(1, int(days))} days') "
                        "ORDER BY date(visited_at, 'localtime') DESC"
                    )
                )
            ).scalars().all()
    except Exception:  # noqa: BLE001 - stats must never break a page
        log.debug("usage open_days failed", exc_info=True)
        rows = []
    return [str(r) for r in rows]