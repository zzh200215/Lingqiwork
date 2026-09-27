"""Scheduled prompt runs + autonomous agent tasks (ROADMAP V2.3).

A task = name + prompt + trigger. Two execution modes:
  simple — one prompt, one model answer (optionally with tools, ≤6 rounds)
  agent  — the model gets a goal and drives a tool loop (budget in rounds)
           until it can produce the final answer; every call is logged to
           `task_runs` for replay.

Triggers: cron (APScheduler), or vault file changes (`trigger_kind="watch"`).
A linear pipeline is expressed with `chain_next_id`: on success the upstream
answer is handed over via `vault/tasks/handoff/<from>-to-<to>.md` and the
downstream task runs with it injected as its main input.
"""
import asyncio
import fnmatch
import json
import logging
import re
import sqlite3
import time
from datetime import datetime
from pathlib import Path

from apscheduler.triggers.cron import CronTrigger
from pydantic import BaseModel, field_validator
from sqlalchemy import delete, select

from app.config import VAULT_DIR, settings
from app.core.llm import (
    MAX_TOOL_ROUNDS,
    ProviderInfo,
    run_agentic_chat,
    stream_chat,
    stream_chat_fallback,
)
from app.core.prefs import load_config
from app.db import SessionLocal
from app.models import Conversation, Message, ProviderConfig, ScheduledTask, TaskRun, utcnow

log = logging.getLogger(__name__)

JOB_PREFIX = "task_"
TASK_DIR = VAULT_DIR / "tasks"
HANDOFF_DIR = TASK_DIR / "handoff"
_RESULT_CAP = 20000
_HANDOFF_CAP = 15000
_CHAIN_MAX_DEPTH = 5
_RUNS_KEEP = 20  # run history rows kept per task

# 「一场一场落目录」的流程（M5）：它们的落点目录自带一件「事」的名字，见
# `thread_name_for_run_dir`。会议闭环是第一个——也是目前唯一一个。
MEETING_DIR = "meetings"
# 会议目录里**不是一场会议**的那一格：等着被处理的录音与材料（`routers/work.py` 列会议时
# 也跳过它、`threads.is_product` 也不把它当成品——三处说的是同一件事，所以有测试钉着
# 这三个词相等）。
MEETING_INBOX = "inbox"
_PER_INSTANCE_DIRS = (MEETING_DIR,)
_RETRY_DELAY_SECONDS = 30
_RETRY_DELAY_CAP_SECONDS = 300  # 退避封顶：5 分钟还不过就该人来看了，不是继续等
_STEP_TIMEOUT_SECONDS = 900  # 步级超时默认：15 分钟（转写长录音也够）


def _retry_delay(attempt: int) -> float:
    """指数退避：30s → 60s → 120s…封顶 5 分钟（Temporal 的 initial_interval + 倍率）。

    固定 30 秒的问题：服务端限流（429）时三趟全撞在同一个窗口里，一趟比一趟贵。
    """
    return min(float(_RETRY_DELAY_SECONDS) * (2 ** (attempt - 1)), float(_RETRY_DELAY_CAP_SECONDS))


# 可重试的「抖动」特征（2026-09-26）。**白名单制**：认得出是抖动才重试——
# 配置类错误（鉴权 401 / 参数 400 / 提示词本身的问题）重试一万次也是同一个错，
# 白烧三趟钱。参照 Temporal RetryPolicy 的 non_retryable_errors，只是反过来列。
_RETRYABLE_MARKERS = (
    "429",
    "502",
    "503",
    "504",
    "overloaded",
    "timeout",
    "timed out",
    "temporarily unavailable",
    "connection",
)


def _retryable(e: BaseException) -> bool:
    """这次失败值不值得再花一次钱。"""
    if isinstance(e, (TimeoutError, ConnectionError)):
        return True
    name = type(e).__name__
    if any(k in name for k in ("Timeout", "Connect", "Transport", "RateLimit", "Overloaded")):
        return True
    text = str(e)[:400].lower()
    return any(k in text for k in _RETRYABLE_MARKERS)
DEFAULT_AGENT_ROUNDS = 12
MAX_AGENT_ROUNDS = 30

# 「产出引擎」上调度（§15）：这一步不是跑提示词，而是把一个成文引擎按表跑一遍——把整条
# 产出线从「点它才跑」变成「到点自己跑」。值是引擎名，`_run_engine` 按名分发；落点交给
# 引擎自己的 `save()`，产出因此进 research/ notes/ decisions/ conflicts/ recap/，
# 出现在它该出现的页面上，而不是混进 tasks/。
ENGINE_ACTIONS = ("research", "compose", "recap", "decide", "conflict")
ENGINE_LABELS = {
    "research": "研究",
    "compose": "产出",
    "recap": "复盘",
    "decide": "方案",
    "conflict": "对质",
}

# set by core.triggers: called around every run of a watch-triggered task so
# its own vault writes don't immediately re-fire it
WATCH_HOOK: "callable[[int], None] | None" = None
_BG_TASKS: set[asyncio.Task] = set()  # keep refs so fire-and-forget chains aren't GC'd


def validate_cron(expr: str) -> str:
    """Normalize + validate a 5-field crontab string. Raises ValueError."""
    cleaned = " ".join((expr or "").split())
    if len(cleaned.split(" ")) != 5:
        raise ValueError("cron 需要 5 段：分 时 日 月 周")
    CronTrigger.from_crontab(cleaned)  # raises ValueError when malformed
    return cleaned


def normalize_watch_path(raw: str) -> str:
    """Clean a vault-relative watch path ('' = whole vault). Raises ValueError."""
    p = (raw or "").strip().replace("\\", "/").strip("/")
    if not p:
        return ""
    parts = [seg for seg in p.split("/") if seg not in ("", ".")]
    if any(seg == ".." for seg in parts) or (len(p) > 1 and p[1] == ":"):
        raise ValueError("监听路径必须是 vault 内的相对路径")
    return "/".join(parts)


def filter_tools(specs: list[dict], whitelist: str) -> list[dict]:
    """Keep only specs whose function name matches a whitelist pattern.

    Patterns are fnmatch-style ('vault_*', 'server__*'); empty or '*' = all.
    `none` = 不给任何工具。**语义在 `mcp.filter_specs` 一处**（A2 起 agent 侧的白名单
    也走那里，两处不许各写一份）。
    """
    from app.core.mcp import filter_specs

    return filter_specs(specs, whitelist)


# ---------- scheduling ----------


def reschedule() -> None:
    """Register every enabled cron-trigger task; watch-trigger ones are event driven.

    Reads through plain sqlite3: the scheduler API is sync and this runs at
    startup and after every task edit.
    """
    from app.core import scheduler as sched

    rows: list[tuple[int, str, str]] = []
    try:
        conn = sqlite3.connect(settings.db_path)
        try:
            rows = conn.execute(
                "SELECT id, cron, name FROM tasks "
                "WHERE enabled = 1 AND (trigger_kind = 'cron' OR trigger_kind IS NULL) "
                "ORDER BY id"
            ).fetchall()
        finally:
            conn.close()
    except sqlite3.Error:  # table may not exist yet on a fresh db
        log.debug("tasks table unavailable, nothing to schedule", exc_info=True)

    keep: set[str] = set()
    for task_id, cron, name in rows:
        job_id = f"{JOB_PREFIX}{task_id}"
        try:
            sched.set_cron(job_id, _run_job, validate_cron(cron), args=[task_id])
            keep.add(job_id)
        except ValueError:
            log.warning("task %s (%s) has invalid cron %r, skipped", task_id, name, cron)
    sched.prune_jobs(JOB_PREFIX, keep)


def next_run(task_id: int) -> str | None:
    from app.core import scheduler as sched

    return sched.next_run(f"{JOB_PREFIX}{task_id}")


async def _run_job(task_id: int) -> None:
    try:
        result = await run_task(task_id, trigger="cron")
        log.info("task %s finished: %s", task_id, result.get("status"))
    except Exception:  # noqa: BLE001 - a failed run must not kill the scheduler
        log.exception("task %s crashed", task_id)


# ---------- execution ----------


