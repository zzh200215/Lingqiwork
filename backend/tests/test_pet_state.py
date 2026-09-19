"""零柒状态机（P1 · 维度一）的离线测试。

不需要模型、不需要服务：

- `energy` / `mode` / `compute` 是**纯函数**，信号直接喂进去，`now` 显式传；
- `snapshot` 那几条用一个 project-local 的 scratch DB，起真表验采集；
- 还有一条**资产对账**：映射出来的动作必须真的落在 `frontend/public/pet/` 里。

Env 必须在 import 前设好（`app.config` 在 import 时就读）。
"""
import atexit
import asyncio
import json
import os
import shutil
import sqlite3
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

sys.path.insert(0, ".")

# project-local scratch（系统 temp 在沙箱下可能不可写）
_TMP = Path(tempfile.mkdtemp(prefix="wb-petstate-", dir=Path(".").resolve()))
atexit.register(lambda: shutil.rmtree(_TMP, ignore_errors=True))

os.environ["WB_DB_PATH"] = str(_TMP / "test.db")
os.environ["WB_CONFIG_PATH"] = str(_TMP / "config.json")

from app.core import pet  # noqa: E402
from app.core import pet_state as ps  # noqa: E402

# 一个普通的下午——用它当「白天」的基准，让断言不受跑测试的钟点影响。
NOON = datetime(2026, 9, 14, 14, 0, 0)


@pytest.fixture
def scratch(monkeypatch):
    """一个空 scratch 目录 + 指向它的 db_path / VAULT_DIR。"""
    d = Path(tempfile.mkdtemp(prefix="wb-petstate-db-", dir=Path(".").resolve()))
    monkeypatch.setattr(ps.settings, "db_path", d / "t.db")
    monkeypatch.setattr(ps, "VAULT_DIR", d / "vault")
    (d / "vault").mkdir(parents=True, exist_ok=True)
    yield d
    shutil.rmtree(d, ignore_errors=True)


def _mk_messages(scratch, stamps: list[str]) -> None:
    conn = sqlite3.connect(ps.settings.db_path)
    try:
        # `IF NOT EXISTS`：同一条用例里想换一批消息时，先 `_clear_messages` 再灌，
        # 不必为了建表这件事新开一条用例（夜猫子那条用例要正反两组数据）。
        conn.execute("CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY, created_at TEXT)")
        conn.executemany("INSERT INTO messages (created_at) VALUES (?)", [(s,) for s in stamps])
        conn.commit()
    finally:
        conn.close()


def _mk_task_runs(scratch, rows: list[tuple[str, str]]) -> None:
    conn = sqlite3.connect(ps.settings.db_path)
    try:
        conn.execute("CREATE TABLE task_runs (id INTEGER PRIMARY KEY, started_at TEXT, status TEXT)")
        conn.executemany("INSERT INTO task_runs (started_at, status) VALUES (?,?)", rows)
        conn.commit()
    finally:
        conn.close()


def _mk_focus(scratch, started_at: datetime, minutes: int = 25) -> None:
    conn = sqlite3.connect(ps.settings.db_path)
    try:
        conn.execute("CREATE TABLE pet_plugins (id INTEGER PRIMARY KEY, name TEXT, storage_json TEXT)")
        conn.execute(
            "INSERT INTO pet_plugins (name, storage_json) VALUES (?,?)",
            ("focus", json.dumps({"started_at": started_at.isoformat(timespec="seconds"), "minutes": minutes})),
        )
        conn.commit()
    finally:
        conn.close()


def _utc_text(local_dt: datetime) -> str:
    """本地时刻 → ORM 那种 naive UTC 文本（`tutor_turns.created_at` 就是它）。"""
    return local_dt.astimezone(timezone.utc).replace(tzinfo=None).isoformat(sep=" ", timespec="microseconds")


def _mk_session(
    scratch,
    *,
    mode: str = "feynman",
    ended: bool = False,
    turn_at: datetime | None = None,
) -> None:
    conn = sqlite3.connect(ps.settings.db_path)
    try:
        conn.execute(
            "CREATE TABLE IF NOT EXISTS tutor_sessions "
            "(id INTEGER PRIMARY KEY, mode TEXT, ended_at TEXT)"
        )
        conn.execute(
            "CREATE TABLE IF NOT EXISTS tutor_turns "
            "(id INTEGER PRIMARY KEY, session_id INTEGER, created_at TEXT)"
        )
        conn.execute(
            "INSERT INTO tutor_sessions (mode, ended_at) VALUES (?,?)",
            (mode, "2026-01-01 00:00:00.000000" if ended else None),
        )
        sid = conn.execute("SELECT MAX(id) FROM tutor_sessions").fetchone()[0]
        if turn_at is not None:
            conn.execute(
                "INSERT INTO tutor_turns (session_id, created_at) VALUES (?,?)",
                (sid, _utc_text(turn_at)),
            )
        conn.commit()
    finally:
        conn.close()


def _mk_event(scratch, kind: str, at: datetime, detail: str = "") -> None:
    """`pet_events.created_at` 是**本地带偏移**的 ISO（`pet.emit` 那么写的）——照它写。"""
    conn = sqlite3.connect(ps.settings.db_path)
    try:
        conn.execute(
            "CREATE TABLE IF NOT EXISTS pet_events "
            "(id INTEGER PRIMARY KEY, created_at TEXT, kind TEXT, text TEXT, detail TEXT)"
        )
        conn.execute(
            "INSERT INTO pet_events (created_at, kind, text, detail) VALUES (?,?,?,?)",
            (at.astimezone().isoformat(timespec="seconds"), kind, "x", detail),
        )
        conn.commit()
    finally:
        conn.close()


