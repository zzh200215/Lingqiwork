"""P4 · 零柒的小屋：门槛判定、三种时间口径、今天喂了它什么。

这一层最容易出的不是逻辑错，是**时间错**（这个仓库已经踩过三次：naive UTC 的 ORM 列、
本地 aware 的 `pet_events`、本地日历日的 `habit_logs.day`）。所以下面有一组测试专门把
三种口径钉在**显式时区**上——与跑测试的机器在哪个时区无关。

全部离线：不调模型，只碰一个临时库与一个临时 vault。
"""
import atexit
import os
import shutil
import sqlite3
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

sys.path.insert(0, ".")

# 项目内 scratch（系统 temp 在某些沙箱里写不了），跑完自己删
_TMP = Path(tempfile.mkdtemp(prefix="wb-room-", dir=Path(".").resolve()))
_DB = _TMP / "room.db"
_VAULT = _TMP / "vault"


def _cleanup() -> None:
    shutil.rmtree(_TMP, ignore_errors=True)


atexit.register(_cleanup)

# 必须在 app.* 导入之前：app.config 在导入时就把这些读成常量了
os.environ["WB_DB_PATH"] = str(_DB)
os.environ["WB_CONFIG_PATH"] = str(_TMP / "config.json")
os.environ["WB_VAULT_DIR"] = str(_VAULT)
os.environ["WB_DATA_DIR"] = str(_TMP / "data")

from app.config import settings  # noqa: E402
from app.core import pet  # noqa: E402
from app.core import pet_room as pr  # noqa: E402

TZ = timezone(timedelta(hours=8))  # 本机偏移；测试里一律显式传，不依赖系统

_DDL = (
    "CREATE TABLE IF NOT EXISTS task_runs (id INTEGER PRIMARY KEY, started_at TEXT, status TEXT)",
    "CREATE TABLE IF NOT EXISTS card_reviews (id INTEGER PRIMARY KEY, reviewed_at TEXT)",
    "CREATE TABLE IF NOT EXISTS habit_logs (id INTEGER PRIMARY KEY, day TEXT)",
    "CREATE TABLE IF NOT EXISTS tutor_sessions ("
    "id INTEGER PRIMARY KEY, mode TEXT, verdict TEXT, ended_at TEXT,"
    " created_at TEXT, concept TEXT)",
    "CREATE TABLE IF NOT EXISTS pet_events ("
    "id INTEGER PRIMARY KEY, created_at TEXT, kind TEXT, text TEXT, detail TEXT)",
)

_TABLES = ("task_runs", "card_reviews", "habit_logs", "tutor_sessions", "pet_events")


def _db():
    conn = sqlite3.connect(_DB)
    for stmt in _DDL:
        conn.execute(stmt)
    return conn


@pytest.fixture(autouse=True)
def _clean():
    conn = _db()
    for t in _TABLES:
        conn.execute(f"DELETE FROM {t}")  # noqa: S608 - 表名是本地常量
    conn.commit()
    conn.close()
    shutil.rmtree(_VAULT, ignore_errors=True)
    (_VAULT / "deliver").mkdir(parents=True, exist_ok=True)
    yield


def _output(name: str, when: datetime, d: str = "deliver") -> Path:
    """落一份产出，并把 mtime 摆到指定时刻（mtime 是**本地 epoch**）。"""
    p = _VAULT / d
    p.mkdir(parents=True, exist_ok=True)
    f = p / name
    f.write_text(f"# {name}\n", encoding="utf-8")
    ts = when.timestamp()
    os.utime(f, (ts, ts))
    return f


def _insert(table: str, **cols) -> None:
    conn = _db()
    names = ", ".join(cols)
    marks = ", ".join("?" for _ in cols)
    conn.execute(f"INSERT INTO {table} ({names}) VALUES ({marks})", tuple(cols.values()))  # noqa: S608
    conn.commit()
    conn.close()


# --- 门槛表本身：它是一份声明，改坏了要在这里被拦下 ------------------------------


def test_every_ladder_starts_at_one_and_is_ordered():
    for lad in pr.LADDERS:
        ns = [t.n for t in lad.tiers]
        assert ns == sorted(ns), lad.key
        assert len(set(ns)) == len(ns), lad.key
        assert ns[0] == 1, lad.key  # 第一档永远是 badge（「第一次」那一下）


