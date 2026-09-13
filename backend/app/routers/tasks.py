"""Scheduled task CRUD + manual run + natural-language schedule parsing."""
import json
import re

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, field_validator
from sqlalchemy import delete as sa_delete
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import VAULT_DIR
from app.core import tasks as core
from app.db import get_db
from app.models import ScheduledTask, TaskRun

router = APIRouter(prefix="/api/tasks", tags=["tasks"])

# 这一步做什么：跑提示词 / 转写录音 / 把一个成文引擎按表跑一遍（引擎名见 core.tasks）。
_VALID_ACTIONS = ("prompt", "transcribe") + core.ENGINE_ACTIONS


def _clean_whitelist(v: str) -> str:
    """Canonical form: comma-joined tokens, no stray spaces (empty = all)."""
    return ", ".join(t for t in re.split(r"[,\s]+", (v or "").strip()) if t)


class TaskIn(BaseModel):
    name: str
    prompt: str
    cron: str = "0 9 * * *"
    model_id: str = ""
    use_rag: bool = False
    tools_enabled: bool = True
    save_to_vault: bool = False
    enabled: bool = True
    # V2.3: agent orchestration
    mode: str = "simple"  # simple | agent
    tool_whitelist: str = ""
    max_rounds: int = 12
    retry: int = 1
    notify_on_error: bool = False
    trigger_kind: str = "cron"  # cron | watch | chain
    watch_path: str = ""
    chain_next_id: int | None = None
    require_approval: bool = False  # 人工卡点：跑完等人点头再触发下游
    action: str = "prompt"  # prompt | transcribe | 引擎名（research/compose/recap/decide/conflict）
    landing_dir: str = ""  # 产物落哪个 vault 子目录（空 = tasks/）

    @field_validator("name")
    @classmethod
    def name_not_blank(cls, v: str) -> str:
        v = (v or "").strip()
        if not v:
            raise ValueError("任务名不能为空")
        return v[:100]

    @field_validator("prompt")
    @classmethod
    def prompt_not_blank(cls, v: str) -> str:
        v = (v or "").strip()
        if not v:
            raise ValueError("任务指令不能为空")
        return v

    @field_validator("cron")
    @classmethod
    def cron_valid(cls, v: str) -> str:
        return core.validate_cron(v)

    @field_validator("mode")
    @classmethod
    def mode_valid(cls, v: str) -> str:
        if v not in ("simple", "agent"):
            raise ValueError("mode 必须是 simple 或 agent")
        return v

    @field_validator("trigger_kind")
    @classmethod
    def trigger_valid(cls, v: str) -> str:
        if v not in ("cron", "watch", "chain"):
            raise ValueError("trigger_kind 必须是 cron、watch 或 chain")
        return v

    @field_validator("action")
    @classmethod
    def action_valid(cls, v: str) -> str:
        if v not in _VALID_ACTIONS:
            raise ValueError(f"action 必须是 {'/'.join(_VALID_ACTIONS)} 之一")
        return v

    @field_validator("landing_dir")
    @classmethod
    def landing_clean(cls, v: str) -> str:
        return core.normalize_watch_path(v)

    @field_validator("watch_path")
    @classmethod
    def watch_path_clean(cls, v: str) -> str:
        return core.normalize_watch_path(v)

    @field_validator("tool_whitelist")
    @classmethod
    def whitelist_clean(cls, v: str) -> str:
        return _clean_whitelist(v)

    @field_validator("max_rounds")
    @classmethod
    def rounds_clamp(cls, v: int) -> int:
        return max(1, min(int(v or 12), core.MAX_AGENT_ROUNDS))

    @field_validator("retry")
    @classmethod
    def retry_clamp(cls, v: int) -> int:
        return max(0, min(int(v or 0), 3))


