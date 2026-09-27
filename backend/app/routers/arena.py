"""模型竞技场 HTTP 层。规则在 core/arena.py。"""
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from app.config import VAULT_DIR
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


@router.get("/records")
async def list_records():
    """历次对打记录（`vault/prompts/duels/`）——对打浏览器（2026-09-26）。

    存的时候就是一篇普通 md（`save_record`），这里只回「**哪几篇、什么时候**」，
    正文走既有的笔记页（`/notes?path=`）看——同一份文件不做第二个查看器。
    按修改时间倒序、封顶 50 篇；目录不存在 = 一次都没存过，返回空表不报错。
    """
    duel_dir = core.DUEL_DIR
    if not duel_dir.exists():
        return {"records": []}
    out = []
    for p in sorted(duel_dir.glob("*.md"), key=lambda x: x.stat().st_mtime, reverse=True)[:50]:
        out.append(
            {
                "path": p.relative_to(VAULT_DIR).as_posix(),
                "title": p.stem,
                "mtime": int(p.stat().st_mtime),
            }
        )
    return {"records": out}


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