def test_every_tier_is_renderable():
    for lad in pr.LADDERS:
        assert lad.key in pr.MEALS, lad.key  # 投喂清单也得认识这条线
        assert lad.module in pr.MODULES, lad.module
        assert lad.unit
        for t in lad.tiers:
            assert t.icon and t.label
            assert t.kind in ("badge", "prop")


def test_first_tier_of_each_ladder_is_a_badge():
    for lad in pr.LADDERS:
        assert lad.tiers[0].kind == "badge", lad.key
        assert all(t.kind == "prop" for t in lad.tiers[1:]), lad.key


def test_ids_are_unique_across_the_whole_room():
    ids = [f"{lad.key}:{t.n}" for lad in pr.LADDERS for t in lad.tiers]
    assert len(ids) == len(set(ids))


# --- 三种时间口径：三条纯函数各钉一条 --------------------------------------------


def test_parse_utc_text_treats_a_naive_value_as_utc():
    dt = pr._parse_utc_text("2026-09-13 18:00:00.000000")
    assert dt == datetime(2026, 9, 13, 18, 0, tzinfo=timezone.utc)


def test_parse_utc_text_keeps_an_explicit_offset():
    """带偏移的 ISO（`models.iso_utc` 的产出）解析出什么就是什么——
    绝不能因为「这一列是 UTC」就再套一次 UTC，那会把一个正确的时刻挪两次。"""
    dt = pr._parse_utc_text("2026-09-14T02:00:00+08:00")
    assert dt == datetime(2026, 9, 13, 18, 0, tzinfo=timezone.utc)
    assert dt.utcoffset() == timedelta(hours=8)


def test_parse_utc_text_rejects_junk():
    assert pr._parse_utc_text("") is None
    assert pr._parse_utc_text("昨天") is None


def test_parse_local_day_is_local_midnight():
    dt = pr._parse_local_day("2026-09-14", TZ)
    assert dt.isoformat() == "2026-09-14T00:00:00+08:00"
    assert pr._parse_local_day("nope", TZ) is None


def test_stamp_gives_wall_clock_and_epoch():
    at, ts = pr._stamp(datetime(2026, 9, 13, 18, 0, tzinfo=timezone.utc), TZ)
    assert at == "2026-09-14T02:00:00"
    assert ts == datetime(2026, 9, 13, 18, 0, tzinfo=timezone.utc).timestamp()


# --- 门槛判定（纯函数）------------------------------------------------------------


def test_no_history_no_things():
    assert pr._things_from({}, TZ) == []


def test_one_event_earns_only_the_first_tier():
    src = {"work": [datetime(2026, 9, 10, 1, 0, tzinfo=timezone.utc)]}
    got = pr._things_from(src, TZ)
    assert [t["id"] for t in got] == ["work:1"]
    assert got[0]["kind"] == "badge"
    assert got[0]["at"] == "2026-09-10T09:00:00"
    assert got[0]["detail"] == "第 1 份成品"
    assert got[0]["module_label"] == "工作"


def test_the_fifth_event_is_the_one_that_earns_the_fifth_tier():
    src = {
        "work": [
            datetime(2026, 9, 10, 1, 0, tzinfo=timezone.utc),
            datetime(2026, 9, 11, 1, 0, tzinfo=timezone.utc),
            datetime(2026, 9, 12, 1, 0, tzinfo=timezone.utc),
            datetime(2026, 9, 13, 1, 0, tzinfo=timezone.utc),
            datetime(2026, 9, 14, 1, 0, tzinfo=timezone.utc),
        ]
    }
    got = {t["id"]: t for t in pr._things_from(src, TZ)}
    assert set(got) == {"work:1", "work:5"}
    assert got["work:5"]["at"] == "2026-09-14T09:00:00"
    assert got["work:1"]["at"] == "2026-09-10T09:00:00"


def test_things_are_newest_first():
    src = {
        "work": [datetime(2026, 9, 10, 1, 0, tzinfo=timezone.utc)],
        "reviews": [datetime(2026, 9, 20, 1, 0, tzinfo=timezone.utc)],
    }
    got = pr._things_from(src, TZ)
    assert [t["id"] for t in got] == ["reviews:1", "work:1"]
    ats = [t["at_ts"] for t in got]
    assert ats == sorted(ats, reverse=True)


