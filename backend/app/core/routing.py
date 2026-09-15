"""确定性路由（W3）：把「这一句是在要一份成品，还是在问一件事」从模型手里拿走。

**它补的是什么。** 缺口三的另一半。实测：同一句自然说法在**空 vault 下 0/4、有素材时 15/16**
—— 模型在这件事上不稳定，而它决定的东西很多（要不要落盘、要不要给输出规矩、要不要走结构化）。
W2a 只敢在「用户明说要落盘」时补跑，就是因为它没法判断这个；这一条把它变成**可复算的函数**。

**三级，逐级回落，每一级都留下决策与依据**（`Decision.level` / `.confidence` / `.reason`）：

1. **规则**（零成本、零延迟）：用户明说要落盘 → 交付；祈使动词 + 体裁名词 → 交付；
   疑问/直接回答类说法 → 闲聊。
2. **向量**：和一小撮**原型句**比（`PROTOTYPES`，不是金标集 —— 金标集是尺子，不许被规则读到）。
   最近的那一类要**够像、而且比另一类明显更像**才作数。
3. **小模型二分类**：`classify_fn` 这条缝留着，**但默认不接线**。理由与数据在 §14：
   前两级在 64 条金标上已经达标（准确率与负例误判两个数都量过），而每接一条含糊的回合
   就多花一次调用 —— 白花钱不是「更稳」，是更贵。真的需要时，把 `classify_fn` 传进来即可。

**判不定时按「闲聊」处理。** 这不是保守，是 upgrade-plan §W3 写明的取舍：
**误判的代价是把闲聊变成产出，比漏判烦人得多**。所以 `Decision.delivery` 只在有把握时为真。

**不做**：不做意图体系、不做多轮槽位填充（plan 的原话）。这一条只回答一个是非题，
外加「如果是要成品，哪一类体裁」—— 认不出体裁就留空，让模型去定（W2 的不做什么：
不自动猜体裁）。
"""
from __future__ import annotations

import logging
import math
import threading
from dataclasses import dataclass

log = logging.getLogger(__name__)

# 原型句：每类的**代表形状**，不是用例清单。向量那一级拿它比 ——
# 金标集（`evals/routes/deliver_or_chat.json`）只用来量，绝不被规则读进来，
# 否则「金标上准确率」就变成了「背答案的准确率」。
PROTOTYPES: dict[bool, tuple[str, ...]] = {
    True: (
        "把这周的进展整理成一份周报存进产出",
        "帮我写一份本周周报，三百字左右",
        "写一份上线前的检查清单",
        "把这周的改动作一次复盘",
        "调研一下向量库选型，整理成一份调研报告",
        "给我两三个方案，写一份选型建议",
        "把这次分歧整理成一份对质记录存进产出",
        "把笔记整理成一篇能给同事看的成文",
        "帮我起草一封邮件",
        "把上面那份存起来",
        "这个内容落盘一下，别只写在对话里",
        "整理成文档存到产出里",
        "出一份给领导看的季度汇报",
        "帮我写一篇八百字的文章，存进产出",
    ),
    False: (
        "用两句话讲一下数据库索引为什么能让查询变快",
        "讲讲 asyncio 事件循环是怎么工作的",
        "解释一下什么是 RAG",
        "这段代码为什么会报 KeyError",
        "我该怎么排查这个内存泄漏",
        "向量库和关键词检索各自的优缺点是什么",
        "这两个函数有什么区别",
        "帮我看看这段 SQL 有什么问题",
        "帮我把这句话翻译成英文",
        "你觉得这个项目怎么样",
        "在吗",
        "我今天心情有点复杂",
        "帮我算一下 128 的平方根",
        "我们刚才说到哪了",
    ),
}

# 向量那一级的两个闸。**这两个数是量出来的，不是拍的**：
# 在 64 条金标（32 正 / 32 负）上 —— 规则级单独 62/64（负例误判 0），加上这一级后 **64/64**、
# 负例仍然 0 误判（见 `tests/test_routing.py` 与 docs §14）。
#
# **这个边界很薄，诚实写在这里**：负例 n26「帮我记住我下周三要去上海」的相似度是 **0.606**，
# 离 0.62 只有 0.014 —— 也就是说，把 `MIN_SIM` 往下调一点点，它就会被判成交付型。
# 而另一个负例 n19 是被 `MIN_MARGIN` 挡住的（0.531 对 0.515，差 0.016 < 0.04）。
# 所以：往下调之前先去账本里看 `level="vector"` 的那些决策，别只看金标上的一个数。
MIN_SIM = 0.62
MIN_MARGIN = 0.04

