"""Scheduled task CRUD + manual run + natural-language schedule parsing."""
import json
import re

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, field_validator
from sqlalchemy import delete as sa_delete
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import tasks as core
from app.db import get_db
from app.models import ScheduledTask, TaskRun

router = APIRouter(prefix="/api/tasks", tags=["tasks"])


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
    trigger_kind: str = "cron"  # cron | watch
    watch_path: str = ""
    chain_next_id: int | None = None

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
        if v not in ("cron", "watch"):
            raise ValueError("trigger_kind 必须是 cron 或 watch")
        return v

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
        if v is not None and v not in ("cron", "watch"):
            raise ValueError("trigger_kind 必须是 cron 或 watch")
        return v

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
    return [{**_out(r), "running": r.id in running} for r in rows]


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
    if changes.get("chain_next_id") == task_id:
        raise HTTPException(400, "下游任务不能是自己（会形成循环）")
    if "chain_next_id" in changes and not await db.get(ScheduledTask, changes["chain_next_id"]):
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
