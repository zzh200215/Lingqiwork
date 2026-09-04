"""Daily vault digest: collect recently changed notes, LLM-summarize, write
to vault/digests/YYYY-MM-DD.md (auto-indexed by the watcher for RAG).

Scheduled on the shared APScheduler from config: digest_enabled + digest_time.
"""
import logging
import time
from datetime import datetime
from pathlib import Path

from app.config import VAULT_DIR
from app.core import ingest
from app.core.llm import ProviderInfo, stream_chat
from app.core.prefs import load_config

log = logging.getLogger(__name__)

DIGEST_DIR = VAULT_DIR / "digests"
_RECENT_DAYS = 7  # window for "recently changed"
_MAX_FILES = 30


def _resolve_model_id() -> str | None:
    """First enabled provider's first *working* model.

    A delegate, same as `pet._default_model_id`: this was a byte-identical copy of
    that function until the rule moved to `core/providers.py`. Its callers here and
    in kg / memory_tidy / podcast are unchanged.
    """
    from app.core.providers import default_model_id

    return default_model_id()


def collect_recent_changes(days: int = _RECENT_DAYS) -> list[Path]:
    cutoff = time.time() - days * 86400
    files = [
        p
        for p in VAULT_DIR.rglob("*")
        if p.is_file()
        and ingest.is_supported(p)
        and "digests" not in p.relative_to(VAULT_DIR).parts  # don't feed on own output
        and p.stat().st_mtime >= cutoff
    ]
    files.sort(key=lambda p: p.stat().st_mtime, reverse=True)
    return files[:_MAX_FILES]


def _build_prompt(files: list[Path]) -> str:
    blocks = []
    for p in files:
        rel = p.relative_to(VAULT_DIR).as_posix()
        text = ingest.parse_file(p)
        if len(text) > 3000:
            text = text[:3000] + "\n...[截断]"
        mtime = datetime.fromtimestamp(p.stat().st_mtime).strftime("%m-%d %H:%M")
        blocks.append(f"### {rel}（更新于 {mtime}）\n{text}")
    joined = "\n\n".join(blocks)
    return (
        "以下是我最近更新的笔记。请用中文写一份今日摘要，帮我快速回顾：\n"
        "1. 按「主题聚类」归纳要点（不要逐文件罗列）；\n"
        "2. 每个主题标注来源笔记路径；\n"
        "3. 结尾列出「值得跟进的事项」（如有）。\n"
        "直接输出 markdown，不要寒暄。\n\n" + joined
    )


async def generate_digest() -> dict:
    """Run one digest generation. Returns status info."""
    model_id = _resolve_model_id()
    if not model_id:
        return {"ok": False, "error": "没有已启用的 provider，无法生成摘要"}

    from app.routers.chat import resolve_model

    try:
        resolved = await resolve_model(model_id)
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": f"{type(e).__name__}: {e}"}

    files = collect_recent_changes()
    if not files:
        return {"ok": True, "files": 0, "message": "最近没有笔记变更，跳过"}

    prompt = _build_prompt(files)
    p = resolved.provider
    info = ProviderInfo(kind=p.kind, base_url=p.base_url, api_key=p.api_key)

    parts: list[str] = []
    async for delta in stream_chat(info, resolved.model, [{"role": "user", "content": prompt}]):
        parts.append(delta)
    content = "".join(parts).strip()
    if not content:
        return {"ok": False, "error": "模型返回空内容"}

    today = datetime.now().strftime("%Y-%m-%d")
    DIGEST_DIR.mkdir(parents=True, exist_ok=True)
    out = DIGEST_DIR / f"{today}.md"
    header = (
        f"# 笔记摘要 {today}\n\n"
        f"> 自动生成 · 覆盖近 {_RECENT_DAYS} 天变更 · 涉及 {len(files)} 个文件\n\n"
    )
    out.write_text(header + content + "\n", encoding="utf-8")
    log.info("digest written: %s (%d source files)", out, len(files))
    return {"ok": True, "file": out.name, "files": len(files)}


def reschedule() -> None:
    """(Re)register the daily digest job from current config."""
    from app.core import scheduler as sched

    cfg = load_config()
    sched.set_daily(
        "daily_digest",
        _run,
        bool(cfg.get("digest_enabled")),
        cfg.get("digest_time") or "09:00",
    )


async def _maybe_podcast(result: dict) -> None:
    """Optionally turn a fresh digest into a podcast episode (opt-in pref).

    Best-effort: any failure is logged and swallowed so the digest job
    itself never breaks.
    """
    if not (result.get("ok") and result.get("files") and load_config().get("podcast_daily_enabled")):
        return
    try:
        from app.core import podcast

        entry = await podcast.from_digest(DIGEST_DIR / result["file"])
        log.info("digest→podcast: %s", entry.get("id") or entry.get("error"))
    except Exception:  # noqa: BLE001
        log.exception("digest→podcast failed")


async def _run() -> None:
    try:
        result = await generate_digest()
        log.info("scheduled digest result: %s", result)
        if result.get("ok") and result.get("files") and load_config().get("email_on_digest"):
            import asyncio

            from app.core import mailer

            body = (DIGEST_DIR / result["file"]).read_text(encoding="utf-8")
            await asyncio.to_thread(mailer.send, f"笔记摘要 {result['file'].removesuffix('.md')}", body)
        await _maybe_podcast(result)
        if result.get("ok") and result.get("files"):
            try:
                from app.core import pet

                pet.emit("digest", count=result["files"])
            except Exception:  # noqa: BLE001
                log.debug("pet emit failed", exc_info=True)
    except Exception:  # noqa: BLE001 - a failed run must not kill the scheduler
        log.exception("scheduled digest failed")
