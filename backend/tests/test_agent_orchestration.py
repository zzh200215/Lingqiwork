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
from app.models import (  # noqa: E402
    Base,
    Conversation,
    Message,
    ScheduledTask,
    TaskRun,
    Thread,
    ThreadItem,
)
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
    # 「一件事」（M2）也在清理之列：工作链起链会建一条，而这件事**跨用例可见**——
    # 漏了它，后一条用例会「捡到」前一条留下的同名的那件事（实测就是这么串的味）。
    async with SessionLocal() as db:
        for model in (ThreadItem, TaskRun, Message, Conversation, Thread, ScheduledTask):
            await db.execute(delete(model))
        await db.commit()


async def _add_task(name: str, **kw) -> int:
    async with SessionLocal() as db:
        row = ScheduledTask(name=name, prompt=f"do {name}", cron="0 9 * * *", **kw)
        db.add(row)
        await db.commit()
        await db.refresh(row)
        return row.id


def _point_vault(monkeypatch) -> Path:
    """把「vault 在哪」这件事在三个模块里说成同一个答案。

    `core.tasks` / `core.threads` / `core.pet` 各持一份 `VAULT_DIR`：M2 的自动挂接要按它
    判断「这份成品在不在产出目录里」，环二的台词要按它**数**架子上有几份成品——
    两边一旦分叉，挂接会**安静地什么都不做**、台词会数到别处去。产品里只有一个 vault
    （几份常量同源），所以这里如实同指；指成一个不存在的目录就等于偷偷把这条规矩关掉。
    """
    from app.core import pet as pet_core
    from app.core import threads as th

    vault = _TMP / "vault"
    monkeypatch.setattr(core, "VAULT_DIR", vault)
    monkeypatch.setattr(core, "TASK_DIR", vault / "tasks")
    monkeypatch.setattr(th, "VAULT_DIR", vault)
    monkeypatch.setattr(pet_core, "VAULT_DIR", vault)
    return vault


@pytest.fixture(autouse=True)
def _env(monkeypatch):
    core.HANDOFF_DIR = _TMP / "handoff"
    # 落点写在**项目的 scratch** 里（`_write_vault` 读的是模块级 `TASK_DIR / VAULT_DIR`，
    # 而 `threads` 自己那份 `VAULT_DIR` 也要跟着指过来，否则「这份成品在不在产出目录里」
    # 会按另一个 vault 去算）。真 sandbox 的 vault 由 conftest 管，两边都写就串了。
    monkeypatch.setattr(core, "VAULT_DIR", _TMP / "vault")
    monkeypatch.setattr(core, "TASK_DIR", _TMP / "vault" / "tasks")
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


async def test_the_gate_reply_is_spoken(monkeypatch):
    """Z2（PLAN4）：你点了头 / 驳回之后，零柒各说一句——**就在那一刻**。

    在这之前是「等你有声，抵达无声」：等你点头那条是气泡第一优先级，点完却一个字都没有
    （`KINDS` 里连一个 gate kind 都没有）。这一条同时钉住「不等下游跑完才开口」。
    """
    from app.core import pet

    monkeypatch.setattr(core, "_execute", _fake_execute)

    async def quiet(t: dict) -> None:
        return None

    monkeypatch.setattr(core, "_notify_gate", quiet)

    tid = await _add_task("人工审话", require_approval=True)
    await core.run_task(tid, trigger="cron")
    run = await _gate_run()
    await core.review_gate(run.id, approve=True)
    await asyncio.gather(*list(core._BG_TASKS))

    line = pet.feed(limit=5)[0]
    assert line["kind"] == "gate_ok"
    assert "人工审话" in line["text"]


async def test_the_rejected_reply_is_neutral(monkeypatch):
    from app.core import pet

    monkeypatch.setattr(core, "_execute", _fake_execute)

    async def quiet(t: dict) -> None:
        return None

    monkeypatch.setattr(core, "_notify_gate", quiet)

    tid = await _add_task("人工审话2", require_approval=True)
    await core.run_task(tid, trigger="cron")
    run = await _gate_run()
    await core.review_gate(run.id, approve=False)

    line = pet.feed(limit=5)[0]
    assert line["kind"] == "gate_rejected"
    assert "人工审话2" in line["text"]
    for word in ("哼", "可惜", "再想想", "错误"):
        assert word not in line["text"], word