async def _resolve(model_id: str) -> tuple[ProviderConfig, str]:
    async with SessionLocal() as db:
        if model_id and "/" in model_id:
            pname, model = model_id.split("/", 1)
            p = (
                await db.execute(select(ProviderConfig).where(ProviderConfig.name == pname))
            ).scalar_one_or_none()
            if p and p.enabled:
                return p, model
        providers = (
            await db.execute(select(ProviderConfig).where(ProviderConfig.enabled.is_(True)))
        ).scalars().all()
    for p in providers:
        if p.models:
            return p, p.models[0]
    raise RuntimeError("没有已启用且配置了模型的 provider")


async def _candidates(model_id: str) -> list[tuple[ProviderInfo, str, str]]:
    """(info, model, label) 降级链（maple-os 参考项）：先解析到的主 provider，
    然后其余每个已启用 provider 各带上它的第一个模型。链的优先级就是启用列表
    的顺序——这是隐式配置，不新增设置项。"""
    primary, model = await _resolve(model_id)
    out = [
        (
            ProviderInfo(kind=primary.kind, base_url=primary.base_url, api_key=primary.api_key),
            model,
            f"{primary.name}/{model}",
        )
    ]
    async with SessionLocal() as db:
        others = (
            await db.execute(
                select(ProviderConfig)
                .where(ProviderConfig.enabled.is_(True), ProviderConfig.id != primary.id)
                .order_by(ProviderConfig.id)
            )
        ).scalars().all()
    for p in others:
        if p.models:
            out.append(
                (
                    ProviderInfo(kind=p.kind, base_url=p.base_url, api_key=p.api_key),
                    p.models[0],
                    f"{p.name}/{p.models[0]}",
                )
            )
    return out


def _safe_name(name: str) -> str:
    return re.sub(r'[\\/:*?"<>|\s]+', "-", name).strip("-") or "task"


def _handoff_path(upstream_name: str, downstream_name: str):
    return HANDOFF_DIR / f"{_safe_name(upstream_name)}-to-{_safe_name(downstream_name)}.md"


def _write_handoff(upstream_name: str, downstream_name: str, answer: str) -> str | None:
    """Park the upstream answer in the vault so the downstream run (and the
    user, in an editor) can read/adjust it before the next stage fires."""
    try:
        HANDOFF_DIR.mkdir(parents=True, exist_ok=True)
        p = _handoff_path(upstream_name, downstream_name)
        stamp = datetime.now().strftime("%Y-%m-%d %H:%M")
        p.write_text(
            f"# 上游产出：{upstream_name} → {downstream_name}\n\n> 任务链交接文件 · {stamp}\n\n{answer}\n",
            encoding="utf-8",
        )
        try:
            return p.relative_to(VAULT_DIR).as_posix()
        except ValueError:  # handoff dir relocated outside the vault (tests)
            return str(p)
    except OSError:
        log.warning("could not write chain handoff", exc_info=True)
        return None


def _read_handoff(upstream_name: str, downstream_name: str) -> str:
    p = _handoff_path(upstream_name, downstream_name)
    try:
        text = p.read_text(encoding="utf-8", errors="ignore").strip()
    except OSError:
        return ""
    if len(text) > _HANDOFF_CAP:
        text = text[:_HANDOFF_CAP] + "\n...[交接内容过长已截断]"
    return text


def _resolve_run_dir(t: dict, watch_files: list[str]) -> str:
    """这次运行的落点目录（vault 相对，空串 = 沿用 `vault/tasks/`）。Pure.

    配了 `landing_dir` 才有落点；由录音触发时再套一层「日期-录音名」，让每一场会议
    自成一个文件夹。链条的下游不走这里——`_fire_chain` 会把上游定下的目录传下去。
    """
    from app.core import ingest

    try:
        base = normalize_watch_path(t.get("landing_dir") or "")
    except ValueError:
        log.warning("bad landing_dir %r, falling back to vault/tasks/", t.get("landing_dir"))
        return ""
    if not base:
        return ""
    audio = next((p for p in watch_files if Path(p).suffix.lower() in ingest.AUDIO_EXT), "")
    if not audio:
        return base
    return f"{base}/{datetime.now():%Y-%m-%d}-{_safe_name(Path(audio).stem)[:40]}"


async def _has_running_run(task_id: int) -> bool:
    """这条任务此刻有没有一趟还在跑（并发守卫的判据）。"""
    from sqlalchemy import select

    from app.models import TaskRun

    async with SessionLocal() as db:
        row = (
            await db.execute(
                select(TaskRun.id)
                .where(TaskRun.task_id == task_id, TaskRun.status == "running")
                .limit(1)
            )
        ).first()
    return row is not None


