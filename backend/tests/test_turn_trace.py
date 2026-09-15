"""回合账本（W5）的测试：记什么、怎么读、什么时候不许影响正在做的事。

这一层最容易出的不是写错列，是**把「没查」读成「查了没问题」**，以及**记账坏了连累
那一轮**。所以下面专门有几条盯这两件事。
"""
import sys
import time

import pytest

sys.path.insert(0, ".")

from app.core import llm  # noqa: E402
from app.core import turn_trace as tt  # noqa: E402
from app.core.llm import ProviderInfo, ToolCall  # noqa: E402
from app.db import engine  # noqa: E402
from app.models import Base, TurnTrace  # noqa: E402


async def _reset() -> None:
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)
        await conn.run_sync(Base.metadata.create_all)


# ---------- 纯函数：筛选项就是实测到的那几类毛病 ----------


def test_the_filters_are_the_measured_failure_modes():
    """筛选项就是实测到的那几类毛病 —— 一条都不能丢，也不许重号。

    **不写死整个列表**：W2a 往里加了四条（补跑过 / 补跑补上了 / 报了个不存在的路径 /
    回执没给出去），写死整串的断言会把一次正常的追加报成失败，于是下次真丢了一条时
    这条断言已经被人改麻了。这里钉的是「一条都不许少」。
    """
    keys = [f["key"] for f in tt.FILTERS]
    assert keys[:2] == ["lie", "no_save"]  # 第一版那两条最重的排最前，顺序别动
    assert {"multi", "slow", "expensive", "error"} <= set(keys)
    assert {"retried", "repaired", "invented_path", "dropped_receipt"} <= set(keys)
    assert len(keys) == len(set(keys))
    assert all(f["label"] and f["hint"] for f in tt.FILTERS)


def _row(**patch) -> dict:
    base = {
        "claim_checked": False,
        "claim_truthful": True,
        "artifacts": [],
        "answer_chars": 0,
        "seconds": 1.0,
        "tokens_out": 100,
        "error": "",
    }
    base.update(patch)
    return base


def test_lie_needs_a_check_that_actually_ran():
    """**没查过 ≠ 查了没问题。** 把两者混起来，「谎报率」这个数就没人敢信。"""
    assert tt._matches(_row(claim_checked=False, claim_truthful=False), "lie") is False
    assert tt._matches(_row(claim_checked=True, claim_truthful=False), "lie") is True
    assert tt._matches(_row(claim_checked=True, claim_truthful=True), "lie") is False


def test_no_save_means_long_body_and_no_receipt():
    assert tt._matches(_row(answer_chars=tt.LONG_BODY_CHARS, artifacts=[]), "no_save") is True
    assert tt._matches(_row(answer_chars=tt.LONG_BODY_CHARS - 1), "no_save") is False
    # 有回执就不算「该存没存」——它存了
    assert tt._matches(_row(answer_chars=999, artifacts=[{"path": "a"}]), "no_save") is False


def test_multi_slow_expensive_error():
    assert tt._matches(_row(artifacts=[{"path": "a"}, {"path": "b"}]), "multi") is True
    assert tt._matches(_row(artifacts=[{"path": "a"}]), "multi") is False
    assert tt._matches(_row(seconds=tt.SLOW_SECONDS), "slow") is True
    assert tt._matches(_row(tokens_out=tt.EXPENSIVE_OUT), "expensive") is True
    assert tt._matches(_row(error="boom"), "error") is True


# ---------- 写一行 ----------


async def test_a_turn_writes_one_row_with_the_tool_loop():
    await _reset()
    draft = tt.begin(conversation_id=7, model_id="p/m")
    draft["rounds"] = 3
    draft["tool_calls"] = [
        {"name": "kb_search", "args_chars": 40, "result_chars": 900, "ms": 120, "ok": True}
    ]
    draft["artifacts"] = [{"kind": "deliver", "path": "deliver/a.md"}]
    draft["answer_chars"] = 320
    # 时长是账本自己量的：把开始时刻往前挪，验证它真的量了，而不是记了个 0
    draft["_t0"] = time.monotonic() - 12.5
    # 有回执 → 那句话不算谎报，哪怕正文里说了「已经写好了，没有存」
    assert tt.note_claim(draft, "已经写好了，没有存。", draft["artifacts"]) is True

    row = await tt.finish(draft, usage={"input": 1200, "output": 800})
    assert row["conversation_id"] == 7 and row["model_id"] == "p/m"
    assert row["rounds"] == 3 and row["tool_calls"][0]["name"] == "kb_search"
    assert row["tokens_in"] == 1200 and row["tokens_out"] == 800
    assert row["artifacts"][0]["path"] == "deliver/a.md"
    assert row["answer_chars"] == 320
    assert row["claim_checked"] is True and row["claim_truthful"] is True
    assert 12 <= row["seconds"] < 20, f"耗时没量上：{row['seconds']}"
    # 时间戳必须带时区（naive UTC 直接给浏览器，这个仓库已经栽过三次）
    assert row["at"].endswith("+00:00")


