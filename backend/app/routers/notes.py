"""Notes workspace: CRUD markdown files in vault/notes/ + AI writing actions.

Notes are plain .md files under the vault, so anything saved here is
automatically indexed for RAG by the watcher/indexer.
"""
import asyncio
import json
from datetime import datetime, timedelta
from pathlib import Path

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy import select

from app.config import VAULT_DIR
from app.core import indexer
from app.db import SessionLocal
from app.models import ProviderConfig

router = APIRouter(prefix="/api/notes", tags=["notes"])

_NOTES_ROOT = VAULT_DIR.resolve()
_NOTES_ROOT.mkdir(parents=True, exist_ok=True)
# generated artifacts — visible for RAG but not editable as "notes"
_HIDDEN_PREFIXES = ("clippings/", "digests/")


def _safe_path(rel: str) -> Path:
    rel = (rel or "").strip().lstrip("/\\")
    # accept both "note.md" and "notes/note.md" (RAG citations use vault-relative)
    if not rel:
        raise HTTPException(400, "path is required")
    p = (_NOTES_ROOT / rel).resolve()
    if not p.is_relative_to(_NOTES_ROOT):
        raise HTTPException(400, "path escapes notes directory")
    return p


@router.get("")
async def list_notes():
    """All vault notes newest-first, with mtime for client-side grouping."""
    files = sorted(
        (
            {
                "path": p.relative_to(_NOTES_ROOT).as_posix(),
                "mtime": int(p.stat().st_mtime),
            }
            for p in _NOTES_ROOT.rglob("*.md")
            if p.is_file()
            and not p.relative_to(_NOTES_ROOT).as_posix().startswith(_HIDDEN_PREFIXES)
        ),
        key=lambda f: f["mtime"],
        reverse=True,
    )
    return {"dir": _NOTES_ROOT.name, "files": files}


@router.get("/content")
async def read_note(path: str):
    p = _safe_path(path)
    if not p.exists():
        return {"path": path, "content": ""}
    return {"path": path, "content": p.read_text(encoding="utf-8", errors="ignore")}


@router.get("/search")
async def search_notes(q: str, limit: int = 50):
    """Full-text keyword search across vault *.md (case-insensitive substring)."""
    needle = (q or "").strip().lower()
    if not needle:
        return {"query": q, "hits": []}

    def _scan() -> list[dict]:
        hits: list[dict] = []
        for p in sorted(_NOTES_ROOT.rglob("*.md")):
            if not p.is_file():
                continue
            rel = p.relative_to(_NOTES_ROOT).as_posix()
            try:
                text = p.read_text(encoding="utf-8", errors="ignore")
            except OSError:
                continue
            low = text.lower()
            pos = low.find(needle)
            in_name = needle in rel.lower()
            if pos < 0 and not in_name:
                continue
            if pos < 0:  # matched filename only — excerpt from the top
                pos = 0
            start = max(0, pos - 40)
            excerpt = text[start : pos + len(needle) + 80].replace("\n", " ").strip()
            hits.append(
                {
                    "path": rel,
                    "count": low.count(needle),
                    "excerpt": ("…" if start > 0 else "") + excerpt,
                }
            )
            if len(hits) >= limit:
                break
        hits.sort(key=lambda h: h["count"], reverse=True)
        return hits

    return {"query": q, "hits": await asyncio.to_thread(_scan)}



class NoteSave(BaseModel):
    path: str
    content: str


@router.put("/content")
async def write_note(body: NoteSave):
    p = _safe_path(body.path)
    if p.suffix != ".md":
        raise HTTPException(400, "only .md files are supported")
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(body.content, encoding="utf-8")
    chunks = await asyncio.to_thread(indexer.index_file, p)
    return {"ok": True, "chunks": chunks}


@router.delete("/content")
async def delete_note(path: str):
    p = _safe_path(path)
    if not p.exists():
        raise HTTPException(404, "note not found")
    p.unlink()
    indexer.delete_file(p)
    return {"ok": True}


# ---------- AI writing actions ----------

