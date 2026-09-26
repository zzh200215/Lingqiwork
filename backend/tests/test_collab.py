"""V14 collab tests: step planning, prompt composition, and the full run
event stream over a fake LLM. No network, no provider.

**A2（2026-09-20）改了执行体**：每一步从 `collab.stream_chat` 换成 `delegate.run` 通道，
所以注入缝也跟着换到 `delegate.run_agentic_chat`（这里一次模型都不调）。
"""
import asyncio

import pytest

from app.core import collab, delegate

_A = {"name": "写手", "avatar": "✍️", "system_prompt": "你是写手", "model_id": "p/m1"}
_B = {"name": "评审", "avatar": "🔍", "system_prompt": "你是评审", "model_id": "p/m2"}


def _run(gen):
    async def collect():
        return [item async for item in gen]

    return asyncio.run(collect())


def _fake_llm(calls, outputs, *, rounds=1, tool_names=None):
    """假的模型循环（A2 起协作走 delegate，缝在 `delegate.run_agentic_chat`）：

    记下每一次的 (model, messages, tools)，然后吐一段脚本化的输出。
    """

    async def fake(provider, model, messages, tools, run_tool, emit_text, emit_tool, **kw):  # noqa: ARG001
        calls.append({"model": model, "messages": [dict(m) for m in messages], "tools": tools})
        text = outputs[len(calls) - 1] if len(calls) <= len(outputs) else "默认输出"
        for chunk in text:
            emit_text(chunk)
        trace = kw.get("trace")
        if trace is not None:
            trace["rounds"] = rounds
            trace["tool_calls"] = [{"name": n, "ok": True, "ms": 1} for n in (tool_names or [])]
        return text

    return fake


def _resolve(default: str = "p/default"):
    """编排器解析模型的假缝：`(ProviderInfo, model)`。**不解析真 provider。**"""

    async def fake_resolve(model_id):
        return ("fake-info", model_id or default)

    return fake_resolve


# ---------- build_steps ----------


def test_pipeline_steps_in_order():
    steps = collab.build_steps("pipeline", [_A, _B])
    assert [s["phase"] for s in steps] == ["work", "work"]
    assert [s["agent"]["name"] for s in steps] == ["写手", "评审"]


def test_review_steps_map_agents():
    steps = collab.build_steps("review", [_A, _B])
    assert [s["phase"] for s in steps] == ["draft", "review", "revise"]
    assert steps[0]["agent"] is steps[2]["agent"] is _A
    assert steps[1]["agent"] is _B


@pytest.mark.parametrize(
    "pattern,agents",
    [
        ("brainstorm", [_A, _B]),  # unknown pattern
        ("pipeline", [_A]),  # too few
        ("pipeline", [_A, _B, _A, _B, _A]),  # too many
        ("review", [_A]),  # review needs exactly 2
    ],
)
def test_build_steps_rejects_bad_config(pattern, agents):
    with pytest.raises(ValueError):
        collab.build_steps(pattern, agents)


# ---------- composition ----------


def test_compose_draft_and_work_with_rag():
    rag = "【资料】片段"
    msgs = collab.compose_messages({"agent": _A, "phase": "draft", "title": "t"}, "目标X", None, "", rag)
    assert msgs[0]["content"] == "你是写手"
    assert msgs[1]["content"] == rag  # rag block as its own system message
    assert "目标X" in msgs[2]["content"]
    # no prev on draft
    assert "上一步" not in msgs[2]["content"]


def test_compose_review_carries_draft():
    msgs = collab.compose_messages({"agent": _B, "phase": "review", "title": "评审"}, "目标X", "这是初稿内容", "初稿 · 写手", "")
    assert msgs[0]["content"] == "你是评审"  # reviewer persona overrides agent prompt
    assert "这是初稿内容" in msgs[1]["content"]
    assert "初稿 · 写手" in msgs[1]["content"]


def test_compose_revise_carries_draft_and_notes():
    step = {"agent": _A, "phase": "revise", "title": "修订", "review_notes": "1. 补数据"}
    msgs = collab.compose_messages(step, "目标X", "初稿全文", "初稿 · 写手", "")
    user = msgs[-1]["content"]
    assert "初稿全文" in user and "1. 补数据" in user and "终稿" in user


def test_compose_work_step2_carries_prev():
    msgs = collab.compose_messages({"agent": _B, "phase": "work", "title": "t2"}, "目标X", "上游产出", "写手", "")
    user = msgs[-1]["content"]
    assert "上游产出" in user and "写手" in user


