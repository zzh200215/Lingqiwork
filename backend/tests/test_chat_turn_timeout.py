"""整轮超时护栏（`TURN_TIMEOUT_SECONDS`）的接线测试。

`llm.py` 没有单次调用超时——provider 挂住时，chat 这头原来会**永远**停在「生成中」，
钱还在悄悄烧。护栏把 runner 整个包进 `wait_for`（与任务侧 `tasks.py` 的
`wait_for(timeout=900)` 同一语义）：超时 → 取消任务 → 走既有错误分支——已流出的文本
落库、界面收到一条说清楚原因的 error 帧，而不是无限转圈。

两条路都从 `chat._generate` 走到底（「护栏写了」与「真的会停」是两件事）：
超时的那个把模型钉成「永远不返回」；正常的那个证明**快回合不被误伤**——
这是护栏最容易犯的错。整个收集过程套 30s 看门狗：护栏失效时测试自己失败，
不是把 CI 挂死。
"""
import asyncio
import sys

from sqlalchemy import delete, select

sys.path.insert(0, ".")


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
        # 画像按模块共享，别的测试写过的会漏进来
        await db.execute(delete(ModelProfileChange))
        await db.execute(delete(ModelProfile))
        await db.commit()


def _drive(monkeypatch, conv_id: int, text: str, *, round_impl) -> list[str]:
    from app.core import channel as channel_gate, llm
    from app.routers import chat

    frames: list[str] = []

    async def fake_retrieve(query: str, top_k: int) -> list[dict]:  # noqa: ARG001
        return []

    async def no_followups(*_a, **_k):
        return []

    async def collect():
        async for frame in chat._generate(
            chat.ChatRequest(conversation_id=conv_id, content=text, use_rag=True)
        ):
            frames.append(frame)

    monkeypatch.setattr(llm, "_openai_round", round_impl)
    monkeypatch.setattr(llm, "_openai_client", lambda p: _NoClose())  # noqa: ARG005
    monkeypatch.setattr(chat, "indexer_retrieve", fake_retrieve)
    monkeypatch.setattr(chat, "_generate_followups", no_followups)
    monkeypatch.setattr(
        chat, "load_config", lambda: {"memory_enabled": False, "automemory_enabled": False}
    )
    monkeypatch.setattr(
        channel_gate, "pick", lambda q: channel_gate.Decision("hybrid", "default", 1.0, "test")
    )
    # 看门狗：护栏失效时这一条先炸（TimeoutError），测试不会陪 provider 挂 999s
    asyncio.run(asyncio.wait_for(collect(), timeout=30))
    return frames


def test_a_hung_provider_ends_the_stream_with_an_error_frame(monkeypatch):
    """模型不返回 → 整轮被停掉：流正常结束、error 帧把原因说清楚。"""
    asyncio.run(_prepare_db(9401))

    async def stuck_round(*_a, **_k):
        await asyncio.sleep(999)

    monkeypatch.setattr("app.routers.chat.TURN_TIMEOUT_SECONDS", 0.5)
    frames = _drive(monkeypatch, 9401, "你好", round_impl=stuck_round)
    assert any("event: error" in f for f in frames), frames
    assert any("没有完成" in f for f in frames), "超时帧必须说清原因，不能只是一句裸错误"
    assert not any(f.startswith("event: answer_done") for f in frames), "没有完成就不能有完成帧"


def test_a_fast_turn_is_not_tripped_by_the_guard(monkeypatch):
    """快回合（哪怕超时钉得很小）必须原样走完——护栏不许把正常回合误杀。"""
    asyncio.run(_prepare_db(9402))

    async def fast_round(client, model, messages, tools, emit_text, usage_out=None):  # noqa: ARG001
        emit_text("好。")
        return "好。", []

    monkeypatch.setattr("app.routers.chat.TURN_TIMEOUT_SECONDS", 0.5)
    frames = _drive(monkeypatch, 9402, "你好", round_impl=fast_round)
    assert any(f.startswith("event: delta") for f in frames), frames
    assert not any("没有完成" in f for f in frames), "快回合不该撞上护栏"
    assert not any(f.startswith("event: error") for f in frames), frames
