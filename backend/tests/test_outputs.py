"""人工出口 `/api/outputs` 的端点测试。

from-message（回执挂回消息）与 from-text（方向 1 的共用出口：导师 / 陪伴 / 笔记对话 /
划词助手的 AI 回答）必须走**同一条** `save_artifact` 工具路径（`_save_via_tool`）——
落点、索引、零柒成长值只有一份判据。所以这里用**真工具**落进沙箱 vault，
不 mock 落盘本身；mock 了就测不出「两条路同源」这件事。
"""
import json
import sys

import pytest
from fastapi import HTTPException

sys.path.insert(0, ".")

from app.config import VAULT_DIR  # noqa: E402
from app.db import SessionLocal  # noqa: E402
from app.models import Conversation, Message  # noqa: E402
from app.routers.outputs import (  # noqa: E402
    SaveFromMessageIn,
    SaveFromTextIn,
    save_from_message,
    save_from_text,
)


async def test_from_text_saves_via_the_real_tool():
    out = await save_from_text(
        SaveFromTextIn(kind="recap", title="测试复盘", content="方向 1 的共用出口正文")
    )
    assert out["kind"] == "recap"
    assert out["path"]
    assert (VAULT_DIR / out["path"]).is_file(), "回执指向的文件必须真的在盘上"


async def test_from_text_rejects_empty_content():
    with pytest.raises(HTTPException) as ei:
        await save_from_text(SaveFromTextIn(kind="recap", content="   "))
    assert ei.value.status_code == 400


async def test_from_text_rejects_unknown_kind():
    with pytest.raises(HTTPException) as ei:
        await save_from_text(SaveFromTextIn(kind="no-such-kind", content="正文"))
    assert ei.value.status_code == 400
    assert "kind" in str(ei.value.detail)


async def test_from_text_derives_title_from_first_line():
    out = await save_from_text(SaveFromTextIn(kind="recap", content="## 我的标题\n正文"))
    assert "我的标题" in out["title"]


async def test_from_message_attaches_receipt_to_the_message():
    async with SessionLocal() as db:
        conv = Conversation(title="t")
        db.add(conv)
        await db.flush()
        msg = Message(conversation_id=conv.id, role="assistant", content="正文一段")
        db.add(msg)
        await db.commit()
        cid, mid = conv.id, msg.id

    out = None
    async with SessionLocal() as db:
        # 直接调端点函数，Depends 不会注入——session 自己给
        out = await save_from_message(
            SaveFromMessageIn(conversation_id=cid, message_id=mid, kind="recap"), db
        )
    assert out["path"]

    async with SessionLocal() as db:
        row = await db.get(Message, mid)
        arts = json.loads(row.artifacts_json)
        assert arts and arts[-1]["path"] == out["path"], "回执必须挂回那条消息"


async def test_from_message_rejects_user_role():
    async with SessionLocal() as db:
        conv = Conversation(title="t")
        db.add(conv)
        await db.flush()
        msg = Message(conversation_id=conv.id, role="user", content="用户的话")
        db.add(msg)
        await db.commit()
        cid, mid = conv.id, msg.id

    async with SessionLocal() as db:
        with pytest.raises(HTTPException) as ei:
            await save_from_message(
                SaveFromMessageIn(conversation_id=cid, message_id=mid, kind="recap"), db
            )
    assert ei.value.status_code == 400
