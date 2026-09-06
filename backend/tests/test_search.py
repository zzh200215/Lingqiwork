"""全局搜索（EvoForge 参考项）：聊天消息 + 教学轮次一并 LIKE 覆盖，
% 和 _ 当普通字符而不是通配符。直接调端点函数，不起 HTTP。"""
import asyncio
import atexit
import os
import shutil
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, ".")

_TMP = Path(tempfile.mkdtemp(prefix="wb-search-", dir=Path(__file__).parent))


def _cleanup() -> None:
    try:
        asyncio.run(engine.dispose())
    except Exception:  # noqa: BLE001
        pass
    shutil.rmtree(_TMP, ignore_errors=True)


atexit.register(_cleanup)
os.environ["WB_DB_PATH"] = str(_TMP / "test.db")
os.environ["WB_CONFIG_PATH"] = str(_TMP / "config.json")

from app.db import SessionLocal, engine  # noqa: E402
from app.models import Base, Conversation, Message, TutorSession, TutorTurn  # noqa: E402
from app.routers.search import global_search  # noqa: E402


async def _init() -> None:
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)


asyncio.run(_init())


async def _seed() -> None:
    async with SessionLocal() as db:
        conv = Conversation(title="每周复盘")
        db.add(conv)
        await db.flush()
        db.add(Message(conversation_id=conv.id, role="user", content="我决定用 pnpm 管理依赖，100% 确定"))
        db.add(Message(conversation_id=conv.id, role="assistant", content="这句完全无关"))
        sess = TutorSession(topic="asyncio 事件循环")
        db.add(sess)
        await db.flush()
        db.add(TutorTurn(session_id=sess.id, role="user", content="await 到底把控制权交给谁"))
        db.add(TutorTurn(session_id=sess.id, role="assistant", content="交给事件循环，没有别的魔法"))
        await db.commit()


async def test_searches_chat_and_tutor_turns():
    await _seed()
    async with SessionLocal() as db:
        hits = (await global_search(q="控制权", db=db))["results"]
    assert len(hits) == 1
    assert hits[0]["source"] == "tutor"
    assert hits[0]["title"] == "asyncio 事件循环"
    assert "await" in hits[0]["excerpt"]

    async with SessionLocal() as db:
        hits = (await global_search(q="pnpm", db=db))["results"]
    assert hits[0]["source"] == "chat" and hits[0]["title"] == "每周复盘"


async def test_percent_and_underscore_are_not_wildcards():
    """自带数据，不依赖前一个测试的播种顺序。字面量语义：搜 % 命中含 % 的行，
    而不是所有行；搜 a_c 不命中 abc。"""
    async with SessionLocal() as db:
        conv = Conversation(title="通配符回归")
        db.add(conv)
        await db.flush()
        db.add(Message(conversation_id=conv.id, role="user", content="承诺 100% 做到 abc 这件事"))
        db.add(Message(conversation_id=conv.id, role="assistant", content="这句没有任何特殊字符"))
        await db.commit()

    async with SessionLocal() as db:
        hits = (await global_search(q="%", db=db))["results"]
    # 库里其他测试也留过含 % 的行；要点是：字面量 % 只命中含 % 的行，
    # 不含特殊字符的行绝不出现（旧实现里 % 会命中全部）
    assert hits and all("100%" in h["excerpt"] for h in hits)

    async with SessionLocal() as db:
        assert (await global_search(q="a_c", db=db))["results"] == []
