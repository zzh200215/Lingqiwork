"""信念演化时间线的 HTTP 层。规则在 core/beliefs.py，这里只是个窗口。"""
from fastapi import APIRouter

from app.core import beliefs as core

router = APIRouter(prefix="/api/beliefs", tags=["beliefs"])


@router.get("")
async def belief_threads():
    return {"threads": await core.threads()}