def test_two_things_in_the_same_second_have_a_stable_order():
    same = datetime(2026, 9, 10, 1, 0, tzinfo=timezone.utc)
    src = {"work": [same], "reviews": [same], "learning": [same]}
    first = [t["id"] for t in pr._things_from(src, TZ)]
    assert first == sorted(first, reverse=True)  # id 兜底，同秒的顺序也是确定的
    assert pr._things_from(src, TZ) == pr._things_from(src, TZ)


# --- 端到端：真库 + 真 vault -------------------------------------------------------


def test_an_early_local_morning_run_counts_as_today():
    """本地 09-14 02:00 = UTC 09-13 18:00，库里存的是后者。房间按**本地**日算今天。"""
    _insert("task_runs", started_at="2026-09-13 18:00:00.000000", status="ok")
    now = datetime(2026, 9, 14, 10, 0, tzinfo=TZ)
    meals = pr.room(now=now, tz=TZ)["today"]["meals"]
    assert [m["key"] for m in meals] == ["runs_ok"]
    assert meals[0]["label"] == "工作流 1 条"

    # 同一个瞬间，换成 UTC 的「现在」：那一刻是 09-13，不该算今天
    utc_meals = pr.room(now=datetime(2026, 9, 14, 10, 0, tzinfo=timezone.utc), tz=timezone.utc)[
        "today"
    ]["meals"]
    assert utc_meals == []


def test_a_habit_day_is_a_local_date_and_is_not_shifted():
    """`habit_logs.day` 是本地日历日——它没有时刻，不该被时区搬走。"""
    _insert("habit_logs", day="2026-09-14")
    west = timezone(timedelta(hours=-5))
    for tz, now in (
        (TZ, datetime(2026, 9, 14, 1, 0, tzinfo=TZ)),
        (west, datetime(2026, 9, 14, 23, 0, tzinfo=west)),
    ):
        meals = pr.room(now=now, tz=tz)["today"]["meals"]
        assert [m["key"] for m in meals] == ["habit_days"], tz


def test_habit_ladder_reaches_the_weekly_prop():
    for i in range(7):
        _insert("habit_logs", day=f"2026-09-{10 + i:02d}")
    got = {t["id"]: t for t in pr.things(now=datetime(2026, 9, 20, 10, 0, tzinfo=TZ), tz=TZ)}
    assert set(got) == {"habit_days:1", "habit_days:7"}
    assert got["habit_days:7"]["label"] == "一周的火"
    assert got["habit_days:7"]["at"] == "2026-09-16T00:00:00"  # 第 7 个打卡日那天


def test_outputs_come_from_the_vault_and_keep_file_order_dates():
    for i in range(5):
        _output(f"2026-09-{10 + i:02d}-note.md", datetime(2026, 9, 10 + i, 9, 0, tzinfo=TZ))
    got = {t["id"]: t for t in pr.things(now=datetime(2026, 9, 20, 10, 0, tzinfo=TZ), tz=TZ)}
    assert set(got) == {"work:1", "work:5"}
    assert got["work:5"]["at"].startswith("2026-09-14")
    assert got["work:1"]["at"].startswith("2026-09-10")


def test_an_earlier_thing_does_not_move_when_more_arrive():
    """「只增不减」的另一半：**已经到手那件的日期不会漂**。
    第 6 份落盘之后，第 5 份仍是 09-14 那件——不是「最近一次」的日期。"""
    for i in range(5):
        _output(f"2026-09-{10 + i:02d}-a.md", datetime(2026, 9, 10 + i, 9, 0, tzinfo=TZ))
    before = {t["id"]: t["at"] for t in pr.things(tz=TZ)}
    _output("2026-09-15-b.md", datetime(2026, 9, 15, 9, 0, tzinfo=TZ))
    after = {t["id"]: t["at"] for t in pr.things(tz=TZ)}
    assert after["work:5"] == before["work:5"]
    assert after["work:5"] != after["work:1"]


