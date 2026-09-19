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

from app.config import VAULT_DIR, settings  # noqa: E402
from app.core import pet  # noqa: E402
from app.core import pet_room as pr  # noqa: E402

# **跟着应用走**，不自己开一个库/一个 vault。
#
# 原来这个模块在 import 时写 `WB_DB_PATH = 自己的 room.db`，再用 `sqlite3` 直接往那儿写，
# 而 `pet_room.room()` 读的是**应用引擎**指的那个库 —— 每文件一进程时两者恰好是同一个，
# 所以 CI 一直绿；单进程里模块 import 早于任何测试，env 被前一个模块写的值占着，
# 于是「写 A 读 B」，**12 条断言当场全错**。也就是说：它在 CI 里是**因为错误的原因**过的。
#
# 隔离现在由 `conftest._clean_sandbox`（每个模块开始时清空沙箱）提供。
_DB = Path(settings.db_path)
_VAULT = VAULT_DIR

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

# 全量 schema 里「NOT NULL、没有**服务端**默认值、又不是主键」的列 —— 这个模块不关心它们，
# 但必须给值。**从模型里推**而不是手写：手写就会一个一个撞（`card_id`、`grade`、`seconds`…）。
#
# 只看 `server_default`：`mapped_column(default=…)` 是 **Python 侧**默认值，**根本不进 DDL**，
# 所以裸 sqlite3 INSERT 不给它照样 IntegrityError —— `card_reviews.seconds` 就是这么撞上的。
def _required_for(table: str) -> dict:
    from app.models import Base

    out: dict[str, object] = {}
    for col in Base.metadata.tables[table].columns:
        if col.primary_key or col.nullable or col.server_default is not None:
            continue
        kind = str(col.type).upper()
        out[col.name] = 0 if "INT" in kind else (0.0 if "FLOAT" in kind or "REAL" in kind else "")
    return out


_REQUIRED: dict[str, dict] = {t: _required_for(t) for t in _TABLES}


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
    """插一行。**补上全量 schema 里 NOT NULL、又没默认值的那些列。**

    这个模块以前自己造一份最小的表（`card_reviews (id, reviewed_at)` 之类），所以只给
    关心的列就够。现在它跟应用共用沙箱库，表是**全量 schema**：缺 `card_id` / `grade` /
    `task_id` / `topic` / `text` 会当场 IntegrityError。这里统一补最小必需值，免得每个
    调用点各写一遍。顺带一提：以前那个 IntegrityError 会把连接连事务一起留在打开状态，
    后面每条都变成「database is locked」（15 秒超时 × 若干条），所以下面用 try/finally。
    """
    cols = {**_REQUIRED.get(table, {}), **cols}
    conn = _db()
    try:
        names = ", ".join(cols)
        marks = ", ".join("?" for _ in cols)
        conn.execute(f"INSERT INTO {table} ({names}) VALUES ({marks})", tuple(cols.values()))  # noqa: S608
        conn.commit()
    finally:
        conn.close()


async def _tutor_session(concept: str, verdict: str, *, days_ago: int = 1, stuck: str = "") -> int:
    """一场已结束的教学会话，直接写库（`tutor.end()` 那一套自己有测试）。

    概念卡的真值就是这张表：屋里那张卡是 `tutor.learning_map()` 的倒影，
    所以这一层要验的是「真会话 → 真地图 → 屋里的卡」，中间不准有第二份判定。
    """
    from app.db import SessionLocal
    from app.models import TutorSession, utcnow

    when = utcnow() - timedelta(days=days_ago)
    async with SessionLocal() as db:
        row = TutorSession(
            topic=concept,
            concept=concept,
            verdict=verdict,
            stuck=stuck,
            created_at=when,
            ended_at=when,
        )
        db.add(row)
        await db.commit()
        await db.refresh(row)
        return row.id


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
    # 用沙箱目录下一个**不存在**的库名就够，不用另开 scratch（系统 temp 本机写不了）
    monkeypatch.setattr(settings, "db_path", _DB.parent / "brand-new.db")
    out = pr.room(now=datetime(2026, 9, 14, 12, 0, tzinfo=TZ), tz=TZ)
    assert out["empty"] is True
    assert pr.things() == []


def test_the_room_survives_a_missing_vault(monkeypatch):
    monkeypatch.setattr(pr, "VAULT_DIR", _VAULT.parent / "no-such-vault")
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


def test_carried_says_which_shelf_row_it_is():
    """叼回来的那份要**指得出架上那一行**（`ref` = 那条 `path`）。

    界面靠它标「它叼的就是这份」。让界面自己再算一遍「谁最新」是不行的：那是第二份判定，
    两处迟早会各指一件东西——而这个仓库为这种事付过账（小屋架子 vs 工作页清单）。
    """
    fresh = datetime(2026, 9, 14, 3, 0, tzinfo=timezone.utc).timestamp()
    got = pr.carried(None, [_shelf("deliver/a.md", fresh)], tz=TZ)
    assert got["ref"] == "deliver/a.md"


