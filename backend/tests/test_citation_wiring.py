"""P3 引用验证的**接线**测试：走产品自己那条路（`routers.chat._generate`）。

判据本身（哪些编号算编造、剥的时候多不吃一个字）在 `tests/test_citations.py` 钉着。
这里钉的是**动作**那半边，四件事：

1. 正文里编造的 `[来源 7]` → **从落库的正文里拿掉**，并回一帧 `citations` 带上干净正文
   （那几个编号已经随流到了屏幕上，不换掉就成「库里剥了、屏幕上还留着」）；
2. **不重生成**：模型只被调一次（打回重写要多一次调用，而且它第二遍可能再编一个）；
3. 两个计数进账本：`sources_injected` / `sources_cited` 是**正式列**（v15），
   不只是塞在 `quality_json` 里；
4. 真引用与「不是引用」的那几种写法**一个字都不动**。

模型调用是假的（`llm._openai_round` 换成剧本），检索也是假的（`chat.indexer_retrieve`），
所以这一条**不花钱、不依赖本地模型**。检索结果里**故意不给 `vec`**：那会让质量门判「材料
不足」，正好顺带验证「门不通过 + 引用验证」两条同时挂在同一轮上互不干扰。
"""
import asyncio
import json
import sys

from sqlalchemy import delete, select

sys.path.insert(0, ".")

from app.core import llm  # noqa: E402
from app.db import SessionLocal  # noqa: E402
from app.models import Conversation, Message, ProviderConfig  # noqa: E402
from app.routers import chat  # noqa: E402


class _NoClose:
    async def close(self):
        pass


def _sources(n: int) -> list[dict]:
    """n 条假命中。**不给 `vec`**：向量通道一条都没进 top-k，质量门会判「材料不足」。"""
    return [
        {
            "source": f"notes/m{i}.md",
            "title": f"材料 {i}",
            "chunk": 0,
            "score": 0.9 - i * 0.01,
            "text": f"第 {i} 条材料的正文。",
            "channels": ["bm25"],
        }
        for i in range(1, n + 1)
    ]


async def _prepare_db(conv_id: int) -> None:
    async with SessionLocal() as db:
        if (
            await db.execute(select(ProviderConfig).where(ProviderConfig.name == "stub"))
        ).scalar_one_or_none() is None:
            db.add(ProviderConfig(name="stub", kind="openai", base_url="", enabled=True))
            await db.commit()
        if await db.get(Conversation, conv_id) is None:
            db.add(Conversation(id=conv_id, title="t", model_id="stub/m"))
            await db.commit()
        from app.models import ModelProfile, ModelProfileChange

        await db.execute(delete(ModelProfileChange))
        await db.execute(delete(ModelProfile))
        await db.commit()


def _stub(monkeypatch, reply: str, sources_n: int, calls: list | None = None):
    """把模型、检索、通道预判三处都换成写死的 —— 这一条要测的不是它们。"""
    from app.core import channel as channel_gate

    seen: list[list[dict]] = []

    async def fake_round(client, model, messages, tools, emit_text, usage_out=None):  # noqa: ARG001
        seen.append([dict(m) for m in messages])
        for ch in reply:
            emit_text(ch)
        return reply, []

    async def fake_retrieve(query: str, top_k: int) -> list[dict]:  # noqa: ARG001
        return _sources(sources_n)

    if calls is not None:
        calls.append(seen)

    monkeypatch.setattr(llm, "_openai_round", fake_round)
    monkeypatch.setattr(llm, "_openai_client", lambda p: _NoClose())  # noqa: ARG005
    monkeypatch.setattr(chat, "indexer_retrieve", fake_retrieve)
    monkeypatch.setattr(chat, "_generate_followups", lambda *_a, **_k: _empty())
    monkeypatch.setattr(
        chat, "load_config", lambda: {"memory_enabled": False, "automemory_enabled": False}
    )
    # 通道预判要借本地 embedder（6-7 秒）；这一条测的不是它，直接给定 hybrid。
    monkeypatch.setattr(
        channel_gate, "pick", lambda q: channel_gate.Decision("hybrid", "default", 1.0, "test")
    )
    return seen


async def _empty():
    return []


def _drive(conv_id: int, text: str) -> list[str]:
    async def go() -> list[str]:
        return [
            frame
            async for frame in chat._generate(
                chat.ChatRequest(conversation_id=conv_id, content=text, use_rag=True)
            )
        ]

    return asyncio.run(go())


def _events(frames: list[str], event: str) -> list[dict]:
    out: list[dict] = []
    for frame in frames:
        lines = frame.split("\n")
        if not lines or lines[0] != f"event: {event}":
            continue
        payload = next((ln[6:] for ln in lines if ln.startswith("data: ")), "")
        try:
            out.append(json.loads(payload))
        except ValueError:
            out.append({})
    return out


