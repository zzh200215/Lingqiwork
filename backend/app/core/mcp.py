"""Tool gateway: built-in local tools + MCP servers (stdio / sse).

The chat loop asks the model which tool to call; the executor here runs it.
MCP servers are configured in `data/config.json` under `mcp_servers`:

    [
        {"name": "filesystem", "type": "stdio",
         "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "<dir>"],
         "enabled": true},
        {"name": "remote", "type": "sse", "url": "https://.../sse", "enabled": true}
    ]

    Server tool names are exposed to the model as `{server}__{tool}` — double
    underscore, because OpenAI-compatible APIs only allow [a-zA-Z0-9_-] in
    function names. Built-in vault / fetch tools are always available.
"""
import asyncio
import json
import logging
import re
import shutil
import sys
from contextlib import AsyncExitStack
from dataclasses import dataclass, field
from html import unescape
from pathlib import Path
from urllib.parse import quote_plus, unquote
from urllib.request import Request, urlopen

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

from app.config import VAULT_DIR
from app.core.prefs import load_config

log = logging.getLogger(__name__)

_VAULT_ROOT = VAULT_DIR.resolve()
_OUTPUT_LIMIT = 40000  # chars, keep tool output from blowing up the context


# ---------- built-in tools ----------

async def _resolve_vault_path(rel: str) -> Path:
    rel = (rel or "").strip().lstrip("/\\")
    p = (_VAULT_ROOT / rel).resolve()
    if not p.is_relative_to(_VAULT_ROOT):
        raise ValueError(f"路径 '{rel}' 越过了 vault 目录")
    return p


async def _read_file(args: dict) -> str:
    target = args.get("path", "")
    p = await _resolve_vault_path(target)
    if not p.exists():
        return f"[未找到] vault 下没有 {target or '.'}"
    if p.is_dir():
        return f"[{p.name} 是目录] 用 vault_list_files 查看内容"
    text = p.read_text(encoding="utf-8", errors="ignore")
    if len(text) > _OUTPUT_LIMIT:
        text = text[:_OUTPUT_LIMIT] + "\n...[已截断]"
    return text


async def _list_files(args: dict) -> str:
    p = await _resolve_vault_path(args.get("path", ""))
    if not p.exists():
        return f"[未找到] vault 下没有 {args.get('path', '.')}"
    rows = []
    for child in sorted(p.iterdir(), key=lambda c: (c.is_file(), c.name)):
        prefix = "📁" if child.is_dir() else "📄"
        rows.append(f"{prefix} {child.name}")
    return "\n".join(rows) or "(空目录)"


async def _write_file(args: dict) -> str:
    rel = (args.get("path") or "").strip().lstrip("/\\")
    if not rel:
        return "[错误] path 不能为空"
    content = args.get("content", "")
    p = await _resolve_vault_path(rel)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(content, encoding="utf-8")
    return f"已写入 {rel}（{len(content)} 字），将自动重新索引供 RAG 检索"


async def _fetch_url(args: dict) -> str:
    url = (args.get("url") or "").strip()
    if not re.match(r"^https?://", url, re.I):
        return "[错误] URL 必须以 http:// 或 https:// 开头"

    def _load() -> str:
        req = Request(url, headers={"User-Agent": "Mozilla/5.0 (AI-Workbench) curl/8"})
        with urlopen(req, timeout=15) as resp:
            raw = resp.read(300_000).decode("utf-8", "ignore")
        raw = re.sub(r"(?is)<(script|style|noscript|svg).*?</\1>", " ", raw)
        raw = re.sub(r"(?is)<(br|/p|/div|/li|/h[1-6])[^>]*>", "\n", raw)
        raw = re.sub(r"(?s)<[^>]+>", " ", raw)
        text = unescape(raw)
        text = re.sub(r"[ \t]+", " ", text)
        text = re.sub(r"\n\s*\n+", "\n\n", text).strip()
        return text or "(页面没有可读正文)"

    text = await asyncio.to_thread(_load)
    if len(text) > _OUTPUT_LIMIT:
        text = text[:_OUTPUT_LIMIT] + "\n...[已截断]"
    return text


