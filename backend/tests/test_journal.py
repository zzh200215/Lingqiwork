"""语音日记：转写文本按天落盘 vault/journal/，recent 跨文件新→旧，
automemory 复用聊天同一开关（automemory_enabled，默认关）后台提取。

JOURNAL_DIR monkeypatch 到项目内临时目录，绝不碰真实 vault。
"""
import asyncio
import atexit
import shutil
import sys
import tempfile
from datetime import datetime, timedelta
from pathlib import Path

import pytest

sys.path.insert(0, ".")

_SCRATCH = Path(tempfile.mkdtemp(prefix="wb-journal-", dir=Path(__file__).parent))


def _cleanup() -> None:
    shutil.rmtree(_SCRATCH, ignore_errors=True)


atexit.register(_cleanup)

from fastapi import HTTPException  # noqa: E402

from app.core import journal as core  # noqa: E402
import app.routers.journal as journal_mod  # noqa: E402


def _patch_dir(monkeypatch, name: str) -> Path:
    d = _SCRATCH / name
    monkeypatch.setattr(core, "JOURNAL_DIR", d)
    return d


def _dt(day_offset: int, hh: int, mm: int) -> datetime:
    base = datetime(2026, 9, 6, 0, 0) + timedelta(days=day_offset)
    return base.replace(hour=hh, minute=mm)


# ---------- core.append ----------


async def test_append_creates_file_with_header(monkeypatch):
    _patch_dir(monkeypatch, "one")
    r = core.append("  今天把  journal 落盘想清楚了。 ", now=_dt(0, 14, 30))
    assert r["count"] == 1 and r["date"] == "2026-09-06" and r["time"] == "14:30"
    text = Path(r["path"]).read_text(encoding="utf-8")
    assert text.startswith("# 语音日记 2026-09-06")
    assert "## 14:30" in text
    # 空白归一：首尾去掉、连续空格压成一个
    assert "今天把 journal 落盘想清楚了。" in text


async def test_append_same_day_appends_no_dup_header(monkeypatch):
    _patch_dir(monkeypatch, "two")
    core.append("第一条", now=_dt(0, 9, 5))
    r2 = core.append("第二条", now=_dt(0, 21, 40))
    assert r2["count"] == 2
    text = Path(r2["path"]).read_text(encoding="utf-8")
    assert text.count("# 语音日记") == 1
    assert "## 09:05" in text and "## 21:40" in text
    assert text.index("## 09:05") < text.index("## 21:40")


async def test_append_rejects_blank(monkeypatch):
    _patch_dir(monkeypatch, "three")
    with pytest.raises(ValueError):
        core.append("   \n\t ", now=_dt(0, 8, 0))


# ---------- core.recent / today_count ----------


async def test_recent_spans_files_newest_first(monkeypatch):
    _patch_dir(monkeypatch, "four")
    core.append("昨早的想法", now=_dt(-1, 8, 10))
    core.append("昨晚的想法", now=_dt(-1, 23, 5))
    core.append("今天的想法", now=_dt(0, 12, 0))
    entries = core.recent(limit=3)
    assert [e["text"] for e in entries] == ["今天的想法", "昨晚的想法", "昨早的想法"]
    assert entries[0]["date"] == "2026-09-06" and entries[0]["time"] == "12:00"
    assert entries[2]["date"] == "2026-09-05"
    assert core.today_count(now=_dt(0, 12, 1)) == 1
    assert core.today_count(now=_dt(-1, 23, 6)) == 2
    # limit 截断 + excerpt 上限
    long = core.append("长" * 200, now=_dt(0, 22, 0))
    assert long["count"] == 2
    top = core.recent(limit=1)[0]
    assert len(top["excerpt"]) == core.EXCERPT_CHARS and top["text"].endswith("长")


async def test_recent_empty_when_no_dir(monkeypatch):
    _patch_dir(monkeypatch, "empty")
    assert core.recent() == [] and core.today_count() == 0


# ---------- router ----------


async def test_router_add_and_recent(monkeypatch):
    _patch_dir(monkeypatch, "router")
    # automemory 默认关：_remember 不许碰 LLM，用记录器替换后台提取
    called = []

    async def fake_remember(text: str) -> None:
        called.append(text)

    monkeypatch.setattr(journal_mod, "_remember", fake_remember)
    r = await journal_mod.add_entry(journal_mod.JournalIn(text="通过路由写一条"))
    assert r["count"] == 1
    await asyncio.sleep(0)  # 让后台任务跑完（fake 立即返回）
    assert called == ["通过路由写一条"]
    view = await journal_mod.recent_entries()
    assert view["today"] == 1
    assert view["entries"][0]["text"] == "通过路由写一条"
    with pytest.raises(HTTPException) as ei:
        await journal_mod.add_entry(journal_mod.JournalIn(text="   "))
    assert ei.value.status_code == 422


async def test_remember_disabled_needs_no_llm(monkeypatch):
    _patch_dir(monkeypatch, "mem-off")
    resolves = []
    monkeypatch.setattr(journal_mod, "load_config", lambda: {"automemory_enabled": False})

    async def fake_resolve(_):
        resolves.append(_)
        raise AssertionError("不应解析 provider")

    monkeypatch.setattr("app.core.tasks._resolve", fake_resolve)
    await journal_mod._remember("随口说说")
    assert resolves == []


async def test_remember_extracts_when_enabled(monkeypatch):
    _patch_dir(monkeypatch, "mem-on")
    monkeypatch.setattr(journal_mod, "load_config", lambda: {"automemory_enabled": True})
    seen = {}

    class _P:
        kind, base_url, api_key = "openai", "http://x", "k"

    async def fake_resolve(_):
        return _P(), "m1"

    async def fake_extract(info, model, user_text, answer_text):
        seen.update(info=info, model=model, user_text=user_text, answer_text=answer_text)
        return ["用户在做语音日记功能"]

    monkeypatch.setattr("app.core.tasks._resolve", fake_resolve)
    monkeypatch.setattr("app.core.memory.auto_extract", fake_extract)
    await journal_mod._remember("我在做语音日记")
    assert seen["model"] == "m1"
    assert seen["info"].base_url == "http://x"
    assert "语音日记" in seen["user_text"] and seen["answer_text"] == ""