async def test_a_silent_pet_stays_silent_on_the_gate(monkeypatch):
    """宠物关着 → 一个字都不说（emit 的三道闸门之一，这里只是验它真的过那道闸）。"""
    from app.core import pet
    from app.core.prefs import save_config

    monkeypatch.setattr(core, "_execute", _fake_execute)

    async def quiet(t: dict) -> None:
        return None

    monkeypatch.setattr(core, "_notify_gate", quiet)

    tid = await _add_task("人工审话3", require_approval=True)
    await core.run_task(tid, trigger="cron")
    run = await _gate_run()
    before = len(pet.feed(limit=100))
    save_config({"pet_enabled": False})
    try:
        await core.review_gate(run.id, approve=True)
        await asyncio.gather(*list(core._BG_TASKS))
        assert len(pet.feed(limit=100)) == before
    finally:
        save_config({"pet_enabled": True})


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
    """在当前 vault 里放一段假录音。

    路径从 `core.VAULT_DIR` 取（不是写死 `_TMP/vault`）：`_fake_vault` 会把 vault
    指到**每条用例一份**的目录，写死的话录音会写进一条早就不存在的路径，
    而症状是「音频不在了」——看着像产品 bug，其实是测试自己走岔了。
    """
    p = core.VAULT_DIR / rel
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
    # 转写 + 纪要 + 待办 全落在这一个文件夹里。
    # **不数总数**（2026-09-17 修）：文件名带「分钟」（`_write_vault` 的 `%Y-%m-%d-%H%M`），
    # 而上面那条 `test_transcribe_step_reads_the_triggering_recording` 也往**同一个**文件夹写一份
    # 「会议·转写」。两条用例落在同一分钟里时后者被覆盖、总数是 3；**跨过一分钟边界**时
    # 前一份留着，总数就成了 4——全量里就这么挂过一次（单跑永远同分钟，所以查不出来）。
    # 这一条要守的是「三个见证都在这一个文件夹里」，不是「文件夹里正好三个文件」。
    names = {p.name.split("-")[0] for p in meeting.glob("*.md")}
    assert {"会议·转写", "会议·纪要", "会议·待办"} <= names, names


# ---------- 语音进料（R2 · PLAN5 §3） ----------
#
# 与上面会议那一条**故意是两套行为**：会议要留着原声（后面几步拿它当原料），
# 语音备忘只留文本、转写完就把录音删掉。这两条测试并排放，谁改了另一种语义一眼能看见。


def _fake_vault(monkeypatch) -> Path:
    """把 vault 指到**这一条用例自己的**临时目录，两个名字一起指。

    ⚠️ 两个坑，各踩过一次：

    1. `tasks.VAULT_DIR` 与 `voice_note.VOICE_DIR` 是两个独立的名字：只 monkeypatch
       前者的话，`_transcribe_note` 按假 vault 找录音，而 `voice_note.write_note` 照样
       往**真** vault 里写——断言在假 vault 里永远找不到文件，文件却落到了别处。
       （这个仓库在 `turn_quality` 那里为同一个坑付过一次代价。）
    2. 目录要**每条用例一份**：本文件共用模块级的 `_TMP`，若都往 `_TMP/vault/voice` 写，
       上一条用例落下的 md 会被下一条看见——于是「失败时不该有文件」这种断言
       会因为别人留下的文件而挂，且**顺序一变就换个姿势挂**。
    """
    from uuid import uuid4

    from app.core import voice_note

    vault = _TMP / f"vault-{uuid4().hex[:8]}"
    monkeypatch.setattr(core, "VAULT_DIR", vault)
    monkeypatch.setattr(voice_note, "VOICE_DIR", vault / "voice")
    return vault


async def test_transcribe_note_writes_a_note_and_deletes_the_recording(monkeypatch):
    """R2 的主路径：录音 → `vault/voice/` 一份 md → **原录音删掉**。

    只留文本是这个功能的**决定**（2026-09-18）：原音频比文本大两个数量级，
    留着只会让 vault 里堆一堆没人再听的东西。所以这条测试一半在验「文本落了」，
    另一半在验「音频没了」——少验一半，功能就悄悄变成了「复制一份」。
    """
    vault = _fake_vault(monkeypatch)
    _write_audio("voice/inbox/随手记.m4a")

    from app.core import asr

    def fake_transcribe(path, model_size="small", language=None):
        return {"text": "记一下：周五之前把报价发出去。", "language": "zh", "duration": 6.0}

    monkeypatch.setattr(asr, "transcribe", fake_transcribe)

    tid = await _add_task(
        "语音备忘", action="transcribe_note",
        trigger_kind="watch", watch_path="voice/inbox", save_to_vault=False,
    )
    r = await core.run_task(tid, trigger="watch", watch_files=["voice/inbox/随手记.m4a"])

    assert r["status"] == "ok", r
    assert "周五之前把报价发出去" in r["answer"]

    (note,) = (vault / "voice").glob("*.md")
    body = note.read_text(encoding="utf-8")
    # H1 是**拼出来**的（不含模型）：验收要求「一分钟内看到文本」，多一次生成就过不了线
    assert body.startswith("# 语音备忘 ")
    assert "周五之前把报价发出去" in body
    # 文件名也是算出来的：日期-时分，不含原音频名（原音频名可能是 IMG_2043 这种）
    assert note.name.endswith(".md") and "随手记" not in note.name
    assert body.count("> 来源") == 1 and "voice/inbox/随手记.m4a" in body

    # **录音删掉了**，而且不是搬走（会议那一条是搬走）
    assert not (vault / "voice" / "inbox" / "随手记.m4a").exists()
    assert not list((vault / "voice").rglob("*.m4a"))

    # 回执指向落盘的那一份（工作页/回执靠它）
    assert r["vault_file"] == f"voice/{note.name}"


