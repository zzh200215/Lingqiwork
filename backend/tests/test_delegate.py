"""A1 子代理委托的测试：深度写死一层、隔离、账、以及那个「不外包」的边界。

**一次模型都不调**：`llm.run_agentic_chat` 与 `report.resolve` 都是注入缝（测试塞假的）。
真正的对比跑在命令行那一轮（`smoke_agent.py`）。

这一层最该钉住的三件事：
  1. **深度 = 1**（两道闸门：子代理的工具清单里**根本没有** `delegate`；就算硬调，运行时也拒绝）；
  2. **隔离**（子代理落盘不吃掉主循环那两次修订额度、不往主循环的产出清单里塞东西）；
  3. **不外包**（零柒的工具、外部 MCP、以及 delegate 自己都不在它的清单里）。
"""
import asyncio
import sys

import pytest

sys.path.insert(0, ".")

from app.core import delegate, llm, mcp  # noqa: E402
from app.core.llm import ProviderInfo  # noqa: E402
from app.db import engine  # noqa: E402
from app.models import Agent, Base  # noqa: E402


async def _reset() -> None:
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)
        await conn.run_sync(Base.metadata.create_all)


def _fake_turn(text: str = "查完了：这块材料在 notes/本周进展.md 里。", rounds: int = 2):
    """假的模型循环：记下**它收到的 messages 与工具清单**，然后回一段文字。"""
    seen: list[dict] = []

    async def fake(provider, model, messages, tools, run_tool, emit_text, emit_tool, **kw):  # noqa: ARG001
        seen.append({"model": model, "messages": [dict(m) for m in messages], "tools": tools, "kw": kw})
        for ch in text:
            emit_text(ch)
        trace = kw.get("trace")
        if trace is not None:
            trace["rounds"] = rounds
            trace["tool_calls"] = [{"name": "kb_search", "ok": True, "ms": 5}]
        return text

    return seen, fake


# ---------- 轮数预算：父减半、封顶 3 ----------


def test_sub_rounds_is_half_the_parent_capped_at_three():
    assert delegate.sub_rounds(6) == 3  # 线上默认（MAX_TOOL_ROUNDS=6）→ 3
    assert delegate.sub_rounds(12) == 3  # 父再宽也不给更多：委托是便宜，不是翻倍
    assert delegate.sub_rounds(4) == 2
    assert delegate.sub_rounds(2) == 1
    assert delegate.sub_rounds(1) == 1  # 至少一轮
    assert delegate.sub_rounds(0) == 3  # 「没给」按默认父预算（6）算，不读成「零轮」
    assert delegate.SUB_ROUNDS_CAP == 3


def test_the_tool_description_does_not_drift_from_the_budget():
    """描述里那句「最多 3 轮」与常量是一回事 —— 漂了就是骗模型。"""
    spec = next(b for b in mcp.BUILTIN_TOOLS if b["name"] == "delegate")
    assert str(delegate.SUB_ROUNDS_CAP) in spec["description"]
    assert "只读" in spec["description"] and "委托" in spec["description"]


# ---------- 工具子集：默认只读，写要显式给，delegate 永远不给 ----------


def test_default_tool_subset_is_read_only_and_never_includes_delegate():
    names, unknown = delegate.allowed_tools()
    assert names == list(delegate.READONLY_TOOLS)
    assert "delegate" not in names
    assert "save_artifact" not in names and "vault_write_file" not in names
    assert unknown == []


def test_write_tools_must_be_named_explicitly_and_unknown_names_are_reported():
    names, unknown = delegate.allowed_tools(["save_artifact", "vault_red_file"])
    assert "save_artifact" in names  # 显式点名才给
    assert unknown == ["vault_red_file"]  # 不认识的照实报（不当场失败）
    assert "delegate" not in names


