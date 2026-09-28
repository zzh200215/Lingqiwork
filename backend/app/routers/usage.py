"""Telemetry router: the "打开次数" half of the 第0周 usage baseline.

`POST /api/usage/visit` is fired once per page load by the frontend layout
(best-effort, never blocks render). Literal path before `/{...}` — same rule as
cards.py / habits.py.
"""
import logging

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.core import usage as core

router = APIRouter(prefix="/api/usage", tags=["usage"])
log = logging.getLogger(__name__)


class VisitIn(BaseModel):
    page: str = ""


@router.post("/visit")
async def record_visit(body: VisitIn):
    if not core.valid_page(body.page):
        raise HTTPException(400, f"未知页面：{body.page or '(空)'}")
    return await core.record_visit(body.page)


@router.get("/open-days")
async def open_days(days: int = 7):
    days = max(1, min(int(days), 90))
    return {"days": days, "open_days": await core.open_days(days)}


@router.get("/features")
async def features():
    """功能真实用量（CTO review #6）：`model_usage` 按操作名聚合。

    这是「30 天自用窗口」的读数来源——哪些功能真的在被使用、哪些零记录。
    零记录 ≠ 不存在；裁决（留/删）等窗口结束拿数据说话，这里只摆事实。

    方向 4 补的第二只读：`page_opens` 是各页**打开过的天数**——只读面不跑模型，
    没有这个信号它们在裁决的尺子上是盲的。与 features 同为全部历史口径。
    """
    from app.core import usage_ledger

    return {
        "features": await usage_ledger.feature_usage(),
        "page_opens": await core.page_opens(),
    }