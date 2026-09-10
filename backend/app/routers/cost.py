"""成本与配额端点：token 用量 + 可选成本估算 + 可选预算状态。"""
from fastapi import APIRouter

from app.core import cost

router = APIRouter(prefix="/api/cost", tags=["cost"])


@router.get("/summary")
async def summary(days: int = 30):
    """最近 N 天 token 用量聚合（按天 / 按模型）+ 可选成本估算。"""
    s = await cost.usage_summary(days=days)
    prices = cost.load_config().get("model_prices") or {}
    return {**s, "cost": cost.estimate_cost(s["by_model"], prices)}


@router.get("/budget")
async def budget():
    """月度预算状态：是否超限（0 预算 = 未启用）。"""
    return await cost.monthly_budget_status()
