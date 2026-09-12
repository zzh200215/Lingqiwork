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
from app.models import Conversation, Message, ProviderConfig, ScheduledTask, TaskRun

log = logging.getLogger(__name__)

JOB_PREFIX = "task_"
TASK_DIR = VAULT_DIR / "tasks"
HANDOFF_DIR = TASK_DIR / "handoff"
_RESULT_CAP = 20000
_HANDOFF_CAP = 15000
_CHAIN_MAX_DEPTH = 5
_RUNS_KEEP = 20  # run history rows kept per task
_RETRY_DELAY_SECONDS = 30
DEFAULT_AGENT_ROUNDS = 12
MAX_AGENT_ROUNDS = 30

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
    """
    tokens = [t for t in re.split(r"[,\s]+", (whitelist or "").strip()) if t]
    if not tokens or "*" in tokens:
        return specs
    return [
        s
        for s in specs
        if any(fnmatch.fnmatchcase(s.get("function", {}).get("name", ""), tok) for tok in tokens)
    ]


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


async def run_task(
    task_id: int,
    manual: bool = False,
    trigger: str = "cron",
    upstream_task_id: int | None = None,
    chain_depth: int = 0,
    chain_path: frozenset[int] = frozenset(),
    watch_files: list[str] | None = None,
    run_dir: str = "",
) -> dict:
    """Execute one task now. Never raises: failures land in last_status/task_runs."""
    async with SessionLocal() as db:
        task = await db.get(ScheduledTask, task_id)
        if not task:
            return {"status": "error", "error": "task not found"}
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
            "notify_on_error": bool(task.notify_on_error),
            "trigger_kind": task.trigger_kind or "cron",
            "chain_next_id": task.chain_next_id,
            "require_approval": bool(task.require_approval),
            "action": task.action or "prompt",
            "landing_dir": task.landing_dir or "",
        }
        if trigger == "chain" and upstream_task_id:
            up = await db.get(ScheduledTask, upstream_task_id)
            if up:
                snapshot["upstream_name"] = up.name
                snapshot["upstream_output"] = _read_handoff(up.name, task.name)

    # 一次运行 = 一个落点目录（§4-13）。链条上游定下的那个必须**继承**下来——
    # 四步因此写进同一个文件夹，那才是「同一场会议」。只有链条的第一跳才解析。
    snapshot["watch_files"] = [str(p) for p in (watch_files or [])]
    snapshot["run_dir"] = run_dir or _resolve_run_dir(snapshot, snapshot["watch_files"])

    if snapshot["trigger_kind"] == "watch" and WATCH_HOOK:
        WATCH_HOOK(task_id)  # suppress self-trigger from our own writes
    run_id = await _create_run(task_id, trigger, upstream_task_id, snapshot["mode"])

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
                result = await _execute(snapshot, log_entries)
                answer, sources, model_id = result["answer"], result["sources"], result["model_id"]
                rounds, tool_calls = result["rounds"], result["tool_calls"]
                tokens_in = result.get("tokens_in")
                tokens_out = result.get("tokens_out")
                status, error = "ok", ""
                break
            except Exception as e:  # noqa: BLE001 - report, never propagate to scheduler
                log.exception("task %s attempt %d/%d failed", task_id, attempt, attempts)
                error = f"{type(e).__name__}: {e}"
                if attempt < attempts:
                    await asyncio.sleep(_RETRY_DELAY_SECONDS)

        if status == "ok":
            conv_id = await _persist(
                task_id, snapshot, answer, sources, model_id, trigger, upstream_task_id,
                tokens_in=tokens_in, tokens_out=tokens_out,
            )
            if snapshot["save_to_vault"]:
                vault_file = _write_vault(
                    snapshot["name"], answer, started, snapshot.get("run_dir") or ""
                )
            # 人工卡点（§4-12）：这一步跑完了，但**不**往下走——等人点头。
            # 这一步的产出照样落盘/进会话，因为它正是要给人看的东西。
            gate = bool(snapshot["require_approval"])
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
                    snapshot.get("run_dir") or "",
                )
                if snapshot["trigger_kind"] == "watch" and WATCH_HOOK:
                    WATCH_HOOK(task_id)
            await _distill(snapshot, answer)
            # 打分管在最后：它是一次额外的模型调用，别让它拖住下游任务（`_fire_chain`）
            await _score_run(run_id, snapshot, sources, answer)
            if gate and not manual:
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
                task.last_run = started.astimezone()
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
    }


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
    chain_path: frozenset[int] = frozenset(), run_dir: str = "",
) -> int | None:
    """Hand the answer to the downstream task (vault file) and run it.

    Manual runs continue the chain in the background so the HTTP response
    returns after the first stage; scheduled runs wait for the whole pipeline.
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
            _write_handoff(snapshot["name"], downstream_name, answer)
            await run_task(
                nxt_id, trigger="chain", upstream_task_id=task_id,
                chain_depth=chain_depth + 1, chain_path=chain_path | {task_id},
                run_dir=run_dir,
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


async def _create_run(task_id: int, trigger: str, upstream: int | None, mode: str) -> int:
    async with SessionLocal() as db:
        row = TaskRun(task_id=task_id, trigger=trigger, upstream_task_id=upstream, mode=mode)
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
        row.finished_at = datetime.now().astimezone()
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


async def _score_run(run_id: int, t: dict, sources: list[dict], answer: str) -> None:
    """跑完给这次产出打一个**接地分**（0-5）并落在 run 上——工作流的网。

    为什么是它（§4-10）：工作流在你不看的时候跑，「跑成功但悄悄变差」不进 `last_status`。
    分数掉下来是唯一看得见的信号。判据复用 `engine_eval` 的 LLM 判分，与五个成文引擎同一套。

    **没材料就不打分**（没开检索 / 检索没命中）：没有尺子可量，别编一个分出来。
    整体 best-effort——判分挂了不能让一次成功的运行变成失败。
    """
    pairs = _judge_sources(sources)
    if not pairs or not (answer or "").strip():
        return
    try:
        candidates = await _candidates(t.get("model_id") or "")
    except Exception:  # noqa: BLE001 - 解析不到 provider，就只是这次没有分
        log.debug("task grounding judge skipped: no provider", exc_info=True)
        return
    if not candidates:
        return
    info, model, _label = candidates[0]

    from app.core import engine_eval

    try:
        grounded, reason = await engine_eval.judge_grounded(
            info, model, "task", t.get("prompt") or t.get("name") or "", pairs, answer
        )
    except Exception:  # noqa: BLE001
        log.warning("task grounding judge failed", exc_info=True)
        return

    try:
        async with SessionLocal() as db:
            row = await db.get(TaskRun, run_id)
            if row is not None:
                row.grounded = grounded
                row.judge_reason = (reason or "")[:200]
                await db.commit()
    except Exception:  # noqa: BLE001
        log.warning("task grounding score write failed", exc_info=True)


_GATE_STATUS = "awaiting_approval"  # 人工卡点：跑完了，等人点头


async def _notify_gate(t: dict) -> None:
    """卡点等人要响一声。不响它可能永远停在那儿——这正是 §6-1 说的静默。"""
    body = f"「{t['name']}」跑完了，等你点头才交给下游——在 /work 上放行或驳回。"
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


async def _execute(t: dict, log_entries: list[dict]) -> dict:
    if (t.get("action") or "prompt") == "transcribe":
        return await _transcribe(t)
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
        result = await mcp_manager.call_tool(name, args)
        stats["tool_calls"] += 1
        text = str(result)
        log_entries.append(
            {"tool": name, "args": args, "ok": not text.startswith("[tool error]"), "result": text[:600]}
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
        return p.relative_to(VAULT_DIR).as_posix()
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
