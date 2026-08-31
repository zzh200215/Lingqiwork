"""RSS/Atom subscriptions (ROADMAP V5.2).

New entries are appended to `vault/feeds/<feed>-YYYY-MM.md` so the vault
watcher indexes them and they become RAG-searchable; a scheduled task (V2.1)
or the daily digest can then summarize them. Seen entry ids live in
`data/feeds_seen.json` — dedupe survives restarts without touching the db.
"""
import json
import logging
import re
import threading
from datetime import datetime
from pathlib import Path

from app.config import DATA_DIR, VAULT_DIR
from app.core.prefs import load_config, save_config

log = logging.getLogger(__name__)

FEEDS_DIR = VAULT_DIR / "feeds"
SEEN_PATH = DATA_DIR / "feeds_seen.json"
NAME_RE = re.compile(r"^[^\\/:*?\"<>|]{1,60}$")

MAX_ENTRIES_PER_SYNC = 20  # newest N per feed per run
MAX_SEEN_PER_FEED = 400  # ring buffer of entry ids
SUMMARY_CHARS = 1200  # per-entry body cap written into the note
FETCH_TIMEOUT = 20

_seen_lock = threading.Lock()


def _load_seen() -> dict[str, list[str]]:
    if not SEEN_PATH.exists():
        return {}
    try:
        return json.loads(SEEN_PATH.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return {}


def _save_seen(data: dict[str, list[str]]) -> None:
    SEEN_PATH.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")


def list_feeds() -> list[dict]:
    return list(load_config().get("feeds") or [])


def _save_feed(entry: dict) -> None:
    feeds = [f for f in list_feeds() if f.get("name") != entry["name"]]
    feeds.append(entry)
    save_config({"feeds": sorted(feeds, key=lambda f: f["name"])})


def _strip_html(html: str) -> str:
    text = re.sub(r"(?is)<(script|style).*?</\1>", " ", html or "")
    text = re.sub(r"(?s)<[^>]+>", " ", text)
    import html as html_mod

    text = html_mod.unescape(text)
    return re.sub(r"[ \t]*\n\s*\n\s*", "\n\n", re.sub(r"[ \t]+", " ", text)).strip()


def _entry_id(e) -> str:
    return str(getattr(e, "id", "") or getattr(e, "link", "") or getattr(e, "title", ""))[:400]


def _entry_time(e) -> str:
    for key in ("published", "updated"):
        val = getattr(e, key, None)
        if val:
            return str(val)[:40]
    return ""


def probe(url: str) -> dict:
    """Fetch a feed without storing anything — used to name/validate a new sub."""
    import feedparser

    parsed = feedparser.parse(url.strip())
    if parsed.get("bozo") and not parsed.entries:
        exc = parsed.get("bozo_exception")
        raise ValueError(f"无法解析该订阅源: {exc or '未知错误'}")
    title = (parsed.feed.get("title") or "").strip()
    return {
        "title": title,
        "entries": len(parsed.entries),
        "name": _safe_name(title or url),
    }


def _safe_name(raw: str) -> str:
    name = re.sub(r'[\\/:*?"<>|]', "-", raw.strip())[:60].strip(" .-")
    return name or "feed"


def add(url: str, name: str | None = None) -> dict:
    url = url.strip()
    if not url:
        raise ValueError("订阅地址为空")
    info = probe(url)
    name = _safe_name(name or info["name"])
    if not NAME_RE.match(name):
        raise ValueError(f"非法订阅名: {name}")
    if any(f["name"] == name for f in list_feeds()):
        raise ValueError(f"订阅 '{name}' 已存在")
    entry = {"name": name, "url": url, "title": info["title"], "enabled": True}
    entry.update(sync(name, _new_entry=entry))
    _save_feed(entry)  # sync() skips persisting when it runs for a not-yet-saved feed
    return entry


def sync(name: str, _new_entry: dict | None = None) -> dict:
    """Fetch one feed and append unseen entries to this month's note."""
    import feedparser

    feed = _new_entry or next((f for f in list_feeds() if f.get("name") == name), None)
    if not feed:
        raise ValueError(f"订阅 '{name}' 不存在")
    if not NAME_RE.match(name):
        raise ValueError(f"非法订阅名: {name}")

    parsed = feedparser.parse(feed["url"])
    entries = list(parsed.entries)[:MAX_ENTRIES_PER_SYNC]

    with _seen_lock:
        seen_all = _load_seen()
        seen = set(seen_all.get(name, []))
        fresh = [e for e in entries if _entry_id(e) not in seen]
        if fresh:
            ids = seen_all.get(name, []) + [_entry_id(e) for e in fresh]
            seen_all[name] = ids[-MAX_SEEN_PER_FEED:]
            _save_seen(seen_all)

    written = 0
    if fresh:
        written = _append_entries(name, feed.get("title") or name, fresh)

    result = {
        "new": len(fresh),
        "total": len(entries),
        "written_to": _note_path(name).name if written else None,
        "last_synced": datetime.now().isoformat(timespec="seconds"),
    }
    if _new_entry is None:
        stored = {**feed, **result}
        _save_feed(stored)
    return result


def _note_path(name: str) -> Path:
    return FEEDS_DIR / f"{name}-{datetime.now().strftime('%Y-%m')}.md"


def _append_entries(name: str, title: str, entries: list) -> int:
    FEEDS_DIR.mkdir(parents=True, exist_ok=True)
    out = _note_path(name)
    blocks: list[str] = []
    for e in entries:
        body = _strip_html(
            getattr(e, "summary", "") or (getattr(e, "content", [{}])[0].get("value", "") if getattr(e, "content", None) else "")
        )
        if len(body) > SUMMARY_CHARS:
            body = body[:SUMMARY_CHARS] + "…"
        head = f"## {getattr(e, 'title', '(无标题)')}"
        meta = " · ".join(x for x in (_entry_time(e), getattr(e, "link", "")) if x)
        blocks.append(f"{head}\n\n{meta}\n\n{body}\n")
    if not out.exists():
        out.write_text(
            f"# 订阅：{title}\n\n> 来源 RSS 自动抓取 · 每次同步追加新条目\n\n", encoding="utf-8"
        )
    with out.open("a", encoding="utf-8") as fh:
        fh.write("\n".join(blocks) + "\n")
    log.info("feed %s: appended %d entries to %s", name, len(entries), out.name)
    return len(entries)


def sync_all() -> dict:
    """Sync every enabled feed. Never raises — per-feed errors are collected."""
    results: dict[str, dict] = {}
    for f in list_feeds():
        if not f.get("enabled", True):
            continue
        try:
            results[f["name"]] = sync(f["name"])
        except Exception as e:  # noqa: BLE001
            results[f["name"]] = {"error": f"{type(e).__name__}: {e}"}
    total_new = sum(r.get("new", 0) for r in results.values())
    return {"feeds": len(results), "new": total_new, "results": results}


def set_enabled(name: str, enabled: bool) -> dict:
    feed = next((f for f in list_feeds() if f.get("name") == name), None)
    if not feed:
        raise ValueError(f"订阅 '{name}' 不存在")
    feed["enabled"] = enabled
    _save_feed(feed)
    return feed


def remove(name: str) -> dict:
    feeds = [f for f in list_feeds() if f.get("name") != name]
    save_config({"feeds": feeds})
    with _seen_lock:
        seen = _load_seen()
        seen.pop(name, None)
        _save_seen(seen)
    return {"ok": True}


def reschedule() -> None:
    """(Re)register the daily feed sync from current config."""
    from app.core import scheduler as sched

    cfg = load_config()
    sched.set_daily(
        "feeds_sync",
        _run,
        bool(cfg.get("feeds_enabled")),
        cfg.get("feeds_time") or "08:00",
        default_hour=8,
    )


async def _run() -> None:
    import asyncio

    try:
        result = await asyncio.to_thread(sync_all)
        log.info("scheduled feed sync: %s", result)
        try:
            from app.core import pet

            pet.emit("feeds", count=result["new"])
        except Exception:  # noqa: BLE001
            log.debug("pet emit failed", exc_info=True)
        cfg = load_config()
        if result["new"] and cfg.get("email_on_feeds"):
            from app.core import mailer

            lines = [f"- {n}: {r.get('new', 0)} 条新内容" for n, r in result["results"].items()]
            await asyncio.to_thread(
                mailer.send,
                f"RSS 订阅更新（{result['new']} 条）",
                "今日订阅抓取结果：\n\n" + "\n".join(lines),
            )
    except Exception:  # noqa: BLE001 - a failed run must not kill the scheduler
        log.exception("scheduled feed sync failed")
