"""W2a 的有界修复：**动作**那一半（判据在 `core/turn_quality.py`，那边另有测试）。

这一层钉的是「补跑之后留下什么」，四件事：

1. 用户明说要落盘、模型却把成品写在对话里 → **补跑一次**，而且那一轮的话里
   指名道姓写着「上一轮没有落盘、这一轮必须调用」。
2. 补跑补上了 → 长文**不进历史**（历史里留的是那一句回执），回执落库。
3. 补跑还是没补上 → **长文一个字都不许丢**（它是用户唯一的一份东西），
   而且账本里如实记着「补了、没补上」。
4. 用户没说要落盘 → **一次都不补**。判断「这算不算一份成品」是 W3 的活，
   在这里猜错的代价是把闲聊变成产出。

还有一条白名单：回执指向的文件在半路没了（用户在别的窗口整理了 vault），
那它就不许进库、不许渲染成链接，但**原因要说出来**。
"""
import asyncio
import json
import sys

import pytest
from sqlalchemy import select

sys.path.insert(0, ".")

from app.config import VAULT_DIR  # noqa: E402
from app.core import llm  # noqa: E402
from app.core.llm import ToolCall  # noqa: E402
from app.db import SessionLocal  # noqa: E402
from app.models import Conversation, Message, ProviderConfig  # noqa: E402
from app.routers import chat  # noqa: E402

# > 400 字（`turn_quality.LONG_BODY_CHARS`）：这就是「该存没存」那条判据的长度门槛
LONG = "这周的工作可以分成三段来讲。" + "每段都写得很细，" * 50


class _NoClose:
    async def close(self):
        pass


async def _prepare_db(conv_id: int) -> None:
    async with SessionLocal() as db:
        exists = (
            await db.execute(select(ProviderConfig).where(ProviderConfig.name == "stub"))
        ).scalar_one_or_none()
        if exists is None:
            db.add(ProviderConfig(name="stub", kind="openai", base_url="", enabled=True))
            await db.commit()
        if await db.get(Conversation, conv_id) is None:
            db.add(Conversation(id=conv_id, title="t", model_id="stub/m"))
            await db.commit()


async def _no_followups(*_a, **_k):
    return []


def _stub_turn(monkeypatch, rounds, seen: list | None = None):
    """把模型换成一份写死的剧本：每轮是 (这一轮吐的文本, 这一轮发的工具调用)。

    `seen` 收下每一轮真正发出去的 messages —— 补跑那句话到底有没有送到模型眼前，
    只有从这儿看才算数（不然测的只是「我们自己拼了一个字符串」）。
    """
    it = iter(rounds)

    async def fake_round(client, model, messages, tools, emit_text, usage_out=None):  # noqa: ARG001
        if seen is not None:
            seen.append([dict(m) for m in messages])
        text, calls = next(it, ("", []))
        for ch in text:
            emit_text(ch)
        return ("", calls) if calls else (text, calls)

    monkeypatch.setattr(llm, "_openai_round", fake_round)
    monkeypatch.setattr(llm, "_openai_client", lambda p: _NoClose())  # noqa: ARG005
    monkeypatch.setattr(chat, "_generate_followups", _no_followups)
    monkeypatch.setattr(
        chat, "load_config", lambda: {"memory_enabled": False, "automemory_enabled": False}
    )


def _drive(conv_id: int, text: str) -> list[str]:
    async def go() -> list[str]:
        return [
            frame
            async for frame in chat._generate(chat.ChatRequest(conversation_id=conv_id, content=text))
        ]

    return asyncio.run(go())


def _events(frames: list[str], event: str) -> list[dict]:
    """SSE 帧 → 某个事件的 payload 列表。"""
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
            (t for t in (await turn_trace.recent(limit=10))["traces"] if t["conversation_id"] == conv_id),
            None,
        )

    return asyncio.run(go())


# ---------- 1/3：补跑补上了 / 没补上 ----------


def test_a_long_body_the_user_asked_to_save_gets_one_retry_and_loses_the_body(monkeypatch):
    """这一条就是 W2a 的目的：成品进产出区，**长文不再进对话**。

    剧本第一轮：整篇写在回复里、一次工具都没调（实测 22 轮里 2 轮这样）。
    补跑那一轮：真的调了 `save_artifact`，然后只说一句回执。
    """
    asyncio.run(_prepare_db(9101))
    seen: list = []
    _stub_turn(
        monkeypatch,
        [
            (LONG, []),
            ("", [ToolCall("1", "save_artifact", {"kind": "deliver", "title": "周报", "content": "正文"})]),
            ("存好了。", []),
        ],
        seen=seen,
    )
    frames = _drive(9101, "把这周的进展整理成一份周报，存进产出。")
    row = _assistant_row(9101)

    assert len(seen) == 3, "第一轮 + 补跑那一轮的工具轮与收尾轮"
    # 补跑那一轮的话真的送到了模型眼前：指名道姓说「上一轮没有落盘」「必须调用 save_artifact」
    assert any("save_artifact" in str(m.get("content")) for m in seen[1])
    assert any("上一轮" in str(m.get("content")) for m in seen[1])

    assert row is not None
    assert row.content == "存好了。"  # 长文没进历史
    assert len(json.loads(row.artifacts_json)) == 1  # 回执落库了

    quality_frames = _events(frames, "quality")
    assert quality_frames[0]["retried"] is True and quality_frames[0]["asked_to_save"] is True
    assert quality_frames[-1]["codes"] == []  # 收尾：两条底线都过了
    assert _events(frames, "saved")[-1]["message_id"] == row.id

    trace = _trace(9101)
    assert trace is not None and trace["retried"] == 1
    assert trace["quality"]["repaired"] is True
    assert trace["quality"]["findings"] == []