def test_cap_truncates():
    assert collab._cap("字" * (collab.MAX_STEP_OUT_CHARS + 10)).endswith("（超长截断）")
    assert collab._cap("  ok  ") == "ok"


def test_header_md_chain():
    h = collab.header_md("pipeline", [_A, _B])
    assert "流水线" in h and "写手" in h and "→" in h
    h2 = collab.header_md("review", [_A, _B])
    assert "评审回路" in h2 and "⟳" in h2


def test_build_rag_block_empty():
    assert collab.build_rag_block([]) == ""
    assert collab.build_rag_block([{"source": "a.md", "text": "内容"}]).count("a.md") == 1


# ---------- run() event stream ----------


def test_run_pipeline_full_flow(monkeypatch):
    calls: list = []
    monkeypatch.setattr(delegate, "run_agentic_chat", _fake_llm(calls, ["第一段输出", "第二段输出"]))

    events = _run(collab.run("目标X", [_A, _B], "pipeline", _resolve("")))

    kinds = [e for e, _ in events]
    assert kinds[0] == "meta" and kinds[-1] == "done"
    assert kinds.count("error") == 0
    done = events[-1][1]
    assert done["ok"] is True and done["steps"] == 2
    # transcript has header + both sections + both outputs
    assert "协作 · 流水线" in done["transcript"]
    assert "第一段输出" in done["transcript"] and "第二段输出" in done["transcript"]
    # each agent pinned model honored
    assert calls[0]["model"] == "p/m1" and calls[1]["model"] == "p/m2"
    # step 2 user content carries step 1 output
    assert "第一段输出" in calls[1]["messages"][-1]["content"]
    # A2：每一步的账都在 done 里（谁跑的 / 几轮 / 几秒）
    assert [f["title"] for f in done["facts"]] == ["写手", "评审"]
    assert all(f["rounds"] == 1 for f in done["facts"])


def test_run_review_loop(monkeypatch):
    calls: list = []
    monkeypatch.setattr(
        delegate,
        "run_agentic_chat",
        _fake_llm(calls, ["初稿正文", "意见1：补数据", "修订后的终稿"]),
    )

    events = _run(collab.run("目标Y", [_A, _B], "review", _resolve("")))
    assert events[-1][1]["ok"] is True
    # 3 LLM calls: draft(A), review(B), revise(A)
    assert len(calls) == 3
    assert calls[0]["model"] == "p/m1" and calls[1]["model"] == "p/m2" and calls[2]["model"] == "p/m1"
    # revise user content has both draft and review notes
    revise_user = calls[2]["messages"][-1]["content"]
    assert "初稿正文" in revise_user and "意见1" in revise_user
    assert "修订后的终稿" in events[-1][1]["transcript"]


def test_run_mid_failure_reports_step_and_stops(monkeypatch):
    calls: list = []

    async def failing(provider, model, messages, tools, run_tool, emit_text, emit_tool, **kw):  # noqa: ARG001
        calls.append(model)
        if len(calls) == 1:
            emit_text("第一步没问题")
            return "第一步没问题"
        raise RuntimeError("网络炸了")

    monkeypatch.setattr(delegate, "run_agentic_chat", failing)

    events = _run(collab.run("目标Z", [_A, _B], "pipeline", _resolve("p/x")))
    kinds = [e for e, _ in events]
    assert "error" in kinds
    err = next(d for e, d in events if e == "error")
    assert "第 2 步" in err["message"] and "RuntimeError" in err["message"]
    assert events[-1][0] == "done" and events[-1][1]["ok"] is False


def test_run_empty_step_output_errors(monkeypatch):
    calls: list = []
    monkeypatch.setattr(delegate, "run_agentic_chat", _fake_llm(calls, ["   "]))

    events = _run(collab.run("目标W", [_A, _B], "pipeline", _resolve("p/x")))
    err = next(d for e, d in events if e == "error")
    assert "返回空内容" in err["message"]


def test_run_with_retrieval(monkeypatch):
    calls: list = []
    monkeypatch.setattr(delegate, "run_agentic_chat", _fake_llm(calls, ["一", "二"]))
    retrieved: list = []

    async def fake_retrieve(q, k):
        retrieved.append((q, k))
        return [{"source": "notes/a.md", "text": "知识库片段"}]

    events = _run(collab.run("检索目标", [_A, _B], "pipeline", _resolve("p/x"), fake_retrieve))
    kinds = [e for e, _ in events]
    assert "sources" in kinds
    assert retrieved == [("检索目标", collab.RAG_TOP_K)]
    # every pipeline "work" step sees the retrieved context
    assert all(any("知识库片段" in m["content"] for m in c["messages"]) for c in calls)


