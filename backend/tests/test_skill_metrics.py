"""技能闭环度量（PLAN3 §6）的离线测试：漏斗的三个数 + 注入那一格。

这一层的全部价值在**不编**：没有注入就是 0 次带注入、没有可读的接地分就是 `mean=None`、
一份技能都没有就是空表。所以测试钉的是这几条，以及红线（本模块一行 `pet.*` 都没有）。
"""
import ast
import asyncio
from datetime import timedelta
import sys
from pathlib import Path

import pytest
from sqlalchemy import delete

sys.path.insert(0, ".")

from app.core import skill_metrics as sm  # noqa: E402
from app.core import tasks as tasks_core  # noqa: E402
from app.db import SessionLocal, engine  # noqa: E402
from app.models import Base, ScheduledTask, TaskRun  # noqa: E402


async def _init_db() -> None:
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)


asyncio.run(_init_db())


@pytest.fixture(autouse=True)
def _clean_runs():
    """每个用例一份干净的任务/运行表（模块内跨用例的状态要各自收，见 `docs/testing.md` §4）。"""

    async def _wipe() -> None:
        async with SessionLocal() as db:
            for model in (TaskRun, ScheduledTask):
                await db.execute(delete(model))
            await db.commit()

    asyncio.run(_wipe())
    yield


def _row(name: str, used: int = 0, cases: int = 0, registered: bool = False, stale: bool = False) -> dict:
    return {
        "name": name,
        "trials": {"n": used, "last_at": None, "last_ts": None},
        "cases": cases,
        "registered": registered,
        "stale": stale,
    }


# ---------- 漏斗（纯函数） ----------


def test_funnel_counts_the_three_stages_separately():
    """三个数分段数的是**不同单位**（次数 / 条数 / 份数），所以合计分开给、不做转化率。"""
    got = sm.funnel(
        [
            _row("甲", used=3, cases=2, registered=True),
            _row("乙", used=0, cases=0),
            _row("丙", used=1, cases=3),
        ]
    )

    assert got["totals"] == {
        "skills": 3,
        "used": 4,  # 被注入的总次数
        "with_cases": 1 + 1,  # 有用例的技能份数（甲、丙）
        "cases": 5,  # 用例总条数
        "registered": 1,  # 升格份数
    }
    assert [r["name"] for r in got["skills"]] == ["甲", "乙", "丙"]
    assert got["skills"][0]["registered"] is True


def test_funnel_is_empty_when_there_are_no_skills():
    assert sm.funnel([])["totals"] == {
        "skills": 0,
        "used": 0,
        "with_cases": 0,
        "cases": 0,
        "registered": 0,
    }


def test_funnel_survives_a_row_without_trials():
    """坏行/老行不该把看板弄成故障源（缺字段 → 当成 0，不是抛）。"""
    got = sm.funnel([{"name": "甲"}])
    assert got["skills"][0]["used"] == 0 and got["skills"][0]["cases"] == 0


# ---------- 均值的分母 ----------


def test_mean_is_none_when_nothing_is_readable():
    """**空着不是 0 分**：没材料可判与判了 0 分是两件事。"""
    assert sm.mean_of([]) == {"n": 0, "mean": None}
    assert sm.mean_of([None, None]) == {"n": 0, "mean": None}
    assert sm.mean_of([4, None, 5]) == {"n": 2, "mean": 4.5}
    assert sm.mean_of([0, 0]) == {"n": 2, "mean": 0.0}  # 真的有 0 分时才是 0


def test_split_injected_counts_both_halves():
    runs = [("compose", 4, True), ("compose", 5, False), ("research", None, False)]
    got = sm.split_injected(runs)
    assert got["runs"] == {"total": 3, "injected": 1, "plain": 2}
    assert got["grounded"]["injected"] == {"n": 1, "mean": 4.0}
    assert got["grounded"]["plain"] == {"n": 1, "mean": 5.0}  # 那条 None 不进分母


# ---------- 真行 ----------


async def _mk_task(name: str, action: str) -> int:
    async with SessionLocal() as db:
        row = ScheduledTask(name=name, prompt="话题", cron="0 9 * * *", action=action)
        db.add(row)
        await db.commit()
        await db.refresh(row)
        return row.id


