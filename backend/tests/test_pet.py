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
from datetime import datetime, timedelta, timezone
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


def test_compose_gate_lines_say_what_you_did():
    """Z2（PLAN4）：点头 / 驳回各一句，主语是「你」——那是你做的一个动作。

    驳回那句必须**中性**：不打趣、不「哼」、不劝你再想想。驳回一步是正常操作，
    不是犯错；这里多带一个字的情绪，都会变成一笔「你否决了它」的账。
    """
    ok = pet.compose("gate_ok", name="周报")
    no = pet.compose("gate_rejected", name="周报")
    assert "周报" in ok and "点了头" in ok
    assert "周报" in no and "驳回" in no
    for word in ("哼", "可惜", "确定吗", "再想想", "错误", "失败", "又"):
        assert word not in no, word


def test_gate_kinds_are_registered():
    assert {"gate_ok", "gate_rejected"} <= pet.KINDS


def test_gate_lines_do_not_toast(monkeypatch):
    """Z2：这是**事件**不是提醒——你刚亲手点了那个按钮，不该再被系统吼一声。

    `emit` 的 frugal 名单只有失败 / 问候 / 到期卡 / 习惯那几种；这两个 kind 不在里面，
    所以这条测试钉的是「以后有人顺手把它们加进名单」。
    """
    import app.core.notify as notify_mod

    calls: list[tuple] = []
    monkeypatch.setattr(notify_mod, "desktop", lambda *a, **kw: calls.append(a))
    pet.emit("gate_ok", name="周报")
    pet.emit("gate_rejected", name="周报")
    assert calls == []


def test_gate_lines_go_through_the_privacy_gate():
    """任务名照旧过 `sanitize`：卡点那句也**不许把路径念出来**（三闸门不是只在老 kind 上）。"""
    pet.emit("gate_ok", name=r"D:\private\tasks\周报")
    line = pet.feed(limit=5)[0]
    assert line["kind"] == "gate_ok"
    assert "private" not in line["text"] and "[路径]" in line["text"]


def test_compose_counts():
    assert "7" in pet.compose("digest", count=7)
    assert "5" in pet.compose("feeds", count=5)


def test_compose_mastered_taught_has_its_own_line():
    """费曼模式说通的那一下，主语是「你把它讲明白了」，不是「你搞懂了」。

    这是两条不同的路：苏格拉底是它教你，费曼是你教它。同一个概念，台词不该一样。
    """
    line = pet.compose("mastered", name="asyncio 事件循环", detail="taught")
    assert "讲明白" in line and "asyncio 事件循环" in line
    assert line != pet.compose("mastered", name="asyncio 事件循环")


def test_compose_greeting_by_hour():
    assert "好" in pet.compose("greeting")
    assert "盯着" in pet.compose("greeting")


# --- Z3（PLAN4）：台词池轮换 ------------------------------------------------------


def test_pools_cover_the_high_frequency_kinds_only():
    """只给高频那几种备说法，每种 2–3 句（计划的范围就是这五个）。"""
    assert set(pet.POOLS) == {"task_done", "task_failed", "cards_done", "output", "mastered"}
    for kind, pool in pet.POOLS.items():
        assert 2 <= len(pool) <= 3, kind
        assert len(set(pool)) == len(pool), f"{kind} 的池子里有重复句"


def test_the_first_line_of_every_pool_is_the_old_line():
    """第 0 句 = 原话。所以 `compose(kind, ...)` 不传 `n` 时，一个字节都没变
    （老测试、`cards.py` 那处直接调用都还是原来那句）。"""
    samples = {
        "task_done": dict(name="T", detail="3 条要点"),
        "task_failed": dict(name="T", detail="boom"),
        "cards_done": dict(count=7, detail="3"),
        "output": dict(name="周报", count=3),
        "mastered": dict(name="闭包"),
    }
    for kind, kw in samples.items():
        assert pet.compose(kind, **kw, n=0) == pet.compose(kind, **kw), kind
        # 绕一圈回到第一句（确定性轮换，不是随机）
        assert pet.compose(kind, **kw, n=len(pet.POOLS[kind])) == pet.compose(kind, **kw), kind


def test_rotation_is_deterministic_and_covers_the_whole_pool():
    kw = dict(name="每日摘要", detail="3 条要点")
    lines = [pet.compose("task_done", **kw, n=i) for i in range(len(pet.POOLS["task_done"]))]
    assert len(set(lines)) == len(lines)  # 每一句都不同——轮换真的在轮
    for i in range(10):  # 同一个 n 永远同一句
        assert pet.compose("task_done", **kw, n=i) == lines[i % len(lines)]


