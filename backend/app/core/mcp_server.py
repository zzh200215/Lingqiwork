"""MCP server 端：把工作台的理解状态开放给本地外部工具。

`core/mcp.py` 是客户端（工作台去调外部 MCP 服务器）；这个模块是反方向——
外部工具（Claude Desktop、其他 AI 客户端）连进来，「看」工作台攒下的东西：
知识库检索、对话/教学历史、长期记忆、学习画像、今日建议。

传输选 streamable HTTP 挂进现有 FastAPI（/mcp）而不是 stdio：stdio 要把本
进程当子进程拉起，索引、DB 连接、模型缓存全得再来一份。同一个 uvicorn 本来
就只绑 127.0.0.1（desktop.py HOST），加上 SDK 自带的 DNS-rebinding 防护，
不出本机。刻意只暴露**读**工具——外部工具看工作台，改动仍走工作台自己的
界面，权限边界就是「只读」本身，不加开关。

坑位记录（两个都踩过）：
1. streamable_http_app() 把 session manager 的启动挂在**被挂载 app**自己的
   lifespan 上，而 Starlette 的 mount 不会跑子 app 的 lifespan——所以 main.py
   必须在主 lifespan 里 `async with mcp_server.running():`。
2. 根上挂着 StaticFiles 时，`Mount("/mcp")` 对**不带斜杠的裸前缀**不再匹配
   （连 307 重定向都没有），请求直接落到静态文件变 405；`/mcp/` 倒是一切
   正常。所以 install() 用「/mcp 精确路由 + /mcp 子路径 Mount」双保险：精确
   路由把 path 重写成 / 再转交子应用，任何前缀形态都可达。
"""
import logging

from mcp.server.mcpserver import MCPServer
from starlette.routing import Mount, Route

log = logging.getLogger(__name__)

mcp = MCPServer(
    name="ai-workbench",
    instructions=(
        "本地个人 AI 工作台的只读入口。工具全是查询：知识库检索、对话与教学"
        "历史搜索、长期记忆、学习画像、今日建议。没有写操作。"
    ),
)

MAX_LIMIT = 20


@mcp.tool()
async def search_knowledge(query: str, limit: int = 5) -> list[dict]:
    """在用户的知识库里检索（markdown 笔记、剪藏、代码仓库 chunk，混合检索）。

    返回 [{text, source, score}]，score 是 0-1 的相似度。想了解「他收藏过/
    笔记里写过什么」时用这个。
    """
    import asyncio

    from app.core.indexer import search_auto

    hits = await asyncio.to_thread(search_auto, query, max(1, min(limit, MAX_LIMIT)))
    return [{"text": h["text"], "source": h.get("source"), "score": h.get("score")} for h in hits]


@mcp.tool()
async def search_history(q: str, limit: int = 10) -> list[dict]:
    """在用户的聊天与教学历史里做全文搜索（LIKE 匹配）。

    返回 [{source: chat|tutor, title, role, excerpt, at}]。想找「他之前说过/
    问过什么」时用这个，先于 search_knowledge——那是他的笔记，这是他的对话。
    """
    from app.db import SessionLocal
    from app.routers.search import global_search

    async with SessionLocal() as db:
        out = await global_search(q=q, limit=max(1, min(limit, MAX_LIMIT)), db=db)
    return out["results"]


@mcp.tool()
async def get_user_memory(limit: int = 50) -> list[dict]:
    """读工作台对用户的长期记忆（偏好 / 事实 / 习惯 / 洞察，automemory 抽取 + 手工添加）。

    返回 [{kind, content, at, evidence_n}]。evidence_n 是这条记忆挂着的原句依据数
    （洞察与合并行才有，0 = 直接来自对话或手写）。代表「工作台理解的这个人是什么样」，
    回答个人相关问题前值得先看一眼。
    """
    from app.core.memory import list_memories, parse_evidence
    from app.models import iso_utc

    rows = await list_memories()
    return [
        {
            "kind": m.kind,
            "content": m.content,
            # naive UTC 裸 isoformat 会被消费方当本地读（本时区差 8 小时）；走 iso_utc 补偏移。
            "at": iso_utc(m.created_at),
            "evidence_n": len(parse_evidence(m.evidence_json)),
        }
        for m in rows[: max(1, min(limit, 100))]
    ]


@mcp.tool()
async def get_learning_profile() -> dict:
    """读学习画像：教学记录里已搞懂 / 半懂的概念与学习偏好。

    苏格拉底教学的副产物。要辅导这位用户、或想知道「他学到哪了」时用。
    """
    from app.core.tutor import profile

    return await profile()


@mcp.tool()
async def get_today_briefing() -> dict:
    """读今日建议：一条人话总结 + 建议动作（哪些后台出问题了、该去看什么）。

    纯规则零模型调用，后端不健康时它反而最有用。
    """
    from app.routers.today import today_next

    return await today_next()


_child = None  # asgi_app() 时创建的子应用，补位路由转交给它


def asgi_app():
    """MCP 子应用（streamable HTTP，stateless，内部路由在 /）。"""
    global _child
    _child = mcp.streamable_http_app(streamable_http_path="/", stateless_http=True)
    return _child


class _BareEntrypoint:
    """裸 /mcp 的补位：重写 path 为 / 后转交子应用（见模块 docstring 坑位 2）。"""

    async def __call__(self, scope, receive, send):
        if _child is None:
            raise RuntimeError("mcp_server.routes() 尚未安装")
        scope = dict(scope)
        scope["path"] = "/"
        await _child(scope, receive, send)


def routes() -> list:
    """装到宿主 app 上的路由组：精确 /mcp 在前，子路径 Mount 在后。

    顺序刻意如此：裸 /mcp 命中精确路由（不再依赖 Mount 对裸前缀的匹配），
    /mcp/… 命中 Mount。宿主必须在静态文件的 / 挂载**之前**调用。
    """
    return [
        Route("/mcp", endpoint=_BareEntrypoint(), methods=["GET", "POST", "DELETE"]),
        Mount("/mcp", app=asgi_app()),
    ]


def running():
    """在主 app 的 lifespan 里进入：启动/停掉 MCP 的 session manager。

    mount 不跑子 app 的 lifespan，所以由 main.py 显式包住。
    """
    return mcp.session_manager.run()
