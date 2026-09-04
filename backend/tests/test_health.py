"""Offline tests for provider health + the scheduler's run recorder (V20).

The health rules are pure dict/time logic, so they need no DB and no network: the
one thing that must never regress is "unknown is not unhealthy", because treating
an unprobed model as broken would disqualify every model on a fresh install.
"""
import asyncio
import atexit
import os
import shutil
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

sys.path.insert(0, ".")

_TMP = Path(tempfile.mkdtemp(prefix="wb-v20-", dir=Path(__file__).parent))


def _cleanup() -> None:
    try:
        asyncio.run(engine.dispose())
    except Exception:  # noqa: BLE001
        pass
    shutil.rmtree(_TMP, ignore_errors=True)


atexit.register(_cleanup)

os.environ["WB_DB_PATH"] = str(_TMP / "test.db")
os.environ["WB_CONFIG_PATH"] = str(_TMP / "config.json")

from app.core import providers as prov  # noqa: E402
from app.core import scheduler as sched  # noqa: E402
from app.db import engine  # noqa: E402


def _at(**delta) -> str:
    return (datetime.now(timezone.utc) - timedelta(**delta)).isoformat(timespec="seconds")


# ---------- is_unhealthy ----------


def test_unknown_model_is_not_unhealthy():
    # the rule the whole feature rests on: nobody has probed it, so it stays usable
    assert prov.is_unhealthy("qwen/anything", {}) is False


def test_recent_failure_is_unhealthy():
    cache = {"qwen/dead": {"ok": False, "code": "403 Quota", "at": _at(hours=1)}}
    assert prov.is_unhealthy("qwen/dead", cache) is True


def test_stale_failure_is_forgiven():
    # otherwise topping the account up would never take effect until a re-probe
    cache = {"qwen/dead": {"ok": False, "code": "403", "at": _at(hours=200)}}
    assert prov.is_unhealthy("qwen/dead", cache) is False


def test_successful_probe_is_never_unhealthy():
    cache = {"qwen/live": {"ok": True, "code": "", "at": _at(hours=1)}}
    assert prov.is_unhealthy("qwen/live", cache) is False


@pytest.mark.parametrize(
    "row", [{"ok": False}, {"ok": False, "at": "not-a-date"}, "garbage", None, 42]
)
def test_malformed_health_rows_do_not_disqualify_a_model(row):
    assert prov.is_unhealthy("qwen/x", {"qwen/x": row}) is False


# ---------- error_code ----------


def test_error_code_surfaces_status_and_upstream_code():
    class Fake(Exception):
        status_code = 403
        body = {"error": {"code": "AllocationQuota.FreeTierOnly"}}

    assert prov.error_code(Fake()) == "403 AllocationQuota.FreeTierOnly"


def test_error_code_falls_back_to_the_exception_name():
    assert prov.error_code(RuntimeError("boom")) == "RuntimeError"


def test_error_code_handles_a_type_only_body():
    class Fake(Exception):
        status_code = 429
        body = {"error": {"type": "rate_limit_error"}}

    assert prov.error_code(Fake()) == "429 rate_limit_error"


def test_error_code_parses_the_real_streaming_failure_message():
    # A streaming request that fails leaves the openai SDK's `.body` unset while
    # rendering the whole payload into str(e). This is the verbatim message from the
    # 2026-09-04 incident; a bare "403" would not distinguish quota from a bad key.
    class Fake(Exception):
        status_code = 403
        body = None

        def __str__(self):
            return (
                "Error code: 403 - {'error': {'message': 'Free quota exhausted. To continue "
                "accessing the model on a paid basis, please add funds or disable the \"use "
                "free tier only\" mode in the management console.', 'type': "
                "'AllocationQuota.FreeTierOnly', 'param': None, 'code': "
                "'AllocationQuota.FreeTierOnly'}, 'id': 'chatcmpl-2f25bfcb'}"
            )

    assert prov.error_code(Fake()) == "403 AllocationQuota.FreeTierOnly"


def test_error_code_ignores_an_unparseable_message():
    class Fake(Exception):
        status_code = 500
        body = None

        def __str__(self):
            return "internal error, no structure here"

    assert prov.error_code(Fake()) == "500"


