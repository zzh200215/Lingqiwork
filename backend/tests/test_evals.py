"""评测回归对比与健康度诊断的测试。

纯函数（source_matches/_rank_of/_compare_two）不碰 DB；DB 部分靠 conftest 的
sandbox 隔离，每个测试先清空 eval 表避免串扰。
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from sqlalchemy import delete

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
