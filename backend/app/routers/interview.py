"""面试陪练（M3 · PLAN §3 G3）的 HTTP 层。规则全在 `core/interview.py`。

会话本身不在这里开：它是一场 `mode='interview'` 的教学会话（`POST /api/tutor/start`），
transcript 与流式对话也走 tutor 那条路。这里只多两个端点：

- `GET  /api/interview/bank`    题库（只读：`vault/面试准备.md` + 半懂 / 又卡住概念 + 到期卡）
- `POST /api/interview/{id}/report`  散场 → 一份复盘报告落 `vault/reports/`
"""
import logging

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

router = APIRouter(prefix="/api/interview", tags=["interview"])
log = logging.getLogger(__name__)


class ReportIn(BaseModel):
    model_id: str = ""


@router.get("/bank")
async def get_bank():
    """题库 + 它现在有几条。**只读那份 md**——红线：陪练产物不回写题库。"""
    from app.core import interview

    return await interview.bank()


@router.get("/{session_id}/progress")
async def get_progress(session_id: int):
    """这场问了几题（从对话里数出来的，不是另存的计数器）。"""
    from app.core import tutor

    detail = await tutor.detail(session_id)
    if detail is None:
        raise HTTPException(404, "会话不存在")
    asked = sum(1 for t in (detail.get("turns") or []) if str(t.get("role")) == "assistant")
    return {"asked": asked, "enough": asked >= 5, "max": 8}


@router.post("/{session_id}/report")
async def make_report(session_id: int, body: ReportIn | None = None):
    """出复盘报告。判不了/写不进都**如实回 `ok=false`**——界面据此说一句，不编一份出来。"""
    from app.core import interview

    out = await interview.report(session_id, model_id=(body.model_id if body else "") or "")
    return out
