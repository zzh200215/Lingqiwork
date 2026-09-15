"""Streaming chat endpoint (SSE) with optional RAG + tool calling.

Flow: persist user message -> [optional RAG retrieval] -> agentic LLM loop
(streams text, may call tools via MCP/built-ins) -> persist assistant message.
Text deltas and tool-call events are pumped to the client through an
asyncio.Queue so streaming stays live while tools execute.
Client disconnect stops the upstream request.
"""
import asyncio
import base64
import json
import logging
import mimetypes
import re
from dataclasses import dataclass
from pathlib import Path

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import select

from app.core import indexer, turn_quality
from app.core.llm import ProviderInfo, run_agentic_chat
from app.core.mcp import begin_turn, mcp_manager
from app.core.prefs import load_config
from app.db import SessionLocal
from app.models import Conversation, Message, ProviderConfig

router = APIRouter(prefix="/api/chat", tags=["chat"])

log = logging.getLogger(__name__)

HISTORY_LIMIT = 40  # messages sent as context

# 主聊天路径唯一的**内建**系统规矩。
#
# 此前这条路径一条系统提示词都没有（`core/prompts.py` 里只有零柒/笔记/导师的人设），
# 于是「成篇的成品要进 vault」只写在 `save_artifact` 的**工具描述**里——而工具描述
# 对模型是建议，不是约束。实测（sensenova-6.8-flash-lite，自然说法
# 「帮我写一份本周周报，300 字左右。」）：规矩只在工具描述里时 **0/10** 会调它；
# 同一句话提到 system 层后 **6/10**。模型不是不会调工具（原始流里 finish_reason
# 就是 tool_calls，kb_search / vault_list_files 照调），它只是把「写份周报」当成
# 一次**回答**，而不是一次**落盘**——所以规矩得说在它决定怎么回答的那一层。
#
# 剩下那 4/10 由界面上的「存进产出」兜底（`routers/outputs.py`）。
# 登记在 `core/prompts.py::_SPECS`，别让这条规矩变成没人审得到的散句。
_OUTPUT_RULE = (
    "你是本地工作台的助手。写周报、调研、方案、复盘、交付稿这类**成篇的成品**时，"
    "不要把它写进回复里——调用 save_artifact 存进 vault 的产出区，正文放在 content "
    "参数里，回复只留一句「已存入产出」。用户不会明说「用工具存」，这一步要你自己判断。"
    "「已存入产出」这句话**只有在这一轮真的调用成功之后才成立**：没调用就一个字也别写，"
    "更不能一边说「已存入产出」一边把正文贴进回复——那样用户会以为东西在产出区，"
    "实际只躺在对话里。要改上一轮的成品，同样要重新调用一次。"
)


class ChatRequest(BaseModel):
    conversation_id: int
    content: str = ""
    # optional override; falls back to conversation.model_id
    model_id: str | None = None
    use_rag: bool = False
    top_k: int = 5
    regenerate: bool = False  # re-answer last user message, don't persist content
    agent_id: int | None = None  # agent preset to apply this turn
    compare_model: str | None = None  # second model for side-by-side comparison
    context_files: list[str] = []  # vault-relative .md paths to inject whole (# command)


@dataclass
class ResolvedModel:
    """model_id formatted as `provider_name/model`."""

    provider: ProviderConfig
    model: str


async def resolve_model(model_id: str) -> ResolvedModel:
    if "/" not in model_id:
        raise HTTPException(400, "model_id must be '<provider>/<model>'")
    pname, model = model_id.split("/", 1)
    async with SessionLocal() as db:
        provider = (
            await db.execute(select(ProviderConfig).where(ProviderConfig.name == pname))
        ).scalar_one_or_none()
    if not provider or not provider.enabled:
        raise HTTPException(400, f"provider '{pname}' not configured")
    return ResolvedModel(provider=provider, model=model)


def _sse(event: str, data: dict | str) -> str:
    payload = json.dumps(data, ensure_ascii=False) if not isinstance(data, str) else data
    return f"event: {event}\ndata: {payload}\n\n"


async def indexer_retrieve(query: str, top_k: int) -> list[dict]:
    """Run search in a thread (embedding/BM25 are CPU-bound)."""
    return await asyncio.to_thread(indexer.search_auto, query, top_k)


def _build_rag_context(sources: list[dict]) -> str:
    """Format retrieved chunks as a system prompt for grounded answering."""
    blocks = [
        f'[来源 {i} — {s["source"]}]\n{s["text"]}'
        for i, s in enumerate(sources, 1)
    ]
    return (
        "你是用户的个人 AI 工作台助手。以下是从用户知识库检索到的相关片段，"
        "请基于这些片段回答当前问题。回答时尽量引用片段内容，"
        "并在涉及某一片段时标注 [来源 N]。如果片段不足以回答，就如实说明。\n\n"
        + "\n\n".join(blocks)
    )


_CTX_FILE_CHAR_CAP = 12000  # per-file cap for whole-file injection (# command)

_LOCAL_IMG_RE = re.compile(r"!\[[^\]]*\]\((/api/images/[^)\s]+)\)")
from app.core.images import resolve_name  # noqa: E402


