"""回合账本（W5）的测试：记什么、怎么读、什么时候不许影响正在做的事。

这一层最容易出的不是写错列，是**把「没查」读成「查了没问题」**，以及**记账坏了连累
那一轮**。所以下面专门有几条盯这两件事。
"""
import asyncio
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


# ---------- P3：引用那两个计数 ----------


async def test_the_citation_counts_land_in_their_own_columns():
    """P3 把「注入几条 / 引用几条」搬进了正式列（v15）—— 挂在 `quality_json` 里读得出来、
    **聚合不出来**，而这两个数就是要聚合的（连续多轮「注入 5 条引用 0 条」是检索质量下滑
    最早的信号）。"""
    await _reset()
    draft = tt.begin(conversation_id=1, model_id="m")
    draft["sources_injected"] = 5
    draft["sources_cited"] = 2
    row = await tt.finish(draft)
    assert row["sources_injected"] == 5 and row["sources_cited"] == 2

    from sqlalchemy import select as _select

    from app.db import SessionLocal

    async with SessionLocal() as db:
        got = (
            await db.execute(_select(TurnTrace.sources_injected, TurnTrace.sources_cited))
        ).first()
    assert (got[0], got[1]) == (5, 2), "只写进 JSON 是不够的：这两列要能被聚合查询读到"


async def test_the_citation_counts_default_to_zero_not_null():
    """没跑 RAG 的那一轮注入就是 0（它确实一条材料都没注入）。**不编 NULL**：
    真库那一列有 DEFAULT 0，模型读回来是 int。"""
    await _reset()
    row = await tt.finish(tt.begin(conversation_id=1, model_id="m"))
    assert row["sources_injected"] == 0 and row["sources_cited"] == 0


def test_fake_citation_reads_the_verdict_the_online_check_wrote():
    """毛病这一栏**只读 `quality["citations"]["stripped"]`** —— 判据在 `core/citations.py`，
    界面与账本都不自己再识别一遍（那会是第二份实现，分叉的那天这个数就没人敢信）。"""
    row = _row()
    row["quality"] = {"citations": {"injected": 5, "stripped": [7]}}
    assert tt._matches(row, "fake_citation") is True
    # 验过、但一个都没剥 → 这一栏不亮（「查了没问题」不是「没查」）
    row["quality"] = {"citations": {"injected": 5, "stripped": []}}
    assert tt._matches(row, "fake_citation") is False
    # 老行（P3 之前）没有这一项 → 不亮，也不许当成异常
    assert tt._matches(_row(), "fake_citation") is False


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
        [
            # 两个都得广告出来：执行层只放行本轮广告过的工具（BUG-008），否则 save_artifact
            # 会被当「未授权」拦下，测不到它真跑起来又抛错、被记成 ok=False 的那条路。
            {"type": "function", "function": {"name": "kb_search", "parameters": {}}},
            {"type": "function", "function": {"name": "save_artifact", "parameters": {}}},
        ],
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
     "retried", "repaired", "invented_path", "dropped_receipt", "over", "rewrote"],
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


async def test_the_length_facts_get_their_own_filters():
    """W4：超没超、写了几版，都从服务端写下的那一栏读 —— 界面不重算。"""
    await _reset()
    d = tt.begin(conversation_id=11, model_id="m")
    d["quality"] = {"length": {"budget": 300, "hard": False, "chars": 412, "over": True, "saves": 2}}
    row = await tt.finish(d)
    assert {"over", "rewrote"} <= set(row["flags"])

    # 没认预算的那一轮：没有「超」这回事，也不该被标成重写
    d2 = tt.begin(conversation_id=12, model_id="m")
    d2["quality"] = {"length": {"budget": None, "hard": None, "chars": 900, "over": False, "saves": 1}}
    row2 = await tt.finish(d2)
    assert "over" not in row2["flags"] and "rewrote" not in row2["flags"]


# ---------- R1：回合读数上墙（PLAN5 §3 R1） ----------
#
# 这一栏要上的是仪表盘那面墙，所以这里钉的不是「算得对不对」而已，而是**它不变成考核表**：
# 只给计数、不给比率，读不到就说读不到。