# ---------- 资产对账：状态机不许指向不存在的动画 ----------


def test_every_mapped_action_is_a_real_file():
    assets = Path(__file__).resolve().parents[2] / "frontend" / "public" / "pet"
    for action in set(ps.MODE_ACTION.values()):
        assert action in ps.ACTIONS, f"{action} 不在 ACTIONS 清单里"
        assert (assets / f"{action}.webp").is_file(), f"缺动画文件 {action}.webp"


def test_p1_actually_uses_the_five_idle_assets():
    """P1 的一半价值是把**已发货但闲置**的动画用起来——这条锁住别退回去。

    此前的 `playAction` 只传过 waving / failed / review，加 idle 共四个；
    jumping / waiting / running / running-right / running-left 一个都没用过。
    """
    assets = Path(__file__).resolve().parents[2] / "frontend" / "public" / "pet"
    on_disk = {p.stem for p in assets.glob("*.webp")}
    assert on_disk == set(ps.ACTIONS)
    # 状态机用掉八个；waving 归 feed 事件与主动提醒（系统出事/你欠账 该盖过日常状态）
    assert set(ps.MODE_ACTION.values()) | {"waving"} == on_disk


def test_every_action_value_is_in_the_atlas():
    for action in ps.MODE_ACTION.values():
        assert action in ps.ACTIONS


# ---------- 优先级：顺序即「什么更值得说」----------


def test_focusing_beats_everything():
    st = ps.compute(
        {"focus_running": True, "busy": True, "fresh_output_min": 1, "idle_sec": 99999, "path": "/work"},
        NOON,
    )
    assert st["mode"] == "focusing"
    assert st["action"] == "running"


def test_celebrating_beats_busy_and_idling():
    st = ps.compute({"fresh_output_min": 2, "busy": True, "idle_sec": 600}, NOON)
    assert st["mode"] == "celebrating"
    assert st["action"] == "jumping"


def test_stale_output_is_not_a_celebration():
    """一份上周交出去的成品不该天天跳。"""
    assert ps.compute({"fresh_output_min": 60 * 24 * 7}, NOON)["mode"] == "idle"


def test_busy_beats_the_path():
    st = ps.compute({"busy": True, "path": "/tutor"}, NOON)
    assert st["mode"] == "busy"
    assert st["action"] == "running-right"


# ---------- 有活停着等你（P4 补的那一格）----------


def test_gated_beats_busy():
    """两件事同时为真时，**需要你的那件**先说话。

    「有活在跑」不需要你，「有活停着等你」需要——顺序反了就成了「它忙着呢」。
    """
    st = ps.compute({"gated": 1, "busy": True, "path": "/work"}, NOON)
    assert st["mode"] == "gated"
    assert st["action"] == "waiting"
    assert "等你点头" in st["line"]


def test_celebrating_still_beats_gated():
    """刚交出一份成品是十分钟的事，卡点是持久的事实——先喊成品那句。"""
    assert ps.compute({"gated": 1, "fresh_output_min": 1}, NOON)["mode"] == "celebrating"


def test_the_gated_line_does_not_count_what_you_owe():
    """**不报件数**：一报就成了「你还欠 N 件」的口吻，那是这个仓库封存过的机制。"""
    one = ps.compute({"gated": 1}, NOON)["line"]
    three = ps.compute({"gated": 3}, NOON)["line"]
    assert one == three == "有一步停着，等你点头。"


def test_no_gate_is_not_a_gate():
    assert ps.compute({"gated": 0, "path": "/work"}, NOON)["mode"] == "working"
    assert ps.compute({"path": "/work"}, NOON)["mode"] == "working"


def test_a_running_task_becomes_gated_at_the_gate_status(scratch):
    """状态串**只有 `tasks._GATE_STATUS` 一份**；这条走真表，锁住那个值没写错。"""
    from app.core.tasks import _GATE_STATUS

    start, _ = ps._utc_day_bounds(NOON)
    when = (datetime.fromisoformat(start) + timedelta(hours=1)).isoformat(sep=" ")
    _mk_task_runs(scratch, [(when, _GATE_STATUS)])
    st = ps.snapshot(now=NOON)
    assert st["mode"] == "gated"
    assert st["action"] == "waiting"
    assert st["gated"] == 1


# ---------- 在跑什么：`task_runs` 看不到的那一半 ----------


def test_a_running_engine_is_busy_and_names_itself(scratch):
    """页面点出来的六个引擎**不写 `task_runs`**，但它们正是「有活正在跑」的真凭据。

    （`inflight` 是进程内状态：跑完就空，重启即清。）
    """
    from app.core import inflight

    assert inflight.try_acquire("recap")
    try:
        st = ps.snapshot(now=NOON)
    finally:
        inflight.release("recap")
    assert st["mode"] == "busy"
    assert st["busy_with"] == "复盘"  # 标签来自 `mcp._ARTIFACT_KINDS`，不另抄一份
    assert "复盘正在跑" in st["line"]


def test_engine_label_falls_back_to_the_key():
    assert ps.engine_label("who-knows") == "who-knows"


