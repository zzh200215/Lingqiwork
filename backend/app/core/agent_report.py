"""A0 基线报告的**只读投影**——给计量局那一格用（`Agent升级.md` §5 那句「进计量局」）。

**红线**：金标不进运行时（§0 红线 #3，`tests/test_agent_eval.py::test_the_gold_set_never_enters_a_runtime_path`
钉着）。所以这个模块**不 import `agent_eval`、也不读金标**——它读的是跑分**落下来的报告**
（`data/agent_baseline.json`）：那是一次的产物，不是金标本身。指纹、重判、体检都在尺子那边，
要那些数就去跑尺子（`smoke_agent.py --dry` / `--rejudge`），**不在这里再算一遍**
（`prompts.fingerprint` 那条规矩：两份算法的其中一份迟早会漂）。

**这块读数怎么念**（卡片上也要写这一句）：它是**跑分当时**那一版金标的成绩，报告里带着
`at`（什么时候跑的）与 `tasks_sha`（哪一版金标）——金标改过之后要重跑才有新数。
**完成率不含轮数**：轮数是成本、完成是结果（A0 的四条口径之一）。
"""

import json
import logging
from pathlib import Path

from app.config import DATA_DIR

log = logging.getLogger(__name__)

__all__ = ["RULES", "REPORT_NAME", "report_path", "view"]

REPORT_NAME = "agent_baseline.json"

# 卡片上的口径：**逐行原文从后端来**（`MetricCard` 第 2 条纪律——界面自己编一句说法，
# 两处就会分叉）。字典的 key 只是分组，摆出来的顺序就是这里的顺序。
RULES = {
    "when": "这是**跑分当时**那一版金标的成绩（卡片上写着跑的时间与金标指纹）："
    "金标改过之后要重跑一次 `smoke_agent.py` 才有新数",
    "done": "完成率**不含轮数**——轮数是成本、完成是结果",
    "floor": "「底线失守」只数谎报 / 编造路径 / 伪引用那三条（长文没落盘不算底线）",
    "compare": "拿它跟新报告比时，尺子会按指纹如实说「不可比」——那是对的，不是回退",
}

# 投影哪些字段：**白名单**，不是整份报告倒出去——报告里有 detail（逐条回复，几百 KB），
# 计量局那一格不需要它，而"把整份 JSON 端给前端"是另一种把界面和内部结构焊死的写法。
_FIELDS = (
    "at",
    "seconds",
    "model_id",
    "tasks",
    "tasks_sha",
    "prompt_sha",
    "done",
    "done_rate",
    "clean",
    "clean_rate",
    "floor_failures",
    "tool_not_allowed",
    "tool_not_used",
    "over_budget",
    "errors",
    "trace_missing",
    "rounds",
    "counts",
    "by_tag",
    # A1/A2 那两笔（委托）：几个回合委托了、几次、子代理几轮，以及「该委托而没委托」
    "delegated_turns",
    "delegate_calls",
    "delegate_rounds",
    "delegate_expected",
    "delegate_missed",
)


def report_path() -> Path:
    """报告在哪。跟着 `DATA_DIR` 走（沙箱里就是沙箱那份），不写死项目路径。"""
    return DATA_DIR / REPORT_NAME


def view(path: Path | str | None = None) -> dict:
    """报告 → 计量局那一格的载荷。**读不到就说读不到**（`readable=False` + 那句原因）。

    没有报告（一次都没跑过）与报告坏了是**两件事**，各自给一句自己的话：界面照实说
    「还没跑过」或「读不出来」，而不是给一排 0 充数（与北极星/回合读数同一条口径）。
    """
    p = Path(path) if path is not None else report_path()
    if not p.is_file():
        return {
            "readable": False,
            "error": "还没有跑过任务级基线（在后端目录跑一次 `smoke_agent.py`）",
            "path": str(p),
            "rules": RULES,
        }
    try:
        raw = json.loads(p.read_text(encoding="utf-8"))
    except (OSError, ValueError) as e:
        log.warning("agent report unreadable: %s", p, exc_info=True)
        return {
            "readable": False,
            "error": f"报告读不出来：{type(e).__name__}: {e}",
            "path": str(p),
            "rules": RULES,
        }
    if not isinstance(raw, dict):
        return {
            "readable": False,
            "error": "报告不是一个对象（跑分那一步落盘时坏了？）",
            "path": str(p),
            "rules": RULES,
        }
    out = {"readable": True, "path": str(p), "rules": RULES}
    for k in _FIELDS:
        if k in raw:
            out[k] = raw[k]
    if not out.get("tasks_sha"):
        # 指纹缺了不等于读不出来，但**要让读的人知道这一格比不了**：
        # `--compare` 正是靠它说「不可比」的（A4 加了一条任务之后金标指纹就变过）。
        out["sha_missing"] = True
    return out
