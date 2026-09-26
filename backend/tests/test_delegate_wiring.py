"""A1 的接线测试：**走产品自己那条路**（`routers.chat._generate`）跑一次真委托。

单元测试在 `tests/test_delegate.py`（隔离、轮数、工具子集、深度闸门）。这里钉的是
「把线接起来之后是不是真的那样」：

1. 主循环的工具清单里**有** `delegate`（chat 显式打开了），子代理的清单里**没有**；
2. 子代理默认拿不到写工具 → **一次落盘都没有**（A1 验收原文那句「子代理无写工具时零落盘」）；
3. 委托**有账**：父这一轮的 `turn_traces.sub_traces` 里记着子代理是谁、几轮、用了什么。

模型调用是假的（`llm._openai_round` 换成剧本，靠 system 里那句子代理人设分辨"现在是父还是子"），
所以这一条**不花钱、不依赖网络**。
"""
import asyncio
import json
import sys

from sqlalchemy import delete, select

sys.path.insert(0, ".")

from app.core import delegate, llm  # noqa: E402
from app.core.llm import ToolCall  # noqa: E402
from app.db import SessionLocal  # noqa: E402
from app.models import Conversation, Message, ProviderConfig  # noqa: E402
from app.routers import chat  # noqa: E402


class _NoClose:
    async def close(self):
        pass


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


def _stub(monkeypatch, *, parent_rounds: int = 2, sub_text: str = "查到了：阈值 0.62。"):
    """一份写死的剧本：父第一轮发 `delegate`，第二轮收尾；子代理回一段话。

    返回三本账：父每一次看到的工具清单、子代理每一次看到的工具清单、**父第二轮看到的
    messages**（子代理的结果就是从那里交给模型的 —— 它不进最终答复，所以只能在那儿验）。
    """
    parent_tools: list[list[str]] = []
    sub_tools: list[list[str]] = []
    parent_msgs: list[list[dict]] = []
    state = {"round": 0}

    async def fake_round(client, model, messages, tools, emit_text, usage_out=None):  # noqa: ARG001
        names = [s["function"]["name"] for s in (tools or [])]
        systems = " ".join(str(m.get("content")) for m in messages if m.get("role") == "system")
        if delegate.DEFAULT_PERSONA[:14] in systems:  # 这是子代理那一侧
            sub_tools.append(names)
            for ch in sub_text:
                emit_text(ch)
            return sub_text, []
        parent_tools.append(names)
        parent_msgs.append([dict(m) for m in messages])
        state["round"] += 1
        if state["round"] < parent_rounds:
            # `emit_text` 一个字都不发：让 llm 的「不支持工具就降级重试」不被触发
            return "", [ToolCall("1", "delegate", {"task": "去查清楚检索阈值现在是多少"})]
        emit_text("查到了，见子代理的答复。")
        return "查到了，见子代理的答复。", []

    monkeypatch.setattr(llm, "_openai_round", fake_round)
    monkeypatch.setattr(llm, "_openai_client", lambda p: _NoClose())  # noqa: ARG005
    monkeypatch.setattr(chat, "_generate_followups", lambda *_a, **_k: _none())
    monkeypatch.setattr(
        chat, "load_config", lambda: {"memory_enabled": False, "automemory_enabled": False}
    )
    return parent_tools, sub_tools, parent_msgs


async def _none():
    return []


def _drive(conv_id: int, text: str) -> list[str]:
    frames: list[str] = []

    async def go() -> None:
        async for frame in chat._generate(
            chat.ChatRequest(conversation_id=conv_id, content=text, use_rag=False)
        ):
            frames.append(frame)

    asyncio.run(go())
    return frames


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


def test_a_real_delegation_end_to_end(monkeypatch):
    """父委托一次 → 子代理只拿只读工具跑一遍 → 结果回到父手里 → 账上留一条。"""
    asyncio.run(_prepare_db(9401))
    parent_tools, sub_tools, parent_msgs = _stub(monkeypatch)
    frames = _drive(9401, "检索阈值现在到底是多少？帮我查清楚。")

    # 1) 父有 delegate，子没有
    assert parent_tools, "父那一轮没跑到？"
    assert "delegate" in parent_tools[0], "chat 这条路的工具清单里没有 delegate"
    assert sub_tools, "子代理没跑起来？"
    assert "delegate" not in sub_tools[0], "子代理的工具清单里不该有 delegate（深度 1）"
    # 2) 子代理默认只有只读 + 检索 → 一个写工具都没有
    assert "save_artifact" not in sub_tools[0] and "vault_write_file" not in sub_tools[0]
    assert "kb_search" in sub_tools[0] or "vault_read_file" in sub_tools[0]

    # 3) **零落盘**（A1 验收原文）：父与子都没有产出
    row = _assistant_row(9401)
    assert row is not None and not row.artifacts_json, "子代理居然落了盘（它不该有写工具）"
    # 子代理的结果是**交给模型**的（在第二轮的消息里），不进最终答复——这是设计，不是漏
    assert len(parent_msgs) >= 2
    fed = json.dumps(parent_msgs[1], ensure_ascii=False)
    assert "[子代理" in fed and "阈值 0.62" in fed, "子代理的结果没交回父手里"

    # 4) 委托有账
    trace = _trace(9401)
    assert trace is not None
    subs = trace["sub_traces"]
    assert len(subs) == 1
    assert subs[0]["model_id"] == "stub/m"  # 不给 model_id 就跟着主循环那个
    assert subs[0]["rounds"] == 1
    assert all(t != "delegate" for t in subs[0]["tools"])
    assert subs[0]["error"] == ""

    # 5) 界面看得见这一刀是个委托（`_TOOL_META` 那条旁路）
    results = _events(frames, "tool_result")
    assert any((r.get("meta") or {}).get("delegate") for r in results), results


def test_an_unknown_tool_name_is_told_to_the_sub_agent(monkeypatch):
    """子代理那边点名了一个不存在的工具：照实告诉它、这一轮照样跑完。"""
    asyncio.run(_prepare_db(9402))
    parent_tools: list[list[str]] = []
    parent_msgs: list[list[dict]] = []
    sub_rounds: list[str] = []

    async def fake_round(client, model, messages, tools, emit_text, usage_out=None):  # noqa: ARG001
        systems = " ".join(str(m.get("content")) for m in messages if m.get("role") == "system")
        if delegate.DEFAULT_PERSONA[:14] in systems:
            sub_rounds.append("sub")
            emit_text("没有那个工具，我用 kb_search 查了：0.62。")
            return "没有那个工具，我用 kb_search 查了：0.62。", []
        parent_tools.append([s["function"]["name"] for s in (tools or [])])
        parent_msgs.append([dict(m) for m in messages])
        if len(parent_tools) == 1:
            return "", [
                ToolCall("1", "delegate", {"task": "查阈值", "tools": ["vault_reed_file"]})
            ]
        return "好。", []

    monkeypatch.setattr(llm, "_openai_round", fake_round)
    monkeypatch.setattr(llm, "_openai_client", lambda p: _NoClose())  # noqa: ARG005
    monkeypatch.setattr(chat, "_generate_followups", lambda *_a, **_k: _none())
    monkeypatch.setattr(
        chat, "load_config", lambda: {"memory_enabled": False, "automemory_enabled": False}
    )
    _drive(9402, "查一下阈值")

    assert sub_rounds == ["sub"], "子代理没跑起来"
    fed = json.dumps(parent_msgs[-1], ensure_ascii=False)
    assert "不认识的工具" in fed and "vault_reed_file" in fed, "拼错的工具名没被照实报出来"