async def _kb_search(args: dict) -> str:
    from app.core import indexer

    query = (args.get("query") or "").strip()
    if not query:
        return "[错误] query 不能为空"
    try:
        top_k = int(args.get("top_k") or 5)
    except (TypeError, ValueError):
        top_k = 5
    top_k = max(1, min(top_k, 10))
    hits = await asyncio.to_thread(indexer.search_auto, query, top_k)
    if not hits:
        return "(知识库无相关内容)"
    lines = []
    for i, h in enumerate(hits, 1):
        channels = "/".join(h.get("channels", [])) or "vec"
        text = h["text"]
        if len(text) > 600:
            text = text[:600] + "…[截断]"
        lines.append(f"[{i}] {h['source']} · chunk {h['chunk']} · {channels} · score {h['score']:.4f}\n{text}")
    out = "\n\n".join(lines)
    if len(out) > _OUTPUT_LIMIT:
        out = out[:_OUTPUT_LIMIT] + "\n...[已截断]"
    return out


async def _memory_save(args: dict) -> str:
    from app.core import memory

    content = (args.get("content") or "").strip()
    if not content or len(content) > 300:
        return "[错误] content 必须是 1-300 字的单条事实陈述"
    return await memory.add_memory(content)


async def _memory_list(args: dict) -> str:
    from app.core import memory

    rows = await memory.list_memories()
    if not rows:
        return "(暂无长期记忆)"
    return "\n".join(f"#{m.id}: {m.content}" for m in rows)


async def _memory_delete(args: dict) -> str:
    from app.core import memory

    mid = args.get("id")
    content = args.get("content")
    if mid is None and not content:
        return "[错误] 需要 id 或 content 之一"
    try:
        mid = int(mid) if mid is not None else None
    except (TypeError, ValueError):
        return "[错误] id 必须是整数（先 memory_list 查看）"
    return await memory.remove_memory(memory_id=mid, content=content)


async def _skill_load(args: dict) -> str:
    from app.core import skills

    return await skills.load_skill_tool(args)


async def _web_search(args: dict) -> str:
    query = (args.get("query") or "").strip()
    if not query:
        return "[错误] query 不能为空"

    _UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"}

    def _search_bing() -> list[tuple[str, str, str]]:
        req = Request("https://www.bing.com/search?q=" + quote_plus(query), headers=_UA)
        with urlopen(req, timeout=15) as resp:
            html = resp.read(500_000).decode("utf-8", "ignore")
        results: list[tuple[str, str, str]] = []
        for block in re.findall(
            r'<li class="b_algo"(.*?)(?=<li class="b_algo"|</ol>)', html, re.S
        )[:8]:
            m = re.search(r'<h2[^>]*><a[^>]*href="([^"]+)"[^>]*>(.*?)</a>', block, re.S)
            if not m:
                continue
            title = unescape(re.sub(r"(?s)<[^>]+>", "", m.group(2))).strip()
            sn = re.search(r"<p[^>]*>(.*?)</p>", block, re.S)
            snippet = (
                unescape(re.sub(r"(?s)<[^>]+>", "", sn.group(1))).strip()
                if sn
                else ""
            )
            if title and m.group(1).startswith("http"):
                results.append((title, m.group(1), snippet[:300]))
        return results

    def _search_ddg() -> list[tuple[str, str, str]]:
        # fallback: DuckDuckGo HTML endpoint (needs direct access)
        req = Request(
            "https://html.duckduckgo.com/html/?q=" + quote_plus(query), headers=_UA
        )
        with urlopen(req, timeout=15) as resp:
            html = resp.read(500_000).decode("utf-8", "ignore")
        results: list[tuple[str, str, str]] = []
        blocks = re.findall(
            r'<a[^>]+class="result__a"[^>]*href="([^"]+)"[^>]*>(.*?)</a>(.*?)(?=<a[^>]+class="result__a"|$)',
            html,
            re.S,
        )
        for url, title_html, rest in blocks[:8]:
            title = unescape(re.sub(r"(?s)<[^>]+>", "", title_html)).strip()
            snippet_m = re.search(r'class="result__snippet"[^>]*>(.*?)</a>', rest, re.S)
            snippet = (
                unescape(re.sub(r"(?s)<[^>]+>", "", snippet_m.group(1))).strip()
                if snippet_m
                else ""
            )
            uddg = re.search(r"uddg=([^&]+)", url)
            if uddg:
                url = unquote(uddg.group(1))
            if url.startswith("//"):
                url = "https:" + url
            if title:
                results.append((title, url, snippet[:300]))
        return results

    errors = []
    for engine, fn in (("bing", _search_bing), ("duckduckgo", _search_ddg)):
        try:
            results = await asyncio.to_thread(fn)
        except Exception as e:  # noqa: BLE001 - one blocked engine falls through to the next
            errors.append(f"{engine}: {type(e).__name__}")
            continue
        if results:
            break
        errors.append(f"{engine}: 无结果")
    else:
        return f"[tool error] 所有搜索引擎都失败（{'; '.join(errors)}）"

    lines = []
    for i, (title, url, snippet) in enumerate(results, 1):
        lines.append(f"{i}. {title}\n   {url}" + (f"\n   {snippet}" if snippet else ""))
    out = "\n\n".join(lines)
    if len(out) > _OUTPUT_LIMIT:
        out = out[:_OUTPUT_LIMIT] + "\n...[已截断]"
    return out


