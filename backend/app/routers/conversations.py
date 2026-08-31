"""Conversation CRUD + fork + markdown export."""
import json
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, field_validator
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.db import get_db
from app.models import Conversation, Message

router = APIRouter(prefix="/api/conversations", tags=["conversations"])


class ConversationCreate(BaseModel):
    title: str = "New chat"
    model_id: str = ""


class ConversationUpdate(BaseModel):
    title: str | None = None
    model_id: str | None = None
    pinned: bool | None = None
    folder: str | None = None


def _dump(c: Conversation, with_messages: bool = False) -> dict:
    data = {
        "id": c.id,
        "title": c.title,
        "model_id": c.model_id,
        "pinned": bool(getattr(c, "pinned", False)),
        "folder": getattr(c, "folder", "") or "",
        "created_at": c.created_at.isoformat(),
        "updated_at": c.updated_at.isoformat(),
    }
    if with_messages:
        data["messages"] = [
            {
                "id": m.id,
                "role": m.role,
                "content": m.content,
                "sources": json.loads(m.sources_json) if m.sources_json else None,
                "model_id": m.model_id,
                "feedback": getattr(m, "feedback", None),
                "tokens_in": getattr(m, "tokens_in", None),
                "tokens_out": getattr(m, "tokens_out", None),
                "created_at": m.created_at.isoformat(),
            }
            for m in c.messages
        ]
    return data


@router.get("")
async def list_conversations(db: AsyncSession = Depends(get_db)):
    rows = (
        await db.execute(
            select(Conversation).order_by(
                Conversation.pinned.desc(), Conversation.updated_at.desc()
            )
        )
    ).scalars().all()
    return [_dump(c) for c in rows]


@router.post("")
async def create_conversation(body: ConversationCreate, db: AsyncSession = Depends(get_db)):
    row = Conversation(title=body.title, model_id=body.model_id)
    db.add(row)
    await db.commit()
    await db.refresh(row)
    return _dump(row)


@router.get("/{conversation_id}")
async def get_conversation(conversation_id: int, db: AsyncSession = Depends(get_db)):
    row = (
        await db.execute(
            select(Conversation)
            .options(selectinload(Conversation.messages))
            .where(Conversation.id == conversation_id)
        )
    ).scalar_one_or_none()
    if not row:
        raise HTTPException(404, "conversation not found")
    return _dump(row, with_messages=True)


@router.put("/{conversation_id}")
async def update_conversation(
    conversation_id: int, body: ConversationUpdate, db: AsyncSession = Depends(get_db)
):
    row = await db.get(Conversation, conversation_id)
    if not row:
        raise HTTPException(404, "conversation not found")
    if body.title is not None:
        row.title = body.title
    if body.model_id is not None:
        row.model_id = body.model_id
    if body.pinned is not None:
        row.pinned = body.pinned
    if body.folder is not None:
        row.folder = body.folder.strip()[:100]
    await db.commit()
    await db.refresh(row)
    return _dump(row)


@router.delete("/{conversation_id}")
async def delete_conversation(conversation_id: int, db: AsyncSession = Depends(get_db)):
    row = await db.get(Conversation, conversation_id)
    if not row:
        raise HTTPException(404, "conversation not found")
    await db.delete(row)
    await db.commit()
    return {"ok": True}


class MessageRef(BaseModel):
    message_id: int


@router.post("/{conversation_id}/fork")
async def fork_conversation(
    conversation_id: int, body: MessageRef, db: AsyncSession = Depends(get_db)
):
    src = (
        await db.execute(
            select(Conversation)
            .options(selectinload(Conversation.messages))
            .where(Conversation.id == conversation_id)
        )
    ).scalar_one_or_none()
    if not src:
        raise HTTPException(404, "conversation not found")
    upto = next((m for m in src.messages if m.id == body.message_id), None)
    if not upto:
        raise HTTPException(404, "message not found in conversation")

    copy = src.messages[: src.messages.index(upto) + 1]
    fork = Conversation(title=f"{src.title} (分叉)", model_id=src.model_id)
    db.add(fork)
    await db.flush()
    for m in copy:
        db.add(
            Message(
                conversation_id=fork.id,
                role=m.role,
                content=m.content,
                sources_json=m.sources_json,
                model_id=m.model_id,
            )
        )
    await db.commit()
    await db.refresh(fork)
    return _dump(fork)


