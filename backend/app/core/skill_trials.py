"""草稿试用期（PLAN3 S3）：一份草稿在**真实工作**里被用过几次、效果如何。

## 真值只有一份

S1 在运行时把「本次注入：xxx」写进了 `task_runs.log_json`（`skill_match.log_entry`）。这一层
只做**派生视图**：把那些运行挑出来、按技能名分组，一条真值都不新增（PLAN3 §3 的「零新表零新列」）。

## 窗口必须写在界面上（PLAN3 §9.2 决策1）

`tasks._RUNS_KEEP = 20`：每个任务只留最近 20 条运行，跑完就删。所以这个数是**窗口内的**、
会随着老运行被删而缩水——界面上要写「最近 20 次运行内被用过 N 次」，**不许写成「共 N 次」**。
真正耐久的是用例：一挑就落进 `evals/skills/*.json`（进 git、可审、可回滚）。

## 这一层不改尺子

`skill_eval` 的 `MIN_CASES` / Wilson / `registered` 一个不动（PLAN3 §7）：试用期只解决
「用例从哪来」和「草稿别死」，不替代量法——**试用 ≠ 对照**（试用只有「有它」侧，没有基线）。
"""
import json
import logging
from datetime import datetime, timezone

log = logging.getLogger(__name__)

# 与 `tasks._RUNS_KEEP` 是同一个数（那一处决定运行日志留多久，这一处决定了这个数能数到多老）。
# 有测试钉着两者相等：改了一边而没改另一边，界面上的「最近 N 次运行内」就开始说谎。
WINDOW = 20
# 产出预览的上限：这一列是给人判「这次试用算不算数」用的，不是把正文抄一份（正文在运行详情里）
ANSWER_PREVIEW = 800


def trials_of(rows: list[dict], name: str) -> list[dict]:
    """一批运行 → 这份技能的试用记录（新→旧）。Pure.

    一次运行可以同时注入两份技能（`MAX_INJECT = 2`），两边都算用过它一次——
    那是真的两次试用，不是重复计数。
    """
    return [r for r in rows if name in (r.get("skills") or [])]


def summarise(rows: list[dict], name: str) -> dict:
    """这份技能的试用小结。Pure. 没被用过时 `n=0`、`last_at=None`——**不编一个日期出来**。

    `last_ts` 是 epoch 秒：界面用 `ago()` 说「几天前」时要按真实时刻算，
    拿 naive 的 ISO 串去 `new Date()` 会被当成本地时间、错几小时。
    """
    mine = trials_of(rows, name)
    return {
        "n": len(mine),
        "last_at": (mine[0].get("started_at") or None) if mine else None,
        "last_ts": (mine[0].get("at_ts") if mine else None),
    }


def epoch(dt: datetime | None) -> int | None:
    """ORM 的时间列 → epoch 秒。Pure.

    ORM 那一列是**naive UTC**（`models.utcnow`），所以这里显式补上 UTC 再转——
    否则浏览器会按本地时区理解它，「最近一次几天前」就会错几个小时（跨天时看着像另一天）。
    """
    if dt is None:
        return None
    return int((dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)).timestamp())


async def recent(*, limit: int = 0) -> list[dict]:
    """最近一批「注入过技能」的运行（新→旧），每条带上注入清单、题目、产出、接地分。

    这是这一层唯一的 I/O。查询用 `LIKE` 做个廉价预筛，**真正的判据是解析出来的 JSON**——
    文本匹配只用来少读几行，不用来下结论。读不到就返回空表（看板是观察面，不能变成故障源）。
    """
    from sqlalchemy import select

    from app.db import SessionLocal
    from app.models import ScheduledTask, TaskRun, Thread

    try:
        async with SessionLocal() as db:
            stmt = (
                select(TaskRun)
                .where(TaskRun.log_json.like('%"skill_inject"%'))
                .order_by(TaskRun.id.desc())
            )
            if limit:
                stmt = stmt.limit(max(1, limit))
            runs = list((await db.execute(stmt)).scalars().all())
            if not runs:
                return []
            tasks = {
                t.id: t
                for t in (
                    await db.execute(
                        select(ScheduledTask).where(ScheduledTask.id.in_({r.task_id for r in runs}))
                    )
                ).scalars().all()
            }
            thread_ids = {r.thread_id for r in runs if r.thread_id}
            names = {
                t.id: t.name
                for t in (
                    await db.execute(select(Thread).where(Thread.id.in_(thread_ids)))
                ).scalars().all()
            } if thread_ids else {}
    except Exception:  # noqa: BLE001 - 观察面读不到就说读不到，不抛
        log.warning("skill trials query failed", exc_info=True)
        return []

    out: list[dict] = []
    for r in runs:
        skills: list[str] = []
        for entry in _entries(r.log_json):
            if entry.get("tool") == "skill_inject":
                skills += [str(n) for n in (entry.get("args") or {}).get("skills") or []]
        if not skills:
            continue  # LIKE 命中了但结构对不上（手改过 / 老格式）：不当成试用
        task = tasks.get(r.task_id)
        from app.core.tasks import run_topic

        out.append(
            {
                "run_id": r.id,
                "task_id": r.task_id,
                "task_name": (task.name if task else "") or "",
                # 题目：与 S2 的「读成技能」同一条规则（那件「事」的名字优先，否则任务指令）
                "topic": run_topic(
                    (task.prompt if task else "") or "", names.get(r.thread_id or 0) or ""
                ),
                "status": r.status,
                "started_at": r.started_at.isoformat(timespec="seconds") if r.started_at else None,
                "at_ts": epoch(r.started_at),
                "grounded": r.grounded,
                "skills": skills,
                "answer": (r.answer or "")[:ANSWER_PREVIEW],
            }
        )
    return out


def _entries(log_json: str) -> list[dict]:
    """`task_runs.log_json` → 日志项列表（坏 JSON 当空表，不炸）。Pure."""
    try:
        rows = json.loads(log_json or "[]")
    except (TypeError, ValueError):
        return []
    return [r for r in rows if isinstance(r, dict)] if isinstance(rows, list) else []


async def for_skill(name: str) -> dict:
    """一份技能的试用记录（界面上的「试用期」那一块）。`window` 一并给出去，免得界面自己写死。"""
    rows = await recent(limit=WINDOW * 4)  # 一次多取些：同一次运行可能同时注入两份技能
    mine = trials_of(rows, name)
    return {
        "skill": name,
        "window": WINDOW,
        "n": len(mine),
        "last_at": (mine[0]["started_at"] if mine else None),
        "last_ts": (mine[0]["at_ts"] if mine else None),
        "trials": mine,
    }


async def counts(names: list[str]) -> dict[str, dict]:
    """一次查询，把好几份技能的试用小结都算出来（`skill_eval.report()` 用，别一份一个查询）。"""
    rows = await recent(limit=WINDOW * 4)
    return {n: summarise(rows, n) for n in names}
