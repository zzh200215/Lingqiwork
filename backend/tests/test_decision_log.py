"""决策日志 + 校准分的离线测试。

重点在**校准那套纯算术**：命中率的样本下限、按信心分档、按领域分组、以及「说不清」
不进分母。这些是这条链路唯一会出错也不会被肉眼发现的地方。存取那一层只测往返与守卫。

M4（2026-09-16）加的这一段是**到期见证**（PLAN §3 G5）：`witness_days` 那一列、
纯函数的到期判定、以及「只回一条」的那道口子。它是这条日志「拉取式」规矩唯一一次
让开，所以最后一条用例专门盯着**那段理由还在不在原地**——规矩可以让开，理由不能丢。
"""
import asyncio
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest

from app.core import decision_log as dl

# ---------- 沙箱库：存取要写 decision_log ----------

from app.db import engine as _engine  # noqa: E402
from app.models import Base as _Base  # noqa: E402


async def _init_db() -> None:
    async with _engine.begin() as conn:
        await conn.run_sync(_Base.metadata.create_all)


asyncio.run(_init_db())


def _row(confidence=70, outcome="", topic=""):
    return {"confidence": confidence, "outcome": outcome, "topic": topic}


# ---------- rate / _bucket ----------


def test_rate_is_none_below_the_sample_floor():
    """一两条算不出「命中率」——硬算出来的是噪音，会让人对这把尺子失去信任。"""
    assert dl.rate(1, 0) is None
    assert dl.rate(2, 0) is None
    assert dl.rate(3, 0) == 1.0  # 到下限才给
    assert dl.rate(3, 7) == 0.3


def test_bucket_boundaries():
    assert dl._bucket(0) == "50 以下"
    assert dl._bucket(49) == "50 以下"
    assert dl._bucket(50) == "50-69"
    assert dl._bucket(69) == "50-69"
    assert dl._bucket(70) == "70-89"
    assert dl._bucket(90) == "90 以上"
    assert dl._bucket(100) == "90 以上"


# ---------- calibration（纯函数） ----------


def test_calibration_on_empty_is_all_zeros_not_a_crash():
    c = dl.calibration([])
    assert c["total"] == 0 and c["reviewed"] == 0 and c["pending"] == 0
    assert c["overall"]["rate"] is None
    assert [b["sample"] for b in c["by_confidence"]] == [0, 0, 0, 0]


def test_calibration_counts_pending_and_unclear_separately():
    rows = [
        _row(outcome="hit"),
        _row(outcome="miss"),
        _row(outcome="unclear"),
        _row(outcome=""),  # 还没回看
    ]
    c = dl.calibration(rows)
    assert (c["total"], c["reviewed"], c["unclear"], c["pending"]) == (4, 2, 1, 1)


def test_unclear_stays_out_of_the_denominator():
    """「说不清」不进分母：塞进去会让你以为自己在某类事上不准，其实只是还没到能判断的时候。"""
    rows = [_row(outcome="hit")] * 3 + [_row(outcome="unclear")] * 5
    c = dl.calibration(rows)
    assert c["overall"]["hits"] == 3 and c["overall"]["misses"] == 0
    assert c["overall"]["rate"] == 1.0
    assert c["unclear"] == 5


def test_calibration_groups_by_confidence_bucket():
    rows = [
        _row(confidence=95, outcome="hit"),
        _row(confidence=90, outcome="miss"),  # 同一档：自称很有把握，实际一半没中
        _row(confidence=95, outcome="hit"),
        _row(confidence=60, outcome="miss"),
    ]
    by_conf = {b["bucket"]: b for b in dl.calibration(rows)["by_confidence"]}
    assert by_conf["90 以上"]["sample"] == 3
    assert by_conf["90 以上"]["rate"] == pytest.approx(2 / 3, abs=1e-3)
    assert by_conf["50-69"]["sample"] == 1
    assert by_conf["50-69"]["rate"] is None  # 样本不够，不给分
    assert by_conf["70-89"]["sample"] == 0