async def _image_gen(args: dict) -> str:
    from app.core import images

    if not images.config()["enabled"]:
        return "[错误] 图片生成已在设置页关闭"
    try:
        return await images.generate_markdown(
            args.get("prompt") or "", size=(args.get("size") or "")
        )
    except ValueError as e:
        return f"[错误] {e}"


BUILTIN_TOOLS: list[dict] = [
    {
        "name": "vault_read_file",
        "description": "读取知识库 vault 中某个文件的内容。path 为相对 vault 根目录的路径。",
        "parameters": {
            "type": "object",
            "properties": {"path": {"type": "string", "description": "相对路径，如 notes/foo.md"}},
            "required": ["path"],
        },
        "handler": _read_file,
    },
    {
        "name": "vault_list_files",
        "description": "列出知识库 vault 目录下的文件和子目录，便于定位笔记。",
        "parameters": {
            "type": "object",
            "properties": {"path": {"type": "string", "description": "可选相对目录，默认根目录"}},
        },
        "handler": _list_files,
    },
    {
        "name": "vault_write_file",
        "description": "在知识库 vault 中创建或覆盖写一个文件（常用于保存整理后的笔记）。写入后自动重新索引，可被 RAG 检索。",
        "parameters": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "相对路径，如 notes/摘要.md"},
                "content": {"type": "string", "description": "文件完整内容"},
            },
            "required": ["path", "content"],
        },
        "handler": _write_file,
    },
    {
        "name": "fetch_url",
        "description": "抓取一个网页并把正文转为纯文本返回，用于查看网上资料、阅读文档。",
        "parameters": {
            "type": "object",
            "properties": {"url": {"type": "string", "description": "http(s) 网页地址"}},
            "required": ["url"],
        },
        "handler": _fetch_url,
    },
    {
        "name": "web_search",
        "description": (
            "联网搜索：用关键词搜索网页，返回标题/链接/摘要列表。"
            "需要最新信息、不确定的事实、或用户明确要求搜索时使用；"
            "拿到结果后可用 fetch_url 阅读具体页面。"
        ),
        "parameters": {
            "type": "object",
            "properties": {"query": {"type": "string", "description": "搜索关键词"}},
            "required": ["query"],
        },
        "handler": _web_search,
    },
    {
        "name": "kb_search",
        "description": (
            "检索用户的个人知识库（笔记/PDF/文档），返回最相关的文本片段。"
            "当用户问到可能记在笔记里的内容、或需要用户私有资料作答时使用；"
            "回答时标注来源文件。"
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "检索关键词或问题"},
                "top_k": {"type": "integer", "description": "返回片段数，默认 5"},
            },
            "required": ["query"],
        },
        "handler": _kb_search,
    },
    {
        "name": "image_gen",
        "description": (
            "文生图：按描述生成图片并返回可直接展示的 markdown（![](/api/images/xxx.png)）。"
            "用户要求画图/配图/生成图片时使用；prompt 越具体越好（主体、风格、构图、光线），"
            "生成需要 30-90 秒，一次调用即可，不要重复调用。"
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "prompt": {"type": "string", "description": "图片描述，中英文均可"},
                "size": {
                    "type": "string",
                    "description": "可选尺寸，如 1024*1024 / 1664*928，或比例 16:9；默认用设置页配置",
                },
            },
            "required": ["prompt"],
        },
        "handler": _image_gen,
    },
    {
        "name": "memory_save",
        "description": (
            "保存一条关于用户的长期记忆（单条事实，如偏好、背景、约定）。"
            "只在用户明确表达个人偏好/重要背景信息时使用，不要记普通聊天内容。"
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "content": {"type": "string", "description": "一条完整事实陈述，如「用户偏好 Python」"}
            },
            "required": ["content"],
        },
        "handler": _memory_save,
    },
    {
        "name": "memory_list",
        "description": "列出已保存的全部长期记忆。",
        "parameters": {"type": "object", "properties": {}},
        "handler": _memory_list,
    },
    {
        "name": "memory_delete",
        "description": "删除一条长期记忆，按 id 或按内容匹配。先用 memory_list 查看现有记忆。",
        "parameters": {
            "type": "object",
            "properties": {
                "id": {"type": "integer", "description": "要删除的记忆 id"},
                "content": {"type": "string", "description": "或按内容精确匹配删除"},
            },
        },
        "handler": _memory_delete,
    },
    {
        "name": "skill_load",
        "description": (
            "加载一个「技能」的完整指令内容（技能清单见系统提示）。"
            "当当前任务与某个技能的描述相关时，先调用本工具加载全文，再遵循其中的指导执行。"
        ),
        "parameters": {
            "type": "object",
            "properties": {"name": {"type": "string", "description": "技能名（来自技能清单）"}},
            "required": ["name"],
        },
        "handler": _skill_load,
    },
]

