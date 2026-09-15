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

from sqlalchemy import delete, select  # noqa: E402

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


# ---------- 任务经验沉淀（EvoForge 参考项 4） ----------


async def _run_ok_task(monkeypatch, task_name: str) -> None:
    await _clear()
    await _add_providers("p1")
    task_id = await _add_task(task_name, tools_enabled=False)

    async def recording(candidates, messages, usage=None, served=None):
        yield "任务完成，产出要点。"

    monkeypatch.setattr(core, "stream_chat_fallback", recording)
    r = await core.run_task(task_id, manual=True)
    assert r["status"] == "ok"


async def test_distill_respects_automemory_switch(monkeypatch):
    """和聊天页共用 automemory_enabled 开关：关着就一次调用都不该有。"""
    from app.core import memory as mem
    from app.core.prefs import save_config

    save_config({"automemory_enabled": False})
    calls: list = []

    async def fake_extract(info, model, user_text, answer_text):
        calls.append(user_text)
        return []

    monkeypatch.setattr(mem, "auto_extract", fake_extract)
    await _run_ok_task(monkeypatch, "关闭沉淀")
    assert calls == []

    save_config({"automemory_enabled": True})
    await _run_ok_task(monkeypatch, "开启沉淀")
    assert len(calls) == 1 and "开启沉淀" in calls[0]
    save_config({"automemory_enabled": False})


async def test_distilled_fact_lands_in_memory(monkeypatch):
    from sqlalchemy import select as _select

    from app.core import memory as mem
    from app.core.prefs import save_config
    from app.models import Memory as _Memory

    save_config({"automemory_enabled": True})
    async with SessionLocal() as db:
        await db.execute(delete(_Memory))
        await db.commit()

    async def fake_embed(texts):
        return [[1.0, 0.0] for _ in texts]

    async def fake_stream(info, model, messages, usage=None):
        yield '[{"kind": "fact", "text": "XX 站点必须带 UA 头"}]'

    monkeypatch.setattr(mem, "_embed_texts", fake_embed)
    monkeypatch.setattr(mem, "stream_chat", fake_stream)
    await _run_ok_task(monkeypatch, "落库验证")

    async with SessionLocal() as db:
        rows = (await db.execute(_select(_Memory))).scalars().all()
    assert any("UA 头" in m.content and m.kind == "fact" and m.source == "auto" for m in rows)
    save_config({"automemory_enabled": False})


async def test_distill_failure_does_not_fail_the_task(monkeypatch):
    from app.core import memory as mem
    from app.core.prefs import save_config

    save_config({"automemory_enabled": True})
    await _clear()
    await _add_providers("p1")
    task_id = await _add_task("异常沉淀", tools_enabled=False)

    async def boom(info, model, user_text, answer_text):
        raise RuntimeError("抽取挂了")

    monkeypatch.setattr(mem, "auto_extract", boom)

    async def recording(candidates, messages, usage=None, served=None):
        yield "正常完成"

    monkeypatch.setattr(core, "stream_chat_fallback", recording)
    r = await core.run_task(task_id, manual=True)
    assert r["status"] == "ok"
    save_config({"automemory_enabled": False})


# ---------- 尺子：运行接地分（§4-10） ----------


def test_judge_sources_normalizes_hits_into_numbered_materials():
    out = core._judge_sources(
        [
            {"source": "notes/a.md", "text": "内容A"},
            {"source": "notes/b.md", "text": "   "},  # 空正文 → 丢掉，它本来也判不了
            {"source": "notes/c.md", "title": "C 的标题", "text": "内容C"},
        ]
    )
    assert [s["n"] for s in out] == [1, 2]  # 重新编号，不留空洞
    assert [s["ref"] for s in out] == ["notes/a.md", "notes/c.md"]
    assert out[1]["title"] == "C 的标题" and out[1]["kind"] == "kb"


def _execute_with(sources: list[dict]):
    async def fake_execute(t: dict, log_entries: list) -> dict:
        return {
            "answer": "答案 [来源 1]",
            "sources": sources,
            "model_id": "p1/p1-m",
            "rounds": 1,
            "tool_calls": 0,
        }

    return fake_execute


async def _last_run() -> TaskRun:
    async with SessionLocal() as db:
        return (
            await db.execute(select(TaskRun).order_by(TaskRun.id.desc()).limit(1))
        ).scalar_one()


