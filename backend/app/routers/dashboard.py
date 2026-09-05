"""Dashboard stats: usage overview for the landing page."""
import json
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import VAULT_DIR
from app.db import get_db
from app.models import Conversation, Memory, Message, ScheduledTask, TaskRun

router = APIRouter(prefix="/api/dashboard", tags=["dashboard"])

# V14 仪表盘叙事：LLM 生成零柒口吻今日一句话，TTL 缓存
_briefing_cache: dict = {"text": "", "facts_hash": None, "ts": None, "ttl": 300}
_BRIEFING_SYSTEM = (
    "你是「零柒」，本地工作台的常驻小助手。性格：极简、克制、偶尔一句冷幽默，不寒暄不卖萌。"
    "根据用户给的「今日事实」，写一句 30 字以内的今日要点。"
    "要求：①像跟朋友随口说一句，不是列数字；②不要堆砌数据，挑 1-2 件最值得说的事；"
    "③早中晚语气略有不同——早上鼓励，下午客观，晚上回顾收尾；"
    "④如果事实几乎都是 0，说「今天挺安静的」之类。"
    "直接输出那句话本身，不要前缀、不要引号、不要解释。"
)

_BRIEFING_DEFAULTS = {
    "conversations": 0, "messages": 0, "memories": 0, "vault_files": 0,
    "narrative": {
        "today_messages": 0, "yesterday_messages": 0,
        "this_week_messages": 0, "prev_week_messages": 0,
        "today_tokens": 0, "today_vault_files": 0,
    },
    "task_stats": {"runs_30d": 0, "ok": 0, "error": 0, "rate": None},
    "recent_conversations": [],
}


@router.get("")
async def dashboard(db: AsyncSession = Depends(get_db)):
    from app.core import usage as usage_core

    total_convs = (await db.execute(select(func.count(Conversation.id)))).scalar() or 0
    total_msgs = (await db.execute(select(func.count(Message.id)))).scalar() or 0
    total_memories = (await db.execute(select(func.count(Memory.id)))).scalar() or 0

    week_ago = datetime.now(timezone.utc) - timedelta(days=7)
    recent_convs = (
        await db.execute(
            select(Conversation).order_by(Conversation.updated_at.desc()).limit(5)
        )
    ).scalars().all()
    daily = (
        await db.execute(
            select(func.date(Message.created_at), func.count(Message.id))
            .where(Message.created_at >= week_ago)
            .group_by(func.date(Message.created_at))
        )
    ).all()

    model_rows = (
        await db.execute(
            select(Message.model_id, func.count(Message.id))
            .where(Message.role == "assistant", Message.model_id.isnot(None))
            .group_by(Message.model_id)
            .order_by(func.count(Message.id).desc())
        )
    ).all()

    vault_files = [p for p in VAULT_DIR.rglob("*") if p.is_file()]

    # --- V6.2 observability: token usage + task health ---
    total_tokens_row = (
        await db.execute(
            select(func.coalesce(func.sum(Message.tokens_in), 0), func.coalesce(func.sum(Message.tokens_out), 0)).where(
                Message.role == "assistant"
            )
        )
    ).one()
    daily_tokens = (
        await db.execute(
            select(
                func.date(Message.created_at),
                func.coalesce(func.sum(Message.tokens_in + Message.tokens_out), 0),
            )
            .where(Message.role == "assistant", Message.created_at >= week_ago)
            .group_by(func.date(Message.created_at))
        )
    ).all()
    month_ago = datetime.now(timezone.utc) - timedelta(days=30)
    run_rows = (
        await db.execute(
            select(TaskRun.status, func.count(TaskRun.id))
            .where(TaskRun.started_at >= month_ago)
            .group_by(TaskRun.status)
        )
    ).all()
    run_counts = {status: n for status, n in run_rows}
    runs_total = sum(run_counts.values())
    runs_ok = run_counts.get("ok", 0)

    from app.core import tasks as task_core

    task_rows = (
        await db.execute(
            select(ScheduledTask).where(ScheduledTask.enabled.is_(True)).order_by(ScheduledTask.id)
        )
    ).scalars().all()
    upcoming = sorted(
        (
            {
                "id": t.id,
                "name": t.name,
                "cron": t.cron,
                "mode": t.mode or "simple",
                "trigger_kind": t.trigger_kind or "cron",
                "watch_path": t.watch_path or "",
                "next_run": task_core.next_run(t.id),
                "last_run": t.last_run.isoformat(timespec="seconds") if t.last_run else None,
                "last_status": t.last_status,
            }
            for t in task_rows
        ),
        key=lambda t: t["next_run"] or "9999",
    )

    return {
        "conversations": total_convs,
        "messages": total_msgs,
        "memories": total_memories,
        "vault_files": len(vault_files),
        "tokens_total": int(total_tokens_row[0] or 0) + int(total_tokens_row[1] or 0),
        "daily_tokens": [
            {"date": str(d), "tokens": int(n or 0)} for d, n in daily_tokens
        ],
        "task_stats": {
            "runs_30d": runs_total,
            "ok": runs_ok,
            "error": run_counts.get("error", 0),
            "rate": round(runs_ok / runs_total, 4) if runs_total else None,
        },
        "tasks": upcoming[:5],
        "tasks_total": len(task_rows),
        "recent_conversations": [
            {"id": c.id, "title": c.title, "model_id": c.model_id, "updated_at": c.updated_at.isoformat()}
            for c in recent_convs
        ],
        # last 7 days message counts (oldest first), missing days filled client-side or as 0
        "daily_messages": [{"date": str(d), "count": n} for d, n in daily],
        "top_models": [{"model_id": m or "?", "count": n} for m, n in model_rows[:5]],
        # 第0周使用基线：本周实际打开过应用的天数（"打开次数"的真相源）
        "open_days_7d": len(await usage_core.open_days(7)),
        # V14 叙事卡片所需：今日/本周/上周对比 + 今日任务 + 今日 vault 新增
        "narrative": _narrative_block(daily, daily_tokens, vault_files),
    }


