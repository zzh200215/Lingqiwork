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
    kind: str  # research | compose | recap | decide | conflict
    verdict: str  # good | bad
    prompt_sha: str = ""
    model_id: str = ""
    reason: str = ""
    ref: str = ""


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
        )
    except ValueError as e:
        raise HTTPException(400, str(e)) from e


@router.get("/summary")
async def summary(days: int = 90):
    return await quality.summary(days)