def test_even_a_caller_asking_for_delegate_does_not_get_it():
    """**纪律 2 的第一道闸门**：子代理的工具清单里没有 delegate，要也不给。"""
    names, unknown = delegate.allowed_tools(["delegate", "save_artifact"])
    assert "delegate" not in names
    assert unknown == ["delegate"]  # 还得告诉它这个名字给不了


def test_pet_tools_are_not_outsourced():
    names, _ = delegate.allowed_tools(["pet_focus_start"])
    assert not any(n.startswith("pet_") for n in names)


def test_the_sub_agent_spec_list_has_no_delegate_and_no_writes():
    specs = delegate._specs(delegate.allowed_tools()[0])  # noqa: SLF001
    got = {s["function"]["name"] for s in specs}
    assert got == set(delegate.READONLY_TOOLS)
    assert "delegate" not in got


# ---------- 深度闸门（第二道） ----------


def test_a_delegation_inside_a_delegation_is_refused():
    """第一道（清单里没有）是构造出来的事实；这一道是**当时**的事实。两道都留着。"""
    token = delegate._DEPTH.set(1)  # noqa: SLF001
    try:
        out = asyncio.run(delegate.run("再委托一层"))
    finally:
        delegate._DEPTH.reset(token)  # noqa: SLF001
    assert out["error"] and "只允许一层" in out["error"]
    assert out["text"] == ""


# ---------- run：隔离 + 账 + 人设/模型/工具的解析 ----------


def test_run_isolates_the_sub_agents_turn_state_from_the_parents(monkeypatch):
    """**这一条是委托最容易出的错**：子代理在自己的 Task 上下文里跑，
    `mcp.begin_turn()` 换的是**它自己那份**额度/产出清单，主循环那一轮一根手指都不动。"""
    seen, fake = _fake_turn()
    monkeypatch.setattr(delegate, "run_agentic_chat", fake)

    async def go():
        from app.core import turn_trace

        parent_saves = mcp.begin_turn(None)
        parent_saves["deliver"] = "deliver/主循环写的.md"
        draft = turn_trace.begin(conversation_id=1, model_id="p/m")
        delegate.set_parent(
            provider=ProviderInfo(kind="openai", base_url="", api_key="k"),
            model_id="p/m",
            model_name="m",
            max_rounds=6,
            usage={"input": 10, "output": 20},
        )

        async def sub_side():
            # 子代理这一侧：它自己的 begin_turn 已经由 run() 调过；这里模拟它存一份产出
            mcp._TURN_SAVES.set({"deliver": 2})  # noqa: SLF001
            (mcp._TURN_ARTIFACTS.get() or {})["deliver"] = "deliver/子代理写的.md"  # noqa: SLF001

        # 在假模型循环里，把「子代理落盘」塞进去看一眼父那边有没有被改
        async def fake_with_write(*a, **kw):
            await sub_side()
            return await fake(*a, **kw)

        monkeypatch.setattr(delegate, "run_agentic_chat", fake_with_write)
        out = await delegate.run("去翻一下材料")
        return out, parent_saves, mcp.turn_saves("deliver"), dict(mcp._TURN_ARTIFACTS.get() or {}), draft, turn_trace

    out, parent_saves, parent_saves_n, parent_arts, draft, turn_trace = asyncio.run(go())
    assert out["error"] == "" and out["text"]
    # 父那一轮的额度与产出清单：还是它自己原来的样子
    assert parent_saves_n == 0, "子代理的落盘吃掉了主循环的修订额度"
    assert parent_arts == {"deliver": "deliver/主循环写的.md"}, "子代理的产出混进了主循环的清单"
    assert parent_saves == {"deliver": "deliver/主循环写的.md"}
    # 账：父这一轮的草稿里挂着子代理那一条
    assert len(draft["sub_traces"]) == 1
    assert draft["sub_traces"][0]["model_id"] == "p/m"
    assert draft["sub_traces"][0]["rounds"] == 2
    assert draft["sub_traces"][0]["tools"] == ["kb_search"]
    asyncio.run(turn_trace.finish(draft))


