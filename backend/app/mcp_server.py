"""Expose the workbench's persistent memory as a local MCP server (V6.3).

Run (stdio transport):
    uv run --directory <backend> python -m app.mcp_server

Register in any MCP client (Claude Desktop, Cursor, ...) to share the same
memory the workbench uses — mem0 retired its local OpenMemory stack in 2026,
so local-first personal memory is the gap this fills.

Reads the same data/workbench.db as the main app (override with WB_DB_PATH);
all tools go through app.core.memory, so semantic dedup applies here too.
"""
from app.core import memory
from mcp.server.mcpserver import MCPServer

server = MCPServer(
    "workbench-memory",
    title="AI Workbench Memory",
    instructions=(
        "用户的个人长期记忆库（AI Workbench）。"
        "memory_add 保存关于用户的持久事实，保存前会自动做语义去重。"
    ),
)


@server.tool(description="列出全部长期记忆（每条一行，带 id）。")
async def memory_list() -> str:
    rows = await memory.list_memories()
    if not rows:
        return "(暂无长期记忆)"
    return "\n".join(f"#{m.id}: {m.content}" for m in rows)


@server.tool(description="添加一条关于用户的长期记忆（单条事实陈述，≤300 字）。重复/近似内容会被自动拒绝。")
async def memory_add(content: str) -> str:
    return await memory.add_memory(content)


@server.tool(description="按 id 修改一条长期记忆的内容。")
async def memory_update(id: int, content: str) -> str:
    return await memory.update_memory(int(id), content)


@server.tool(description="删除长期记忆：按 id，或按内容精确匹配。")
async def memory_delete(id: int | None = None, content: str | None = None) -> str:
    return await memory.remove_memory(
        memory_id=int(id) if id is not None else None,
        content=content,
    )


if __name__ == "__main__":
    server.run(transport="stdio")