async def run_task(
    task_id: int,
    manual: bool = False,
    trigger: str = "cron",
    upstream_task_id: int | None = None,
    chain_depth: int = 0,
    chain_path: frozenset[int] = frozenset(),
    watch_files: list[str] | None = None,
    run_dir: str = "",
    topic: str = "",
    thread_id: int | None = None,
) -> dict:
    """Execute one task now. Never raises: failures land in last_status/task_runs.

    `topic`（可选）：这一次运行用的题目，覆盖行里的 `prompt`。工作流第一步是「引擎 + 你当场
    输入的题目」——把题目写进行里会永久改掉 preset 模板、破坏幂等，所以走**运行期覆盖**，
    单次生效、用完即弃（和 `watch_files` / `run_dir` 同类）。

    `thread_id`（可选，M2）：这一跳在处理的哪件「事」。链条上**上游说了算**（通过 `_fire_chain`
    传下来，同 `run_dir`）；没传就用行里那个（工作流入口起链时写进去的）。两者都没有 =
    这次运行的成品不挂到任何事上。
    """
    async with SessionLocal() as db:
        task = await db.get(ScheduledTask, task_id)
        if not task:
            return {"status": "error", "error": "task not found"}
        # 并发守卫（2026-09-26）：同一条任务**已在跑**时，再来的触发不再起第二趟——
        # watch 连发 / cron 撞上手动 / 双击重跑，从前是并发两趟一起烧钱、各写一份产物
        # （GHA `concurrency: 1` 同一语义）。跳过要有声音：返回带 reason，日志留一行。
        if await _has_running_run(task_id):
            log.warning("task %s (%s) skipped: a run is already in flight", task_id, task.name)
            return {
                "status": "skipped",
                "reason": "already_running",
                "task_id": task_id,
                "name": task.name,
            }
        snapshot = {
            "task_id": task_id,
            "name": task.name,
            "prompt": task.prompt,
            "model_id": task.model_id,
            "use_rag": task.use_rag,
            "tools_enabled": task.tools_enabled,
            "save_to_vault": task.save_to_vault,
            "conversation_id": task.conversation_id,
            "mode": task.mode or "simple",
            "tool_whitelist": task.tool_whitelist or "",
            "max_rounds": task.max_rounds or DEFAULT_AGENT_ROUNDS,
            "retry": task.retry if task.retry is not None else 1,
            # 步级超时（秒）：空 = 默认 900。转写一小时录音的那条该自己配大一点。
            "timeout_seconds": int(task.timeout_seconds) if task.timeout_seconds else _STEP_TIMEOUT_SECONDS,
            # 接地分门禁（0-5）：空 = 不设（打分照旧，只是不挡道）。
            "gate_min_grounded": task.gate_min_grounded,
            "notify_on_error": bool(task.notify_on_error),
            "trigger_kind": task.trigger_kind or "cron",
            "chain_next_id": task.chain_next_id,
            "require_approval": bool(task.require_approval),
            "action": task.action or "prompt",
            "landing_dir": task.landing_dir or "",
            # 这条流程处理的是哪件「事」（M2）。起链时由工作流入口写进行里，下游靠它
            # 把产物挂到同一件事上；没人写就是 None（自动挂接整个不发生）。
            "thread_id": task.thread_id,
        }
        # 运行期题目覆盖（工作流第一步「你当场输入的题目」）。行里的 prompt 是模板，不动。
        if (topic or "").strip():
            snapshot["prompt"] = topic.strip()[:2000]
        if trigger == "chain" and upstream_task_id:
            up = await db.get(ScheduledTask, upstream_task_id)
            if up:
                snapshot["upstream_name"] = up.name
                snapshot["upstream_output"] = _read_handoff(up.name, task.name)

    # 一次运行 = 一个落点目录（§4-13）。链条上游定下的那个必须**继承**下来——
    # 四步因此写进同一个文件夹，那才是「同一场会议」。只有链条的第一跳才解析。
    snapshot["watch_files"] = [str(p) for p in (watch_files or [])]
    snapshot["run_dir"] = run_dir or _resolve_run_dir(snapshot, snapshot["watch_files"])
    # 链条上「这件事是哪件」也由上游说了算（同 run_dir 的道理）：行里那个只是起链时写的，
    # 上游传下来的才是这一趟的真值。
    if thread_id is not None:
        snapshot["thread_id"] = int(thread_id)
    # 「这一趟在处理哪件『事』」还有第二个名字来源（M5）：**一场一场落目录的流程自带名字**。
    # 会议闭环落 `meetings/<日期>-<录音名>/`，那个子目录就是这一场会议——于是会议结论也能
    # 进主线（挂到一条以会议名命名的「事」上），不必让你手打标签。只有链条的第一跳才需要
    # 解析：下游的 `thread_id` 由上游传下来（上面的分支已经赋值了）。
    if snapshot.get("thread_id") is None:
        snapshot["thread_id"] = await _thread_for_run_dir(snapshot["run_dir"])

    if snapshot["trigger_kind"] == "watch" and WATCH_HOOK:
        WATCH_HOOK(task_id)  # suppress self-trigger from our own writes
    run_id = await _create_run(
        task_id, trigger, upstream_task_id, snapshot["mode"], snapshot.get("thread_id")
    )

    started = datetime.now()
    attempts = 1 if manual else 1 + max(0, min(int(snapshot["retry"] or 0), 3))
    answer, sources, model_id = "", [], snapshot["model_id"]
    rounds = tool_calls = 0
    tokens_in = tokens_out = None
    log_entries: list[dict] = []
    status, error = "error", ""
    vault_file = None
    conv_id = snapshot["conversation_id"]
    finished = False  # 是否已把 run 落成终态；兜底靠它避免重复 finish
    gate = False  # 这一步是否停在人工卡点上（§4-12）

    try:
        for attempt in range(1, attempts + 1):
            log_entries = []
            try:
                # 步级超时（2026-09-26）：本地最常见的死法不是报错，是**不返回**——
                # 一个挂死的请求把整条链冻在夜里。超时才是重试的总闸，次数只是兜底。
                result = await asyncio.wait_for(
                    _execute(snapshot, log_entries), timeout=snapshot["timeout_seconds"]
                )
                answer, sources, model_id = result["answer"], result["sources"], result["model_id"]
                rounds, tool_calls = result["rounds"], result["tool_calls"]
                tokens_in = result.get("tokens_in")
                tokens_out = result.get("tokens_out")
                status, error = "ok", ""
                break
            except Exception as e:  # noqa: BLE001 - report, never propagate to scheduler
                log.exception("task %s attempt %d/%d failed", task_id, attempt, attempts)
                error = f"{type(e).__name__}: {e}"
                if isinstance(e, asyncio.TimeoutError):
                    error = f"TimeoutError: 单次执行超过 {snapshot['timeout_seconds']} 秒"
                # 只对「抖动」重试（超时 / 连不上 / 限流）；配置类错误再跑一趟
                # 也是同一个错——停，把钱省下来（Temporal non_retryable 同一口径）。
                if attempt < attempts and _retryable(e):
                    await asyncio.sleep(_retry_delay(attempt))

        if status == "ok":
            conv_id = await _persist(
                task_id, snapshot, answer, sources, model_id, trigger, upstream_task_id,
                tokens_in=tokens_in, tokens_out=tokens_out,
            )
            saved = result.get("saved") or {}
            if saved.get("filename"):  # 引擎自己落了盘（§15）——别再往 tasks/ 抄一份
                vault_file = saved["filename"]
            elif snapshot["save_to_vault"]:
                vault_file = _write_vault(
                    snapshot["name"], answer, started, snapshot.get("run_dir") or ""
                )
            # M2：这一步的成品挂到这条流程正在处理的那件「事」上。判据只有一条：
            # **这一步真的落了盘**。落点是不是「一份成品」由 `threads.attach_output`
            # 按目录判（`tasks/` 那种运行留痕不算）——两边各管一件事，不重复也不打架。
            # best-effort：挂接挂了不能把一次成功的运行变成失败。
            if vault_file:
                await _attach_to_thread(snapshot.get("thread_id"), vault_file)
            # 人工卡点（§4-12）：这一步跑完了，但**不**往下走——等人点头。
            # 这一步的产出照样落盘/进会话，因为它正是要给人看的东西。
            gate = bool(snapshot["require_approval"])
            # 接地分门禁（required checks，2026-09-26）：配了阈值就**先打分再决定放行**——
            # 低于阈值的产物停在卡点等人处置，不自动流向下游。没配门禁的照旧把打分
            # 排在最后（一次额外的模型调用，别拖住 `_fire_chain`）。
            gate_min = snapshot.get("gate_min_grounded")
            gate_score: float | None = None
            if gate_min is not None:
                gate_score = await _score_run(run_id, snapshot, sources, answer)
                if gate_score is None:
                    # 没打出分（没材料 / 判分挂了）：**不挡道**——门禁只挡「量出来不合格」
                    # 的，不编一个不合格出来。留一条日志让人知道这次门禁没生效。
                    log_entries.append({"step": "gate", "ok": True, "note": "未打分：门禁这次不生效"})
                else:
                    low = gate_score < float(gate_min)
                    log_entries.append(
                        {
                            "step": "gate",
                            "ok": not low,
                            "note": f"接地 {gate_score}/5，门禁 ≥{gate_min}"
                            + ("——停在卡点等人" if low else ""),
                        }
                    )
                    if low:
                        gate = True
            await _finish_run(
                run_id, _GATE_STATUS if gate else "ok", answer=answer, model_id=model_id,
                rounds=rounds, tool_calls=tool_calls, log_entries=log_entries,
                tokens_in=tokens_in, tokens_out=tokens_out,
                run_dir=snapshot.get("run_dir") or "",
            )
            finished = True
            if not gate:
                await _fire_chain(
                    task_id, snapshot, answer, chain_depth, manual, chain_path,
                    snapshot.get("run_dir") or "", snapshot.get("thread_id"),
                )
                if snapshot["trigger_kind"] == "watch" and WATCH_HOOK:
                    WATCH_HOOK(task_id)
            await _distill(snapshot, answer)
            if gate_min is None:
                # 打分管在最后：它是一次额外的模型调用，别让它拖住下游任务（`_fire_chain`）
                await _score_run(run_id, snapshot, sources, answer)
            if gate and not manual:
                if gate_min is not None:
                    # 门禁拦下的：把分数带进通知，人不用拆开两处才知道为什么停。
                    await _notify_gate(snapshot, gate_score=gate_score, gate_min=gate_min)
                else:
                    # 没配门禁的纯人工卡点：维持旧签名（既有替身/测试都按单参走）。
                    await _notify_gate(snapshot)
        else:
            await _finish_run(
                run_id, "error", error=error, model_id=model_id,
                rounds=rounds, tool_calls=tool_calls, log_entries=log_entries,
                tokens_in=tokens_in, tokens_out=tokens_out,
                run_dir=snapshot.get("run_dir") or "",
            )
            finished = True
            if not manual and snapshot["notify_on_error"]:
                await _notify_error(snapshot, trigger, error)

        if trigger != "manual" and load_config().get("desktop_notify", True):
            try:
                from app.core import notify

                if status == "error":
                    await asyncio.to_thread(notify.desktop, f"任务失败：{snapshot['name']}", error[:180])
                elif snapshot["mode"] == "agent":  # long unattended runs only
                    await asyncio.to_thread(notify.desktop, f"任务完成：{snapshot['name']}", (answer or "")[:180])
            except Exception:  # noqa: BLE001 - a broken toaster must not fail the task
                log.debug("desktop notification failed", exc_info=True)

        # 零柒: surface the run to the resident companion (best-effort, ROADMAP V14)
        try:
            from app.core import pet

            if status == "ok":
                # 落了成品的那一路，零柒那句话**由写盘的人说过了**（`_write_vault` /
                # 引擎的 `report.save`）——这里就别再补一句「跑完了」：一个事件一句话。
                # 判据与自动挂接、成长值共用 `pet.is_output_path`，路径说是成品，
                # 就一定有人开过口（`pet.note_output` 的 docstring 记着这条约定）。
                if not (vault_file and pet.is_output_path(vault_file)):
                    pet.emit("task_done", name=snapshot["name"], detail=(answer or "")[:120])
            else:
                pet.emit("task_failed", name=snapshot["name"], detail=error[:160])
        except Exception:  # noqa: BLE001
            log.debug("pet emit failed", exc_info=True)
    except Exception as e:  # noqa: BLE001 - 兜底：绝不让 run 停在 running
        log.exception("task %s crashed after execution", task_id)
        status, error = "error", f"{type(e).__name__}: {e}"
        if not finished:
            try:
                await _finish_run(
                    run_id, "error", error=error, model_id=model_id,
                    rounds=rounds, tool_calls=tool_calls, log_entries=log_entries,
                    tokens_in=tokens_in, tokens_out=tokens_out,
                    run_dir=snapshot.get("run_dir") or "",
                )
            except Exception:  # noqa: BLE001
                log.exception("finish_run fallback failed")

    # 更新 last_status（兜底，DB 失败也不向上抛，run_task 永不抛异常）
    try:
        async with SessionLocal() as db:
            task = await db.get(ScheduledTask, task_id)
            if task:
                # `last_run` 与 `task_runs.started_at` 说的是**同一个时刻**，所以必须是
                # 同一个时钟。原来是 `started.astimezone()`（`started` 本身是本地 naive），
                # 于是同一屏上任务行说「上次 13:58」、它自己的运行记录说「05:58」。
                # 而 `started` 仍旧留给 `_write_vault`——**落盘文件名里的日期该是本地**的
                # （「今天写的」按用户的今天算，不按 UTC 的今天）。
                task.last_run = utcnow()
                task.last_status = status
                task.last_result = (answer or error)[:_RESULT_CAP]
                if conv_id:
                    task.conversation_id = conv_id
                await db.commit()
    except Exception:  # noqa: BLE001
        log.exception("task last_status update failed")

    return {
        "status": status,
        "error": error,
        "answer": answer,
        "model_id": model_id,
        "conversation_id": conv_id,
        "vault_file": vault_file,
        "manual": manual,
        "sources": len(sources),
        "run_id": run_id,
        "rounds": rounds,
        "tool_calls": tool_calls,
        "tokens_in": tokens_in,
        "tokens_out": tokens_out,
        "log": log_entries,
        "awaiting_approval": gate,
        "thread_id": snapshot.get("thread_id"),
    }