def test_every_variant_still_spells_the_facts_out():
    """**只换说法，不换事实**：占位符（名字 / 数字 / 缺口 / 连着几天）逐句都得拼对。"""
    for i in range(3):
        done = pet.compose("task_done", name="每日摘要", detail="3 条要点", n=i)
        assert "每日摘要" in done and "3 条要点" in done, done
        failed = pet.compose("task_failed", name="爬虫", detail="TimeoutError", n=i)
        assert "爬虫" in failed and "TimeoutError" in failed, failed
        cards = pet.compose("cards_done", count=7, detail="3", n=i)
        assert "7" in cards and "连着 3 天" in cards, cards
        out3 = pet.compose("output", name="周报", count=3, n=i)
        assert "周报" in out3 and "第 3 份" in out3, out3
        plain = pet.compose("mastered", name="闭包", n=i)
        assert "闭包" in plain, plain


def test_the_milestone_half_never_rotates():
    """里程碑的那半句**逐字保留**——只换主句，不换事实。

    `taught`（你把它讲明白了）整句就是那个语义，一个字都不轮；「连着第二次」「第一份」
    「这是第 N 份」这些半句在每一句变体里都得原样出现。轮换只发生在主句上。
    """
    taught = {pet.compose("mastered", name="闭包", detail="taught", n=i) for i in range(6)}
    assert len(taught) == 1 and "讲明白" in taught.pop()

    for kind, kw, must in (
        ("mastered", dict(name="闭包", detail="twice"), "，这次是连着第二次说通。"),
        ("output", dict(name="周报", count=1), "第一份。"),
        ("output", dict(name="周报", count=5), "这是第 5 份。"),
    ):
        for i in range(6):
            assert must in pet.compose(kind, **kw, n=i), (kind, kw, i)


def test_output_without_a_count_does_not_invent_one():
    """数不出来（0）就不提第几份——也不许轮换出别的数字。"""
    for i in range(3):
        line = pet.compose("output", name="周报", count=0, n=i)
        assert "周报" in line and "第" not in line, line


def test_compose_survives_a_junk_rotation_index():
    for junk in (None, "不是数", -1, 3.7):
        assert pet.compose("task_done", name="T", n=junk) == pet.compose("task_done", name="T")


def test_emit_rotates_through_the_pool():
    """真行：同一个 kind 连着说，句子轮着变，绕一圈回到第一句（`feed` 是最新的在前）。"""
    pool = pet.POOLS["task_done"]
    for _ in range(len(pool)):
        pet.emit("task_done", name="轮换", detail="ok")
    got = [e["text"] for e in pet.feed(limit=len(pool))][::-1]  # 摆回说的顺序
    assert len(set(got)) == len(pool)
    assert got == [pet.compose("task_done", name="轮换", detail="ok", n=i) for i in range(len(pool))]


def test_compose_unknown_kind_falls_back():
    assert pet.compose("whatever", detail="兜底") == "兜底"


def test_compose_output_reads_the_shelf_count():
    """成品那句：主语是「你交出去的」（B1），数字是**读出来的**架子上有几份。

    「第 N 份」不是宠物发的奖，也不是它记的账——它与成长值读的是同一批目录
    （`_OUTPUT_DIRS`）。数不出来（0）就只留前半句：宁可少说一句，也不编一个数。
    """
    line = pet.compose("output", name="周报", count=3)
    assert "周报" in line and "交出去了" in line and "第 3 份" in line
    assert "第一份" in pet.compose("output", name="周报", count=1)
    bare = pet.compose("output", name="周报", count=0)
    assert "交出去了" in bare and "份" not in bare


# --- 环二表达层：成品落盘才开口（`docs/loops.md` §2）-----------------------------


def test_note_output_speaks_only_for_products(monkeypatch):
    """**「算不算成品」只有一个答案**：`is_output_path`。

    `tasks/` 的运行留痕、`notes/` 的成文都不是交出去的东西（与成长值、小屋架子同一口径），
    所以它们在零柒这里一个字都不该有——不然「你交出 N 份」和它嘴里的话会对不上。
    """
    scratch = Path(tempfile.mkdtemp(prefix="wb-pet-out-", dir=Path(__file__).parent))
    monkeypatch.setattr(pet, "VAULT_DIR", scratch)
    try:
        assert pet.note_output("周报", "deliver/2026-09-16-周报.md") is not None
        assert pet.note_output("留痕", "tasks/每日摘要-2026-09-16-0900.md") is None
        assert pet.note_output("成文", "notes/2026-09-16-随手记.md") is None
        assert pet.note_output("空", "") is None
    finally:
        shutil.rmtree(scratch, ignore_errors=True)
    lines = [e for e in pet.feed(limit=20) if e["kind"] == "output"]
    assert len(lines) == 1 and "周报" in lines[0]["text"]