def test_calibration_by_topic_needs_enough_samples():
    rows = [
        _row(topic="架构选型", outcome="hit"),
        _row(topic="架构选型", outcome="miss"),
        _row(topic="架构选型", outcome="hit"),
        _row(topic="运维", outcome="hit"),  # 只有一条，不进榜
        _row(topic="", outcome="hit"),  # 没填领域，不进榜
    ]
    c = dl.calibration(rows)
    assert [t["topic"] for t in c["by_topic"]] == ["架构选型"]
    assert c["by_topic"][0]["rate"] == pytest.approx(2 / 3, abs=1e-3)


def test_calibration_by_topic_sorts_by_sample_desc():
    rows = (
        [_row(topic="A", outcome="hit")] * 3
        + [_row(topic="B", outcome="hit")] * 5
    )
    assert [t["topic"] for t in dl.calibration(rows)["by_topic"]] == ["B", "A"]


def test_calibration_reads_orm_objects_too():
    class _Row:
        def __init__(self, confidence, outcome, topic):
            self.confidence, self.outcome, self.topic = confidence, outcome, topic

    c = dl.calibration([_Row(80, "hit", "架构选型")] * 3)
    assert c["overall"]["rate"] == 1.0


# ---------- 存取 ----------


def test_add_list_and_review_round_trip():
    async def go():
        row = await dl.add("先用 Chroma 就够", basis="数据量上不去", topic="架构选型", confidence=70)
        assert row["outcome"] == "" and row["reviewed_at"] is None
        got = await dl.list_decisions()
        assert got["entries"][0]["id"] == row["id"]
        assert got["calibration"]["pending"] == 1

        reviewed = await dl.review(row["id"], "hit", "三个月后还在用")
        assert reviewed["outcome"] == "hit" and reviewed["reviewed_at"] is not None
        assert (await dl.list_decisions())["calibration"]["reviewed"] == 1

        # 撤销回看：回到「还没回看」，计数跟着退回去
        back = await dl.review(row["id"], "")
        assert back["outcome"] == "" and back["reviewed_at"] is None
        assert (await dl.list_decisions())["calibration"]["pending"] == 1
        await dl.remove(row["id"])

    asyncio.run(go())


def test_add_rejects_blank_and_clamps_confidence():
    async def go():
        with pytest.raises(ValueError):
            await dl.add("   ")
        row = await dl.add("x", confidence=999)
        assert row["confidence"] == 100
        await dl.remove(row["id"])

    asyncio.run(go())


def test_review_rejects_unknown_outcome():
    async def go():
        row = await dl.add("x")
        with pytest.raises(ValueError):
            await dl.review(row["id"], "maybe")
        await dl.remove(row["id"])

    asyncio.run(go())


def test_missing_row_raises_lookup_error():
    async def go():
        with pytest.raises(LookupError):
            await dl.review(999999, "hit")
        with pytest.raises(LookupError):
            await dl.remove(999999)

    asyncio.run(go())


# ---------- HTTP 层（路由挂上了、守卫罩着它、形状对） ----------


def test_http_endpoints(monkeypatch):
    monkeypatch.setenv("WB_API_TOKEN", "t")
    from fastapi.testclient import TestClient

    from app.core import auth
    from app.main import app

    monkeypatch.setattr(auth, "_cached", None)
    c = TestClient(app)
    h = {"X-WB-Token": "t"}

    assert c.get("/api/decisions").status_code == 401  # 和其他 /api/* 一样要 token
    body = c.get("/api/decisions", headers=h).json()
    assert "entries" in body and "calibration" in body

    created = c.post("/api/decisions", json={"text": "HTTP 一条", "confidence": 80}, headers=h).json()
    assert created["confidence"] == 80 and created["outcome"] == ""
    assert c.put(f"/api/decisions/{created['id']}/review", json={"outcome": "hit"}, headers=h).json()["outcome"] == "hit"
    assert c.put(f"/api/decisions/{created['id']}/review", json={"outcome": "maybe"}, headers=h).status_code == 400
    assert c.put("/api/decisions/999999/review", json={"outcome": "hit"}, headers=h).status_code == 404
    assert c.post("/api/decisions", json={"text": "  "}, headers=h).status_code == 400
    assert c.delete(f"/api/decisions/{created['id']}", headers=h).json()["ok"] is True


