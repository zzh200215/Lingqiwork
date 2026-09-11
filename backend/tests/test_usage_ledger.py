"""模型用量账本（PLAN §10.2「成本」）的离线测试。

重点在**不重复记账**：聊天（`messages`）与定时任务（`task_runs`）各自有列，账本只收其余
路径。所以两件事必须成立——`note()` 在 span 外是空操作；`_absorb_usage` 有 `usage_out`
时绝不碰账本。把这条搞错，总额会悄悄翻倍，而且没人看得出来。

每个用例用**各自的 kind**，互不干扰（真库里 kind 是操作名，这里只是标签）。
"""
import asyncio

from sqlalchemy import select

from app.core import usage_ledger as ul

# ---------- 沙箱库：span 退出要写 model_usage ----------

from app.db import SessionLocal, engine as _engine  # noqa: E402
from app.models import Base as _Base, ModelUsage  # noqa: E402


async def _init_db():
    async with _engine.begin() as conn:
        await conn.run_sync(_Base.metadata.create_all)


asyncio.run(_init_db())


class _Usage:
    """假的 provider usage 对象（Anthropic 形状）。"""

    def __init__(self, i, o):
        self.input_tokens = i
        self.output_tokens = o


def _rows(kind: str) -> list:
    async def go():
        async with SessionLocal() as db:
            return (
                (await db.execute(select(ModelUsage).where(ModelUsage.kind == kind)))
                .scalars()
                .all()
            )

    return asyncio.run(go())


# ---------- span 之外：绝不记账 ----------


def test_note_outside_a_span_is_dropped():
    ul.note("m", 100, 50)
    assert _rows("k_outside") == []
    assert ul.active() is False


def test_active_reflects_the_span():
    assert ul.active() is False

    async def go():
        async with ul.span("k_active", "1"):
            assert ul.active() is True
        assert ul.active() is False

    asyncio.run(go())


# ---------- span：累积 → 退出时按模型落行 ----------


def test_span_writes_one_row_per_model():
    async def go():
        async with ul.span("k_row", "asyncio 调度"):
            ul.note("qwen", 100, 20)
            ul.note("qwen", 30, 5)
            ul.note("gpt", 7, 3)

    asyncio.run(go())
    rows = {r.model_id: r for r in _rows("k_row")}
    assert set(rows) == {"qwen", "gpt"}
    assert (rows["qwen"].tokens_in, rows["qwen"].tokens_out, rows["qwen"].calls) == (130, 25, 2)
    assert rows["gpt"].calls == 1
    assert rows["qwen"].ref == "asyncio 调度"


def test_span_with_nothing_noted_writes_nothing():
    async def go():
        async with ul.span("k_empty", "空跑"):
            pass

    asyncio.run(go())
    assert _rows("k_empty") == []


def test_concurrent_spans_do_not_mix():
    """span 是 contextvar：两个并发操作的账不能串到一起。"""

    async def one(kind: str, model: str):
        async with ul.span(kind, kind):
            await asyncio.sleep(0)  # 让出控制权，逼出串账的机会
            ul.note(model, 10, 1)

    async def go():
        await asyncio.gather(one("k_conc_a", "a"), one("k_conc_b", "b"))

    asyncio.run(go())
    assert [r.model_id for r in _rows("k_conc_a")] == ["a"]
    assert [r.model_id for r in _rows("k_conc_b")] == ["b"]


# ---------- _absorb_usage 的分叉：有账本填账本，没有才记账本 ----------


def test_absorb_usage_fills_the_callers_accumulator_and_not_the_ledger():
    """聊天 / 定时任务那条路径：有 usage_out 就只填它，账本一个字都不该多。"""
    from app.core.llm import _absorb_usage

    acc: dict = {}

    async def go():
        async with ul.span("k_own", "不该被记"):
            _absorb_usage(acc, _Usage(11, 22), "m")

    asyncio.run(go())
    assert acc == {"input": 11, "output": 22}
    assert _rows("k_own") == []  # span 里没发生 note → 不落行


def test_absorb_usage_without_an_accumulator_goes_to_the_ledger():
    from app.core.llm import _absorb_usage

    async def go():
        async with ul.span("k_ledger", "谁恢复协程"):
            _absorb_usage(None, _Usage(9, 4), "qwen")

    asyncio.run(go())
    row = _rows("k_ledger")[0]
    assert (row.tokens_in, row.tokens_out, row.calls) == (9, 4, 1)


def test_both_provider_usage_shapes_are_read():
    """OpenAI 用 prompt/completion_tokens，Anthropic 用 input/output_tokens。"""
    from app.core.llm import _absorb_usage

    class _OpenAIUsage:
        prompt_tokens = 5
        completion_tokens = 6

    acc: dict = {}
    _absorb_usage(acc, _OpenAIUsage(), "m")
    assert acc == {"input": 5, "output": 6}


def test_a_none_usage_object_is_ignored():
    from app.core.llm import _absorb_usage

    acc: dict = {}
    _absorb_usage(acc, None, "m")
    assert acc == {}


# ---------- traced：两种入口形状都能套上 ----------


def test_traced_wraps_a_generator_and_opens_a_span():
    @ul.traced("k_traced")
    async def gen(topic, *, extra=""):
        assert ul.active() is True
        ul.note("m", 1, 2)
        yield "e", {"topic": topic, "extra": extra}

    async def go():
        return [ev async for ev in gen("话题", extra="x")]

    assert asyncio.run(go()) == [("e", {"topic": "话题", "extra": "x"})]
    row = _rows("k_traced")[0]
    assert (row.ref, row.tokens_in, row.tokens_out) == ("话题", 1, 2)


def test_traced_wraps_a_coroutine():
    """入口形状不一（`roundtable.run` 之类直接返回结果，不是生成器）。"""

    @ul.traced("k_coro")
    async def work(name):
        ul.note("m", 5, 5)
        return name.upper()

    assert asyncio.run(work("abc")) == "ABC"
    assert _rows("k_coro")[0].ref == "abc"


def test_span_is_settled_once_the_generator_finishes():
    @ul.traced("k_closed")
    async def gen():
        ul.note("m", 1, 1)
        yield 1

    async def go():
        out = [x async for x in gen()]
        assert ul.active() is False  # 跑完就结算，不会漏在 context 里
        return out

    assert asyncio.run(go()) == [1]


def test_traced_without_a_first_arg_leaves_the_ref_empty():
    @ul.traced("k_noref")
    async def work():
        ul.note("m", 1, 1)

    asyncio.run(work())
    assert _rows("k_noref")[0].ref == ""


def test_usage_summary_counts_the_ledger_and_groups_by_kind():
    from app.core import cost

    async def go():
        async with ul.span("k_summary", "开销测试"):
            ul.note("qwen-k", 1000, 200)
        return await cost.usage_summary(30)

    s = asyncio.run(go())
    assert s["ledger_calls"] >= 1
    assert s["by_kind"]["k_summary"] == {"in": 1000, "out": 200, "calls": 1}
    assert s["by_model"]["qwen-k"]["total"] >= 1200
    assert s["by_day"]  # 按天趋势也要带上账本那条腿
