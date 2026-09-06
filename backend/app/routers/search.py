"""Global search across conversations + tutor turns (SQLite LIKE — fine at
personal scale; PLAN.md 实测过语义检索对「精确找回」不可靠，全文才是对的工具).

教学轮次从 2026-09-06 起一并覆盖（EvoForge 参考项：每个过去的会话都可搜索）：
聊天命中带 conversation_id，教学命中带 session_id，前端按 source 跳转。
"""
from fastapi import APIRouter, Depends, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_db
from app.models import Conversation, Message, TutorSession, TutorTurn, iso_utc

router = APIRouter(prefix="/api/search", tags=["search"])


def _excerpt(content: str, needle: str) -> str:
    idx = content.find(needle)
    if idx < 0:
        return content[:120].replace("\n", " ")
    start = max(0, idx - 40)
    end = idx + len(needle) + 80
    excerpt = content[start:end].replace("\n", " ")
    return ("…" if start > 0 else "") + excerpt + ("…" if end < len(content) else "")


@router.get("")
async def global_search(
    q: str = Query(..., min_length=1),
    limit: int = 20,
    db: AsyncSession = Depends(get_db),
):
    needle = q.strip()
    if not needle:
        return {"query": q, "results": []}

    # % 和 _ 是 LIKE 的通配符：搜「100%」不该变成全表命中
    safe = needle.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    pattern = f"%{safe}%"

    msgs = (
        await db.execute(
            select(Message, Conversation.title)
            .join(Conversation, Message.conversation_id == Conversation.id)
            .where(Message.content.like(pattern, escape="\\"))
            .order_by(Message.id.desc())
            .limit(limit)
        )
    ).all()
    turns = (
        await db.execute(
            select(TutorTurn, TutorSession.topic)
            .join(TutorSession, TutorTurn.session_id == TutorSession.id)
            .where(TutorTurn.content.like(pattern, escape="\\"))
            .order_by(TutorTurn.id.desc())
            .limit(limit)
        )
    ).all()

    results: list[dict] = []
    for m, conv_title in msgs:
        results.append(
            {
                "source": "chat",
                "id": m.id,
                "ref_id": m.conversation_id,
                "title": conv_title,
                "role": m.role,
                "excerpt": _excerpt(m.content, needle),
                "at": iso_utc(m.created_at),
            }
        )
    for t, topic in turns:
        results.append(
            {
                "source": "tutor",
                "id": t.id,
                "ref_id": t.session_id,
                "title": topic,
                "role": t.role,
                "excerpt": _excerpt(t.content, needle),
                "at": iso_utc(t.created_at),
            }
        )
    results.sort(key=lambda r: r["at"] or "", reverse=True)
    return {"query": needle, "results": results[:limit]}
