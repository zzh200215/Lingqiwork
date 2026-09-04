"""零柒 — the workbench's resident companion (ROADMAP V14).

零柒 is the personification of the proactive layer: it speaks first, without
being asked, about what the system already did (tasks, digest, backup, feeds).

Three rules baked into the design:
- proactive, not reactive — it emits on events, never waits to be asked;
- honest mood — its "status" is computed from real data, never faked;
- frugal — it stays quiet unless it has something with substance, and only
  toasts for failures and greetings (never per-event spam).

Deliberately all-sync: emit() fires from scheduler threads and task coroutines
alike, so it uses plain sqlite3 (same pattern as digest._resolve_model) and
never awaits. A failed emit must never break the triggering job.
"""
import logging
from datetime import datetime

from app.config import VAULT_DIR, settings
from app.core import notify
from app.core.prefs import load_config

log = logging.getLogger(__name__)

KINDS = {
    "task_done",
    "task_failed",
    "digest",
    "backup",
    "feeds",
    "greeting",
    "say",
    "cards_due",
    "cards_done",
    "cards_remedy",
    "habits_due",
}

CHAT_SYSTEM = (
    "你是「零柒」，一台本地优先的个人工作台里的常驻小助手。"
    "性格：极简、克制、靠谱，偶尔一句冷幽默；不寒暄、不卖萌、不刷存在感。"
    "回答尽量短——能一句说完就不说两句，用户要细节时再展开。"
    "你了解这台工作台的能力（多模型对话/RAG 知识库/定时任务/笔记/备份/语音），"
    "适合交给定时任务的事就主动建议交给定时任务。用中文回答。"
)


def _conn():
    import sqlite3

    return sqlite3.connect(settings.db_path)


def _pet_enabled() -> bool:
    try:
        return bool(load_config().get("pet_enabled", True))
    except Exception:  # noqa: BLE001
        return True


def _default_model_id() -> str | None:
    """First enabled provider's first *working* model.

    Kept as a thin delegate so its six call sites did not have to change when the
    rule moved into `core/providers.py`; that move is what made "skip a model whose
    last probe failed" possible in one place instead of three.
    """
    from app.core.providers import default_model_id

    return default_model_id()


def compose(kind: str, name: str = "", detail: str = "", count: int = 0) -> str:
    """Template line for an event. 零柒's voice: terse, a little dry."""
    now = datetime.now()
    if kind == "task_done":
        tail = f" {detail.strip()[:60]}" if detail.strip() else ""
        return f"「{name}」跑完了。{tail.strip()}"
    if kind == "task_failed":
        return f"「{name}」没跑成。{detail.strip()[:80]}"
    if kind == "digest":
        return f"今日摘要好了，覆盖 {count} 个文件的变更，已放进 digests。"
    if kind == "backup":
        return f"备份打好了（{detail}）。"
    if kind == "feeds":
        return f"订阅抓完了，{count} 条新内容已入库。"
    if kind == "cards_due":
        tail = f"，已经连着 {detail} 天了" if detail and detail not in ("0", "") else ""
        return f"今天有 {count} 张卡到期{tail}。十分钟的事。"
    if kind == "cards_done":
        tail = f"，连着 {detail} 天" if detail and detail not in ("0", "") else ""
        return f"今天 {count} 张过完了{tail}。"
    if kind == "cards_remedy":
        return f"你老错的那几个点我补了一段讲解（{count} 篇），在 notes 里。"
    if kind == "habits_due":
        # cards all cleared, only the habit grid left — `name` carries the names
        tail = f"：{name}" if name else ""
        return f"卡都清完了。还剩 {count} 个习惯没打勾{tail}。"
    if kind == "greeting":
        part = "早上" if now.hour < 11 else ("下午" if now.hour < 18 else "晚上")
        return f"{part}好。今天的事我盯着，有进展我叫你。"
    return detail or "在。"


def emit(
    kind: str,
    name: str = "",
    detail: str = "",
    count: int = 0,
    text: str | None = None,
) -> int | None:
    """Record one spoken line; toast only for failures and greetings.

    Best-effort by contract: any failure is logged and swallowed so the
    triggering job (task/digest/backup/feeds) is never broken by the pet.
    """
    try:
        if not _pet_enabled():
            return None
        line = (text or compose(kind, name=name, detail=detail, count=count)).strip()
        if not line:
            return None
        import sqlite3

        conn = sqlite3.connect(settings.db_path)
        try:
            conn.execute(
                "CREATE TABLE IF NOT EXISTS pet_events ("
                "id INTEGER PRIMARY KEY, created_at TEXT, kind TEXT, text TEXT, detail TEXT)"
            )
            cur = conn.execute(
                "INSERT INTO pet_events (created_at, kind, text, detail) VALUES (?,?,?,?)",
                (datetime.now().astimezone().isoformat(timespec="seconds"), kind[:20], line, detail[:500]),
            )
            conn.commit()
            event_id = int(cur.lastrowid or 0)
        finally:
            conn.close()
        # frugal: toast only for things that are useless unseen — failures,
        # greetings, and the daily review/habit nudge (a bubble in a page you
        # never opened is worth nothing). At most one such toast per day.
        if kind in ("task_failed", "greeting", "cards_due", "habits_due") and load_config().get(
            "pet_notify", True
        ):
            try:
                notify.desktop("零柒", line[:180])
            except Exception:  # noqa: BLE001
                pass
        log.info("pet emit [%s]: %s", kind, line[:80])
        return event_id
    except Exception:  # noqa: BLE001 - never break the caller
        log.debug("pet emit failed", exc_info=True)
        return None


