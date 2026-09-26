"""通道预判（P2）：这句话该不该去检索、该走哪条通道。

方案 §2 P2 的目标形态第一格就是它：「通道预判（复用 routing.py 思想）」——
闲聊/寒暄跳过检索、关系/多跳型走图谱为主、事实/材料型走混合检索。方案 §3 的 P2 验收把它
写成一条可测的硬要求：**闲聊零检索**（现状是每轮都检索，白付一次嵌入 + 一次混合检索）。

**形状照 W3 三级来，但有两处取舍跟它相反，理由都写死在下面**：

1. **判不定时默认「去检索」，不是「闲聊」**。`routing.py` 那边默认按闲聊处理，理由是
   「误判的代价是把闲聊变成产出，比漏判烦人得多」。这里**方向反了**，因为两次误判的代价
   不对称：
     漏判（该跳过却检索了）= 白付一次检索（本地嵌入 + BM25，几十毫秒）；
     误判（该检索却跳过了）= **材料缺失、答案变差，而且用户看不见**。
   后者更贵，所以默认走「检索」。
2. 它是**三值**（skip / kg / hybrid），而 W3 是是非题。

**按方案 §5「本方案不动 PLAN2/3/4 已落地的任何模块」，这一层没有去改 `routing.py`**——
是照形状另写的（`find_kind` 那种公开入口照用，改文件的事不做）。真要合成一层，得先动 §5
那条边界。

**金的纪律**：原型句是「这一类的代表形状」，不是用例清单；金标集
（`evals/routes/channel.json`）**只用来量，绝不被规则读进来**——否则「金标上的准确率」
就变成「背答案的准确率」（`routing.PROTOTYPES` 上方同款规矩）。
"""
from __future__ import annotations

import logging
import math
import threading
from dataclasses import dataclass

log = logging.getLogger(__name__)

CHANNELS = ("skip", "kg", "hybrid")

# 「不用材料」的说法：整句就是寒暄/应答（**按整句比，不按子串**——「早点告诉我」里有「早」，
# 但它不是寒暄）。逐条列出来比长度启发式可靠，因为误判的方向很贵。
_SMALL_TALK_EXACT = frozenset(
    {
        "在吗", "在么", "在不在", "你好", "您好", "大家好", "早", "早啊", "早上好", "晚安",
        "谢谢", "多谢", "谢谢你", "辛苦了", "收到", "好的", "好", "行", "可以", "明白",
        "哈哈", "呵呵", "嗯", "ok", "OK", "好的好的", "你是谁", "介绍一下你自己", "没事",
    }
)
# 整句里只剩这些填充字，也算寒暄（「嗯嗯」「哈哈哈哈」）
_FILLERS = frozenset("嗯哦啊哈呵嘿好行对呀嘛")
# 可出现在寒暄里、但**去掉之后剩余部分必须很短**才算寒暄（防「你好，帮我看看这份材料」）
_SMALL_TALK_PARTS = ("你好", "您好", "谢谢", "晚安", "辛苦", "在吗", "在么")

# 关系/多跳线索 → 图谱为主（方案 §1.5：「多跳/关系型问题图谱更强」）
#
# **「有什么关系」和「有关系」两条都得写**：中文里插入疑问词会把词断开——
# 「有什么关系」的字符是 有,什,么,关,系，`"有关系"` **不是**它的子串（有 与 关 不相邻）。
# 只写短的那条，「这两份材料有什么关系」就漏了；只写长的那条，「这两次事故有关系」就漏了。
_RELATION_CUES = (
    "有什么关系", "有关系", "之间的关联", "什么关联", "关联", "联系", "谁认识", "谁和谁",
    "图谱", "关系网", "连到", "串联", "牵出", "之间是什么关系",
)

