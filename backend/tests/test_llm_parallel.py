"""run_agentic_chat 并行工具调用测试。

模型一次返回多个 tool_calls 时，语义就是「可并行」——独立工具同时跑省时。
这里钉住三点：确实并行（非串行）、结果顺序保持、单个工具失败不拖垮同轮。
"""
import asyncio
import sys

sys.path.insert(0, ".")

from app.core import llm
from app.core.llm import ProviderInfo, ToolCall


class _FakeClient:
    async def close(self):
        pass


def _patch(monkeypatch, rounds):
    """按顺序返回 (text, [ToolCall])；rounds 耗尽即结束。"""
    it = iter(rounds)

    async def fake_openai_round(client, model, messages, tools, emit_text, usage_out=None):
        text, calls = next(it)
        if text:
            emit_text(text)
        return text, calls

    monkeypatch.setattr(llm, "_openai_round", fake_openai_round)
    monkeypatch.setattr(llm, "_openai_client", lambda p: _FakeClient())


def _provider():
    return ProviderInfo(kind="openai", base_url="", api_key="k")


def _tools():
    # 执行层只放行**本轮广告过**的工具（BUG-008）。这些测试量的是循环机制（并行/顺序/
    # 隔离），用的是占位名——把它们都广告出去，机制照测，又不触发未授权拦截。
    return [
        {"type": "function", "function": {"name": n, "parameters": {}}}
        for n in ("a", "b", "slow", "fast", "bad", "good")
    ]


async def _run(tools_rounds, run_tool, monkeypatch):
    _patch(monkeypatch, tools_rounds)
    return await llm.run_agentic_chat(
        _provider(),
        "m",
        [{"role": "user", "content": "x"}],
        _tools(),
        run_tool=run_tool,
        emit_text=lambda t: None,
        emit_tool=lambda name, args: None,
    )


async def test_parallel_tools_run_concurrently(monkeypatch):
    active = 0
    max_active = 0

    async def run_tool(name, args):
        nonlocal active, max_active
        active += 1
        max_active = max(max_active, active)
        await asyncio.sleep(0.01)
        active -= 1
        return f"{name} result"

    text = await _run(
        [
            ("", [ToolCall("1", "a", {}), ToolCall("2", "b", {})]),
            ("done", []),
        ],
        run_tool,
        monkeypatch,
    )
    assert text == "done"
    assert max_active == 2  # 两个工具同时 in-flight —— 并行而非串行


async def test_parallel_result_order_preserved(monkeypatch):
    # 慢工具在前、快工具在后：结果顺序仍应等于 calls 顺序（gather 保持顺序）
    captured: dict = {}

    async def run_tool(name, args):
        if name == "slow":
            await asyncio.sleep(0.03)
        return f"{name} result"

    monkeypatch.setattr(llm, "_append_tool_round", lambda msgs, kind, text, outputs: captured.setdefault("names", [tc.name for tc, _ in outputs]) or msgs)

    await _run(
        [
            ("", [ToolCall("1", "slow", {}), ToolCall("2", "fast", {})]),
            ("done", []),
        ],
        run_tool,
        monkeypatch,
    )
    assert captured["names"] == ["slow", "fast"]  # 即使 slow 后完成，顺序不变


async def test_parallel_error_isolation(monkeypatch):
    captured: dict = {}

    async def run_tool(name, args):
        if name == "bad":
            raise RuntimeError("boom")
        return "ok"

    monkeypatch.setattr(
        llm, "_append_tool_round",
        lambda msgs, kind, text, outputs: captured.setdefault("outputs", [out for _, out in outputs]) or msgs,
    )

    await _run(
        [
            ("", [ToolCall("1", "bad", {}), ToolCall("2", "good", {})]),
            ("done", []),
        ],
        run_tool,
        monkeypatch,
    )
    assert captured["outputs"][0].startswith("[tool error]")
    assert captured["outputs"][1] == "ok"


async def test_single_tool_stays_sequential(monkeypatch):
    active = 0
    max_active = 0

    async def run_tool(name, args):
        nonlocal active, max_active
        active += 1
        max_active = max(max_active, active)
        await asyncio.sleep(0.01)
        active -= 1
        return "result"

    await _run(
        [
            ("", [ToolCall("1", "a", {})]),
            ("done", []),
        ],
        run_tool,
        monkeypatch,
    )
    assert max_active == 1  # 单工具自然串行