def test_the_generic_busy_line_is_kept_for_nameless_runs(scratch):
    """定时任务那一跳没有名字（`task_runs` 只知道有一行在跑）——退回一句泛的。"""
    start, _ = ps._utc_day_bounds(NOON)
    when = (datetime.fromisoformat(start) + timedelta(hours=1)).isoformat(sep=" ")
    _mk_task_runs(scratch, [(when, "running")])
    st = ps.snapshot(now=NOON)
    assert st["busy_with"] == ""
    assert st["line"] == "活正在跑，我去盯着。"


def test_the_fingerprint_changes_when_work_starts_and_stops(scratch):
    """指纹只回答「有没有变化」——它是事件流决定要不要叫醒界面的依据。"""
    from app.core import inflight

    idle = ps.work_fingerprint(now=NOON)
    assert ps.work_fingerprint(now=NOON) == idle  # 没变就是没变
    assert inflight.try_acquire("decide")
    try:
        running = ps.work_fingerprint(now=NOON)
    finally:
        inflight.release("decide")
    assert running != idle and "decide" in running
    assert ps.work_fingerprint(now=NOON) == idle  # 跑完了又回到原样


def test_the_fingerprint_sees_a_gate(scratch):
    from app.core.tasks import _GATE_STATUS

    start, _ = ps._utc_day_bounds(NOON)
    when = (datetime.fromisoformat(start) + timedelta(hours=1)).isoformat(sep=" ")
    _mk_task_runs(scratch, [(when, _GATE_STATUS)])
    assert "gated:1" in ps.work_fingerprint(now=NOON)


def test_a_broken_db_does_not_break_the_fingerprint(scratch, monkeypatch):
    junk = scratch / "junk.db"
    junk.write_text("this is not a database", encoding="utf-8")
    monkeypatch.setattr(ps.settings, "db_path", junk)
    assert isinstance(ps.work_fingerprint(now=NOON), str)  # 不抛，最多多刷一次


def test_being_away_beats_the_path():
    """人在 /work 页发呆 20 分钟，零柒该显示无聊，而不是假装你还在干活。"""
    st = ps.compute({"idle_sec": 20 * 60, "path": "/work"}, NOON)
    assert st["mode"] == "idling"
    assert st["action"] == "waiting"


def test_long_absence_walks_off_to_rest():
    st = ps.compute({"idle_sec": 90 * 60, "path": "/work"}, NOON)
    assert st["mode"] == "resting"
    assert st["action"] == "running-left"


def test_five_minutes_is_the_line():
    assert ps.compute({"idle_sec": 300}, NOON)["mode"] == "idling"
    assert ps.compute({"idle_sec": 299}, NOON)["mode"] == "idle"


def test_frontend_idle_beats_the_server_clock():
    """前端知道你刚动过鼠标，服务端的「距上次消息」就不该说话。"""
    st = ps.compute({"idle_sec": 10 * 60, "last_activity_sec": 1}, NOON)
    assert st["mode"] == "idling"


def test_path_picks_the_module():
    assert ps.compute({"path": "/tutor"}, NOON)["mode"] == "learning"
    assert ps.compute({"path": "/review"}, NOON)["mode"] == "reviewing"
    assert ps.compute({"path": "/work?tab=engine"}, NOON)["mode"] == "working"
    assert ps.compute({"path": "/assets"}, NOON)["mode"] == "idle"


def test_unknown_idle_means_do_not_judge():
    """不知道你走没走 ≠ 你不在。宁可显示 idle，也不要误报「你摸鱼了」。"""
    st = ps.compute({}, NOON)
    assert st["mode"] == "idle"
    assert st["action"] == "idle"


# ---------- 精力：此刻，不是账本 ----------


def test_tired_is_reachable_in_the_middle_of_the_day():
    """`FATIGUE_CAP` 曾经高到 `tired` 永远命中不了——夜里先被 sleepy 截走，白天跌不破。
    这条锁住那个坑：封顶必须低于 `100 - LOW_ENERGY`。"""
    st = ps.compute({"active_span_min": 600}, NOON)
    assert st["mode"] == "tired"
    assert st["action"] == "failed"
    assert st["line"]


def test_sleepy_beats_tired_at_night():
    late = datetime(2026, 9, 14, 23, 30)
    assert ps.compute({"active_span_min": 600}, late)["mode"] == "sleepy"


def test_energy_does_not_accumulate_across_calls():
    """「此刻不记账」：连算十次必须和算一次一样。这条直接锁住拍板的口径。"""
    sig = {"active_span_min": 300, "idle_sec": 0}
    assert len({ps.energy(sig, NOON) for _ in range(10)}) == 1


def test_minutes_are_not_divided_by_sixty():
    """单位坑回归：`active_span_min` / `fresh_output_min` **本来就是分钟**。

    早先误用了「秒 → 分钟」的换算，600 分钟的一天被算成 10 分钟，
    所有疲劳都被除了 60，`tired` 于是永远命中不了。
    """
    # 600 分钟 × 0.12 = 72 → 撞 FATIGUE_CAP 65 → 100 - 65 = 35
    assert ps.energy({"active_span_min": 600}, NOON) == 35
    assert ps.energy({"active_span_min": 60}, NOON) == pytest.approx(100 - 7.2, abs=1)


