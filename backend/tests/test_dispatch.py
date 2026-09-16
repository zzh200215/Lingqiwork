"""调度台（Q4）的测试：**状态必须是算出来的**，而且只从现成两张表算。

分三层：
1. `compute()` 纯函数：链条怎么串、每一步什么状态、卡在哪、下一步是谁、给哪个按钮。
2. `broadcast()`：宠物那一句 —— **只说事实**（谁在跑、谁在等），不催不排名，也不编「一切正常」。
3. `board()` 读库那一层：真的从 `tasks` / `task_runs` 里算，而不是自己造一份状态。
"""
import asyncio
import sys

sys.path.insert(0, ".")

from app.core import dispatch  # noqa: E402


def _task(tid, name=None, *, next_id=None, enabled=True, mode="simple", model="", approval=False):
    return {
        "id": tid,
        "name": name or f"任务 {tid}",
        "enabled": enabled,
        "mode": mode,
        "model_id": model,
        "chain_next_id": next_id,
        "require_approval": approval,
    }


def _run(rid, tid, status, **extra):
    base = {"id": rid, "task_id": tid, "status": status, "started_at": "", "finished_at": "", "error": "", "grounded": None}
    base.update(extra)
    return base


# ---------- 1. 纯函数：串链 + 状态 ----------


def test_a_two_step_chain_shows_both_steps_in_order():
    out = dispatch.compute([_task(1, "写草稿", next_id=2), _task(2, "审一遍")], [_run(10, 1, "ok")])
    chain = out["chains"][0]
    assert chain["length"] == 2
    assert [s["name"] for s in chain["steps"]] == ["写草稿", "审一遍"]
    assert [s["state"] for s in chain["steps"]] == ["ok", "idle"]


def test_an_awaiting_step_is_where_the_chain_is_stuck_and_it_offers_放行():
    """验收原话：一条两步任务链要看得见「卡在哪、点谁放行」。"""
    out = dispatch.compute(
        [_task(1, "写草稿", next_id=2, approval=True), _task(2, "发出去")],
        [_run(10, 1, "awaiting_approval")],
    )
    chain = out["chains"][0]
    assert chain["needs_attention"] is True
    stuck = chain["stuck_at"]
    assert stuck["task_id"] == 1 and stuck["state"] == "awaiting"
    kinds = [a["kind"] for a in stuck["actions"]]
    assert kinds == ["approve", "reject"], "等人点头那一步两个按钮都要给（run / approve / reject）"
    assert stuck["actions"][0] == {"kind": "approve", "run_id": 10, "task_id": 1, "label": "放行"}
    # 下游：**等上一步**，而且没有按钮（上游没过，点它没有意义）
    assert chain["steps"][1]["state"] == "blocked"
    assert chain["steps"][1]["blocked_by"] == 1
    assert chain["steps"][1]["actions"] == []


def test_a_failed_step_offers_a_rerun_and_blocks_the_rest():
    out = dispatch.compute(
        [_task(1, "写草稿", next_id=2), _task(2, "发出去")],
        [_run(9, 1, "error", error="上游 500")],
    )
    chain = out["chains"][0]
    assert chain["steps"][0]["state"] == "error"
    assert chain["steps"][0]["error"] == "上游 500"
    assert chain["steps"][0]["actions"][0]["kind"] == "run"
    assert chain["steps"][1]["state"] == "blocked"


def test_a_running_step_is_reported_as_running_and_does_not_block_downstream():
    """在跑 ≠ 卡住：下游只是还没轮到，但**不该**被标成「等上一步」——那会让人以为要动手。"""
    out = dispatch.compute([_task(1, "写草稿", next_id=2), _task(2, "发出去")], [_run(7, 1, "running")])
    chain = out["chains"][0]
    assert chain["steps"][0]["state"] == "running"
    assert chain["steps"][1]["state"] == "idle"
    assert chain["needs_attention"] is False


def test_only_the_latest_run_counts():
    out = dispatch.compute([_task(1, "写草稿")], [_run(1, 1, "error"), _run(2, 1, "ok")])
    assert out["chains"][0]["steps"][0]["state"] == "ok"


