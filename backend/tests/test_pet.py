"""Offline tests for 零柒 (ROADMAP V14): template composition, event emit +
feed roundtrip, the pet_enabled kill switch, honest status aggregation, and
the greeting LLM fallback.

No model is needed: greeting falls back to templates when no provider exists
in the scratch DB. Env must be set before app imports.
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

# project-local scratch dir (system temp may be sandboxed)
_TMP = Path(tempfile.mkdtemp(prefix="wb-pet-", dir=Path(".").resolve()))


def _cleanup() -> None:
    shutil.rmtree(_TMP, ignore_errors=True)


atexit.register(_cleanup)

os.environ["WB_DB_PATH"] = str(_TMP / "test.db")
os.environ["WB_CONFIG_PATH"] = str(_TMP / "config.json")

from app.core import pet  # noqa: E402
from app.core.prefs import load_config, save_config  # noqa: E402


# --- compose: 零柒's voice -----------------------------------------------------


def test_compose_task_done_includes_name_and_tail():
    line = pet.compose("task_done", name="每日摘要", detail="3 条要点")
    assert "每日摘要" in line and "3 条要点" in line


def test_compose_task_failed_mentions_failure():
    line = pet.compose("task_failed", name="爬虫", detail="TimeoutError: too long" * 10)
    assert "没跑成" in line and "爬虫" in line
    assert len(line) < 200  # error text is capped


def test_compose_counts():
    assert "7" in pet.compose("digest", count=7)
    assert "5" in pet.compose("feeds", count=5)


def test_compose_greeting_by_hour():
    assert "好" in pet.compose("greeting")
    assert "盯着" in pet.compose("greeting")


def test_compose_unknown_kind_falls_back():
    assert pet.compose("whatever", detail="兜底") == "兜底"


# --- emit + feed roundtrip -----------------------------------------------------


def test_emit_and_feed_roundtrip():
    eid = pet.emit("task_done", name="T1", detail="ok")
    assert eid is not None and eid > 0
    events = pet.feed(limit=10)
    assert events[0]["id"] == eid
    assert events[0]["kind"] == "task_done"
    assert "T1" in events[0]["text"]


def test_emit_respects_kill_switch():
    save_config({"pet_enabled": False})
    try:
        assert pet.emit("say", text="不该被记录") is None
        assert all("不该被记录" not in e["text"] for e in pet.feed(limit=50))
    finally:
        save_config({"pet_enabled": True})


def test_emit_never_raises_on_notify_failure(monkeypatch):
    import app.core.notify as notify_mod

    def _boom(title, body=""):
        raise RuntimeError("no toaster")

    monkeypatch.setattr(notify_mod, "desktop", _boom)
    eid = pet.emit("task_failed", name="T2", detail="x")  # failure kind → toast path
    assert eid is not None  # event recorded despite the broken toaster


def test_feed_since_id_filter():
    e1 = pet.emit("say", text="第一条")
    e2 = pet.emit("say", text="第二条")
    assert e1 and e2 and e2 > e1
    newer = pet.feed(since_id=e1)
    assert all(ev["id"] > e1 for ev in newer)


def test_feed_limit_clamped():
    assert len(pet.feed(limit=999)) <= 100


# --- status: honest mood from real data ----------------------------------------


def test_status_fields_are_real():
    st = pet.status()
    for key in ("tasks_done", "tasks_failed", "notes_today", "tokens_today", "time_of_day"):
        assert key in st
    assert st["tasks_done"] >= 0 and st["tasks_failed"] >= 0
    assert st["time_of_day"] in ("morning", "afternoon", "evening")


def test_status_survives_missing_tables(monkeypatch):
    import sqlite3

    import app.core.pet as pet_mod

    def _boom(*a, **kw):
        raise RuntimeError("db gone")

    monkeypatch.setattr(pet_mod, "_conn", _boom)
    # status() 统计 task_runs/messages 走的是直接 sqlite3.connect(settings.db_path)，
    # 不经过 _conn——把它也掐掉，测试才真正密封；否则它数到的是同进程里
    # 第一个测试库今天的运行行，日期一变结论就变。
    monkeypatch.setattr(sqlite3, "connect", _boom)
    st = pet.status()  # must not raise
    assert st["tasks_done"] == 0


# --- greeting: LLM with template fallback --------------------------------------


def test_greeting_falls_back_without_provider():
    save_config({"pet_enabled": True})  # ensure on
    # scratch DB has no provider_configs rows → template fallback, never raises
    line = asyncio.run(pet.greeting("morning"))
    assert isinstance(line, str) and len(line) > 4


def test_say_rejects_empty_free_prompt():
    from fastapi import HTTPException

    from app.routers.pet import SayIn, pet_say

    with pytest.raises(HTTPException):
        asyncio.run(pet_say(SayIn(mode="free", prompt="  ")))


# --- circadian rhythm: scheduled morning/evening greetings ---------------------


def test_reschedule_registers_morning_and_evening():
    from app.core import scheduler as sched

    save_config({"pet_greet_enabled": True})
    pet.reschedule()
    ids = {j.id for j in sched.scheduler.get_jobs()}
    assert "pet_morning" in ids
    assert "pet_evening" in ids


def test_reschedule_disabled_removes_jobs():
    from app.core import scheduler as sched

    save_config({"pet_greet_enabled": False})
    try:
        pet.reschedule()
        ids = {j.id for j in sched.scheduler.get_jobs()}
        assert "pet_morning" not in ids
        assert "pet_evening" not in ids
    finally:
        save_config({"pet_greet_enabled": True})
        pet.reschedule()


def test_greet_morning_emits_greeting(monkeypatch):
    import app.core.notify as notify_mod

    monkeypatch.setattr(notify_mod, "desktop", lambda *a, **k: None)  # no real toast
    save_config({"pet_enabled": True})
    asyncio.run(pet._greet_morning())
    events = pet.feed(limit=10)
    assert any(e["kind"] == "greeting" for e in events)