async def _age_row(conversation_id: int, hours: float) -> None:
    """把某一轮往前挪 —— 窗口边界只有真比时间才验得出来。

    **按 `conversation_id` 认行，不按「最新/最早那一行」**：靠顺序认行，改一条用例的
    插入顺序就会静默挪错行，而症状是另一条断言莫名其妙地挂（这里第一版就是这么挂的）。

    它也是 `async def`（与 `_three_turns` 一致）：在 `async def` 用例里调 `asyncio.run`
    会撞上「cannot be called from an already running event loop」。
    """
    from datetime import timedelta

    from sqlalchemy import select as _select

    from app.db import SessionLocal
    from app.models import TurnTrace as _TT, utcnow

    async with SessionLocal() as db:
        row = (
            await db.execute(
                _select(_TT).where(_TT.conversation_id == conversation_id).order_by(_TT.id.desc())
            )
        ).scalars().first()
        assert row is not None, f"没有 conversation_id={conversation_id} 那一轮"
        row.created_at = utcnow() - timedelta(hours=hours)
        await db.commit()


async def _three_turns() -> None:
    """三条各带一种毛病的事实 + 一条干净的。"""
    await _reset()
    lie = tt.begin(conversation_id=1, model_id="m")
    tt.note_claim(lie, "已存入产出：周报", [])
    await tt.finish(lie)

    multi = tt.begin(conversation_id=2, model_id="m")
    multi["artifacts"] = [{"path": "a"}, {"path": "b"}]
    await tt.finish(multi)

    clean = tt.begin(conversation_id=3, model_id="m")
    clean["answer_chars"] = 20
    await tt.finish(clean)


async def test_summary_counts_each_flag_over_the_window():
    """每一格是**窗口内命中这一类毛病的回合数**，分母是窗口内跑过的回合数。"""
    await _three_turns()
    out = await tt.summary()
    assert out["readable"] is True and out["error"] == ""
    assert out["days"] == tt.SUMMARY_DAYS
    assert out["turns"] == 3 and out["total"] == 3
    assert out["truncated"] is False
    assert out["counts"]["lie"] == 1
    assert out["counts"]["multi"] == 1
    # 干净那一轮不制造任何毛病（一排 0 里只有这两格是 1）
    assert out["counts"]["slow"] == 0 and out["counts"]["error"] == 0


async def test_summary_has_a_key_for_every_filter():
    """每一类毛病都有一格 —— 少一格，界面上就是「这一类从来没发生过」的假象。"""
    await _three_turns()
    out = await tt.summary()
    assert [f["key"] for f in out["filters"]] == [f["key"] for f in tt.FILTERS]
    assert set(out["counts"]) == {f["key"] for f in tt.FILTERS}


# ---------- P3：材料那几个读数 ----------


async def _citation_turns() -> None:
    """四条各一种材料形态：用了材料的、一点没引用的、没检索的、注入了但全引用不存在的。"""
    await _reset()
    used = tt.begin(conversation_id=11, model_id="m")
    used["sources_injected"] = 5
    used["sources_cited"] = 2
    await tt.finish(used)

    ignored = tt.begin(conversation_id=12, model_id="m")
    ignored["sources_injected"] = 4
    ignored["sources_cited"] = 0
    await tt.finish(ignored)

    # 没检索的那一轮（闲聊跳过 / RAG 关）：注入 0 —— **不许进材料那几个数的分母**
    skipped = tt.begin(conversation_id=13, model_id="m")
    skipped["quality"] = {"channel": {"channel": "skip", "level": "rule"}}
    await tt.finish(skipped)


async def test_summary_counts_material_usage_without_a_rate():
    """P3：材料用掉了几条 —— **两个计数 + 一个「有材料却没引用」的回合数，一个比率都没有**。

    分母是**注入过材料的回合**（2 条），不是窗口里的回合总数（3 条）：没检索的那一轮注入
    本来就是 0，把它算进来就是把「没检索」读成「检索了没人用」（`_SUMMARY_RULES["sources"]`）。
    """
    await _citation_turns()
    out = await tt.summary()
    assert out["turns"] == 3
    src = out["sources"]
    assert src == {"turns_with_material": 2, "injected": 9, "cited": 2, "uncited_turns": 1}