async def _mk_run(task_id: int, *, injected: bool = False, grounded: int | None = None, ago_days: float = 0) -> None:
    import json

    async with SessionLocal() as db:
        row = TaskRun(
            task_id=task_id,
            status="ok",
            grounded=grounded,
            log_json=json.dumps(
                [{"tool": "skill_inject", "args": {"skills": ["甲工序"]}, "ok": True, "result": "本次注入：甲工序"}]
                if injected
                else []
            ),
        )
        # 列是 naive UTC（`models.utcnow` 那一族）——窗口边界也得是同一个口径才比得对
        row.started_at = sm._naive_utc_now() - timedelta(days=ago_days)
        db.add(row)
        await db.commit()


async def test_injection_counts_engine_runs_only():
    """只数**引擎运行**：普通提示词步/转写根本没有注入这回事，算进分母会把比例读成「任务里有多少是引擎」。"""
    compose = await _mk_task("产出", "compose")
    plain_step = await _mk_task("普通提示词", "prompt")
    await _mk_run(compose, injected=True, grounded=4)
    await _mk_run(compose, grounded=5)
    await _mk_run(plain_step, grounded=1)

    got = await sm.injection()

    assert got["readable"] is True
    assert got["runs"] == {"total": 2, "injected": 1, "plain": 1}
    assert got["grounded"]["injected"] == {"n": 1, "mean": 4.0}
    assert got["grounded"]["plain"] == {"n": 1, "mean": 5.0}
    assert [e["engine"] for e in got["by_engine"]] == ["compose"]
    assert got["by_engine"][0]["label"] == tasks_core.ENGINE_LABELS["compose"]


async def test_injection_window_excludes_older_runs():
    compose = await _mk_task("产出", "compose")
    await _mk_run(compose, injected=True, ago_days=1)
    await _mk_run(compose, injected=True, ago_days=40)

    got = await sm.injection(days=30)

    assert got["runs"]["total"] == 1 and got["runs"]["injected"] == 1


async def test_no_engine_runs_at_all_is_an_honest_zero():
    """一次引擎运行都没有 → 0 次带注入、接地分读不到（`n=0` 而不是「0 分」）。"""
    got = await sm.injection()

    assert got["readable"] is True
    assert got["runs"] == {"total": 0, "injected": 0, "plain": 0}
    assert got["grounded"]["injected"] == {"n": 0, "mean": None}
    assert got["by_engine"] == []


async def test_the_board_reads_the_same_report_the_skill_page_reads(monkeypatch):
    """漏斗读 `skill_eval.report()`——**同一条事实不许有两个出处**。"""
    from app.core import skill_eval

    async def fake_report() -> dict:
        return {"skills": [_row("甲", used=2, cases=1, registered=True)]}

    monkeypatch.setattr(skill_eval, "report", fake_report)

    got = await sm.funnel_board()

    assert got["readable"] is True
    assert got["totals"]["registered"] == 1 and got["totals"]["used"] == 2
    assert got["window"] > 0
    assert set(got["rules"]) == {"used", "cases", "registered", "window"}


async def test_a_broken_report_says_it_cannot_read(monkeypatch):
    """读不到就说读不到——不摆一张全零的表。"""
    from app.core import skill_eval

    async def boom() -> dict:
        raise RuntimeError("库挂了")

    monkeypatch.setattr(skill_eval, "report", boom)

    got = await sm.funnel_board()

    assert got["readable"] is False and "库挂了" in got["error"]
    assert got["skills"] == [] and got["totals"]["skills"] == 0


# ---------- 红线 ----------


def test_the_board_never_speaks():
    """与 `metrics.py` 同一条红线：源码里一行 `pet.*` 都没有（扫语法树，不扫字面）。"""
    src = Path("app/core/skill_metrics.py").read_text(encoding="utf-8")
    used = sorted(
        {
            n.attr
            for n in ast.walk(ast.parse(src))
            if isinstance(n, ast.Attribute) and getattr(n.value, "id", "") == "pet"
        }
    )
    assert used == []
    assert "pet_events" not in src
