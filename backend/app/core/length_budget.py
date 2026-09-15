"""长度约束的确定性执行（W4）：把「多少字」从**模型的自我叙述**变成**服务端能数的事实**。

**它补的是什么。** W2a 管的是「说了要存就得真存」，这一条管「存下来的东西长度对不对」。
实测（upgrade-plan 缺口四）：带「300 字左右」的说法，20 轮里 **5 轮存了 ≥2 次**，最坏一轮 4 次
—— 模型写一版、自己估一下「超了」，再写一版、再存一次。它估得准不准没人知道，因为
**「超没超」这件事以前只有它自己在心里算**。

**这里只做三件事，都是确定性的：**

1. `count(text)`：字数怎么数（与 `answer_chars`、回执里报的那个数**同一个算法**）。
2. `parse_budget(text)`：从**用户那句话**里认出字数预算（「三百字左右」「不超过 500 字」），
   认不出就是 `None` —— **不猜**。认出「硬上限」还是「左右」，因为这两者的判据不一样。
3. `verdict(text, budget)`：超没超、超了多少。

**为什么预算认不出来就不猜**：猜错的方向只有两种，一种是把闲聊按 300 字裁剪（用户没要求），
一种是给一句本来没约束的话加上约束（模型会为了满足一个不存在的预算多存一版，正是要治的病）。
两种都比「不认」差。

**没做的第三种（如实记下）**：plan 里还有一条「服务端裁剪：确定性截到预算」。**不做** ——
当前没有哪一类产出适合**静默裁掉用户的内容**（`deliver`/`recap` 都是成品，截了就是丢东西，
而且丢得没有痕迹）。真要裁剪，得先有一个显式的「这一类可以裁」的配置，而不是默认给所有体裁。
现在走的是 plan 的第二条：**单次受限修订**（同一个文件、一回合最多 2 次落盘），执行点
在 `core/mcp.py::_save_artifact`。
"""
from __future__ import annotations

import re
from dataclasses import dataclass

# 预算的合理区间。低于 20 字的「N 字」多半不是在说长度预算（「两个字」是词，不是预算），
# 高于 2 万的也不是（那是小说，不是这个产品的活儿）。认不出区间就当作没认出。
MIN_BUDGET = 20
MAX_BUDGET = 20000

# 「左右」这类软约束的容忍度：300 字左右写到 359 字不算超。硬上限（不超过/以内）1.0。
SOFT_TOLERANCE = 1.2

_HARD_MARKERS = ("不超过", "不得超过", "以内", "以下", "上限", "最多")

_ARABIC = re.compile(r"(\d{2,5})\s*字")
_CHINESE = re.compile(r"([零一二两三四五六七八九十百千]{1,6})\s*字")
_CN_DIGIT = {"零": 0, "一": 1, "二": 2, "两": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9}


@dataclass(frozen=True)
class Budget:
    """一句话里的字数预算。`hard=True` 表示「不超过/以内」这种硬上限。"""

    chars: int
    hard: bool
    phrase: str  # 认出来的那一段原文（给人看，不进判据）

    @property
    def tolerance(self) -> float:
        return 1.0 if self.hard else SOFT_TOLERANCE

    def limit(self) -> int:
        """超过这个数才算超。"""
        return int(self.chars * self.tolerance)


def count(text: str | None) -> int:
    """字数怎么数：去首尾空白后的长度。

    与 `turn_trace.answer_chars`、以及回执里报给用户的那个数**同一个算法** —— 服务端报的字数
    和账本里的字数不一致，是那种「看半天才发现两个数不是一个东西」的坑。
    """
    return len((text or "").strip())


def _cn_number(raw: str) -> int | None:
    """中文数字 → 整数。支持 一…九十九、一百、三百、一千、一千二百、八千。"""
    if not raw:
        return None
    if "百" in raw or "千" in raw:
        total = 0
        unit = 0
        for ch in raw:  # 逐字扫：一千二百 → 1000 + 200
            if ch in _CN_DIGIT:
                unit = _CN_DIGIT[ch]
            elif ch == "十":
                unit = unit or 1
                total += unit * 10
                unit = 0
            elif ch == "百":
                total += (unit or 1) * 100
                unit = 0
            elif ch == "千":
                total += (unit or 1) * 1000
                unit = 0
        return total + unit
    if "十" in raw:
        head, _, tail = raw.partition("十")
        tens = _CN_DIGIT.get(head, 1) if head else 1
        ones = _CN_DIGIT.get(tail, 0) if tail else 0
        return tens * 10 + ones
    return _CN_DIGIT.get(raw)


def parse_budget(text: str) -> Budget | None:
    """从用户那句话里认出字数预算；认不出返回 None。Pure。

    一句话里出现多个字数时取**第一个**（「先写八百字，再删到三百字」里第一个是祈使的目标）。
    这条歧义如实写在这里：真出现两个目标时，模型可以在 `save_artifact` 的 `length_budget`
    参数里给一个明确的数，服务端会优先用它 —— 但**只在服务端自己认不出的时候**。
    """
    ask = text or ""
    for rx, conv in ((_ARABIC, int), (_CHINESE, _cn_number)):
        m = rx.search(ask)
        if not m:
            continue
        n = conv(m.group(1))
        if n is None or not (MIN_BUDGET <= n <= MAX_BUDGET):
            continue
        window = ask[max(0, m.start() - 8) : m.end() + 4]
        return Budget(chars=int(n), hard=_is_hard(window), phrase=m.group(0))
    return None


def _is_hard(window: str) -> bool:
    """硬上限只在**用户写了硬上限的话**时成立（「不超过 / 以内 / 以下 / 不得超过」）。

    只说「三百字的周报」的：按软约束算（20% 容忍）。理由是这条判据的用途 —— 它要拦的是
    「模型为了凑字数反复重写」，不是替用户挑刺；把一个正常的 320 字周报报成「超了」，
    用户下次就不看这个标签了。
    """
    return any(k in window for k in _HARD_MARKERS)


def verdict(text: str, budget: Budget | None) -> dict:
    """超没超、超了多少、按多少算超。Pure。`budget=None` = 这一轮没有字数约束。"""
    n = count(text)
    if budget is None:
        return {"chars": n, "budget": None, "hard": None, "limit": None, "over": False, "over_by": 0}
    return {
        "chars": n,
        "budget": budget.chars,
        "hard": budget.hard,
        "limit": budget.limit(),
        "over": n > budget.limit(),
        "over_by": max(0, n - budget.chars),
    }


def describe(budget: Budget | None) -> str:
    """给人看的一句话（回执里用）。没有预算就空着 —— 不编一个「不限」出来。"""
    if budget is None:
        return ""
    kind = "不超过" if budget.hard else "左右"
    return f"预算 {budget.chars} 字{kind}"