def _attach_local_images(llm_messages: list[dict]) -> list[str]:
    """Turn ![](/api/images/x.png) in the last user message into OpenAI-style
    image_url content blocks (in place). Returns the names actually attached."""
    for m in reversed(llm_messages):
        if m.get("role") != "user":
            continue
        if isinstance(m.get("content"), list):
            return []  # already multimodal
        content = m.get("content") or ""
        matches = list(_LOCAL_IMG_RE.finditer(content))
        if not matches:
            return []
        parts: list = []
        pos = 0
        attached: list[str] = []
        for match in matches:
            name = match.group(1)
            try:
                path = resolve_name(name.rsplit("/", 1)[-1])
            except ValueError:
                continue
            if not path.exists():
                continue
            mime = mimetypes.guess_type(path.name)[0] or "image/png"
            b64 = base64.b64encode(Path(path).read_bytes()).decode()
            parts.append({"type": "text", "text": content[pos:match.start()].strip()})
            parts.append({"type": "image_url", "image_url": {"url": f"data:{mime};base64,{b64}"}})
            pos = match.end()
            attached.append(name)
        if not attached:
            return []
        parts.append({"type": "text", "text": content[pos:].strip()})
        parts = [p for p in parts if p["type"] != "text" or p["text"]]
        m["content"] = parts
        return attached
    return []


def _load_context_files(paths: list[str]) -> list[tuple[str, str]]:
    """Read vault-relative .md files whole for the # command. Returns (rel, text)."""
    from app.config import VAULT_DIR

    root = VAULT_DIR.resolve()
    out: list[tuple[str, str]] = []
    seen: set[str] = set()
    for raw in paths:
        rel = (raw or "").strip().lstrip("/\\")
        if not rel or rel in seen:
            continue
        seen.add(rel)
        p = (root / rel).resolve()
        if not p.is_relative_to(root) or not p.is_file():
            continue
        try:
            text = p.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            continue
        if len(text) > _CTX_FILE_CHAR_CAP:
            text = text[:_CTX_FILE_CHAR_CAP] + "\n…（文件过长，已截断）"
        out.append((rel, text))
    return out


# 模型把整篇正文塞进工具参数时，回复正文那头可能只剩一个「无话可说」的占位串
# （实测见过字面量 `(empty)`）。它不是模型说的话，落进历史只是一条噪音，下一轮
# 还会被当成「它真这么说过」再喂回去。
#
# 只在**整条内容就是这一个占位串**时才丢弃——只要模型多说了半个字，一律原样保留。
# 这条是刻意收窄的：宁可漏掉一个没认出来的占位，也不能因为匹配太宽而吃掉一句真话。
_PLACEHOLDER_ONLY = {
    "empty", "(empty)", "[empty]", "（empty）",
    "no content", "(no content)", "(no reply)", "(nothing)",
    "blank", "(blank)", "(none)", "n/a",
    "空", "（空）", "(空)", "(无内容)", "（无内容）", "(无回复)",
}


def _without_placeholder(content: str) -> str:
    """整条内容只是一个空占位串时返回 ""，否则原样返回。"""
    text = (content or "").strip()
    if not text:
        return text
    return "" if text.lower() in _PLACEHOLDER_ONLY else text


# 模型有时会在回复里写「已存入产出」，但那一轮**根本没调 save_artifact**（实测 22 轮里
# 2 轮）。它不是被什么提示教的——量过：`_replay_message` 那条还原行一次都没出现在它
# 眼前。它是**在模仿自己上一轮的开场白**：上一轮开头就是「已存入产出：…」，于是下一轮
# 照着同一个句式说，却没做那件事。
#
# 这种话比「不存」更伤：用户以为东西已经在产出区，其实 vault 里还是上一轮的旧版本，
# 新写的这版只活在对话里。所以两件事一起做——把话说清楚（规矩里加一条），
# 以及**永远不要再让它静默**（这里记一条日志，界面那边给一条提示）。
_SAVE_CLAIM_MARKERS = (
    "已存入产出",
    "已存为",
    "已另存为",
)


def _save_claim_markers() -> tuple[str, ...]:
    """工具成功时回的是「已更新交付「X」→ 路径」，模型会照抄这个句式——
    所以「已更新{体裁}」也算声称。体裁标签从 `mcp._ARTIFACT_KINDS` 取，别抄第二份。"""
    from app.core import mcp

    return (
        *_SAVE_CLAIM_MARKERS,
        *(f"已更新{label}" for _, label in mcp._ARTIFACT_KINDS.values()),
    )


def claims_a_save_without_one(content: str, artifacts: list | None) -> bool:
    """这一轮的回复里声称存了产出，但实际一次都没落盘。

    只在**真的没有产出**时才成立：有回执就说明真存了，哪怕正文里那句话是模型多说的。
    这里刻意宁可少报也不误报——它只用来记日志和给提示，不拦内容、不改落库。
    """
    if artifacts:
        return False
    text = (content or "").strip()
    return any(marker in text for marker in _save_claim_markers())