def test_run_gives_the_sub_agent_only_the_task_and_an_optional_persona(monkeypatch):
    """纪律 1：**独立 messages**——只有 task + 人设，不带主循环那段对话。"""
    seen, fake = _fake_turn()
    monkeypatch.setattr(delegate, "run_agentic_chat", fake)
    delegate.set_parent(
        provider=ProviderInfo(kind="openai", base_url="", api_key="k"),
        model_id="p/m",
        model_name="m",
        max_rounds=6,
    )
    out = asyncio.run(delegate.run("把 A 和 B 的差异找出来"))
    msgs = seen[0]["messages"]
    assert [m["role"] for m in msgs] == ["system", "user"]
    assert "把 A 和 B 的差异找出来" in msgs[-1]["content"]
    assert msgs[0]["content"] == delegate.DEFAULT_PERSONA
    assert out["model_id"] == "p/m"  # 不给 model_id 就跟着主循环那个
    # **发给模型的是 provider 那边认的名字**（`seen[0]["model"]` 就是 `run_agentic_chat` 收到的）
    assert seen[0]["model"] == "m"
    assert seen[0]["kw"]["max_rounds"] == 3


def test_a_reused_parent_provider_still_sends_the_model_name(monkeypatch):
    """**A1 的潜伏 bug，A2 才炸出来**（2026-09-20）。

    复用父的 provider 那条路（也就是**最常见的一条**：主循环开轮时登记了 provider，
    工具调用没指定 `model_id`）当时把 `mid` 原样当模型名发了出去 —— 而 `mid` 是
    `sensenova/sensenova-6.8-flash-lite` 这种 **id**。服务端回 `400 required model`。
    A1 装了那么久没炸，因为那 16 条任务一次都没委托；A2 把协作接上同一条通道，每一步都炸。

    这条测试钉的就是「复用也要用名字」：父没给 `model_name` 时**必须重新解析**，
    不许拿 id 顶上去。
    """
    seen, fake = _fake_turn()
    monkeypatch.setattr(delegate, "run_agentic_chat", fake)
    calls: list[str] = []

    async def fake_resolve(model_id):
        calls.append(model_id)
        return ProviderInfo(kind="openai", base_url="", api_key="k"), "the-real-name"

    monkeypatch.setattr("app.core.report.resolve", fake_resolve)
    # 父给了 provider 与 id，但**没给名字** —— 老代码就是在这里把 id 当名字发出去的
    delegate.set_parent(
        provider=ProviderInfo(kind="openai", base_url="", api_key="k"), model_id="p/m", max_rounds=6
    )
    out = asyncio.run(delegate.run("查一下"))
    assert calls == ["p/m"], "拿不到 provider 侧的名字时，应当按 id 重新解析一次"
    assert seen[0]["model"] == "the-real-name"
    assert out["model_name"] == "the-real-name" and out["model_id"] == "p/m"


def test_run_can_be_pointed_at_another_model(monkeypatch):
    seen, fake = _fake_turn()
    monkeypatch.setattr(delegate, "run_agentic_chat", fake)
    calls: list[str] = []

    async def fake_resolve(model_id):
        calls.append(model_id)
        return ProviderInfo(kind="openai", base_url="", api_key="k"), "cheap-model"

    monkeypatch.setattr("app.core.report.resolve", fake_resolve)
    delegate.set_parent(
        provider=ProviderInfo(kind="openai", base_url="", api_key="k"), model_id="p/m", model_name="m", max_rounds=6
    )
    out = asyncio.run(delegate.run("查一下", model_id="qwen/cheap-model"))
    assert calls == ["qwen/cheap-model"]  # 换了模型就得重新解析 provider
    # **id 与名字分开记**（A2 校正）：id 是人配的那个，名字是发给服务端的那个
    assert out["model_id"] == "qwen/cheap-model"
    assert out["model_name"] == "cheap-model"
    assert seen[0]["model"] == "cheap-model"


