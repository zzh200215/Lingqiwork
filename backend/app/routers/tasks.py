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
from app.models import ScheduledTask, TaskRun, iso_utc

router = APIRouter(prefix="/api/tasks", tags=["tasks"])

# 这一步做什么：跑提示词 / 转写录音（会议闭环的第一步，录音留着） /
# 转写语音备忘（R2：只留文本、删掉录音） / 把一个成文引擎按表跑一遍（引擎名见 core.tasks）。
_VALID_ACTIONS = ("prompt", "transcribe", "transcribe_note") + core.ENGINE_ACTIONS


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
        # 这条流程处理的是哪件「事」（M2）。工作链起链时写进来，前端拿它给一个「去这件事」的入口。
        "thread_id": t.thread_id,
        "conversation_id": t.conversation_id,
        # `iso_utc` 不是装饰：这一列是 naive UTC，裸 `.isoformat()` 出来不带偏移，
        # 而前端 `fmtWhen` 是**解析**它的 —— 少了那个 `+00:00`，浏览器会按本地时区读，
        # 本时区下整整齐齐差八小时（`models.iso_utc` 的注释就是为这件事写的）。
        "last_run": iso_utc(t.last_run),
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
        # 两个时间戳都带 `+00:00` —— 见 `_out` 里 `last_run` 那条注释。
        # **这两个值必须是同一个时钟**：曾经 `started_at` 是 UTC（模型默认 `utcnow`）
        # 而 `finished_at` 是本地（`datetime.now().astimezone()`），于是每一次运行的
        # 耗时都多八小时（实测一次 50 秒的运行显示成「480 分 50 秒」）。
        "started_at": iso_utc(r.started_at),
        "finished_at": iso_utc(r.finished_at),
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
        # S2（PLAN3 §9.3 决策7）：这趟运行在处理哪件「事」——「读成技能」按它把三步合成一次输入
        "thread_id": r.thread_id,
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


@router.get("/recent-runs")
async def recent_runs(ids: str = "", db: AsyncSession = Depends(get_db)):
    """**一批任务各自的最近一次运行**——把前端那 8 次请求合成 1 次。

    「工作」页顶那块「最近几次运行」是逐条任务去问 `/api/tasks/{id}/runs` 的
    （`WorkPage.tsx` 的 `EnginePulse`，`t.slice(0, 8)`），**8 个并发请求换 8 条数据**，
    每次切回那一档还重新来一遍。这个接口就是那 8 次的批量版。

    **不能直接复用 `list_runs`**：那条是「每任务最近 20 条」，照字面复用等于还是
    每 id 一次查询，批量就白做了。这里按 `task_id IN (...)` **一次捞完再在 Python 侧
    取每组最新**——`core/tasks._RUNS_KEEP = 20` 保证每任务最多 20 行，所以这一次查询
    的上界是 `20 × len(ids)`，封顶 50 个 id 就是最多 1000 行，很小。

    返回**按 task_id 分组的一个对象**（JSON 的键是字符串）：`{"7": {...run...}}`。
    没有运行记录的任务**不出现**在结果里——调用方据此区分「没跑过」与「跑了但读不到」。
    """
    wanted = sorted({int(x) for x in ids.split(",") if x.strip().isdigit()})[:50]
    if not wanted:
        return {}
    rows = (
        await db.execute(
            select(TaskRun)
            .where(TaskRun.task_id.in_(wanted))
            .order_by(TaskRun.id.desc())
        )
    ).scalars().all()
    latest: dict[int, TaskRun] = {}
    for r in rows:
        # 按 id 倒序扫，**每条第一次遇到的**就是它最近的那一次
        latest.setdefault(r.task_id, r)
    return {str(k): _run_out(v) for k, v in latest.items()}


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


class RunIn(BaseModel):
    """手动起一次运行时的可选参数。`topic` 覆盖行里的 prompt——工作流第一步靠它
    接住你当场输入的题目，而不改掉 preset 模板。

    `thread`（M2）：这次运行是在处理哪件「事」。给了就按它的名字**复用或新建**一条，
    落到这条流程的行上——这一步的成品就挂到它上面，下游由链条一路继承（见 `_start_chain`）。
    """

    topic: str = ""
    thread: str = ""