def _artifact_titles(m: Message) -> list[str]:
    """一条落库消息里那几份产出的标题。老行是 NULL、坏 JSON 一律当没有。"""
    raw = getattr(m, "artifacts_json", None)
    if not raw:
        return []
    try:
        items = json.loads(raw)
    except (TypeError, ValueError):
        return []
    if not isinstance(items, list):
        return []
    return [str(a["title"]) for a in items if isinstance(a, dict) and a.get("title")]


def _replay_message(m: Message) -> dict:
    """把落库的一行还原成喂给模型的一轮。

    存产出的那一轮正文可以是空的——正文在 vault 文件里，不在对话里。空 content
    有些 provider 不收；而且模型不知道自己已经存过了，下一轮会把同一份再存一遍
    （P1 的重复写就是这么做出来的）。给它一行「本轮已存入产出：X」，既避开空串，
    也把「这件事已经做完了」讲清楚。
    """
    content = m.content
    if m.role == "assistant" and not (content or "").strip():
        titles = _artifact_titles(m)
        if titles:
            content = f"（本轮已存入产出：{'、'.join(titles)}）"
    return {"role": m.role, "content": content}


async def _generate(req: ChatRequest):
    async with SessionLocal() as db:
        conv = await db.get(Conversation, req.conversation_id)
        if not conv:
            yield _sse("error", {"message": "conversation not found"})
            return
        model_id = req.model_id or conv.model_id
        if not model_id:
            yield _sse("error", {"message": "no model selected"})
            return

        agent = None
        if req.agent_id is not None:
            from app.models import Agent

            agent = await db.get(Agent, req.agent_id)
            if not agent or not agent.enabled:
                yield _sse("error", {"message": "agent not found"})
                return
            if agent.model_id:  # agent preset may pin a model
                model_id = agent.model_id

        # 回合账本（W5）从**这里**开始计时 —— 不是从最后记录的那一刻。少了这一次
        # `begin`，`_record_turn` 只能自己造一份草稿，于是耗时永远是 0（第一次验收
        # 就是这么量出一个 0 秒的回合的）。它绝不能挡住聊天，所以整段 best-effort。
        try:
            from app.core import turn_trace

            draft = turn_trace.begin(conv.id, model_id)
        except Exception:  # noqa: BLE001 - 账本坏了照样聊
            log.warning("turn trace begin failed", exc_info=True)
            draft = None

        try:
            resolved = await resolve_model(model_id)
        except HTTPException as e:
            yield _sse("error", {"message": e.detail})
            return

        # persist user message (unless regenerating — then last user msg stays)
        if not req.regenerate:
            if not req.content.strip():
                yield _sse("error", {"message": "empty content"})
                return
            user_msg = Message(conversation_id=conv.id, role="user", content=req.content)
            db.add(user_msg)
            query_text = req.content
        else:
            last_user = (
                await db.execute(
                    select(Message)
                    .where(Message.conversation_id == conv.id, Message.role == "user")
                    .order_by(Message.id.desc())
                    .limit(1)
                )
            ).scalar_one_or_none()
            if not last_user:
                yield _sse("error", {"message": "nothing to regenerate"})
                return
            query_text = last_user.content

        # auto-title from first exchange
        is_first_exchange = conv.title == "New chat"
        if is_first_exchange and not req.regenerate:
            conv.title = req.content.strip().replace("\n", " ")[:50] or "New chat"

        history = (
            await db.execute(
                select(Message)
                .where(Message.conversation_id == conv.id)
                .order_by(Message.id.desc())
                .limit(HISTORY_LIMIT)
            )
        ).scalars().all()
        history = list(reversed(history))
        if req.regenerate:
            # drop trailing assistant messages so the model re-answers fresh
            while history and history[-1].role == "assistant":
                history.pop()
        await db.commit()

    llm_messages = [_replay_message(m) for m in history]

    # context compaction: if history is huge, summarize the oldest half
    summary_block: str | None = None
    from app.core import compaction

    if compaction.needs_compaction(llm_messages):
        p0 = resolved.provider
        try:
            summary_block, kept = await asyncio.wait_for(
                compaction.compact(
                    ProviderInfo(kind=p0.kind, base_url=p0.base_url, api_key=p0.api_key),
                    resolved.model,
                    conv.id,
                    llm_messages,
                ),
                timeout=30,
            )
            if kept is not None and len(kept) < len(llm_messages):
                yield _sse("compacted", {"kept": len(kept), "total": len(llm_messages)})
                llm_messages = kept
        except Exception:  # noqa: BLE001 - compaction must never break chat
            summary_block = None

    # user's global system prompt (settings page), if configured
    prefs = load_config()
    tools_on = agent.tools_enabled if agent is not None else True
    system_blocks: list[str] = []
    # 规矩排在一切之前：它是这一轮「怎么回答」的基准，不该被人设/记忆挤到后面去。
    # 工具关掉时不能说——那会指使模型去调一个它根本没有的工具。
    if tools_on:
        system_blocks.append(_OUTPUT_RULE)
    if summary_block:
        system_blocks.append(
            "以下是本次对话较早部分的摘要（原文已省略以节省上下文）：\n\n" + summary_block
        )
    if prefs.get("system_prompt", "").strip():
        system_blocks.append(prefs["system_prompt"].strip())

    # agent persona overrides/augments the global prompt
    if agent is not None and agent.system_prompt.strip():
        system_blocks.append(agent.system_prompt.strip())
        use_rag = agent.use_rag or req.use_rag
    else:
        use_rag = req.use_rag

    # persistent memory (opt-out via settings)
    memory_on = bool(prefs.get("memory_enabled", True))
    if memory_on:
        from app.core import memory

        mem_block = await memory.format_memories(query_text)
        if mem_block:
            system_blocks.append(mem_block)

    # agent skills: inject the compact index; the model loads full SKILL.md
    # via the skill_load tool when one is relevant
    from app.core import skills

    skills_block = skills.index_block()
    if skills_block:
        system_blocks.append(skills_block)

    for i, block in enumerate(system_blocks):
        llm_messages.insert(i, {"role": "system", "content": block})

    attached_images = _attach_local_images(llm_messages)
    if attached_images:
        yield _sse("images_attached", {"images": attached_images})

    # explicit # file attachments: inject whole file(s) as context (full-context mode)
    if req.context_files:
        attached = _load_context_files(req.context_files)
        if attached:
            block = "以下是用户用 # 显式指定要纳入上下文的文件全文：\n\n" + "\n\n".join(
                f"[文件 {rel}]\n{text}" for rel, text in attached
            )
            llm_messages = [{"role": "system", "content": block}] + llm_messages
            yield _sse("context_files", {"files": [rel for rel, _ in attached]})

    # RAG: retrieve from knowledge base and inject as a system message.
    sources: list[dict] = []
    if req.top_k != 5:
        top_k = req.top_k
    else:
        try:
            top_k = int(prefs.get("rag_top_k") or 5)
        except (TypeError, ValueError):
            top_k = 5
    if use_rag:
        try:
            sources = await indexer_retrieve(query_text, top_k)
        except Exception as e:  # noqa: BLE001 - RAG failure should not break chat
            yield _sse("rag_error", {"message": f"{type(e).__name__}: {e}"})
            sources = []
        if sources:
            # full-context mode: short source docs go in whole, not as fragments
            from app.core import fullctx

            if fullctx.enabled():
                try:
                    sources = await asyncio.to_thread(fullctx.expand, sources)
                except Exception:  # noqa: BLE001 - never break chat
                    pass
            context = _build_rag_context(sources)
            llm_messages = [{"role": "system", "content": context}] + llm_messages
            yield _sse("sources", {"sources": sources})

        # knowledge-graph channel (local Neo4j): entity/relation context on
        # top of chunk RAG — silent no-op when the feature is off or the
        # graph is unreachable
        from app.core import kg

        if kg.enabled():
            try:
                kg_block = await asyncio.to_thread(kg.context_for_query, query_text)
            except Exception:  # noqa: BLE001 - context_for_query already guards
                kg_block = ""
            if kg_block:
                llm_messages = [{"role": "system", "content": kg_block}] + llm_messages
                yield _sse("kg_used", {"ok": True})

    p = resolved.provider
    info = ProviderInfo(kind=p.kind, base_url=p.base_url, api_key=p.api_key)

    # ---- tool loop: runner task pushes events into a queue, we pump SSR ----
    q: asyncio.Queue = asyncio.Queue()
    tool_specs = mcp_manager.tool_specs(include_memory=memory_on) if tools_on else []

    compare_resolved: ResolvedModel | None = None
    if req.compare_model:
        try:
            if req.compare_model != model_id:
                compare_resolved = await resolve_model(req.compare_model)
        except HTTPException as e:
            yield _sse("error", {"message": f"对比模型无效: {e.detail}"})
            return

    partial_parts: list[str] = []  # 出错时保留已流出的文本，供错误分支落库
    # 这一轮落盘的产出，按 uid 分开装（对比模式两路各一份）。落库时必须把它写进
    # 消息里：正文那头可能是空的（正文在 vault 文件里），只落正文等于把这一轮唯一
    # 有信息量的东西丢掉，刷新后回执就没了。
    saved_by_uid: dict[str | None, list[dict]] = {}
    # 工具循环的账（W5）：两路各一份草稿，由 `run_agentic_chat` 填轮数与工具明细
    turn_traces: dict[str | None, dict] = {}
    # 两条底线校验的结论（W2a）：两路各一份，最后连同账本一起落库
    quality_by_uid: dict[str | None, dict] = {}

    # 这两条底线之外的第三件事（W4）：**用户这一句里有没有字数预算**。
    # 认出来就挂到这一轮上，`save_artifact` 落盘时报的是服务端数过的字数 ——
    # 「超没超」不再靠模型自我叙述。认不出就是 None（不猜）。
    from app.core import length_budget

    turn_budget = length_budget.parse_budget(req.content or query_text)

    async def run_one(r: ResolvedModel, uid: str | None):
        # 这一轮的同体裁落盘记录交给 mcp：同一个体裁第二次存 = 模型在改自己刚写的那份，
        # 覆盖同一个文件而不是新开一个（否则一版一个文件，产出清单和零柒成长值都按份数涨）。
        # 必须**按 uid 各开一份**：对比模式两路是并发的两个任务，共用一个 dict 会让
        # B 模型的产出盖掉 A 模型刚写的那个文件。并发在这行 set 的上下文是各自的任务，
        # 不会互相串。`budget` 一并挂上去（W4）。
        begin_turn(turn_budget)
        streamed_parts: list[str] = []
        final = ""
        # 工具循环的账（W5）：轮数、每个工具的耗时与大小。对比模式两路各一份。
        turn_traces[uid] = {}
        quality: dict = {}
        quality_by_uid[uid] = quality

        def on_delta(t: str) -> None:
            q.put_nowait(("delta", t, uid))
            streamed_parts.append(t)
            partial_parts.append(t)

        def on_tool(name: str, arguments: dict) -> None:
            q.put_nowait(("tool", name, arguments))

        def on_tool_result(name: str, arguments: dict, meta: dict) -> None:
            # 工具的副产物（产出落盘路径…）→ 界面。正文不在这条路上：模型仍会把
            # 「已存为…」那句话写在回复里，这里给的是能点开的**链接**。
            art = (meta or {}).get("artifact")
            if isinstance(art, dict):
                # W2a 的白名单闸门：回执路径必须在 vault 里、而且盘上真有这个文件。
                # 过不去就不进这一轮的产出、也不给界面链接 —— 一个看起来可信、点开即
                # 404 的链接比没有链接更伤（用户会以为东西存好了）。
                # **不是静默丢掉**：原因写进这一轮的 quality，账本和界面都看得见。
                why = turn_quality.receipt_problem(art)
                if why:
                    log.warning("产出回执不给出去（%s）：%s", why, art.get("path"))
                    quality.setdefault("dropped_receipts", []).append(
                        {"path": str(art.get("path") or ""), "why": why}
                    )
                    meta = {k: v for k, v in (meta or {}).items() if k != "artifact"}
                else:
                    bucket = saved_by_uid.setdefault(uid, [])
                    # 按 path 去重、留最后一条。同一个文件被存了两版时，界面上不能出现
                    # 两条指向同一处的回执——用户点开都是一样的内容，多出来的那条是谎话。
                    path = art.get("path")
                    bucket[:] = [a for a in bucket if a.get("path") != path]
                    bucket.append(art)
            q.put_nowait(("tool_result", {"name": name, "meta": meta}, uid))

        usage: dict = {}

        async def one_pass(extra: str) -> str:
            """跑一遍工具循环。`extra` 非空 = 这是修复那一轮，多带一句指名道姓的话。"""
            msgs = llm_messages
            if extra:
                msgs = [*llm_messages, {"role": "system", "content": extra}]
            return await run_agentic_chat(
                ProviderInfo(kind=r.provider.kind, base_url=r.provider.base_url, api_key=r.provider.api_key),
                r.model,
                msgs,
                tool_specs,
                mcp_manager.call_tool,
                on_delta,
                on_tool,
                usage=usage,
                emit_tool_result=on_tool_result,
                trace=turn_traces[uid],
            )

        final = await one_pass("")
        # 正文那头怎么定：
        # - 模型最后说了话（`final` 非空）→ 用它。
        # - 一个字没说，但**这一轮落了产出** → 就用空的。正文在 vault 文件里，
        #   回执那行才是这一轮的正身（`_replay_message` 会把它还原成一句话）。
        #   绝不能用 `streamed_parts` 回填：那是工具轮之前的 pre-text，`llm.py` 已经
        #   明确把它丢掉了，这里再捞回来等于把整篇长文又塞进对话——P1 要消的就是它，
        #   而且它是**同一篇正文的第二份拷贝**（文件里一份、历史里一份）。
        # - 一个字没说、也没落产出 → 保留流出的文本，否则报错前吐的那半句会丢。
        text = (final or "").strip()
        if not text and not saved_by_uid.get(uid):
            text = "".join(streamed_parts).strip()

        # ---- W2a：事后校验 → 有界修复（**只重试一次**）----
        # 判据在 `core/turn_quality.py` 一处（与 W1 评测同一份），这里只执行它给的动作。
        # 「该不该补跑」还要看**用户有没有明说要落盘**：判断「这算不算一份成品」是 W3 的活，
        # 在这里猜错的代价是把闲聊变成产出（见 turn_quality.should_retry）。
        quality["asked_to_save"] = turn_quality.asked_to_save(req.content or query_text)
        bad = turn_quality.findings(text, saved_by_uid.get(uid))
        # W4：字数那一栏**记服务端数过的数**。没认预算就如实写 None（不编一个「不限」出来）。
        quality["length"] = _length_note(turn_budget, turn_traces[uid], saved_by_uid.get(uid))
        if turn_quality.should_retry(bad, req.content or query_text):
            quality["findings_before"] = bad
            turn_traces[uid]["retried"] = 1
            # 先告诉界面「这一轮没落盘、要补一次」：上一轮那篇长文已经流出去了，
            # 界面收到这帧就把它丢掉，换成下面这轮的短回执（**长文不进对话**是这一整
            # 件事的目的，光在库里不存、屏幕上还留着，等于没做）。
            q.put_nowait(
                (
                    "quality",
                    {
                        "codes": [b["code"] for b in bad],
                        "retried": True,
                        "asked_to_save": quality["asked_to_save"],
                    },
                    uid,
                )
            )
            log.info("uid=%s 上一轮没落盘（%s），补跑一次", uid, [b["code"] for b in bad])
            before = len(saved_by_uid.get(uid) or [])
            kept_text = text
            mark = len(partial_parts)
            streamed_parts.clear()
            del partial_parts[mark:]
            try:
                final2 = await one_pass(turn_quality.retry_instruction(bad, req.content or query_text))
            except BaseException:
                # 补跑炸了：把上一轮那篇正文还给错误分支（那是用户唯一的一份东西）
                partial_parts.append(kept_text)
                raise
            after = saved_by_uid.get(uid) or []
            if len(after) > before:
                # 补上了：正文就用这一轮的（一句话回执），上一轮那篇长文不进历史。
                # 它可能一个字都没说（正文进了 vault），那正文就该是空的 —— 回执行是
                # 这一轮的正身（`_replay_message` 会把它还原成一句话）。
                text = (final2 or "").strip()
                quality["repaired"] = True
                log.info("uid=%s 补跑成功：产出落盘了", uid)
            else:
                # 还是没存。**不能把上一轮那篇正文丢掉**——它是用户唯一的一份成品，
                # 而这一轮的失败已经由界面上的「存进产出」兜底（一键补）。
                text = kept_text
                quality["repaired"] = False
                log.warning("uid=%s 补跑之后仍然没有落盘", uid)
            bad = turn_quality.findings(text, after)
        quality["findings"] = bad
        # 落库前再过一遍白名单：从「工具说存好了」到「把回执交给界面」中间隔了这一整轮，
        # 文件可能在半路被删/被移走（用户手动整理了 vault）。这一遍是**同一条判据的第二次
        # 调用**，不是第二份实现；挑掉的那些连原因一起记进 quality。
        good_receipts, broken = turn_quality.drop_broken_receipts(saved_by_uid.get(uid))
        if broken:
            seen = {d.get("path") for d in quality.get("dropped_receipts") or []}
            quality.setdefault("dropped_receipts", []).extend(d for d in broken if d.get("path") not in seen)
            saved_by_uid[uid] = good_receipts
            for d in broken:
                log.warning("落库前发现回执给不出去（%s）：%s", d["why"], d["path"])
        # 收尾那一帧：界面拿它决定还显不显示「该存没存」那条提示（成功修复后就不显示了），
        # 以及要不要把「📄 存进产出」提到最显眼处（**只有用户真说过要落盘时**才提；
        # 对一次「我不想凭空编」的拒绝，提那个按钮是在误导人）。
        q.put_nowait(
            (
                "quality",
                {
                    "codes": [b["code"] for b in bad],
                    "retried": bool(turn_traces[uid].get("retried")),
                    "asked_to_save": quality["asked_to_save"],
                    "dropped_receipts": quality.get("dropped_receipts") or [],
                },
                uid,
            )
        )
        return (text, usage)

    async def runner():
        try:
            if compare_resolved is not None:
                results = await asyncio.gather(
                    run_one(resolved, "a"),
                    run_one(compare_resolved, "b"),
                    return_exceptions=True,
                )
                for uid, res in zip(("a", "b"), results):
                    q.put_nowait(("done_one", uid, res))
                q.put_nowait(("stop", None, None))
            else:
                text, usage = await run_one(resolved, None)
                q.put_nowait(("result", text, usage))
                q.put_nowait(("stop", None, None))
        except Exception as e:  # noqa: BLE001
            q.put_nowait(("error", f"{type(e).__name__}: {e}", None))

    task = asyncio.create_task(runner())
    status = "ok"
    final_text = ""
    final_usage: dict = {}
    answers: dict[str, str] = {}
    usages: dict[str, dict] = {}
    errors: dict[str, str] = {}
    try:
        while True:
            kind, a, b = await q.get()
            if kind == "delta":
                yield _sse("delta", {"text": a} if b is None else {"text": a, "uid": b})
            elif kind == "tool":
                yield _sse("tool_call", {"name": a, "arguments": b})
            elif kind == "tool_result":
                payload = dict(a)
                if b is not None:
                    payload["uid"] = b
                yield _sse("tool_result", payload)
            elif kind == "quality":
                # W2a 的两条底线校验结论。**判定在服务端一处**（`core/turn_quality.py`），
                # 界面只负责显示 —— 让界面自己再算一遍「算不算该存没存」就是第二份实现，
                # 两份分叉的那天这个数就没人敢信了。
                payload = dict(a)
                if b is not None:
                    payload["uid"] = b
                yield _sse("quality", payload)
            elif kind == "done_one":
                uid, res = a, b
                if isinstance(res, BaseException):
                    errors[uid] = f"{type(res).__name__}: {res}"
                    yield _sse("model_error", {"uid": uid, "message": str(res)})
                else:
                    text, usage = res
                    answers[uid] = text
                    usages[uid] = usage
                    yield _sse("answer_done", {"uid": uid})
            elif kind == "result":
                final_text = a
                final_usage = b or {}
            elif kind == "error":
                status = "error"
                yield _sse("error", {"message": a})
                break
            else:  # stop
                break
    finally:
        if not task.done():
            task.cancel()
        try:
            await task
        except (asyncio.CancelledError, Exception):
            pass

    if status == "ok":
        if compare_resolved is not None:
            # comparison mode: persist each answer tagged with its model
            for uid, res in answers.items():
                mid = model_id if uid == "a" else req.compare_model
                u = usages.get(uid) or {}
                content = _without_placeholder(res.strip())
                artifacts = saved_by_uid.get(uid) or []
                truthful = not claims_a_save_without_one(content, artifacts)
                if not truthful:
                    log.warning(
                        "uid=%s 声称已存入产出，但这一轮没有落盘（conv=%s）", uid, conv.id
                    )
                # 判据是「有没有东西可说」而不是「正文非空」：只调工具、正文空着的
                # 那一轮也有产出要记，否则刷新后这一轮整个消失。
                msg_id = None
                if content or artifacts:
                    msg_id = await _save_assistant_message(
                        conv.id, content, mid, sources,
                        tokens_in=u.get("input"), tokens_out=u.get("output"),
                        artifacts=artifacts,
                    )
                await _record_turn(
                    conv.id, msg_id, mid, turn_traces.get(uid) or {},
                    content=content, artifacts=artifacts, usage=u, truthful=truthful,
                    draft=draft, quality=quality_by_uid.get(uid) or {},
                )
                yield _sse("saved", {"uid": uid, "message_id": msg_id})
        else:
            content = _without_placeholder(final_text or "")
            artifacts = saved_by_uid.get(None) or []
            truthful = not claims_a_save_without_one(content, artifacts)
            if not truthful:
                log.warning("声称已存入产出，但这一轮没有落盘（conv=%s）", conv.id)
            msg_id = None
            if content or artifacts:
                msg_id = await _save_assistant_message(
                    conv.id, content, model_id, sources,
                    tokens_in=final_usage.get("input"), tokens_out=final_usage.get("output"),
                    artifacts=artifacts,
                )
            await _record_turn(
                conv.id, msg_id, model_id, turn_traces.get(None) or {},
                content=content, artifacts=artifacts, usage=final_usage, truthful=truthful,
                draft=draft, quality=quality_by_uid.get(None) or {},
            )
            # 把这一轮的 message id 交给界面：它手里的气泡还没有后端 id，而「📄 存进
            # 产出」那条人工出口是按 id 存的。不交出去，用户得先刷新才能点那一下。
            yield _sse("saved", {"message_id": msg_id})
        yield _sse("done", {})
        # automemory: let the model decide whether this exchange was worth
        # remembering (Khoj automemory style). Best-effort, after done so the
        # UI already shows the answer; result surfaces via SSE to a toast.
        base_answer = (
            answers.get("a") or answers.get("b") or (final_text or "")
        ).strip()
        user_text = (req.content or "").strip() or query_text
        if (
            memory_on
            and prefs.get("automemory_enabled")
            and not req.regenerate
            and compare_resolved is None
            and base_answer
        ):
            try:
                from app.core import memory

                yield _sse("memorizing", {})
                facts = await asyncio.wait_for(
                    memory.auto_extract(
                        info,
                        resolved.model,
                        user_text,
                        base_answer,
                    ),
                    timeout=40,
                )
                if facts:
                    yield _sse("memorized", {"facts": facts})
            except Exception:  # noqa: BLE001 - automemory must never break chat
                pass
        # follow-up suggestions: best-effort, after done so UI renders answer first
        if base_answer and not req.regenerate:
            try:
                fups = await _generate_followups(resolved, llm_messages, base_answer)
                if fups:
                    yield _sse("followups", {"questions": fups})
            except Exception:  # noqa: BLE001 - suggestions must never break chat
                pass
    else:
        # provider/tool error — keep whatever text streamed before it failed.
        # 已经落盘的产出也算数：文件真在 vault 里，界面得能指回去。
        partial = _without_placeholder(answers.get("a") or "".join(partial_parts) or "")
        artifacts = saved_by_uid.get(None) or saved_by_uid.get("a") or []
        if partial or artifacts:
            await _save_assistant_message(conv.id, partial, model_id, sources, artifacts=artifacts)


