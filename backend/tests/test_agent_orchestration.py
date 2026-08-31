"""Offline tests for V2.3 agent orchestration: tool whitelist, chain pipeline
(incl. loop guard), retries, and watch-path matching. `tasks._execute` is
monkeypatched so no provider or network is needed.

Env must be set before app imports so the engine binds to a throwaway db.
"""
import asyncio
import atexit
import os
import shutil
import sys
import tempfile
from pathlib import Path

import pytest

sys.path.insert(0, ".")

# project-local scratch dir (system temp may be sandboxed)
_TMP = Path(tempfile.mkdtemp(prefix="wb-v23-", dir=Path(".").resolve()))


def _cleanup() -> None:
    try:
        asyncio.run(engine.dispose())  # release the sqlite handle first (Windows)
    except Exception:  # noqa: BLE001
        pass
    shutil.rmtree(_TMP, ignore_errors=True)


atexit.register(_cleanup)
os.environ["WB_DB_PATH"] = str(_TMP / "test.db")
os.environ["WB_CONFIG_PATH"] = str(_TMP / "config.json")

from sqlalchemy import delete  # noqa: E402

from app.core import tasks as core  # noqa: E402
from app.db import SessionLocal, engine  # noqa: E402
from app.models import Base, Conversation, Message, ScheduledTask, TaskRun  # noqa: E402
from app.core.triggers import TaskTriggerWatcher  # noqa: E402


async def _create_all() -> None:
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)


asyncio.run(_create_all())


def _specs() -> list[dict]:
    def spec(name: str) -> dict:
        return {"type": "function", "function": {"name": name, "description": name, "parameters": {}}}

    return [spec(n) for n in ("vault_read_file", "vault_write_file", "web_search", "fs__read", "fs__write")]


# ---------- filter_tools ----------


def test_filter_tools():
    specs = _specs()
    assert len(core.filter_tools(specs, "")) == 5
    assert len(core.filter_tools(specs, "*")) == 5
    assert len(core.filter_tools(specs, "vault_*")) == 2
    assert len(core.filter_tools(specs, "fs__*")) == 2
    assert len(core.filter_tools(specs, "vault_read_file, web_search")) == 2
    assert len(core.filter_tools(specs, "nope")) == 0
    # MCP tool must be whitelisted by its exposed server__tool name
    assert [s["function"]["name"] for s in core.filter_tools(specs, "fs__read")] == ["fs__read"]


# ---------- normalize_watch_path ----------


def test_normalize_watch_path():
    assert core.normalize_watch_path(" feeds/ ") == "feeds"
    assert core.normalize_watch_path("a\\b\\c") == "a/b/c"
    assert core.normalize_watch_path("") == ""
    for bad in ("../x", "a/../../b", "C:/outside"):
        try:
            core.normalize_watch_path(bad)
            raise AssertionError(f"{bad} should have raised")
        except ValueError:
            pass


# ---------- chain pipeline ----------

CALLS: list[dict] = []


async def _fake_execute(t: dict, log_entries: list) -> dict:
    CALLS.append(
        {
            "name": t["name"],
            "upstream": t.get("upstream_name"),
            "upstream_output": t.get("upstream_output"),
        }
    )
    return {
        "answer": f"result-of-{t['name']}",
        "sources": [],
        "model_id": "test/model",
        "rounds": 2,
        "tool_calls": 3,
    }


async def _clear() -> None:
    async with SessionLocal() as db:
        for model in (TaskRun, Message, Conversation, ScheduledTask):
            await db.execute(delete(model))
        await db.commit()


async def _add_task(name: str, **kw) -> int:
    async with SessionLocal() as db:
        row = ScheduledTask(name=name, prompt=f"do {name}", cron="0 9 * * *", **kw)
        db.add(row)
        await db.commit()
        await db.refresh(row)
        return row.id


@pytest.fixture(autouse=True)
def _env(monkeypatch):
    core.HANDOFF_DIR = _TMP / "handoff"
    core._RETRY_DELAY_SECONDS = 0
    CALLS.clear()
    asyncio.run(_clear())
    yield