def test_rounds_exhausted_travels_from_the_sub_trace_to_the_caller(monkeypatch):
    """**轮数烧光 = 交回来的是占位符，不是答案**（A2 撞到的）。

    `run_agentic_chat` 烧光轮数时返回一句「工具调用轮次过多…」，而它长得像正常回答。
    子代理这一层必须把这个事实**带出去**（给 `collab` 的逐步账、给账本的 sub_trace JSON）——
    不然调用方会把「它什么都没答」读成「它答完了」。
    """
    _, fake = _fake_turn("(工具调用轮次过多，未能生成最终回答。请简化指令或关闭工具后重试。)")

    async def go():
        from app.core import turn_trace

        delegate.set_parent(
            provider=ProviderInfo(kind="openai", base_url="", api_key="k"),
            model_id="p/m",
            model_name="m",
            max_rounds=6,
        )
        draft = turn_trace.begin(conversation_id=1, model_id="p/m")

        async def fake_exhausted(*a, **kw):
            out = await fake(*a, **kw)
            tr = kw.get("trace")
            if tr is not None:
                tr["rounds_exhausted"] = True  # 真实路径由 `llm.run_agentic_chat` 记这一笔
            return out

        monkeypatch.setattr(delegate, "run_agentic_chat", fake_exhausted)
        res = await delegate.run("查一下")
        return res, draft

    out, draft = asyncio.run(go())
    assert out["rounds_exhausted"] is True
    assert draft["sub_traces"][-1]["rounds_exhausted"] is True  # 账本那一列是 JSON，加字段不用迁移
    # 正常答完时是 False，**不是缺字段**——「没烧光」与「读不到」要分得开
    _, ok_fake = _fake_turn("查完了")
    monkeypatch.setattr(delegate, "run_agentic_chat", ok_fake)
    assert asyncio.run(delegate.run("再查一下"))["rounds_exhausted"] is False


def test_an_agent_that_turned_tools_off_gets_no_tools(monkeypatch):
    """纪律 4：agents 表就是登记处 —— 它的工具白名单对它一样有效。

    A2 起那一栏是**白名单字符串**（原来是布尔）：`none` = 一个都不给。
    """

    async def go():
        await _reset()
        from app.db import SessionLocal

        async with SessionLocal() as db:
            db.add(Agent(name="纯写手", system_prompt="你只写字。", model_id="", tool_whitelist="none"))
            await db.commit()

        seen, fake = _fake_turn("写好了")
        monkeypatch.setattr(delegate, "run_agentic_chat", fake)
        delegate.set_parent(
            provider=ProviderInfo(kind="openai", base_url="", api_key="k"), model_id="p/m", model_name="m", max_rounds=6
        )
        out = await delegate.run("写一段", agent_name="纯写手")
        return out, seen

    out, seen = asyncio.run(go())
    assert seen[0]["tools"] == []
    assert seen[0]["messages"][0]["content"] == "你只写字。"
    assert out["agent_name"] == "纯写手"


def test_an_agent_whitelist_is_an_upper_bound(monkeypatch):
    """A2：agent 的白名单是**上限**，`tools` 参数是**下限**，两者取交集。

    - agent 只许碰 vault → 就算这一步点名要 `kb_search`，它也给不了；
    - agent 不限制（空）→ 这一步要什么就给什么。
    """

    async def go():
        await _reset()
        from app.db import SessionLocal

        async with SessionLocal() as db:
            db.add(Agent(name="只读手", system_prompt="你只看文件。", tool_whitelist="vault_*"))
            await db.commit()

        seen, fake = _fake_turn("看完了")
        monkeypatch.setattr(delegate, "run_agentic_chat", fake)
        delegate.set_parent(
            provider=ProviderInfo(kind="openai", base_url="", api_key="k"), model_id="p/m", model_name="m", max_rounds=6
        )
        out = await delegate.run("看一眼", agent_name="只读手", tools=["kb_search", "vault_list_files"])
        return out, seen

    _, seen = asyncio.run(go())
    names = sorted(s["function"]["name"] for s in seen[0]["tools"])
    # 只读基线里属于 `vault_*` 的两个留下；点名要的 `kb_search` 被 agent 的白名单挡掉
    assert names == ["vault_list_files", "vault_read_file"]