_BUILTIN_BY_NAME = {b["name"]: b for b in BUILTIN_TOOLS}

# map tool->actual server for MCP tools (server__tool -> server)
# handled inline via name.partition("__").


# ---------- MCP client manager ----------

@dataclass
class McpTool:
    server: str
    name: str
    description: str
    input_schema: dict = field(default_factory=dict)


def _resolve_command(command: str) -> str:
    """Windows can't spawn `npx`/`uvx` (.cmd) directly — resolve the real path."""
    if not sys.platform.startswith("win"):
        return command
    if "/" in command or "\\" in command or Path(command).suffix:
        p = Path(command).expanduser()
        return str(p if p.is_absolute() else p.resolve())
    resolved = shutil.which(command)
    return resolved or command


class McpManager:
    """Owns zero or more MCP client sessions + their tool inventory."""

    def __init__(self) -> None:
        self._stacks: dict[str, AsyncExitStack] = {}
        self._sessions: dict[str, ClientSession] = {}
        self._tools: list[McpTool] = []
        self._status: dict[str, dict] = {}
        self._lock = asyncio.Lock()

    # ---------- introspection ----------

    @property
    def status(self) -> dict:
        return dict(self._status)

    def tool_specs(self, include_memory: bool = True) -> list[dict]:
        """OpenAI-style function specs handed to the model's `tools` parameter."""
        prefs = load_config()
        flat = []
        for b in BUILTIN_TOOLS:
            if b["name"].startswith("memory_") and not include_memory:
                continue
            if b["name"] == "image_gen" and not prefs.get("image_enabled", True):
                continue
            flat.append({"name": b["name"], "description": b["description"], "parameters": b["parameters"]})
        for t in self._tools:
            flat.append(
                {
                    "name": f"{t.server}__{t.name}",
                    "description": f"[{t.server}] {t.description}",
                    "parameters": t.input_schema
                    or {"type": "object", "properties": {}},
                }
            )
        return [
            {"type": "function", "function": spec} for spec in flat
        ]

    def active_tools(self) -> list[dict]:
        return [
            {"server": t.server, "name": t.name, "description": t.description}
            for t in self._tools
        ]

    # ---------- lifecycle ----------

    async def reload(self) -> None:
        async with self._lock:
            await self._close_all()
            servers = [s for s in load_config().get("mcp_servers", []) if s.get("enabled", True)]
            for sv in servers:
                name = sv.get("name") or "?"
                try:
                    count = await self._connect(sv)
                    self._status[name] = {"ok": True, "tools": count, "error": None}
                except Exception as e:  # one bad server must not kill the rest
                    self._status[name] = {"ok": False, "tools": 0, "error": f"{type(e).__name__}: {e}"}
                    log.warning("MCP server %r failed: %s", name, e)

    async def close(self) -> None:
        async with self._lock:
            await self._close_all()

    async def _close_all(self) -> None:
        for name, stack in list(self._stacks.items()):
            try:
                await stack.aclose()
            except Exception as e:  # noqa: BLE001
                log.warning("closing MCP %r: %s", name, e)
        self._stacks.clear()
        self._sessions.clear()
        self._tools.clear()
        self._status.clear()

    async def _connect(self, sv: dict) -> int:
        stack = AsyncExitStack()
        name = sv["name"]
        try:
            if sv.get("type") == "sse":
                from mcp.client.sse import sse_client

                ctx = sse_client(sv["url"])
            else:
                command = _resolve_command(sv.get("command") or "python")
                ctx = stdio_client(
                    StdioServerParameters(
                        command=command,
                        args=sv.get("args") or [],
                        env=None,
                    )
                )
            read, write = await stack.enter_async_context(ctx)
            session = await stack.enter_async_context(ClientSession(read, write))
            await session.initialize()
            result = await session.list_tools()
        except Exception:
            await stack.aclose()
            raise

        self._stacks[name] = stack
        self._sessions[name] = session
        for t in result.tools:
            self._tools.append(
                McpTool(
                    server=name,
                    name=t.name,
                    description=t.description or "",
                    input_schema=dict(t.input_schema or {}),
                )
            )
        return len(result.tools)

    # ---------- execution ----------

    async def call_tool(self, name: str, args: dict) -> str:
        """Run a built-in or MCP tool. Returns output text (never raises for tool errors)."""
        if name.startswith(("vault_", "memory_", "skill_")) or name in ("fetch_url", "web_search", "kb_search", "image_gen"):
            handler = _BUILTIN_BY_NAME.get(name)
            if not handler:
                return f"[tool error] 未知工具 {name!r}"
            try:
                out = await handler["handler"](args or {})
            except Exception as e:  # noqa: BLE001
                out = f"[tool error] {type(e).__name__}: {e}"
            return str(out)

        server, _, tool = name.partition("__")
        session = self._sessions.get(server)
        if not session:
            return f"[tool error] MCP server '{server}' 未连接"
        try:
            result = await session.call_tool(tool, args or {})
        except Exception as e:  # noqa: BLE001
            return f"[tool error] {server}__{tool} → {type(e).__name__}: {e}"

        parts = []
        for block in result.content:
            if getattr(block, "type", "") == "text":
                parts.append(str(getattr(block, "text", "")))
            elif getattr(block, "type", "") == "image":
                parts.append("[image]")
            else:
                try:
                    parts.append(json.dumps(block.model_dump(exclude_none=True), ensure_ascii=False))
                except Exception:  # noqa: BLE001
                    parts.append(str(block))
        if result.structured_content is not None:
            parts.append(json.dumps(result.structured_content, ensure_ascii=False))
        out = "\n".join(parts).strip()
        if result.is_error:
            out = f"[tool error]\n{out}" if out else f"[tool error] {server}__{tool}"
        if len(out) > _OUTPUT_LIMIT:
            out = out[:_OUTPUT_LIMIT] + "\n...[已截断]"
        return out or "(无输出)"

    async def probe(self, sv: dict) -> dict:
        """Connect a throwaway copy of a server config and report its tools (for the test button)."""
        name = sv.get("name") or "?"
        stack = AsyncExitStack()
        try:
            if sv.get("type") == "sse":
                from mcp.client.sse import sse_client

                ctx = sse_client(sv["url"])
            else:
                command = _resolve_command(sv.get("command") or "python")
                ctx = stdio_client(
                    StdioServerParameters(command=command, args=sv.get("args") or [], env=None)
                )
            read, write = await stack.enter_async_context(ctx)
            session = await stack.enter_async_context(ClientSession(read, write))
            await session.initialize()
            result = await session.list_tools()
            names = [t.name for t in result.tools]
            await stack.aclose()
            return {"name": name, "ok": True, "tools": names, "error": None}
        except Exception as e:  # noqa: BLE001
            await stack.aclose()
            return {"name": name, "ok": False, "tools": [], "error": f"{type(e).__name__}: {e}"}


mcp_manager = McpManager()