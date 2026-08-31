"""One-off smoke for V6.3: the memory MCP server (app.mcp_server).

Spawns the server as a real subprocess over stdio (exactly what Claude
Desktop / Cursor would do), lists tools, and exercises add/list/update/delete
against a scratch db. Semantic dedup runs for real (embeddings load on first
add).
"""
import asyncio
import json
import os
import shutil
import sys
import urllib.request  # noqa: F401  (placeholder, unused)
from pathlib import Path

BACKEND = Path("D:/TP/A/backend")
SCRATCH = BACKEND / ".smoke18"

sys.path.insert(0, ".")
os.environ["WB_DB_PATH"] = str(SCRATCH / "smoke.db")
os.environ["WB_CONFIG_PATH"] = str(SCRATCH / "config.json")

from mcp import ClientSession, StdioServerParameters  # noqa: E402
from mcp.client.stdio import stdio_client  # noqa: E402

from app.core import memory  # noqa: E402  (verify tools route to the same core)
from app.db import engine  # noqa: E402
from app.models import Base  # noqa: E402


def text_of(result) -> str:
    return "\n".join(getattr(b, "text", "") for b in result.content)


async def create_tables() -> None:
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)


async def main() -> None:
    shutil.rmtree(SCRATCH, ignore_errors=True)
    SCRATCH.mkdir(parents=True)
    await create_tables()

    params = StdioServerParameters(
        command="uv",
        args=["--directory", str(BACKEND), "run", "python", "-m", "app.mcp_server"],
        env={
            **os.environ,
            "WB_DB_PATH": str(SCRATCH / "smoke.db"),
            "WB_CONFIG_PATH": str(SCRATCH / "config.json"),
        },
    )
    async with stdio_client(params) as (read, write):
        async with ClientSession(read, write) as s:
            await s.initialize()

            tools = (await s.list_tools()).tools
            names = {t.name for t in tools}
            assert {"memory_list", "memory_add", "memory_update", "memory_delete"} <= names, names
            print(f"tools listed: {sorted(names)}")

            r = await s.call_tool("memory_add", {"content": "冒烟记忆：用户偏好浅色主题"})
            assert not r.is_error and "已记住" in text_of(r), text_of(r)

            # semantic dedup through the server too
            r = await s.call_tool("memory_add", {"content": "冒烟记忆：用户偏爱浅色主题"})
            assert "已存在相似记忆" in text_of(r), text_of(r)

            r = await s.call_tool("memory_list", {})
            assert "浅色主题" in text_of(r), text_of(r)

            r = await s.call_tool("memory_update", {"id": 1, "content": "冒烟记忆：用户偏好深色主题"})
            assert "已更新" in text_of(r), text_of(r)

            r = await s.call_tool("memory_delete", {"id": 1})
            assert "已删除" in text_of(r), text_of(r)

            r = await s.call_tool("memory_list", {})
            assert "暂无长期记忆" in text_of(r), text_of(r)
            print("add/dedup/list/update/delete ok")

    rows = await memory.list_memories()
    assert rows == []
    print("SMOKE PASS (server wrote to the scratch db shared with this process)")


if __name__ == "__main__":
    asyncio.run(main())