# 明确要材料的说法：疑问标记 + 任务动词 + 体裁名词（体裁那张表照用 W3 的公开入口）。
_ASK_MARKS = (
    "为什么", "怎么", "如何", "是什么", "什么是", "什么", "哪些", "哪个", "多少",
    "什么样", "有没有", "什么意思", "多久", "在哪", "哪里", "谁",
)
_TASK_VERBS = (
    "帮我", "看看", "看一下", "查一下", "查查", "找一下", "找找", "讲讲", "讲一下",
    "说说", "解释", "翻译", "总结", "对比", "比较", "列一下", "整理", "写", "改",
    "复盘", "回顾", "根据", "按", "照着", "引用",
)

# 原型句：向量那一级拿它比（**不是用例清单**）。两类各自代表形状。
PROTOTYPES: dict[str, tuple[str, ...]] = {
    "skip": (
        "在吗",
        "你好呀",
        "早啊",
        "谢谢你了",
        "哈哈这个有点意思",
        "辛苦了",
        "我先去吃饭了",
        "收到",
        "你觉得呢",
        "嗯嗯",
    ),
    "hybrid": (
        "用两句话讲一下数据库索引为什么能让查询变快",
        "解释一下什么是 RAG",
        "这段代码为什么会报 KeyError",
        "帮我看看这份材料里怎么说的",
        "向量库和关键词检索各自有什么优缺点",
        "我上周记的那条笔记在哪",
        "把这个项目的进展总结一下",
        "那篇调研里提了哪些方案",
    ),
}

# 向量那一级的两个闸。**方向与 W3 不同**：这边只在「判成不用材料」且**够有把握**时才跳过，
# 否则一律去检索。所以这两道闸卡的是「跳过」，卡错的方向是安全的。
MIN_SIM = 0.62
MIN_MARGIN = 0.04

_LOCK = threading.Lock()
_PROTO_VECTORS: list[tuple[str, list[float]]] | None = None


@dataclass(frozen=True)
class Decision:
    """一次通道预判。`reason` 是给人看的一句话依据（可回放：同一句永远同一个决策）。"""

    channel: str  # skip | kg | hybrid
    level: str  # rule | vector | default
    confidence: float
    reason: str


def _strip(text: str) -> str:
    return "".join(ch for ch in (text or "").strip() if ch not in " \t\n，。！？!?、,.~～…")


def is_small_talk(ask: str) -> bool:
    """整句就是寒暄/应答？Pure。

    **按整句判、不按子串判**：「早点告诉我」含「早」、「你好，帮我看看这份材料」含「你好」，
    两个都不是寒暄。做法是「把寒暄片段摘掉之后剩下的必须很短」。
    """
    t = _strip(ask)
    if not t:
        return False
    if t in _SMALL_TALK_EXACT:
        return True
    if set(t) <= _FILLERS:
        return True
    rest = t
    for part in _SMALL_TALK_PARTS:
        rest = rest.replace(part, "")
    return len(rest) <= 2 and len(t) <= 10


def is_relational(ask: str) -> bool:
    """问的是「谁和谁有关系」这类多跳/关系型问题？Pure。"""
    t = _strip(ask)
    return any(c in t for c in _RELATION_CUES)


def needs_material(ask: str) -> bool:
    """明确要材料（疑问 / 任务动词 / 体裁名词）？Pure。"""
    from app.core import routing

    t = _strip(ask)
    if not t:
        return False
    return (
        any(m in t for m in _ASK_MARKS)
        or any(v in t for v in _TASK_VERBS)
        or bool(routing.find_kind(t))
    )


def _rule(ask: str) -> Decision | None:
    """第一级：规则。有把握就返回，没把握返回 None（交给下一级）。Pure。

    顺序有意：**关系线索最前**（它可能与疑问词同时出现，「A 和 B 有什么关系」两者都命中，
    而通道该走图谱）；寒暄在要材料之前（「在吗」没有疑问词，不会冲突）。
    """
    t = _strip(ask)
    if not t:
        return None
    if is_relational(t):
        return Decision("kg", "rule", 0.85, "关系/多跳线索（谁和谁、之间的关联）")
    if is_small_talk(t):
        return Decision("skip", "rule", 0.9, "整句就是寒暄/应答，没有信息需求")
    if needs_material(t):
        return Decision("hybrid", "rule", 0.9, "疑问标记/任务动词/体裁名词——要材料")
    return None