class TaskPatch(BaseModel):
    """Partial update — all fields optional."""

    name: str | None = None
    prompt: str | None = None
    cron: str | None = None
    model_id: str | None = None
    use_rag: bool | None = None
    tools_enabled: bool | None = None
    save_to_vault: bool | None = None
    enabled: bool | None = None
    mode: str | None = None
    tool_whitelist: str | None = None
    max_rounds: int | None = None
    retry: int | None = None
    notify_on_error: bool | None = None
    trigger_kind: str | None = None
    watch_path: str | None = None
    chain_next_id: int | None = None
    require_approval: bool | None = None
    action: str | None = None
    landing_dir: str | None = None

    @field_validator("cron")
    @classmethod
    def cron_valid(cls, v: str | None) -> str | None:
        return core.validate_cron(v) if v is not None else None

    @field_validator("mode")
    @classmethod
    def mode_valid(cls, v: str | None) -> str | None:
        if v is not None and v not in ("simple", "agent"):
            raise ValueError("mode 必须是 simple 或 agent")
        return v

    @field_validator("trigger_kind")
    @classmethod
    def trigger_valid(cls, v: str | None) -> str | None:
        if v is not None and v not in ("cron", "watch", "chain"):
            raise ValueError("trigger_kind 必须是 cron、watch 或 chain")
        return v

    @field_validator("action")
    @classmethod
    def action_valid(cls, v: str | None) -> str | None:
        if v is not None and v not in _VALID_ACTIONS:
            raise ValueError(f"action 必须是 {'/'.join(_VALID_ACTIONS)} 之一")
        return v

    @field_validator("landing_dir")
    @classmethod
    def landing_clean(cls, v: str | None) -> str | None:
        return core.normalize_watch_path(v) if v is not None else None

    @field_validator("watch_path")
    @classmethod
    def watch_path_clean(cls, v: str | None) -> str | None:
        return core.normalize_watch_path(v) if v is not None else None

    @field_validator("tool_whitelist")
    @classmethod
    def whitelist_clean(cls, v: str | None) -> str | None:
        return _clean_whitelist(v) if v is not None else None

    @field_validator("max_rounds")
    @classmethod
    def rounds_clamp(cls, v: int | None) -> int | None:
        return max(1, min(int(v or 12), core.MAX_AGENT_ROUNDS)) if v is not None else None

    @field_validator("retry")
    @classmethod
    def retry_clamp(cls, v: int | None) -> int | None:
        return max(0, min(int(v or 0), 3)) if v is not None else None


def _out(t: ScheduledTask) -> dict:
    return {
        "id": t.id,
        "name": t.name,
        "prompt": t.prompt,
        "cron": t.cron,
        "model_id": t.model_id,
        "use_rag": t.use_rag,
        "tools_enabled": t.tools_enabled,
        "save_to_vault": t.save_to_vault,
        "enabled": t.enabled,
        "mode": t.mode or "simple",
        "tool_whitelist": t.tool_whitelist or "",
        "max_rounds": t.max_rounds,
        "retry": t.retry,
        "notify_on_error": bool(t.notify_on_error),
        "trigger_kind": t.trigger_kind or "cron",
        "watch_path": t.watch_path or "",
        "chain_next_id": t.chain_next_id,
        "require_approval": bool(t.require_approval),
        "action": t.action or "prompt",
        "landing_dir": t.landing_dir or "",
        "conversation_id": t.conversation_id,
        "last_run": t.last_run.isoformat(timespec="seconds") if t.last_run else None,
        "last_status": t.last_status,
        "last_result": t.last_result,
        "next_run": core.next_run(t.id) if t.enabled else None,
    }


def _run_out(r: TaskRun) -> dict:
    try:
        log_entries = json.loads(r.log_json or "[]")
    except Exception:  # noqa: BLE001
        log_entries = []
    return {
        "id": r.id,
        "task_id": r.task_id,
        "trigger": r.trigger,
        "upstream_task_id": r.upstream_task_id,
        "started_at": r.started_at.isoformat(timespec="seconds") if r.started_at else None,
        "finished_at": r.finished_at.isoformat(timespec="seconds") if r.finished_at else None,
        "status": r.status,
        "mode": r.mode,
        "model_id": r.model_id,
        "rounds": r.rounds,
        "tool_calls": r.tool_calls,
        "error": r.error,
        "answer": r.answer,
        # 接地分 0-5（§4-10）：null = 没打分（没材料 / 判分没跑成）
        "grounded": r.grounded,
        "judge_reason": r.judge_reason or "",
        "run_dir": r.run_dir or "",
        "log": log_entries,
    }