async def test_successful_run_records_a_grounding_score(monkeypatch):
    """跑完一条用了检索的任务，run 上带着接地分——工作流无人值守时唯一会说话的东西。"""
    await _clear()
    await _add_providers("p1")
    monkeypatch.setattr(
        core, "_execute", _execute_with([{"source": "notes/a.md", "text": "内容A"}])
    )

    from app.core import engine_eval

    seen: dict = {}

    async def fake_judge(info, model, engine, topic, sources, produced, **kw):
        seen.update(engine=engine, topic=topic, n=len(sources), produced=produced)
        return 4, "每条都能在材料里找到依据"

    monkeypatch.setattr(engine_eval, "judge_grounded", fake_judge)

    task_id = await _add_task("带检索的任务")
    assert (await core.run_task(task_id, manual=True))["status"] == "ok"

    run = await _last_run()
    assert run.grounded == 4 and run.judge_reason == "每条都能在材料里找到依据"
    assert seen["engine"] == "task" and seen["n"] == 1
    assert seen["topic"] == "do 带检索的任务"  # 判分要看得懂任务问的是什么


async def test_run_without_material_gets_no_score(monkeypatch):
    """没开检索 / 检索没命中 → 没有尺子可量，不许编一个分出来。"""
    await _clear()
    await _add_providers("p1")
    monkeypatch.setattr(core, "_execute", _execute_with([]))

    from app.core import engine_eval

    called: list = []

    async def fake_judge(*a, **kw):
        called.append(1)
        return 5, ""

    monkeypatch.setattr(engine_eval, "judge_grounded", fake_judge)

    task_id = await _add_task("没检索的任务")
    assert (await core.run_task(task_id, manual=True))["status"] == "ok"

    assert (await _last_run()).grounded is None
    assert called == []  # 连一次判分调用都不该发生


async def test_judge_failure_does_not_fail_the_run(monkeypatch):
    """判分挂了不能让一次成功的运行变成失败——它是网，不是路。"""
    await _clear()
    await _add_providers("p1")
    monkeypatch.setattr(
        core, "_execute", _execute_with([{"source": "notes/a.md", "text": "内容A"}])
    )

    from app.core import engine_eval

    async def boom(*a, **kw):
        raise RuntimeError("判分模型挂了")

    monkeypatch.setattr(engine_eval, "judge_grounded", boom)

    task_id = await _add_task("判分挂了的任务")
    assert (await core.run_task(task_id, manual=True))["status"] == "ok"
    assert (await _last_run()).grounded is None


# ---------- 人工卡点（§4-12） ----------


async def _gate_run() -> TaskRun:
    async with SessionLocal() as db:
        return (
            await db.execute(select(TaskRun).where(TaskRun.status == core._GATE_STATUS))
        ).scalar_one()


async def _chain(a: int, b: int) -> None:
    async with SessionLocal() as db:
        (await db.get(ScheduledTask, a)).chain_next_id = b
        await db.commit()


async def test_gate_stops_before_downstream_until_approved(monkeypatch):
    """配了卡点：这一步跑完就停住——下游不许自己跑起来，直到人点头。"""
    monkeypatch.setattr(core, "_execute", _fake_execute)
    gates: list[str] = []

    async def record_gate(t: dict) -> None:
        gates.append(t["name"])

    monkeypatch.setattr(core, "_notify_gate", record_gate)

    a = await _add_task("人工审", require_approval=True)
    b_id = await _add_task("下游")
    await _chain(a, b_id)

    result = await core.run_task(a, trigger="cron")
    assert result["status"] == "ok" and result["awaiting_approval"] is True
    assert [c["name"] for c in CALLS] == ["人工审"]  # 下游没跑
    assert gates == ["人工审"]  # 卡点要响一声，不响它可能永远停在那儿

    run = await _gate_run()
    out = await core.review_gate(run.id, approve=True)
    assert out["approved"] is True and out["next_task_id"] == b_id
    await asyncio.gather(*list(core._BG_TASKS))  # 放行后下游在后台续跑
    assert [c["name"] for c in CALLS] == ["人工审", "下游"]


