"""度量 · 北极星（PLAN §7）的离线测试。

这一格的全部难点不在算术，在**口径**与**红线**，所以钉的就是这两样：

1. **两个条件都要满足**才算一天：只重讲不算、只消化也不算（「讲」是输出、「消化」是输入）；
2. **「重讲作答」= `card_reviews.retell` 非空**：自评那一路照旧留空，所以自评再多也不进这条曲线；
3. **按本地日算**：凌晨 00:30 的那次重讲算今天，不是算昨天（边界用真行验，不是看代码）；
4. **红线：它不进零柒嘴里**——跑完曲线，宠物一个字都没说（没有 `pet_events` 行，
   也没有任何 `pet.*` 调用）；曲线只出现在仪表盘。
"""
import asyncio
import sys
from datetime import datetime, timedelta, timezone

import pytest

sys.path.insert(0, ".")

from app.core import metrics  # noqa: E402
from app.core import pet as pet_core  # noqa: E402
from app.db import SessionLocal, engine as _engine  # noqa: E402
from app.models import Base as _Base  # noqa: E402
from app.models import CardReview, DigestPoint, TutorSession  # noqa: E402

NOW = datetime.now().astimezone()


async def _init_db() -> None:
    async with _engine.begin() as conn:
        await conn.run_sync(_Base.metadata.create_all)


asyncio.run(_init_db())


def _naive_utc(when: datetime) -> datetime:
    """库里那几列的口径：naive UTC（`utcnow()` 写的 UTC，读出来不带时区）。"""
    return when.astimezone(timezone.utc).replace(tzinfo=None)


def _review(when: datetime, retell: str = "我讲一遍：事件循环就是这个意思") -> None:
    async def go() -> None:
        async with SessionLocal() as db:
            db.add(CardReview(card_id=1, grade=3, retell=retell, reviewed_at=_naive_utc(when)))
            await db.commit()

    asyncio.run(go())


def _point(when: datetime, source: str = "notes/材料.md") -> None:
    async def go() -> None:
        async with SessionLocal() as db:
            db.add(DigestPoint(source=source, point="一个点", why="", created_at=_naive_utc(when)))
            await db.commit()

    asyncio.run(go())


@pytest.fixture(autouse=True)
def _clean():
    from sqlalchemy import delete

    async def _go() -> None:
        async with SessionLocal() as db:
            for model in (CardReview, DigestPoint, TutorSession):
                await db.execute(delete(model))
            await db.commit()

    asyncio.run(_go())
    yield


# ---------- 窗口与曲线（纯函数） ----------


def test_the_window_is_seven_consecutive_local_days_ending_today():
    ds = metrics.days(NOW)
    assert len(ds) == metrics.WINDOW_DAYS
    assert ds[-1] == NOW.replace(hour=0, minute=0, second=0, microsecond=0)  # 最后一个是今天
    assert [d.date() for d in ds] == sorted(d.date() for d in ds)  # 旧 → 新
    # 相邻差一天，且都是本地零点：曲线上的每一格就是一天，不是「最近 168 小时」
    assert all((ds[i + 1] - ds[i]) == timedelta(days=1) for i in range(len(ds) - 1))
    assert all((d.hour, d.minute) == (0, 0) for d in ds)


def test_a_day_counts_only_when_both_happened():
    """「讲」是输出、「消化」是输入——缺一半转不起来，所以缺一半不算一天。"""
    curve = metrics.classify(
        [
            {"date": "2026-09-10", "retell": 3, "digested": 0},  # 只讲没消化
            {"date": "2026-09-11", "retell": 0, "digested": 5},  # 只消化没讲
            {"date": "2026-09-12", "retell": 1, "digested": 1},  # 两件都发生
            {"date": "2026-09-13", "retell": 0, "digested": 0},  # 那天很安静
        ]
    )
    assert [d["counted"] for d in curve] == [False, False, True, False]
    assert metrics.summary(curve) == {"counted": 1, "denominator": 4, "rate": 0.25}


def test_a_missing_number_is_not_a_yes():
    """字段缺失 / 坏值一律当 0：**不许**把「读不出来」读成「做到了」。"""
    assert [d["counted"] for d in metrics.classify([{"date": "x"}, {"date": "y", "retell": None, "digested": 2}])] == [False, False]


def test_an_empty_curve_has_no_rate():
    """没有窗口就没有比率——不给 0（0% 与「没算」是两回事）。"""
    assert metrics.rate_of([]) is None
    assert metrics.summary([])["rate"] is None


def test_the_denominator_is_the_window_not_a_hardcoded_seven():
    curve = metrics.classify([{"date": "d", "retell": 1, "digested": 1}])
    assert metrics.summary(curve)["denominator"] == 1


# ---------- 真行：口径与边界 ----------


def test_counts_come_from_the_two_real_sources():
    _review(NOW, retell="我讲了一遍")
    _point(NOW)
    got = asyncio.run(metrics.north_star())
    today = got["days"][-1]
    assert today["counted"] is True and today["retell"] == 1 and today["digested"] == 1
    assert got["counted"] == 1 and got["denominator"] == 7
    assert got["readable"] is True