def test_note_output_count_is_the_real_shelf(monkeypatch):
    """台词的数是**数出来的**，而且与成长值同一份目录清单：两份成品 → 「第 2 份」。"""
    scratch = Path(tempfile.mkdtemp(prefix="wb-pet-out-", dir=Path(__file__).parent))
    monkeypatch.setattr(pet, "VAULT_DIR", scratch)
    try:
        for rel in ("deliver/a.md", "research/b.md", "tasks/留痕.md", "notes/随手记.md"):
            p = scratch / rel
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text("# x\n", encoding="utf-8")
        pet.note_output("第二份", "research/b.md")
    finally:
        shutil.rmtree(scratch, ignore_errors=True)
    line = next(e for e in pet.feed(limit=20) if e["kind"] == "output")
    assert "第 2 份" in line["text"]  # 两份成品；`tasks/` 与 `notes/` 不算


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


# --- 本地日 vs UTC：status() 曾经整体错位一个时区 --------------------------------
#
# 库里的 `started_at` / `created_at` 是 **UTC**（`models.utcnow()` 写的），而「今天」
# 永远是**本地**的。旧写法 `LIKE '<本地日期>%'` 于是把本地 00:00–08:00 的活动算到
# 前一天、又把第二天 00:00–08:00 的算进今天。下面这几条就是那张网。


def test_local_day_utc_bounds_pins_a_known_offset():
    """把语义钉在**显式时区**上——这条测试因此与跑它的机器在哪个时区无关。

    非零偏移是关键：本地 00:00 落在 UTC 的**前一天** 16:00，正是旧写法漏掉的那一段。
    """
    tz = timezone(timedelta(hours=8))
    start, end = pet.local_day_utc_bounds(datetime(2026, 9, 14, 7, 30, tzinfo=tz))
    assert start == "2026-09-13 16:00:00.000000"
    assert end == "2026-09-14 16:00:00.000000"


def test_local_day_utc_bounds_handles_a_negative_offset():
    """西半球是反方向的偏移，别写成只顾东八区的算式。"""
    tz = timezone(timedelta(hours=-5))
    start, end = pet.local_day_utc_bounds(datetime(2026, 9, 14, 23, 0, tzinfo=tz))
    assert start == "2026-09-14 05:00:00.000000"
    assert end == "2026-09-15 05:00:00.000000"


def test_local_day_utc_bounds_naive_uses_local_midnight():
    """不传 / 传 naive：按系统本地时区，取到本地 00:00，跨度一天。"""
    start, end = pet.local_day_utc_bounds(datetime(2026, 9, 14, 15, 45))
    s = datetime.fromisoformat(start).replace(tzinfo=timezone.utc).astimezone()
    e = datetime.fromisoformat(end).replace(tzinfo=timezone.utc).astimezone()
    assert (s.hour, s.minute, s.second) == (0, 0, 0)
    assert s.date().isoformat() == "2026-09-14"
    assert (e - s).total_seconds() == 86400


def _today_at(offset: timedelta) -> datetime:
    """本地「今天 00:00」+ 偏移，返回能直接交给 ORM 的 datetime。

    给的是 **UTC 分量**：SQLite 上 `DateTime(timezone=True)` 存不下时区，ORM 写下去的
    是字面分量，而应用写的一律是 UTC（`utcnow()`）——所以这里必须与它同一条路。
    """
    start, _ = pet.local_day_utc_bounds()
    return datetime.fromisoformat(start) + offset


async def test_status_counts_a_run_from_early_local_morning():
    """**时区回归**：本地凌晨那一行必须算进「今天」。

    本地 03:00 在 UTC+8 下是**前一天 19:00**，旧的 `LIKE '<本地日期>%'` 会漏掉它。
    在偏移为 0 的机器上两种写法等价（CI 是 UTC），所以这条真正的作用是在带偏移的
    开发机上——而带偏移的机器才是这个 bug 的现场。
    """
    await _tables()
    from app.db import SessionLocal
    from app.models import TaskRun

    before = pet.status()["tasks_done"]
    async with SessionLocal() as db:
        db.add(TaskRun(task_id=1, status="ok", started_at=_today_at(timedelta(hours=3))))
        await db.commit()
    assert pet.status()["tasks_done"] == before + 1