def test_a_retry_that_still_fails_keeps_the_body_and_says_so(monkeypatch):
    """补跑没补上时**一个字都不许丢** —— 那是用户唯一的一份东西。

    而且账本要如实记「补了、没补上」：不记的话，事后看到的就是一条「长正文没落盘」
    的回合，没人知道服务端其实动过手。
    """
    asyncio.run(_prepare_db(9102))
    _stub_turn(monkeypatch, [(LONG, []), ("我判断现在不该落盘：没有任何素材。", [])])
    frames = _drive(9102, "把这周的进展整理成一份周报，存进产出。")
    row = _assistant_row(9102)

    assert row is not None and row.content == LONG.strip()  # 正文保住了
    assert row.artifacts_json is None

    last = _events(frames, "quality")[-1]
    assert "long_body_without_a_receipt" in last["codes"]
    trace = _trace(9102)
    assert trace["retried"] == 1 and trace["quality"]["repaired"] is False
    assert [f["code"] for f in trace["quality"]["findings"]] == ["long_body_without_a_receipt"]


# ---------- 4：没说要落盘就一次都不补 ----------


def test_a_long_body_nobody_asked_to_save_is_never_retried(monkeypatch):
    """**判断「这算不算一份成品」不是 W2a 的活**（那是 W3 的路由）。

    在自然说法上下手，代价是把闲聊变成产出 —— 而实测里模型对这种说法本来就多半不存
    （两批 1/18），那不该由这里去纠。
    """
    asyncio.run(_prepare_db(9103))
    seen: list = []
    _stub_turn(monkeypatch, [(LONG, [])], seen=seen)
    frames = _drive(9103, "讲讲数据库索引为什么能让查询变快。")
    row = _assistant_row(9103)

    assert len(seen) == 1, "一次都不该多跑"
    assert row is not None and row.content == LONG.strip()
    assert not any(f.get("retried") for f in _events(frames, "quality"))
    trace = _trace(9103)
    assert trace["retried"] == 0 and trace["quality"]["asked_to_save"] is False


def test_a_short_refusal_is_not_a_finding_at_all(monkeypatch):
    """正确拒绝（空 vault 下「我不想凭空编」）不许被当成失守 —— 它是短回复，判据够不着。"""
    asyncio.run(_prepare_db(9104))
    refusal = "我这边没有这周的素材，我不想凭空编一份周报给你——那东西进了产出区反而更难收拾。"
    seen: list = []
    _stub_turn(monkeypatch, [(refusal, [])], seen=seen)
    frames = _drive(9104, "把这周的进展整理成一份周报，存进产出。")

    assert len(seen) == 1
    assert _events(frames, "quality")[-1]["codes"] == []
    trace = _trace(9104)
    assert trace["quality"]["asked_to_save"] is True  # 用户是说了要存的
    assert trace["quality"]["findings"] == []  # 但它正确地拒绝了，且没编


# ---------- 编造路径：判出来、但不补跑 ----------


def test_an_invented_path_is_reported_but_not_retried(monkeypatch):
    """模型报了一个盘上没有的路径 —— 再问一遍救不了那句话（已经说出去了）。"""
    asyncio.run(_prepare_db(9105))
    seen: list = []
    _stub_turn(monkeypatch, [("已经存好了：recap/2026-09-14-本周周报-精简版.md", [])], seen=seen)
    frames = _drive(9105, "把这周的进展整理成一份周报，存进产出。")

    assert len(seen) == 1
    last = _events(frames, "quality")[-1]
    assert last["codes"] == ["invented_path"]
    trace = _trace(9105)
    assert "invented_path" in trace["flags"]


# ---------- 白名单：回执指向的文件在半路没了 ----------


def test_a_receipt_whose_file_vanished_is_not_shown_and_says_why(monkeypatch):
    """从「工具说存好了」到「把回执交给界面」中间隔着一整轮，文件可能半路被移走。

    这时候不许给链接（点开就是 404），但**也不许静默**：原因要说给用户听，
    并且记进账本。
    """
    asyncio.run(_prepare_db(9106))
    rounds = iter(
        [
            ("", [ToolCall("1", "save_artifact", {"kind": "deliver", "title": "周报", "content": "正文"})]),
            ("存好了。", []),
        ]
    )

    async def fake_round(client, model, messages, tools, emit_text, usage_out=None):  # noqa: ARG001
        text, calls = next(rounds, ("", []))
        if not calls:
            # 收尾那一轮之前把刚落的文件删掉：模拟用户在别的窗口整理了 vault
            for p in VAULT_DIR.glob("deliver/*.md"):
                p.unlink()
        for ch in text:
            emit_text(ch)
        return ("", calls) if calls else (text, calls)

    monkeypatch.setattr(llm, "_openai_round", fake_round)
    monkeypatch.setattr(llm, "_openai_client", lambda p: _NoClose())  # noqa: ARG005
    monkeypatch.setattr(chat, "_generate_followups", _no_followups)
    monkeypatch.setattr(
        chat, "load_config", lambda: {"memory_enabled": False, "automemory_enabled": False}
    )

    frames = _drive(9106, "把这周的进展整理成一份周报，存进产出。")
    row = _assistant_row(9106)

    assert row is not None and row.artifacts_json is None  # 没有链接可点
    dropped = _events(frames, "quality")[-1]["dropped_receipts"]
    assert dropped and "盘上" in dropped[0]["why"]
    trace = _trace(9106)
    assert "dropped_receipt" in trace["flags"]