def test_run_rejects_bad_input():
    with pytest.raises(ValueError):
        _run(collab.run("  ", [_A, _B], "pipeline", _resolve("p/x")))
    with pytest.raises(ValueError):
        _run(collab.run("目标", [_A], "pipeline", _resolve("p/x")))


# ---------- A2：波次（并行由编排器判定） ----------


def test_fanout_waves_are_one_parallel_wave_plus_a_merge():
    waves = collab.build_waves("fanout", [_A, _B])
    assert len(waves) == 2
    assert [s["phase"] for s in waves[0]] == ["work", "work"]
    assert all(s["parallel_group"] == "fanout" for s in waves[0])
    assert [s["phase"] for s in waves[1]] == ["merge"]
    assert waves[1][0]["parallel_group"] == ""
    # 扁平视图与 waves 是同一批 step（`build_steps` 只是压平）
    assert [s["title"] for s in collab.build_steps("fanout", [_A, _B])] == [
        s["title"] for w in waves for s in w
    ]


@pytest.mark.parametrize("pattern", ["pipeline", "review"])
def test_serial_patterns_are_one_step_per_wave(pattern):
    """串行语义不许被并行那套改掉：`pipeline` / `review` 每一波只有一个 step。"""
    waves = collab.build_waves(pattern, [_A, _B])
    assert all(len(w) == 1 for w in waves)


def test_no_step_ever_declares_a_write_tool_or_delegate():
    """工具白名单的第一版是**零写工具**：协作的产物是对话里的纪要，不是产出区的成品。

    这条要钉住的是「有人顺手给了 save_artifact」——那是改产品交付方式，不是改机制。
    """
    seen = set()
    for pattern in collab.PATTERNS:
        # **带材料也要查一遍**：② 之后 fanout 会多出 read / digest 两种 phase，
        # 只查「不给材料」的那条路等于漏掉它们（新加一步就是一种「顺手给个工具」的机会）。
        for mats in (None, ["notes/a.md"]):
            for step in collab.build_steps(pattern, [_A, _B], mats):
                seen.update(step["tools"])
    assert seen == set()


# ---------- A2：材料由编排器分给各路 ----------


def test_materials_are_split_across_the_fanout_branches():
    """**「谁能读什么」是编排器的判定**（2026-09-20 拍板：瓶颈是任务形状，不是轮数）。

    实测背景：不给分工时，那几路各自反复 `vault_list_files`，把每一步 3 轮的预算全烧在
    找文件上（一条任务 27 次工具调用、四步全交占位符）。分好之后每一路只知道自己的那几份。

    **② 之后多了一波**：每份材料先各自一个「读」步（一步只读一份），再按 agent 合成结论，
    最后汇总——见 `test_the_fanout_read_wave_gives_every_step_exactly_one_material`。
    """
    mats = ["a.md", "b.md", "c.md", "d.md", "e.md", "f.md"]
    waves = collab.build_waves("fanout", [_A, _B], mats)
    reads, digests, merge = waves
    # 读那一波：一份材料一个 step，谁都不许顺手读别人的
    assert [s["focus"] for s in reads] == [[m] for m in mats]
    assert all(s["phase"] == "read" for s in reads)
    # 结论那一波：按 agent 的切片（轮流分，与 `split_materials` 同一把尺子）
    assert [s["focus"] for s in digests] == [["a.md", "c.md", "e.md"], ["b.md", "d.md", "f.md"]]
    assert all(s["phase"] == "digest" for s in digests)
    assert [s["focus"] for s in merge] == [[]]  # 汇总步不读材料，它看的是各路的产出
    assert sorted(m for s in reads for m in s["focus"]) == sorted(mats)  # 不重不漏
    # 串行那两种形状不分工（它们本来就是一棒接一棒）
    for pattern in ("pipeline", "review"):
        assert all(not s["focus"] for s in collab.build_steps(pattern, [_A, _B], mats))