# 「要一份成品」的说法：祈使动词 + 体裁名词。
_DELIVER_VERBS = ("写", "整理", "起草", "拟", "出", "生成", "汇总", "做成", "润色", "归档", "存")
# 体裁名词 → 落盘体裁（与 `mcp._ARTIFACT_KINDS` 同一套 key）。**认不出就留空。**
#
# **顺序是有意的：具体在前，笼统在后。**「报告」是最笼统的那个（调研报告、事后报告、周报
# 都能叫报告），所以 `deliver` 排在最后 —— 先让「调研报告」被 research 认走，剩下的报告才
# 算交付稿。这条顺序不是风格问题：它决定了「调研报告」到底算哪一类。
_KIND_NOUNS: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("research", ("调研", "研究", "选型报告")),
    ("recap", ("复盘", "回顾")),
    ("decide", ("方案", "决策", "取舍", "建议书")),
    ("conflict", ("对质", "分歧", "冲突")),
    ("compose", ("成文", "文章", "短文", "稿子", "稿", "公众号")),
    ("deliver", ("周报", "日报", "月报", "汇报", "报告", "交付", "清单", "邮件", "通知", "计划", "说明书")),
)
# 「问一件事 / 要一句回答」的说法。分两档，**这不是细节，是最容易搞错的那条分界线**：
#
# - `_WH_MARKS`（疑问副词）：它问的是**怎么/为什么**，所以哪怕句子里有祈使动词和体裁名词，
#   它也是在问一件事 —— 「我该怎么写复盘？」不是要一份复盘，「复盘为什么延期？」同理。
# - `_POLITE_TAIL`（句尾的「吗/呢」）：只是**礼貌**，不改变产出物 ——
#   「帮我写一份周报可以吗？」仍然是要一份周报。两者混起来就会把这一类误判成闲聊。
_WH_MARKS = (
    "为什么", "怎么", "如何", "是什么", "什么是", "什么", "哪些", "哪个", "多少",
    "什么样", "有没有", "什么意思",
)
_POLITE_TAIL = ("吗？", "吗?", "呢？", "呢?")
_CHAT_VERBS = ("翻译", "解释", "讲讲", "讲一下", "说说", "聊聊", "看看", "算一下", "查一下", "告诉我")

_EMBED_LOCK = threading.Lock()
_PROTO_VECTORS: list[tuple[bool, list[float]]] | None = None


@dataclass(frozen=True)
class Decision:
    """一次路由决策。`reason` 是给人看的一句话依据（可回放：同一句话永远得到同一个决策）。"""

    delivery: bool
    kind: str  # "" = 不猜，交给模型
    level: str  # rule | vector | default
    confidence: float
    reason: str


def find_kind(ask: str) -> str:
    """这句话点明了哪一类体裁；认不出返回 ""。Pure —— **不猜体裁**。"""
    text = ask or ""
    for kind, nouns in _KIND_NOUNS:
        if any(n in text for n in nouns):
            return kind
    return ""


def _asks_how(ask: str) -> bool:
    """疑问副词（问的是怎么/为什么）—— 它优先于「祈使动词 + 体裁名词」。Pure。"""
    return any(m in (ask or "") for m in _WH_MARKS)


def _polite_or_direct_answer(ask: str) -> bool:
    """句尾的「吗/呢」或者「要一句回答」的动词。Pure。"""
    text = (ask or "").strip()
    return text.endswith(_POLITE_TAIL) or any(v in text for v in _CHAT_VERBS)


def _rule(ask: str) -> Decision | None:
    """第一级：规则。有把握就返回，没把握返回 None（交给下一级）。Pure。"""
    from app.core import length_budget, turn_quality

    text = (ask or "").strip()
    if not text:
        return None
    kind = find_kind(text)

    # ① 用户明说要落盘 —— 这一条最硬：话是用户说的，不是我们猜的。
    if turn_quality.asked_to_save(text):
        return Decision(
            delivery=True,
            kind=kind,
            level="rule",
            confidence=0.95,
            reason="用户明说要落盘" + (f"（体裁：{kind}）" if kind else "（没点体裁）"),
        )

    has_verb = any(v in text for v in _DELIVER_VERBS)
    has_budget = length_budget.parse_budget(text) is not None

    # ② 问的是「怎么/为什么」→ 那是在问一件事（哪怕句子里有动词和体裁名词）。
    if _asks_how(text):
        return Decision(False, "", "rule", 0.9, "疑问副词（问的是怎么/为什么）")

    # ③ 祈使动词 + 体裁名词 → 要一份成品。
    if has_verb and kind:
        return Decision(True, kind, "rule", 0.9, f"祈使动词 + 体裁名词（{kind}）")

    # ④ 句尾「吗/呢」或「要一句回答」的动词 → 闲聊（礼貌不改变产出物，所以放在 ③ 之后）。
    if _polite_or_direct_answer(text):
        return Decision(False, "", "rule", 0.85, "句尾的「吗/呢」或要一句回答的说法")

    # ⑤ 体裁名词 + 字数意图（哪怕没有动词）：一份三百字左右的周报。
    if kind and has_budget:
        return Decision(True, kind, "rule", 0.85, f"体裁名词 + 字数意图（{kind}）")

    return None


