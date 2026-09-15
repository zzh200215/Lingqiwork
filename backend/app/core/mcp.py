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
from contextvars import ContextVar
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

# 工具跑完想「额外告诉界面一件事」时的旁路。
#
# 为什么不用返回值：`call_tool -> str` 是**给模型看**的形状，塞 JSON 进去等于让模型
# 去解析副产物。而界面要的是副产物本身——最典型的是「这刀存到哪个文件了」，
# 前端靠它渲染「已存入产出」的回执链接（见 `routers/chat.py` 的 tool_result 事件）。
# 所以 handler 把结构化结果丢进这个 ContextVar，`call_tool` 在返回前捞出来交出去，
# 模型那条字符串路径一个字节都不动。ContextVar 而非实例属性：并行工具（llm.py 的
# asyncio.gather）各跑各的任务上下文，用共享属性会互相串味。
_TOOL_META: ContextVar[dict | None] = ContextVar("mcp_tool_meta", default=None)

# 这一轮已经存过哪些体裁（kind → 落点相对路径）。
#
# 为什么需要它：模型满足不了「300 字左右」这种约束时会**写一版、存一版、回头数一遍、
# 再写再存**（实测 20 轮里 5 轮存了 ≥2 次，最坏一轮 4 次）。`save_artifact` 原来对
# 「同一份东西的第 2 版」和「第 2 份东西」一视同仁，于是要么同日同名互相覆盖（前几版
# 正文静默消失，却留下 3 条指向同一文件的回执），要么换标题堆出 5 个半成品文件
# （产出清单和零柒成长值都按份数算）。一轮里同体裁的第二次落盘，语义上就是**在改
# 自己刚写的那份**，所以让它覆盖同一个文件、只留一条回执。
#
# 用 ContextVar 装一个**可变 dict**，而不是每次 set 一个新值：llm.py 的并行工具跑在
# gather 出来的子任务里，子任务里 `set()` 不会传回父上下文；但大家拿到的是同一个 dict
# 对象，改它的内容是所有上下文都能看见的。
_TURN_ARTIFACTS: ContextVar[dict[str, str] | None] = ContextVar("mcp_turn_artifacts", default=None)

# 这一轮的**字数预算**（W4）。由 `chat` 在开轮时从用户那句话里认出来传进来 ——
# 「多少字」是用户说的，不是模型自己叙述的。
_TURN_BUDGET: ContextVar[object | None] = ContextVar("mcp_turn_budget", default=None)

# 这一轮每个体裁已经**存了几次**（W4 的「单次受限修订」）。
# 为什么要在服务端数：模型满足不了字数时会写一版存一版（实测 20 轮里 5 轮 ≥2 次，最坏 4 次），
# 而它自己的估算是不可靠的。这里给一个**硬上限**：1 次初稿 + 1 次修订，第三次直接拒绝。
# 拒绝而不是静默覆盖：静默覆盖等于让它一直写下去，而每一次都要用户付 token。
_TURN_SAVES: ContextVar[dict[str, int] | None] = ContextVar("mcp_turn_saves", default=None)

# 一回合里同一个体裁最多落盘几次（1 次初稿 + 1 次修订）。改这个数要想清楚：
# 它同时是「模型还有没有机会改」和「用户要为几次生成付钱」。
MAX_SAVES_PER_KIND = 2


def begin_turn(budget=None) -> dict[str, str]:
    """开一轮：清掉上一轮的同体裁记录与修订额度。返回这个 dict，调用方不必自己 set。

    `budget` 是本轮的字数预算（`core.length_budget.Budget` 或 None），由调用方从用户那句话
    里认出来 —— 这里只负责把它挂到这一轮上，让 `save_artifact` 是**服务端在数**。
    """
    fresh: dict[str, str] = {}
    _TURN_ARTIFACTS.set(fresh)
    _TURN_BUDGET.set(budget)
    _TURN_SAVES.set({})
    return fresh


def turn_budget():
    """当前回合的字数预算（没认出来就是 None）。"""
    return _TURN_BUDGET.get()