async def test_a_lie_is_recorded_as_a_lie():
    await _reset()
    draft = tt.begin(conversation_id=1, model_id="m")
    assert tt.note_claim(draft, "已存入产出：周报", []) is False  # 说了，但没落盘
    row = await tt.finish(draft)
    assert row["claim_checked"] is True and row["claim_truthful"] is False


async def test_finishing_without_a_draft_is_a_no_op():
    await _reset()
    assert await tt.finish(None) is None


async def test_a_broken_ledger_never_breaks_the_turn(monkeypatch):
    """账本坏了不能连累已经答完的那一轮 —— 与 `usage_ledger` 同级的要求。"""
    await _reset()

    async def boom(_draft, _usage, _error):
        raise RuntimeError("账本写不进去")

    monkeypatch.setattr(tt, "_write", boom)
    draft = tt.begin(conversation_id=1, model_id="m")
    assert await tt.finish(draft, usage={"input": 1, "output": 2}) is None
    assert tt.current() is None  # 草稿也清掉了，不留着串到下一轮


async def test_current_is_the_draft_the_tool_loop_fills():
    await _reset()
    draft = tt.begin(conversation_id=2, model_id="m")
    assert tt.current() is draft
    await tt.finish(draft)
    assert tt.current() is None


# ---------- 工具循环真的把数填进去了吗 ----------


class _FakeClient:
    async def close(self):
        pass


async def test_run_agentic_chat_fills_the_trace(monkeypatch):
    """轮数、每个工具的耗时与大小 —— 这些数以前只活在界面事件里，落不了盘。"""
    scripted = [
        ("", [ToolCall("1", "kb_search", {"q": "x"}), ToolCall("2", "save_artifact", {"a": 1})]),
        ("写好了", []),
    ]
    it = iter(scripted)

    async def fake_round(client, model, messages, tools, emit_text, usage_out=None):  # noqa: ARG001
        text, calls = next(it)
        if text:
            emit_text(text)
        return text, calls

    monkeypatch.setattr(llm, "_openai_round", fake_round)
    monkeypatch.setattr(llm, "_openai_client", lambda p: _FakeClient())  # noqa: ARG005

    async def run_tool(name, args):  # noqa: ARG001
        if name == "save_artifact":
            raise RuntimeError("落盘失败")  # 失败也要记一笔，而且要标 ok=False
        return "x" * 50

    trace: dict = {}
    text = await llm.run_agentic_chat(
        ProviderInfo(kind="openai", base_url="", api_key="k"),
        "m",
        [{"role": "user", "content": "写份周报"}],
        [{"type": "function", "function": {"name": "kb_search", "parameters": {}}}],
        run_tool=run_tool,
        emit_text=lambda t: None,
        emit_tool=lambda n, a: None,
        trace=trace,
    )

    assert text == "写好了"
    assert trace["rounds"] == 2  # 第一轮调工具，第二轮收尾
    assert [c["name"] for c in trace["tool_calls"]] == ["kb_search", "save_artifact"]
    ok_call = trace["tool_calls"][0]
    assert ok_call["ok"] is True and ok_call["result_chars"] == 50
    assert ok_call["args_chars"] > 0 and ok_call["ms"] >= 0
    assert trace["tool_calls"][1]["ok"] is False  # 炸了也是一条事实，不能悄悄少一条
    # **不记正文**：trace 是诊断账本，正文该在 vault 里
    assert "content" not in ok_call and "result" not in ok_call


async def test_run_agentic_chat_still_works_without_a_trace(monkeypatch):
    """没给 trace 的调用方（定时任务、协作）一个字节都不用改。"""
    it = iter([("答完了", [])])

    async def fake_round(client, model, messages, tools, emit_text, usage_out=None):  # noqa: ARG001
        text, calls = next(it)
        if text:
            emit_text(text)
        return text, calls

    monkeypatch.setattr(llm, "_openai_round", fake_round)
    monkeypatch.setattr(llm, "_openai_client", lambda p: _FakeClient())  # noqa: ARG005
    text = await llm.run_agentic_chat(
        ProviderInfo(kind="openai", base_url="", api_key="k"),
        "m",
        [{"role": "user", "content": "x"}],
        [],
        run_tool=lambda n, a: None,
        emit_text=lambda t: None,
        emit_tool=lambda n, a: None,
    )
    assert text == "答完了"


# ---------- 读出来 ----------