async def test_voice_note_stays_put_when_transcription_fails(monkeypatch):
    """转写失败 → 录音留在原地，**一个字节都不动**。先删后转就等于把原料烧了。"""
    vault = _fake_vault(monkeypatch)
    audio = _write_audio("voice/inbox/坏录音.m4a")

    from app.core import asr

    def boom(*a, **k):
        raise RuntimeError("解码失败")

    monkeypatch.setattr(asr, "transcribe", boom)

    tid = await _add_task(
        "语音备忘", action="transcribe_note", retry=0,
        trigger_kind="watch", watch_path="voice/inbox", save_to_vault=False,
    )
    r = await core.run_task(tid, trigger="watch", watch_files=["voice/inbox/坏录音.m4a"])

    assert r["status"] == "error"
    assert audio.is_file()
    assert not list((vault / "voice").glob("*.md"))


async def test_empty_transcription_writes_nothing_and_keeps_the_recording(monkeypatch):
    """空转写不算成功：不写一份「搜得到、点开什么都没有」的产出，也不删录音。"""
    vault = _fake_vault(monkeypatch)
    audio = _write_audio("voice/inbox/静音.m4a")

    from app.core import asr

    monkeypatch.setattr(asr, "transcribe", lambda *a, **k: {"text": "   ", "language": "zh"})

    tid = await _add_task(
        "语音备忘", action="transcribe_note", retry=0,
        trigger_kind="watch", watch_path="voice/inbox", save_to_vault=False,
    )
    r = await core.run_task(tid, trigger="watch", watch_files=["voice/inbox/静音.m4a"])

    assert r["status"] == "error"
    assert audio.is_file()
    assert not list((vault / "voice").glob("*.md"))


async def test_the_meeting_path_still_keeps_its_audio(monkeypatch):
    """**反向钉子**：加了 `transcribe_note` 之后，会议那条路一个字节都没变。

    两条路共用一个 helper 的那天，最可能发生的事就是「顺手把删音频也带上」——
    于是会议链的第二步没有原声可用了，而那是四步链条的前提。
    """
    _fake_vault(monkeypatch)
    _write_audio("meetings/inbox/周会.m4a")

    from app.core import asr

    monkeypatch.setattr(asr, "transcribe", lambda *a, **k: {"text": "转写正文", "language": "zh"})

    tid = await _add_task(
        "会议·转写", action="transcribe", landing_dir="meetings", save_to_vault=True,
        trigger_kind="watch", watch_path="meetings/inbox",
    )
    r = await core.run_task(tid, trigger="watch", watch_files=["meetings/inbox/周会.m4a"])

    assert r["status"] == "ok"
    (meeting,) = (core.VAULT_DIR / "meetings").glob("*-周会")
    assert (meeting / "audio.m4a").is_file()  # 原声还在，而且搬进了这一场


def test_voice_note_filenames_are_derived_not_generated():
    """文件名与 H1 **都是算出来的**：同一分钟两次 → 第二份带 `-2`，**不覆盖**。

    覆盖就等于丢了一份已经转写好的原文（那是这里唯一值钱的东西）。
    """
    from datetime import datetime

    from app.core import voice_note

    now = datetime(2026, 9, 18, 14, 30, 5)
    assert voice_note._title(now) == "语音备忘 2026-09-18 14:30"
    assert voice_note._pick_path(now).name == "2026-09-18-1430.md"


def test_voice_preset_is_a_one_step_watch_not_a_chain(monkeypatch):
    """`/api/tasks/preset/voice`：**一步**监听 `voice/inbox`，用 `transcribe_note`，幂等。

    与会议 preset 的关键差别都在这条测试里：会议是四步链 + `transcribe`（留原声），
    这条是一步 + `transcribe_note`（只留文本）。装错 action 的话，丢进去的录音
    会被搬进一个没人看的目录里——功能看着"成功"，其实什么也没留下。
    """
    import asyncio as _asyncio

    _fake_vault(monkeypatch)
    monkeypatch.setenv("WB_API_TOKEN", "t")
    from fastapi.testclient import TestClient

    from app.core import auth
    from app.main import app

    monkeypatch.setattr(auth, "_cached", None)
    c = TestClient(app)
    h = {"X-WB-Token": "t"}

    async def _make() -> None:
        async with SessionLocal() as db:
            await db.execute(delete(ScheduledTask))
            await db.commit()

    _asyncio.run(_make())

    assert c.post("/api/tasks/preset/voice").status_code == 401

    r = c.post("/api/tasks/preset/voice", headers=h).json()
    assert r["created"] == 1
    (task,) = r["tasks"]
    assert task["name"] == "语音备忘"
    assert task["action"] == "transcribe_note"  # ← 不是 "transcribe"
    assert task["trigger_kind"] == "watch"
    assert task["watch_path"] == "voice/inbox"
    assert task["chain_next_id"] is None  # 一步，没有下游
    # 落点由 `voice_note` 自己算，所以不经 tasks/ 抄一份
    assert not task["save_to_vault"]

    # 幂等：再点一次不装第二遍
    again = c.post("/api/tasks/preset/voice", headers=h).json()
    assert again["created"] == 0
    assert len(again["tasks"]) == 1

    (core.VAULT_DIR / "voice" / "inbox").is_dir()  # 目录建好了（丢录音的地方）


def test_the_voice_note_module_has_no_way_to_speak():
    """红线：写语音备忘不经过零柒的嘴——`voice_note` 一行 `pet.*` 都不许有。

    通知那件事由 `tasks.run_task` 统一做（跑完一句 `task_done`），
    写盘的人不另开口子（与 `journal` / `metrics` 同一条纪律）。
    """
    import re
    from pathlib import Path

    from app.core import voice_note

    src = Path(voice_note.__file__).read_text(encoding="utf-8")
    assert re.findall(r"\bpet\.(\w+)", src) == []