def feed(limit: int = 30, since_id: int = 0) -> list[dict]:
    """Recent spoken lines, newest first."""
    limit = max(1, min(int(limit), 100))
    import sqlite3

    conn = sqlite3.connect(settings.db_path)
    try:
        rows = conn.execute(
            "SELECT id, kind, text, detail, created_at FROM pet_events "
            "WHERE id > ? ORDER BY id DESC LIMIT ?",
            (int(since_id), limit),
        ).fetchall()
    finally:
        conn.close()
    return [
        {"id": r[0], "kind": r[1], "text": r[2], "detail": r[3], "created_at": r[4]}
        for r in rows
    ]


def status() -> dict:
    """Honest mood: computed from real data, never faked. All best-effort."""
    today = datetime.now().strftime("%Y-%m-%d")
    out: dict = {
        "tasks_done": 0,
        "tasks_failed": 0,
        "notes_today": 0,
        "tokens_today": 0,
        "time_of_day": "morning" if datetime.now().hour < 11 else ("afternoon" if datetime.now().hour < 18 else "evening"),
        "pet_enabled": _pet_enabled(),
    }
    try:
        import sqlite3

        conn = sqlite3.connect(settings.db_path)
        try:
            for st, n in conn.execute(
                "SELECT status, COUNT(*) FROM task_runs "
                "WHERE CAST(started_at AS TEXT) LIKE ? GROUP BY status",
                (f"{today}%",),
            ):
                if st == "ok":
                    out["tasks_done"] = int(n)
                elif st == "error":
                    out["tasks_failed"] = int(n)
            row = conn.execute(
                "SELECT COALESCE(SUM(tokens_in),0)+COALESCE(SUM(tokens_out),0) "
                "FROM messages WHERE CAST(created_at AS TEXT) LIKE ?",
                (f"{today}%",),
            ).fetchone()
            out["tokens_today"] = int(row[0] or 0)
        finally:
            conn.close()
    except Exception:  # noqa: BLE001 - stats are best-effort
        log.debug("pet status db query failed", exc_info=True)
    try:
        cutoff = datetime.now().replace(hour=0, minute=0, second=0, microsecond=0).timestamp()
        out["notes_today"] = sum(
            1
            for p in VAULT_DIR.rglob("*")
            if p.is_file()
            and p.suffix == ".md"
            and p.stat().st_mtime >= cutoff
            and not {"digests", "feeds", "tasks"} & set(p.relative_to(VAULT_DIR).parts[:-1])
        )
    except Exception:  # noqa: BLE001
        pass
    return out


async def greeting(mode: str = "morning") -> str:
    """One LLM-composed line in 零柒's voice; template fallback if no provider."""
    st = status()
    mode_label = {"morning": "早间", "evening": "晚间"}.get(mode, "")
    fallback = compose("greeting")
    model_id = _default_model_id()
    if not model_id:
        return fallback
    try:
        from app.core.llm import ProviderInfo, stream_chat
        from app.routers.chat import resolve_model

        resolved = await resolve_model(model_id)
        p = resolved.provider
        info = ProviderInfo(kind=p.kind, base_url=p.base_url, api_key=p.api_key)
        when = {"morning": "早上", "evening": "晚上"}.get(mode, "现在")
        user = (
            f"现在是{when}。今日数据：任务完成 {st['tasks_done']} 失败 {st['tasks_failed']}，"
            f"今日新增笔记 {st['notes_today']} 篇，token 用量 {st['tokens_today']}。"
            f"以零柒的身份说一句{mode_label}的话（一两句以内），直接输出那句话本身。"
        )
        parts: list[str] = []
        async for delta in stream_chat(
            info,
            resolved.model,
            [
                {"role": "system", "content": CHAT_SYSTEM},
                {"role": "user", "content": user},
            ],
        ):
            parts.append(delta)
        line = "".join(parts).strip()
        return line[:200] if line else fallback
    except Exception:  # noqa: BLE001 - template fallback, never raise
        log.debug("pet greeting LLM failed", exc_info=True)
        return fallback


def reschedule() -> None:
    """(Re)register the daily morning/evening greetings from config.

    This is the pet's "circadian rhythm" — the one thing that makes it
    speak FIRST on a schedule, instead of only reacting to job events.
    """
    from app.core import scheduler as sched

    cfg = load_config()
    enabled = bool(cfg.get("pet_greet_enabled", True)) and _pet_enabled()
    sched.set_daily(
        "pet_morning",
        _greet_morning,
        enabled,
        cfg.get("pet_morning_time") or "08:30",
    )
    sched.set_daily(
        "pet_evening",
        _greet_evening,
        enabled,
        cfg.get("pet_evening_time") or "21:00",
    )


async def _greet_morning() -> None:
    """Scheduled: 零柒 greets first thing; best-effort, never breaks the scheduler."""
    try:
        line = await greeting("morning")
        emit("greeting", text=line)
        log.info("pet morning greeting: %s", line[:80])
    except Exception:  # noqa: BLE001
        log.exception("pet morning greeting failed")


async def _greet_evening() -> None:
    """Scheduled: 零柒 recaps the day from real data; best-effort."""
    try:
        line = await greeting("evening")
        emit("greeting", text=line)
        log.info("pet evening greeting: %s", line[:80])
    except Exception:  # noqa: BLE001
        log.exception("pet evening greeting failed")
