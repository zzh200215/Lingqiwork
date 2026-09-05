"""Offline tests for opening-count telemetry (PLAN 第0周).

Uses a scratch db (WB_DB_PATH env before import, same pattern as test_health.py).
The rules tested: record_visit is idempotent per (page, day), only known pages
are accepted, and open_days counts distinct local days.
"""
import asyncio
import atexit
import os
import shutil
import sys
import tempfile
from pathlib import Path

import pytest

sys.path.insert(0, ".")

_TMP = Path(tempfile.mkdtemp(prefix="wb-usage-", dir=Path(__file__).parent))


def _cleanup() -> None:
    try:
        asyncio.run(engine.dispose())
    except Exception:  # noqa: BLE001
        pass
    shutil.rmtree(_TMP, ignore_errors=True)


atexit.register(_cleanup)

os.environ["WB_DB_PATH"] = str(_TMP / "test.db")
os.environ["WB_CONFIG_PATH"] = str(_TMP / "config.json")

from app.core import usage as core  # noqa: E402
from app.db import engine  # noqa: E402


async def _init_db() -> None:
    from app.models import Base

    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)


def test_valid_page_whitelist():
    for good in ("chat", "review", "dashboard", "notes", "kb", "settings"):
        assert core.valid_page(good) is True
    for bad in ("", "  ", "weird.html", "chat/", "CON"):
        assert core.valid_page(bad) is False


async def test_record_visit_is_idempotent_per_day():
    await _init_db()
    first = await core.record_visit("review")
    second = await core.record_visit("review")
    assert first["recorded"] is True
    assert second["recorded"] is False  # reload must not inflate the count

    from sqlalchemy import select

    from app.db import SessionLocal
    from app.models import UsageVisit

    async with SessionLocal() as db:
        rows = (
            (await db.execute(select(UsageVisit).where(UsageVisit.page == "review"))).scalars().all()
        )
    assert len(rows) == 1


async def test_different_pages_count_separately():
    await _init_db()
    await core.record_visit("chat")
    await core.record_visit("notes")
    days = await core.open_days(7)
    assert len(days) == 1  # same local day, two pages -> one open day


async def test_unknown_page_returns_recorded_false():
    await _init_db()
    r = await core.record_visit("totally-not-a-page")
    assert r["recorded"] is False


async def test_usage_record_never_raises():
    # a torn-down db (table missing) must still return recorded False, not raise
    from sqlalchemy import text as sql

    async with engine.begin() as conn:
        await conn.execute(sql("DROP TABLE usage_visits"))
    r = await core.record_visit("review")
    assert r["recorded"] is False