async def test_recent_reads_back_and_filters():
    await _reset()
    for i in range(3):
        d = tt.begin(conversation_id=i, model_id="m")
        d["answer_chars"] = 500 if i == 0 else 10
        d["artifacts"] = [{"path": "a"}, {"path": "b"}] if i == 1 else []
        tt.note_claim(d, "已存入产出", d["artifacts"])
        await tt.finish(d, usage={"input": 10, "output": 20})

    allof = await tt.recent()
    assert len(allof["traces"]) == 3 and allof["filters"] and allof["only"] == ""
    nosave = await tt.recent(only="no_save")
    assert [t["conversation_id"] for t in nosave["traces"]] == [0]  # 长正文 + 没落盘
    multi = await tt.recent(only="multi")
    # 第 1 条：一轮两份 → multi（顺带说明它没被判成谎报：有回执）
    assert [t["conversation_id"] for t in multi["traces"]] == [1]
    assert all(t["claim_truthful"] for t in multi["traces"])


async def test_each_row_carries_its_own_flags():
    """毛病由核判定、随行返回 —— 界面不许再算一遍（同一个判断的第二份实现）。"""
    await _reset()
    d = tt.begin(conversation_id=9, model_id="m")
    d["answer_chars"] = 900
    # 时长是账本**自己量的**（不是调用方报的），所以这里把开始时刻往前挪，而不是写一个数
    d["_t0"] = time.monotonic() - 30.0
    tt.note_claim(d, "已存入产出：周报", [])  # 谎报 + 长正文没落盘 + 慢
    row = await tt.finish(d)

    assert set(row["flags"]) == {"lie", "no_save", "slow"}
    assert "multi" not in row["flags"] and "error" not in row["flags"]


def test_prompt_sha_matches_the_registry_algorithm():
    """与 `ArtifactFeedback` 同一把 key，才能把自动数和人点的满意率对照起来。"""
    from app.core import prompts

    sha = tt.prompt_sha()
    assert len(sha) == 12
    entry = next(
        p for p in prompts.inventory() if p.module == "app.routers.chat" and p.name == "_OUTPUT_RULE"
    )
    assert sha == entry.sha


def test_turn_trace_row_has_every_column_the_plan_asked_for():
    """列是对着 upgrade-plan §W5 那张清单写的，少一列就等于那个问题问不出来。"""
    cols = set(TurnTrace.__table__.columns.keys())
    for c in (
        "created_at", "conversation_id", "message_id", "model_id", "prompt_sha",
        "route_level", "route_kind", "rounds", "tool_calls_json", "tokens_in",
        "tokens_out", "artifacts_json", "answer_chars", "claim_checked",
        "claim_truthful", "retried", "quality_json", "seconds", "error",
    ):
        assert c in cols, f"少了 {c}"


@pytest.mark.parametrize(
    "key",
    ["", "lie", "no_save", "multi", "slow", "expensive", "error",
     "retried", "repaired", "invented_path", "dropped_receipt"],
)
def test_every_filter_key_is_a_keyword_the_core_knows(key):
    """界面只会传 `FILTERS` 里那几把 key；传了个没人认识的，`_matches` 会当成不筛。"""
    known = {f["key"] for f in tt.FILTERS}
    assert key == "" or key in known


# ---------- W2a：两条底线的结论也落在这里 ----------


async def test_the_quality_verdict_is_recorded_and_read_back():
    """这一轮该存的存了没、有没有编路径 —— 判定在 `core/turn_quality.py` 一处，
    账本只负责记下来。界面靠读它显示提示，不自己再算一遍。"""
    await _reset()
    d = tt.begin(conversation_id=7, model_id="m")
    d["retried"] = 1
    d["quality"] = {
        "findings": [
            {"code": "long_body_without_a_receipt", "detail": "正文 900 字却没落盘"},
            {"code": "invented_path", "detail": "回复里报了一个不在回执里的路径：recap/编的.md"},
        ],
        "asked_to_save": True,
        "repaired": False,
        "dropped_receipts": [{"path": "recap/编的.md", "why": "回执指向的文件不在盘上：recap/编的.md"}],
    }
    d["answer_chars"] = 900
    row = await tt.finish(d)

    assert row["quality"]["findings"][0]["code"] == "long_body_without_a_receipt"
    assert row["retried"] == 1
    # 「长正文没落盘」这件事**只有一份实现**：判据写进结论后，筛子读的是它
    assert set(row["flags"]) >= {"no_save", "retried", "invented_path", "dropped_receipt"}
    assert "repaired" not in row["flags"]  # 没修复就不许说修复了


async def test_an_old_row_without_a_quality_verdict_still_filters():
    """W2a 之前写下的行没有这一项 —— 那时的事实列（长度 + 有没有回执）照样能筛。"""
    await _reset()
    d = tt.begin(conversation_id=8, model_id="m")
    d["answer_chars"] = 900
    d["quality"] = {}
    row = await tt.finish(d)
    assert "no_save" in row["flags"]
    assert row["quality"] == {}