# --- 那一问：这份语音备忘归到哪儿（R2 · PLAN5 §3）-------------------------------


def _voice_note_file(monkeypatch, when, text="记一下：周五之前把报价发出去。"):
    """在假 vault 里落一份语音备忘，返回它的 vault 相对路径。"""
    from app.core import voice_note

    return voice_note.write_note(text, source="voice/inbox/x.m4a", now=when)["path"]


async def test_pending_lists_a_note_until_it_is_answered(monkeypatch):
    """那一问是**拉取式**的：刚落的备忘在单子上，回答了才下去。"""
    from datetime import datetime

    from app.core import voice_note

    _fake_vault(monkeypatch)
    path = _voice_note_file(monkeypatch, datetime(2026, 9, 18, 8, 1))
    out = await voice_note.pending()
    assert out["readable"] is True and out["error"] == ""
    assert [i["path"] for i in out["open"]] == [path]
    assert out["open"][0]["title"] == "语音备忘 2026-09-18 08:01"
    assert out["counts"] == {"total": 1, "material": 0, "thread": 0, "open": 1}
    for key in ("pull", "material", "thread", "state"):
        assert out["rules"][key]


async def test_a_digest_point_takes_it_off_the_question(monkeypatch):
    """「当材料」的痕就是 `digest_points.source`——有痕就不再问第二遍。

    判据刻意用**既有那条路上的痕**：新增一列「归类状态」等于把同一件事记两遍，
    而两处迟早会给出两个答案（§4-7）。
    """
    from datetime import datetime

    from app.core import voice_note
    from app.models import DigestPoint

    _fake_vault(monkeypatch)
    path = _voice_note_file(monkeypatch, datetime(2026, 9, 18, 8, 2))
    async with SessionLocal() as db:
        db.add(DigestPoint(source=path, point="报价要提前几天发", why=""))
        await db.commit()
    try:
        out = await voice_note.pending()
        assert out["open"] == []
        assert out["counts"] == {"total": 1, "material": 1, "thread": 0, "open": 0}
    finally:
        async with SessionLocal() as db:
            await db.execute(delete(DigestPoint).where(DigestPoint.source == path))
            await db.commit()


async def test_attaching_it_to_a_thread_takes_it_off_the_question(monkeypatch):
    """「工作留痕」的痕就是 `thread_items.ref`——挂事是引用，不搬内容。"""
    from datetime import datetime

    from app.core import voice_note

    _fake_vault(monkeypatch)
    path = _voice_note_file(monkeypatch, datetime(2026, 9, 18, 8, 3))
    async with SessionLocal() as db:
        db.add(ThreadItem(thread_id=999001, kind="note", ref=path))
        await db.commit()
    try:
        out = await voice_note.pending()
        assert out["open"] == []
        assert out["counts"] == {"total": 1, "material": 0, "thread": 1, "open": 0}
    finally:
        async with SessionLocal() as db:
            await db.execute(delete(ThreadItem).where(ThreadItem.ref == path))
            await db.commit()


async def test_pending_says_so_when_it_cannot_read(monkeypatch):
    """§4-8：**读不到 ≠ 「都归类完了」**——那是这一格最不该说错的一句话。"""
    from app.core import voice_note

    _fake_vault(monkeypatch)

    async def boom():
        raise RuntimeError("db down")

    monkeypatch.setattr(voice_note, "_answered", boom)
    out = await voice_note.pending()
    assert out["readable"] is False
    assert "db down" in out["error"]
    assert out["open"] == []  # 空是因为没读到，不是因为答完了——靠 readable 区分


async def test_asking_the_question_makes_the_pet_say_nothing(monkeypatch):
    """红线：那一问是**拉取式**的——看一眼单子不该让零柒冒一句话出来，也不该进 nudge。"""
    from datetime import datetime

    from app.core import pet as pet_core
    from app.core import voice_note

    _fake_vault(monkeypatch)
    _voice_note_file(monkeypatch, datetime(2026, 9, 18, 8, 4))
    before = pet_core.feed(limit=50)
    await voice_note.pending()
    assert pet_core.feed(limit=50) == before


def test_http_voice_notes_endpoint(monkeypatch):
    """笔记页读的那一格走 `/api/notes/voice`（R2 的「那一问」）。"""
    from datetime import datetime

    _fake_vault(monkeypatch)
    _voice_note_file(monkeypatch, datetime(2026, 9, 18, 8, 6))
    monkeypatch.setenv("WB_API_TOKEN", "t")
    from fastapi.testclient import TestClient

    from app.core import auth
    from app.main import app

    monkeypatch.setattr(auth, "_cached", None)
    c = TestClient(app)
    h = {"X-WB-Token": "t"}

    assert c.get("/api/notes/voice").status_code == 401
    body = c.get("/api/notes/voice", headers=h).json()
    assert body["readable"] is True
    assert body["counts"]["open"] == 1
    assert "pull" in body["rules"]