def test_the_celebration_window_is_measured_in_minutes():
    assert ps.compute({"fresh_output_min": ps.CELEBRATE_MIN - 1}, NOON)["mode"] == "celebrating"
    assert ps.compute({"fresh_output_min": ps.CELEBRATE_MIN + 1}, NOON)["mode"] == "idle"
    # 五小时前交出去的东西不该现在才跳（这条在单位坑里是错的，但当时没测）
    assert ps.compute({"fresh_output_min": 300}, NOON)["mode"] == "idle"


def test_energy_recovers_while_you_are_away():
    busy = ps.energy({"active_span_min": 300}, NOON)
    rested = ps.energy({"active_span_min": 300, "idle_sec": 1800}, NOON)
    assert rested > busy


def test_energy_stays_inside_zero_and_hundred():
    for span in (0, 10, 1000, 100000, -5):
        for idle in (None, 0, 100, 100000):
            e = ps.energy({"active_span_min": span, "idle_sec": idle}, NOON)
            assert 0 <= e <= 100


def test_a_full_day_without_a_break_is_tiring():
    assert ps.energy({"active_span_min": 600}, NOON) < ps.energy({"active_span_min": 60}, NOON)


def test_garbage_signals_do_not_raise():
    """信号来自 DB / HTTP 参数，什么都可能。坏值一律当「不知道」，不许抛。"""
    for junk in ("abc", [], {}, object(), None):
        st = ps.compute({"active_span_min": junk, "idle_sec": junk, "path": junk}, NOON)
        assert st["action"] in ps.ACTIONS
        assert 0 <= st["energy"] <= 100


# ---------- 信号采集：真库、真表 ----------


def test_empty_db_is_idle_and_never_raises(scratch):
    st = ps.snapshot(now=NOON)
    assert st["mode"] == "idle"
    assert st["action"] == "idle"
    assert st["line"] == ""  # 克制：安静是默认
    assert 0 <= st["energy"] <= 100


def test_a_broken_db_degrades_instead_of_raising(scratch, monkeypatch):
    """库文件坏了不是 500 的理由——零柒就安静待着。"""
    junk = scratch / "junk.db"
    junk.write_text("this is not a database", encoding="utf-8")
    monkeypatch.setattr(ps.settings, "db_path", junk)
    st = ps.snapshot(now=NOON)
    assert st["mode"] == "idle"


def test_messages_give_activity_span_and_age(scratch):
    start, _ = ps._utc_day_bounds(NOON)
    t0 = datetime.fromisoformat(start) + timedelta(hours=1)
    t1 = t0 + timedelta(hours=2)
    _mk_messages(scratch, [t0.isoformat(sep=" "), t1.isoformat(sep=" ")])

    sig = ps._signals(now=NOON)
    assert sig["active_span_min"] == pytest.approx(120.0)
    # 两头都在 UTC 里比：本地 now 换算成 UTC 再减，否则差一个时区偏移
    now_utc = NOON.astimezone(timezone.utc).replace(tzinfo=None)
    assert sig["last_activity_sec"] == pytest.approx((now_utc - t1).total_seconds(), abs=1)


def test_messages_outside_today_are_ignored(scratch):
    start, _ = ps._utc_day_bounds(NOON)
    yesterday = datetime.fromisoformat(start) - timedelta(hours=2)
    _mk_messages(scratch, [yesterday.isoformat(sep=" ")])
    assert "active_span_min" not in ps._signals(now=NOON)


def test_running_task_becomes_busy(scratch):
    start, _ = ps._utc_day_bounds(NOON)
    when = (datetime.fromisoformat(start) + timedelta(hours=1)).isoformat(sep=" ")
    _mk_task_runs(scratch, [(when, "running")])
    st = ps.snapshot(now=NOON)
    assert st["mode"] == "busy"
    assert st["action"] == "running-right"


def test_task_counts_are_read_from_the_local_day(scratch):
    """本地「今天」要换算成 UTC 区间去查——`LIKE '<本地日期>%'` 在 UTC+8 下
    会把本地 00:00–08:00 的活动算到前一天。"""
    start, end = ps._utc_day_bounds(NOON)
    inside = (datetime.fromisoformat(start) + timedelta(minutes=30)).isoformat(sep=" ")
    before = (datetime.fromisoformat(start) - timedelta(minutes=30)).isoformat(sep=" ")
    _mk_task_runs(scratch, [(inside, "ok"), (before, "ok"), (inside, "error")])
    sig = ps._signals(now=NOON)
    assert sig["tasks_done"] == 1
    assert sig["tasks_failed"] == 1
    assert datetime.fromisoformat(end) > datetime.fromisoformat(inside)


def test_the_day_bounds_conversion_has_one_home():
    """这个换算**只能有一份**。

    `pet.status()` 与本模块原先各写了一份，而老那份是错的（拿本地日期串去 LIKE
    UTC 的列）——两份实现就是这个坑的来源。这条锁住「只有一个出处」。
    """
    tz = timezone(timedelta(hours=8))
    now = datetime(2026, 9, 14, 7, 30, tzinfo=tz)
    assert ps._utc_day_bounds(now) == pet.local_day_utc_bounds(now)
    assert ps._utc_day_bounds(now) == ("2026-09-13 16:00:00.000000", "2026-09-14 16:00:00.000000")


def test_focus_in_plugin_storage_becomes_focusing(scratch):
    _mk_focus(scratch, NOON - timedelta(minutes=5), minutes=25)
    st = ps.snapshot(now=NOON)
    assert st["mode"] == "focusing"
    assert st["action"] == "running"


