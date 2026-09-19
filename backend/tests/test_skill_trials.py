"""草稿试用期（PLAN3 S3）的离线测试：从运行日志聚合「这份草稿在真实工作里被用过几次」。

真值只有一份（`task_runs.log_json` 里那条 `skill_inject`），所以这里钉的是**派生得对不对**、
**窗口写没写明**、以及**读不到时会不会编一个数字或日期出来**。
"""
import asyncio
import json
import sys

import pytest
from sqlalchemy import delete

sys.path.insert(0, ".")

from app.core import skill_match  # noqa: E402
from app.core import skill_trials as st  # noqa: E402
from app.core import tasks as tasks_core  # noqa: E402
from app.db import SessionLocal, engine  # noqa: E402
from app.models import Base, ScheduledTask, TaskRun, Thread  # noqa: E402


async def _init_db() -> None:
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)


asyncio.run(_init_db())


@pytest.fixture(autouse=True)
def _clean_runs():
    """每个用例一份干净的三张表。

    `conftest` 只在**模块开始时**清沙箱，模块内跨用例的状态得各自收（`docs/testing.md` §4
    第一条就是这条坑）——运行日志是这一层唯一的输入，上一个用例留下的运行会直接改数。
    """

    async def _wipe() -> None:
        async with SessionLocal() as db:
            for model in (TaskRun, ScheduledTask, Thread):
                await db.execute(delete(model))
            await db.commit()

    asyncio.run(_wipe())
    yield


def _log(*names: str) -> str:
    """S1 写进去的那种日志（**用写它的那个函数来造**，免得两边形状各走各的）。"""
    return json.dumps([skill_match.log_entry({"names": list(names)})], ensure_ascii=False)


async def _mk_task(name: str = "每周产出", prompt: str = "给领导汇报这次项目的结论") -> int:
    async with SessionLocal() as db:
        row = ScheduledTask(name=name, prompt=prompt, cron="0 9 * * *", action="compose")
        db.add(row)
        await db.commit()
        await db.refresh(row)
        return row.id


async def _mk_thread(name: str) -> int:
    async with SessionLocal() as db:
        row = Thread(name=name)
        db.add(row)
        await db.commit()
        await db.refresh(row)
        return row.id


async def _mk_run(
    task_id: int,
    *,
    log_json: str = "[]",
    answer: str = "产出",
    thread_id: int | None = None,
    grounded: int | None = None,
    status: str = "ok",
) -> int:
    async with SessionLocal() as db:
        row = TaskRun(
            task_id=task_id,
            answer=answer,
            status=status,
            log_json=log_json,
            thread_id=thread_id,
            grounded=grounded,
        )
        db.add(row)
        await db.commit()
        await db.refresh(row)
        return row.id


# ---------- 窗口 ----------


def test_the_window_is_the_run_log_retention():
    """界面上的「最近 N 次运行内」必须等于运行日志真正留多久（`tasks._RUNS_KEEP`）。

    改了一边而没改另一边，那句话就开始说谎——所以钉住它们相等，而不是各写一个数。
    """
    assert st.WINDOW == tasks_core._RUNS_KEEP  # noqa: SLF001 - 故意的：这两个数是一回事


# ---------- 派生得对不对 ----------


async def test_a_run_that_ate_the_skill_is_a_trial():
    """真行：一次带注入的运行 → 一条试用记录，题目 / 产出 / 接地分都在。"""
    tid = await _mk_task()
    rid = await _mk_run(tid, log_json=_log("给领导写汇报要结论先行"), answer="## 结论\n先说结论", grounded=4)

    got = await st.for_skill("给领导写汇报要结论先行")

    assert got["n"] == 1 and got["window"] == st.WINDOW
    one = got["trials"][0]
    assert one["run_id"] == rid and one["task_name"] == "每周产出"
    assert one["topic"] == "给领导汇报这次项目的结论"  # 没有那件「事」→ 用任务指令
    assert one["grounded"] == 4 and "先说结论" in one["answer"]
    assert got["last_at"] == one["started_at"]
    # epoch 秒：界面按它说「几天前」，不许把 naive 的 ISO 当本地时间算
    assert isinstance(got["last_ts"], int) and got["last_ts"] > 0
    assert got["last_ts"] == one["at_ts"]


async def test_a_run_that_ate_another_skill_does_not_count():
    tid = await _mk_task()
    await _mk_run(tid, log_json=_log("别的一份技能"))

    got = await st.for_skill("给领导写汇报要结论先行")

    assert got["n"] == 0 and got["trials"] == [] and got["last_at"] is None


async def test_one_run_can_be_a_trial_for_both_skills():
    """一次运行最多注入两份（`MAX_INJECT = 2`）——那是**两次试用**，不是重复计数。"""
    tid = await _mk_task()
    await _mk_run(tid, log_json=_log("甲工序", "乙工序"))

    assert (await st.for_skill("甲工序"))["n"] == 1
    assert (await st.for_skill("乙工序"))["n"] == 1
    got = await st.counts(["甲工序", "乙工序", "没人用的工序"])
    assert got["甲工序"]["n"] == 1 and got["乙工序"]["n"] == 1
    assert got["没人用的工序"] == {"n": 0, "last_at": None, "last_ts": None}


async def test_the_topic_prefers_the_thing_the_run_was_working_on():
    """有那件「事」时题目取它的名字（与 S2 的「读成技能」同一条规则，`tasks.run_topic`）。"""
    th = await _mk_thread("手机换不换")
    tid = await _mk_task(prompt="下面是这次调研的产出…")  # 链条中段那种模板指令
    await _mk_run(tid, log_json=_log("甲工序"), thread_id=th)

    one = (await st.for_skill("甲工序"))["trials"][0]

    assert one["topic"] == "手机换不换"


async def test_the_answer_is_only_a_preview():
    """产出只带一段预览：它是给人判「这次试用算不算数」的，不是把正文抄一份（正文在运行详情里）。"""
    tid = await _mk_task()
    await _mk_run(tid, log_json=_log("甲工序"), answer="正" * 3000)

    one = (await st.for_skill("甲工序"))["trials"][0]

    assert len(one["answer"]) == st.ANSWER_PREVIEW


async def test_newest_first():
    tid = await _mk_task()
    first = await _mk_run(tid, log_json=_log("甲工序"))
    second = await _mk_run(tid, log_json=_log("甲工序"))

    got = await st.for_skill("甲工序")

    assert [t["run_id"] for t in got["trials"]] == [second, first]


# ---------- 读不到就说读不到 ----------


async def test_broken_or_foreign_logs_are_not_trials():
    """`LIKE` 只是廉价预筛，**判据是解析出来的结构**：坏 JSON / 不是一个列表 / 没这一项，都不算。"""
    tid = await _mk_task()
    await _mk_run(tid, log_json="不是 JSON")
    await _mk_run(tid, log_json='{"tool": "skill_inject"}')  # 不是列表
    await _mk_run(tid, log_json=json.dumps([{"tool": "别的工具", "args": {}}], ensure_ascii=False))
    await _mk_run(tid, log_json=json.dumps([skill_match.log_entry({"names": []})], ensure_ascii=False))

    got = await st.for_skill("甲工序")

    assert got["n"] == 0 and got["trials"] == []


async def test_no_runs_at_all_is_an_empty_answer():
    assert (await st.for_skill("甲工序"))["n"] == 0
    assert await st.recent() == []