def test_thread_name_for_run_dir_only_for_per_instance_dirs():
    """M5：只有「一场一场落目录」的流程才自带一件「事」的名字，而且必须正好两层。

    `meetings/inbox` 不是一场会议、`meetings/a/b` 是更深的中间目录、`tasks/…` 是运行留痕
    ——一律没有名字（没有名字来源就不硬安一个）。
    """
    assert core.thread_name_for_run_dir("meetings/2026-09-13-周会") == "2026-09-13-周会"
    assert core.thread_name_for_run_dir("meetings/inbox") == ""
    assert core.thread_name_for_run_dir("meetings/a/b") == ""
    assert core.thread_name_for_run_dir("tasks/x") == ""
    assert core.thread_name_for_run_dir("deliver") == ""
    assert core.thread_name_for_run_dir("") == ""
    assert core.thread_name_for_run_dir("meetings/  ") == ""
    # 「inbox 不是一场会议」这件事三处都说了（这里 / 作品目录判据 / 会议列表），
    # 所以词也得是同一个——改了一边而没改另一边，三处就开始各说各话。
    from app.core import threads

    assert core.MEETING_INBOX == threads._MEETING_INBOX  # noqa: SLF001


async def test_a_meeting_lands_its_conclusions_on_a_thread_named_after_it(monkeypatch):
    """M5「会议结论进主线」：一场会议的产物挂到一条以**会议名**命名的「一件事」上。

    在这之前 `meetings` 不在成品目录里（`threads.PRODUCT_DIRS`），而会议链也没有 `thread_id`
    ——「名字来源」那一栏一直是空的，于是纪要/待办/短稿落进文件夹之后就再没人看第二眼。
    现在名字来自落点目录（`meetings/<日期>-<录音名>` 那一段），产物自动挂上去。
    """
    monkeypatch.setattr(core, "VAULT_DIR", _TMP / "vault")
    _write_audio("meetings/inbox/周会.m4a")

    from app.core import asr

    monkeypatch.setattr(
        asr, "transcribe", lambda *a, **k: {"text": "转写正文", "language": "zh", "duration": 1.0}
    )

    real_execute = core._execute

    async def fake(t: dict, log_entries: list) -> dict:
        if (t.get("action") or "prompt") == "transcribe":
            return await real_execute(t, log_entries)
        return {
            "answer": f"{t['name']} 的产出", "sources": [], "model_id": "m", "rounds": 0, "tool_calls": 0,
        }

    monkeypatch.setattr(core, "_execute", fake)

    a = await _add_task(
        "会议·转写", action="transcribe", landing_dir="meetings", save_to_vault=True,
        trigger_kind="watch", watch_path="meetings/inbox",
    )
    b = await _add_task("会议·纪要", landing_dir="meetings", save_to_vault=True, trigger_kind="chain")
    c = await _add_task("会议·待办", landing_dir="meetings", save_to_vault=True, trigger_kind="chain")
    await _chain(a, b)
    await _chain(b, c)

    assert (await core.run_task(a, trigger="watch", watch_files=["meetings/inbox/周会.m4a"]))["status"] == "ok"
    await asyncio.gather(*list(core._BG_TASKS))

    async with SessionLocal() as db:
        thread_rows = (await db.execute(select(Thread))).scalars().all()
        items = (await db.execute(select(ThreadItem))).scalars().all()
    assert len(thread_rows) == 1, "一场会议只该有一条「事」"
    assert thread_rows[0].name.endswith("-周会")
    assert len(items) == 3 and all(i.kind == "output" for i in items)
    assert all(i.ref.startswith("meetings/") and "/inbox/" not in i.ref for i in items)


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


# ---------- 产物挂到一条「一件事」（M2，docs/work-module.md） ----------


async def _attached(thread_id: int) -> list[str]:
    from app.models import ThreadItem

    async with SessionLocal() as db:
        rows = (
            await db.execute(select(ThreadItem).where(ThreadItem.thread_id == thread_id))
        ).scalars().all()
    return [r.ref for r in rows]


def _fake_engine(vault: Path, filename: str):
    """假引擎：真写一个文件、真报它的落点（照引擎自己的 `save()` 那份回执）。

    只是把「模型写正文」那一步换成常量文本 —— **落盘这件事不假装**，因为 M2 的挂接
    正是由这一行决定的。
    """
    from app.core import research as engine_mod

    async def fake_run(topic):
        yield "report", {
            "title": topic,
            "sections": [{"heading": "结论", "body": "B"}],
            "used": [],
            "sources": [],
        }

    async def fake_save(rep, sources):
        p = vault / filename
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(f"# {rep.title}\n", encoding="utf-8")
        return {"filename": filename, "title": rep.title, "chunks": 1}

    engine_mod.run = fake_run
    engine_mod.save = fake_save


def _fake_saved_execute(filename: str):
    """假 `_execute`：**引擎那一步照旧走真路**，只有提示词步被换成常量文本。

    为什么引擎那一步不能一起假掉：M2 的挂接认的是「引擎自己报的落点」
    （`_run_engine` 把 `saved.filename` 当 `vault_file`），把它也换成假函数，
    测的就成了 stub 自己 —— 实测踩过一次：产物落进了 `tasks/`，断言却以为它在
    `research/`，而两边都是假的。
    """
    from app.core.tasks import ENGINE_ACTIONS

    async def _execute(t: dict, log_entries: list) -> dict:
        action = t.get("action") or "prompt"
        if action in ENGINE_ACTIONS:
            return await core._run_engine(t, action)  # noqa: SLF001
        return {
            "answer": f"result-of-{t['name']}",
            "sources": [],
            "model_id": "test/model",
            "rounds": 2,
            "tool_calls": 3,
        }

    return _execute


