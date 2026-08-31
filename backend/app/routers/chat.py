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
import mimetypes
import re
from dataclasses import dataclass
from pathlib import Path

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy import select

from app.core import indexer
from app.core.llm import ProviderInfo, run_agentic_chat
from app.core.mcp import mcp_manager
from app.core.prefs import load_config
from app.db import SessionLocal
from app.models import Conversation, Message, ProviderConfig

router = APIRouter(prefix="/api/chat", tags=["chat"])

HISTORY_LIMIT = 40  # messages sent as context


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
from app.core.images import IMAGE_DIR, resolve_name  # noqa: E402


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

    llm_messages = [
        {"role": m.role, "content": m.content} for m in history
    ]

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
    system_blocks: list[str] = []
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
    top_k = req.top_k if req.top_k != 5 else int(prefs.get("rag_top_k", 5))
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
    tools_on = agent.tools_enabled if agent is not None else True
    tool_specs = mcp_manager.tool_specs(include_memory=memory_on) if tools_on else []

    compare_resolved: ResolvedModel | None = None
    if req.compare_model:
        try:
            if req.compare_model != model_id:
                compare_resolved = await resolve_model(req.compare_model)
        except HTTPException as e:
            yield _sse("error", {"message": f"对比模型无效: {e.detail}"})
            return

    async def run_one(r: ResolvedModel, uid: str | None):
        streamed_parts: list[str] = []
        final = ""

        def on_delta(t: str) -> None:
            q.put_nowait(("delta", t, uid))
            streamed_parts.append(t)

        def on_tool(name: str, arguments: dict) -> None:
            q.put_nowait(("tool", name, arguments))

        usage: dict = {}
        final = await run_agentic_chat(
            ProviderInfo(kind=r.provider.kind, base_url=r.provider.base_url, api_key=r.provider.api_key),
            r.model,
            llm_messages,
            tool_specs,
            mcp_manager.call_tool,
            on_delta,
            on_tool,
            usage=usage,
        )
        return ((final or "").strip() or "".join(streamed_parts).strip(), usage)

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
                if res.strip():
                    await _save_assistant_message(
                        conv.id, res.strip(), mid, sources,
                        tokens_in=u.get("input"), tokens_out=u.get("output"),
                    )
        else:
            content = (final_text or "").strip()
            if content:
                await _save_assistant_message(
                    conv.id, content, model_id, sources,
                    tokens_in=final_usage.get("input"), tokens_out=final_usage.get("output"),
                )
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
        # provider/tool error — keep whatever text streamed before it failed
        partial = (answers.get("a") or "").strip()
        if partial:
            await _save_assistant_message(conv.id, partial, model_id, sources)


async def _generate_followups(
    resolved: ResolvedModel, llm_messages: list[dict], answer: str
) -> list[str]:
    """Ask the same model for 3 short follow-up questions (Open WebUI-style)."""
    from app.core.llm import stream_chat

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
    text = ""
    async for delta in stream_chat(info, resolved.model, msgs):
        text += delta
    import re as _re

    m = _re.search(r"\[.*\]", text, _re.S)
    if not m:
        return []
    arr = json.loads(m.group(0))
    return [str(q).strip()[:40] for q in arr if str(q).strip()][:3]


async def _save_assistant_message(
    conversation_id: int,
    content: str,
    model_id: str,
    sources: list[dict] | None = None,
    tokens_in: int | None = None,
    tokens_out: int | None = None,
):
    async with SessionLocal() as db:
        db.add(
            Message(
                conversation_id=conversation_id,
                role="assistant",
                content=content,
                sources_json=json.dumps(sources, ensure_ascii=False) if sources else None,
                model_id=model_id,
                tokens_in=tokens_in,
                tokens_out=tokens_out,
            )
        )
        from datetime import datetime, timezone
        from sqlalchemy import update

        await db.execute(
            update(Conversation)
            .where(Conversation.id == conversation_id)
            .values(updated_at=datetime.now(timezone.utc))
        )
        await db.commit()


@router.post("")
async def chat(req: ChatRequest):
    return StreamingResponse(
        _generate(req),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )