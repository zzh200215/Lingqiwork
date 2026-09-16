"""调度台（Q4）：确定性编排的看板。**只读 + 复用现成的动作**。

- `GET /api/dispatch` —— 看板（链条、每一步的状态、谁在跑、卡在哪、可点的动作、宠物那句话）。
- 动作**不在这里**：放行/重跑走 `POST /api/tasks/runs/{id}/approve|reject` 与
  `POST /api/tasks/{id}/run`（现成的接口，语义与权限都已经定好了，不另写一份）。
"""
from fastapi import APIRouter

from app.core import dispatch

router = APIRouter(prefix="/api/dispatch", tags=["dispatch"])


@router.get("")
async def get_board(limit: int = 20):
    return await dispatch.board(limit)