def test_mastery_comes_from_the_caller_not_from_a_second_rule():
    """「已掌握」的规则只有 `tutor.mastery_events()` 那一份；房间只消费它。"""
    mastered = [{"concept": "asyncio 事件循环", "at": "2026-09-14T02:00:00+00:00"}]
    got = {t["id"]: t for t in pr.things(mastered, now=datetime(2026, 9, 14, 12, 0, tzinfo=TZ), tz=TZ)}
    assert set(got) == {"learning:1"}
    assert got["learning:1"]["at"] == "2026-09-14T10:00:00"


def test_taught_ladder_and_growth_count_share_one_predicate():
    """费曼说通算「教它」，苏格拉底说通不算。数时刻（房间）与数次数（成长值）
    用的是同一个谓词常量——两边数出来的必须是同一个数。"""
    _insert("tutor_sessions", mode="feynman", verdict="got", ended_at="2026-09-14 02:00:00.000000")
    _insert("tutor_sessions", mode="feynman", verdict="half", ended_at="2026-09-14 03:00:00.000000")
    _insert("tutor_sessions", mode="socratic", verdict="got", ended_at="2026-09-14 04:00:00.000000")

    teach = pr._instants(_db(), None, TZ)["teach"]
    assert len(teach) == 1
    assert teach[0] == datetime(2026, 9, 14, 2, 0, tzinfo=timezone.utc)
    assert pet.growth()["counts"]["taught"] == len(teach)


def test_focus_history_only_counts_events_that_name_the_plugin():
    """插件事件以前不带插件名（三条线同形），所以**没有历史可数**。
    这条同时钉住「不去猜文本」：台词里写着「专注」但 detail 为空的行，不算。"""
    _insert(
        "pet_events",
        created_at="2026-09-14T09:30:00+08:00",
        kind="plugin",
        text="25 分钟到，抬头歇一下。",
        detail="focus",
    )
    _insert(
        "pet_events",
        created_at="2026-09-14T09:40:00+08:00",
        kind="plugin",
        text="专注 25 分钟到，抬头歇一下。",
        detail="",
    )
    now = datetime(2026, 9, 14, 12, 0, tzinfo=TZ)
    got = {t["id"]: t for t in pr.things(now=now, tz=TZ)}
    assert set(got) == {"focus:1"}
    assert got["focus:1"]["at"] == "2026-09-14T09:30:00"
    meals = pr.room(now=now, tz=TZ)["today"]["meals"]
    assert [m["count"] for m in meals if m["key"] == "focus"] == [1]


def test_meals_name_the_module_they_came_from():
    _insert("task_runs", started_at="2026-09-14 02:00:00.000000", status="ok")
    _insert("card_reviews", reviewed_at="2026-09-14 03:00:00.000000")
    _insert("habit_logs", day="2026-09-14")
    now = datetime(2026, 9, 14, 12, 0, tzinfo=TZ)
    meals = pr.room(now=now, tz=TZ)["today"]["meals"]
    assert [m["key"] for m in meals] == ["runs_ok", "reviews", "habit_days"]
    assert [m["module_label"] for m in meals] == ["工作", "复习", "坚持"]
    assert [m["icon"] for m in meals] == ["⚙️", "⟳", "🔥"]


def test_a_failed_run_is_not_a_meal():
    _insert("task_runs", started_at="2026-09-14 02:00:00.000000", status="error")
    now = datetime(2026, 9, 14, 12, 0, tzinfo=TZ)
    assert pr.room(now=now, tz=TZ)["today"]["meals"] == []


def test_room_reports_the_local_date_it_measured():
    now = datetime(2026, 9, 14, 23, 30, tzinfo=TZ)
    assert pr.room(now=now, tz=TZ)["today"]["date"] == "2026-09-14"
    # 同一瞬间在另一个时区已经是 09-15——投喂清单按**你所在的**那天算
    west = timezone(timedelta(hours=-5))
    assert pr.room(now=now, tz=west)["today"]["date"] == "2026-09-14"
    assert pr.room(now=datetime(2026, 9, 15, 3, 0, tzinfo=TZ), tz=timezone.utc)["today"][
        "date"
    ] == "2026-09-14"


def test_an_empty_room_says_empty_and_owns_nothing():
    out = pr.room(now=datetime(2026, 9, 14, 12, 0, tzinfo=TZ), tz=TZ)
    assert out["empty"] is True
    assert out["things"] == [] and out["carried"] is None
    assert out["today"]["meals"] == []