async def _attach_to_thread(thread_id: int | None, filename: str) -> None:
    """把这一步的成品挂到这条流程正在处理的那件「事」上（M2）。

    没有这件事、落点不是成品、挂接本身出错 —— 一律**安静地不挂**。自动挂接是顺手做的
    事，不是这一步的产出：它挂了不该让一次成功的运行变成失败（与 `_distill` / `_score_run`
    同一条纪律）。「挂到哪了」由 `ThreadItem` 自己回答，不另记一份真值。
    """
    if not thread_id:
        return
    try:
        from app.core import threads

        await threads.attach_output(int(thread_id), filename)
    except Exception:  # noqa: BLE001 - 挂接失败不该影响任务结果
        log.warning("attach %s to thread %s failed", filename, thread_id, exc_info=True)


async def _distill(t: dict, answer: str) -> None:
    """任务成功后把可复用经验沉淀进 automemory（EvoForge 的 distill 迷你版）。

    和聊天页的抽取共用同一个开关（automemory_enabled，默认关）与同一个
    `auto_extract`，不加新设置。与 `_last_failure` 的失败教训互补：那是任务
    自己的短期记忆（下次执行注入），这里沉淀的是跨任务的长期记忆。放在
    _finish_run / _fire_chain 之后：产出已落库、链已点火，多出来的这步
    不该拖慢谁。best-effort：抽取挂了绝不影响任务结果。
    """
    if not load_config().get("automemory_enabled"):
        return
    try:
        from app.core import memory

        provider, model = await _resolve("")
        info = ProviderInfo(kind=provider.kind, base_url=provider.base_url, api_key=provider.api_key)
        user_text = f"定时任务「{t['name']}」刚执行完。任务指令：{t['prompt']}"
        facts = await asyncio.wait_for(
            memory.auto_extract(info, model, user_text, answer),
            timeout=60,
        )
        if facts:
            log.info("task %s distilled %d memory fact(s)", t["name"], len(facts))
    except Exception:  # noqa: BLE001 - distillation must never fail the task
        log.warning("task memory distillation failed", exc_info=True)


async def _fire_chain(
    task_id: int, snapshot: dict, answer: str, chain_depth: int, manual: bool,
    chain_path: frozenset[int] = frozenset(), run_dir: str = "", thread_id: int | None = None,
) -> int | None:
    """Hand the answer to the downstream task (vault file) and run it.

    Manual runs continue the chain in the background so the HTTP response
    returns after the first stage; scheduled runs wait for the whole pipeline.

    `thread_id` 与 `run_dir` 同路：从上游那一跳传下来（M2），下游的成品因此挂到**同一件**
    「事」上，而不是各自去读自己行里那个运行期字段。
    """
    nxt_id = snapshot.get("chain_next_id")
    if not nxt_id or chain_depth >= _CHAIN_MAX_DEPTH:
        return None
    if nxt_id in chain_path:
        log.warning("chain: cycle detected at task %s (path %s), stopping", nxt_id, sorted(chain_path))
        return None

    async def _go() -> None:
        try:
            async with SessionLocal() as db:
                nxt = await db.get(ScheduledTask, nxt_id)
                if not nxt or not nxt.enabled:
                    log.info("chain: downstream task %s missing/disabled, skipped", nxt_id)
                    return
                downstream_name = nxt.name
                # 链条默认继承上游落点（「同一场会议」四步写进同一个文件夹）。但下游
                # 自己指定了**另一个基地**时（工作流三步分别落 decisions/ 与 deliver/），
                # 它要自己的目录——否则非空的继承值会短路 `_resolve_run_dir`，汇报稿
                # 会跟着方案落进 decisions/。同基（含子目录）仍继承。
                try:
                    own = normalize_watch_path(nxt.landing_dir or "")
                except ValueError:
                    own = ""
                inherit = (
                    run_dir
                    if (not own or run_dir == own or run_dir.startswith(own + "/"))
                    else ""
                )
            _write_handoff(snapshot["name"], downstream_name, answer)
            await run_task(
                nxt_id, trigger="chain", upstream_task_id=task_id,
                chain_depth=chain_depth + 1, chain_path=chain_path | {task_id},
                run_dir=inherit, thread_id=thread_id,
            )
        except Exception:  # noqa: BLE001 - the pipeline must not crash the caller
            log.exception("chain handoff to task %s failed", nxt_id)

    if manual:
        t = asyncio.create_task(_go())
        _BG_TASKS.add(t)
        t.add_done_callback(_BG_TASKS.discard)
    else:
        await _go()
    return nxt_id


async def _create_run(
    task_id: int, trigger: str, upstream: int | None, mode: str, thread_id: int | None = None
) -> int:
    async with SessionLocal() as db:
        row = TaskRun(
            task_id=task_id, trigger=trigger, upstream_task_id=upstream, mode=mode,
            thread_id=thread_id,
        )
        db.add(row)
        await db.commit()
        await db.refresh(row)
        return row.id