def test_a_threshold_thing_has_no_shelf_row_to_point_at():
    """门槛那件（徽章 / 摆设）不在架上，所以它没有 `ref`——不是空串猜出来的，
    是这个字段**根本不存在**于那条路上。"""
    # 空库里没有任何东西，先造一件：一条复习记录就够跨过 `reviews:1` 那个门槛
    _insert("card_reviews", reviewed_at="2026-09-14 03:00:00.000000")
    out = pr.room(now=datetime(2026, 9, 14, 12, 0, tzinfo=TZ), tz=TZ)
    assert out["carried"]["id"] == "reviews:1"
    assert "ref" not in out["carried"]


# --- 概念卡（P2 · F13）：学习地图在小屋里的镜子 ------------------------------------
#
# 这一类的规矩与「攒下的东西」不同（模块 docstring 里那两类的分别）：它照的是**此刻**
# 在哪一档，所以状态会来回动。要钉住的只有三件事：
#   1. 档位是**地图分好的**，屋里不重判（map 怎么分，这儿就怎么摆）；
#   2. 「未触及」一档一个字都不进小屋（那是欠账）；
#   3. 读不出来就说读不出来（时间读不出来的行整张不摆）。


def _row(concept: str, at: str, sessions: int = 1, stuck: str = "") -> dict:
    """地图那一行的样子（`tutor._by_concept()` 的产出，只留这里读的几个字段）。"""
    return {"concept": concept, "last_at": at, "sessions": sessions, "stuck": stuck}


def _board(mastered=(), learning=(), stuck=(), untouched=()) -> dict:
    return {
        "mastered": list(mastered),
        "learning": list(learning),
        "stuck": list(stuck),
        "untouched": list(untouched),
    }


def test_concept_cards_carry_the_state_the_map_put_them_in():
    board = _board(
        mastered=[_row("asyncio 事件循环", "2026-09-14T01:00:00+00:00", sessions=2)],
        learning=[_row("SQLite WAL", "2026-09-13T01:00:00+00:00")],
        stuck=[_row("CORS 预检", "2026-09-12T01:00:00+00:00", stuck="以为 OPTIONS 是应用层发的")],
    )
    out = pr.concept_cards(board, tz=TZ)
    assert [c["id"] for c in out["cards"]] == [
        "concept:asyncio 事件循环",
        "concept:SQLite WAL",
        "concept:CORS 预检",
    ]
    assert [c["state"] for c in out["cards"]] == ["mastered", "learning", "stuck"]
    assert out["total"] == 3
    # 时间是**镜像那一刻之前最后一次碰它**的时刻，本地墙钟与 epoch 都给（前端不猜时区）
    first = out["cards"][0]
    assert first["at"] == "2026-09-14T09:00:00"
    assert first["at_ts"] == datetime(2026, 9, 14, 1, 0, tzinfo=timezone.utc).timestamp()
    assert first["sessions"] == 2


def test_the_untouched_bucket_never_enters_the_room():
    """「拆出来、还没开成教」的点是**还没做的事**，不是屋里的一件东西。

    摆出来就是一张「你还有 3 个点没碰」的清单——那正是这个仓库封存过的口吻。
    注意它**也不进 `total`**：屋里连数都不数它。
    """
    board = _board(
        learning=[_row("SQLite WAL", "2026-09-13T01:00:00+00:00")],
        untouched=[{"id": 1, "point": "B+ 树怎么分裂"}, {"id": 2, "point": "WAL 的检查点"}],
    )
    out = pr.concept_cards(board, tz=TZ)
    assert [c["name"] for c in out["cards"]] == ["SQLite WAL"]
    assert out["total"] == 1
    assert all("未触及" not in c["id"] for c in out["cards"])


def test_the_room_shows_the_newest_ones_but_the_total_keeps_counting():
    """屋里只摆得下 `limit` 张（学页那张地图才是全量）。**掉出屋子的不是没了**——
    它没有从 `total` 里消失，也没有从真值里消失，只是这一屏放不下。"""
    board = _board(
        learning=[
            _row(f"概念{i:02d}", f"2026-09-{i + 1:02d}T01:00:00+00:00") for i in range(15)
        ]
    )
    out = pr.concept_cards(board, tz=TZ)
    assert len(out["cards"]) == pr.CONCEPT_CARDS_CAP == 12
    assert out["total"] == 15
    assert out["cards"][0]["name"] == "概念14"  # 最近的排最前
    assert "概念00" not in [c["name"] for c in out["cards"]]