class Followups(BaseModel):
    """后续追问问题。模型直接给字符串数组；items 包装以兼容 anthropic tool。"""

    items: list[str] = Field(default_factory=list)

    @field_validator("items", mode="before")
    @classmethod
    def _strs(cls, v):
        if not isinstance(v, list):
            return []
        return [str(x).strip()[:40] for x in v if str(x).strip()]


async def _generate_followups(
    resolved: ResolvedModel, llm_messages: list[dict], answer: str
) -> list[str]:
    """Ask the same model for 3 short follow-up questions (Open WebUI-style)."""
    from app.core.structured import extract_json

    prompt = (
        "基于以上对话，生成 3 个用户可能想继续追问的问题。"
        "只输出 JSON 数组，格式 [\"问题1\",\"问题2\",\"问题3\"]，每个不超过 20 字，不要其他内容。"
    )
    msgs = llm_messages[-6:] + [
        {"role": "assistant", "content": answer[:2000]},
        {"role": "user", "content": prompt},
    ]
    p = resolved.provider
    info = ProviderInfo(kind=p.kind, base_url=p.base_url, api_key=p.api_key)
    obj, meta = await extract_json(info, resolved.model, msgs, Followups)
    if obj is None:
        return []
    return obj.items[:3]


def _length_note(budget, trace: dict, artifacts: list | None) -> dict:
    """这一轮的字数事实（W4）：预算、服务端数过的字数、超没超、落盘几次。**不评分。**

    `saves` 从工具账里数（`trace["tool_calls"]`）而不是从回执里数：回执按 path 去重，
    同一体裁改两版只会剩一条 —— 而 W4 要看的恰恰是**它写了几版**（每版都要用户付钱）。
    """
    saves = sum(1 for c in (trace.get("tool_calls") or []) if c.get("name") == "save_artifact")
    chars = max((int(a.get("chars") or 0) for a in (artifacts or []) if isinstance(a, dict)), default=0)
    if budget is None:
        return {"budget": None, "hard": None, "chars": chars, "over": False, "saves": saves}
    return {
        "budget": budget.chars,
        "hard": budget.hard,
        "chars": chars,
        "over": any(bool(a.get("over")) for a in (artifacts or []) if isinstance(a, dict)),
        "saves": saves,
    }