async def test_chain_pipeline_runs_downstream_with_upstream_output(monkeypatch):
    monkeypatch.setattr(core, "_execute", _fake_execute)
    a = await _add_task("抓取", chain_next_id=None)
    b_id = await _add_task("总结")
    async with SessionLocal() as db:
        row = await db.get(ScheduledTask, a)
        row.chain_next_id = b_id
        await db.commit()

    result = await core.run_task(a, trigger="cron")

    assert result["status"] == "ok"
    assert [c["name"] for c in CALLS] == ["抓取", "总结"]
    downstream = CALLS[1]
    assert downstream["upstream"] == "抓取"
    assert "result-of-抓取" in downstream["upstream_output"]
    # handoff file lives in the vault and holds the upstream answer
    handoffs = list(core.HANDOFF_DIR.glob("*-to-*.md"))
    assert len(handoffs) == 1 and "result-of-抓取" in handoffs[0].read_text(encoding="utf-8")
    # run rows record trigger + upstream + agent stats
    async with SessionLocal() as db:
        runs = (
            (await db.execute(TaskRun.__table__.select().order_by(TaskRun.id))).mappings().all()
        )
    assert [(r["task_id"], r["trigger"]) for r in runs] == [(a, "cron"), (b_id, "chain")]
    assert runs[1]["upstream_task_id"] == a
    assert runs[0]["rounds"] == 2 and runs[0]["tool_calls"] == 3
    assert runs[0]["status"] == "ok"


async def test_chain_skips_disabled_downstream(monkeypatch):
    monkeypatch.setattr(core, "_execute", _fake_execute)
    a = await _add_task("A任务")
    b = await _add_task("B任务", enabled=False)
    async with SessionLocal() as db:
        (await db.get(ScheduledTask, a)).chain_next_id = b
        await db.commit()

    await core.run_task(a, trigger="cron")
    assert [c["name"] for c in CALLS] == ["A任务"]


async def test_chain_loop_guard(monkeypatch):
    """A↔B cycle must terminate (depth cap), not run forever."""
    monkeypatch.setattr(core, "_execute", _fake_execute)
    a = await _add_task("环A")
    b = await _add_task("环B")
    async with SessionLocal() as db:
        (await db.get(ScheduledTask, a)).chain_next_id = b
        (await db.get(ScheduledTask, b)).chain_next_id = a
        await db.commit()

    await core.run_task(a, trigger="cron")
    assert len(CALLS) <= core._CHAIN_MAX_DEPTH + 1


async def test_retry_then_success(monkeypatch):
    attempts = {"n": 0}

    async def flaky(t, log_entries):
        attempts["n"] += 1
        if attempts["n"] < 3:
            raise RuntimeError("provider 429")
        return await _fake_execute(t, log_entries)

    monkeypatch.setattr(core, "_execute", flaky)
    tid = await _add_task("重试任务", retry=2)  # 1 + 2 = 3 attempts

    result = await core.run_task(tid, trigger="cron")
    assert attempts["n"] == 3
    assert result["status"] == "ok"


async def test_manual_run_skips_retry(monkeypatch):
    attempts = {"n": 0}

    async def always_fail(t, log_entries):
        attempts["n"] += 1
        raise RuntimeError("down")

    monkeypatch.setattr(core, "_execute", always_fail)
    tid = await _add_task("手动失败", retry=3)

    result = await core.run_task(tid, manual=True, trigger="manual")
    assert attempts["n"] == 1
    assert result["status"] == "error"
    assert "down" in result["error"]


async def test_run_history_stores_log(monkeypatch):
    async def with_tools(t, log_entries):
        log_entries.append({"tool": "vault_list_files", "args": {"path": ""}, "ok": True, "result": "📄 a.md"})
        return await _fake_execute(t, log_entries)

    monkeypatch.setattr(core, "_execute", with_tools)
    tid = await _add_task("日志任务")
    await core.run_task(tid, trigger="cron")

    async with SessionLocal() as db:
        run = (
            (await db.execute(TaskRun.__table__.select().order_by(TaskRun.id.desc())))
            .mappings()
            .first()
        )
    assert run["task_id"] == tid
    assert "vault_list_files" in run["log_json"]


# ---------- watch matching ----------


def test_watch_match():
    m = TaskTriggerWatcher._match
    assert m("feeds", "feeds/2026-08.md")
    assert m("feeds/", "feeds/2026-08.md")
    assert m("notes/x.md", "notes/x.md")
    assert m("", "anything/here.md")
    assert not m("feeds", "notes/x.md")
    assert not m("feeds", "feeds2/x.md")  # prefix must stop at a separator


def test_watch_to_rel():
    w = TaskTriggerWatcher(root=Path("D:/TP/A/vault").resolve())
    assert w._to_rel("D:\\TP\\A\\vault\\feeds\\08.md") == "feeds/08.md"
    assert w._to_rel(str(Path("D:/TP/A/vault").resolve() / "a.md")) == "a.md"
    assert w._to_rel("D:\\TP\\A\\backend\\x.md") is None  # outside the vault
