"""Reusable prompt library (Open WebUI-style Prompts)."""
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, field_validator
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_db
from app.models import Prompt

router = APIRouter(prefix="/api/prompts", tags=["prompts"])


class PromptIn(BaseModel):
    title: str
    content: str

    @field_validator("title")
    @classmethod
    def title_not_blank(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("title cannot be blank")
        return v[:100]


class PromptPatch(BaseModel):
    title: str | None = None
    content: str | None = None


def _dump(p: Prompt) -> dict:
    return {"id": p.id, "title": p.title, "content": p.content, "created_at": p.created_at.isoformat()}


@router.get("")
async def list_prompts(db: AsyncSession = Depends(get_db)):
    rows = (await db.execute(select(Prompt).order_by(Prompt.id))).scalars().all()
    return [_dump(p) for p in rows]


@router.post("")
async def create_prompt(body: PromptIn, db: AsyncSession = Depends(get_db)):
    row = Prompt(title=body.title, content=body.content)
    db.add(row)
    await db.commit()
    await db.refresh(row)
    return _dump(row)


@router.put("/{prompt_id}")
async def update_prompt(prompt_id: int, body: PromptPatch, db: AsyncSession = Depends(get_db)):
    row = await db.get(Prompt, prompt_id)
    if not row:
        raise HTTPException(404, "prompt not found")
    if body.title is not None and body.title.strip():
        row.title = body.title.strip()[:100]
    if body.content is not None:
        row.content = body.content
    await db.commit()
    await db.refresh(row)
    return _dump(row)


@router.delete("/{prompt_id}")
async def delete_prompt(prompt_id: int, db: AsyncSession = Depends(get_db)):
    row = await db.get(Prompt, prompt_id)
    if not row:
        raise HTTPException(404, "prompt not found")
    await db.delete(row)
    await db.commit()
    return {"ok": True}