async def _start_chain(db: AsyncSession, task_id: int, thread_name: str) -> dict:
    """给一条流程起链：先把它该处理的「这件事」落到**链头**的行上，再交给 `run_task`。

    为什么落链头而不是只回一个 id：链条下游是 `_fire_chain` 一路传下去、根本读不到 HTTP
    入参；而**手动重跑下游某一步**（卡点驳回之后想再跑一遍）也得知道这是哪件事——
    那一步的行上没有值，只能顺着 `chain_next_id` 回链头去问。

    行里只是「这条流程在忙哪件事」的界面提示；**一趟运行的真值记在 `task_runs.thread_id`**
    （`core.tasks._create_run`）。两处都要有：一个管跨刷新看得见，一个管过卡点不丢。
    """
    from app.core import threads

    row = await db.get(ScheduledTask, task_id)
    if row is None:
        raise HTTPException(404, "task not found")
    try:
        thread = await threads.resolve(thread_name)
    except ValueError as e:  # 空题目 / 全是空白 —— 400，而不是悄悄不挂
        raise HTTPException(400, str(e)) from e
    # 回链头（最多走 5 跳，与 `_CHAIN_MAX_DEPTH` 同量级）：头部是唯一一个起链时被写过的地方
    head, seen = row, {row.id}
    for _ in range(5):
        if head.thread_id or not head.chain_next_id:
            break
        nxt = (
            await db.execute(
                select(ScheduledTask).where(ScheduledTask.chain_next_id == head.id)
            )
        ).scalars().first()
        if nxt is None or nxt.id in seen:
            break
        seen.add(nxt.id)
        head = nxt
    if head.thread_id != thread["id"]:
        head.thread_id = thread["id"]
    row.thread_id = thread["id"]
    await db.commit()
    return thread


@router.post("/{task_id}/run")
async def run_now(
    task_id: int, body: RunIn | None = None, db: AsyncSession = Depends(get_db)
):
    row = await db.get(ScheduledTask, task_id)
    if not row:
        raise HTTPException(404, "task not found")
    # 起链时先落「这件事」，再跑：跑出来的成品才有地方挂（顺序不能反）。
    # **给了就一定要落成**：全是空白也交给 `resolve` 去拒（400），而不是自己 strip 一下
    # 当没给——那等于「你说了要挂，系统没挂还不告诉你」（实测就是这么漏过去的）。
    thread: dict | None = None
    if body and body.thread:
        thread = await _start_chain(db, task_id, body.thread)
    out = await core.run_task(
        task_id, manual=True, trigger="manual", topic=(body.topic if body else "")
    )
    out["thread"] = thread
    return out


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


# 工作流三步（docs/work-module.md v2）：题目 → 调研 → 方案 → 汇报稿。第一个名字即身份。
# 首步用引擎（research 自落 research/），后两步用 prompt 吃上游交接**并**落进自己的基地——
# `_run_engine` 不吃上游（只看 prompt 当话题），而 prompt 路径会把上游产出当系统消息注入，
# 所以「方案」读得到「调研」、「汇报稿」读得到「方案」。每步 require_approval：跑完停下等你点头。
#
# `landing_dir` 在这条链上不是可有可无的装饰：**三步的成品分别落 research/ decisions/ deliver/**，
# 那正是 M2 认的「产出目录」——挂到「一件事」上的是真成品，不是 `tasks/` 里的运行留痕。
# （尾步尤其明显：落 tasks/ 的话，你要的汇报稿得去翻一堆执行记录才找得到。）
_WORK_STEPS: tuple[tuple[str, str, str, str], ...] = (
    (
        "工作·调研",
        "research",
        "（题目在起链时给：运行期用 topic 参数覆盖，这条只是模板占位。）",
        "",
    ),
    (
        "工作·方案",
        "prompt",
        "下面是这次调研的产出。基于它写一份可执行的方案：目标 / 关键选择 / 步骤 / 风险。"
        "只用调研里给出的材料，没提到的不要编。",
        "decisions",
    ),
    (
        "工作·汇报稿",
        "prompt",
        "下面是这份方案。把它写成一页汇报稿：结论先行，3-5 段，说清做什么、为什么、下一步。"
        "口气平实，不要客套开头与落款。",
        "deliver",
    ),
)
_WORK_NAMES = {name for name, *_ in _WORK_STEPS}


