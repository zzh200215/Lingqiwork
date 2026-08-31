"""Global search across conversations (SQLite LIKE — fine at personal scale)."""
from fastapi import APIRouter, Depends, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_db
from app.models import Conversation, Message

router = APIRouter(prefix="/api/search", tags=["search"])


@router.get("")
async def global_search(
    q: str = Query(..., min_length=1),
    limit: int = 20,
    db: AsyncSession = Depends(get_db),
):
    needle = q.strip()
    if not needle:
        return {"query": q, "results": []}

    pattern = f"%{needle}%"
    msgs = (
        await db.execute(
            select(Message, Conversation.title)
            .join(Conversation, Message.conversation_id == Conversation.id)
            .where(Message.content.like(pattern))
            .order_by(Message.id.desc())
            .limit(limit)
        )
    ).all()

    results = []
    for m, conv_title in msgs:
        # small excerpt around the first hit
        idx = m.content.find(needle)
        start = max(0, idx - 40)
        excerpt = m.content[start : idx + len(needle) + 80].replace("\n", " ")
        results.append(
            {
                "message_id": m.id,
                "conversation_id": m.conversation_id,
                "conversation_title": conv_title,
                "role": m.role,
                "excerpt": ("…" if start > 0 else "") + excerpt + ("…" if idx + len(needle) + 80 < len(m.content) else ""),
            }
        )
    return {"query": needle, "results": results}