async def test_summary_says_so_when_it_cannot_read_the_material_counts(monkeypatch):
    """读不到时材料那一块**也要有形状**（界面照 `readable` 摆「读不出来」，不摆一排 0）。"""
    await _citation_turns()

    async def boom(_since, _cap):
        raise RuntimeError("db down")

    monkeypatch.setattr(tt, "_summary_rows", boom)
    out = await tt.summary()
    assert out["readable"] is False
    assert out["sources"] == {
        "turns_with_material": 0,
        "injected": 0,
        "cited": 0,
        "uncited_turns": 0,
    }
    assert out["rules"]["sources"], "口径要跟着读数一起给出去，界面照抄"


async def test_summary_leaves_out_what_is_outside_the_window():
    """窗口之外的行不算 —— 否则「最近 30 天」会慢慢变成「从装那天起」。"""
    await _three_turns()
    await _age_row(conversation_id=2, hours=24 * 40)  # 那条「多份」挪到 40 天前
    out = await tt.summary(days=30)
    assert out["turns"] == 2 and out["total"] == 2
    assert out["counts"]["multi"] == 0  # 被挪走的那一条
    assert out["counts"]["lie"] == 1  # 还在窗口里的照旧数得到


async def test_summary_says_so_when_it_cannot_read(monkeypatch):
    """读不到就 `readable=false`，**不拿一排 0 充数**（§4-8：读不到 ≠ 零）。"""
    await _three_turns()

    async def boom(_since, _cap):
        raise RuntimeError("db down")

    monkeypatch.setattr(tt, "_summary_rows", boom)
    out = await tt.summary()
    assert out["readable"] is False
    assert "db down" in out["error"]
    assert out["turns"] == 0
    assert set(out["counts"].values()) == {0}  # 形状还在（界面不必判空），但 readable 说明了真相


async def test_summary_says_so_when_it_had_to_stop_counting():
    """库很大时只数最近 N 轮 —— **截断了要说出来**，不静默少算。"""
    await _three_turns()
    out = await tt.summary(max_rows=1)
    assert out["turns"] == 1
    assert out["total"] == 3  # 窗口里真实有三轮
    assert out["truncated"] is True


async def test_summary_hands_out_its_rules_and_no_rate():
    """口径随读数一起给（界面照抄），而且**这里没有比率**。"""
    await _three_turns()
    out = await tt.summary()
    for key in ("window", "counts", "no_rate", "truncated"):
        assert out["rules"][key]
    # 红线（§4-2 / 本模块开篇）：诊断工具不是考核仪表 —— 不给成功率，一个都不给
    assert not any("rate" in k or "ratio" in k or "percent" in k for k in out)


async def test_reading_the_summary_makes_the_pet_say_nothing():
    """R1 的红线：这面墙**不进零柒嘴里**（与 `metrics` / `calibration` 同一条）。

    跑完读数，宠物那边一个字都不该多出来（`pet_events` 是它说话的账本）。
    """
    await _three_turns()
    await tt.summary()

    from app.core import pet as pet_core

    assert pet_core.feed(limit=50) == []


def test_the_module_has_no_way_to_speak():
    """比上一条更硬：光测「这一次没说话」不够，真正的风险是下一个人顺手在这里 emit 一句。

    `turn_trace` 与宠物那条线**一处都不该连**——它连本地日换算都不需要。
    """
    import re
    from pathlib import Path

    src = Path(tt.__file__).read_text(encoding="utf-8")
    body = src.split('"""', 2)[2]  # 去掉模块 docstring
    assert re.findall(r"\bpet\.(\w+)", body) == []
    for banned in ("emit", "note_output", "compose", "feed", "greeting"):
        assert f"pet.{banned}" not in body, banned


def test_http_summary_endpoint(monkeypatch):
    """墙上的那一格走的是 `/api/dashboard/turns`（R1 决定：扩现有 /dashboard，不新增导航）。"""
    asyncio.run(_three_turns())
    monkeypatch.setenv("WB_API_TOKEN", "t")
    from fastapi.testclient import TestClient

    from app.core import auth
    from app.main import app

    monkeypatch.setattr(auth, "_cached", None)
    c = TestClient(app)
    h = {"X-WB-Token": "t"}

    assert c.get("/api/dashboard/turns").status_code == 401
    body = c.get("/api/dashboard/turns", headers=h).json()
    assert body["readable"] is True
    assert body["turns"] == 3 and body["counts"]["lie"] == 1
    assert "window" in body["rules"]