async def _save_assistant_message(
    conversation_id: int,
    content: str,
    model_id: str,
    sources: list[dict] | None = None,
    tokens_in: int | None = None,
    tokens_out: int | None = None,
    artifacts: list[dict] | None = None,
):
    """落一条助手消息，**返回新行的 id**。

    返回值是给界面用的：这一轮跑完时它手里那条气泡还没有后端 id，而「📄 存进产出」
    那条人工出口是按 id 存的（W2a 的兜底动作）。不把 id 给它，用户就得先刷新才能点。
    """
    async with SessionLocal() as db:
        msg = Message(
            conversation_id=conversation_id,
            role="assistant",
            content=content,
            sources_json=json.dumps(sources, ensure_ascii=False) if sources else None,
            artifacts_json=json.dumps(artifacts, ensure_ascii=False) if artifacts else None,
            model_id=model_id,
            tokens_in=tokens_in,
            tokens_out=tokens_out,
        )
        db.add(msg)
        from datetime import datetime, timezone
        from sqlalchemy import update

        await db.execute(
            update(Conversation)
            .where(Conversation.id == conversation_id)
            .values(updated_at=datetime.now(timezone.utc))
        )
        await db.commit()
        await db.refresh(msg)
        return msg.id


async def _record_turn(
    conversation_id: int,
    message_id: int | None,
    model_id: str,
    trace: dict,
    *,
    content: str,
    artifacts: list[dict],
    usage: dict,
    truthful: bool,
    draft: dict | None,
    quality: dict | None = None,
) -> None:
    """落一行回合账（W5）。**best-effort**：记账失败不该影响已经答完的那一轮。

    `truthful` 由调用方算好传进来 —— 校验只有 `claims_a_save_without_one` 那一处，
    这里是记录，不是第二个判断。`draft` 是本回合开头的草稿（带着开始时刻）；
    对比模式两路共用它，所以每次落库都传**副本**（`finish` 会把 contextvar 清掉）。
    `quality` 是 W2a 那两条底线校验的结论（findings / 有没有修复 / 哪条回执没给出去）
    —— 一并落库，界面和评测读的是同一份。
    """
    try:
        from app.core import turn_trace

        base = dict(draft) if draft else {
            "conversation_id": conversation_id,
            "model_id": model_id,
            "prompt_sha": turn_trace.prompt_sha(),
        }
        base.update(
            {
                "conversation_id": conversation_id,
                "model_id": model_id,
                "rounds": int(trace.get("rounds") or 0),
                "tool_calls": trace.get("tool_calls") or [],
                "artifacts": artifacts or [],
                "answer_chars": len(content or ""),
                "claim_checked": True,
                "claim_truthful": bool(truthful),
                # 重试次数从工具循环的账里来（W2a 的补跑记在这里），quality 是那两条
                # 底线的结论。两者都是**事实**，不是评分。
                "retried": int(trace.get("retried") or 0),
                "quality": quality or {},
            }
        )
        row = await turn_trace.finish(base, usage=usage)
        if row is None or not message_id:
            return
        # 把这一行和落库的那条 message 对上（点开某一轮时要用）。按 id 定位刚写的那一行，
        # 不用 created_at 之类的软条件 —— 那会在并发下改错行。
        from sqlalchemy import update as _update

        from app.models import TurnTrace

        async with SessionLocal() as db:
            await db.execute(
                _update(TurnTrace).where(TurnTrace.id == row["id"]).values(message_id=message_id)
            )
            await db.commit()
    except Exception:  # noqa: BLE001 - 账本坏了不能连累这一轮
        log.warning("turn trace record failed", exc_info=True)


@router.post("")
async def chat(req: ChatRequest):
    return StreamingResponse(
        _generate(req),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )