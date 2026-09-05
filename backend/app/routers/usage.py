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