# ---------- 到期见证（M4 · PLAN §3 G5） ----------


def _past(days: int) -> datetime:
    """`days` 天前的 **naive UTC**——就是库里那一列的口径（`utcnow()` 写 UTC，读出来是 naive）。"""
    return (datetime.now(timezone.utc) - timedelta(days=days)).replace(tzinfo=None)


def _wrow(id_: int = 1, days_ago: int = 100, witness_days=90, outcome: str = "", **kw):
    """够用的行替身：`due()` 只读这几个字段（与上面 `calibration` 那几条用例同一个做法）。

    刻意不叫 `_row`——那个是校准那几条用例的（`(confidence, outcome, topic)`），
    重名会**安静地把它们改坏**（第一版就是这么撞的）。
    """
    return SimpleNamespace(
        id=id_,
        text=kw.get("text", "先用 SQLite 就够"),
        basis=kw.get("basis", "数据量上不去"),
        topic="",
        confidence=kw.get("confidence", 70),
        created_at=_past(days_ago),
        reviewed_at=None,
        outcome=outcome,
        note="",
        witness_days=witness_days,
    )


async def _backdate(did: int, days: int) -> None:
    """把一条真行改到 `days` 天前——`add()` 只会写「此刻」，而这一条测的就是时间。

    **是 async 的**：调用它的用例本身就在事件循环里（`asyncio.run` 套 `asyncio.run`
    会直接抛「cannot be called from a running event loop」）。
    """
    from app.db import SessionLocal
    from app.models import DecisionLog

    async with SessionLocal() as db:
        row = await db.get(DecisionLog, did)
        row.created_at = _past(days)
        await db.commit()


def test_witness_due_at_is_written_plus_the_column():
    row = _wrow(days_ago=100, witness_days=30)
    assert dl.witness_due_at(row) == dl._when(row) + timedelta(days=30)


def test_a_missing_or_broken_column_falls_back_to_ninety():
    """老库（迁移还没跑）那一列读出来是 None，坏数据是串——一律按默认 90 天。

    这里的要点不是「容错」而是**默认值属于规矩**：读不出来就「永不到点」，
    正是这张表会退化成死数据的那种方式。
    """
    for wd in (None, "", "x", 0, -5):
        row = _wrow(days_ago=100, witness_days=wd)
        assert dl.witness_due_at(row) == dl._when(row) + timedelta(days=90), wd


def test_the_column_is_clamped_to_something_sane():
    row = _wrow(days_ago=100, witness_days=99999)
    assert dl.witness_due_at(row) == dl._when(row) + timedelta(days=dl.WITNESS_MAX)


def test_due_skips_reviewed_and_not_yet_due():
    rows = [
        _wrow(1, days_ago=100),  # 到点
        _wrow(2, days_ago=100, outcome="hit"),  # 回看过了：不是「到点」，是「看过了」
        _wrow(3, days_ago=10),  # 还没到
    ]
    assert [d["id"] for d in dl.due(rows)] == [1]


def test_due_puts_the_longest_overdue_first():
    """老行上线时会集体到点，先念最老的那条：它最可能已经见分晓、也最可能被忘干净。"""
    rows = [_wrow(1, days_ago=120), _wrow(2, days_ago=400), _wrow(3, days_ago=95)]
    assert [d["id"] for d in dl.due(rows)] == [2, 1, 3]


def test_age_days_counts_from_the_day_it_was_written():
    """台词说的是「三个月前你判断」——那是**判断的年纪**，不是到点之后过了多久。"""
    got = dl.due([_wrow(1, days_ago=100, witness_days=30)])[0]
    assert 99 <= got["age_days"] <= 100
    assert got["due_at"] is not None


