"""模型画像（W7）的接口：把「这个模型该怎么用」和它的基线摆到界面上。

**纪律在核里，不在这里**：`core/model_profiles.py` 的 `effective()` 决定一份画像生不生效
（没有基线就不生效）。这个路由只做两件事 —— 读出来、写进去。
"""
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from app.core import model_profiles

router = APIRouter(prefix="/api/model-profiles", tags=["model-profiles"])


class ProfileIn(BaseModel):
    temperature: float | None = None
    max_rounds: int | None = None
    tool_choice: str | None = None
    force_structure: bool | None = None
    supports_structure: bool | None = None
    length_policy: str | None = None
    give_output_rule: bool | None = None
    notes: str | None = None
    note: str = Field("", description="这次改动的一句话说明（进改动历史）")


@router.get("")
async def list_profiles():
    """每个在用模型的画像、基线、以及画像到底生不生效。"""
    return await model_profiles.overview()


@router.put("/{model_id:path}")
async def save_profile(model_id: str, body: ProfileIn):
    """写一份画像。**必带一条改动记录**（append-only），「改画像有前后对照」靠它。"""
    fields = body.model_dump(exclude_none=True)
    note = fields.pop("note", "")
    try:
        return await model_profiles.save(model_id, fields, note=note)
    except model_profiles.ProfileError as e:
        raise HTTPException(400, str(e)) from e


@router.post("/{model_id:path}/baseline")
async def bless_baseline(model_id: str, run_id: int | None = None):
    """把一条 W1 跑分挂成基线 —— 画像生效的唯一入口。不给 run_id 就用最近一条。"""
    try:
        return await model_profiles.bless(model_id, run_id)
    except model_profiles.ProfileError as e:
        raise HTTPException(400, str(e)) from e


@router.get("/{model_id:path}/history")
async def profile_history(model_id: str, limit: int = 20):
    return {"model_id": model_id, "changes": await model_profiles.history(model_id, limit)}