async def _finish_run(
    run_id: int,
    status: str,
    *,
    answer: str = "",
    error: str = "",
    model_id: str = "",
    rounds: int = 0,
    tool_calls: int = 0,
    log_entries: list[dict] | None = None,
    tokens_in: int | None = None,
    tokens_out: int | None = None,
    run_dir: str = "",
) -> None:
    async with SessionLocal() as db:
        row = await db.get(TaskRun, run_id)
        if not row:
            return
        row.status = status
        # **UTC，与 `started_at` 同一个时钟**。这里原来是 `datetime.now().astimezone()`
        # （本地），而 `started_at` 是模型默认的 `utcnow()`——两个时钟混在一行里，
        # 于是 `finished_at - started_at` 永远多八小时（前端 `elapsed()` 就是那么算的，
        # 实测一次 50 秒的运行显示成「480 分 50 秒」）。
        row.finished_at = utcnow()
        row.answer = answer[:_RESULT_CAP]
        row.error = error[:2000]
        row.model_id = model_id
        row.rounds = rounds
        row.tool_calls = tool_calls
        row.log_json = json.dumps(log_entries or [], ensure_ascii=False)
        row.tokens_in = tokens_in
        row.tokens_out = tokens_out
        row.run_dir = run_dir
        sub = (
            select(TaskRun.id)
            .where(TaskRun.task_id == row.task_id)
            .order_by(TaskRun.id.desc())
            .offset(_RUNS_KEEP)
        )
        await db.execute(delete(TaskRun).where(TaskRun.task_id == row.task_id, TaskRun.id.in_(sub)))
        await db.commit()


async def _notify_error(t: dict, trigger: str, error: str) -> None:
    from app.core import mailer

    try:
        await asyncio.to_thread(
            mailer.send,
            f"任务失败：{t['name']}",
            f"任务「{t['name']}」（{trigger} 触发）在 {datetime.now():%Y-%m-%d %H:%M} 执行失败：\n\n{error[:1500]}",
        )
    except Exception:  # noqa: BLE001 - notification failure must not mask the real error
        log.warning("task failure notification mail could not be sent", exc_info=True)


async def _last_failure(task_id: int) -> str:
    """最近一次**已结束**的运行若是失败，返回原因，否则空串。教训住在
    task_runs 里，不占新列：成功一次它自然就消失，不需要清理逻辑。
    当前这次运行自己的 running 行要排除掉，否则每次都查到自己。"""
    async with SessionLocal() as db:
        row = (
            await db.execute(
                select(TaskRun)
                .where(TaskRun.task_id == task_id, TaskRun.status != "running")
                .order_by(TaskRun.id.desc())
                .limit(1)
            )
        ).scalar_one_or_none()
    if row is None or row.status != "error":
        return ""
    return (row.error or "").strip()


def run_topic(task_prompt: str, thread_name: str = "") -> str:
    """一趟运行的**题目**：有那件「事」就用它的名字（起链时按你输入的题目落地），否则用任务指令。Pure.

    S2 的「读成技能」与 S3 的试用记录都要这个题目，所以规则只留这一处——各写一遍迟早
    给出两个题目（链条第 2/3 步的 `prompt` 是模板，不是用户输入的题目）。
    """
    return (thread_name or "").strip() or (task_prompt or "").strip()


def thread_name_for_run_dir(run_dir: str) -> str:
    """这一趟运行的落点目录能不能自己给出一件「事」的名字。Pure.

    会议闭环落 `meetings/<日期>-<录音名>/`——那个子目录**就是这一场会议**，名字现成
    （`_resolve_run_dir` 用录音名 + 日期拼的），于是「会议结论进主线」不必让你手打标签。
    必须有且正好两层，而且第二段不能是 `inbox`（那是等着被处理的那一格，不是一场会议）；
    `meetings/a/b` 是更深的中间目录，也不是。

    别的流程没有这种「一场一场」的形状：普通任务落 `tasks/`（运行留痕）、引擎的成品直接进
    各自的产出目录——一律返回空串（没有名字来源就不硬安一个）。
    """
    parts = [p for p in (run_dir or "").split("/") if p]
    if len(parts) == 2 and parts[0] in _PER_INSTANCE_DIRS and parts[1] != MEETING_INBOX:
        return parts[1].strip()
    return ""


async def _thread_for_run_dir(run_dir: str) -> int | None:
    """落点目录自带名字时，把这一趟挂到那条「事」上（复用或新建）。

    顺手做的事：**出错就返回 None**，不让一次成功的运行变成失败（与 `_attach_to_thread`
    / `_distill` / `_score_run` 同一条纪律）。
    """
    name = thread_name_for_run_dir(run_dir)
    if not name:
        return None
    try:
        from app.core import threads

        return int((await threads.resolve(name))["id"])
    except Exception:  # noqa: BLE001 - 挂不上就是没挂上，运行照旧
        log.warning("could not resolve a thread for %s", run_dir, exc_info=True)
        return None


def _judge_sources(hits: list[dict]) -> list[dict]:
    """检索命中 → 判分器能吃的材料形状（`report.format_sources` 要 `n` 与 `kind`）。Pure.

    检索给的是 `{source, text, score}`，判分器要的是编号材料——这里补上编号，
    空正文的命中丢掉（它本来也判不了）。
    """
    out: list[dict] = []
    for h in hits or []:
        text = str(h.get("text") or "").strip()
        if not text:
            continue
        src = str(h.get("source") or "").strip()
        out.append(
            {
                "n": len(out) + 1,
                "kind": "kb",
                "title": str(h.get("title") or src),
                "ref": src,
                "text": text,
            }
        )
    return out


async def _score_run(
    run_id: int, t: dict, sources: list[dict], answer: str
) -> float | None:
    """跑完给这次产出打一个**接地分**（0-5）并落在 run 上——工作流的网。
    **返回分**（2026-09-26，门禁要用这个数）：没材料 / 判分挂了返回 `None`——
    「没分」和「0 分」是两件事，门禁只挡「量出来不合格」，不编一个不合格出来。

    为什么是它（§4-10）：工作流在你不看的时候跑，「跑成功但悄悄变差」不进 `last_status`。
    分数掉下来是唯一看得见的信号。判据复用 `engine_eval` 的 LLM 判分，与五个成文引擎同一套。

    **没材料就不打分**（没开检索 / 检索没命中）：没有尺子可量，别编一个分出来。
    整体 best-effort——判分挂了不能让一次成功的运行变成失败。
    """
    pairs = _judge_sources(sources)
    if not pairs or not (answer or "").strip():
        return None
    try:
        candidates = await _candidates(t.get("model_id") or "")
    except Exception:  # noqa: BLE001 - 解析不到 provider，就只是这次没有分
        log.debug("task grounding judge skipped: no provider", exc_info=True)
        return None
    if not candidates:
        return None
    info, model, _label = candidates[0]

    from app.core import engine_eval

    try:
        grounded, reason = await engine_eval.judge_grounded(
            info, model, "task", t.get("prompt") or t.get("name") or "", pairs, answer
        )
    except Exception:  # noqa: BLE001
        log.warning("task grounding judge failed", exc_info=True)
        return None

    try:
        async with SessionLocal() as db:
            row = await db.get(TaskRun, run_id)
            if row is not None:
                row.grounded = grounded
                row.judge_reason = (reason or "")[:200]
                await db.commit()
    except Exception:  # noqa: BLE001
        log.warning("task grounding score write failed", exc_info=True)
    return float(grounded)


_GATE_STATUS = "awaiting_approval"  # 人工卡点：跑完了，等人点头


async def _notify_gate(
    t: dict, gate_score: float | None = None, gate_min: float | None = None
) -> None:
    """卡点等人要响一声。不响它可能永远停在那儿——这正是 §6-1 说的静默。

    门禁拦下的（分数不够）把**为什么**放进同一句话里——人不该拆开两处才知道
    这次为什么要自己来看。"""
    why = (
        f"接地 {gate_score}/5 低于门禁 {gate_min}。"
        if gate_score is not None and gate_min is not None
        else ""
    )
    body = f"「{t['name']}」跑完了，等你点头才交给下游——在 /work 上放行或驳回。"
    if why:
        body = f"{why}{body}"
    if load_config().get("desktop_notify", True):
        try:
            from app.core import notify

            await asyncio.to_thread(notify.desktop, f"等你点头：{t['name']}", body)
        except Exception:  # noqa: BLE001 - 通知挂了不该影响流程
            log.debug("gate desktop notification failed", exc_info=True)
    if t.get("notify_on_error"):  # 同一个「要我留意」的开关，复用它
        from app.core import mailer

        try:
            await asyncio.to_thread(mailer.send, f"任务等待确认：{t['name']}", body)
        except Exception:  # noqa: BLE001
            log.warning("gate notification mail could not be sent", exc_info=True)