async def test_status_ignores_early_local_morning_tomorrow():
    """对称的一半：**明天**凌晨那一行不算今天。

    少了这条，把区间写成开区间、或者干脆用 `>= 今天00:00` 也能过——而旧写法在这
    条上同样是错的（本地明天 03:00 的 UTC 串带着**今天**的日期）。
    """
    await _tables()
    from app.db import SessionLocal
    from app.models import TaskRun

    before = pet.status()["tasks_done"]
    async with SessionLocal() as db:
        db.add(TaskRun(task_id=1, status="ok", started_at=_today_at(timedelta(hours=27))))
        await db.commit()
    assert pet.status()["tasks_done"] == before


async def test_status_counts_tokens_from_early_local_morning():
    """token 走的是另一张表（`messages`），同一个坑得分别钉住。"""
    await _tables()
    from app.db import SessionLocal
    from app.models import Conversation, Message

    before = pet.status()["tokens_today"]
    async with SessionLocal() as db:
        conv = Conversation(title="t")
        db.add(conv)
        await db.flush()
        db.add(
            Message(
                conversation_id=conv.id,
                role="user",
                content="x",
                tokens_in=7,
                tokens_out=11,
                created_at=_today_at(timedelta(hours=3)),
            )
        )
        await db.commit()
    assert pet.status()["tokens_today"] == before + 18


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


def test_growth_empty_db_is_level_one_and_never_raises(monkeypatch):
    """空 DB + 空产出目录 = 1 级 0 经验。

    两个「空」都得显式造出来：conftest 的 sandbox 是**全 session 共用**的——DB 里
    已经有别的测试写的习惯/复习/任务行，产出目录里也有别的测试落的产出。不隔离的话
    「空 DB」根本不空，这条测试会随收集顺序飘（实测 exp 会是 17）。

    不用 pytest 的 `tmp_path`：这台机器的 `%TEMP%\\pytest-of-TX` 拒绝访问（WinError 5）。
    """
    scratch = Path(tempfile.mkdtemp(prefix="wb-pet-empty-", dir=Path(__file__).parent))
    monkeypatch.setattr(pet, "VAULT_DIR", scratch)
    monkeypatch.setattr(pet.settings, "db_path", scratch / "empty.db")
    try:
        g = pet.growth()
    finally:
        shutil.rmtree(scratch, ignore_errors=True)
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
    # 界面按这些 key 读明细，缺一个就是「exp 对、明细写 0」（产出数曾经就是这么漏的）
    assert {"mastered", "sessions", "runs_ok", "outputs", "habit_days", "reviews"} <= set(
        g["counts"]
    )
    assert g["level"] >= 1
    assert pet.growth()["exp"] == g["exp"]  # 累计量只增不减：再读一次不回落


# --- P2「教它」：把零柒教会是单独一条来源 -----------------------------------------


async def test_growth_counts_teaching_the_pet_as_its_own_source():
    """费曼模式说通 = 「把零柒教会」，它自己一条线，而且给得比单纯「学会」还多。"""
    await _tables()
    from app.db import SessionLocal
    from app.models import TutorSession

    before = pet.growth()["exp"]
    async with SessionLocal() as db:
        db.add_all(
            [
                TutorSession(topic="t", concept="c1", verdict="got", mode="feynman"),
                TutorSession(topic="t", concept="c2", verdict="half", mode="feynman"),
                # 苏格拉底模式是**它教你**，不算教它——这条就是区分度所在
                TutorSession(topic="t", concept="c3", verdict="got", mode="socratic"),
            ]
        )
        await db.commit()

    g = pet.growth()
    assert g["counts"]["taught"] == 1  # 只有那场 feynman 的 got
    assert g["counts"]["taught_half"] == 1
    teach = next(p for p in g["parts"] if p["key"] == "teach")
    assert teach["exp"] == pet.EXP_TAUGHT_PET + pet.EXP_TAUGHT_HALF
    assert teach["label"] == "把零柒教会"
    # 三场教学各自还进 learning 那一格（+5/场）——那不是重复计数，两件事都真发生了
    assert g["exp"] == before + teach["exp"] + 3 * pet.EXP_SESSION


def test_teaching_exp_outweighs_merely_mastering():
    """讲明白比听明白难，所以单次给得更多。数字变了要重新想一遍这条。"""
    assert pet.EXP_TAUGHT_PET > pet.EXP_MASTERED > pet.EXP_SESSION