async def test_reject_ends_the_pipeline(monkeypatch):
    monkeypatch.setattr(core, "_execute", _fake_execute)
    async def quiet(t: dict) -> None:
        return None

    monkeypatch.setattr(core, "_notify_gate", quiet)

    a = await _add_task("人工审2", require_approval=True)
    b_id = await _add_task("下游2")
    await _chain(a, b_id)

    await core.run_task(a, trigger="cron")
    run = await _gate_run()
    out = await core.review_gate(run.id, approve=False)
    assert out["approved"] is False and out["next_task_id"] is None

    await asyncio.gather(*list(core._BG_TASKS))
    assert [c["name"] for c in CALLS] == ["人工审2"]  # 流程到此为止

    async with SessionLocal() as db:
        assert (await db.get(TaskRun, run.id)).status == "rejected"


async def test_a_run_can_only_be_reviewed_once(monkeypatch):
    """重复点、点错行都不该改变什么——只有停在待审的那一次能被审。"""
    monkeypatch.setattr(core, "_execute", _fake_execute)

    async def quiet(t: dict) -> None:
        return None

    monkeypatch.setattr(core, "_notify_gate", quiet)

    tid = await _add_task("人工审3", require_approval=True)
    await core.run_task(tid, trigger="cron")
    run = await _gate_run()

    assert (await core.review_gate(run.id, approve=True))["ok"] is True
    with pytest.raises(ValueError):
        await core.review_gate(run.id, approve=True)
    with pytest.raises(LookupError):
        await core.review_gate(run.id + 9999, approve=True)


async def test_task_without_the_gate_never_pauses(monkeypatch):
    """没配卡点的任务照旧一路跑完——卡点是 opt-in，不是新的默认。"""
    monkeypatch.setattr(core, "_execute", _fake_execute)
    a = await _add_task("无卡点")
    b_id = await _add_task("下游3")
    await _chain(a, b_id)

    result = await core.run_task(a, trigger="cron")
    assert result["awaiting_approval"] is False
    assert [c["name"] for c in CALLS] == ["无卡点", "下游3"]


# ---------- 会议闭环（§4-13） ----------


def _write_audio(rel: str) -> Path:
    p = _TMP / "vault" / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(b"\x00fake-audio")
    return p


def test_is_triggerable_accepts_audio_but_is_supported_does_not():
    """音频要能让 watcher 看见，但**不进索引**——这是两件事，所以是两个函数。"""
    from app.core import ingest

    assert ingest.is_triggerable(Path("meetings/inbox/周会.m4a"))
    assert ingest.is_triggerable(Path("notes/a.md"))
    assert not ingest.is_triggerable(Path("data.db"))
    assert not ingest.is_supported(Path("meetings/inbox/周会.m4a"))


async def test_transcribe_step_reads_the_triggering_recording(monkeypatch):
    """转写步骤：把触发它的那段录音交给本地 ASR（不走模型），成功后录音搬进会议文件夹。"""
    monkeypatch.setattr(core, "VAULT_DIR", _TMP / "vault")
    _write_audio("meetings/inbox/周会.m4a")

    from app.core import asr

    seen: list[str] = []

    def fake_transcribe(path, model_size="small", language=None):
        seen.append(path)
        return {"text": "大家好，今天聊三件事。", "language": "zh", "duration": 12.5}

    monkeypatch.setattr(asr, "transcribe", fake_transcribe)

    tid = await _add_task(
        "会议·转写", action="transcribe", landing_dir="meetings",
        trigger_kind="watch", watch_path="meetings/inbox", save_to_vault=True,
    )
    r = await core.run_task(tid, trigger="watch", watch_files=["meetings/inbox/周会.m4a"])

    assert r["status"] == "ok"
    assert seen and seen[0].endswith("周会.m4a")
    assert "今天聊三件事" in r["answer"]

    (meeting,) = (_TMP / "vault" / "meetings").glob("*-周会")
    assert (meeting / "audio.m4a").is_file()  # 原声跟着这一场走
    assert not (_TMP / "vault" / "meetings" / "inbox" / "周会.m4a").exists()  # 搬走，不是复制
    assert len(list(meeting.glob("会议·转写-*.md"))) == 1


async def test_recording_stays_put_when_transcription_fails(monkeypatch):
    """转写失败 → 录音留在 inbox 等人处置。搬文件只在成功之后，不赌。"""
    monkeypatch.setattr(core, "VAULT_DIR", _TMP / "vault")
    _write_audio("meetings/inbox/坏录音.m4a")

    from app.core import asr

    def boom(*a, **k):
        raise RuntimeError("解码失败")

    monkeypatch.setattr(asr, "transcribe", boom)

    tid = await _add_task(
        "会议·转写", action="transcribe", landing_dir="meetings", retry=0,
        trigger_kind="watch", watch_path="meetings/inbox", save_to_vault=True,
    )
    r = await core.run_task(tid, trigger="watch", watch_files=["meetings/inbox/坏录音.m4a"])

    assert r["status"] == "error"
    assert (_TMP / "vault" / "meetings" / "inbox" / "坏录音.m4a").is_file()
    assert not list((_TMP / "vault" / "meetings").glob("*-坏录音"))