def test_finished_focus_is_not_focusing(scratch):
    _mk_focus(scratch, NOON - timedelta(minutes=90), minutes=25)
    assert ps.snapshot(now=NOON)["mode"] != "focusing"


def test_a_fresh_output_file_is_a_celebration(scratch):
    d = ps.VAULT_DIR / "research"
    d.mkdir(parents=True)
    f = d / "x.md"
    f.write_text("hi", encoding="utf-8")
    ts = NOON.timestamp()
    os.utime(f, (ts, ts))
    st = ps.snapshot(now=NOON)
    assert st["mode"] == "celebrating"
    assert st["action"] == "jumping"


def test_a_yesterdays_output_file_is_not_a_celebration(scratch):
    d = ps.VAULT_DIR / "recap"
    d.mkdir(parents=True)
    f = d / "y.md"
    f.write_text("hi", encoding="utf-8")
    ts = (NOON - timedelta(days=1)).timestamp()
    os.utime(f, (ts, ts))
    assert ps.snapshot(now=NOON)["mode"] == "idle"


# ---------- P2「教它」：你讲给它听的时候 --------------------------------


def test_an_open_feynman_session_puts_the_pet_in_pupil(scratch):
    """有一场费曼会话开着、最近还动过 → 零柒摆出「我在听」。"""
    _mk_session(scratch, turn_at=NOON - timedelta(minutes=5))
    st = ps.snapshot(now=NOON)
    assert st["mode"] == "pupil"
    assert st["action"] == "waiting"
    assert st["line"] == "我在听。你讲。"


def test_a_finished_session_is_not_pupil(scratch):
    _mk_session(scratch, ended=True, turn_at=NOON - timedelta(minutes=5))
    assert ps.snapshot(now=NOON)["mode"] != "pupil"


def test_a_stale_session_is_not_pupil(scratch):
    """开了没关的旧会话（关了标签页就走了）不该让零柒永远假装在听。"""
    _mk_session(scratch, turn_at=NOON - timedelta(minutes=ps.PUPIL_WINDOW_MIN + 5))
    assert ps.snapshot(now=NOON)["mode"] != "pupil"


def test_a_socratic_session_is_not_pupil(scratch):
    """苏格拉底模式是**它教你**——那时候该认真听的是你，不是它。"""
    _mk_session(scratch, mode="socratic", turn_at=NOON - timedelta(minutes=5))
    assert ps.snapshot(now=NOON)["mode"] != "pupil"


def test_walking_away_beats_listening(scratch):
    """讲解中走开 20 分钟，零柒该显示无聊，而不是一直假装在听。"""
    _mk_session(scratch, turn_at=NOON - timedelta(minutes=5))
    assert ps.snapshot(idle_sec=20 * 60, now=NOON)["mode"] == "idling"


def test_a_fresh_mastery_makes_the_pet_jump(scratch):
    """刚说通一个概念（含「你讲给它听」）→ 它自己跳一下。

    P2 之前 `celebrating` 只认产出文件，所以教完零柒它毫无反应。
    """
    _mk_event(scratch, "mastered", NOON - timedelta(minutes=3))
    st = ps.snapshot(now=NOON)
    assert st["mode"] == "celebrating"
    assert st["action"] == "jumping"


def test_a_stale_mastery_is_not_a_celebration(scratch):
    _mk_event(scratch, "mastered", NOON - timedelta(hours=5))
    assert ps.snapshot(now=NOON)["mode"] != "celebrating"


def test_a_failure_event_is_not_a_celebration(scratch):
    """只有 `mastered` 算喜事——`task_failed` 之类的进同一张表，别一起跳了。"""
    _mk_event(scratch, "task_failed", NOON - timedelta(minutes=3))
    assert ps.snapshot(now=NOON)["mode"] != "celebrating"


def test_the_celebration_line_follows_the_reason(scratch):
    """台词要跟着**原因**走。

    这条是 P2 的**视觉验收抓出来的**：当时零柒因为「说通一个概念」跳起来，却说
    「交出去一份。收着。」——那是产出文件的台词，张冠李戴。
    """
    _mk_event(scratch, "mastered", NOON - timedelta(minutes=3), detail="taught")
    assert ps.snapshot(now=NOON)["line"] == "你讲明白了。我记住了。"


def test_a_socratic_mastery_gets_its_own_celebration_line(scratch):
    """你说通的是自己（苏格拉底：它教你）——那时不该说「你讲明白了」。"""
    _mk_event(scratch, "mastered", NOON - timedelta(minutes=3))
    assert ps.snapshot(now=NOON)["line"] == "你搞懂了。记一笔。"


def test_an_output_wins_the_celebration_line(scratch):
    """两件同时发生：产出优先，因为它是到手的成果。"""
    d = ps.VAULT_DIR / "research"
    d.mkdir(parents=True, exist_ok=True)
    f = d / "x.md"
    f.write_text("hi", encoding="utf-8")
    ts = NOON.timestamp()
    os.utime(f, (ts, ts))
    _mk_event(scratch, "mastered", NOON - timedelta(minutes=3), detail="taught")
    assert ps.snapshot(now=NOON)["line"] == "交出去一份。收着。"


# ---------- 路由：参数真的接上了 ----------


