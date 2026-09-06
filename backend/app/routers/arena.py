"""模型竞技场 HTTP 层。规则在 core/arena.py。"""
from fastapi import APIRouter
from pydantic import BaseModel

from app.core import arena as core

router = APIRouter(prefix="/api/arena", tags=["arena"])


class ArenaIn(BaseModel):
    prompt: str


@router.post("")
async def run(body: ArenaIn):
    return {"results": await core.run(body.prompt)}
