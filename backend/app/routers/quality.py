"""生成质量闭环 HTTP layer. Every rule lives in `app/core/quality.py`.

`POST /api/quality/feedback` 记一次 👍/👎（非法 kind / verdict 是 400），
`GET /api/quality/summary` 给出按 (kind, 提示词版本, 模型) 聚合的满意率。
"""

import logging

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.core import quality

router = APIRouter(prefix="/api/quality", tags=["quality"])
log = logging.getLogger(__name__)


class FeedbackIn(BaseModel):
    kind: str  # research | compose | recap | decide | conflict | deliver
    verdict: str  # good | bad
    prompt_sha: str = ""
    model_id: str = ""
    reason: str = ""
    ref: str = ""
    # S1（PLAN3 §9.2 决策4）：这份产出吃着技能生成的没有。**三态**：
    # 不传（默认 ""）= 不知道；`"[]"` = 没有注入；`'["技能名"]'` = 有注入。
    # 点 👍 的那一刻手上就有注入清单的调用方（刚跑完的预览页）才传得起这个值；
    # 从产出清单**事后**点的传不了，于是如实落在「不知道」——这一列不许编。
    injected: str = ""


@router.post("/feedback")
async def feedback(body: FeedbackIn):
    try:
        return await quality.record(
            body.kind,
            body.verdict,
            prompt_sha=body.prompt_sha,
            model_id=body.model_id,
            reason=body.reason,
            ref=body.ref,
            injected=body.injected,
        )
    except ValueError as e:
        raise HTTPException(400, str(e)) from e


@router.get("/summary")
async def summary(days: int = 90):
    return await quality.summary(days)
