"""「材料不足」明示的接线测试（P2 的第二条决定 + P2 边界①）。

门不通过时 `_build_rag_context` 要在提示词里明说这批片段没有直接相关的材料；门通过时
**一个字都不加**（那段提示词是校准过的，没理由动它）。**一条都没检索到时也要明说**
（P2 记下的边界①，2026-09-20 补齐）——这一条当时不做是因为「闲聊 + 常开 RAG」会被这句
误伤，而通道预判已经把闲聊拦在检索之前了。

前半是纯字符串那一层；后半两条走**产品自己那条路**（`chat._generate`），因为「提示词拼对了」
与「这一轮真的把它发给了模型」是两件事。
"""
import asyncio
import sys

from sqlalchemy import delete, select

sys.path.insert(0, ".")

from app.core import retrieval_gate  # noqa: E402
from app.routers.chat import _build_rag_context  # noqa: E402


def _hits(vec=0.8):
    h = {"source": "notes/a.md", "text": "正文内容", "chunk": 0, "channels": ["vec", "bm25"]}
    if vec is not None:
        h["vec"] = vec
    return [h]


def test_without_a_quality_verdict_the_prompt_is_unchanged():
    """不给判定（评测判分那条路就是这么调的）→ 提示词与改动前逐字相同。"""
    ctx = _build_rag_context(_hits())
    assert "质量门" not in ctx
    assert "从用户知识库检索到的相关片段" in ctx
    assert "[来源 1 — notes/a.md]" in ctx


def test_a_passing_gate_adds_nothing():
    """门说够好 → 一个字都不加。"""
    q = retrieval_gate.assess(_hits())
    assert q.ok
    assert "质量门" not in _build_rag_context(_hits(), quality=q)


def test_a_failed_gate_says_the_material_is_insufficient():
    q = retrieval_gate.assess(_hits(vec=0.1))
    assert not q.ok
    ctx = _build_rag_context(_hits(vec=0.1), quality=q)
    assert "没有与当前问题直接相关的材料" in ctx
    assert "不要" in ctx and "冒充" in ctx, "没把「别硬答、别拿常识冒充材料」说清楚"
    assert q.reason in ctx, "判据没写进去，模型与人都看不到为什么判不足"
    assert "[来源 1 — notes/a.md]" in ctx, "片段本身该照旧给它，万一里面有能用的"


def test_hits_without_a_vector_score_count_as_insufficient():
    """纯词法命中（或假命中）没有 `vec`：主判据得 0.0 → 判不足，于是明示生效。"""
    q = retrieval_gate.assess(_hits(vec=None))
    assert not q.ok and q.vec_top1 == 0.0
    assert "没有与当前问题直接相关的材料" in _build_rag_context(_hits(vec=None), quality=q)


# ---------- P2 边界①：一条都没检索到 ----------


def test_nothing_retrieved_says_there_is_no_material_at_all():
    """零命中与「门判不足」是**两件事**，说法也得分开：这里连片段都没有，
    不能再说「片段里没有直接相关的」——那会让模型以为手里有材料。"""
    q = retrieval_gate.assess([])
    assert not q.ok and q.reason == "没有检索到任何材料"
    ctx = _build_rag_context([], quality=q)
    assert "没有检索到任何材料" in ctx
    assert q.reason in ctx, "判据要原样带出去（模型与账本是同一句话）"
    assert "不要" in ctx and "常识" in ctx, "没把「别凭常识硬答」说清楚"
    assert "缺的是什么" in ctx, "要让它说缺什么，否则用户不知道该往库里放什么"
    assert "[来源" not in ctx, "一条材料都没有，提示词里不该出现任何来源编号"


def test_nothing_retrieved_without_a_verdict_still_says_so():
    """没给判定也说得出话（`evals._answer_and_judge` 那条路就不给 quality）。"""
    assert "没有检索到任何材料" in _build_rag_context([])


# ---------- 接线：这一轮真的把这句话发给模型了吗 ----------


class _NoClose:
    async def close(self):
        pass