async def test_run_dir_is_inherited_down_the_chain(monkeypatch):
    """四步写进**同一个**文件夹——那才是「同一场会议」，也是这条链的意义所在。"""
    monkeypatch.setattr(core, "VAULT_DIR", _TMP / "vault")
    _write_audio("meetings/inbox/周会.m4a")

    from app.core import asr

    monkeypatch.setattr(
        asr, "transcribe", lambda *a, **k: {"text": "转写正文", "language": "zh", "duration": 1.0}
    )

    real_execute = core._execute
    dirs: list[str] = []

    async def recording(t: dict, log_entries: list) -> dict:
        dirs.append(t.get("run_dir") or "")
        if (t.get("action") or "prompt") == "transcribe":
            return await real_execute(t, log_entries)
        return {"answer": f"{t['name']} 的产出", "sources": [], "model_id": "m", "rounds": 0, "tool_calls": 0}

    monkeypatch.setattr(core, "_execute", recording)

    a = await _add_task(
        "会议·转写", action="transcribe", landing_dir="meetings", save_to_vault=True,
        trigger_kind="watch", watch_path="meetings/inbox",
    )
    b = await _add_task("会议·纪要", landing_dir="meetings", save_to_vault=True, trigger_kind="chain")
    c = await _add_task("会议·待办", landing_dir="meetings", save_to_vault=True, trigger_kind="chain")
    await _chain(a, b)
    await _chain(b, c)

    assert (await core.run_task(a, trigger="watch", watch_files=["meetings/inbox/周会.m4a"]))["status"] == "ok"

    assert len(dirs) == 3 and len(set(dirs)) == 1 and dirs[0] != ""
    (meeting,) = (_TMP / "vault" / "meetings").glob("*-周会")
    # 转写 + 纪要 + 待办 全落在这一个文件夹里
    assert len(list(meeting.glob("*.md"))) == 3


async def test_meeting_preset_installs_four_linked_steps_and_is_idempotent(monkeypatch):
    monkeypatch.setattr(core, "VAULT_DIR", _TMP / "vault")
    monkeypatch.setattr(core, "reschedule", lambda: None)

    from app.routers import tasks as tasks_router

    monkeypatch.setattr(tasks_router, "VAULT_DIR", _TMP / "vault")

    async with SessionLocal() as db:
        out = await tasks_router.install_meeting_preset(db)
    assert out["created"] == 4
    assert [t["name"] for t in out["tasks"]] == ["会议·转写", "会议·纪要", "会议·待办", "会议·跟进短稿"]
    assert [t["trigger_kind"] for t in out["tasks"]] == ["watch", "chain", "chain", "chain"]
    assert [t["action"] for t in out["tasks"]] == ["transcribe", "prompt", "prompt", "prompt"]
    assert out["tasks"][0]["chain_next_id"] == out["tasks"][1]["id"]
    assert (_TMP / "vault" / "meetings" / "inbox").is_dir()  # 用户得知道录音丢哪

    async with SessionLocal() as db:
        again = await tasks_router.install_meeting_preset(db)
    assert again["created"] == 0 and len(again["tasks"]) == 4


# ---------- 工作 preset（工作线的三步工作流） ----------


