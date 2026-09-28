"""把一条已有的回答**手工**归档成产出 —— P1 的人工出口。

`save_artifact` 是**靠模型自觉**调的，而模型并不总调。实测（sensenova-6.8-flash-lite
与 deepseek-v4-pro，自然说法「帮我写一份本周周报，300 字左右。」）：模型几乎从不调它
（flash-lite 两批合计 1/18）。工具调用本身没坏——绕过适配层直接读原始流，`finish_reason`
就是 `tool_calls`，`skill_load` / `kb_search` / `vault_list_files` 都照调。它只是把
「写一份周报」当成**一次回答**，而不是一次**落盘**。

后果是静默的：正文好端端躺在回复里，却没进 vault——工作页产出清单看不到、零柒成长
不算、检索也搜不到。用户不会知道少了什么。

所以给它一条人工出口：内容已经在手上了，体裁由你点，一键落盘、回执写回那条消息。
**刻意不做自动判定**——「这算不算一份成品、算哪一类」交给用户，不猜。
"""
import json

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_db
from app.models import Message

router = APIRouter(prefix="/api/outputs", tags=["outputs"])


class SaveFromMessageIn(BaseModel):
    conversation_id: int
    message_id: int
    kind: str
    title: str = ""


class SaveFromTextIn(BaseModel):
    """一段**不在会话里**的回答（划词助手 / 导师 / 陪伴 / 笔记对话…）。"""

    kind: str
    title: str = ""
    content: str


async def _save_via_tool(content: str, kind: str, title: str) -> dict:
    """经模型同款的 `save_artifact` 工具落盘，返回回执。

    两个人工出口（from-message / from-text）共用的就这一段：**不另写一份落盘逻辑**——
    落点目录、索引、零柒成长值读的 `_OUTPUT_DIRS` 都得跟工具那条路一致。回执接不住要
    502：落盘成功了却装没事，界面会以为失败而重试，写出第二份。
    """
    from app.core import mcp

    # 人工出口每次调用自成一轮：不跟别的请求共享「这一轮存过哪些体裁」的记录，
    # 所以用户手动存第二份时不会被当成「在改上一份」而覆盖掉。
    mcp.begin_turn()
    out = await mcp.mcp_manager.call_tool(
        "save_artifact",
        {"kind": kind, "title": title.strip() or _derive_title(content), "content": content},
    )
    if out.startswith(("[错误]", "[tool error]")):
        raise HTTPException(400, out)
    art = (mcp.take_tool_meta() or {}).get("artifact")
    if not isinstance(art, dict):
        raise HTTPException(502, "产出已落盘但没拿到回执")
    return art


def _existing_artifacts(msg: Message) -> list[dict]:
    """这条消息已经存过的产出。老行是 NULL、坏 JSON 一律当没有。"""
    raw = getattr(msg, "artifacts_json", None)
    if not raw:
        return []
    try:
        items = json.loads(raw)
    except (TypeError, ValueError):
        return []
    return [a for a in items if isinstance(a, dict)] if isinstance(items, list) else []


def _derive_title(content: str) -> str:
    """标题取正文的第一个非空行（去掉 markdown 标题号），没有就用「产出」。"""
    for raw in content.splitlines():
        line = raw.strip()
        if not line:
            continue
        return (line.lstrip("#").strip() or "产出")[:40]
    return "产出"


@router.get("/kinds")
async def list_kinds():
    """可选体裁。真值是 `core.mcp._ARTIFACT_KINDS`（落点目录 + 标签都由它定），
    前端不硬编码——多做一份表就是多一个漂移点。"""
    from app.core import mcp

    return {
        "kinds": [
            {"kind": kind, "label": label, "dir": dir_name}
            for kind, (dir_name, label) in mcp._ARTIFACT_KINDS.items()
        ]
    }


@router.post("/from-message")
async def save_from_message(body: SaveFromMessageIn, db: AsyncSession = Depends(get_db)):
    """把会话里的一条回答存成产出，并把回执挂回那条消息。"""
    msg = (
        await db.execute(
            select(Message).where(
                Message.id == body.message_id,
                Message.conversation_id == body.conversation_id,
            )
        )
    ).scalar_one_or_none()
    if msg is None:
        raise HTTPException(404, "message not found")
    if msg.role != "assistant":
        raise HTTPException(400, "只有助手的回答能存成产出")
    content = (msg.content or "").strip()
    if not content:
        raise HTTPException(400, "这条回答没有正文")

    art = await _save_via_tool(content, body.kind, body.title)
    msg.artifacts_json = json.dumps([*_existing_artifacts(msg), art], ensure_ascii=False)
    await db.commit()
    return art


@router.post("/from-text")
async def save_from_text(body: SaveFromTextIn):
    """把一段不在会话里的 AI 回答存成产出（方向 1 的共用出口）。

    落盘与 `/from-message` 同一条工具路径。差别只在「回执挂哪儿」：这里没有消息行
    可挂，回执直接返回、由前端就地展示；**持久的那份记录是 vault 文件本身**——
    工作页产出清单照常翻得到。
    """
    content = (body.content or "").strip()
    if not content:
        raise HTTPException(400, "没有正文")
    return await _save_via_tool(content, body.kind, body.title)