async def test_work_chain_products_land_on_one_thread(monkeypatch):
    """一条工作链 = 一件事：三步的成品挂的都是它，而谁都不必自己去查「这件事叫什么」。

    真链条全程：第一步跑引擎（`research.run` / `research.save` 换成假引擎，**落盘不假**），
    过了卡点之后由 `review_gate` → `_fire_chain` 一路把「这件事」传下去。
    """
    from app.core import threads as th

    vault = _point_vault(monkeypatch)
    monkeypatch.setattr(core, "reschedule", lambda: None)
    _fake_engine(vault, "research/2026-09-20-选型.md")
    monkeypatch.setattr(core, "_execute", _fake_saved_execute("ignored.md"))

    from app.routers import tasks as tasks_router

    async with SessionLocal() as db:
        preset = await tasks_router.install_work_preset(db)
        thread = await th.resolve("要不要上向量库")
        step1 = preset["tasks"][0]["id"]
        row = await db.get(ScheduledTask, step1)
        row.thread_id = thread["id"]
        await db.commit()

    assert thread["created"] is True
    # 三步的落点各不相同：research/（引擎自己）→ decisions/ → deliver/
    assert [t["landing_dir"] for t in preset["tasks"]] == ["", "decisions", "deliver"]

    # 第一步：引擎那条真路，产物落 research/ 并挂上
    r1 = await core.run_task(step1, manual=True, topic="要不要上向量库")
    assert r1["status"] == "ok" and r1["thread_id"] == thread["id"]
    assert r1["vault_file"] == "research/2026-09-20-选型.md"
    assert await _attached(thread["id"]) == ["research/2026-09-20-选型.md"]

    # 每一步跑完都停在卡点上，由你放行——「这件事」必须过得了卡点（M2 的关键一跳）
    for _ in range(2):
        async with SessionLocal() as db:
            gated = (
                await db.execute(
                    select(TaskRun)
                    .where(TaskRun.status == "awaiting_approval")
                    .order_by(TaskRun.id.desc())
                    .limit(1)
                )
            ).scalar_one()
        assert (await core.review_gate(gated.id, True))["approved"] is True
        await asyncio.gather(*list(core._BG_TASKS))

    # 三步三份成品，都在这件事上；`tasks/` 里的运行留痕一份都不算
    # （`glob` 会连别的用例留下的文件一起捞进来——这个模块的 scratch vault 只在模块开始时清一次）
    refs = await _attached(thread["id"])
    assert set(refs) == {
        "research/2026-09-20-选型.md",
        f"decisions/{max((vault / 'decisions').glob('*.md'), key=lambda p: p.stat().st_mtime).name}",
        f"deliver/{max((vault / 'deliver').glob('*.md'), key=lambda p: p.stat().st_mtime).name}",
    }
    assert len(refs) == 3
    # 落点也在它们该在的地方：`tasks/` 里一份影子副本都没有（那是没人找得到的第二份真值）
    assert not list((vault / "tasks").glob("*.md"))


async def test_attachment_is_idempotent_across_two_runs(monkeypatch):
    """同一份产物再跑一遍还是同一条引用——「跑两次」不该让这件事上多出重复条目。"""
    from app.core import threads as th

    _point_vault(monkeypatch)

    async def fake_execute(t: dict, log_entries: list) -> dict:
        return {
            "answer": "A",
            "sources": [],
            "model_id": "test/model",
            "rounds": 1,
            "tool_calls": 0,
            "saved": {"filename": "deliver/2026-09-20-汇报.md"},
        }

    monkeypatch.setattr(core, "_execute", fake_execute)

    thread = await th.resolve("选型")
    tid = await _add_task("跑两次", landing_dir="deliver", thread_id=thread["id"])
    await core.run_task(tid, manual=True)
    await core.run_task(tid, manual=True)

    assert await _attached(thread["id"]) == ["deliver/2026-09-20-汇报.md"]


async def test_no_thread_means_no_attachment(monkeypatch):
    """没挂这件事的任务照旧：产物落到 tasks/，谁都不多一只手。"""
    _point_vault(monkeypatch)
    monkeypatch.setattr(core, "_execute", _fake_execute)

    tid = await _add_task("普通定时", landing_dir="deliver", save_to_vault=True)
    assert (await core.run_task(tid, manual=True))["status"] == "ok"

    from app.models import ThreadItem

    async with SessionLocal() as db:
        assert (await db.execute(select(ThreadItem))).scalars().all() == []


async def test_a_landing_dir_less_step_is_not_a_product(monkeypatch):
    """落点还是 `tasks/` 的步骤（第一步就是）不挂：那是运行留痕，不是产出。

    这条守着挂接的**命名规矩** —— 留痕混进「这件事」里，看的人就分不清哪些是成品。
    """
    from app.core import threads as th

    _point_vault(monkeypatch)
    monkeypatch.setattr(core, "_execute", _fake_execute)

    thread = await th.resolve("选型")
    tid = await _add_task("没有落点", landing_dir="", save_to_vault=True, thread_id=thread["id"])
    r = await core.run_task(tid, manual=True)
    assert r["status"] == "ok" and r["vault_file"].startswith("tasks/")  # 留痕照写

    assert await _attached(thread["id"]) == []