class MessageEdit(BaseModel):
    content: str


class FeedbackIn(BaseModel):
    rating: str | None = None  # 'up' | 'down' | None (clear)

    @field_validator("rating")
    @classmethod
    def check_rating(cls, v: str | None) -> str | None:
        if v not in ("up", "down", None):
            raise ValueError("rating must be 'up', 'down' or null")
        return v


@router.put("/{conversation_id}/messages/{message_id}/feedback")
async def set_message_feedback(
    conversation_id: int,
    message_id: int,
    body: FeedbackIn,
    db: AsyncSession = Depends(get_db),
):
    row = await db.get(Message, message_id)
    if not row or row.conversation_id != conversation_id:
        raise HTTPException(404, "message not found")
    if row.role != "assistant":
        raise HTTPException(400, "only assistant messages can be rated")
    row.feedback = body.rating
    await db.commit()
    return {"ok": True, "feedback": row.feedback}


@router.put("/{conversation_id}/messages/{message_id}")
async def edit_message(
    conversation_id: int,
    message_id: int,
    body: MessageEdit,
    db: AsyncSession = Depends(get_db),
):
    """Edit a user message and drop everything after it (caller re-runs the turn)."""
    row = await db.get(Message, message_id)
    if not row or row.conversation_id != conversation_id:
        raise HTTPException(404, "message not found")
    if row.role != "user":
        raise HTTPException(400, "only user messages can be edited")
    new_content = body.content.strip()
    if not new_content:
        raise HTTPException(400, "content cannot be empty")

    later_rows = (
        await db.execute(
            select(Message)
            .where(Message.conversation_id == conversation_id, Message.id > message_id)
        )
    ).scalars().all()
    later_ids = [m.id for m in later_rows]
    if later_ids:
        await db.execute(delete(Message).where(Message.id.in_(later_ids)))

    row.content = new_content
    conv = await db.get(Conversation, conversation_id)
    if conv:
        conv.updated_at = datetime.now(timezone.utc)
    await db.commit()
    return {"ok": True, "dropped": len(later_ids)}


@router.get("/{conversation_id}/export")
async def export_conversation(conversation_id: int, db: AsyncSession = Depends(get_db)):
    """Export the whole conversation as a Markdown document."""
    row = (
        await db.execute(
            select(Conversation)
            .options(selectinload(Conversation.messages))
            .where(Conversation.id == conversation_id)
        )
    ).scalar_one_or_none()
    if not row:
        raise HTTPException(404, "conversation not found")

    lines = [f"# {row.title}", "", f"> 导出于 {datetime.now().strftime('%Y-%m-%d %H:%M')}"
            + (f" · 模型 {row.model_id}" if row.model_id else ""), ""]
    for m in row.messages:
        who = "🧑 我" if m.role == "user" else ("🤖 助手" if m.role == "assistant" else "⚙️ 系统")
        lines.append(f"## {who}")
        lines.append("")
        lines.append(m.content)
        if m.sources_json:
            try:
                sources = json.loads(m.sources_json)
            except json.JSONDecodeError:
                sources = []
            if sources:
                lines.append("")
                lines.append("**参考片段**: " + " · ".join(s.get("source", "?") for s in sources))
        lines.append("")
    md = "\n".join(lines)
    from urllib.parse import quote

    from fastapi.responses import Response

    return Response(
        content=md,
        media_type="text/markdown; charset=utf-8",
        headers={
            "Content-Disposition": (
                f"attachment; filename=\"chat-{row.id}.md\"; "
                f"filename*=UTF-8''{quote(row.title or 'chat')}-{row.id}.md"
            )
        },
    )
