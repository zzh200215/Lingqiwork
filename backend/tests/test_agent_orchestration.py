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
from types import SimpleNamespace

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

# ---------- 自然语言 -> cron（parse_schedule） ----------


def _fake_llm(reply: str):
    provider = SimpleNamespace(kind="openai", base_url="", api_key="k")

    async def _resolve(_model_id):
        return provider, "m"

    async def _stream(_info, _model, _messages):
        yield reply

    return _resolve, _stream


async def test_parse_schedule_turns_nl_into_validated_draft(monkeypatch):
    resolve, stream = _fake_llm(
        '{"cron": "0 20 * * 3", "name": "每周复盘", "prompt": "复盘本周的学习记录"}'
    )
    monkeypatch.setattr(core, "_resolve", resolve)
    monkeypatch.setattr(core, "stream_chat", stream)
    d = await core.parse_schedule("每周三晚上八点复盘本周的学习记录")
    assert d == {"cron": "0 20 * * 3", "name": "每周复盘", "prompt": "复盘本周的学习记录"}


async def test_parse_schedule_rejects_non_schedule_intent(monkeypatch):
    """出口必须有：模型判定不是周期性需求时返回空 cron，落成一句人话，而不是硬编一个时间表。"""
    resolve, stream = _fake_llm('{"cron": "", "name": "", "prompt": ""}')
    monkeypatch.setattr(core, "_resolve", resolve)
    monkeypatch.setattr(core, "stream_chat", stream)
    with pytest.raises(ValueError, match="周期"):
        await core.parse_schedule("今天天气怎么样")


async def test_parse_schedule_rejects_broken_cron_and_garbage(monkeypatch):
    resolve, stream = _fake_llm('{"cron": "8点", "name": "x", "prompt": "y"}')
    monkeypatch.setattr(core, "_resolve", resolve)
    monkeypatch.setattr(core, "stream_chat", stream)
    with pytest.raises(ValueError):
        await core.parse_schedule("每天八点")

    resolve, stream = _fake_llm("模型没按格式回答")
    monkeypatch.setattr(core, "_resolve", resolve)
    monkeypatch.setattr(core, "stream_chat", stream)
    with pytest.raises(ValueError, match="JSON"):
        await core.parse_schedule("每天八点")


# ---------- 降级链（maple-os 参考项 2） ----------


async def _add_providers(*names: str) -> None:
    from app.models import ProviderConfig

    async with SessionLocal() as db:
        await db.execute(delete(ProviderConfig))
        for n in names:
            db.add(
                ProviderConfig(
                    name=n, kind="openai", base_url=f"https://{n}", api_key=n,
                    models=[f"{n}-m"], enabled=True,
                )
            )
        await db.commit()


async def test_candidates_chain_lists_pinned_then_other_enabled_providers():
    await _clear()
    await _add_providers("p1", "p2", "p3")
    got = await core._candidates("p2/p2-m")
    assert [c[2] for c in got] == ["p2/p2-m", "p1/p1-m", "p3/p3-m"]


async def test_execute_records_the_provider_that_actually_served(monkeypatch):
    await _clear()
    await _add_providers("p1", "p2")

    async def fake_fallback(candidates, messages, usage=None, served=None):
        assert [c[2] for c in candidates] == ["p1/p1-m", "p2/p2-m"]
        if served is not None:
            served["label"] = candidates[1][2]  # 主家挂了，第二家顶上
        yield "答案"

    monkeypatch.setattr(core, "stream_chat_fallback", fake_fallback)
    t = {"name": "t", "prompt": "p", "model_id": "", "use_rag": False, "tools_enabled": False, "mode": "simple"}
    got = await core._execute(t, [])
    assert got["answer"] == "答案" and got["model_id"] == "p2/p2-m"


def _patch_mcp_specs(monkeypatch) -> None:
    import app.core.mcp as mcp_mod

    spec = {"type": "function", "function": {"name": "x", "description": "", "parameters": {}}}
    monkeypatch.setattr(mcp_mod.mcp_manager, "tool_specs", lambda include_memory=True: [spec])
    monkeypatch.setattr(mcp_mod.mcp_manager, "call_tool", _fake_call_tool)