# ---------- 环二表达层：成品落盘，零柒只说一句 ------------------------------------


def _clear_pet() -> None:
    """清掉这个 scratch 库里别的用例留下的台词——不然断言的是「累计说过什么」。"""
    import sqlite3

    from app.config import settings

    conn = sqlite3.connect(settings.db_path)
    try:
        conn.execute("DELETE FROM pet_events")
        conn.commit()
    except sqlite3.OperationalError:  # 表还没建过 = 本来就没有台词
        pass
    finally:
        conn.close()


def _pet_lines(kind: str = "") -> list[dict]:
    from app.core import pet

    try:
        rows = pet.feed(limit=100)
    except Exception:  # noqa: BLE001 - 表不存在 = 一句话都没说过
        return []
    return [e for e in rows if not kind or e["kind"] == kind]


async def test_a_landed_product_makes_pet_say_exactly_one_line(monkeypatch):
    """落了成品 → 零柒说的是**成品那一句**（`output`），**不**再补一句「跑完了」：一件事一句话。

    这句话由写盘的那个人说（这里是真的 `_write_vault`），`run_task` 让位——两边判的
    是同一个 `pet.is_output_path`。多一句不是风格问题：气泡里会同时出现两条说同一件事
    的话，而「跑完了」比成品那句少说了最要紧的那半句。
    **断 kind 不断措辞**：`output` 那几句轮着说（Z3 的台词池）。
    """
    _point_vault(monkeypatch)
    monkeypatch.setattr(core, "_execute", _fake_execute)
    await _clear()
    _clear_pet()

    tid = await _add_task("交付", landing_dir="deliver", save_to_vault=True)
    r = await core.run_task(tid, manual=True)
    assert r["vault_file"].startswith("deliver/")  # 真落了盘，不是空口白话

    lines = _pet_lines()
    assert [e["kind"] for e in lines] == ["output"]
    assert "交付" in lines[0]["text"]


async def test_a_plain_run_still_says_it_finished(monkeypatch):
    """落点还是 `tasks/`（运行留痕，不是成品）→ `task_done` 那句照旧有人说。

    这是上一条的另一半：台词不是被统一掐掉了，而是换了一句更准的。
    **断 kind 不断措辞**（Z3 的台词池会换说法）。
    """
    _point_vault(monkeypatch)
    monkeypatch.setattr(core, "_execute", _fake_execute)
    await _clear()
    _clear_pet()

    tid = await _add_task("留痕", landing_dir="", save_to_vault=True)
    r = await core.run_task(tid, manual=True)
    assert r["vault_file"].startswith("tasks/")

    lines = _pet_lines()
    assert [e["kind"] for e in lines] == ["task_done"]
    assert "留痕" in lines[0]["text"]


async def test_the_engine_writer_speaks_and_run_task_does_not_echo(monkeypatch):
    """引擎那一跳：说话的是**写盘的 `report.save`**，`run_task` 不补第二句。

    上面两条钉的是 `_write_vault` 那条路，这条用**真的** `report.save`——六个成文引擎
    （研究/成文/复盘/方案/对质/交付）都从那一处落盘。两条路都只说一句，气泡里才不会
    出现两条说同一件事的话。

    这条不用 `_point_vault`：它要的正是「所有模块都指着同一个 vault」那个产品状态——
    `report.save` 的落点在 `app.config` 的 vault 里，pet 数的也是它。
    """
    from app.core import indexer
    from app.core import report as report_core

    monkeypatch.setattr(indexer, "index_file", lambda path, **kw: 1)  # 索引不是这条要测的

    async def engine_execute(t: dict, log_entries: list) -> dict:
        rep = report_core.Report(
            title="初稿", sections=[report_core.Section(heading="一", body="内容 [1]")], used=[1]
        )
        srcs = [{"n": 1, "kind": "kb", "title": "笔记", "ref": "notes/a.md", "text": "x"}]
        saved = await report_core.save(rep, srcs, report_core.VAULT_DIR / "research", "研究")
        return {
            "answer": "x",
            "sources": srcs,
            "model_id": "test/model",
            "rounds": 0,
            "tool_calls": 0,
            "saved": saved,
        }

    monkeypatch.setattr(core, "_execute", engine_execute)
    await _clear()
    _clear_pet()

    tid = await _add_task("出稿", save_to_vault=True)
    r = await core.run_task(tid, manual=True)
    assert r["vault_file"].startswith("research/")  # 引擎自己落的盘，没往 tasks/ 抄第二份

    lines = _pet_lines()
    assert [e["kind"] for e in lines] == ["output"]
    assert "初稿" in lines[0]["text"]


async def _ok() -> dict:
    return {"status": "ok"}


