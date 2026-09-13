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
from app.core import pet_plugins as pp  # noqa: E402
from app.core.prefs import save_config  # noqa: E402


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


# --- B3: 隐私边界 —— 台词不许带路径 / 密钥 ----------------------------------------


def test_sanitize_strips_file_paths():
    for text in (
        "改好了 D:\\TP\\A\\vault\\note.md",
        "读了 /etc/passwd 一眼",
        "在 ~/work/x.md 里",
        "\\\\server\\share\\a.txt 同步完了",
    ):
        out = pet.sanitize(text)
        assert pet.sanitize(out) == out  # 幂等
        assert "\\" not in out and "/" not in out, out


def test_sanitize_keeps_urls_and_slash_words():
    # URL 与「和/或」这类带斜杠的词不该被当成绝对路径啃掉
    assert pet.sanitize("见 https://example.com/a/b") == "见 https://example.com/a/b"
    assert "和/或" in pet.sanitize("和/或 都行")
    assert pet.sanitize("普通一句话，没有别的") == "普通一句话，没有别的"


def test_sanitize_strips_secrets():
    for text in (
        "key=sk-abcdef0123456789abcdef",
        "Authorization: Bearer abcdef0123456789abcdef",
        "token: " + "a1b2c3d4" * 8,  # 64 位 hex
        "api_key=secretvalue123",
    ):
        assert "[已隐藏]" in pet.sanitize(text) or "[路径]" in pet.sanitize(text), text
    assert "abc123" in pet.sanitize("版本 abc123")  # 短串不是密钥，不要误伤


def test_emit_sanitizes_the_spoken_line():
    eid = pet.emit("say", text="已处理 D:\\TP\\A\\vault\\secret.md 这个文件")
    assert eid is not None
    ev = pet.feed(limit=1)[0]
    assert "D:\\" not in ev["text"] and "secret.md" not in ev["text"]


def test_compose_mastered_line():
    assert "搞懂了" in pet.compose("mastered", name="asyncio 事件循环")


# --- B1: 成长模型 —— 诚实、只增不减、只正面呈现 -----------------------------------


async def _tables() -> None:
    from app.db import engine
    from app.models import Base

    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)


def test_growth_empty_db_is_level_one_and_never_raises():
    g = pet.growth()
    assert g["level"] == 1 and g["exp"] == 0
    assert g["title"] == "初识"
    assert g["parts"] == []  # 没有来源就不摆空档，也就没有「还欠」可写
    assert g["progress"] == 0.0
    assert "next_exp" not in g  # 没有「还差 N」这种字段


async def test_growth_counts_real_accumulation_and_only_grows():
    await _tables()
    from app.db import SessionLocal
    from app.models import CardReview, HabitLog, TaskRun, TutorSession

    before = pet.growth()["exp"]
    async with SessionLocal() as db:
        db.add_all(
            [
                TutorSession(topic="t", concept="asyncio 事件循环", verdict="got"),
                TutorSession(topic="t", concept="asyncio 事件循环", verdict="got"),
                TaskRun(task_id=1, status="ok"),
                HabitLog(habit_id=1, day="2026-09-13"),
                CardReview(card_id=1, grade=3),
            ]
        )
        await db.commit()

    g = pet.growth()
    assert g["exp"] > before
    assert {p["key"] for p in g["parts"]} >= {"learning", "work", "habits", "review"}
    assert g["counts"]["mastered"] == 1  # 两场说通才算「学会」（与学习地图同一条）
    assert g["level"] >= 1
    assert pet.growth()["exp"] == g["exp"]  # 累计量只增不减：再读一次不回落


# --- B2: 能力插件（openpets 范式） ------------------------------------------------


async def test_plugins_seed_two_builtins_with_panels():
    await _tables()
    rows = await pp.list_plugins()
    names = {r["name"] for r in rows}
    assert {"water", "focus"} <= names
    water = next(r for r in rows if r["name"] == "water")
    assert water["panel"]["kind"] == "counter"
    assert water["panel"]["target"] == pp.WATER_TARGET
    assert "drink" in water["commands"]
    assert water["enabled"] is True
    assert len(await pp.list_plugins()) == len(rows)  # 二次调用幂等，不重复播种


async def test_plugin_command_drink_increments_and_persists():
    await _tables()
    await pp.list_plugins()
    assert (await pp.command("water", "drink"))["panel"]["value"] == 1
    assert (await pp.command("water", "drink"))["panel"]["value"] == 2


async def test_plugin_command_rejects_unknown_command():
    await _tables()
    await pp.list_plugins()
    with pytest.raises(ValueError):
        await pp.command("water", "fly")


async def test_plugin_focus_start_stop_roundtrip():
    await _tables()
    await pp.list_plugins()
    started = await pp.command("focus", "start", {"minutes": 25})
    assert started["panel"]["running"] is True
    assert started["panel"]["minutes"] == 25
    assert (await pp.command("focus", "stop"))["panel"]["running"] is False


async def test_plugin_quota_caps_daily_events():
    await _tables()
    await pp.list_plugins()
    cap = int((pp.BUILTINS["water"]["quota"] or {}).get("events_per_day", 0))
    results = [await pp._emit_for("water", "喝口水吧") for _ in range(cap + 2)]
    assert results[:cap] == [True] * cap
    assert results[cap:] == [False, False]


def test_water_due_respects_hours_target_and_once_per_hour():
    from datetime import datetime

    hours = [10, 15, 20]
    state = {"day": "2026-09-13", "cups": 3, "reminded": [10]}
    assert pp.water_due(state, datetime(2026, 9, 13, 15, 5), hours, 8) is True
    assert pp.water_due(state, datetime(2026, 9, 13, 11, 5), hours, 8) is False  # 不在计划钟点
    assert pp.water_due(state, datetime(2026, 9, 13, 10, 5), hours, 8) is False  # 这个钟点提醒过
    full = {"day": "2026-09-13", "cups": 8, "reminded": []}
    assert pp.water_due(full, datetime(2026, 9, 13, 15, 5), hours, 8) is False  # 喝够了


def test_focus_due_and_day_rollover():
    from datetime import datetime

    started = {"started_at": datetime(2026, 9, 13, 9, 0).isoformat(timespec="seconds"), "minutes": 25}
    assert pp.focus_due(started, datetime(2026, 9, 13, 9, 10)) is False
    assert pp.focus_due(started, datetime(2026, 9, 13, 9, 30)) is True
    assert pp.focus_remaining(started, datetime(2026, 9, 13, 9, 10)) == 900
    # 跨天把日计数归零（杯子数、已提醒钟点）
    assert pp.roll_day({"day": "2026-09-13", "cups": 5, "reminded": [10]}, "2026-09-14") == {
        "day": "2026-09-14",
        "cups": 0,
        "reminded": [],
    }




def test_builtin_plugins_only_declare_known_permissions():
    """插件声明的权限必须落在 SDK 的词汇表里——不然「权限」只是摆设。"""
    for name, spec in pp.BUILTINS.items():
        assert set(spec["permissions"]) <= set(pp.PERMISSIONS), name
        assert spec["commands"], name  # 每个内置插件至少要能被命令驱动
