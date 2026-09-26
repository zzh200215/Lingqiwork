"""引用验证（P3）：回复里的 `[来源 N]` 是不是真有那一条？

**它补的是哪条缺口。** `chat._build_rag_context` 只说「尽量引用、标注 [来源 N]」，
而**从来没有人验证过那个 N 是不是真的在这一次的注入列表里**。模型完全可以写一个
`[来源 7]`，而这一轮只注入了 5 条——用户看到的是一个看起来可信、其实指向空处的编号。
引擎侧（四个引擎）有接地分，聊天这条路上是**零度量**。

**它与 W2a 的 `invented_path_in_reply` 是同一类错**：模型给了一个指向不存在东西的指针
（那边是「点开即 404 的路径」，这边是「点开什么都没有的编号」）。所以形状也照抄那一份：
**判定是纯函数、只做判定不做动作**，线上（`routers/chat.py`）与离线（`core/turn_eval.py`）
用**同一份实现**——W2a 的先例原话：「同一条规则在两个地方各写一遍，分叉的那天就没人
敢信了」。

**失败行为写死：剥离 + 记账，不重生成**（RAG升级.md §3 P3）。打回重写要多一次模型调用，
而且它第二遍可能再编一个；验证器拦的是**标注**，不是回答本身。

**方向与 `channel.py` 一致（代价不对称）**：误剥掉一条真引用（内容还在、只是少个角标）
比留下一个假指针（用户信了、点不开）便宜得多。所以「这一轮一条都没注入」时，正文里的
任何 `[来源 N]` 都按编造处理。**这一点有个真实代价，写在明处**：跨轮引用（这一轮没检索、
正文却提「接着上面 [来源 3]」）会被一起剥掉——本轮检索不了上面那一轮的编号，认了。

**不收宽的两种写法**（都进了尺子 `evals/citations/cases.json`）：`[来源 N]`（模型复述
指令时就是这么写的，`N` 不是数字）、`[资料来源 3]`（不是本产品的标记格式）——它们一个
字都不许动。宽匹配吃掉的是**真话**，比漏一个假编号贵。
"""
from __future__ import annotations

import re
from dataclasses import dataclass

# 注入时用的标记格式：`chat._build_rag_context` 写的是 `[来源 {i} — {source}]`，
# 所以正文里的引用就是这个形状。容一点空格（模型常写成 `[来源1]` / `[ 来源 1 ]`）。
CITE_RE = re.compile(r"\[\s*来源\s*(\d{1,3})\s*\]")

# 剥掉标记之后收拢它留下的空格（"先结论 [来源 7] 后文" → "先结论 后文" → 一个空格）。
# **只收空格，不动标点**：空括号、被删空的一行都原样留着——那是「这里本来有东西」的痕迹，
# 加规则去美化它，下一次就会连正文一起改掉。
_SPACE_RUN = re.compile(r"[ \t]{2,}")


@dataclass(frozen=True)
class Report:
    """这一轮的引用对账。**字段全是事实**，没有分数、没有比率（照 W5 账本那条红线）。"""

    injected: int  # 这一轮注入了多少条材料（= `[来源 N]` 的合法上界）
    markers: int  # 正文里一共出现了多少个 `[来源 N]` 标记（含重复）
    cited: tuple[int, ...]  # 真的存在的编号（按首次出现，去重）
    fake: tuple[int, ...]  # 注入列表里没有的编号（按首次出现，去重）

    @property
    def ok(self) -> bool:
        return not self.fake

    @property
    def sources_cited(self) -> int:
        """被引用到了几条材料（进账本的那个 `sources_cited`）。"""
        return len(self.cited)

    @property
    def reason(self) -> str:
        if self.ok:
            return ""
        return (
            f"正文标注了不存在的 [来源 {self.fake[0]}]"
            f"（这一轮只注入了 {self.injected} 条）"
        )

    def as_dict(self) -> dict:
        """进 `quality_json` 的形状。**`stripped` 由调用方补** —— 它记的是「真的动手拿掉了
        哪几个」，只有调用方知道（同一个回合可能先剥一次、补跑之后再剥一次）。"""
        return {
            "injected": self.injected,
            "markers": self.markers,
            "cited": list(self.cited),
            "fake": list(self.fake),
        }


def _numbers(text: str) -> list[int]:
    """正文里所有 `[来源 N]` 的 N，按出现顺序、去重（第一次写的那次算数）。"""
    seen: list[int] = []
    for m in CITE_RE.finditer(text or ""):
        n = int(m.group(1))
        if n not in seen:
            seen.append(n)
    return seen


def verify(text: str, injected: int) -> Report:
    """对一次账：正文引用了哪些编号、其中哪几个是编的。Pure。

    `injected` = **这一次真正注入的条数**（`len(sources)`），不是「检索到几条」——
    编号是 `_build_rag_context` 按注入顺序发的，所以合法区间就是 `1..injected`。
    """
    total = max(0, int(injected or 0))
    nums = _numbers(text)
    markers = len(CITE_RE.findall(text or ""))
    cited = tuple(n for n in nums if 1 <= n <= total)
    fake = tuple(n for n in nums if not (1 <= n <= total))
    return Report(injected=total, markers=markers, cited=cited, fake=fake)


def strip_fake(text: str, injected: int) -> tuple[str, list[int]]:
    """把编造的 `[来源 N]` 从正文里拿掉 →（干净正文，拿掉了哪几个）。Pure。

    **只动标记本身**：正文的其余部分（包括被它删空的那一行、留下的空括号）一个字不改。
    收拢空格是因为 `"先结论 [来源 7] 后文"` 删完会剩两个连续空格，那不是用户的原文，
    是我们这次删除的痕迹。
    """
    total = max(0, int(injected or 0))
    removed: list[int] = []

    def _sub(m: re.Match) -> str:
        n = int(m.group(1))
        if 1 <= n <= total:
            return m.group(0)
        if n not in removed:
            removed.append(n)
        return ""

    out = CITE_RE.sub(_sub, text or "")
    if removed:
        out = _SPACE_RUN.sub(" ", out)
    return out, removed