async def _fake_call_tool(name: str, args: dict) -> str:
    return "tool-ok"


def _agent_task() -> dict:
    return {"name": "t", "prompt": "p", "model_id": "", "use_rag": False, "tools_enabled": True, "mode": "agent"}


async def test_agent_path_does_not_fallback_after_a_tool_ran(monkeypatch):
    """工具已经执行 = 副作用已经发生，换 provider 重跑会重复它——宁可抛回重试循环。"""
    await _clear()
    await _add_providers("p1", "p2")
    _patch_mcp_specs(monkeypatch)
    tried: list[str] = []

    async def fake_agentic(info, model, messages, tools, run_tool, emit_text, emit_tool, max_rounds=6, on_round=None, usage=None):
        tried.append(info.api_key)
        if info.api_key == "p1":
            await run_tool("x", {})
            emit_text("部分")
            raise RuntimeError("mid-loop death")
        return "最终答案"

    monkeypatch.setattr(core, "run_agentic_chat", fake_agentic)
    with pytest.raises(RuntimeError, match="mid-loop"):
        await core._execute(_agent_task(), [])
    assert tried == ["p1"]


async def test_agent_path_falls_back_before_any_action(monkeypatch):
    await _clear()
    await _add_providers("p1", "p2")
    _patch_mcp_specs(monkeypatch)
    tried: list[str] = []

    async def fake_agentic(info, model, messages, tools, run_tool, emit_text, emit_tool, max_rounds=6, on_round=None, usage=None):
        tried.append(info.api_key)
        if info.api_key == "p1":
            raise ConnectionError("connection refused")
        emit_text("最终答案")
        return "最终答案"

    monkeypatch.setattr(core, "run_agentic_chat", fake_agentic)
    got = await core._execute(_agent_task(), [])
    assert got["answer"] == "最终答案" and got["model_id"] == "p2/p2-m"
    assert tried == ["p1", "p2"]


# ---------- 失败教训沉淀（maple-os 参考项 3） ----------


async def test_failure_lesson_is_injected_then_cleared_by_success(monkeypatch):
    """上次失败的原因要在下次运行时进 prompt；成功一次后自然消失——
    教训住在 task_runs 里，不需要任何清理逻辑。"""
    await _clear()
    await _add_providers("p1")
    task_id = await _add_task("教训任务", tools_enabled=False)

    async def failing(candidates, messages, usage=None, served=None):
        raise ConnectionError("域名解析失败")
        yield ""  # noqa: unreachable — 只是让函数成为 async generator

    monkeypatch.setattr(core, "stream_chat_fallback", failing)
    r1 = await core.run_task(task_id, manual=True)
    assert r1["status"] == "error"

    seen: list = []

    async def recording(candidates, messages, usage=None, served=None):
        seen.append(messages)
        yield "好的"

    monkeypatch.setattr(core, "stream_chat_fallback", recording)
    r2 = await core.run_task(task_id, manual=True)
    assert r2["status"] == "ok"
    assert any(
        "最近一次运行失败" in m["content"] and "域名解析失败" in m["content"] for m in seen[0]
    )

    seen.clear()
    r3 = await core.run_task(task_id, manual=True)
    assert r3["status"] == "ok"
    assert not any("最近一次运行失败" in m["content"] for m in seen[0])


async def test_first_run_has_no_lesson(monkeypatch):
    await _clear()
    await _add_providers("p1")
    task_id = await _add_task("首跑任务", tools_enabled=False)
    seen: list = []

    async def recording(candidates, messages, usage=None, served=None):
        seen.append(messages)
        yield "好"

    monkeypatch.setattr(core, "stream_chat_fallback", recording)
    assert (await core.run_task(task_id, manual=True))["status"] == "ok"
    assert not any("最近一次运行失败" in m["content"] for m in seen[0])