def test_only_a_stuck_card_carries_the_stuck_line():
    """卡在哪只有「卡住」那一档说。

    「已掌握」的行上也可能留着当时的卡点（说通了，当时卡在 X）——那是记录，不是现状；
    镜子照的是现状，所以那两档一律不带这句话。
    """
    board = _board(
        mastered=[_row("asyncio 事件循环", "2026-09-14T01:00:00+00:00", stuck="当时卡在 select")],
        stuck=[_row("CORS 预检", "2026-09-12T01:00:00+00:00", stuck="以为 OPTIONS 是应用层发的")],
    )
    got = {c["name"]: c for c in pr.concept_cards(board, tz=TZ)["cards"]}
    assert got["CORS 预检"]["stuck"] == "以为 OPTIONS 是应用层发的"
    assert got["asyncio 事件循环"]["stuck"] == ""


def test_a_concept_without_a_readable_time_is_not_shown_at_all():
    """时间读不出来 → 整张不摆，`total` 也不数它。

    「什么时候碰的」是这张卡的一半；摆一张日期空着的卡，读的人只会以为是今天。
    同 `delivery.due()` 对时间读不出来的行的做法。
    """
    board = _board(
        learning=[
            _row("时间坏了", "昨天"),
            _row("空时间", ""),
            _row("好的", "2026-09-13T01:00:00+00:00"),
        ]
    )
    out = pr.concept_cards(board, tz=TZ)
    assert [c["name"] for c in out["cards"]] == ["好的"]
    assert out["total"] == 1


def test_concept_cards_survive_a_broken_board():
    """镜子坏了不该挡住整间屋子：读不出来就是没有，一条也不抛。"""
    for junk in (None, {}, [], {"mastered": "不是清单"}, {"learning": ["不是字典", None]}):
        assert pr.concept_cards(junk, tz=TZ) == {"cards": [], "total": 0}

    # 同一个概念真出现在两档里（地图不会这么给）：以**靠前的档**为准，且只摆一张
    dup = _board(
        mastered=[_row("同名", "2026-09-14T01:00:00+00:00")],
        learning=[_row("同名", "2026-09-13T01:00:00+00:00")],
    )
    cards = pr.concept_cards(dup, tz=TZ)["cards"]
    assert [c["state"] for c in cards] == ["mastered"]
    assert pr.concept_cards(dup, tz=TZ)["total"] == 1

    # 计数读不出来当 0、负数不摆成负的（界面上那行字是「讲过 N 次」）
    bad = pr.concept_cards(_board(learning=[_row("x", "2026-09-13T01:00:00+00:00", sessions="很多")]), tz=TZ)
    assert bad["cards"][0]["sessions"] == 0
    neg = pr.concept_cards(_board(learning=[_row("y", "2026-09-13T01:00:00+00:00", sessions=-3)]), tz=TZ)
    assert neg["cards"][0]["sessions"] == 0

    # limit=0：一张都不摆，但总数照旧
    assert pr.concept_cards(
        _board(learning=[_row("z", "2026-09-13T01:00:00+00:00")]), tz=TZ, limit=0
    ) == {"cards": [], "total": 1}


async def test_the_rooms_three_states_are_the_maps_three_buckets():
    """屋里那三档与学习地图的三档**同形**（`concept_cards` 只读这三个键）。

    地图加一档（或改个名），这里必须当场红——否则屋里会安静地少摆一类概念，
    而那种少是看不出来的。这是「一处逻辑」那条规矩在这一层上的钉子。
    """
    from app.core import tutor

    board = await tutor.learning_map()
    assert set(pr.CONCEPT_STATES) | {"untouched"} == set(board)
    assert set(pr.CONCEPT_STATES) == {"mastered", "learning", "stuck"}


async def test_the_room_reads_its_concept_cards_out_of_real_sessions():
    """真行那一层：会话是真值，地图是派生的，屋里这张卡只是它的倒影。

    顺带钉住**接线**：`/api/pet/room` 真的把它带出来了（路由里那一行不写，
    界面就永远是空的，而且看不出来是坏的）。
    """
    from app.core import tutor
    from app.routers.pet import pet_room as room_endpoint

    await _tutor_session("asyncio 事件循环", "got", days_ago=5)
    await _tutor_session("asyncio 事件循环", "got", days_ago=1)  # 两场才算已掌握
    await _tutor_session("React useEffect 依赖数组", "half", days_ago=2)
    await _tutor_session("CORS 预检", "half", days_ago=3, stuck="以为 OPTIONS 是应用层发的")

    # `/api/pet/room` 那个端点本身（直接调函数，不起 HTTP）
    payload = await room_endpoint()
    cards = {c["name"]: c["state"] for c in payload["concepts"]["cards"]}
    assert cards == {
        "asyncio 事件循环": "mastered",
        "React useEffect 依赖数组": "learning",
        "CORS 预检": "stuck",
    }
    assert payload["concepts"]["total"] == 3
    # 与地图本身对齐（不是自己另算了一份）
    board = await tutor.learning_map()
    assert payload["concepts"]["total"] == len(board["mastered"]) + len(board["learning"]) + len(
        board["stuck"]
    )
