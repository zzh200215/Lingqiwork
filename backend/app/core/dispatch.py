"""Q4 调度台：把**确定性编排**画出来 —— 谁在跑、卡在哪、等谁点头。

**不做自主 PM**（`docs/ai-dev-plan.md` ③ 的三条理由：仓库自己否决过、单 agent 的失真会相乘、
最阴的失败是「编排者拿着不完整信息继续推进」）。这一层因此只有两个动作：**算**与**画**。

**零新真值**：每一步的状态都从两张现成的表算出来 ——

| 算什么 | 从哪来 |
|---|---|
| 链条有哪些步骤、下一步是谁 | `tasks.chain_next_id` |
| 这一步在跑 / 跑完了 / 挂了 / 等人点头 / 被拒 | 该任务**最近一次** `task_runs.status` |
| 谁在跑 | `tasks.mode`（simple / agent）+ `tasks.model_id` |
| 卡在哪 | 链条上第一个「没跑完」的步骤（`awaiting_approval` / `error` / `rejected`） |
| 能做点什么 | 现成的接口：`POST /api/tasks/{id}/run`、`POST /api/tasks/runs/{id}/approve|reject` |

`compute()` 是**纯函数**（拿两份行数据算），`board()` 只负责把行读出来 —— 所以「界面上的状态
是不是真的从库里算出来的」可以离线钉死，不用起服务。

**红线（照 `quality.py` / `turn_trace.py`）**：这是看板，不是考核。不设目标、不催、不排名、
没有「该跑了」这种话；宠物那一句播报也只说事实（谁在跑、谁在等）。
"""
from __future__ import annotations

import logging

log = logging.getLogger(__name__)

# 一步的状态。**这几个词就是要显示给用户看的词**（界面上不再翻译一遍）。
STATE_LABEL = {
    "running": "在跑",
    "awaiting": "等人点头",
    "ok": "跑完了",
    "error": "挂了",
    "rejected": "被拒了",
    "idle": "还没跑过",
    "blocked": "等上一步",
    "off": "停用了",
}
# 需要人做点什么的（看板把它们排在最前面）
NEEDS_ATTENTION = ("awaiting", "error", "rejected")


def _state_of(task: dict, run: dict | None) -> str:
    """一步的状态 —— 只从 task 与它最近一次 run 算。Pure。"""
    if not task.get("enabled", True):
        return "off"
    if not run:
        return "idle"
    status = str(run.get("status") or "")
    if status == "running":
        return "running"
    if status == "awaiting_approval":
        return "awaiting"
    if status == "error":
        return "error"
    if status == "rejected":
        return "rejected"
    return "ok" if status == "ok" else "idle"


def _actions(state: str, task: dict, run: dict | None) -> list[dict]:
    """这一步该给用户哪些按钮（**指向现成的接口**，这里不另造动作）。Pure。

    等人点头那一步给**两个**：放行与驳回 —— plan 原话是「真实的 run / approve / reject」，
    只给一个等于把另一半藏起来。
    """
    tid = task.get("id")
    if state == "awaiting" and run:
        return [
            {"kind": "approve", "run_id": run.get("id"), "task_id": tid, "label": "放行"},
            {"kind": "reject", "run_id": run.get("id"), "task_id": tid, "label": "驳回"},
        ]
    if state in ("error", "rejected", "idle") and tid:
        return [{"kind": "run", "task_id": tid, "label": "跑一次"}]
    if state == "ok" and tid:
        return [{"kind": "run", "task_id": tid, "label": "再跑一次"}]
    return []