@router.post("/preset/work")
async def install_work_preset(db: AsyncSession = Depends(get_db)):
    """一键装好工作流：三步链（调研 → 方案 → 汇报稿），每步一个人工卡点。**幂等**。

    装好后在「处理一项工作」里输入题目起链；每步跑完停下等你通过 / 驳回。
    """
    first = _WORK_STEPS[0][0]
    rows = (await db.execute(select(ScheduledTask).order_by(ScheduledTask.id))).scalars().all()
    if any(t.name == first for t in rows):
        return {"created": 0, "tasks": [_out(t) for t in rows if t.name in _WORK_NAMES]}

    made: list[ScheduledTask] = []
    for name, action, prompt, landing in _WORK_STEPS:
        step = ScheduledTask(
            name=name,
            prompt=prompt,
            cron="0 9 * * *",  # 占位：chain 不注册调度，纯手动点火
            action=action,
            landing_dir=landing,
            save_to_vault=True,  # 正文落它的基地（`landing_dir`）：decisions/ 与 deliver/
            tools_enabled=False,
            mode="simple",
            require_approval=True,  # 每步跑完停下等人点头
            trigger_kind="chain",  # 三步都是 chain：既不注册 cron 也不注册 watch
            watch_path="",
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


# 语音进料（R2 · PLAN5 §3）：**一步**，不是一条链——录音进去，文本出来，就完了。
#
# 与会议闭环的区别是这条 preset 的全部意义：会议要**留着原声**并往下走三步（纪要 / 待办 /
# 跟进稿），所以它用 `action="transcribe"`；语音备忘只留文本（`action="transcribe_note"`，
# 转写完删掉录音），没有下游、没有卡点、没有落点目录（落点由 `voice_note` 自己算）。
VOICE_DIR = "voice"
VOICE_INBOX = f"{VOICE_DIR}/inbox"
_VOICE_NAME = "语音备忘"


@router.post("/preset/voice")
async def install_voice_preset(db: AsyncSession = Depends(get_db)):
    """一键装好语音进料：`voice/inbox/` 目录 + 一个监听它的任务。**幂等**。

    装好之后，把录音（手机导出的 m4a、语音备忘录…）丢进 `vault/voice/inbox/`，
    它就会转成文本落到 `vault/voice/YYYY-MM-DD-HHMM.md`，**原录音随后被删掉**。
    """
    rows = (await db.execute(select(ScheduledTask).order_by(ScheduledTask.id))).scalars().all()
    if any(t.name == _VOICE_NAME for t in rows):
        return {"created": 0, "tasks": [_out(t) for t in rows if t.name == _VOICE_NAME]}

    (VAULT_DIR / VOICE_INBOX).mkdir(parents=True, exist_ok=True)

    task = ScheduledTask(
        name=_VOICE_NAME,
        prompt="把落进 voice/inbox/ 的录音转成文本。",  # 转写不看指令，这行只给人看
        cron="0 9 * * *",  # 占位：watch 任务不靠 cron 跑
        action="transcribe_note",
        landing_dir="",  # 落点由 `voice_note` 算（voice/YYYY-MM-DD-HHMM.md），不经 tasks/
        save_to_vault=False,  # 同上：这一路自己落盘，别再往 tasks/ 抄一份
        tools_enabled=False,
        mode="simple",
        trigger_kind="watch",
        watch_path=VOICE_INBOX,
    )
    db.add(task)
    await db.commit()
    await db.refresh(task)
    core.reschedule()
    return {"created": 1, "tasks": [_out(task)]}


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