async def test_work_preset_installs_three_linked_gated_steps_and_is_idempotent(monkeypatch):
    monkeypatch.setattr(core, "VAULT_DIR", _TMP / "vault")
    monkeypatch.setattr(core, "reschedule", lambda: None)

    from app.routers import tasks as tasks_router

    monkeypatch.setattr(tasks_router, "VAULT_DIR", _TMP / "vault")

    async with SessionLocal() as db:
        out = await tasks_router.install_work_preset(db)
    assert out["created"] == 3
    assert [t["name"] for t in out["tasks"]] == ["工作·调研", "工作·方案", "工作·汇报稿"]
    # 三步都不靠自动触发：chain 既不注册 cron 也不注册 watch，纯手动点火起链
    assert [t["trigger_kind"] for t in out["tasks"]] == ["chain", "chain", "chain"]
    assert [t["action"] for t in out["tasks"]] == ["research", "prompt", "prompt"]
    assert [t["landing_dir"] for t in out["tasks"]] == ["", "decisions", "deliver"]
    assert all(t["require_approval"] for t in out["tasks"])  # 每步跑完停下等人点头
    assert out["tasks"][0]["chain_next_id"] == out["tasks"][1]["id"]
    assert out["tasks"][1]["chain_next_id"] == out["tasks"][2]["id"]

    async with SessionLocal() as db:
        again = await tasks_router.install_work_preset(db)
    assert again["created"] == 0 and len(again["tasks"]) == 3


async def test_work_step_one_is_inert_to_both_trigger_engines():
    """第一步没有自己的触发源——不被 cron 注册，也不被 watch 拾取。"""
    async with SessionLocal() as db:
        from app.routers import tasks as tasks_router

        out = await tasks_router.install_work_preset(db)
    step1_id = out["tasks"][0]["id"]
    assert core.next_run(step1_id) is None  # 没上调度


async def test_topic_override_reaches_the_engine_and_leaves_the_template(monkeypatch):
    """运行期题目覆盖：到得了引擎，且**不动**行里的模板（preset 幂等因此不破）。"""
    monkeypatch.setattr(core, "reschedule", lambda: None)
    from app.routers import tasks as tasks_router

    async with SessionLocal() as db:
        out = await tasks_router.install_work_preset(db)
    step1_id = out["tasks"][0]["id"]
    template = out["tasks"][0]["prompt"]

    seen: list[str] = []

    async def fake_engine(t: dict, engine: str) -> dict:
        seen.append(t.get("prompt") or "")
        return {"answer": "ok", "sources": [], "model_id": "engine:research", "saved": {"filename": "research/x.md"}}

    monkeypatch.setattr(core, "_execute", fake_engine)
    await core.run_task(step1_id, manual=True, topic="季度规划")

    assert seen == ["季度规划"]
    async with SessionLocal() as db:
        row = await db.get(ScheduledTask, step1_id)
    assert row.prompt == template  # 模板原封不动


async def test_run_now_accepts_a_topic_body_or_none(monkeypatch):
    monkeypatch.setattr(core, "reschedule", lambda: None)
    from app.routers import tasks as tasks_router

    async with SessionLocal() as db:
        out = await tasks_router.install_work_preset(db)
    step1_id = out["tasks"][0]["id"]

    captured: list[str] = []

    async def fake_run_task(task_id, **kw):
        captured.append(kw.get("topic", ""))
        return {"status": "ok"}

    monkeypatch.setattr(core, "run_task", fake_run_task)
    async with SessionLocal() as db:
        assert (await tasks_router.run_now(step1_id, tasks_router.RunIn(topic="X"), db))["status"] == "ok"
        assert (await tasks_router.run_now(step1_id, None, db))["status"] == "ok"
    assert captured == ["X", ""]  # 不给 body 时 topic 为空，不炸


async def test_chain_step_landing_dir_overrides_inherited_run_dir(monkeypatch):
    """下游自带另一个基地时不继承上游落点——否则汇报稿会跟着方案落进 decisions/。"""
    monkeypatch.setattr(core, "_execute", _fake_execute)
    monkeypatch.setattr(core, "VAULT_DIR", _TMP / "vault")

    a = await _add_task("起点", landing_dir="")
    b = await _add_task("方案", landing_dir="decisions", save_to_vault=True)
    c = await _add_task("汇报", landing_dir="deliver", save_to_vault=True)
    await _chain(a, b)
    await _chain(b, c)

    assert (await core.run_task(a, manual=True))["status"] == "ok"
    await asyncio.gather(*list(core._BG_TASKS))

    vault = _TMP / "vault"
    assert len(list((vault / "decisions").glob("*.md"))) == 1
    assert len(list((vault / "deliver").glob("*.md"))) == 1
    assert not (vault / "deliver").samefile(vault / "decisions")


# ---------- 产出引擎上调度（§15） ----------


async def _add_engine_task(name: str, engine: str, *, prompt: str | None = None, **kw) -> int:
    """建一个「这一步跑引擎」的任务。prompt 就是引擎的话题（recap 不看它）。"""
    async with SessionLocal() as db:
        row = ScheduledTask(
            name=name,
            prompt=prompt if prompt is not None else f"do {name}",
            cron="0 9 * * *",
            action=engine,
            **kw,
        )
        db.add(row)
        await db.commit()
        await db.refresh(row)
        return row.id