def test_the_fanout_read_wave_gives_every_step_exactly_one_material():
    """**②那条挂账的落地**：一步的活要小到能在 3 轮里做完。

    实测的瓶颈：每步 3 轮，而「找文件 + 读 + 提炼 + 成文」挤在一步里必然烧光
    （B 轮 `fanout` 四步全交占位符、C 轮 `review` 也烧光）。所以读那一波**一步只读一份**——
    这样它最多花 1 轮读 + 1 轮答，怎么都用不完 3 轮。
    """
    mats = [f"notes/m{i}.md" for i in range(6)]
    reads = collab.build_waves("fanout", [_A, _B, _A], mats)[0]
    assert len(reads) == len(mats)
    assert all(len(s["focus"]) == 1 for s in reads)
    assert all(s["title"].startswith("读材料 · ") for s in reads)
    # 读的活**不落给同一个人**：按材料顺序轮流（与结论那一波的切片对得上）
    assert [s["agent"]["name"] for s in reads] == ["写手", "评审", "写手", "写手", "评审", "写手"]
    # 没材料时**不拆**（拆出来的是空活）：回到单段式，v1 的形状一个字没变
    assert [s["phase"] for s in collab.build_steps("fanout", [_A, _B])] == ["work", "work", "merge"]


def test_the_digest_step_sees_only_its_own_reads(monkeypatch):
    """读产出**按路径**分发给结论步：写手只看自己那几份，不能顺手看见评审的。

    给它全部就等于把那几路的墙拆了——fanout 的价值正在于几路互不影响地成稿。
    """
    mats = ["notes/x.md", "notes/y.md"]
    calls: list[dict] = []

    async def fake(provider, model, messages, tools, run_tool, emit_text, emit_tool, **kw):  # noqa: ARG001
        """**按提示词决定吐什么**，不按调用次序——两路是并发跑的，次序不保证。

        （第一版写的是「第 N 次调用吐 outputs[N]」，于是并发下 x 的读产出可能落到 y 那一步，
        断言就会随机红——与 `test_fanout_wave_runs_branches_concurrently` 那条同族。）
        """
        body = messages[-1]["content"]
        calls.append({"model": model, "messages": [dict(m) for m in messages]})
        if "【你负责的材料（已读，事实如下）】" in body:
            text = "这一路的结论"
        else:
            text = "x 里读到 0.6176" if "notes/x.md" in body else "y 里读到 0.5"
        for ch in text:
            emit_text(ch)
        trace = kw.get("trace")
        if trace is not None:
            trace["rounds"] = 1
            trace["tool_calls"] = []
        return text

    monkeypatch.setattr(delegate, "run_agentic_chat", fake)
    events = _run(collab.run("读两份材料", [_A, _B], "fanout", _resolve(""), materials=mats))
    done = events[-1][1]
    assert done["ok"] is True
    assert [f["phase"] for f in done["facts"]] == ["read", "read", "digest", "digest", "merge"]

    def _digest_prompt(model: str) -> str:
        bodies = [
            c["messages"][-1]["content"]
            for c in calls
            if c["model"] == model and "（已读，事实如下）" in c["messages"][-1]["content"]
        ]
        assert len(bodies) == 1, f"{model} 的结论步应当正好一次"
        return bodies[0]

    mine, yours = _digest_prompt("p/m1"), _digest_prompt("p/m2")
    # 路径与**读出来的内容**都只给自己那一份
    assert "notes/x.md" in mine and "0.6176" in mine
    assert "notes/y.md" not in mine and "0.5" not in mine
    assert "notes/y.md" in yours and "0.5" in yours
    assert "0.6176" not in yours


def test_split_materials_is_even_and_stable():
    assert collab.split_materials(["a", "b", "c"], 2) == [["a", "c"], ["b"]]
    assert collab.split_materials([], 3) == [[], [], []]
    assert collab.split_materials(["a", "b"], 0) == [["a", "b"]]  # 0 路 → 当 1 路，不除零
    # 顺序稳定：同一批材料每次分到的一样（两次跑才可比）
    mats = [f"m{i}.md" for i in range(7)]
    assert collab.split_materials(mats, 3) == collab.split_materials(list(mats), 3)


def test_the_focus_reaches_the_branch_prompt():
    """分到的材料要**真的写进那一路的提示词**，否则分工只是账上好看。"""
    step = collab.build_steps("fanout", [_A, _B], ["notes/x.md", "notes/y.md"])[0]
    user = collab.compose_messages(step, "目标", None, "", "")[-1]["content"]
    assert "notes/x.md" in user and "你负责的材料" in user
    assert "不用去列目录" in user  # 明确别把轮数浪费在列目录上
    # 没分工时不出现这一段
    plain = collab.compose_messages({"agent": _A, "phase": "work", "title": "t"}, "目标", None, "", "")
    assert "你负责的材料" not in plain[-1]["content"]