def test_the_room_survives_a_database_with_no_tables(monkeypatch):
    # 不用 pytest 的 tmp_path：那是系统 temp，本机沙箱里写不了（见文件头注释）
    monkeypatch.setattr(settings, "db_path", _TMP / "brand-new.db")
    out = pr.room(now=datetime(2026, 9, 14, 12, 0, tzinfo=TZ), tz=TZ)
    assert out["empty"] is True
    assert pr.things() == []


def test_the_room_survives_a_missing_vault(monkeypatch):
    monkeypatch.setattr(pr, "VAULT_DIR", _TMP / "no-such-vault")
    assert pr.things() == []


def test_only_real_output_dirs_count_as_a_finished_piece():
    """「成品」的定义只有 `pet._OUTPUT_DIRS` 一处。

    工作页那张清单更宽（`tasks/` 的工作流产物、`notes/` 的成文都在里面），那是另一个
    问题。P4 的验收里就撞上过：拿宽的那份当屋里的架子，会出现「架上 4 份、成长说交出
    2 份」。这一条把口径钉住。"""
    assert pet.is_output_path("deliver/2026-09-15-a.md") is True
    assert pet.is_output_path("research/x.md") is True
    assert pet.is_output_path("tasks/RAG一句话-2026-08-27-1029.md") is False
    assert pet.is_output_path("notes/2026-09-14-成文.md") is False
    assert pet.is_output_path("") is False


def test_carried_is_the_newest_thing_when_the_shelf_is_empty():
    _insert("card_reviews", reviewed_at="2026-09-14 03:00:00.000000")
    out = pr.room(now=datetime(2026, 9, 14, 12, 0, tzinfo=TZ), tz=TZ)
    assert out["carried"]["id"] == "reviews:1"
    assert out["carried"] == out["things"][0]


# --- 它「叼回来」的那件：门槛是稀疏的，叼回来是每份成品都发生的 ----------------------


def _shelf(path: str, mtime: float, title: str = "一份成品", label: str = "交付") -> dict:
    return {"path": path, "mtime": mtime, "title": title, "label": label, "date": "2026-09-14"}


def test_a_fresh_output_is_what_it_carries_even_without_crossing_a_threshold():
    """交一份成品就多一件「身上的东西」——**不必**正好撞上第 5 份那个门槛。"""
    old = pr._things_from(
        {"reviews": [datetime(2026, 9, 1, 1, 0, tzinfo=timezone.utc)]}, TZ
    )[0]
    fresh = datetime(2026, 9, 14, 3, 0, tzinfo=timezone.utc).timestamp()
    got = pr.carried(old, [_shelf("deliver/a.md", fresh, title="给领导的汇报")], tz=TZ)
    assert got["kind"] == "output"
    assert got["id"] == "file:deliver/a.md"
    assert got["label"] == "给领导的汇报"
    assert got["at"] == "2026-09-14T11:00:00"  # 本地墙钟
    assert got["at_ts"] == fresh


def test_an_older_output_does_not_replace_a_newer_thing():
    recent = pr._things_from(
        {"reviews": [datetime(2026, 9, 14, 3, 0, tzinfo=timezone.utc)]}, TZ
    )[0]
    older = datetime(2026, 9, 1, 3, 0, tzinfo=timezone.utc).timestamp()
    assert pr.carried(recent, [_shelf("deliver/a.md", older)], tz=TZ) == recent


def test_carried_survives_a_broken_shelf_row():
    assert pr.carried(None, [{"path": "x"}, {"mtime": "不是数"}, "不是字典"], tz=TZ) is None


def test_the_newest_row_wins_when_a_new_file_lands_on_an_old_shelf():
    """一份成品刚落地，其余是旧的——挂上去的是**新那份**。"""
    old = datetime(2026, 9, 10, 3, 0, tzinfo=timezone.utc).timestamp()
    new = datetime(2026, 9, 14, 5, 0, tzinfo=timezone.utc).timestamp()
    got = pr.carried(
        None,
        [_shelf("deliver/old.md", old, title="旧的"), _shelf("deliver/new.md", new, title="新的")],
        tz=TZ,
    )
    assert got["label"] == "新的"
    assert got["detail"] == "交付 · 2026-09-14"