def test_a_disabled_task_says_so_instead_of_pretending():
    out = dispatch.compute([_task(1, "写草稿", enabled=False)], [])
    assert out["chains"][0]["steps"][0]["state"] == "off"
    assert out["chains"][0]["steps"][0]["state_label"] == "停用了"


def test_who_runs_the_step_comes_from_the_task_itself():
    out = dispatch.compute(
        [
            _task(1, "甲", next_id=2, mode="agent", model="p/m"),
            _task(2, "乙", next_id=3, mode="agent"),
            _task(3, "丙"),
        ],
        [],
    )
    who = {s["name"]: s["who"] for s in out["chains"][0]["steps"]}
    assert who["甲"] == "p/m（agent）"
    assert who["乙"] == "默认模型（agent）"
    assert who["丙"] == "默认模型"


def test_two_independent_chains_are_both_listed_and_the_needy_one_comes_first():
    out = dispatch.compute(
        [
            _task(1, "平稳链"),
            _task(2, "等人的链", next_id=3, approval=True),
            _task(3, "下一步"),
        ],
        [_run(1, 1, "ok"), _run(2, 2, "awaiting_approval")],
    )
    assert [c["root_id"] for c in out["chains"]] == [2, 1]
    assert out["counts"]["chains"] == 2
    assert out["counts"]["needs_attention"] == 1


def test_an_empty_board_is_empty_not_invented():
    out = dispatch.compute([], [])
    assert out["chains"] == []
    assert out["counts"]["steps"] == 0


# ---------- 2. 宠物那一句：只说事实 ----------


def test_the_broadcast_says_who_is_waiting_and_what_to_click():
    out = dispatch.compute(
        [_task(1, "写草稿", next_id=2, approval=True), _task(2, "发出去")],
        [_run(1, 1, "awaiting_approval")],
    )
    line = dispatch.broadcast(out)
    assert "等你点头" in line and "写草稿" in line and "放行" in line


def test_the_broadcast_says_when_something_is_running():
    out = dispatch.compute([_task(1, "写草稿")], [_run(1, 1, "running")])
    assert "现在在跑" in dispatch.broadcast(out) and "写草稿" in dispatch.broadcast(out)


def test_the_broadcast_never_nags():
    """红线：这是看板不是考核。没有「该跑了 / 你落后了 / 今天还没做」这种话。"""
    for board in (
        dispatch.compute([_task(1, "甲")], [_run(1, 1, "ok")]),
        dispatch.compute([_task(1, "甲")], []),
        dispatch.compute([], []),
    ):
        line = dispatch.broadcast(board)
        for banned in ("该跑", "落后", "还没做", "注意", "必须", "赶紧"):
            assert banned not in line, line


def test_the_broadcast_says_nothing_is_running_instead_of_all_good():
    out = dispatch.compute([_task(1, "甲")], [_run(1, 1, "ok")])
    line = dispatch.broadcast(out)
    assert "没有在跑的东西" in line
    assert "一切正常" not in line


def test_an_empty_board_says_how_to_get_something_here():
    assert "还是空的" in dispatch.broadcast(dispatch.compute([], []))


# ---------- 3. 读库那一层：状态真的是从库里算的 ----------


def test_the_board_reads_the_real_tables():
    from app.db import SessionLocal, engine
    from app.models import Base, ScheduledTask, TaskRun

    async def go():
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
            await conn.run_sync(Base.metadata.create_all)
        async with SessionLocal() as db:
            db.add(ScheduledTask(id=1, name="写草稿", prompt="x", chain_next_id=2, require_approval=True))
            db.add(ScheduledTask(id=2, name="发出去", prompt="x"))
            await db.commit()
            db.add(TaskRun(task_id=1, status="awaiting_approval", trigger="chain"))
            await db.commit()
        return await dispatch.board()

    out = asyncio.run(go())
    chain = out["chains"][0]
    assert [s["name"] for s in chain["steps"]] == ["写草稿", "发出去"]
    assert chain["steps"][0]["state"] == "awaiting"
    assert chain["steps"][1]["state"] == "blocked"
    assert "等你点头" in out["broadcast"]
