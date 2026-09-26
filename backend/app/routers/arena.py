"""模型竞技场 HTTP 层。规则在 core/arena.py。"""
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from app.core import arena as core

router = APIRouter(prefix="/api/arena", tags=["arena"])


class ArenaIn(BaseModel):
    # 这一问（答什么）。**与 `system` 分开**是 §8.2 区2「同一输入并排比」的全部意义：
    # 合成一段就量不出「换了模型」这一件事。
    prompt: str = ""
    # 提示词（怎么答）。空 = 老行为：整段当 user 消息。
    system: str = ""
    # 只打这几个模型（提示词页的「对打」：选 2–4 个比一比）。
    # **不传 = 所有已启用的 provider**——原行为，一字不变。
    models: list[str] | None = None


class ResultIn(BaseModel):
    label: str = ""
    ok: bool = False
    text: str = ""
    error: str = ""
    seconds: float = 0.0
    tokens_in: int | None = None
    tokens_out: int | None = None


class SaveIn(BaseModel):
    title: str = ""
    system: str = ""
    prompt: str = ""
    model_id: str = ""
    results: list[ResultIn] = Field(default_factory=list)


@router.post("")
async def run(body: ArenaIn):
    return {"results": await core.run(body.prompt, body.models, body.system)}


@router.post("/save")
async def save(body: SaveIn):
    """把这一次对打落成 `vault/prompts/duels/` 里一篇 md 并进索引。

    **一份对照记录，不是一条断言**——为什么不进评测区的金标集，见 `core.arena.save_record`。
    """
    try:
        return await core.save_record(
            title=body.title,
            system=body.system,
            prompt=body.prompt,
            model_id=body.model_id,
            results=[r.model_dump() for r in body.results],
        )
    except ValueError as e:
        raise HTTPException(422, str(e)) from e