def _narrative_block(daily_msgs, daily_tokens, vault_files):
    """Aggregate narrative-card data: today / yesterday / this-week / prev-week
    deltas plus today's vault additions. Returns plain ints for JSON."""
    from datetime import timezone

    now = datetime.now(timezone.utc)
    today_start_dt = now.replace(hour=0, minute=0, second=0, microsecond=0)
    today_start_d = today_start_dt.date()
    yesterday_d = today_start_d - timedelta(days=1)
    week_start_d = today_start_d - timedelta(days=7)
    prev_week_start_d = today_start_d - timedelta(days=14)

    msg_by = {str(d): int(n) for d, n in daily_msgs}
    tok_by = {str(d): int(n) for d, n in daily_tokens}

    def _parse_date(s):
        import datetime as _dt
        return _dt.date.fromisoformat(s)

    this_week_msgs = sum(
        n for d_str, n in msg_by.items()
        if week_start_d <= _parse_date(d_str) <= today_start_d
    )
    prev_week_msgs = sum(
        n for d_str, n in msg_by.items()
        if prev_week_start_d <= _parse_date(d_str) < week_start_d
    )

    today_vault = sum(
        1 for p in vault_files
        if p.suffix == ".md"
        and not {"digests", "feeds", "tasks"} & set(p.relative_to(VAULT_DIR).parts[:-1])
        and p.stat().st_mtime >= today_start_dt.timestamp()
    )

    return {
        "today_messages": msg_by.get(str(today_start_d), 0),
        "yesterday_messages": msg_by.get(str(yesterday_d), 0),
        "this_week_messages": this_week_msgs,
        "prev_week_messages": prev_week_msgs,
        "today_tokens": tok_by.get(str(today_start_d), 0),
        "today_vault_files": today_vault,
        "week_start": today_start_d.isoformat(),
    }


