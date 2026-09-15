"""形态（Q3）：一个领域长没长出枝。

一个只读面。三个数（检索 / 概念 / 技能）全是**算出来的**：评测结果读 `EvalRun`、
掌握读 `tutor_sessions`、技能读对照台的基线 + golden set 自带的领域。这个路由**不写
任何东西**——「领域」这三个字的写入口分别在证据自己那一侧（评测集、教学会话、金标集）。

为什么单独开一个面而不是塞进 `/api/pet/room`：小屋每 60 秒拉一次，它**只需要长出来的
那些**；工作页那张诊断表要的是**全部领域**（包括只有一样、甚至一样都不够的），好回答
「为什么这根枝还没长出来」。两个消费者、两种切面，用一个接口会逼着其中一边多拉一堆。
"""
from fastapi import APIRouter

from app.core import form as core

router = APIRouter(prefix="/api/form", tags=["form"])


@router.get("")
async def form():
    """全部领域 + 各自的三个数。`grown` 为真 = 三样都够 = 小屋会长出那根枝。"""
    return await core.branches()
