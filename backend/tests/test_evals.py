"""评测回归对比与健康度诊断的测试。

纯函数（source_matches/_rank_of/_compare_two）不碰 DB；DB 部分靠 conftest 的
sandbox 隔离，每个测试先清空 eval 表避免串扰。
"""
import sys
from pathlib import Path

import pytest
from fastapi import HTTPException
from sqlalchemy import delete

sys.path.insert(0, str(Path(__file__).parent.parent))

from app.core import evals as core
from app.db import SessionLocal, engine
from app.models import Base, EvalItem, EvalRun


async def _init_db() -> None:
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)


async def _clear() -> None:
    async with SessionLocal() as db:
        await db.execute(delete(EvalRun))
        await db.execute(delete(EvalItem))
        await db.commit()


# ---------- 纯函数：source_matches / _rank_of ----------


def test_source_matches_full_path():
    assert core.source_matches("notes/测试笔记.md", "notes/测试笔记.md") is True


def test_source_matches_bare_filename():
    # 期望源只给裸文件名时，按 basename 匹配
    assert core.source_matches("测试笔记.md", "vault/notes/测试笔记.md") is True


def test_source_matches_normalizes_slashes_and_case():
    assert core.source_matches("Notes/Foo.md", "notes/foo.md") is True
    assert core.source_matches("./notes/foo.md", "notes/foo.md") is True


def test_source_matches_negative_and_empty():
    assert core.source_matches("a.md", "b.md") is False
    assert core.source_matches("", "x.md") is False
    assert core.source_matches("a.md", None) is False
    assert core.source_matches("a.md", "") is False


def test_rank_of():
    hits = [{"source": "a.md"}, {"source": "b.md"}, {"source": "c.md"}]
    assert core._rank_of("b.md", hits) == 2
    assert core._rank_of("c.md", hits) == 3
    assert core._rank_of("zzz.md", hits) is None


# ---------- 纯函数：_compare_two ----------


def test_compare_two_flags_regression():
    newer = {"hit1": 0.6, "hit3": 0.9, "hitk": 1.0, "mrr": 0.7, "faithfulness": 4.0}
    older = {"hit1": 0.8, "hit3": 0.9, "hitk": 1.0, "mrr": 0.8, "faithfulness": 4.5}
    out = core._compare_two(newer, older)
    assert out["regressions"] == ["faithfulness", "hit1", "mrr"]
    assert out["improvements"] == []
    assert out["deltas"]["hit1"] == -0.2
    assert out["deltas"]["faithfulness"] == -0.5


def test_compare_two_skips_none():
    newer = {"hit1": 0.6, "faithfulness": None}
    older = {"hit1": 0.8, "faithfulness": 4.0}
    out = core._compare_two(newer, older)
    assert "faithfulness" not in out["deltas"]  # 任一侧 None 都跳过
    assert out["deltas"]["hit1"] == -0.2


def test_compare_two_ignores_noise():
    newer = {"hit1": 0.8, "mrr": 0.7, "faithfulness": None}
    older = {"hit1": 0.8, "mrr": 0.7, "faithfulness": None}
    out = core._compare_two(newer, older)
    assert out["deltas"] == {}
    assert out["regressions"] == []
    assert out["improvements"] == []


# ---------- DB：compare_history ----------


async def test_compare_history_needs_two_runs():
    await _init_db()
    await _clear()
    async with SessionLocal() as db:
        db.add(EvalRun(hit1=0.8, mrr=0.8))
        await db.commit()
    out = await core.compare_history()
    assert out["comparison"] is None
    assert "两次" in out["conclusion"]


async def test_compare_history_flags_regression():
    await _init_db()
    await _clear()
    async with SessionLocal() as db:
        db.add(EvalRun(hit1=0.8, hit3=0.9, hitk=1.0, mrr=0.8, faithfulness=4.5))  # 旧
        db.add(EvalRun(hit1=0.6, hit3=0.7, hitk=0.9, mrr=0.7, faithfulness=4.0))  # 新
        await db.commit()
    out = await core.compare_history()
    assert out["comparison"] is not None
    assert out["comparison"]["regressions"] == ["faithfulness", "hit1", "hit3", "hitk", "mrr"]
    assert "变差" in out["conclusion"]
    # 最新对上次的主结论之外，还有逐段 history
    assert len(out["history"]) == 1