async def review_gate(run_id: int, approve: bool) -> dict:
    """人工卡点（§4-12）：通过 → 把这一步的产出交给下游；驳回 → 流程到此为止。

    只有停在 `awaiting_approval` 的那一步可以被审——重复点、点错行都不该改变什么
    （抛 `ValueError`，路由转 409）。驳回**不删**这一步的产出：它是给人看的东西，
    要不要留由人决定。
    """
    async with SessionLocal() as db:
        run = await db.get(TaskRun, run_id)
        if run is None:
            raise LookupError("run not found")
        if run.status != _GATE_STATUS:
            raise ValueError(f"这次运行不在等确认（当前 {run.status}）")
        task = await db.get(ScheduledTask, run.task_id)
        snapshot = {
            "task_id": run.task_id,
            "name": (task.name if task else "") or "",
            "chain_next_id": task.chain_next_id if task else None,
            "trigger_kind": (task.trigger_kind or "cron") if task else "cron",
        }
        answer = run.answer or ""
        run_dir = run.run_dir or ""
        run.status = "ok" if approve else "rejected"
        await db.commit()

    nxt = None
    # Z2（PLAN4）：**等你有声，抵达无声**——停着等你点头的那一步有人点了头 / 驳回之后，
    # 之前一个字都没有（`KINDS` 里连一个 gate kind 都没有）。两句都在这里说，就在状态
    # 写下去的那一刻：驳回没有下游；通过的下游 `_fire_chain` 可能要跑几分钟，等它回来
    # 再开口就不是「那一刻」了。
    # **不弹桌面通知**：它不在 `emit` 的 toast 名单里——这是**事件**（你刚亲手点的），
    # 不是提醒；你人就在那个页面上，不该再被系统吼一声。
    try:
        from app.core import pet

        pet.emit("gate_ok" if approve else "gate_rejected", name=snapshot["name"])
    except Exception:  # noqa: BLE001 - 台词永远不该挡住流程（emit 自己也不抛，这层防导入）
        log.debug("pet gate emit failed", exc_info=True)

    if approve:
        # 后台续跑：一个完整的下游流水线可能跑几分钟，HTTP 响应不该等它
        nxt = await _fire_chain(
            snapshot["task_id"],
            snapshot,
            answer,
            0,
            manual=True,
            chain_path=frozenset({snapshot["task_id"]}),
            run_dir=run_dir,  # 停在卡点上的一轮不能把落点目录弄丢
            # 「这件事」以**这一轮运行**记的为准（M2）：任务行那个是「最近一次在忙哪件」，
            # 而续跑要接的是**当初那一轮**在处理的那件。老行没有值时退回任务行。
            thread_id=(run.thread_id if run.thread_id is not None else (task.thread_id if task else None)),
        )
    return {"ok": True, "approved": approve, "run_id": run_id, "next_task_id": nxt}


def _land_audio(src: Path, run_dir: str) -> str:
    """把录音搬进这次运行的落点目录。**只在转写成功之后调**——失败就留在 inbox 等人处置。"""
    if not run_dir:
        return ""
    import shutil

    try:
        dest_dir = VAULT_DIR / run_dir
        dest_dir.mkdir(parents=True, exist_ok=True)
        dest = dest_dir / f"audio{src.suffix.lower()}"
        shutil.move(str(src), str(dest))
        return dest.relative_to(VAULT_DIR).as_posix()
    except (OSError, ValueError):
        log.warning("could not land recording into %s", run_dir, exc_info=True)
        return ""


async def _transcribe(t: dict) -> dict:
    """转写步骤（§4-13）：把触发它的那段录音交给本地 ASR——**不走模型**，这不是一次生成。"""
    from app.core import asr, ingest

    files = [
        p for p in (t.get("watch_files") or []) if Path(p).suffix.lower() in ingest.AUDIO_EXT
    ]
    if not files:
        raise RuntimeError("没有可转写的音频——这一步要靠「录音落目录」触发")
    rel = files[0]
    src = VAULT_DIR / rel
    if not src.is_file():
        raise RuntimeError(f"音频不在了：{rel}")

    model_size, language = asr.prefs()
    result = await asyncio.to_thread(asr.transcribe, str(src), model_size, language)
    text = str((result or {}).get("text") or "").strip()
    if not text:
        raise RuntimeError("转写结果是空的")

    landed = _land_audio(src, t.get("run_dir") or "")
    return {
        "answer": f"转写（{rel} → {landed}）\n\n{text}" if landed else f"转写（{rel}）\n\n{text}",
        "sources": [],
        "model_id": "asr",
        "rounds": 0,
        "tool_calls": 0,
    }


async def _transcribe_note(t: dict) -> dict:
    """语音进料（R2 · PLAN5 §3）：一段录音 → `vault/voice/` 里一份 md，**然后删掉录音**。

    **与 `_transcribe` 是两条路，故意不合并**：那一条是会议闭环的第一步，它把录音
    `_land_audio` 进这次运行的落点目录、留着给后面几步当原料（`test_agent_orchestration`
    钉着这个行为：录音被搬进 `meetings/*-周会/`）。这一条只留文本、删掉音频，
    是「随手一段录音」的处置方式。**共用一个 action 会让两种语义互相污染**，
    所以宁可多一个名字，也不在 `_transcribe` 里加开关。

    **删录音只在转写成功之后**：失败照旧把文件留在原地（`RuntimeError` 抛出去，
    watcher 那侧记一次失败），人还能再试一次——**先删后转就等于把原料烧了**。
    """
    from app.core import asr, ingest, voice_note

    files = [
        p for p in (t.get("watch_files") or []) if Path(p).suffix.lower() in ingest.AUDIO_EXT
    ]
    if not files:
        raise RuntimeError("没有可转写的音频——这一步要靠「录音落目录」触发")
    rel = files[0]
    src = VAULT_DIR / rel
    if not src.is_file():
        raise RuntimeError(f"音频不在了：{rel}")

    model_size, language = asr.prefs()
    result = await asyncio.to_thread(asr.transcribe, str(src), model_size, language)
    text = str((result or {}).get("text") or "").strip()
    if not text:
        # 空转写不算成功：不写空文件（那会变成一份搜得到、点开什么都没有的产出），
        # 也不删录音
        raise RuntimeError("转写结果是空的")

    note = voice_note.write_note(text, source=rel)

    # 到这一步转写已经落盘了，删除失败**不能**让这一步报失败——否则人会以为没转成功
    # 而去重试，结果是把同一段录音转第二遍、留下第二份一模一样的 md。
    gone = True
    try:
        src.unlink()
    except OSError:
        gone = False
        log.warning("transcribed note but could not delete the recording: %s", rel, exc_info=True)

    tail = "原录音已删除" if gone else "（原录音还在，没能删掉）"
    return {
        "answer": f"# {note['title']}\n\n{text}\n\n---\n\n已落到 vault/{note['path']}（{tail}）",
        "sources": [],
        "model_id": "asr",
        "rounds": 0,
        "tool_calls": 0,
        "saved": {"filename": note["path"], "title": note["title"]},
    }