async def _prepare_db(conv_id: int) -> None:
    from app.db import SessionLocal
    from app.models import Conversation, ModelProfile, ModelProfileChange, ProviderConfig

    async with SessionLocal() as db:
        if (
            await db.execute(select(ProviderConfig).where(ProviderConfig.name == "stub"))
        ).scalar_one_or_none() is None:
            db.add(ProviderConfig(name="stub", kind="openai", base_url="", enabled=True))
            await db.commit()
        if await db.get(Conversation, conv_id) is None:
            db.add(Conversation(id=conv_id, title="t", model_id="stub/m"))
            await db.commit()
        # 画像按模块共享，别的测试写过的会漏进来（见 `test_turn_repair` 那条注）
        await db.execute(delete(ModelProfileChange))
        await db.execute(delete(ModelProfile))
        await db.commit()


def _stub(monkeypatch, *, hits: list[dict], channel: str) -> tuple[list, list]:
    """把模型、检索、通道预判换成写死的 —— 这一条要测的是「发没发那句话」。

    返回（模型每一轮看到的 messages，检索被调用的次数）。
    """
    from app.core import channel as channel_gate, llm
    from app.routers import chat

    seen: list[list[dict]] = []
    calls: list[str] = []

    async def fake_round(client, model, messages, tools, emit_text, usage_out=None):  # noqa: ARG001
        seen.append([dict(m) for m in messages])
        emit_text("好。")
        return "好。", []

    async def fake_retrieve(query: str, top_k: int) -> list[dict]:  # noqa: ARG001
        calls.append("retrieve")
        return hits

    async def no_followups(*_a, **_k):
        return []

    monkeypatch.setattr(llm, "_openai_round", fake_round)
    monkeypatch.setattr(llm, "_openai_client", lambda p: _NoClose())  # noqa: ARG005
    monkeypatch.setattr(chat, "indexer_retrieve", fake_retrieve)
    monkeypatch.setattr(chat, "_generate_followups", no_followups)
    monkeypatch.setattr(
        chat, "load_config", lambda: {"memory_enabled": False, "automemory_enabled": False}
    )
    monkeypatch.setattr(
        channel_gate, "pick", lambda q: channel_gate.Decision(channel, "default", 1.0, "test")
    )
    return seen, calls


def _drive(conv_id: int, text: str) -> list[str]:
    from app.routers import chat

    frames: list[str] = []

    async def go() -> None:
        async for frame in chat._generate(
            chat.ChatRequest(conversation_id=conv_id, content=text, use_rag=True)
        ):
            frames.append(frame)

    asyncio.run(go())
    return frames


def test_zero_hits_reach_the_model_as_a_system_message(monkeypatch):
    """**接线那一步**：纯字符串对了不等于模型收到了 —— 这一条从 `_generate` 走到底，
    断言发给模型的 messages 里真有那句「没有检索到任何材料」。"""
    asyncio.run(_prepare_db(9301))
    seen, calls = _stub(monkeypatch, hits=[], channel="hybrid")
    frames = _drive(9301, "这份材料里怎么说的？")

    assert calls == ["retrieve"], "hybrid 通道必须真的去检索"
    assert seen, "模型没被调到？"
    sys_msgs = [str(m.get("content")) for m in seen[0] if m.get("role") == "system"]
    assert any("没有检索到任何材料" in s for s in sys_msgs), "那句话没进 messages"
    assert any("不要" in s and "常识" in s for s in sys_msgs), "规矩没跟着去"
    # 事件流里也留一条痕（界面/别的客户端要能看见「这一轮为什么一句材料都没有」）
    assert any(f.startswith("event: rag_empty") for f in frames)


def test_a_skipped_turn_never_gets_the_note(monkeypatch):
    """**闲聊零检索的那条红线不能被这句话破掉**：skip 那一路根本不检索，
    所以也就没有「一条都没检索到」这回事 —— 模型面前一个字的材料提示都不该有。"""
    asyncio.run(_prepare_db(9302))
    seen, calls = _stub(monkeypatch, hits=[], channel="skip")
    frames = _drive(9302, "你好呀")

    assert calls == [], "skip 不许检索"
    assert seen, "模型没被调到？"
    # **只扫那句话本身**：system 里还有技能索引之类的块，它们正常会提到「材料」两个字
    # （第一版这条断言就是被技能索引里的一个词打挂的），所以扫的是一个精确的句子。
    for m in seen[0]:
        if m.get("role") == "system":
            assert "没有检索到任何材料" not in str(m.get("content")), f"闲聊被灌了材料提示：{m}"
    assert not any(f.startswith("event: rag_empty") for f in frames)
    assert any(f.startswith("event: rag_skipped") for f in frames)