async def test_compare_history_improvement():
    await _init_db()
    await _clear()
    async with SessionLocal() as db:
        db.add(EvalRun(hit1=0.5, mrr=0.5))  # 旧
        db.add(EvalRun(hit1=0.8, mrr=0.8))  # 新
        await db.commit()
    out = await core.compare_history()
    assert out["comparison"]["improvements"] == ["hit1", "mrr"]
    assert "变好" in out["conclusion"]


# ---------- DB：eval_health ----------


async def test_eval_health_empty():
    await _init_db()
    await _clear()
    h = await core.eval_health()
    assert h["total"] == 0
    assert any("空" in w for w in h["warnings"])


async def test_eval_health_too_small_and_all_perfect():
    await _init_db()
    await _clear()
    async with SessionLocal() as db:
        for q in ["q1", "q2", "q3"]:
            db.add(EvalItem(question=q, expected_source="a.md"))
        db.add(EvalRun(hit1=1.0, hit3=1.0, hitk=1.0, mrr=1.0, total=3))
        await db.commit()
    h = await core.eval_health()
    assert h["total"] == 3
    assert h["labelled"] == 3
    assert any("区分度" in w for w in h["warnings"])
    assert any("全满分" in w for w in h["warnings"])


async def test_eval_health_unlabelled():
    await _init_db()
    await _clear()
    async with SessionLocal() as db:
        db.add(EvalItem(question="q1", expected_source=""))
        await db.commit()
    h = await core.eval_health()
    assert h["unlabelled"] == 1
    assert any("没有期望源" in w for w in h["warnings"])


# ---------- 合作式取消（方向 2）----------


async def test_one_case_skips_entirely_when_cancel_requested(monkeypatch):
    """开头就查：被取消的用例检索都不该跑，skipped 标记给聚合过滤。"""
    import asyncio

    from fastapi import HTTPException
    from app.core import inflight, indexer
    from app.routers import evals as router

    async def boom(*a, **k):  # noqa: ARG001
        raise AssertionError("被取消的用例不该再花一次检索")

    monkeypatch.setattr(indexer, "search_auto", boom)
    assert inflight.try_acquire("kb_eval")
    try:
        assert inflight.request_cancel("kb_eval") is True
        out = await core._one_case(
            {"id": 1, "question": "q", "expected_source": ""},
            5,
            None,
            "",
            asyncio.Semaphore(1),
            "kb_eval",
        )
        assert out.get("skipped") is True
        # 锁被占着 → 并发进来要 409；取消要如实说停上了
        with pytest.raises(HTTPException) as ei:
            await router.run_eval(None)
        assert ei.value.status_code == 409
        assert await router.cancel_run_eval() == {"stopped": True}
    finally:
        inflight.release("kb_eval")
    # 没在跑时取消要如实说 stopped:false——不假装停成功
    assert await router.cancel_run_eval() == {"stopped": False}


async def test_cancelled_eval_run_marks_stopped_in_response(monkeypatch):
    """run_eval 的响应要带 stopped —— 界面靠它说「提前收工」，不靠猜。"""
    import asyncio

    from app.core import inflight, indexer

    async def fake_one_case(case, top_k, info, model, sem, cancel_key=""):  # noqa: ARG001
        skipped = bool(cancel_key)
        return {
            **case,
            # 开头就被跳过的用例 rank 是 None（真实代码同形），聚合自然把它滤掉
            "rank": None if skipped else 1,
            "hits": [],
            "answer": "",
            "score": None,
            "reason": "",
            "error": "",
            "skipped": skipped,
        }

    monkeypatch.setattr(core, "_one_case", fake_one_case)
    await _init_db()
    await _clear()
    async with SessionLocal() as db:
        db.add(EvalItem(question="q1", expected_source="notes/a.md"))
        await db.commit()

    out = await core.run_eval(top_k=5, judge=False, cancel_key="kb_eval-x")
    assert out["stopped"] is True
    # 被跳过的用例没有 rank —— 不给指标添假分（与既有 error 用例同一口径：进分母、不进分子）
    assert out["labelled"] == 1
    assert out["hit1"] == 0