def test_fanout_wave_runs_branches_concurrently(monkeypatch):
    """**并行那一波是真的同时在跑**：两路各自等同一个事件，串行跑就会死等。

    这是「并行由编排器定义」的正面证据——不是看代码猜，是让它跑给你看。
    """
    order: list[str] = []
    gate = asyncio.Event()
    started = 0

    async def fake(provider, model, messages, tools, run_tool, emit_text, emit_tool, **kw):  # noqa: ARG001
        nonlocal started
        started += 1
        order.append(f"start:{model}")
        if started >= 2:  # 两路都到了 → 放行（串行的话第二路永远不会到）
            gate.set()
        await asyncio.wait_for(gate.wait(), timeout=5)
        text = f"{model} 的一路"
        emit_text(text)
        trace = kw.get("trace")
        if trace is not None:
            trace["rounds"] = 1
            trace["tool_calls"] = []
        return text

    monkeypatch.setattr(delegate, "run_agentic_chat", fake)
    events = _run(collab.run("并行目标", [_A, _B], "fanout", _resolve("")))
    done = events[-1][1]
    assert done["ok"] is True
    # **两路都开跑了**（顺序不断言）：`gather` 的调度顺序本来就不保证，第一版写的是
    # `order[:2] == ["start:p/m1", "start:p/m2"]`，②改形状时它抖了一次——而并行的证据
    # 从来不是顺序，是下面那道闸门：串行跑的话第二路永远到不了 `gate.set()`。
    assert set(order[:2]) == {"start:p/m1", "start:p/m2"}
    assert started >= 2, "两路必须同时在路上（串行的话第二路到不了这里）"
    # 汇总那一步拿得到两路的产出
    merge = [f for f in done["facts"] if f["phase"] == "merge"]
    assert len(merge) == 1
    # 头部与 meta 都要说清这是并行那一版（界面上看得见）
    assert events[0][1]["parallel"] is True
    head = next(d["text"] for e, d in events if e == "delta")
    assert "并行" in head


def test_fanout_merge_prompt_lists_every_branch_including_the_failed_one(monkeypatch):
    """某一路失败**不拖垮整轮**，而且汇总步要看见「那一路失败」——不能装作没跑。"""
    seen_merge: list[dict] = []

    async def fake(provider, model, messages, tools, run_tool, emit_text, emit_tool, **kw):  # noqa: ARG001
        if model == "p/m2":
            raise RuntimeError("这一路挂了")
        if "汇总结论" in messages[-1]["content"] or "合成" in messages[-1]["content"]:
            seen_merge.append({"messages": [dict(m) for m in messages]})
        text = "一路产出" if model == "p/m1" else "汇总结论"
        emit_text(text)
        trace = kw.get("trace")
        if trace is not None:
            trace["rounds"] = 1
            trace["tool_calls"] = []
        return text

    monkeypatch.setattr(delegate, "run_agentic_chat", fake)
    events = _run(collab.run("并行目标", [_A, _B], "fanout", _resolve("")))
    done = events[-1][1]
    errs = [d["message"] for e, d in events if e == "error"]
    assert any("这一路挂了" in m for m in errs)  # 失败了，而且说出来了
    assert done["ok"] is False
    # 汇总步仍然跑了（没有被那一路拖垮），并且提示词里带着失败的事实
    assert seen_merge, "汇总步应当仍然执行"
    merge_prompt = seen_merge[0]["messages"][-1]["content"]
    assert "这一路挂了" in merge_prompt and "一路产出" in merge_prompt


def test_agent_whitelist_bounds_the_step_tools(monkeypatch):
    """agent 的 `tool_whitelist` 是**上限**：`none` 让这一步一个工具都拿不到（A2 字段升级）。"""
    from app.db import engine
    from app.models import Agent, Base

    async def reset_and_add():
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
            await conn.run_sync(Base.metadata.create_all)
        from app.db import SessionLocal

        async with SessionLocal() as db:
            db.add(Agent(name="写手", avatar="✍️", system_prompt="你是写手", tool_whitelist="none"))
            await db.commit()

    asyncio.run(reset_and_add())
    got: list[list] = []

    async def fake(provider, model, messages, tools, run_tool, emit_text, emit_tool, **kw):  # noqa: ARG001
        got.append(tools or [])
        emit_text("嗯")
        trace = kw.get("trace")
        if trace is not None:
            trace["rounds"] = 1
            trace["tool_calls"] = []
        return "嗯"

    monkeypatch.setattr(delegate, "run_agentic_chat", fake)
    agent = {"name": "写手", "avatar": "✍️", "system_prompt": "你是写手", "model_id": "p/m1"}
    events = _run(collab.run("目标", [agent, _B], "pipeline", _resolve("")))
    assert events[-1][1]["ok"] is True
    assert got and got[0] == [], "白名单是 none 的 agent，这一步的工具清单必须是空的"