@router.get("")
async def list_tasks(db: AsyncSession = Depends(get_db)):
    rows = (await db.execute(select(ScheduledTask).order_by(ScheduledTask.id))).scalars().all()
    running = set(
        (
            await db.execute(select(TaskRun.task_id).where(TaskRun.status == "running").distinct())
        ).scalars().all()
    )
    # 停在人工卡点上的那一步：下游还没被触发，界面上要能直接放行/驳回。
    # 升序取，后写覆盖先写——留下的就是**最新**那次待审的运行。
    awaiting: dict[int, int] = {}
    for r in (
        await db.execute(
            select(TaskRun).where(TaskRun.status == core._GATE_STATUS).order_by(TaskRun.id)
        )
    ).scalars().all():
        awaiting[r.task_id] = r.id
    return [
        {**_out(r), "running": r.id in running, "awaiting_run_id": awaiting.get(r.id)}
        for r in rows
    ]


@router.get("/tools")
async def list_tools():
    """All tools the model could use right now (built-ins + connected MCP)."""
    from app.core.mcp import mcp_manager
    from app.core.prefs import load_config

    specs = mcp_manager.tool_specs(include_memory=bool(load_config().get("memory_enabled", True)))
    return [
        {"name": s["function"]["name"], "description": s["function"]["description"]} for s in specs
    ]


@router.get("/{task_id}/runs")
async def list_runs(task_id: int, db: AsyncSession = Depends(get_db)):
    rows = (
        await db.execute(
            select(TaskRun)
            .where(TaskRun.task_id == task_id)
            .order_by(TaskRun.id.desc())
            .limit(20)
        )
    ).scalars().all()
    return [_run_out(r) for r in rows]


@router.post("")
async def create_task(body: TaskIn, db: AsyncSession = Depends(get_db)):
    if body.chain_next_id is not None:
        if not await db.get(ScheduledTask, body.chain_next_id):
            raise HTTPException(400, "下游任务不存在")
    row = ScheduledTask(**body.model_dump())
    db.add(row)
    await db.commit()
    await db.refresh(row)
    core.reschedule()
    return _out(row)


@router.put("/{task_id}")
async def update_task(task_id: int, body: TaskPatch, db: AsyncSession = Depends(get_db)):
    row = await db.get(ScheduledTask, task_id)
    if not row:
        raise HTTPException(404, "task not found")
    changes = body.model_dump(exclude_none=True)
    # chain_next_id 需要能置空（解除任务链）：exclude_none=True 会把显式传的 null 丢掉，
    # 这里单独补上，让「取消下游」能真正生效。
    if "chain_next_id" in body.model_fields_set and body.chain_next_id is None:
        changes["chain_next_id"] = None
    if changes.get("chain_next_id") == task_id:
        raise HTTPException(400, "下游任务不能是自己（会形成循环）")
    if changes.get("chain_next_id") is not None and not await db.get(ScheduledTask, changes["chain_next_id"]):
        raise HTTPException(400, "下游任务不存在")
    for k, v in changes.items():
        setattr(row, k, v)
    await db.commit()
    await db.refresh(row)
    core.reschedule()
    return _out(row)


@router.delete("/{task_id}")
async def delete_task(task_id: int, db: AsyncSession = Depends(get_db)):
    row = await db.get(ScheduledTask, task_id)
    if not row:
        raise HTTPException(404, "task not found")
    # drop the chain edge(s) pointing at it and its run history
    await db.execute(
        update(ScheduledTask)
        .where(ScheduledTask.chain_next_id == task_id)
        .values(chain_next_id=None)
    )
    await db.execute(sa_delete(TaskRun).where(TaskRun.task_id == task_id))
    await db.delete(row)
    await db.commit()
    core.reschedule()
    return {"ok": True}


@router.post("/{task_id}/run")
async def run_now(task_id: int, db: AsyncSession = Depends(get_db)):
    if not await db.get(ScheduledTask, task_id):
        raise HTTPException(404, "task not found")
    return await core.run_task(task_id, manual=True, trigger="manual")