def compute(tasks: list[dict], runs: list[dict]) -> dict:
    """两份行数据 → 看板。Pure（可离线钉死）。"""
    by_id = {int(t["id"]): dict(t) for t in tasks if t.get("id") is not None}
    # 每个任务最近一次 run（runs 按 started_at 升序给进来也没关系，这里自己挑最新的）
    latest: dict[int, dict] = {}
    for r in runs:
        tid = r.get("task_id")
        if tid is None:
            continue
        tid = int(tid)
        cur = latest.get(tid)
        if cur is None or int(r.get("id") or 0) >= int(cur.get("id") or 0):
            latest[tid] = dict(r)

    # 串链：把 chain_next_id 接起来。一个任务只会出现在一条链里。
    next_of = {tid: (int(t["chain_next_id"]) if t.get("chain_next_id") else None) for tid, t in by_id.items()}
    pointed_to = {v for v in next_of.values() if v}
    roots = [tid for tid in by_id if tid not in pointed_to and (next_of.get(tid) or True)]
    roots.sort()

    chains: list[dict] = []
    seen: set[int] = set()
    for root in roots:
        step_ids: list[int] = []
        cur: int | None = root
        while cur is not None and cur in by_id and cur not in seen:
            step_ids.append(cur)
            seen.add(cur)
            cur = next_of.get(cur)
        if not step_ids:
            continue
        steps: list[dict] = []
        blocked_by: int | None = None
        for i, tid in enumerate(step_ids):
            t = by_id[tid]
            run = latest.get(tid)
            state = _state_of(t, run)
            if blocked_by is not None and state in ("idle", "off", "ok"):
                # 上游没放行：这一步「等上一步」——但它自己的历史状态仍然如实带着
                steps.append(
                    {
                        "index": i + 1,
                        "task_id": tid,
                        "name": t.get("name") or f"任务 {tid}",
                        "state": "blocked",
                        "raw_state": state,
                        "state_label": STATE_LABEL["blocked"],
                        "blocked_by": blocked_by,
                        "who": _who(t),
                        "model_id": t.get("model_id") or "",
                        "mode": t.get("mode") or "simple",
                        "run_id": run.get("id") if run else None,
                        "started_at": (run or {}).get("started_at") or "",
                        "finished_at": (run or {}).get("finished_at") or "",
                        "error": ((run or {}).get("error") or "")[:200],
                        "grounded": (run or {}).get("grounded"),
                        "require_approval": bool(t.get("require_approval")),
                        "next_task_id": next_of.get(tid),
                        "actions": [],
                    }
                )
                continue
            step = {
                "index": i + 1,
                "task_id": tid,
                "name": t.get("name") or f"任务 {tid}",
                "state": state,
                "raw_state": state,
                "state_label": STATE_LABEL.get(state, state),
                "blocked_by": None,
                "who": _who(t),
                "model_id": t.get("model_id") or "",
                "mode": t.get("mode") or "simple",
                "run_id": run.get("id") if run else None,
                "started_at": (run or {}).get("started_at") or "",
                "finished_at": (run or {}).get("finished_at") or "",
                "error": ((run or {}).get("error") or "")[:200],
                "grounded": (run or {}).get("grounded"),
                "require_approval": bool(t.get("require_approval")),
                "next_task_id": next_of.get(tid),
                "actions": _actions(state, t, run),
            }
            steps.append(step)
            if state in NEEDS_ATTENTION:
                blocked_by = tid  # 下游都算「等上一步」

        stuck = next((s for s in steps if s["state"] in NEEDS_ATTENTION), None)
        chains.append(
            {
                "root_id": root,
                "name": (by_id[root].get("name") or f"任务 {root}"),
                "steps": steps,
                "length": len(steps),
                # 「卡在哪」：链条上第一个需要人动手的步骤（没有就 None —— 不编一句「一切正常」）
                "stuck_at": stuck,
                "needs_attention": bool(stuck),
                "enabled": any(by_id[t].get("enabled", True) for t in step_ids),
            }
        )

    chains.sort(key=lambda c: (not c["needs_attention"], c["root_id"]))
    return {
        "chains": chains,
        "counts": {
            "chains": len(chains),
            "steps": sum(c["length"] for c in chains),
            "needs_attention": sum(1 for c in chains if c["needs_attention"]),
            "running": sum(1 for c in chains for s in c["steps"] if s["state"] == "running"),
        },
        "states": STATE_LABEL,
    }


def _who(task: dict) -> str:
    """这一步「谁在跑」—— 只从任务自己声明的东西算（agent 模式 / 指定模型 / 默认模型）。"""
    mode = task.get("mode") or "simple"
    model = (task.get("model_id") or "").strip()
    if model:
        return f"{model}{'（agent）' if mode == 'agent' else ''}"
    return "默认模型（agent）" if mode == "agent" else "默认模型"


def broadcast(board: dict) -> str:
    """宠物的一句话播报。**只说事实**：谁在跑、谁在等 —— 不催、不排名、没有「该跑了」。

    没有需要人动手的东西时也不编一句「一切正常」，只说「没有在跑的东西」。
    """
    counts = board.get("counts") or {}
    waiting = [
        s
        for c in board.get("chains") or []
        for s in c["steps"]
        if s["state"] == "awaiting"
    ]
    running = [s for c in board.get("chains") or [] for s in c["steps"] if s["state"] == "running"]
    broken = [s for c in board.get("chains") or [] for s in c["steps"] if s["state"] in ("error", "rejected")]
    if waiting:
        who = "、".join(s["name"] for s in waiting[:3])
        return f"{len(waiting)} 步在等你点头：{who}。点「放行」就接着往下跑。"
    if running:
        who = "、".join(s["name"] for s in running[:3])
        return f"现在在跑：{who}。"
    if broken:
        who = "、".join(f"{s['name']}（{s['state_label']}）" for s in broken[:3])
        return f"有 {len(broken)} 步没跑成：{who}。要不要重跑一次？"
    if counts.get("steps"):
        return f"调度台上有 {counts['chains']} 条链、{counts['steps']} 步，现在没有在跑的东西。"
    return "调度台还是空的 —— 建一条任务链才会出现在这里。"


async def board(chains_limit: int = 20) -> dict:
    """读行 + 算看板。**只读**，不改任何东西。"""
    from sqlalchemy import select

    from app.db import SessionLocal
    from app.models import ScheduledTask, TaskRun, iso_utc

    async with SessionLocal() as db:
        tasks = [
            {
                "id": t.id,
                "name": t.name,
                "enabled": bool(t.enabled),
                "mode": t.mode or "simple",
                "model_id": t.model_id or "",
                "chain_next_id": t.chain_next_id,
                "require_approval": bool(getattr(t, "require_approval", False)),
            }
            for t in (await db.execute(select(ScheduledTask).order_by(ScheduledTask.id))).scalars().all()
        ]
        runs = [
            {
                "id": r.id,
                "task_id": r.task_id,
                "status": r.status,
                "started_at": iso_utc(r.started_at) or "",
                "finished_at": iso_utc(r.finished_at) or "",
                "error": r.error or "",
                "grounded": r.grounded,
            }
            for r in (
                await db.execute(select(TaskRun).order_by(TaskRun.id.desc()).limit(400))
            ).scalars().all()
        ]
    out = compute(tasks, runs)
    out["chains"] = out["chains"][: max(1, int(chains_limit or 20))]
    out["broadcast"] = broadcast(out)
    return out