class _Steps:
    """一次运行的**步骤账**——写进 `task_runs.log_json`，与工具调用同一个数组。

    **为什么是同一个数组**（方案 §8.3 的步骤条）：那一条的全部价值在**顺序**，而两个数组
    没法交错——工具那几项没有时间戳，插不回去。同一个数组里两种形状靠键区分
    （`tool` / `step`），读的人各取各的：`skill_trials` 与 `skill_metrics` 按 `tool` 过滤，
    看不见这些。

    **为什么要有这个类**：每一步都要记「花了多久」，而 `time.monotonic()` 的成对调用散在
    各处最容易漏——漏一处那一步就没有耗时，界面上看起来像 0 秒（那是**一句假话**，
    比不显示更糟）。`begin` / `end` 把成对这件事收成一个对象，漏不掉。
    """

    def __init__(self, entries: list[dict] | None = None):
        self.entries = entries if entries is not None else []
        self._name = ""
        self._t0 = 0.0

    def begin(self, name: str) -> None:
        """开一步。上一步还开着就**先结掉**——顺序错乱比少一步难查得多。"""
        self.end()
        self._name, self._t0 = name, time.monotonic()

    def end(self, *, ok: bool = True, **extra) -> None:
        """结掉当前这一步。没有开着的就什么都不做（收尾那一下因此可以随手写）。"""
        if not self._name:
            return
        self.entries.append(
            {
                "step": self._name,
                "ok": bool(ok),
                "ms": max(0, int((time.monotonic() - self._t0) * 1000)),
                **extra,
            }
        )
        self._name = ""


async def _run_engine(t: dict, engine: str, log_entries: list[dict] | None = None) -> dict:
    """把一个成文引擎无人值守地跑一遍（§15）。

    引擎本来就是 async 生成器（`compose.run` 等），路由只是 SSE 包装 + 让人先看再存。
    这里就是那条链去掉人：跑到 `report`（其它四个引擎）或 `saved`（recap 自成文即落盘）
    就落盘。**落点交给引擎自己的 `save()`**，产出因此出现在它该出现的页面上。

    话题取自任务指令（`prompt`）——引擎要的是一个话题，不是一段给模型的指令；
    recap 例外，它不看话题，把「最近几天」合成一份。

    `log_entries`（S1）：引擎那条 `skills` 事件（本次注入了哪份工序）记进运行日志——
    S3 的试用期靠聚合它，而且它是**现有日志结构里的一项，不是新列**。
    """
    import importlib

    from app.core import providers
    from app.core import report as _report
    from app.core import skill_match

    mod = importlib.import_module(f"app.core.{engine}")
    topic = (t.get("prompt") or "").strip()
    if engine != "recap" and not topic:
        raise RuntimeError(f"{ENGINE_LABELS[engine]}需要一个话题——把话题填进任务指令")

    gen = mod.run() if engine == "recap" else mod.run(topic)
    title = markdown = error = ""
    sources: list[dict] = []
    saved: dict | None = None
    # 步骤条（§8.3）：无人值守的那几步就是引擎自己的相位。**「取材」在这里就开**——
    # 引擎从被调起来的那一刻就在取材，`gathering` 那帧只是它自己确认一下。
    # 不再对那一帧开第二步：那样会得到两个「取材」（一个 ms≈0，一个有材料数），
    # 而步骤条上重复的一步看起来像引擎跑了两遍。
    steps = _Steps(log_entries)
    steps.begin("取材")
    async for ev, data in gen:
        if ev == "error":
            steps.end(ok=False, note=str((data or {}).get("message") or "引擎没跑成")[:200])
            error = (data or {}).get("message") or "引擎没跑成"
            break
        if ev == "skills":
            # 本次运行吃了哪份工序。注入了就算数——哪怕这一步随后失败（它确实被用过了）。
            if log_entries is not None and (data or {}).get("skills"):
                log_entries.append(skill_match.log_entry(data))
        if ev == "sources":
            n = len((data or {}).get("sources") or [])
            # 一条都没找到也是一步——而且是**该被看见**的一步（`ok=False`）。
            # 我省略它的话，那趟失败看上去会像「没跑过」。
            steps.end(ok=n > 0, note=f"{n} 条材料" if n else "没找到材料")
            steps.begin("成文")
        elif ev == "report":
            steps.end(note=f"{len(data.get('sections') or [])} 节")
            steps.begin("落盘")
            sources = data.get("sources") or []
            rep = _report.Report(
                title=(data.get("title") or "").strip(),
                sections=[
                    _report.Section(heading=s.get("heading", ""), body=s.get("body", ""))
                    for s in data.get("sections") or []
                ],
                used=list(data.get("used") or []),
            )
            title = rep.title
            markdown = _report.to_markdown(rep, sources, ENGINE_LABELS[engine])
            saved = await mod.save(rep, sources)  # 路由里那一步「预览后再存」，这里直接存
            steps.end(ref=str((saved or {}).get("filename") or ""))
        elif ev == "saved":  # recap 自己落盘，没有 review 环节
            saved = data
            title = data.get("title") or title
            steps.end(ref=str((data or {}).get("filename") or ""))
    # 收尾：还开着的那一步按**这趟成没成**结掉。**不能提前结**——提前结会把
    # 「引擎一个字都没吐」记成一步成功的「取材」，而那正是最该被看见的那种失败。
    if error:
        steps.end(ok=False, note=str(error)[:200])
        raise RuntimeError(error)
    if not saved:
        steps.end(ok=False, note="引擎没有产出可落盘的结果")
        raise RuntimeError("引擎没有产出可落盘的结果")
    steps.end()

    where = saved.get("filename", "")
    answer = f"# {title or ENGINE_LABELS[engine]}\n\n{markdown}\n\n---\n\n已落到 vault/{where}"
    return {
        "answer": answer.strip(),
        "sources": sources,
        "model_id": providers.default_model_id() or f"engine:{engine}",
        "rounds": 0,
        "tool_calls": 0,
        "tokens_in": None,
        "tokens_out": None,
        "saved": saved,  # run_task 拿它当 vault_file，别再往 tasks/ 抄一份
    }