def test_an_unknown_agent_name_falls_back_to_a_bare_task(monkeypatch):
    """查不到就用裸 task + 默认配置 —— `resolve_agent` 返回 None，不抛错、不拦住这一轮。"""

    async def go():
        await _reset()
        seen, fake = _fake_turn()
        monkeypatch.setattr(delegate, "run_agentic_chat", fake)
        delegate.set_parent(
            provider=ProviderInfo(kind="openai", base_url="", api_key="k"), model_id="p/m", model_name="m", max_rounds=6
        )
        return await delegate.run("查一下", agent_name="根本没有这个人"), seen

    out, seen = asyncio.run(go())
    assert out["error"] == ""
    assert seen[0]["messages"][0]["content"] == delegate.DEFAULT_PERSONA


def test_stopping_the_parent_stops_the_sub_agent(monkeypatch):
    """用户点「停止」时子代理不能接着烧钱。

    `await child` **不会**把取消自动传下去 —— 不显式 `cancel()`，子代理会在后台跑完，
    而用户那边已经什么都看不到了。这条钉住那个 `except CancelledError` 分支。
    """
    stopped = {"cancelled": False}

    async def hanging(*_a, **_kw):
        try:
            await asyncio.sleep(30)
        except asyncio.CancelledError:
            stopped["cancelled"] = True
            raise
        return "永远不会到这里"

    monkeypatch.setattr(delegate, "run_agentic_chat", hanging)

    async def go():
        delegate.set_parent(
            provider=ProviderInfo(kind="openai", base_url="", api_key="k"),
            model_id="p/m", model_name="m",
            max_rounds=6,
        )
        task = asyncio.create_task(delegate.run("查一下"))
        await asyncio.sleep(0.05)  # 让它真的进到子代理那一层
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass
        await asyncio.sleep(0.05)  # 给取消一点时间落地

    asyncio.run(go())
    assert stopped["cancelled"] is True, "主循环被掐断了，子代理还在跑"


def test_a_blown_up_sub_agent_does_not_take_the_parent_down(monkeypatch):
    async def boom(*_a, **_kw):
        raise RuntimeError("provider 挂了")

    monkeypatch.setattr(delegate, "run_agentic_chat", boom)

    async def go():
        delegate.set_parent(
            provider=ProviderInfo(kind="openai", base_url="", api_key="k"), model_id="p/m", model_name="m", max_rounds=6
        )
        return await delegate.run("查一下")

    out = asyncio.run(go())
    assert "provider 挂了" in out["error"]
    assert delegate.render(out).startswith("[子代理失败]")


# ---------- render / handler ----------


def test_render_says_who_did_it_and_what_it_cost():
    got = delegate.render(
        {
            "agent_name": "检索员",
            "model_id": "p/cheap",
            "rounds": 2,
            "tool_calls": [{"name": "kb_search"}, {"name": "vault_read_file"}],
            "text": "结论：阈值是 0.62。",
        }
    )
    assert got.startswith("[子代理 · 检索员 · p/cheap · 2 轮 · 2 次工具]")
    assert "结论：阈值是 0.62。" in got


def test_render_truncates_and_says_so():
    got = delegate.render({"text": "字" * (delegate.TEXT_CAP + 50), "rounds": 1, "tool_calls": []})
    assert "已截断" in got
    assert len(got) < delegate.TEXT_CAP + 200