def turn_saves(kind: str) -> int:
    """当前回合这个体裁已经存了几次。"""
    return int((_TURN_SAVES.get() or {}).get(kind, 0))


def take_tool_meta() -> dict | None:
    """取走当前调用攒下的结构化结果（读完即清，避免串到下一个工具）。"""
    meta = _TOOL_META.get()
    _TOOL_META.set(None)
    return meta


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


# 体裁 → 落点。与五个成文引擎的 `*_DIR`（`report` / `research` / `decide` /
# `conflict` / `recap` / `deliver` / `compose`）**是同一个约定**，不是新目录：
# 存下来的产出必须出现在工作页的产出清单里，否则「已存入产出」是句谎话。
# `pet._OUTPUT_DIRS` 数产出数也读这几个目录，所以这里多一个目录就等于成长值多一份。
_ARTIFACT_KINDS: dict[str, tuple[str, str]] = {
    "research": ("research", "研究"),
    "decide": ("decisions", "方案"),
    "conflict": ("conflicts", "对质"),
    "recap": ("recap", "复盘"),
    "deliver": ("deliver", "交付"),
    "compose": ("notes", "成文"),
}


async def _save_artifact(args: dict) -> str:
    """把模型已经写好的长文按体裁落进 vault，并回一个能点开的路径。

    和 `vault_write_file` 的区别在**它是产出的语义**，不是裸写文件：体裁决定落点目录
    （于是自动进工作页产出清单、自动算进零柒的成长值）、标题决定文件名，而且它会把
    落点通过 `_TOOL_META` 交给会话流，让界面渲染成「已存入产出」的回执链接而不是把
    整篇正文摊在对话里。

    正文按**原文**存——这里不做 markdown 重排，模型写成什么样就是什么样（它是给人看的
    成品，不是待解析的数据）。
    """
    kind = (args.get("kind") or "compose").strip().lower()
    if kind not in _ARTIFACT_KINDS:
        return f"[错误] kind 只能是 {'/'.join(_ARTIFACT_KINDS)} 之一"
    title = (args.get("title") or "").strip()
    content = (args.get("content") or "").strip()
    if not content:
        return "[错误] content 不能为空"

    dest_dir_name, label = _ARTIFACT_KINDS[kind]

    # ---- W4：长度约束的确定性执行 ----
    # ① 先看这一轮的修订额度用完了没有。用完就直接拒绝，**不写盘**：这是「单次受限修订」
    #    的硬上限。第三版必然是在猜字数，猜一次要用户付一次钱。
    from app.core import length_budget as lb

    done = turn_saves(kind)
    if done >= MAX_SAVES_PER_KIND:
        return (
            f"[错误] 本回合「{label}」已经存过 {done} 次（1 次初稿 + 1 次修订），"
            f"修订额度用完了 —— 现在这份就是你最新的一版，不要再重写。"
            f"请直接给用户一句回执。"
        )

    # ② 预算：**服务端认出来的优先**（那是用户的原话），认不出才用工具参数里的数。
    budget = turn_budget()
    source = "ask" if budget is not None else ""
    if budget is None:
        raw = args.get("length_budget")
        try:
            n = int(raw) if raw not in (None, "") else 0
        except (TypeError, ValueError):
            n = 0
        if lb.MIN_BUDGET <= n <= lb.MAX_BUDGET:
            budget = lb.Budget(chars=n, hard=False, phrase=f"工具参数 {n}")
            source = "tool"
    length = lb.verdict(content, budget)

    from app.core.report import slug
    dest_dir = (VAULT_DIR / dest_dir_name)
    dest_dir.mkdir(parents=True, exist_ok=True)
    from datetime import datetime

    stem = f"{datetime.now():%Y-%m-%d}-{slug(title or '产出', dest_dir_name)}"
    body = content if content.startswith("#") else f"# {title or '产出'}\n\n{content}"

    # 落点三选一。区别全在「这份东西是不是已经在别处存在」：
    turn = _TURN_ARTIFACTS.get()
    prev_path = (turn or {}).get(kind)
    body_text = body + "\n"

    def _unchanged(p: Path) -> bool:
        try:
            return p.read_text(encoding="utf-8", errors="ignore") == body_text
        except OSError:
            return False

    if prev_path:
        # 这一轮里同体裁已经存过 → 模型在改自己刚写的那份，覆盖同一个文件。
        # 不新开文件：否则「一版一个文件」把产出清单塞满，份数还会算进零柒的成长值。
        dest = VAULT_DIR / prev_path
        action = "更新"
    else:
        dest = dest_dir / f"{stem}.md"
        if dest.exists() and _unchanged(dest):
            # 逐字一样：实测出现过同一轮存两次、正文完全相同的两个 128 字版本。
            # 这一条要在挑新名字**之前**判，否则会为了「不覆盖」白白多出一个 -2.md。
            action = "未变"
        elif dest.exists():
            # 跨轮的同名不覆盖。之前那一版可能是上一轮、甚至上一个话题的东西，
            # 静默盖掉它就是丢用户的数据。另存一个不冲突的名字，并如实说「另存」。
            n = 2
            while dest.exists():
                dest = dest_dir / f"{stem}-{n}.md"
                n += 1
            action = "另存"
        else:
            action = "存为"

    if turn is not None:
        turn[kind] = dest.relative_to(VAULT_DIR).as_posix()
    # 这一轮的修订额度用掉一次（含「内容没变」那条路：它也是一次生成、一次调用）
    counts = _TURN_SAVES.get()
    if counts is not None:
        counts[kind] = done + 1

    rel = dest.relative_to(VAULT_DIR).as_posix()
    if action == "更新" and _unchanged(dest):
        action = "未变"

    # 索引是**增强**不是前置：索引器挂了产出也已经落盘了，回执照样得给出去
    chunks = 0
    if action != "未变":
        dest.write_text(body_text, encoding="utf-8")
        try:
            from app.core import indexer

            # **把 root 显式传进去**：`index_file` 的 root 默认值是在模块导入时绑死的
            # （`root: Path = VAULT_DIR`），所以任何临时换过 `VAULT_DIR` 的调用方
            # （评测的临时 vault、恢复演练）都会在这里拿到一句
            # 「not in the subpath of ...」——产出照样落盘，但索引白跑一趟还刷一屏日志。
            chunks = await asyncio.to_thread(indexer.index_file, dest, VAULT_DIR)
        except Exception:  # noqa: BLE001
            log.warning("artifact saved but indexing failed: %s", rel, exc_info=True)

    # 回执**无条件**给出去，包括「内容没变」那条路：界面靠 meta 渲染那一行链接，
    # 少给一次就等于让「只存了产出、一个字没说」的那一轮整轮消失。
    # W4：**实际字数由服务端报**（`chars`），超没超也是服务端判的（`over`）——
    # 不让「超没超」留在模型的自我叙述里。
    _TOOL_META.set(
        {
            "artifact": {
                "kind": kind,
                "label": label,
                "title": title or dest.stem,
                "path": rel,
                "href": f"/notes?path={quote_plus(rel)}",
                "chunks": chunks,
                "action": action,
                "chars": length["chars"],
                "budget": length["budget"],
                "budget_source": source,
                "hard": length["hard"],
                "over": length["over"],
                "over_by": length["over_by"],
                "save_no": done + 1,
                "revised": done > 0,
            }
        }
    )
    left = max(0, MAX_SAVES_PER_KIND - (done + 1))
    tail = _budget_tail(length, left)
    if action == "未变":
        return f"{label}「{title or dest.stem}」和已存的那份一模一样，没有重复写 → {rel}{tail}"
    verb = {"存为": "已存为", "更新": "已更新", "另存": "已另存为"}[action]
    return (
        f"{verb}{label}「{title or dest.stem}」→ {rel}"
        f"（{len(content)} 字，{chunks} 段已索引）{tail}"
    )