def test_state_route_returns_the_documented_shape(scratch):
    from app.routers import pet as pet_router

    out = asyncio.run(pet_router.pet_state(idle_sec=None, path="/work"))
    assert set(out) == {"mode", "action", "energy", "line", "path", "busy_with", "gated"}
    assert out["mode"] == "working"


def test_state_route_truncates_the_path(scratch):
    """`path` 是查询参数，长度不可控——只留前缀匹配够用的那 100 个字符。"""
    from app.routers import pet as pet_router

    out = asyncio.run(pet_router.pet_state(idle_sec=None, path="/" + "x" * 500))
    assert len(out["path"]) == 100


def test_state_route_does_not_echo_a_path_it_was_not_given(scratch):
    from app.routers import pet as pet_router

    assert asyncio.run(pet_router.pet_state(idle_sec=None, path=""))["path"] == ""


def test_state_endpoint_is_served_over_http(scratch, monkeypatch):
    """真的挂上了路由、真的解析了查询参数——**直接调函数验不出注册这一层**。

    照 `test_auth.py` 的路子：不进 TestClient 的上下文管理器（那会跑 lifespan：
    模型预热、watcher、调度器，这里一样都不需要），但请求仍然过鉴权中间件。
    """
    from fastapi.testclient import TestClient

    from app.core import auth

    monkeypatch.setenv("WB_API_TOKEN", "test-token-123")
    monkeypatch.setattr(auth, "_cached", None)
    from app.main import app

    c = TestClient(app)
    r = c.get(
        "/api/pet/state",
        params={"idle_sec": 0, "path": "/tutor"},
        headers={auth.HEADER: "test-token-123"},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["mode"] == "learning"
    assert body["action"] == "review"
    assert set(body) == {"mode", "action", "energy", "line", "path", "busy_with", "gated"}


def test_state_endpoint_is_token_guarded(scratch, monkeypatch):
    from fastapi.testclient import TestClient

    from app.core import auth

    monkeypatch.setenv("WB_API_TOKEN", "test-token-123")
    monkeypatch.setattr(auth, "_cached", None)
    from app.main import app

    assert TestClient(app).get("/api/pet/state").status_code == 401


# ---------- 事件流（SSE）：有事发生就立刻说 ----------


def _seed_event(scratch, text: str) -> int:
    """往 `pet_events` 塞一行台词，返回它的 id（`since_id` 就是按它筛的）。"""
    conn = sqlite3.connect(ps.settings.db_path)
    try:
        conn.execute(
            "CREATE TABLE IF NOT EXISTS pet_events "
            "(id INTEGER PRIMARY KEY, created_at TEXT, kind TEXT, text TEXT, detail TEXT, "
            "name TEXT DEFAULT '')"
        )
        cur = conn.execute(
            "INSERT INTO pet_events (created_at, kind, text, detail) VALUES (?,?,?,?)",
            (datetime.now().astimezone().isoformat(timespec="seconds"), "task_done", text, ""),
        )
        conn.commit()
        return int(cur.lastrowid or 0)
    finally:
        conn.close()


def _fast_stream(monkeypatch) -> None:
    """把 2 秒的空转压成 10 毫秒——这条流是**无限**的，测试只取头几帧。"""
    from app.routers import pet as pet_router

    monkeypatch.setattr(pet_router, "PET_STREAM_POLL", 0.01)
    monkeypatch.setattr(pet_router, "PET_STREAM_PING", 0.03)


def _frames(gen, n: int) -> list[str]:
    async def _go() -> list[str]:
        out: list[str] = []
        try:
            async for f in gen:
                out.append(f)
                if len(out) >= n:
                    break
        finally:
            await gen.aclose()
        return out

    return asyncio.run(_go())


def test_the_stream_says_hello_with_the_poll_interval(scratch, monkeypatch):
    from app.routers import pet as pet_router

    _fast_stream(monkeypatch)
    first = _frames(pet_router._pet_stream(0), 1)[0]
    assert first.startswith("event: hello\n")
    assert '"poll"' in first


def test_the_stream_pushes_new_lines_in_the_order_they_were_said(scratch, monkeypatch):
    """两条新台词一次送出去时**按说的顺序**（`feed` 是最新在前，直接转发会把话倒着说）。"""
    from app.routers import pet as pet_router

    _fast_stream(monkeypatch)
    _seed_event(scratch, "第一句")
    _seed_event(scratch, "第二句")

    frames = _frames(pet_router._pet_stream(0), 3)
    assert frames[0].startswith("event: hello")
    assert "第一句" in frames[1] and "第二句" in frames[2]


def test_the_stream_does_not_replay_what_you_already_have(scratch, monkeypatch):
    """`since_id` 之后才有话说；没有新东西时只发注释心跳（客户端会跳过它）。"""
    from app.routers import pet as pet_router

    _fast_stream(monkeypatch)
    last = _seed_event(scratch, "已经看过了")
    frames = _frames(pet_router._pet_stream(last), 2)
    assert "已经看过了" not in "".join(frames)
    assert frames[1].startswith(": ping")


def test_the_stream_tells_the_client_when_work_starts(scratch, monkeypatch):
    """有活开始跑 → 一条 `work` ——界面据此立刻重算状态，不用等下一个 15 秒。"""
    from app.core import inflight

    from app.routers import pet as pet_router

    _fast_stream(monkeypatch)

    async def _go() -> list[str]:
        gen = pet_router._pet_stream(0)
        out = [await gen.__anext__()]  # hello（此刻没有活）
        assert inflight.try_acquire("research")
        try:
            out.append(await gen.__anext__())  # work（有活开始跑了）
        finally:
            inflight.release("research")
            await gen.aclose()
        return out

    frames = asyncio.run(_go())
    assert frames[0].startswith("event: hello")
    assert frames[1].startswith("event: work")
    assert "research" in frames[1]


def test_the_stream_route_is_mounted_and_guarded(scratch, monkeypatch):
    """路由真的挂上了、真的过鉴权。

    **通的那半条刻意不在这儿验**：`TestClient` 会把整个响应体收完才把控制权还给你，
    而这条流是无限的——`next(iter_lines())` 就是挂在那儿（实测 300 秒不返回）。
    生成器本身由上面几条直接驱动（`_frames`）覆盖；浏览器那条路与既有的
    `/api/pet/chat` 是同一种 `StreamingResponse`，那条已经在用。
    """
    from fastapi.testclient import TestClient

    from app.core import auth

    monkeypatch.setenv("WB_API_TOKEN", "test-token-123")
    monkeypatch.setattr(auth, "_cached", None)
    from app.main import app

    assert "/api/pet/stream" in app.openapi()["paths"]  # 走 FastAPI 自己的路由表
    assert TestClient(app).get("/api/pet/stream").status_code == 401


# ---------- P2 · 夜猫子信号：连着三个晚上过十点，它就蔫 ----------
#
# 口径两条，都在这里钉死：**只看已结束的日子**（今天 22:00 后这件事今天还没发生），
# **只看 `messages` 一个来源**（一个模块里「活跃」只有一个意思）。


def _at(days_ago: int, hour: int, minute: int = 0) -> str:
    """`days_ago` 天前的**本地** `hour:minute` → 库里那种 naive UTC 文本。"""
    d = (datetime.now().astimezone() - timedelta(days=days_ago)).replace(
        hour=hour, minute=minute, second=0, microsecond=0
    )
    return _utc_text(d)


def _clear_messages(scratch) -> None:
    """同一条用例里要换一批消息时用：`_mk_messages` 建表不带 `IF NOT EXISTS`。"""
    conn = sqlite3.connect(ps.settings.db_path)
    try:
        conn.execute("DELETE FROM messages")
        conn.commit()
    finally:
        conn.close()


def test_is_late_night_reads_the_local_hour():
    """22:00 这条线按**本地**时刻判（库里存的是 naive UTC，差一个时区就会判反）。"""
    late = datetime(2026, 9, 14, 22, 0).astimezone(timezone.utc).replace(tzinfo=None)
    early = datetime(2026, 9, 14, 21, 59).astimezone(timezone.utc).replace(tzinfo=None)
    assert ps.is_late_night(late) is True
    assert ps.is_late_night(early) is False
    # 那天一条活动都没有 → **不算**：没开过工作台的那天，凭什么说人家熬夜
    assert ps.is_late_night(None) is False


def test_is_night_owl_needs_three_nights_in_a_row():
    assert ps.is_night_owl([True, True, True]) is True
    assert ps.is_night_owl([True, True, False]) is False  # 中间断一晚就不算
    assert ps.is_night_owl([False, True, True]) is False
    assert ps.is_night_owl([True, True]) is False  # 还不够三天
    assert ps.is_night_owl([]) is False


def test_is_night_owl_only_looks_at_the_last_three():
    """更早熬过的夜不算数——作息说的是**最近**，不是历史。"""
    assert ps.is_night_owl([False, False, True, True, True]) is True


def test_three_late_nights_and_it_slumps(scratch):
    _mk_messages(scratch, [_at(1, 23), _at(2, 22, 30), _at(3, 23, 45)])
    now = datetime.now().astimezone().replace(hour=14, minute=0, second=0, microsecond=0)

    st = ps.snapshot(now=now)
    assert st["mode"] == "night_owl"
    assert st["action"] == "failed"  # 蔫：与 `tired` 同一个姿势，靠台词区分
    assert "蔫" in st["line"]
    # 事实是无主语的陈述，**没有劝、没有算账**
    for bad in ("早睡", "该睡", "还欠", "连续 3", "注意身体"):
        assert bad not in st["line"]


def test_tonight_does_not_count_until_it_is_over(scratch):
    """今天 22:00 之后这件事，在今天还没过完时不算一格——不然这个信号白天永远为假。"""
    _mk_messages(scratch, [_at(0, 23), _at(1, 23), _at(2, 23)])  # 缺的是前天那一格
    now = datetime.now().astimezone().replace(hour=14, minute=0, second=0, microsecond=0)
    assert ps.snapshot(now=now)["mode"] != "night_owl"
    assert ps.snapshot(now=now)["mode"] == "sleepy" or ps.snapshot(now=now)["mode"] == "idle"


def test_a_quiet_evening_breaks_the_streak(scratch):
    """前天/昨天都晚，大前天十点前就收了 → 断了一晚，不算。"""
    _mk_messages(scratch, [_at(1, 23), _at(2, 23), _at(3, 20)])
    now = datetime.now().astimezone().replace(hour=14, minute=0, second=0, microsecond=0)
    assert ps.snapshot(now=now)["mode"] != "night_owl"


def test_a_day_with_no_activity_at_all_breaks_the_streak(scratch):
    _mk_messages(scratch, [_at(1, 23), _at(3, 23)])  # 前天一条都没有
    now = datetime.now().astimezone().replace(hour=14, minute=0, second=0, microsecond=0)
    assert ps.snapshot(now=now)["mode"] != "night_owl"


def test_ten_pm_sharp_counts_and_2159_does_not(scratch):
    now = datetime.now().astimezone().replace(hour=14, minute=0, second=0, microsecond=0)
    _mk_messages(scratch, [_at(1, 22), _at(2, 22), _at(3, 22)])
    assert ps.snapshot(now=now)["mode"] == "night_owl"

    _clear_messages(scratch)
    _mk_messages(scratch, [_at(1, 21, 59), _at(2, 21, 59), _at(3, 21, 59)])
    assert ps.snapshot(now=now)["mode"] != "night_owl"


def test_night_owl_beats_tired_but_not_tonight(scratch):
    """顺序即优先级：连着晚睡压过「今天坐太久了」，但压不过「此刻就是深夜」。"""
    assert ps.compute({"night_owl": True, "active_span_min": 600}, NOON)["mode"] == "night_owl"
    late = datetime(2026, 9, 14, 23, 30)
    assert ps.compute({"night_owl": True, "active_span_min": 600}, late)["mode"] == "sleepy"
    # 有活停着等你／在跑，照样盖过它
    assert ps.compute({"night_owl": True, "gated": 1}, NOON)["mode"] == "gated"
    assert ps.compute({"night_owl": True, "busy": True}, NOON)["mode"] == "busy"


def test_the_night_owl_says_nothing_out_loud(scratch):
    """🚩 纯派生、**不发通知**：算一遍状态，宠物那边一个字都不该多出来。"""
    _mk_messages(scratch, [_at(1, 23), _at(2, 23), _at(3, 23)])
    now = datetime.now().astimezone().replace(hour=14, minute=0, second=0, microsecond=0)
    assert ps.snapshot(now=now)["mode"] == "night_owl"
    assert pet.feed(limit=20) == []


# ---------- 久别重逢（P5）：好几天没来，它认得这趟是回来 ----------


def test_returning_beats_the_path_and_idle():
    st = ps.compute({"away_days": 5, "away_topic": "asyncio 事件循环", "path": "/work"}, NOON)
    assert st["mode"] == "returning"
    assert st["action"] == "waving"  # 挥手是问候的姿势——和 feed 事件共用同一个素材
    assert "5 天没见" in st["line"]
    assert "asyncio 事件循环" in st["line"]


def test_returning_without_a_topic_stays_dry():
    """拆点不在离开前后那阵子就不提——「N 天没见」单摆着，也不替记忆编一句。"""
    assert ps.compute({"away_days": 12}, NOON)["line"] == "12 天没见。"


def test_busy_still_beats_returning():
    assert ps.compute({"away_days": 5, "busy": True}, NOON)["mode"] == "busy"
    assert ps.compute({"away_days": 5, "gated": 1}, NOON)["mode"] == "gated"
    assert ps.compute({"away_days": 5, "focus_running": True}, NOON)["mode"] == "focusing"


def test_mode_trusts_the_collector_on_away_days():
    """「几天算久别」的门槛在 `_away`（采集层）；`mode()` 只认「有没有这个信号」。"""
    assert ps.compute({"away_days": 2}, NOON)["mode"] == "returning"


def test_five_days_away_becomes_a_reunion(scratch):
    """真库采集：最后一次活动是 5 天前 → returning，并带上「走的时候在拆什么」。"""
    now = datetime.now().astimezone().replace(hour=14, minute=0, second=0, microsecond=0)
    _mk_messages(scratch, [_utc_text(now - timedelta(days=5))])
    # 拆点就发生在离开那天——它才有资格当「走的时候你在拆的」
    conn = sqlite3.connect(ps.settings.db_path)
    try:
        conn.execute(
            "CREATE TABLE IF NOT EXISTS digest_points "
            "(id INTEGER PRIMARY KEY, point TEXT, created_at TEXT)"
        )
        conn.execute(
            "INSERT INTO digest_points (point, created_at) VALUES (?,?)",
            ("asyncio 事件循环", _utc_text(now - timedelta(days=5) + timedelta(minutes=30))),
        )
        conn.commit()
    finally:
        conn.close()
    st = ps.snapshot(now=now)
    assert st["mode"] == "returning"
    assert "5 天没见" in st["line"]
    assert "asyncio 事件循环" in st["line"]


def test_away_threshold_is_two_days(scratch):
    """36 小时前还在 → 不算重逢（那叫摸鱼）。门槛钉在 `AWAY_DAYS=2` 天。"""
    now = datetime.now().astimezone().replace(hour=14, minute=0, second=0, microsecond=0)
    _mk_messages(scratch, [_utc_text(now - timedelta(hours=36))])
    assert ps.snapshot(now=now)["mode"] != "returning"


def test_chatting_with_the_pet_counts_as_showing_up(scratch):
    """跟零柒聊过天就算来过——只聊天不记笔记的人，不该被说「没见」。"""
    now = datetime.now().astimezone().replace(hour=14, minute=0, second=0, microsecond=0)
    _mk_messages(scratch, [_utc_text(now - timedelta(days=9))])
    pet.save_chat_turn("在吗", "在。")  # 刚聊过：pet_chats 才是最近的来过
    assert ps.snapshot(now=now)["mode"] != "returning"