# ---------- default_model_id ----------


def _providers(rows: list[tuple[str, list[str]]]) -> None:
    """Write provider rows straight into the scratch db (sync, like the caller)."""
    import json
    import sqlite3

    from app.config import settings

    conn = sqlite3.connect(settings.db_path)
    try:
        conn.execute(
            "CREATE TABLE IF NOT EXISTS provider_configs "
            "(id INTEGER PRIMARY KEY, name TEXT, kind TEXT, base_url TEXT, api_key TEXT, "
            "models TEXT, enabled INTEGER)"
        )
        conn.execute("DELETE FROM provider_configs")
        for i, (name, models) in enumerate(rows, 1):
            conn.execute(
                "INSERT INTO provider_configs VALUES (?,?,?,?,?,?,1)",
                (i, name, "openai", "http://x", "k", json.dumps(models)),
            )
        conn.commit()
    finally:
        conn.close()


def test_enabled_models_keeps_configured_order():
    _providers([("qwen", ["a", "b"]), ("other", ["c"])])
    assert prov.enabled_models() == ["qwen/a", "qwen/b", "other/c"]


def test_default_skips_a_recently_broken_model(monkeypatch):
    _providers([("qwen", ["dead", "live"])])
    monkeypatch.setattr(
        prov, "health", lambda: {"qwen/dead": {"ok": False, "code": "403", "at": _at(hours=1)}}
    )
    # exactly the 2026-09-04 shape: the broken model is first, a working one is second
    assert prov.default_model_id() == "qwen/live"


def test_default_falls_back_to_the_first_when_everything_is_broken(monkeypatch):
    _providers([("qwen", ["a", "b"])])
    monkeypatch.setattr(
        prov,
        "health",
        lambda: {
            "qwen/a": {"ok": False, "code": "403", "at": _at(hours=1)},
            "qwen/b": {"ok": False, "code": "403", "at": _at(hours=1)},
        },
    )
    # None would make callers report "没有已启用的 provider", which hides the real 403
    assert prov.default_model_id() == "qwen/a"


def test_default_is_none_without_any_provider():
    _providers([])
    assert prov.default_model_id() is None


def test_default_ignores_a_provider_with_no_models():
    _providers([("empty", []), ("qwen", ["a"])])
    assert prov.default_model_id() == "qwen/a"


# ---------- the scheduler's run recorder ----------


async def _init_db() -> None:
    from app.models import Base

    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)


async def _runs(job_id: str) -> list:
    from sqlalchemy import select

    from app.db import SessionLocal
    from app.models import JobRun

    async with SessionLocal() as db:
        return (
            (
                await db.execute(
                    select(JobRun).where(JobRun.job_id == job_id).order_by(JobRun.id)
                )
            )
            .scalars()
            .all()
        )


async def test_a_successful_job_is_recorded():
    await _init_db()
    calls = []

    async def job():
        calls.append(1)

    await sched._recorded("t_ok", job)()
    rows = await _runs("t_ok")
    assert calls == [1]
    assert len(rows) == 1 and rows[0].ok is True and rows[0].message == ""


async def test_a_raising_job_is_recorded_as_failed_and_does_not_propagate():
    await _init_db()

    async def job():
        raise RuntimeError("upstream 403")

    await sched._recorded("t_raise", job)()  # must NOT raise: the scheduler survives
    rows = await _runs("t_raise")
    assert len(rows) == 1 and rows[0].ok is False
    assert "RuntimeError" in rows[0].message and "403" in rows[0].message


async def test_a_dict_result_saying_not_ok_counts_as_a_failure():
    # how cards.remediate and friends report trouble without raising
    await _init_db()

    async def job():
        return {"ok": False, "error": "没有已启用的 provider"}

    await sched._recorded("t_softfail", job)()
    rows = await _runs("t_softfail")
    assert rows[0].ok is False and "provider" in rows[0].message