def _cosine(a: list[float], b: list[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(y * y for y in b))
    if not na or not nb:
        return 0.0
    return dot / (na * nb)


def _build_prototype_vectors(embed_fn) -> list[tuple[str, list[float]]]:
    pairs: list[tuple[str, list[float]]] = []
    for label, texts in PROTOTYPES.items():
        for vec in embed_fn(list(texts)):
            pairs.append((label, vec))
    return pairs


def _prototype_vectors(embed_fn=None) -> list[tuple[str, list[float]]]:
    """原型句的向量，进程内缓存一次。

    **注入进来的 `embed_fn` 一律不缓存**——这条是 `routing._prototype_vectors` 用真实教训
    换来的：缓存是全局的，注入的是测试假实现，先跑一次假的，真嵌入器的向量就再也不会被算。
    """
    if embed_fn is not None:
        return _build_prototype_vectors(embed_fn)

    global _PROTO_VECTORS
    with _LOCK:
        if _PROTO_VECTORS is None:
            from app.core.embedder import embed as default_embed

            _PROTO_VECTORS = _build_prototype_vectors(default_embed)
        return _PROTO_VECTORS


def _vector(ask: str, embed_fn=None) -> Decision | None:
    """第二级：和原型句比。**只有判成「不用材料」且够有把握**才返回 skip，否则 None。"""
    t = _strip(ask)
    if not t:
        return None
    try:
        if embed_fn is None:
            from app.core.embedder import embed as embed_fn  # type: ignore[assignment]

        pairs = _prototype_vectors(embed_fn)
        vec = embed_fn([t])[0]
    except Exception:  # noqa: BLE001 - 嵌入器不可用不该挡住聊天
        log.debug("channel vector level unavailable", exc_info=True)
        return None

    best: dict[str, float] = {label: -1.0 for label in PROTOTYPES}
    for label, pv in pairs:
        sim = _cosine(vec, pv)
        if sim > best[label]:
            best[label] = sim
    if best["skip"] < MIN_SIM or (best["skip"] - best["hybrid"]) < MIN_MARGIN:
        return None  # 不够像、或跟「要材料」拉不开 → 交给默认（去检索）
    return Decision(
        "skip",
        "vector",
        round(best["skip"], 3),
        f"与寒暄原型句的相似度 {best['skip']:.2f}（与要材料那类 {best['hybrid']:.2f}）",
    )


def pick(ask: str, *, embed_fn=None, classify_fn=None) -> Decision:
    """这句话该走哪条通道。**纯函数（除嵌入器那一次本地前向）。**

    三级：规则 → 向量原型 → （`classify_fn` 那条缝留着，默认不接线，与 W3 同）。
    **判不定 → `hybrid`（去检索）**：漏判只是白付一次检索，误判是材料缺失且用户看不见。
    """
    decision = _rule(ask)
    if decision is None:
        decision = _vector(ask, embed_fn=embed_fn)
    if decision is None and classify_fn is not None:
        try:
            verdict = classify_fn(ask)
        except Exception:  # noqa: BLE001 - 判不了就回落，绝不让它挡住这一轮
            log.debug("channel model level failed", exc_info=True)
            verdict = None
        if verdict in CHANNELS:
            decision = Decision(str(verdict), "model", 0.7, "小模型判通道（不确定的一级）")
    if decision is None:
        return Decision("hybrid", "default", 0.5, "两级都没把握 → 去检索（误判的代价更大）")
    return decision


def describe(d: Decision) -> str:
    """给人看的一行（账本、日志用）。"""
    what = {"skip": "跳过检索", "kg": "图谱为主", "hybrid": "混合检索"}[d.channel]
    return f"{what}（{d.level} {d.confidence:.2f}：{d.reason}）"