def _assistant_row(conv_id: int) -> Message | None:
    async def go():
        async with SessionLocal() as db:
            return (
                await db.execute(
                    select(Message)
                    .where(Message.conversation_id == conv_id, Message.role == "assistant")
                    .order_by(Message.id.desc())
                )
            ).scalars().first()

    return asyncio.run(go())


def _trace(conv_id: int) -> dict | None:
    async def go():
        from app.core import turn_trace

        return next(
            (
                t
                for t in (await turn_trace.recent(limit=10))["traces"]
                if t["conversation_id"] == conv_id
            ),
            None,
        )

    return asyncio.run(go())


# ---------- 1/2：剥掉 + 不重生成 ----------


def test_a_fabricated_citation_is_stripped_from_what_lands_on_disk(monkeypatch):
    """这一条就是 P3 的目的：`[来源 7]` 只注入了 5 条 —— 用户点开什么都没有。

    库里那份必须是剥干净的，而且**回一帧带干净正文的 `citations`**（屏幕上那几个编号已经
    流出来了，不换掉就是「库里剥了、屏幕上还留着」）。
    """
    asyncio.run(_prepare_db(9201))
    seen = _stub(monkeypatch, "阈值是 0.62[来源 3]，这一条见[来源 7]。", 5)
    frames = _drive(9201, "检索阈值是多少？")

    row = _assistant_row(9201)
    assert row is not None
    assert row.content == "阈值是 0.62[来源 3]，这一条见。", "编造的那个编号必须从落库正文里拿掉"
    assert "[来源 7]" not in row.content

    fix = _events(frames, "citations")
    assert len(fix) == 1 and fix[0]["fake"] == [7] and fix[0]["injected"] == 5
    assert fix[0]["text"] == row.content, "回给界面的正文要与落库那份逐字一致"

    assert len(seen) == 1, "剥离不重生成：模型只许被调一次（打回重写还可能在第二遍再编一个）"

    trace = _trace(9201)
    assert trace is not None
    assert trace["sources_injected"] == 5 and trace["sources_cited"] == 1, "两个计数在正式列里"
    assert trace["quality"]["citations"] == {
        "injected": 5,
        "markers": 2,
        "cited": [3],
        "fake": [7],
        "stripped": [7],
    }
    assert "fake_citation" in trace["flags"]


def test_a_clean_answer_raises_no_frame_and_no_flag(monkeypatch):
    """没编的时候**一个字都不动**：不发 `citations` 帧、账本那一栏毛病不亮
    （「查了没问题」与「没查」是两件事，但这里两者都不该惊动用户）。"""
    asyncio.run(_prepare_db(9202))
    _stub(monkeypatch, "阈值是 0.62[来源 1]，另外[来源 5]也提过。", 5)
    frames = _drive(9202, "检索阈值是多少？")

    row = _assistant_row(9202)
    assert row is not None and row.content == "阈值是 0.62[来源 1]，另外[来源 5]也提过。"
    assert _events(frames, "citations") == []

    trace = _trace(9202)
    assert trace is not None
    assert trace["sources_injected"] == 5 and trace["sources_cited"] == 2
    assert trace["quality"]["citations"]["stripped"] == []
    assert "fake_citation" not in trace["flags"]


def test_nothing_injected_means_no_legitimate_number_at_all(monkeypatch):
    """一条材料都没注入时，正文里的 `[来源 1]` 也是编的 —— 那一轮它手里根本没有编号表。

    **这条是有代价的取舍**（写死在 `core/citations.py` 开头）：跨轮引用上一轮的编号会被
    一起剥掉。方向照 `channel.py`：假指针比少个角标贵。
    """
    asyncio.run(_prepare_db(9203))
    _stub(monkeypatch, "按之前的材料，阈值是 0.62[来源 2]。", 0)
    frames = _drive(9203, "检索阈值是多少？")

    row = _assistant_row(9203)
    assert row is not None and row.content == "按之前的材料，阈值是 0.62。"
    assert _events(frames, "citations")[0]["fake"] == [2]

    trace = _trace(9203)
    assert trace is not None
    assert trace["sources_injected"] == 0 and trace["sources_cited"] == 0


def test_lookalikes_are_left_alone_through_the_whole_path(monkeypatch):
    """`[来源 N]`（复述指令）与 `[资料来源 3]`（不是本产品的格式）**一个字都不许动** ——
    匹配写宽吃掉的是真话。"""
    asyncio.run(_prepare_db(9204))
    reply = "我会标注 [来源 N]，另外[资料来源 3]里写着阈值。"
    _stub(monkeypatch, reply, 5)
    frames = _drive(9204, "你会怎么引用？")

    row = _assistant_row(9204)
    assert row is not None and row.content == reply
    assert _events(frames, "citations") == []
    assert _trace(9204)["quality"]["citations"]["markers"] == 0