_ACTIONS = {
    "continue": (
        "你正在帮用户续写笔记。只输出接续的正文内容，不要重复已有内容，"
        "不要解释，不要加标题前缀。保持与笔记一致的语气和 Markdown 风格。"
    ),
    "polish": (
        "润色下面的笔记：修正错别字和语病、让表达更流畅清晰，"
        "保留原有结构和 Markdown 格式，不要增删大段内容。只输出润色后的全文。"
    ),
    "summarize": (
        "为下面的笔记生成一段简明摘要（3-5 句），放在一个「## 摘要」标题下。"
        "只输出摘要部分。"
    ),
    "rewrite": (
        "你正在帮用户改写笔记中选中的一段文字。只输出改写后的这段文字本身"
        "（保持 Markdown 格式），不要解释、不要加引号或任何前后缀。"
    ),
    "chat": (
        "你在用户的笔记编辑器旁回答关于这篇笔记的问题。基于笔记内容回答，"
        "回答保持简洁、可用 Markdown；笔记内容不足以回答时如实说明，不要编造。"
    ),
}

_SELECTION_CONTEXT_CAP = 8000  # note context given alongside a rewrite
_CHAT_NOTE_CAP = 12000  # whole-note cap for chat
_CHAT_HISTORY_TURNS = 6
_CHAT_TURN_CAP = 600

_WRITER_PERSONA = "你是用户的 AI 写作助手，工作在本地个人工作台内。"

_DEFAULT_REWRITE_INSTRUCTION = (
    "润色这一段：修正错别字和语病，表达更流畅清晰，保持原意与篇幅。"
)


class ChatTurn(BaseModel):
    role: str  # user | assistant
    content: str


class AiAction(BaseModel):
    action: str  # continue | polish | summarize | rewrite | chat
    content: str
    model_id: str | None = None
    selection: str = ""  # rewrite: the selected text
    instruction: str = ""  # rewrite: custom instruction ("" = default polish)
    question: str = ""  # chat: what to ask about the note
    history: list[ChatTurn] = []  # chat: prior turns of this note-side chat


def _compose_prompt(body: AiAction) -> tuple[str, str]:
    """Build (system_instruction, user_content). Raises ValueError on bad input.

    Pure function so the prompt shapes stay unit-testable without an LLM.
    Whole-note actions keep the writer persona in system + directive in user;
    rewrite/chat carry their directive in system because the user content is
    dynamic.
    """
    if body.action == "continue":
        return (
            _WRITER_PERSONA,
            f"{_ACTIONS['continue']}\n\n---\n\n这是笔记的当前内容，请直接接着往下写：\n\n{body.content}",
        )

    if body.action == "rewrite":
        if not body.selection.strip():
            raise ValueError("rewrite 需要 selection（选中的文字）")
        instruction = body.instruction.strip() or _DEFAULT_REWRITE_INSTRUCTION
        ctx = body.content[:_SELECTION_CONTEXT_CAP]
        return _ACTIONS["rewrite"], (
            f"{instruction}\n\n---\n【笔记上下文（节选）】\n{ctx}\n---\n"
            f"【选中的段落——只改写这一段】\n{body.selection}"
        )

    if body.action == "chat":
        if not body.question.strip():
            raise ValueError("chat 需要 question（当前问题）")
        turns = "\n".join(
            f"{'用户' if t.role == 'user' else '助手'}：{t.content[:_CHAT_TURN_CAP]}"
            for t in body.history[-_CHAT_HISTORY_TURNS:]
        )
        hist = f"【此前对话】\n{turns}\n\n" if turns else ""
        note = body.content[:_CHAT_NOTE_CAP] or "（空笔记）"
        return _ACTIONS["chat"], (
            f"{hist}【当前问题】\n{body.question.strip()}\n\n【当前笔记全文】\n---\n{note}"
        )

    instruction = _ACTIONS.get(body.action)
    if not instruction:
        raise ValueError(f"unknown action '{body.action}'")
    return _WRITER_PERSONA, f"{instruction}\n\n---\n\n{body.content}"


async def _default_model() -> tuple[ProviderConfig, str]:
    async with SessionLocal() as db:
        providers = (
            await db.execute(
                select(ProviderConfig).where(ProviderConfig.enabled.is_(True))
            )
        ).scalars().all()
    for p in providers:
        if p.models:
            return p, p.models[0]
    raise HTTPException(400, "no enabled provider with models configured")