async def test_run_now_lands_the_topic_as_a_thread_and_reuses_it(monkeypatch):
    """工作流入口：题目就是这件事的名字。同名复用，不是第二次又建一条同名的事。"""
    from app.core import threads as th
    from app.models import Thread

    monkeypatch.setattr(core, "reschedule", lambda: None)

    async def fake_run_task(*a, **k) -> dict:
        return await _ok()

    monkeypatch.setattr(core, "run_task", fake_run_task)

    from app.routers import tasks as tasks_router

    async with SessionLocal() as db:
        preset = await tasks_router.install_work_preset(db)
        step1 = preset["tasks"][0]["id"]

        first = await tasks_router.run_now(step1, tasks_router.RunIn(topic="选型", thread="选型"), db)
        second = await tasks_router.run_now(step1, tasks_router.RunIn(topic="选型", thread="选型"), db)
        rows = (await db.execute(select(Thread))).scalars().all()
        row = await db.get(ScheduledTask, step1)

    assert first["thread"]["created"] is True and second["thread"]["created"] is False
    assert first["thread"]["id"] == second["thread"]["id"] == row.thread_id
    assert len(rows) == 1  # 同名不新建第二条
    assert th._matches("选型", rows[0].name)


async def test_run_now_guards_a_blank_thread_name(monkeypatch):
    """给了 `thread` 却又全是空白：400，而不是悄悄建一条没名字的事。"""
    from fastapi import HTTPException

    from app.routers import tasks as tasks_router

    monkeypatch.setattr(core, "reschedule", lambda: None)

    async with SessionLocal() as db:
        preset = await tasks_router.install_work_preset(db)
        step1 = preset["tasks"][0]["id"]
        with pytest.raises(HTTPException) as ei:
            await tasks_router.run_now(step1, tasks_router.RunIn(topic="x", thread="   "), db)
    assert ei.value.status_code == 400


async def test_rerunning_a_downstream_step_by_hand_still_knows_the_thread(monkeypatch):
    """手动重跑下游某一步（卡点驳回之后再跑一遍）也得挂回同一件事。

    那一步的行上没有 thread_id，只能**顺着链回链头去问** —— 不这么做的话，
    重跑出来的成品会悄悄不挂（实测就是这么漏的：`vault_file` 明明有了，事上却是空的）。
    """
    from app.routers import tasks as tasks_router

    monkeypatch.setattr(core, "reschedule", lambda: None)

    async def fake_run_task(*a, **k) -> dict:
        return {"status": "ok"}

    monkeypatch.setattr(core, "run_task", fake_run_task)

    async with SessionLocal() as db:
        preset = await tasks_router.install_work_preset(db)
        step1, step2 = preset["tasks"][0]["id"], preset["tasks"][1]["id"]
        first = await tasks_router.run_now(
            step1, tasks_router.RunIn(topic="选型", thread="选型"), db
        )
        # 下游那一步重跑：body 里也带着题目（界面每次都会带）
        again = await tasks_router.run_now(
            step2, tasks_router.RunIn(topic="选型", thread="选型"), db
        )
        head = await db.get(ScheduledTask, step1)
        down = await db.get(ScheduledTask, step2)

    assert first["thread"]["created"] is True and again["thread"]["created"] is False
    assert head.thread_id == down.thread_id == first["thread"]["id"]


async def _ok() -> dict:
    return {"status": "ok"}


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


async def test_the_injected_skills_land_in_the_run_log(monkeypatch):
    """S1 留痕（PLAN3 §2 S1 第 6 条）：引擎那条 `skills` 事件（本次注入了哪份工序）写进
    运行日志——S3 的试用期靠聚合它，而它是**现有日志结构里的一项，不是新列**。"""
    from app.core import compose as engine_mod

    async def fake_run(topic):
        yield "gathering", {}
        yield "skills", {
            "skills": ["给领导写汇报要结论先行"],
            "picked": [{"name": "给领导写汇报要结论先行", "score": 0.61}],
        }
        yield "report", {
            "title": "周报",
            "sections": [{"heading": "结论", "body": "先说结论"}],
            "used": [],
            "sources": [],
        }

    async def fake_save(rep, sources):
        return {"filename": "notes/2026-09-17-周报.md", "title": rep.title, "chunks": 1}

    monkeypatch.setattr(engine_mod, "run", fake_run)
    monkeypatch.setattr(engine_mod, "save", fake_save)

    tid = await _add_engine_task("写周报", "compose")
    r = await core.run_task(tid, manual=True)
    assert r["status"] == "ok"

    run = await _last_run_row()
    assert "skill_inject" in run.log_json
    assert "给领导写汇报要结论先行" in run.log_json
    assert "本次注入" in run.log_json


async def test_a_run_without_an_injection_records_nothing(monkeypatch):
    """没命中就不许在日志里写一条——「本次注入：无」也是编的（日志只摆真发生过的事）。"""
    from app.core import compose as engine_mod

    async def fake_run(topic):
        yield "gathering", {}
        yield "report", {
            "title": "周报",
            "sections": [{"heading": "结论", "body": "先说结论"}],
            "used": [],
            "sources": [],
        }

    async def fake_save(rep, sources):
        return {"filename": "notes/2026-09-17-周报.md", "title": rep.title, "chunks": 1}

    monkeypatch.setattr(engine_mod, "run", fake_run)
    monkeypatch.setattr(engine_mod, "save", fake_save)

    tid = await _add_engine_task("写周报", "compose")
    r = await core.run_task(tid, manual=True)
    assert r["status"] == "ok"
    assert "skill_inject" not in (await _last_run_row()).log_json


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