def test_render_reads_back_unknown_tools_and_artifacts():
    got = delegate.render(
        {
            "text": "好",
            "rounds": 1,
            "tool_calls": [],
            "unknown_tools": ["vault_reed_file"],
            "artifacts": [{"path": "deliver/a.md"}],
        }
    )
    assert "不认识的工具" in got and "vault_reed_file" in got
    assert "子代理落盘：deliver/a.md" in got


def test_handler_requires_a_task():
    async def go():
        return await delegate.handler({}), await delegate.handler({"task": "  "})

    empty, blank = asyncio.run(go())
    assert empty.startswith("[tool error]") and blank.startswith("[tool error]")


def test_handler_puts_a_small_summary_on_the_tool_meta_bypass(monkeypatch):
    """界面靠 `_TOOL_META` 知道「这一刀是个委托」；子代理的产出回执也一起带走。

    **必须在同一个事件循环里读**：`_TOOL_META` 是 ContextVar，`asyncio.run` 跑在另一个
    上下文里 —— 外面那个同步栈读不到它（生产路径上 `call_tool` 与处理器是同一个 Task，
    所以没这个问题）。
    """
    seen, fake = _fake_turn("查完了")
    monkeypatch.setattr(delegate, "run_agentic_chat", fake)
    delegate.set_parent(
        provider=ProviderInfo(kind="openai", base_url="", api_key="k"), model_id="p/m", model_name="m", max_rounds=6
    )

    async def go():
        text = await delegate.handler({"task": "查一下", "tools": "save_artifact"})
        return text, mcp.take_tool_meta(), mcp.take_tool_meta()

    text, meta, again = asyncio.run(go())
    assert "查完了" in text
    assert meta and meta["delegate"]["model_id"] == "p/m"
    assert meta["delegate"]["rounds"] == 2
    assert again is None  # 取走即清


def test_handler_accepts_a_comma_separated_tools_string(monkeypatch):
    """模型常把数组写成逗号分隔的字符串 —— 认它，别当没给。"""
    seen, fake = _fake_turn()
    monkeypatch.setattr(delegate, "run_agentic_chat", fake)
    delegate.set_parent(
        provider=ProviderInfo(kind="openai", base_url="", api_key="k"), model_id="p/m", model_name="m", max_rounds=6
    )
    asyncio.run(delegate.handler({"task": "查一下", "tools": "save_artifact, kb_search"}))
    names = {s["function"]["name"] for s in seen[0]["tools"]}
    assert "save_artifact" in names and "kb_search" in names
    assert "delegate" not in names


# ---------- 谁拿得到 delegate（纪律 5：chat 开、无人值守关） ----------


def test_only_chat_opts_in_to_the_delegate_tool():
    default_names = {s["function"]["name"] for s in mcp.mcp_manager.tool_specs()}
    chat_names = {s["function"]["name"] for s in mcp.mcp_manager.tool_specs(include_delegate=True)}
    assert "delegate" not in default_names, "默认给了 = 无人值守那条路也拿到了（纪律 5）"
    assert "delegate" in chat_names


def test_the_tasks_tool_catalogue_does_not_offer_delegate():
    """`GET /api/tasks/tools` 是**给模型看的工具清单**（也是建任务时那个白名单选择器）——
    它走的是默认参数，所以委托不会出现在无人值守那条路上。"""
    import asyncio as _a

    from app.routers.tasks import list_tools

    rows = _a.run(list_tools())
    assert "delegate" not in {r["name"] for r in rows}


@pytest.mark.parametrize("name", ["delegate"])
def test_the_builtin_entry_points_at_the_delegate_module(name):
    spec = next(b for b in mcp.BUILTIN_TOOLS if b["name"] == name)
    assert callable(spec["handler"])
    assert spec["parameters"]["required"] == ["task"]
    assert set(spec["parameters"]["properties"]) == {"task", "agent_name", "model_id", "tools"}