def _budget_tail(length: dict, left: int) -> str:
    """字数那一段话。**服务端数的数**，并明确告诉它还剩几次修订额度。

    为什么要把「还剩几次」写进工具返回：实测的失败形状是模型**反复重写重存**。以前它没有
    任何关于「还能不能改」的信息，只能凭感觉再存一次；现在这句话直接摆在它眼前，
    而真正的硬上限在 `_save_artifact` 开头（第三次直接拒绝、不写盘）。

    **「按多少算超」也一起给**：预算 300 字左右 ≠ 300 字就超了（软约束按 1.2 倍算），
    不说清这个数，它那一版就只能继续猜 —— 实测补跑的 3 版**都没落进预算**，
    最可能的原因就是它不知道自己在瞄哪个数（n=3，这只是个假设，下一轮要量）。
    """
    if length.get("budget") is None:
        return ""
    limit_kind = "上限" if length.get("hard") else "左右"
    limit = length.get("limit")
    line = f"［服务端数过］{length['chars']} 字（预算 {length['budget']} 字{limit_kind}，按 {limit} 字算超没超）"
    if not length["over"]:
        return f"\n{line} —— 没超。不要再为字数重写一版；直接给用户一句回执。"
    return (
        f"\n{line} —— **超了 {length['over_by']} 字**。要改就再存一次（会覆盖同一份文件），"
        f"目标 {length['budget']} 字左右，不要再新开文件；本回合还剩 {left} 次修订额度。"
        f"已经够用就给一句回执收尾。"
    )


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