def _cosine(a: list[float], b: list[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(y * y for y in b))
    if not na or not nb:
        return 0.0
    return dot / (na * nb)


def _build_prototype_vectors(embed_fn) -> list[tuple[bool, list[float]]]:
    pairs: list[tuple[bool, list[float]]] = []
    for label, texts in PROTOTYPES.items():
        for vec in embed_fn(list(texts)):
            pairs.append((label, vec))
    return pairs


def _prototype_vectors(embed_fn=None) -> list[tuple[bool, list[float]]]:
    """原型句的向量。**进程内缓存一次**（本地 embedder，不花钱，但没必要每轮重算）。

    **注入进来的 `embed_fn` 一律不缓存**：缓存是全局的，而注入的是测试/灰度的假实现 ——
    第一版就是被这个咬了：测试里先用假嵌入器跑了一遍，真嵌入器的向量就再也不会被算，
    于是「向量级认不出任何东西」这个结论其实是我自己造成的。
    """
    if embed_fn is not None:
        return _build_prototype_vectors(embed_fn)

    global _PROTO_VECTORS
    with _EMBED_LOCK:
        if _PROTO_VECTORS is None:
            from app.core.embedder import embed as default_embed

            _PROTO_VECTORS = _build_prototype_vectors(default_embed)
        return _PROTO_VECTORS


def _vector(ask: str, embed_fn=None) -> Decision | None:
    """第二级：和原型句比。**够像、而且比另一类明显更像**才作数，否则 None。"""
    text = (ask or "").strip()
    if not text:
        return None
    try:
        if embed_fn is None:
            from app.core.embedder import embed as embed_fn  # type: ignore[assignment]

        pairs = _prototype_vectors(embed_fn)
        vec = embed_fn([text])[0]
    except Exception:  # noqa: BLE001 - 嵌入器不可用（没下模型、磁盘满）不该挡住聊天
        log.debug("routing vector level unavailable", exc_info=True)
        return None

    best: dict[bool, float] = {True: -1.0, False: -1.0}
    for label, pv in pairs:
        sim = _cosine(vec, pv)
        if sim > best[label]:
            best[label] = sim
    top, second = (True, best[False]) if best[True] >= best[False] else (False, best[True])
    top_sim = best[top]
    if top_sim < MIN_SIM or (top_sim - second) < MIN_MARGIN:
        return None
    return Decision(
        delivery=top,
        # 体裁仍然只从**名词**来（同一个确定性查表），向量级不猜体裁 ——
        # 认不出就留空交给模型（W2 的不做什么）。
        kind=find_kind(text) if top else "",
        level="vector",
        confidence=round(top_sim, 3),
        reason=f"与原型句的相似度 {top_sim:.2f}（另一类 {second:.2f}）",
    )


def route(ask: str, *, embed_fn=None, classify_fn=None) -> Decision:
    """这句话要的是一份成品，还是在问一件事。**纯函数（除嵌入器那一次本地前向）。**

    `embed_fn` / `classify_fn` 是测试与灰度用的注入口；生产路径一个都不用传。
    """
    decision = _rule(ask)
    if decision is None:
        decision = _vector(ask, embed_fn=embed_fn)
    if decision is None and classify_fn is not None:
        # 第三级（小模型二分类）。**默认不接线**，只在调用方显式给了 `classify_fn` 时才走。
        try:
            verdict = classify_fn(ask)
        except Exception:  # noqa: BLE001 - 判不了就回落，绝不让它挡住这一轮
            log.debug("routing model level failed", exc_info=True)
            verdict = None
        if verdict is not None:
            delivery, kind = verdict if isinstance(verdict, tuple) else (bool(verdict), "")
            decision = Decision(
                delivery=bool(delivery),
                kind=str(kind or ""),
                level="model",
                confidence=0.7,
                reason="小模型二分类（不确定的一级）",
            )
    if decision is None:
        return Decision(
            delivery=False,
            kind="",
            level="default",
            confidence=0.5,
            reason="两级都没把握 → 按闲聊处理（误判的代价更大）",
        )
    return decision


def describe(d: Decision) -> str:
    """给人看的一行（账本、日志用）。"""
    what = f"交付型/{d.kind or '体裁待定'}" if d.delivery else "闲聊"
    return f"{what}（{d.level} {d.confidence:.2f}：{d.reason}）"