def test_growth_thresholds_were_not_raised_for_the_new_source():
    """新增来源会让 EXP 涨得更快，等级只会往上——那是好事。

    但**把门槛调高会让已经到过的等级回落**，那违反「只增不减」。这条把门槛
    的字节钉住：P2 加了一条来源，`LEVEL_STEPS` 一个数都不许动。
    """
    assert pet.LEVEL_STEPS == (0, 120, 320, 640, 1100, 1700, 2500, 3500, 4800, 6400)


# --- B2: 能力插件（openpets 范式） ------------------------------------------------


async def test_plugins_seed_three_builtins_with_panels():
    await _tables()
    rows = await pp.list_plugins()
    names = {r["name"] for r in rows}
    assert {"water", "focus", "mood"} <= names
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


# --- 心情打卡（openpets 第三个内置插件） ------------------------------------------


def test_mood_set_read_recent_and_clear():
    st = pp.mood_set({}, "2026-09-13", 4)
    assert pp.mood_today(st, "2026-09-13") == 4
    assert pp.mood_today(st, "2026-09-12") == 0  # 没记 = 0，不是「心情 0」
    st = pp.mood_set(st, "2026-09-14", 2)
    assert pp.mood_recent(st, 14) == [
        {"day": "2026-09-13", "value": 4},
        {"day": "2026-09-14", "value": 2},
    ]
    assert [d["day"] for d in pp.mood_recent(pp.mood_clear(st, "2026-09-13"))] == ["2026-09-14"]
    for bad in (0, 6, -1, 99):
        with pytest.raises(ValueError):
            pp.mood_set({}, "2026-09-13", bad)


def test_mood_keeps_only_the_most_recent_days():
    from datetime import date, timedelta

    d0 = date(2026, 1, 1)
    st: dict = {}
    for i in range(pp.MOOD_KEEP + 5):
        st = pp.mood_set(st, (d0 + timedelta(days=i)).isoformat(), 3)
    assert len(st["days"]) == pp.MOOD_KEEP
    assert len(pp.mood_recent(st, 999)) == pp.MOOD_KEEP
    assert min(st["days"]) == (d0 + timedelta(days=5)).isoformat()  # 最旧的 5 天被丢掉


async def test_plugin_mood_command_records_today():
    await _tables()
    rows = await pp.list_plugins()
    mood = next(r for r in rows if r["name"] == "mood")
    assert mood["panel"]["kind"] == "mood" and mood["panel"]["value"] == 0
    out = await pp.command("mood", "set", {"value": 4})
    assert out["panel"]["value"] == 4
    assert out["panel"]["recent"][-1]["value"] == 4
    with pytest.raises(ValueError):
        await pp.command("mood", "set", {"value": 9})  # 越界要在写库前挡住




def test_builtin_plugins_only_declare_known_permissions():
    """插件声明的权限必须落在 SDK 的词汇表里——不然「权限」只是摆设。"""
    for name, spec in pp.BUILTINS.items():
        assert set(spec["permissions"]) <= set(pp.PERMISSIONS), name
        assert spec["commands"], name  # 每个内置插件至少要能被命令驱动


# --- 聊天落库（P5 · 加深脑子）：它记得你 ----------------------------------------


def test_chat_turn_roundtrip():
    """一问一答落进去，`recent_chats` 旧 → 新原样吐出来，回执跟着走。"""
    pet.save_chat_turn("在吗", "在。")
    pet.save_chat_turn(
        "开始专注",
        "开着了。",
        tools=[{"tool": "pet_focus_start", "plugin": "focus", "command": "start", "panel": {}, "said": None}],
    )
    chats = pet.recent_chats(4)
    assert [c["role"] for c in chats] == ["user", "pet", "user", "pet"]
    assert chats[0]["text"] == "在吗"
    assert chats[-1]["text"] == "开着了。"
    assert chats[-1]["tools"][0]["plugin"] == "focus"


def test_chat_turn_skips_incomplete_rounds():
    """报错/中断的那轮不落：只问没答、只答没问、两头全空，一个字都不进记忆。"""
    n = len(pet.recent_chats(100))
    pet.save_chat_turn("只有问", "")
    pet.save_chat_turn("", "只有答")
    pet.save_chat_turn("", "")
    assert len(pet.recent_chats(100)) == n


def test_recent_chats_survives_a_broken_db(monkeypatch, tmp_path):
    """读不出来就空表——记忆是增强项，聊天绝不因此挂掉。"""
    monkeypatch.setattr(pet.settings, "db_path", tmp_path / "no-such-dir" / "x.db")
    assert pet.recent_chats(10) == []
    pet.save_chat_turn("在吗", "在。")  # 写不进去也不能抛