@router.post("/ai")
async def ai_write(body: AiAction):
    try:
        system_instruction, user_content = _compose_prompt(body)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e

    from app.core.llm import ProviderInfo, stream_chat

    if body.model_id and "/" in body.model_id:
        pname, model = body.model_id.split("/", 1)
        async with SessionLocal() as db:
            provider = (
                await db.execute(
                    select(ProviderConfig).where(ProviderConfig.name == pname)
                )
            ).scalar_one_or_none()
        if not provider or not provider.enabled:
            raise HTTPException(400, f"provider '{pname}' not configured")
    else:
        provider, model = await _default_model()

    async def gen():
        msgs = [
            {"role": "system", "content": system_instruction},
            {"role": "user", "content": user_content},
        ]
        info = ProviderInfo(kind=provider.kind, base_url=provider.base_url, api_key=provider.api_key)

        def sse(event: str, data: dict) -> str:
            return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"

        try:
            async for delta in stream_chat(info, model, msgs):
                yield sse("delta", {"text": delta})
            yield sse("done", {})
        except Exception as e:  # noqa: BLE001
            yield sse("error", {"message": f"{type(e).__name__}: {e}"})

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# --- 零柒笔记简报（V14 仪表盘同款思路：LLM 一句话 + 缓存 + 模板兜底）-----------

_briefing_cache: dict = {"text": "", "facts_hash": None, "ts": None, "ttl": 300}
_BRIEFING_SYSTEM = (
    "你是「零柒」，本地工作台的常驻小助手。极简、克制、偶尔一句冷幽默。"
    "根据用户给的「笔记库事实」，写一句 30 字以内的写作视角要点："
    "挑最值得说的一两篇（今天新写的、最近改的、或数量里程碑），"
    "像随口提醒一句，不要堆数字、不要列清单。"
    "直接输出那句话本身，不要前缀、引号或解释。"
)


@router.get("/briefing")
async def notes_briefing():
    """零柒口吻的笔记概览一句话（5 分钟缓存，模板兜底）。"""
    files = [
        p
        for p in _NOTES_ROOT.rglob("*.md")
        if p.is_file() and not p.relative_to(_NOTES_ROOT).as_posix().startswith(_HIDDEN_PREFIXES)
    ]
    files.sort(key=lambda p: p.stat().st_mtime, reverse=True)
    now = datetime.now()
    today_start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    week_start = today_start - timedelta(days=7)
    today_notes = [p for p in files if p.stat().st_mtime >= today_start.timestamp()]
    week_notes = [p for p in files if p.stat().st_mtime >= week_start.timestamp()]
    facts = {
        "total": len(files),
        "today_new": len(today_notes),
        "this_week_touched": len(week_notes),
        "latest_titles": [p.stem for p in files[:3]],
        "latest_today": [p.stem for p in today_notes[:3]],
    }
    facts_hash = hash(json.dumps(facts, sort_keys=True))
    if (
        _briefing_cache["text"]
        and _briefing_cache["facts_hash"] == facts_hash
        and _briefing_cache["ts"]
        and (now - _briefing_cache["ts"]).total_seconds() < _briefing_cache["ttl"]
    ):
        return {"text": _briefing_cache["text"], "facts": facts, "cached": True}

    text = await _generate_note_briefing(facts)
    _briefing_cache.update({"text": text, "facts_hash": facts_hash, "ts": now})
    return {"text": text, "facts": facts, "cached": False}


async def _generate_note_briefing(facts: dict) -> str:
    fallback = _note_template(facts)
    try:
        from app.core.llm import ProviderInfo, stream_chat
        from app.core.pet import _default_model_id
        from app.routers.chat import resolve_model

        model_id = _default_model_id()
        if not model_id:
            return fallback
        resolved = await resolve_model(model_id)
        info = ProviderInfo(
            kind=resolved.provider.kind,
            base_url=resolved.provider.base_url,
            api_key=resolved.provider.api_key,
        )
        user = f"事实：{json.dumps(facts, ensure_ascii=False)}。\n以零柒身份写一句笔记库要点（30 字以内）："
        parts: list[str] = []
        async for delta in stream_chat(
            info,
            resolved.model,
            [
                {"role": "system", "content": _BRIEFING_SYSTEM},
                {"role": "user", "content": user},
            ],
        ):
            parts.append(delta)
        text = "".join(parts).strip().strip(' "「」『』').strip()
        if text.startswith("零柒："):
            text = text.split("：", 1)[1].strip()
        return text[:200] if text else fallback
    except Exception:  # noqa: BLE001
        return fallback


def _note_template(facts: dict) -> str:
    if facts["today_new"] >= 1:
        names = "、".join(f"《{n}》" for n in facts["latest_today"][:2])
        return f"今天写了 {names}，趁热打铁。"
    if facts["total"] == 0:
        return "vault 还是空的，写第一篇试试。"
    if facts["this_week_touched"] >= 1:
        names = "、".join(f"《{n}》" for n in facts["latest_titles"][:2])
        return f"最近动过 {names}，要不要接着写？"
    return f"库里有 {facts['total']} 篇了，很久没动笔了吧。"