@router.get("/briefing")
async def dashboard_briefing(db: AsyncSession = Depends(get_db)):
    """零柒口吻的「今日要点」：基于真实数据 + LLM，带 5 分钟 TTL 缓存，
    无 provider 时降级模板。"""
    # 复用 dashboard 主体计算（避免双倍 SQL）
    main = await dashboard(db)
    facts = _facts_for_briefing(main)
    facts_hash = hash(json.dumps(facts, sort_keys=True, default=str))
    now = datetime.now(timezone.utc)
    if (
        _briefing_cache["text"]
        and _briefing_cache["facts_hash"] == facts_hash
        and _briefing_cache["ts"]
        and (now - _briefing_cache["ts"]).total_seconds() < _briefing_cache["ttl"]
    ):
        return {"text": _briefing_cache["text"], "facts": facts, "cached": True}

    text = await _generate_briefing_text(facts)
    _briefing_cache.update({"text": text, "facts_hash": facts_hash, "ts": now})
    return {"text": text, "facts": facts, "cached": False}


def _facts_for_briefing(main: dict) -> dict:
    """从 dashboard 主响应里抽出 briefing 关心的紧凑事实。"""
    nar = main.get("narrative") or _BRIEFING_DEFAULTS["narrative"]
    ts = main.get("task_stats") or _BRIEFING_DEFAULTS["task_stats"]
    return {
        "conversations": main.get("conversations", 0),
        "memories": main.get("memories", 0),
        "vault_files": main.get("vault_files", 0),
        "today_messages": nar.get("today_messages", 0),
        "yesterday_messages": nar.get("yesterday_messages", 0),
        "this_week_messages": nar.get("this_week_messages", 0),
        "prev_week_messages": nar.get("prev_week_messages", 0),
        "today_tokens": nar.get("today_tokens", 0),
        "today_vault_files": nar.get("today_vault_files", 0),
        "task_runs_30d": ts.get("runs_30d", 0),
        "task_ok_30d": ts.get("ok", 0),
        "task_err_30d": ts.get("error", 0),
        "recent_titles": [c["title"] for c in main.get("recent_conversations", [])[:3] if c.get("title")],
    }


async def _generate_briefing_text(facts: dict) -> str:
    """调 LLM 生成零柒口吻今日要点；任何失败都降级模板。"""
    hour = datetime.now().hour
    part = "早上" if hour < 11 else ("下午" if hour < 18 else "晚上")
    fallback = _template_briefing(facts, part)

    try:
        from app.core.llm import ProviderInfo, stream_chat
        from app.core.pet import _default_model_id
        from app.routers.chat import resolve_model

        model_id = _default_model_id()
        if not model_id:
            return fallback
        resolved = await resolve_model(model_id)
        info = ProviderInfo(
            kind=resolved.provider.kind,
            base_url=resolved.provider.base_url,
            api_key=resolved.provider.api_key,
        )
        user = (
            f"现在是{part}。事实：{json.dumps(facts, ensure_ascii=False)}。\n"
            f"以零柒身份写一句今日要点（30 字以内）："
        )
        parts: list[str] = []
        async for delta in stream_chat(
            info,
            resolved.model,
            [
                {"role": "system", "content": _BRIEFING_SYSTEM},
                {"role": "user", "content": user},
            ],
        ):
            parts.append(delta)
        text = "".join(parts).strip()
        # 兜底：去引号、去前缀、长度限制
        text = text.strip(' "「」『』').strip()
        if text.startswith("零柒："):
            text = text.split("：", 1)[1].strip()
        return text[:200] if text else fallback
    except Exception:  # noqa: BLE001 - never break the dashboard
        return fallback


def _template_briefing(facts: dict, part: str) -> str:
    """无 LLM 时的零柒口吻模板——挑 1-2 件最值得说的。"""
    if facts.get("task_err_30d", 0) > 0 and (facts.get("today_messages", 0) or facts.get("today_vault_files", 0)) == 0:
        return f"{part}安。{facts['task_err_30d']} 件事最近没跑成，回头看看。"
    if facts.get("today_messages", 0) == 0 and facts.get("today_vault_files", 0) == 0:
        return f"{part}好，挺安静的，适合写点东西。"
    if facts.get("today_messages", 0) >= 8:
        return f"{part}好，聊了不少——{facts['today_messages']} 条新消息。"
    if facts.get("today_vault_files", 0) >= 1:
        return f"{part}好，vault 今天又多了 {facts['today_vault_files']} 篇。"
    delta = facts.get("this_week_messages", 0) - facts.get("prev_week_messages", 0)
    if delta > 5:
        return f"{part}好，这周比上周多聊了 {delta} 条。"
    return f"{part}好。"
