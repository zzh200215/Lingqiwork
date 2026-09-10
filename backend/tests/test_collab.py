"""V14 collab tests: step planning, prompt composition, and the full run
event stream over a fake LLM. No network, no provider.
"""
import asyncio

import pytest

from app.core import collab

_A = {"name": "写手", "avatar": "✍️", "system_prompt": "你是写手", "model_id": "p/m1"}
_B = {"name": "评审", "avatar": "🔍", "system_prompt": "你是评审", "model_id": "p/m2"}


def _run(gen):
    async def collect():
        return [item async for item in gen]

    return asyncio.run(collect())


def _fake_llm(calls, outputs):
    """Monkeypatched stream_chat: records (model, messages), yields scripted output."""

    async def fake(info, model, messages):
        calls.append((model, messages))
        text = outputs[len(calls) - 1] if len(calls) <= len(outputs) else "默认输出"
        for chunk in text:
            yield chunk

    return fake


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
    monkeypatch.setattr(collab, "stream_chat", _fake_llm(calls, ["第一段输出", "第二段输出"]))

    async def fake_resolve(model_id):
        return ("fake-info", model_id or "p/default")

    events = _run(collab.run("目标X", [_A, _B], "pipeline", fake_resolve))

    kinds = [e for e, _ in events]
    assert kinds[0] == "meta" and kinds[-1] == "done"
    assert kinds.count("error") == 0
    done = events[-1][1]
    assert done["ok"] is True and done["steps"] == 2
    # transcript has header + both sections + both outputs
    assert "协作 · 流水线" in done["transcript"]
    assert "第一段输出" in done["transcript"] and "第二段输出" in done["transcript"]
    # each agent pinned model honored, empty falls back to resolve's default
    assert calls[0][0] == "p/m1" and calls[1][0] == "p/m2"
    # step 2 user content carries step 1 output
    assert "第一段输出" in calls[1][1][-1]["content"]


def test_run_review_loop(monkeypatch):
    calls: list = []
    monkeypatch.setattr(
        collab,
        "stream_chat",
        _fake_llm(calls, ["初稿正文", "意见1：补数据", "修订后的终稿"]),
    )

    async def fake_resolve(model_id):
        return ("fake-info", model_id or "p/default")

    events = _run(collab.run("目标Y", [_A, _B], "review", fake_resolve))
    assert events[-1][1]["ok"] is True
    # 3 LLM calls: draft(A), review(B), revise(A)
    assert len(calls) == 3
    assert calls[0][0] == "p/m1" and calls[1][0] == "p/m2" and calls[2][0] == "p/m1"
    # revise user content has both draft and review notes
    revise_user = calls[2][1][-1]["content"]
    assert "初稿正文" in revise_user and "意见1" in revise_user
    assert "修订后的终稿" in events[-1][1]["transcript"]


def test_run_mid_failure_reports_step(monkeypatch):
    calls: list = []

    async def failing(info, model, messages):
        calls.append(messages)
        if len(calls) == 1:
            yield "第一步没问题"
            return
        raise RuntimeError("网络炸了")

    monkeypatch.setattr(collab, "stream_chat", failing)

    async def fake_resolve(model_id):
        return ("fake-info", "p/x")

    events = _run(collab.run("目标Z", [_A, _B], "pipeline", fake_resolve))
    kinds = [e for e, _ in events]
    assert "error" in kinds
    err = next(d for e, d in events if e == "error")
    assert "第 2 步" in err["message"] and "RuntimeError" in err["message"]
    assert events[-1][0] == "done" and events[-1][1]["ok"] is False


def test_run_empty_step_output_errors(monkeypatch):
    calls: list = []
    monkeypatch.setattr(collab, "stream_chat", _fake_llm(calls, ["   "]) )

    async def fake_resolve(model_id):
        return ("fake-info", "p/x")

    events = _run(collab.run("目标W", [_A, _B], "pipeline", fake_resolve))
    err = next(d for e, d in events if e == "error")
    assert "返回空内容" in err["message"]


def test_run_with_retrieval(monkeypatch):
    calls: list = []
    monkeypatch.setattr(collab, "stream_chat", _fake_llm(calls, ["一", "二"]))
    retrieved: list = []

    async def fake_retrieve(q, k):
        retrieved.append((q, k))
        return [{"source": "notes/a.md", "text": "知识库片段"}]

    async def fake_resolve(model_id):
        return ("fake-info", "p/x")

    events = _run(collab.run("检索目标", [_A, _B], "pipeline", fake_resolve, fake_retrieve))
    kinds = [e for e, _ in events]
    assert "sources" in kinds
    assert retrieved == [("检索目标", collab.RAG_TOP_K)]
    # every pipeline "work" step sees the retrieved context
    assert all(any("知识库片段" in m["content"] for m in msgs) for _model, msgs in calls)


def test_run_rejects_bad_input():
    async def fake_resolve(model_id):
        return ("fake-info", "p/x")

    with pytest.raises(ValueError):
        _run(collab.run("  ", [_A, _B], "pipeline", fake_resolve))
    with pytest.raises(ValueError):
        _run(collab.run("目标", [_A], "pipeline", fake_resolve))
