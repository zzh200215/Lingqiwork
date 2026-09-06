"""MCP server 端：把工作台读状态开放给本地外部工具（streamable HTTP, /mcp）。

两层验证：
- 工具级——直接调函数，钉住映射与钳制（search 结果整形、limit 上限、LIKE 历史）。
- 协议级——真实 mcp 客户端连 127.0.0.1 的 uvicorn（同事件循环，engine 池不跨
  loop），走完 initialize / list_tools / call_tool 一整轮。

WB_* 环境变量在导入 app 前设置；vault/索引/记忆全部落在项目内临时目录。
"""
import asyncio
import atexit
import json
import os
import shutil
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, ".")

_TMP = Path(tempfile.mkdtemp(prefix="wb-mcpserver-", dir=Path(__file__).parent))
os.environ["WB_DB_PATH"] = str(_TMP / "test.db")
os.environ["WB_CONFIG_PATH"] = str(_TMP / "config.json")
os.environ["WB_CHROMA_PATH"] = str(_TMP / "chroma")


def _cleanup() -> None:
    try:
        asyncio.run(engine.dispose())
    except Exception:  # noqa: BLE001
        pass
    shutil.rmtree(_TMP, ignore_errors=True)


atexit.register(_cleanup)

from contextlib import asynccontextmanager  # noqa: E402

import pytest  # noqa: E402

from app.core import mcp_server  # noqa: E402
from app.db import SessionLocal, engine  # noqa: E402
from app.models import Base, Conversation, Memory, Message  # noqa: E402


async def _init() -> None:
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)


asyncio.run(_init())


async def _seed_memory(content: str, kind: str = "fact") -> None:
    async with SessionLocal() as db:
        db.add(Memory(content=content, source="auto", kind=kind))
        await db.commit()


# ---------- 工具级 ----------


async def test_search_knowledge_maps_and_clamps(monkeypatch):
    seen = {}

    def fake_search_auto(query, top_k=5, hybrid=None):
        seen["top_k"] = top_k
        return [
            {"id": "1", "text": "协程挂起后去哪", "source": "notes/async.md", "score": 0.81},
            {"id": "2", "text": "第二条", "source": "clippings/x.md", "score": 0.5},
        ]

    monkeypatch.setattr("app.core.indexer.search_auto", fake_search_auto)
    # 装饰器返回原函数：直接调，验证映射与钳制
    hits = await mcp_server.search_knowledge("协程", limit=99)
    assert seen["top_k"] == 20  # 钳到 MAX_LIMIT
    assert hits[0] == {"text": "协程挂起后去哪", "source": "notes/async.md", "score": 0.81}
    assert len(hits) == 2


async def test_search_history_finds_chat_and_tutor(monkeypatch):
    async with SessionLocal() as db:
        conv = Conversation(title="协程那晚")
        db.add(conv)
        await db.flush()
        db.add(Message(conversation_id=conv.id, role="user", content="唯一检索词: 电掘星辉"))
        await db.commit()
    results = await mcp_server.search_history(q="电掘星辉", limit=5)
    assert results and results[0]["source"] == "chat"
    assert "电掘星辉" in results[0]["excerpt"] and results[0]["title"] == "协程那晚"


async def test_get_user_memory_shapes_rows():
    await _seed_memory("用户主用 Python，偏好 uv 管理依赖", kind="preference")
    rows = await mcp_server.get_user_memory(limit=10)
    assert any(r["content"] == "用户主用 Python，偏好 uv 管理依赖" for r in rows)
    pref = next(r for r in rows if r["content"].startswith("用户主用"))
    assert pref["kind"] == "preference" and pref["at"]  # ISO 字符串，不是 datetime 对象
    assert isinstance(pref["at"], str)


async def test_get_today_briefing_always_answers():
    out = await mcp_server.get_today_briefing()
    assert "text" in out and "tone" in out and "action" in out  # 纯规则，不依赖模型


# ---------- 协议级：真客户端连真 socket ----------


def _payload(result):
    """CallToolResult → Python 对象：mcp 2.x 是 structured_content（snake_case），
    结构化缺失时退回 text JSON（列表返回可能被拆成多条 TextContent，取能解析的）。"""
    for attr in ("structured_content", "structuredContent"):
        sc = getattr(result, attr, None)
        if sc is not None:
            return sc.get("result", sc) if isinstance(sc, dict) else sc
    for c in reversed(result.content):
        text = getattr(c, "text", None)
        if text:
            try:
                return json.loads(text)
            except ValueError:
                continue
    return None


@asynccontextmanager
async def _mcp_http_server():
    import uvicorn
    from starlette.applications import Starlette

    # 与生产同拓扑：/mcp 精确路由 + /mcp 子路径 Mount（mcp_server.routes() 自带顺序）
    mini = Starlette(
        lifespan=lambda app: mcp_server.running(),
        routes=mcp_server.routes(),
    )
    config = uvicorn.Config(mini, host="127.0.0.1", port=0, log_level="warning")
    server = uvicorn.Server(config)
    serve_task = asyncio.create_task(server.serve())
    for _ in range(100):
        if server.started:
            break
        await asyncio.sleep(0.05)
    assert server.started, "uvicorn 没起来"
    port = server.servers[0].sockets[0].getsockname()[1]
    try:
        yield f"http://127.0.0.1:{port}/mcp"
    finally:
        server.should_exit = True
        await serve_task


async def test_protocol_initialize_list_and_call():
    from mcp import ClientSession
    from mcp.client.streamable_http import streamable_http_client

    await _seed_memory("协议级往返探测桩")
    async with _mcp_http_server() as url:
        async with streamable_http_client(url) as streams:
            read_stream, write_stream = streams[0], streams[1]
            async with ClientSession(read_stream, write_stream) as session:
                await session.initialize()
                tools = await session.list_tools()
                names = {t.name for t in tools.tools}
                assert {
                    "search_knowledge",
                    "search_history",
                    "get_user_memory",
                    "get_learning_profile",
                    "get_today_briefing",
                } <= names

                res = await session.call_tool("get_user_memory", {"limit": 5})
                assert json.dumps(_payload(res), ensure_ascii=False).find("协议级往返探测桩") >= 0

                res = await session.call_tool("get_today_briefing", {})
                assert "text" in _payload(res)