def test_a_self_assessed_review_does_not_count_as_a_retell():
    """🚩 自评那一路 `retell` 留空（双入口单账本）：自评再多也不进这条曲线。"""
    _review(NOW, retell="")
    _point(NOW)
    got = asyncio.run(metrics.north_star())
    assert got["counted"] == 0
    assert got["days"][-1]["retell"] == 0 and got["days"][-1]["digested"] == 1


def test_yesterday_does_not_leak_into_today():
    """边界按**本地日**算：昨天 23:00 的那次重讲属于昨天，不属于今天。"""
    _review(NOW - timedelta(days=1), retell="昨天讲的")
    _point(NOW - timedelta(days=1))
    got = asyncio.run(metrics.north_star())
    assert [d["counted"] for d in got["days"]] == [False] * 5 + [True, False]
    assert got["days"][-2]["date"] != got["days"][-1]["date"]


def test_just_after_midnight_still_belongs_to_that_day():
    """凌晨刚过的那一刻算**新的一天**——本地日边界是 00:00，不是「睡醒之前」。"""
    midnight = NOW.replace(hour=0, minute=0, second=0, microsecond=0)
    _review(midnight + timedelta(minutes=1), retell="刚过午夜讲的")
    _point(midnight + timedelta(minutes=2))
    got = asyncio.run(metrics.north_star())
    assert got["days"][-1]["counted"] is True
    assert got["days"][-1]["retell"] == 1


def test_older_than_the_window_is_not_counted():
    _review(NOW - timedelta(days=metrics.WINDOW_DAYS), retell="上周讲的")
    _point(NOW - timedelta(days=metrics.WINDOW_DAYS))
    got = asyncio.run(metrics.north_star())
    assert got["counted"] == 0
    assert all(d["retell"] == 0 and d["digested"] == 0 for d in got["days"])


def test_it_says_so_when_it_cannot_read(monkeypatch):
    """读不到 ≠ 什么都没发生：这条曲线要是两种情况长得一样，这把尺子就不值得信。"""

    async def boom(now=None, span=metrics.WINDOW_DAYS):
        raise RuntimeError("db down")

    monkeypatch.setattr(metrics, "_day_counts", boom)
    got = asyncio.run(metrics.north_star())
    assert got["readable"] is False and "db down" in got["error"]
    assert got["days"] == [] and got["rate"] is None


# ---------- 🚩 红线：它不进零柒嘴里 ----------


def test_drawing_the_curve_makes_the_pet_say_nothing():
    """PLAN §7 的红线：这些数**只进仪表盘曲线**——不设目标、不排名、不进它嘴里。

    跑一遍完整曲线，宠物那边一个字都不该多出来（`pet_events` 是它说话的账本）。
    """
    _review(NOW, retell="讲一遍")
    _point(NOW)
    asyncio.run(metrics.north_star())
    assert pet_core.feed(limit=50) == []


def test_the_module_has_no_way_to_speak():
    """更硬的一条：这个模块从宠物那条线里**只拿本地日换算**，没有任何开口的路。

    光测「这一次没说话」不够：真正的风险是下一个人顺手在这里 emit 一句
    「这周 3/7 天，加油」。所以直接盯源码——`pet.` 后面只允许出现
    `local_day_utc_bounds`（那份换算的来源），不许出现 emit / compose / feed 之类。
    """
    import re
    from pathlib import Path

    src = Path(metrics.__file__).read_text(encoding="utf-8")
    body = src.split('"""', 2)[2]  # 去掉模块 docstring（那里正当地提到了 pet 那条线）
    assert sorted(set(re.findall(r"\bpet\.(\w+)", body))) == ["local_day_utc_bounds"]
    for banned in ("emit", "note_output", "compose", "feed", "greeting"):
        assert f"pet.{banned}" not in body, banned


# ---------- HTTP 层 ----------


def test_http_endpoint(monkeypatch):
    monkeypatch.setenv("WB_API_TOKEN", "t")
    from fastapi.testclient import TestClient

    from app.core import auth
    from app.main import app

    monkeypatch.setattr(auth, "_cached", None)
    c = TestClient(app)
    h = {"X-WB-Token": "t"}

    assert c.get("/api/dashboard/north-star").status_code == 401
    body = c.get("/api/dashboard/north-star", headers=h).json()
    assert body["readable"] is True
    assert len(body["days"]) == metrics.WINDOW_DAYS
    assert body["denominator"] == metrics.WINDOW_DAYS
    # 口径随曲线一起给出来：界面上照抄，别让两边各说一个意思
    assert "retell" in body["rules"] and "digested" in body["rules"] and "bias" in body["rules"]


# ---------- §7.2 过程指标：半懂率按周 ----------


def _session(verdict: str, when: datetime) -> None:
    """一场有 verdict 的教学。`verdict` 是它唯一的自评。"""
    async def go() -> None:
        async with SessionLocal() as db:
            db.add(
                TutorSession(
                    topic="随便聊聊",
                    concept="某个概念",
                    verdict=verdict,
                    created_at=_naive_utc(when),
                )
            )
            await db.commit()

    asyncio.run(go())


