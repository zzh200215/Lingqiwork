"""A2 的逐步账：**落库并读回**（2026-09-23）。

在那之前 `facts` 只走流式事件——刷新一下，界面上的逐步账就没了，只剩纪要正文；而
「哪一步贵、哪一步烧光」恰恰是协作最该留下的那笔账（同 `artifacts` 那条理由）。

这一层钉三件事：

1. 协作路由把它**跟正文一起落**（`_save_assistant_message(..., steps=…)`）；
2. 会话接口**原样送回来**（照抄后端那份事实，界面不聚合）；
3. 没有那笔账时是 **`None`** 而不是 `[]`——「那时候没有」与「有一笔空账」是两件事
   （老行、以及聊天那条路的普通消息都是前者）。
"""
import asyncio
import sys

import pytest

sys.path.insert(0, ".")

from sqlalchemy import delete as sa_delete  # noqa: E402
from sqlalchemy import select  # noqa: E402

from app.db import SessionLocal  # noqa: E402
from app.models import Agent, Conversation, Message  # noqa: E402


@pytest.fixture(autouse=True)
def _clean():
    """这个模块共用一个库：上一条用例种的会话/消息/agent 会漏进下一条（同 `test_threads` 的形状）。

    `agents.name` 是 UNIQUE，不清就会撞「同名智能体已存在」——而那不是被测行为。
    """

    async def _go() -> None:
        async with SessionLocal() as db:
            for model in (Message, Conversation, Agent):
                await db.execute(sa_delete(model))
            await db.commit()

    asyncio.run(_go())
    yield

FACTS = [
    {
        "step": 1,
        "title": "读材料 · 升级记录",
        "phase": "read",
        "agent": "整理者",
        "rounds": 1,
        "tools": ["vault_read_file"],
        "seconds": 3.4,
        "parallel": True,
        "rounds_exhausted": False,
    },
    {
        "step": 2,
        "title": "汇总 · 整理者",
        "phase": "merge",
        "agent": "整理者",
        "rounds": 3,
        "tools": [],
        "seconds": 8.1,
        "parallel": False,
        "rounds_exhausted": True,
    },
]


def _seed() -> list[int]:
    async def go() -> list[int]:
        async with SessionLocal() as db:
            db.add(Conversation(id=9501, title="t", model_id="stub/stub-m"))
            for name in ("甲", "乙"):
                db.add(Agent(name=f"steps-{name}"))
            await db.commit()
            return list((await db.execute(select(Agent.id))).scalars())

    return asyncio.run(go())


def _client(monkeypatch):
    """→ (TestClient, 认证头)。**头名从 `auth.HEADER` 拿**，不手写字符串——
    写错了会得到 401，而那不是被测行为（这一版第一次就栽在这上面）。"""
    from fastapi.testclient import TestClient

    from app.core import auth
    from app.main import app

    monkeypatch.setenv("WB_API_TOKEN", "test-token-123")
    monkeypatch.setattr(auth, "_cached", None)
    return TestClient(app), {auth.HEADER: "test-token-123"}


def _messages(client, headers) -> list[dict]:
    got = client.get("/api/conversations/9501", headers=headers)
    assert got.status_code == 200, got.text
    return got.json()["messages"]


def test_the_collab_route_saves_the_step_ledger_and_the_api_returns_it(monkeypatch):
    """正面证据：跑一次协作 → 落一条带账的消息 → 会话接口把它原样送回来。"""
    from app.routers import agents as agents_router

    agent_ids = _seed()

    async def fake_run(goal, agents, pattern, resolve, retrieve, **kw):  # noqa: ARG001
        yield "meta", {"pattern": pattern, "parallel": False, "steps": []}
        yield "delta", {"text": "纪要正文（逐步账在下面那栏）。"}
        for f in FACTS:
            yield "step", {"fact": f}
        yield "done", {"facts": FACTS, "transcript": "纪要正文（逐步账在下面那栏）。"}

    monkeypatch.setattr(agents_router.collab, "run", fake_run)
    client, headers = _client(monkeypatch)

    r = client.post(
        "/api/agents/collab",
        json={
            "conversation_id": 9501,
            "goal": "把这三份升级记录攒成一份小结",
            "agent_ids": agent_ids,
            "pattern": "fanout",
        },
        headers=headers,
    )
    assert r.status_code == 200, r.text

    assistant = [m for m in _messages(client, headers) if m["role"] == "assistant"]
    assert assistant, "协作那一轮连正文都没落？"
    assert assistant[-1]["steps"] == FACTS, "逐步账没跟着消息一起回来"


def test_a_plain_message_has_no_step_ledger(monkeypatch):
    """**没有那笔账就不给空表**：`None` = 那时候没有（老行 / 聊天那条路），界面据此不画那一栏。"""
    _seed()
    client, headers = _client(monkeypatch)

    async def go() -> None:
        async with SessionLocal() as db:
            db.add(
                Message(
                    conversation_id=9501,
                    role="assistant",
                    content="普通的一条回答",
                    model_id="stub/stub-m",
                )
            )
            await db.commit()

    asyncio.run(go())
    msgs = [m for m in _messages(client, headers) if m["role"] == "assistant"]
    assert msgs and msgs[-1]["steps"] is None, msgs[-1].get("steps")


def test_a_broken_steps_column_does_not_blow_up_the_conversation(monkeypatch):
    """写坏一行不该让整个会话 500（与 `sources` / `artifacts` 同一条兜底）。"""
    _seed()

    async def go() -> None:
        async with SessionLocal() as db:
            db.add(
                Message(
                    conversation_id=9501,
                    role="assistant",
                    content="坏行",
                    steps_json="{不是 JSON",
                    model_id="stub/stub-m",
                )
            )
            await db.commit()

    asyncio.run(go())
    client, headers = _client(monkeypatch)
    assert [m for m in _messages(client, headers) if m["role"] == "assistant"][-1]["steps"] is None