async def _last_run_row() -> TaskRun:
    async with SessionLocal() as db:
        return (
            await db.execute(select(TaskRun).order_by(TaskRun.id.desc()).limit(1))
        ).scalar_one()


async def test_engine_action_runs_the_engine_and_lands_at_its_own_dir(monkeypatch):
    """「产出半边接上调度」：到点不再只跑提示词，而是把一个引擎跑一遍。落点由引擎
    自己的 `save()` 决定——产出进 notes/，**不**被再抄一份进 tasks/。"""
    from app.core import compose as engine_mod

    async def fake_run(topic):
        assert topic == "do 每周产出"  # 任务指令就是引擎的话题
        yield "gathering", {}
        yield "report", {
            "title": "手机换不换",
            "sections": [{"heading": "结论", "body": "再等一代"}],
            "used": [],
            "sources": [],
        }

    saved_seen: dict = {}

    async def fake_save(rep, sources):
        saved_seen["title"] = rep.title
        return {"filename": "notes/2026-09-13-手机换不换.md", "title": rep.title, "chunks": 2}

    monkeypatch.setattr(engine_mod, "run", fake_run)
    monkeypatch.setattr(engine_mod, "save", fake_save)

    async def boom(*a, **k):  # 引擎已经落了盘，就不该再往 tasks/ 抄一份
        raise AssertionError("_write_vault 不该在引擎任务里跑")

    monkeypatch.setattr(core, "_write_vault", boom)

    tid = await _add_engine_task("每周产出", "compose", save_to_vault=True)
    r = await core.run_task(tid, manual=True)

    assert r["status"] == "ok"
    assert r["vault_file"] == "notes/2026-09-13-手机换不换.md"
    assert saved_seen["title"] == "手机换不换"
    run = await _last_run_row()
    assert "手机换不换" in run.answer and "notes/2026-09-13-手机换不换.md" in run.answer


async def test_recap_engine_is_driven_without_a_topic(monkeypatch):
    """复盘不看话题——它把「最近几天」合成一份，自成文即落盘（发 saved，不走 report）。"""
    from app.core import recap as engine_mod

    async def fake_run(*a, **k):
        assert a == ()  # 不给它话题
        yield "gathering", {}
        yield "saved", {"filename": "recap/2026-09-13.md", "title": "9 月 13 日", "chunks": 3}

    monkeypatch.setattr(engine_mod, "run", fake_run)

    tid = await _add_engine_task("每天复盘", "recap")
    r = await core.run_task(tid, manual=True)
    assert r["status"] == "ok"
    assert r["vault_file"] == "recap/2026-09-13.md"


async def test_engine_without_a_topic_fails_with_a_readable_reason(monkeypatch):
    tid = await _add_engine_task("没话题", "research", prompt="")
    r = await core.run_task(tid, manual=True)
    assert r["status"] == "error"
    assert "话题" in r["error"]


async def test_engine_error_event_becomes_a_failed_run(monkeypatch):
    """引擎把「没取到材料」变成一条 error 事件——任务照实记成失败，不假装成功。"""
    from app.core import compose as engine_mod

    async def fake_run(topic):
        yield "error", {"message": "你自己的材料里没找到相关内容"}

    monkeypatch.setattr(engine_mod, "run", fake_run)

    tid = await _add_engine_task("没材料", "compose")
    r = await core.run_task(tid, manual=True)
    assert r["status"] == "error"
    assert "没找到相关内容" in r["error"]


def test_engine_actions_and_router_agree():
    """后端认的引擎名，和 core 里列的那几个，是同一个集合——不然表单能选却存不进去。"""
    from app.routers.tasks import _VALID_ACTIONS

    assert set(core.ENGINE_ACTIONS) <= set(_VALID_ACTIONS)
    assert core.ENGINE_LABELS.keys() == set(core.ENGINE_ACTIONS)
    import pydantic

    from app.routers.tasks import TaskIn

    for eng in core.ENGINE_ACTIONS:
        assert TaskIn(name="n", prompt="p", action=eng).action == eng
    with pytest.raises(pydantic.ValidationError):
        TaskIn(name="n", prompt="p", action="nope")