def test_weeks_start_on_monday_and_end_with_this_week():
    """周一是一周的开始——与 `weekly.window()` 同一个约定，不另立一个。Pure."""
    starts = metrics.week_starts(NOW, 8)
    assert len(starts) == 8
    assert starts[-1].weekday() == 0  # 本周的周一
    assert starts[-1] <= NOW.replace(hour=0, minute=0, second=0, microsecond=0)
    assert all((starts[i + 1] - starts[i]) == timedelta(weeks=1) for i in range(7))
    assert all((s.hour, s.minute) == (0, 0) for s in starts)


def test_a_week_with_no_session_is_not_a_zero():
    """**空的一周是 `None` 不是 0**：0 读作「这周教的全都说通了」，两件事不能长得一样。"""
    starts = metrics.week_starts(NOW, 3)
    counts = {starts[0].strftime("%Y-%m-%d"): {"got": 1, "half": 1}}
    curve = metrics.fold_weeks(counts, starts)
    assert curve[0]["rate"] == 0.5 and curve[0]["n"] == 2
    assert curve[1]["n"] == 0 and curve[1]["rate"] is None
    assert curve[-1]["is_current"] is True and curve[0]["is_current"] is False
    # 全说通的那一周是真的 0（有分母），与空的那一周分得开
    out = metrics.fold_weeks({starts[0].strftime("%Y-%m-%d"): {"got": 3}}, starts)
    assert out[0]["rate"] == 0.0 and out[0]["n"] == 3
    assert metrics.total_of(curve) == {"got": 1, "half": 1, "n": 2, "rate": 0.5}
    assert metrics.total_of(metrics.fold_weeks({}, starts))["rate"] is None


def test_the_half_rate_reads_real_rows_and_leaves_useless_out():
    """真行：说通 / 半懂进分母，**「没用」一个都不进**（教学没成，证明不了水平）。"""
    _session("got", NOW)
    _session("got", NOW - timedelta(minutes=5))
    _session("half", NOW)
    _session("useless", NOW)  # 不进任何一个分母
    _session("", NOW)  # 没标 verdict 的会话（tab 关了）：同样不进

    out = asyncio.run(metrics.half_rate(NOW, 3))
    assert out["readable"] is True and out["error"] == ""
    assert out["totals"] == {"got": 2, "half": 1, "n": 3, "rate": 0.333}
    assert len(out["weeks"]) == 3
    assert out["weeks"][-1]["n"] == 3 and out["weeks"][-1]["is_current"] is True
    assert out["weeks"][0]["n"] == 0 and out["weeks"][0]["rate"] is None
    # 口径三行随曲线一起给出来（界面照抄，不自己编）
    assert set(out["rules"]) == {"half", "useless", "week"}
    assert "半懂" in out["rules"]["half"] and "没用" in out["rules"]["useless"]


def test_last_week_is_a_different_week():
    """分周真的按周切：上周一的会话落在上一格，不是这一格。"""
    monday = NOW.replace(hour=0, minute=0, second=0, microsecond=0) - timedelta(
        days=NOW.weekday()
    )
    _session("half", monday - timedelta(days=1))  # 上周日
    _session("got", monday + timedelta(hours=9))  # 本周一
    out = asyncio.run(metrics.half_rate(NOW, 3))
    assert out["weeks"][-1]["got"] == 1 and out["weeks"][-1]["half"] == 0
    assert out["weeks"][-2]["half"] == 1 and out["weeks"][-2]["got"] == 0


def test_reading_it_failing_is_not_a_flat_line():
    """读不出来照实说，不给八格全零——与北极星同一条纪律。"""
    async def boom(now=None, weeks=metrics.WEEKS):
        raise RuntimeError("db down")

    import pytest as _pytest

    with _pytest.MonkeyPatch.context() as mp:
        mp.setattr(metrics, "_week_counts", boom)
        out = asyncio.run(metrics.half_rate())
    assert out["readable"] is False and "db down" in out["error"]
    assert out["weeks"] == [] and out["totals"]["rate"] is None


def test_the_process_metric_does_not_make_the_pet_speak_either():
    """红线沿用 §7.1 那条：半懂率也**只进仪表盘**——跑完一遍，宠物一个字都没说。"""
    _session("half", NOW)
    _session("got", NOW)
    asyncio.run(metrics.half_rate(NOW, 3))
    assert pet_core.feed(limit=50) == []


def test_http_process_endpoint(monkeypatch):
    monkeypatch.setenv("WB_API_TOKEN", "t")
    from fastapi.testclient import TestClient

    from app.core import auth
    from app.main import app

    monkeypatch.setattr(auth, "_cached", None)
    c = TestClient(app)
    h = {"X-WB-Token": "t"}
    assert c.get("/api/dashboard/process").status_code == 401
    body = c.get("/api/dashboard/process", headers=h).json()
    assert body["readable"] is True
    assert len(body["weeks"]) == metrics.WEEKS
    assert body["window"]["weeks"] == metrics.WEEKS
    assert body["weeks"][-1]["is_current"] is True
    assert "half" in body["rules"] and "useless" in body["rules"] and "week" in body["rules"]
