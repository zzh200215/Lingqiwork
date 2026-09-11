"""决策日志 + 校准分（PLAN §10.3 C）的离线测试。

重点在**校准那套纯算术**：命中率的样本下限、按信心分档、按领域分组、以及「说不清」
不进分母。这些是这条链路唯一会出错也不会被肉眼发现的地方。存取那一层只测往返与守卫。
"""
import asyncio

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