async def _execute(t: dict, log_entries: list[dict]) -> dict:
    action = t.get("action") or "prompt"
    if action == "transcribe":
        return await _transcribe(t)
    if action == "transcribe_note":
        return await _transcribe_note(t)
    if action in ENGINE_ACTIONS:
        return await _run_engine(t, action, log_entries)
    candidates = await _candidates(t["model_id"])
    model_id = candidates[0][2]
    served: dict = {}  # 实际产出内容的 provider——降级发生时它可能不是第一家
    prefs = load_config()

    messages: list[dict] = []
    system = (prefs.get("system_prompt") or "").strip()
    if system:
        messages.append({"role": "system", "content": system})
    task_note = (
        f"你正在执行用户的定时任务「{t['name']}」，当前时间 {datetime.now():%Y-%m-%d %H:%M}。"
        "请直接输出任务结果（markdown），不要寒暄、不要复述任务本身。"
    )
    if t.get("mode") == "agent":
        task_note += (
            "这是无人值守的自主执行环境：你可以连续多轮调用工具来收集信息、执行操作，"
            "每轮工具结果会返回给你，直到能给出完整结果为止。不要请求用户确认；"
            "个别工具失败就换方法或跳过。全部完成后，你的最终文本回复就是任务产出，会被自动存档。"
        )
    messages.append({"role": "system", "content": task_note})
    if t.get("upstream_output"):
        messages.append(
            {
                "role": "system",
                "content": (
                    f"本任务由上游任务「{t['upstream_name']}」通过任务链触发。"
                    f"上游产出如下，请以它为主要输入完成任务：\n\n---\n{t['upstream_output']}\n---"
                ),
            }
        )

    sources: list[dict] = []
    if t["use_rag"]:
        from app.core import indexer
        from app.routers.chat import _build_rag_context

        try:
            sources = await asyncio.to_thread(
                indexer.search_auto, t["prompt"], int(prefs.get("rag_top_k", 5))
            )
        except Exception:  # noqa: BLE001 - RAG failure must not fail the task
            log.warning("task RAG retrieval failed", exc_info=True)
            sources = []
        if sources:
            messages.append({"role": "system", "content": _build_rag_context(sources)})

    lesson = await _last_failure(t.get("task_id") or 0)
    if lesson:
        messages.append(
            {
                "role": "system",
                "content": (
                    f"注意：这个任务最近一次运行失败了：{lesson[:500]}。"
                    "如果这次失败和要做的事有关，请换方法修正或规避；"
                    "如果只是临时故障（网络、限流），按原计划执行。"
                ),
            }
        )

    messages.append({"role": "user", "content": t["prompt"]})

    agent = t.get("mode") == "agent"
    use_tools = agent or t.get("tools_enabled")
    stats = {"rounds": 0, "tool_calls": 0}
    usage: dict = {}

    async def _plain() -> str:
        chunks = [
            c
            async for c in stream_chat_fallback(candidates, messages, usage=usage, served=served)
        ]
        return "".join(chunks).strip()

    if not use_tools:
        answer = await _plain()
        if not answer:
            raise RuntimeError("模型返回空内容")
        return {"answer": answer, "sources": sources, "model_id": served.get("label") or model_id, **stats, "tokens_in": usage.get("input"), "tokens_out": usage.get("output")}

    from app.core.mcp import mcp_manager

    specs = mcp_manager.tool_specs(include_memory=bool(prefs.get("memory_enabled", True)))
    specs = filter_tools(specs, t.get("tool_whitelist") or "")
    if not specs:  # nothing whitelisted / no MCP servers → plain run
        answer = await _plain()
        if not answer:
            raise RuntimeError("模型返回空内容")
        return {"answer": answer, "sources": sources, "model_id": served.get("label") or model_id, **stats, "tokens_in": usage.get("input"), "tokens_out": usage.get("output")}

    async def _run_tool(name: str, args: dict) -> str:
        t0 = time.monotonic()
        result = await mcp_manager.call_tool(name, args)
        stats["tool_calls"] += 1
        text = str(result)
        log_entries.append(
            {
                "tool": name,
                "args": args,
                "ok": not text.startswith("[tool error]"),
                "result": text[:600],
                # 步骤条要「每步耗时」（§8.3）。这一次调用花的时间就在这里量——
                # 别处补不出来：`rounds` 是次数，`started_at/finished_at` 是整趟。
                "ms": max(0, int((time.monotonic() - t0) * 1000)),
            }
        )
        return result

    def _on_round(n: int) -> None:
        stats["rounds"] = n

    max_rounds = (
        max(1, min(int(t.get("max_rounds") or DEFAULT_AGENT_ROUNDS), MAX_AGENT_ROUNDS))
        if agent
        else MAX_TOOL_ROUNDS
    )
    parts: list[str] = []
    answer = ""
    last_err: Exception | None = None
    for info, model, label in candidates:
        parts.clear()
        try:
            answer = await run_agentic_chat(
                info,
                model,
                messages,
                specs,
                _run_tool,
                parts.append,
                lambda name, args: log.info("task tool call: %s %s", name, args),
                max_rounds=max_rounds,
                on_round=_on_round,
                usage=usage,
            )
            model_id = label
            break
        except Exception as e:  # noqa: BLE001
            # 换下一家的条件比纯文本严格：一个字没吐、一个工具没跑。文本已经
            # 流出会重复，工具已经执行会重复副作用——发生过就原样抛回给重试循环。
            if parts or stats["tool_calls"]:
                raise
            last_err = e
    else:
        if last_err is not None:
            raise last_err
    answer = (answer or "").strip() or "".join(parts).strip()
    if not answer:
        raise RuntimeError("模型返回空内容")
    return {
        "answer": answer,
        "sources": sources,
        "model_id": model_id,
        **stats,
        "tokens_in": usage.get("input"),
        "tokens_out": usage.get("output"),
    }


async def _persist(
    task_id: int,
    t: dict,
    answer: str,
    sources: list[dict],
    model_id: str,
    trigger: str,
    upstream_task_id: int | None,
    tokens_in: int | None = None,
    tokens_out: int | None = None,
) -> int:
    """Append the run to the task's conversation (created on first run)."""
    if trigger == "chain" and t.get("upstream_name"):
        label = f"任务链 · 上游「{t['upstream_name']}」"
    else:
        label = {"cron": "定时任务", "manual": "手动运行", "watch": "文件变化触发"}.get(trigger, trigger)
    async with SessionLocal() as db:
        conv = await db.get(Conversation, t["conversation_id"]) if t["conversation_id"] else None
        if not conv:
            conv = Conversation(
                title=f"⏰ {t['name']}"[:255], model_id=model_id, folder="定时任务"
            )
            db.add(conv)
            await db.flush()
        conv.model_id = model_id
        stamp = datetime.now().strftime("%Y-%m-%d %H:%M")
        db.add(
            Message(
                conversation_id=conv.id,
                role="user",
                content=f"[{label} {stamp}] {t['prompt']}",
            )
        )
        db.add(
            Message(
                conversation_id=conv.id,
                role="assistant",
                content=answer,
                model_id=model_id,
                sources_json=json.dumps(sources, ensure_ascii=False) if sources else None,
                tokens_in=tokens_in,
                tokens_out=tokens_out,
            )
        )
        await db.commit()
        log.info("task %s appended to conversation %s", task_id, conv.id)
        return conv.id


def _write_vault(name: str, answer: str, when: datetime, subdir: str = "") -> str | None:
    """Save the answer under vault/<subdir>/ (default vault/tasks/) so the watcher indexes it."""
    try:
        dest = (VAULT_DIR / subdir) if subdir else TASK_DIR
        dest.mkdir(parents=True, exist_ok=True)
        p = dest / f"{_safe_name(name)}-{when:%Y-%m-%d-%H%M}.md"
        p.write_text(
            f"# {name}\n\n> 定时任务自动生成 · {when:%Y-%m-%d %H:%M}\n\n{answer}\n",
            encoding="utf-8",
        )
        rel = p.relative_to(VAULT_DIR).as_posix()
        # 环二表达层：落点是成品目录（`deliver/` 之类）时零柒在这里说一句；`tasks/` 的
        # 运行留痕不是成品，它一个字都不说，下面那句「跑完了」照旧（见 `pet.note_output`）。
        from app.core import pet

        pet.note_output(name, rel)
        return rel
    except OSError:
        log.warning("could not write task result to vault", exc_info=True)
        return None


# ---------- natural language -> cron ----------
_PARSE_SYSTEM = (
    "把用户的中文定时需求转成 JSON，只输出 JSON，不要解释、不要代码块。字段：\n"
    '{"cron": "5 段标准 crontab（分 时 日 月 周，本地时区）", '
    '"name": "不超过 12 字的任务名", "prompt": "要交给模型执行的完整指令"}\n'
    "如果用户说的不是周期性任务需求（只是问问题、要一次性提醒、聊天），"
    '就输出 {"cron": "", "name": "", "prompt": ""}，不要硬编一个 cron。\n'
    "示例：每天早上8点总结知识库新增内容 → "
    '{"cron": "0 8 * * *", "name": "知识库日报", "prompt": "总结我知识库里最近新增或修改的内容，按主题归纳要点。"}'
)


class ScheduleParse(BaseModel):
    """自然语言 → cron 的解析草稿。cron 为空表示「这不是周期性需求」，
    由调用方落成一句人话报错，而不是硬编一个时间表。"""

    cron: str = ""
    name: str = ""
    prompt: str = ""

    @field_validator("cron", "name", "prompt", mode="before")
    @classmethod
    def _text(cls, v):
        if v is None or isinstance(v, (list, dict)):
            return ""
        return str(v).strip()


async def parse_schedule(text: str) -> dict:
    """Ask the model to turn '每天早上8点…' into a cron + task draft."""
    from app.core.structured import extract_json

    provider, model = await _resolve("")
    info = ProviderInfo(kind=provider.kind, base_url=provider.base_url, api_key=provider.api_key)
    obj, meta = await extract_json(
        info,
        model,
        [
            {"role": "system", "content": _PARSE_SYSTEM},
            {"role": "user", "content": text},
        ],
        ScheduleParse,
        stream_fn=stream_chat,  # 保住 tasks.stream_chat 的既有 mock seam
    )
    if obj is None:
        raise ValueError(f"模型未返回 JSON：{meta.error[:120]}")
    cron = obj.cron.strip()
    if not cron:  # 模型判定这不是周期性任务需求——照实说，别硬编
        raise ValueError("这听起来不是一个周期性的任务需求；定时任务需要能落到一个重复时间表上")
    cron = validate_cron(cron)
    return {
        "cron": cron,
        "name": obj.name.strip()[:100] or "新任务",
        "prompt": obj.prompt.strip() or text,
    }