async def _review(run_id: int, approve: bool) -> dict:
    try:
        return await core.review_gate(run_id, approve)
    except LookupError as e:
        raise HTTPException(404, str(e)) from e
    except ValueError as e:
        raise HTTPException(409, str(e)) from e


@router.post("/runs/{run_id}/approve")
async def approve_run(run_id: int):
    """人工卡点：放行——把这一步的产出交给下游任务。"""
    return await _review(run_id, approve=True)


@router.post("/runs/{run_id}/reject")
async def reject_run(run_id: int):
    """人工卡点：驳回——流程到此为止（这一步的产出留着，由你处置）。"""
    return await _review(run_id, approve=False)


# ---------- 预设工作流 ----------

MEETING_DIR = "meetings"

# 会议闭环的四步（§4-13）。第一个名字即身份——preset 靠它判断装没装过。
_MEETING_STEPS: tuple[tuple[str, str, str], ...] = (
    ("会议·转写", "transcribe", "把落进 meetings/inbox/ 的会议录音转成文字。"),
    (
        "会议·纪要",
        "prompt",
        "下面是这场会议的转写。写一份会议纪要，分「议题 / 结论 / 悬而未决」三节。"
        "只写转写里出现过的内容，没提到的不许编；听不清的地方写「（听不清）」。",
    ),
    (
        "会议·待办",
        "prompt",
        "下面是这场会议的纪要。逐条列出会后要做的事：做什么、谁来做、什么时候。"
        "纪要里没写负责人的就留空，别自己安一个；一条都没有就直说「这次会议没有明确的待办」。",
    ),
    (
        "会议·跟进短稿",
        "prompt",
        "下面是这场会议的纪要。写一段会后可以直接发出去的跟进短消息：3-5 句，"
        "说清结论与下一步。口气平实，不要客套开头，不要称呼与落款。",
    ),
)
_MEETING_NAMES = {name for name, _, _ in _MEETING_STEPS}


@router.post("/preset/meeting")
async def install_meeting_preset(db: AsyncSession = Depends(get_db)):
    """一键装好会议闭环：inbox 目录 + 四步链。**幂等**——装过就原样返回。

    没有它，"一段录音进去"要先手搓四个任务再串链，等于够不着。
    """
    first = _MEETING_STEPS[0][0]
    rows = (await db.execute(select(ScheduledTask).order_by(ScheduledTask.id))).scalars().all()
    if any(t.name == first for t in rows):
        return {"created": 0, "tasks": [_out(t) for t in rows if t.name in _MEETING_NAMES]}

    (VAULT_DIR / MEETING_DIR / "inbox").mkdir(parents=True, exist_ok=True)

    made: list[ScheduledTask] = []
    for i, (name, action, prompt) in enumerate(_MEETING_STEPS):
        step = ScheduledTask(
            name=name,
            prompt=prompt,
            cron="0 9 * * *",  # 下游链条不靠 cron 跑（trigger_kind=chain 根本不注册），值只占位
            action=action,
            landing_dir=MEETING_DIR,
            save_to_vault=True,
            tools_enabled=False,
            mode="simple",
            trigger_kind="watch" if i == 0 else "chain",
            watch_path=f"{MEETING_DIR}/inbox" if i == 0 else "",
        )
        db.add(step)
        made.append(step)
    await db.flush()  # 先拿到 id 才串得起链
    for cur, nxt in zip(made, made[1:]):
        cur.chain_next_id = nxt.id
    await db.commit()
    for step in made:
        await db.refresh(step)
    core.reschedule()
    return {"created": len(made), "tasks": [_out(s) for s in made]}


class ParseIn(BaseModel):
    text: str


@router.post("/parse")
async def parse(body: ParseIn):
    """'每天早上8点总结知识库' -> {cron, name, prompt} draft for the form."""
    text = (body.text or "").strip()
    if not text:
        raise HTTPException(400, "请描述你的定时需求")
    try:
        return await core.parse_schedule(text)
    except ValueError as e:
        raise HTTPException(400, f"解析失败：{e}") from e
    except Exception as e:  # noqa: BLE001 - provider/network errors
        raise HTTPException(500, f"解析失败：{type(e).__name__}: {e}") from e