def test_due_skips_rows_whose_time_is_unreadable():
    """宁可少念一条，也不编一个年纪出来。"""
    bad = _wrow(1)
    bad.created_at = None
    assert [d["id"] for d in dl.due([bad, _wrow(2, days_ago=100)])] == [2]
    assert dl.due([bad]) == []


def test_witness_returns_one_line_and_a_count():
    """**只回一条**：一次全摆出来就等于把 90 天前的一堆判断变成一张「你还欠」的账单。"""

    async def go():
        first = await dl.add("最老的那条", basis="当时只能这么选", confidence=70)
        second = await dl.add("次老的", basis="", confidence=60)
        await _backdate(first["id"], 400)
        await _backdate(second["id"], 200)
        try:
            got = await dl.witness()
            assert got["count"] == 2 and got["due"]["id"] == first["id"]
            assert got["due"]["age_days"] >= 399
            # 回看掉第一条 → 下一条顶上来（回看是拉取式的，这一步只有人做）
            await dl.review(first["id"], "hit", "")
            got2 = await dl.witness()
            assert got2["count"] == 1 and got2["due"]["id"] == second["id"]
        finally:
            await dl.remove(first["id"])
            await dl.remove(second["id"])

    asyncio.run(go())


def test_witness_is_silent_on_an_empty_log():
    async def go():
        got = await dl.witness()
        assert got == {"due": None, "count": 0}

    asyncio.run(go())


def test_add_carries_the_column_and_clamps_it():
    """写行与读行走**同一个** `clamp_witness_days`：两处各写一遍迟早给出两个答案。"""

    async def go():
        row = await dl.add("没给就用默认", witness_days=0)  # 0 会让「刚写完就催你回看」
        assert row["witness_days"] == dl.WITNESS_DAYS
        await dl.remove(row["id"])
        big = await dl.add("十年封顶", witness_days=99999)
        assert big["witness_days"] == dl.WITNESS_MAX
        await dl.remove(big["id"])

    asyncio.run(go())


def test_http_witness_endpoint(monkeypatch):
    monkeypatch.setenv("WB_API_TOKEN", "t")
    from fastapi.testclient import TestClient

    from app.core import auth
    from app.main import app

    monkeypatch.setattr(auth, "_cached", None)
    c = TestClient(app)
    h = {"X-WB-Token": "t"}

    assert c.get("/api/decisions/witness").status_code == 401
    assert c.get("/api/decisions/witness", headers=h).json() == {"due": None, "count": 0}

    async def seed():
        row = await dl.add("三个月前那条", basis="凭当时的量级估算", confidence=70)
        await _backdate(row["id"], 120)
        return row["id"]

    did = asyncio.run(seed())
    try:
        got = c.get("/api/decisions/witness", headers=h).json()
        assert got["count"] == 1
        # 台词要能**引用原文依据**（PLAN §3 G5 的验收）：三个字段一个都不能少
        assert got["due"]["text"] == "三个月前那条"
        assert got["due"]["basis"] == "凭当时的量级估算"
        assert got["due"]["confidence"] == 70
    finally:
        asyncio.run(dl.remove(did))


def test_the_reason_it_bends_the_rule_is_still_written_down():
    """规矩可以让开，**理由不能丢**（PLAN §3 G5 的验收就要求钉住这个）。

    钉的是「为什么」：原来那条是拉取式；这次可以，是因为纯拉取式在 90 天的尺度上会
    让这张表变成死数据，所以接进**现有 nudge 管线**、一天一条、只说当时的事实。
    下一个人翻到这里，第一眼就该看到这段，而不是只看到 `witness()` 在催人。
    """
    from app import models

    assert "拉取式" in dl.__doc__ and "死数据" in dl.__doc__ and "nudge" in dl.__doc__
    assert "让开" in dl.__doc__
    # 表上那份说明说的是同一件事——只改一处的话，另一处就成了自相矛盾
    assert "让开" in models.DecisionLog.__doc__
    assert "witness_days" in models.DecisionLog.__doc__
