"""回合账本的读数口（W5）。规则都在 `core/turn_trace.py`。

一个只读面：最近若干回合，以及**按看得懂的那几种毛病筛**（声称存了没存 / 长正文没落盘 /
一轮多份 / 慢 / 贵 / 出错）。存在的理由是升级计划那句话：这一轮为什么慢/贵/没存，
**能在界面上点出来，不用起脚本**。

红线与 `quality.py` 同一条：这是诊断工具，不是考核仪表。所以这里没有「好回合」这个筛选项，
也没有百分比、没有排行榜、没有目标。
"""
from fastapi import APIRouter

from app.core import turn_trace

router = APIRouter(prefix="/api/turns", tags=["turns"])


@router.get("")
async def list_turns(limit: int = 50, only: str = ""):
    """最近若干回合。`only` 见 `turn_trace.FILTERS`；空 = 不筛。"""
    return await turn_trace.recent(limit=limit, only=only)