async def test_a_sync_job_still_works():
    await _init_db()
    seen = []

    def job():
        seen.append(1)
        return {"message": "done"}

    await sched._recorded("t_sync", job)()
    rows = await _runs("t_sync")
    assert seen == [1] and rows[0].ok is True and rows[0].message == "done"


async def test_args_reach_the_wrapped_job():
    # tasks.py registers task_<id> jobs with args=[task_id]
    await _init_db()
    got = []

    async def job(task_id):
        got.append(task_id)

    await sched._recorded("t_args", job)(7)
    assert got == [7]


async def test_retention_keeps_only_the_newest_runs():
    await _init_db()

    async def job():
        return None

    for _ in range(sched.KEEP_RUNS + 6):
        await sched._recorded("t_keep", job)()
    rows = await _runs("t_keep")
    assert len(rows) <= sched.KEEP_RUNS, len(rows)


# ---------- job_report ----------


async def test_report_lists_known_jobs_even_when_nothing_is_registered():
    # a job that is simply absent used to look identical to a healthy one; on
    # 2026-09-04 cards_remind was off for hours and no surface showed it
    await _init_db()
    report = await sched.job_report()
    ids = {j["job_id"] for j in report}
    assert set(sched.KNOWN_JOBS) <= ids
    for j in report:
        if j["job_id"] in sched.KNOWN_JOBS:
            assert j["registered"] is False  # nothing is registered in this test process


async def test_report_separates_switched_off_from_unexpectedly_missing(monkeypatch):
    await _init_db()
    monkeypatch.setattr(
        sched, "KNOWN_JOBS", {"off_job": "some_flag", "on_job": "other_flag"}
    )
    monkeypatch.setattr(
        "app.core.prefs.load_config", lambda: {"some_flag": False, "other_flag": True}
    )
    report = {j["job_id"]: j for j in await sched.job_report()}
    assert report["off_job"]["disabled"] is True  # you turned it off: not a fault
    assert report["on_job"]["disabled"] is False  # should be running: a bug


async def test_report_counts_consecutive_failures_from_the_newest_run():
    await _init_db()

    async def ok_job():
        return None

    async def bad_job():
        raise RuntimeError("nope")

    await sched._recorded("t_seq", bad_job)()  # old failure, must not be counted
    await sched._recorded("t_seq", ok_job)()
    await sched._recorded("t_seq", bad_job)()
    await sched._recorded("t_seq", bad_job)()
    row = next(j for j in await sched.job_report() if j["job_id"] == "t_seq")
    assert row["runs"] == 4 and row["consecutive_failures"] == 2
    assert row["last"]["ok"] is False and "nope" in row["last"]["message"]


# ---------- iso_utc ----------


def test_iso_utc_stamps_the_offset_onto_a_naive_value():
    # SQLite drops the tz, so a value read back is naive UTC. Serialising it bare
    # made `new Date(...)` in the page read 09:41 UTC as 09:41 local — the review
    # page said a card was due 11:57 when it was really 19:57.
    from datetime import datetime as dt

    from app.models import iso_utc

    assert iso_utc(dt(2026, 9, 4, 9, 41, 0)) == "2026-09-04T09:41:00+00:00"


def test_iso_utc_leaves_an_aware_value_alone_and_passes_none_through():
    from datetime import datetime as dt

    from app.models import iso_utc

    aware = dt(2026, 9, 4, 9, 41, 0, tzinfo=timezone.utc)
    assert iso_utc(aware) == aware.isoformat()
    assert iso_utc(None) is None


# ---------- probe hygiene ----------


async def test_probe_scrubs_the_api_key_out_of_the_stored_message(monkeypatch):
    # the message is persisted into config.json and returned to the browser, so a
    # provider that echoed the credential back must not leak it into a file
    key = "sk-super-secret-value-1234"

    async def boom(info, model, messages, usage=None):
        raise RuntimeError(f"401 unauthorized for Bearer {key}")
        yield  # pragma: no cover - makes this an async generator

    monkeypatch.setattr("app.core.llm.stream_chat", boom)
    r = await prov.probe_model("openai", "http://x/v1", key, "m")
    assert r["ok"] is False
    assert key not in r["message"] and "***" in r["message"]
