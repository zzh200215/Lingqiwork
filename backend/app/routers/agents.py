"""Agent presets CRUD + deterministic multi-agent collaboration runs."""
import json

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, field_validator
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import collab
from app.db import SessionLocal, get_db
from app.models import Agent
from app.models import Conversation, Message

router = APIRouter(prefix="/api/agents", tags=["agents"])


class AgentIn(BaseModel):
    name: str
    avatar: str = "🤖"
    system_prompt: str = ""
    model_id: str = ""
    use_rag: bool = False
    tools_enabled: bool = True
    enabled: bool = True

    @field_validator("name")
    @classmethod
    def name_not_blank(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("name 不能为空")
        return v[:50]

    @field_validator("avatar")
    @classmethod
    def avatar_short(cls, v: str) -> str:
        return (v or "🤖")[:8]


class AgentPatch(BaseModel):
    """Partial update — all fields optional."""

    name: str | None = None
    avatar: str | None = None
    system_prompt: str | None = None
    model_id: str | None = None
    use_rag: bool | None = None
    tools_enabled: bool | None = None
    enabled: bool | None = None


def _out(a: Agent) -> dict:
    return {
        "id": a.id,
        "name": a.name,
        "avatar": a.avatar,
        "system_prompt": a.system_prompt,
        "model_id": a.model_id,
        "use_rag": a.use_rag,
        "tools_enabled": a.tools_enabled,
        "enabled": a.enabled,
    }


@router.get("")
async def list_agents(db: AsyncSession = Depends(get_db)):
    rows = (await db.execute(select(Agent).order_by(Agent.id))).scalars().all()
    return [_out(r) for r in rows]


@router.post("")
async def create_agent(body: AgentIn, db: AsyncSession = Depends(get_db)):
    dup = (
        await db.execute(select(Agent).where(Agent.name == body.name))
    ).scalar_one_or_none()
    if dup:
        raise HTTPException(409, f"同名智能体已存在：{body.name}")
    row = Agent(**body.model_dump())
    db.add(row)
    await db.commit()
    await db.refresh(row)
    return _out(row)


@router.put("/{agent_id}")
async def update_agent(
    agent_id: int, body: AgentPatch, db: AsyncSession = Depends(get_db)
):
    row = await db.get(Agent, agent_id)
    if not row:
        raise HTTPException(404, "agent not found")
    data = body.model_dump(exclude_none=True)
    if "name" in data and data["name"] != row.name:
        dup = (
            await db.execute(select(Agent).where(Agent.name == data["name"]))
        ).scalar_one_or_none()
        if dup:
            raise HTTPException(409, f"同名智能体已存在：{data['name']}")
    for k, v in data.items():
        setattr(row, k, v)
    await db.commit()
    await db.refresh(row)
    return _out(row)


@router.delete("/{agent_id}")
async def delete_agent(agent_id: int, db: AsyncSession = Depends(get_db)):
    row = await db.get(Agent, agent_id)
    if not row:
        raise HTTPException(404, "agent not found")
    await db.delete(row)
    await db.commit()
    return {"ok": True}


# ---------- multi-agent collaboration (deterministic patterns) ----------


class CollabIn(BaseModel):
    conversation_id: int
    goal: str
    agent_ids: list[int]
    pattern: str = "pipeline"
    use_rag: bool = False

    @field_validator("pattern")
    @classmethod
    def known_pattern(cls, v: str) -> str:
        if v not in collab.PATTERNS:
            raise ValueError(f"pattern 只能是 {'/'.join(collab.PATTERNS)}")
        return v

    @field_validator("goal")
    @classmethod
    def goal_not_blank(cls, v: str) -> str:
        if not (v or "").strip():
            raise ValueError("goal 不能为空")
        return v[: collab.MAX_GOAL_CHARS]


def _sse(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


@router.post("/collab")
async def run_collab(body: CollabIn):
    """Run agents in a fixed pattern, streaming the transcript as one message."""
    if not (collab.MIN_AGENTS <= len(body.agent_ids) <= collab.MAX_AGENTS):
        raise HTTPException(400, f"协作需要 {collab.MIN_AGENTS}~{collab.MAX_AGENTS} 个智能体")
    if len(set(body.agent_ids)) != len(body.agent_ids):
        raise HTTPException(400, "智能体不能重复选择")

    async with SessionLocal() as db:
        conv = await db.get(Conversation, body.conversation_id)
        if not conv:
            raise HTTPException(404, "conversation not found")
        rows = []
        for aid in body.agent_ids:
            a = await db.get(Agent, aid)
            if not a or not a.enabled:
                raise HTTPException(400, f"智能体不可用: id={aid}")
            rows.append(a)
        default_model_id = conv.model_id
        user_msg = Message(conversation_id=conv.id, role="user", content=body.goal.strip())
        db.add(user_msg)
        if conv.title == "New chat":
            conv.title = body.goal.strip().replace("\n", " ")[:50] or "New chat"
        agent_dicts = [
            {"id": a.id, "name": a.name, "avatar": a.avatar, "system_prompt": a.system_prompt, "model_id": a.model_id}
            for a in rows
        ]
        conv_id = conv.id
        await db.commit()

    from app.routers.chat import _save_assistant_message, indexer_retrieve, resolve_model

    async def resolve(model_id: str):
        return await resolve_model(model_id or default_model_id)

    async def retrieve(query: str, top_k: int):
        return await indexer_retrieve(query, top_k)

    retrieve_fn = retrieve if body.use_rag else None

    async def gen():
        transcript = ""
        try:
            async for event, data in collab.run(body.goal, agent_dicts, body.pattern, resolve, retrieve_fn):
                if event == "delta":
                    transcript += data["text"]
                yield _sse(event, data)
        except Exception as e:  # noqa: BLE001 - surface setup failures in-stream
            yield _sse("error", {"message": f"{type(e).__name__}: {e}"})
        if transcript.strip():
            await _save_assistant_message(conv_id, transcript, default_model_id or "collab")

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