# ---------- 联网搜索：结构化结果 + 文本格式化两层 ----------
#
# `search_web` 返回结构化结果（研究引擎直接消费）；`_web_search` 是它之上的
# 文本格式化（给 agent 的 tool 输出）。引擎顺序：配了 keenable 就排第一，
# 否则 Bing → DuckDuckGo 兜底。两层分开是为了让研究引擎拿得到标题/链接/摘要，
# 而不必去正则解析自己拼出来的编号文本。

_SEARCH_UA = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"
}


class SearchError(RuntimeError):
    """所有搜索引擎都没结果时抛出，携带每家的失败原因。"""


def _search_bing(query: str) -> list[tuple[str, str, str]]:
    req = Request("https://www.bing.com/search?q=" + quote_plus(query), headers=_SEARCH_UA)
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


def _search_ddg(query: str) -> list[tuple[str, str, str]]:
    # fallback: DuckDuckGo HTML endpoint (needs direct access)
    req = Request(
        "https://html.duckduckgo.com/html/?q=" + quote_plus(query), headers=_SEARCH_UA
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


def _search_keenable(query: str, ws_key: str) -> list[tuple[str, str, str]]:
    req = Request(
        "https://api.keenable.ai/v1/search",
        data=json.dumps({"query": query, "max_results": 8}).encode("utf-8"),
        headers={"X-API-Key": ws_key, "Content-Type": "application/json", **_SEARCH_UA},
    )
    with urlopen(req, timeout=15) as resp:
        data = json.loads(resp.read(1_000_000).decode("utf-8", "ignore"))
    results: list[tuple[str, str, str]] = []
    for r in data.get("results", [])[:8]:
        title = str(r.get("title") or "").strip()
        url = str(r.get("url") or "").strip()
        snippet = str(r.get("snippet") or r.get("description") or "").strip()
        if title and url.startswith("http"):
            results.append((title, url, snippet[:300]))
    return results


async def search_web(query: str) -> list[dict]:
    """联网搜索 → [{title, url, snippet}]。所有引擎都没结果时抛 `SearchError`。

    研究引擎的消费口；`_web_search`（agent 工具）是它之上的文本格式化。
    Test seam: monkeypatch me.
    """
    query = (query or "").strip()
    if not query:
        return []

    cfg = load_config()
    ws_api = str(cfg.get("websearch_api") or "").strip()
    ws_key = str(cfg.get("websearch_api_key") or "").strip()

    engines: list[tuple[str, object]] = []
    if ws_api == "keenable" and ws_key:
        engines.append(("keenable", lambda: _search_keenable(query, ws_key)))
    engines += [("bing", lambda: _search_bing(query)), ("duckduckgo", lambda: _search_ddg(query))]

    errors = []
    for engine, fn in engines:
        try:
            results = await asyncio.to_thread(fn)
        except Exception as e:  # noqa: BLE001 - one blocked engine falls through to the next
            errors.append(f"{engine}: {type(e).__name__}")
            continue
        if results:
            return [{"title": t, "url": u, "snippet": s} for t, u, s in results]
        errors.append(f"{engine}: 无结果")
    raise SearchError("; ".join(errors))


async def _web_search(args: dict) -> str:
    query = (args.get("query") or "").strip()
    if not query:
        return "[错误] query 不能为空"
    try:
        results = await search_web(query)
    except SearchError as e:
        return f"[tool error] 所有搜索引擎都失败（{e}）"

    lines = []
    for i, r in enumerate(results, 1):
        lines.append(
            f"{i}. {r['title']}\n   {r['url']}"
            + (f"\n   {r['snippet']}" if r["snippet"] else "")
        )
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
        "name": "save_artifact",
        "description": (
            "把一份**写好的成品**存进 vault 的产出区，并让它在工作页的产出清单里出现。"
            "写周报、调研、方案、复盘、交付稿这类成篇的东西，一律用它存——**别把长文直接"
            "写在回复里**，长篇正文会淹掉对话。存完只回一句「已存入产出」，正文用户点链接看。"
            "**一轮里同一个体裁最多存两次**（1 次初稿 + 1 次修订，第三次会被服务端拒绝）："
            "写完直接存，字数不对就在 content 里改好再存一次（会覆盖同一份文件）；"
            "返回里会告诉你**服务端数出来的实际字数**以及还剩几次修订额度，按那个来，别自己估。"
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "kind": {
                    "type": "string",
                    "enum": list(_ARTIFACT_KINDS),
                    "description": "体裁：research 调研 / decide 方案 / conflict 对质 / recap 复盘 / deliver 交付稿 / compose 成文",
                },
                "title": {"type": "string", "description": "标题，一句话说清这份东西是什么"},
                "content": {"type": "string", "description": "成品正文（Markdown）"},
                "length_budget": {
                    "type": "integer",
                    "description": (
                        "可选：用户要的字数上限。用户在对话里说清了（如「300 字左右」）时"
                        "**不必填**，服务端自己认；只有在服务端认不出、而你确实知道目标字数时才填。"
                    ),
                },
            },
            "required": ["title", "content"],
        },
        "handler": _save_artifact,
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
        if name.startswith(("vault_", "memory_", "skill_")) or name in (
            "fetch_url",
            "web_search",
            "kb_search",
            "image_gen",
            "save_artifact",
        ):
            handler = _BUILTIN_BY_NAME.get(name)
            if not handler:
                return f"[tool error] 未知工具 {name!r}"
            # 内置工具的副产物（如落盘路径）由 handler 写进 `_TOOL_META`，调用方在自己
            # 的任务里用 `take_tool_meta()` 取。不存 self：并行工具（llm.py 的 gather）
            # 会在这个共享属性上打架。进入前先清干净，免得上一个工具的残留被读走。
            _TOOL_META.set(None)
            try:
                out = await handler["handler"](args or {})
            except Exception as e:  # noqa: BLE001
                out = f"[tool error] {type(e).__name__}: {e}"
            return str(out)

        # 宠物能力插件（P3）：零柒 "会干活" 的那双手。声明与实现在 `pet_plugins`，
        # 这里只做**分派**——不加这一段，`pet_focus_start` 会掉进下面的 MCP 分支，
        # 报「server 'pet_focus_start' 未连接」。
        if name.startswith("pet_"):
            from app.core import pet_plugins

            _TOOL_META.set(None)
            try:
                out, meta = await pet_plugins.call_tool(name, args or {})
            except Exception as e:  # noqa: BLE001
                return f"[tool error] {type(e).__name__}: {e}"
            if meta:
                _TOOL_META.set(meta)
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