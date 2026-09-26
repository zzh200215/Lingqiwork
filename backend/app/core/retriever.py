"""Hybrid retrieval: BM25 (lexical) + vector (semantic), fused with RRF.

The BM25 corpus is rebuilt from ChromaDB documents whenever the index
changes (generation counter). Chinese/English tokenization via jieba.
Fusion uses Reciprocal Rank Fusion: score = sum(1 / (k + rank)), k=60.

外面还有四件：
- **按来源限块** `_diversify`：一次 top-6 里出现过 3 条来自同一个文件（实测），喂给引擎的
  「你的材料」就变成同一页的三份。限块之后广度优先，不够再原序回填，不会比原来更少。
- **结果缓存**：同一句查询不再重复付 BM25 + 向量 + cross-encoder 重排的钱。索引一变
  （`_cache_epoch`）整片失效。
- **两路各用最合适的形态** `_search_forms`：向量路与词法路的查询**可以不是同一句话**
  （HyDE 靠的就是这条不对称）。`hybrid_search` 只是两路同形的那一次调用。
- **查询理解策略池** `deep_search`（P1c）：改写（现状）/ HyDE / 子问题分解三档并列，
  由 `pick_strategy` 的**确定性规则**选档（不让模型选——省一次调用，且选择本身可测）。
  实测中→英改写一次能多带回 4-6 条原话撞不到的材料——材料是中英混杂的，而检索是拿
  一句话去撞的。**哪档上线由金标分档量出来定，默认值不抢跑。**
"""
import asyncio
import logging
import re
import threading
from collections import OrderedDict

import jieba
from pydantic import BaseModel, Field, field_validator

from app.core import indexer

log = logging.getLogger(__name__)

_RRF_K = 60
PER_SOURCE_MAX = 2  # 同一个文档最多占几个名额（限块，见 _diversify）
_CACHE_MAX = 128  # 查询结果缓存条数（FIFO）
REWRITE_MAX = 3  # 改写最多要几条
DECOMPOSE_MAX = 3  # 子问题最多拆几条（宁少勿滥：多了就是把原话稀释成几份）

_lock = threading.Lock()
_bm25 = None            # BM25Okapi | None when empty
_corpus_ids: list[str] = []  # chunk ids aligned with _bm25 corpus rows
_generation: int | None = None  # chroma count at build time
_cache_epoch = 0        # 索引一重建就 +1，用来让结果缓存整片失效
_cache: OrderedDict = OrderedDict()


def tokenize(text: str) -> list[str]:
    return [t for t in jieba.lcut(text.lower()) if t.strip()]


def _build_corpus() -> tuple[list[str], list[dict]]:
    col = indexer.get_collection()
    data = col.get(include=["documents", "metadatas"])
    return data["documents"], data["metadatas"]


def _ensure_index() -> None:
    """Rebuild the BM25 index if the chroma collection changed."""
    global _bm25, _corpus_ids, _generation, _cache_epoch
    col = indexer.get_collection()
    count = col.count()
    with _lock:
        if _bm25 is not None and _generation == count:
            return
        docs, metas = _build_corpus()
        _corpus_ids = [
            f"{m.get('source')}::{m.get('chunk')}" for m in metas
        ]
        if docs:
            from rank_bm25 import BM25Okapi

            _bm25 = BM25Okapi([tokenize(d) for d in docs])
        else:
            _bm25 = None
        _generation = count
        _cache_epoch += 1  # 索引变了 → 之前缓存的结果作废
        _cache.clear()


def invalidate() -> None:
    """Force a rebuild on next search (call after indexing changes)."""
    global _generation
    with _lock:
        _generation = None
        _cache.clear()


def bm25_search(query: str, top_k: int) -> list[tuple[str, float]]:
    """Returns [(chunk_id, score)] sorted desc, up to top_k non-zero hits."""
    _ensure_index()
    with _lock:
        if _bm25 is None:
            return []
        scores = _bm25.get_scores(tokenize(query))
        order = sorted(range(len(scores)), key=lambda i: scores[i], reverse=True)
        out = []
        for i in order[: top_k * 3]:
            if scores[i] <= 0:
                break
            out.append((_corpus_ids[i], float(scores[i])))
        return out


def _chunk_id_of(hit: dict) -> str:
    return f"{hit['source']}::{hit['chunk']}"


def _copy_hits(hits: list[dict]) -> list[dict]:
    """给调用方一份浅拷贝（channels 也复制）——缓存里的条目不能被外面改坏。"""
    return [dict(h, channels=list(h.get("channels") or [])) for h in hits]


def _cache_get(key: tuple):
    with _lock:
        hit = _cache.get(key)
        if hit is None:
            return None
        _cache.move_to_end(key)
    return _copy_hits(hit)


def _cache_put(key: tuple, hits: list[dict]) -> None:
    with _lock:
        _cache[key] = _copy_hits(hits)
        _cache.move_to_end(key)
        while len(_cache) > _CACHE_MAX:
            _cache.popitem(last=False)


def _diversify(hits: list[dict], top_k: int, per_source: int = PER_SOURCE_MAX) -> list[dict]:
    """同一来源最多占 per_source 个名额；不够 top_k 时按原序回填被挤掉的。Pure.

    为什么要有它：实测一次 top-6 里出现过 3 条来自同一个文件——喂给引擎的「你的材料」
    就成了同一页的三份，别的来源全被挤出去。回填保证结果**不会比不限块时更少**，只是
    顺序先广度后深度。
    """
    kept: list[dict] = []
    overflow: list[dict] = []
    counts: dict[str, int] = {}
    for h in hits:
        src = str(h.get("source") or "")
        if counts.get(src, 0) < per_source:
            counts[src] = counts.get(src, 0) + 1
            kept.append(h)
        else:
            overflow.append(h)
    if len(kept) < top_k:
        kept.extend(overflow[: top_k - len(kept)])
    return kept[:top_k]


def _search_forms(
    vec_query: str,
    lex_query: str,
    top_k: int,
    candidate_k: int,
    tag: str,
    *,
    rerank_query: str | None = None,
) -> list[dict]:
    """两路**各用自己的查询形态** → RRF 融合 → 限块/重排。`tag` 进缓存 key。

    之前两路共用一个 `query`，所以「换个形态去检索」只能在句子层面做。HyDE 要的正是
    形态不对称：假设段落进向量路（答案形态与文档的词汇鸿沟更小），原话进词法路
    （BM25 要的是真词，拿一段生成文本去撞词面只会更差）。拆出这一层，`hybrid_search`
    就是两路同形的那一次调用。
    """
    from app.core import prefs

    rerank_on = prefs.rerank_enabled()
    # 缓存 key 要带上索引代次：索引一变（epoch +1），之前的结果整片作废
    key = (tag, vec_query, lex_query, top_k, candidate_k, rerank_on, _cache_epoch)
    cached = _cache_get(key)
    if cached is not None:
        return cached

    # with a reranker we can afford a wider candidate pool before the cut
    pool = candidate_k if not rerank_on else max(candidate_k, top_k * 4)
    vec_hits = indexer.search(vec_query, min(pool, max(top_k * 2, 10)))
    lex_hits = bm25_search(lex_query, pool)

    # enrich lexical hits with doc text/metadata from the collection
    id_to_hit: dict[str, dict] = {}
    for h in vec_hits:
        id_to_hit[_chunk_id_of(h)] = h
    missing = [cid for cid, _ in lex_hits if cid not in id_to_hit]
    if missing:
        col = indexer.get_collection()
        res = col.get(ids=missing)
        for i, cid in enumerate(res["ids"]):
            meta = res["metadatas"][i]
            id_to_hit[cid] = {
                "id": cid,
                "text": res["documents"][i],
                "source": meta.get("source"),
                "title": meta.get("title"),
                "chunk": meta.get("chunk"),
                "score": 0.0,
            }

    rrf: dict[str, float] = {}
    channels: dict[str, set[str]] = {}
    vec_ids = [_chunk_id_of(h) for h in vec_hits]
    lex_ids = [cid for cid, _ in lex_hits]
    # 向量路的**原始**相似度：`hit["score"]` 融合之后是 RRF 分，而质量门的主判据要的是
    # 融合之前那一层（RAG升级.md §3：`vec_top1` 门口径 AUC 0.814，RRF 分只有 0.733）。
    # 只从向量路来的条才有这个值；纯词法命的条挂 None——门会跳过，不把缺失当 0。
    vec_raw = {cid: float(h.get("score") or 0.0) for cid, h in zip(vec_ids, vec_hits)}
    for label, ranking in (("vec", vec_ids), ("bm25", lex_ids)):
        for rank, cid in enumerate(ranking):
            rrf[cid] = rrf.get(cid, 0.0) + 1.0 / (_RRF_K + rank + 1)
            channels.setdefault(cid, set()).add(label)

    ranked = sorted(rrf.items(), key=lambda kv: kv[1], reverse=True)
    out = []
    for cid, score in ranked:
        hit = dict(id_to_hit[cid])
        hit["score"] = round(score, 4)
        hit["channels"] = sorted(channels[cid])
        hit["vec"] = vec_raw.get(cid)
        out.append(hit)

    if not rerank_on:
        final = _diversify(out, top_k)
    else:
        from app.core import reranker

        # 重排永远拿**用户的原话**打分：HyDE 那条路里 vec_query 是一段假设答案，
        # 交叉编码器要判的是「这段材料答不答用户的问题」，不是「像不像那段假设」。
        # 重排本来就把候选全打一遍分，所以多要一些不额外花钱；限块会挤掉同源条目，
        # 得留够备选才能把 top_k 填满
        wide = reranker.rerank(rerank_query or lex_query, out, max(top_k, min(len(out), top_k * 4)))
        final = _diversify(wide, top_k)
    _cache_put(key, final)
    return final


def hybrid_search(query: str, top_k: int = 5, candidate_k: int = 20) -> list[dict]:
    """Vector + BM25 fused with RRF (+ optional cross-encoder rerank), 限块 + 缓存。"""
    return _search_forms(query, query, top_k, candidate_k, "hybrid")


def search_hyde(query: str, passage: str, top_k: int = 5, candidate_k: int = 20) -> list[dict]:
    """HyDE：`passage`（假设答案）进向量路，`query`（原话）进词法路。

    为什么两路要用不同形态：向量路比的是「意思」，拿答案形态去撞文档比拿问题形态更近；
    词法路比的是「词面」，生成文本里的词是编的，拿它去撞只会稀释真词的权重。
    """
    passage = (passage or "").strip()
    if not passage:
        return hybrid_search(query, top_k, candidate_k)
    return _search_forms(passage, query, top_k, candidate_k, "hyde", rerank_query=query)


# ---------- 多问几遍 ----------


def merge_hits(groups: list[list[dict]], top_k: int = 5) -> list[dict]:
    """几组命中按 chunk 去重合并（同一条取最高分），再限块取前 top_k。Pure。

    多句查询、HyDE、子问题分解的产物都从这里合并——「同一条取最高分」这条规矩只写
    一份，免得各档各写一份、分叉了没人敢信。
    """
    merged: dict[str, dict] = {}
    for hits in groups:
        for h in hits:
            cid = _chunk_id_of(h) if h.get("source") is not None else str(h.get("id"))
            prev = merged.get(cid)
            if prev is None or (h.get("score") or 0.0) > (prev.get("score") or 0.0):
                merged[cid] = h
    ranked = sorted(merged.values(), key=lambda h: h.get("score") or 0.0, reverse=True)
    return _diversify(ranked, top_k)


def search_multi(queries: list[str], top_k: int = 5) -> list[dict]:
    """多句查询各搜一遍，按 chunk 去重合并（同一条取最高分），再限块取前 top_k。

    「把这个话题多说几遍」是提召回最便宜的一招：同一个意思换种说法，撞到的 chunk 不一样。
    实测中→英改写一次能多带回 4-6 条原话撞不到的材料。只读索引。
    """
    groups = [
        indexer.search_auto(q, top_k)
        for q in (str(x or "").strip() for x in queries)
        if q
    ]
    return merge_hits(groups, top_k)


# ---------- 查询理解：策略池（P1c）----------

# 确定性规则（方案 §2 P1c 写死的三条）：**不让模型选策略**——省一次调用，而且
# 「选择本身」可以离线单测；选错了比选哪个更难定位。
_MULTI_HOP_CUES = (
    "为什么", "怎么影响", "有什么区别", "区别", "差异", "相比", "对比",
    "之间的关系", "哪个更", "分别",
)
_QUESTION_CUES = (
    "?", "？", "吗", "呢", "怎么", "如何", "什么", "哪", "谁", "多少",
    "是否", "能不能", "有没有", "该不该",
)


def pick_strategy(query: str) -> str:
    """问题 → 检索策略（`decompose` | `hyde` | `rewrite`）。Pure。

      - 含多跳/比较线索 → `decompose`（复合问题拆成单跳，走既有 search_multi）
      - 陈述型（没有任何疑问标记）→ `hyde`（它更像「要写一段」，答案形态更好撞）
      - 其余 → `rewrite`（现状：换几种说法）

    刻意是确定性函数：多一次模型调用、多一处不可测的分叉，不划算。
    """
    q = (query or "").strip()
    if not q:
        return "rewrite"
    if any(c in q for c in _MULTI_HOP_CUES):
        return "decompose"
    if not any(c in q for c in _QUESTION_CUES):
        return "hyde"
    return "rewrite"


_REWRITE_PROMPT = """你在帮检索「多问几遍」。给一个话题，写 3 条**换种说法**的检索式。
只输出一个 JSON 对象，不要任何解释：

{"queries": ["改写1", "改写2", "改写3"]}

硬要求：
1. 换说法，不是同义替换：换角度、换用词去问同一件事。
2. **至少一条用另一种语言**（中文话题给英文检索式，反之亦然）——材料里中英混杂，
   换一种语言往往能撞到原话撞不到的东西。
3. 不要重复原话；也不要写「研究一下」这种没有信息量的开头。"""


def _as_str_list(v) -> list[str]:
    """模型给的「列表 / 换行分号分隔的字符串 / 其它」→ 字符串列表。Pure。

    改写与分解共用同一条收口：两份 schema 各写一遍就是两处会分叉的地方。
    """
    if isinstance(v, str):
        return re.split(r"[\n；;]+", v) if v.strip() else []
    if isinstance(v, (list, tuple)):
        return [str(x).strip() for x in v if x is not None and str(x).strip()]
    return []


class _RewritePlan(BaseModel):
    queries: list[str] = Field(default_factory=list)

    @field_validator("queries", mode="before")
    @classmethod
    def _as_list(cls, v):
        return _as_str_list(v)


async def _delegate_text(messages: list[dict], model_id: str, *, tools: bool = True) -> str:
    """把一次「查询理解」交给 A1 的委托通道（`Agent升级.md` §5 那句「在委托处合流」）。

    **为什么值得合流、以及它到底买到了什么**（2026-09-22 核过一遍才写的）：
    - 账**不**是理由：直连那条路每一次调用都会过 `llm._absorb_usage` → `usage_ledger.note`，
      在 span 里本来就是记着的；
    - 隔离也不是：这三档生成本来就带着自己的 messages，不碰主循环的回合状态；
    - **唯一真有区别的是工具**：委托通道可以给它只读工具（vault / kb_search），
      于是「策略生成自己去看一眼材料」这件事第一次成为可能——而那是**能力变化**，
      得按「量出来的才上」的规矩过一遍 P1c 金标，所以它默认**关**（`via_delegate=False`）。

    返回 "" = 这条路没走通（没模型 / 委托报错 / 交出占位符）：调用方**退回直连**——
    这一层是给检索提召回的，不是拿通道换可靠性。
    """
    from app.core import delegate

    out = await delegate.run(
        "查询理解", model_id=model_id, messages=messages, with_readonly=tools
    )
    if out.get("error") or out.get("rounds_exhausted"):
        log.info("retriever: 委托通道没走通（%s），退回直连", out.get("error") or "轮数烧光")
        return ""
    return str(out.get("text") or "").strip()


def _parse_plan(raw: str, schema):
    """委托通道回来的文本 → 结构化对象（与 `structured` 同一套清洗）。Pure。

    只管**清洗 + 校验**，不管重试：重试那条路（L1 原生通道 / L3 自纠正）在直连那一侧，
    走委托时失败就退回那边，不在这里再写一遍。
    """
    from app.core.structured import clean_json

    blob = clean_json(raw or "")
    if blob is None:
        return None
    try:
        return schema.model_validate_json(blob)
    except Exception:  # noqa: BLE001 - 解析不出来就是不可用，调用方退回直连
        return None


async def rewrite_queries(
    topic: str,
    model_id: str = "",
    *,
    stream_fn=None,
    native_fn=None,
    via_delegate: bool = False,
) -> list[str]:
    """话题 → 几条换说法的检索式（[] 表示不可用，调用方退回只搜原话）。"""
    topic = (topic or "").strip()
    if not topic:
        return []
    from app.core.report import resolve

    resolved = await resolve(model_id)
    if resolved is None:
        return []
    info, model = resolved

    msgs = [
        {"role": "system", "content": _REWRITE_PROMPT},
        {"role": "user", "content": f"话题：{topic}"},
    ]
    from app.core.structured import extract_json

    obj = None
    if via_delegate:
        obj = _parse_plan(await _delegate_text(msgs, model_id), _RewritePlan)
    if obj is None:
        obj, meta = await extract_json(
            info, model, msgs, _RewritePlan, stream_fn=stream_fn, native_fn=native_fn
        )
        if obj is None:
            log.info("query rewrite unavailable: %s", meta.error)
            return []
    out: list[str] = []
    for q in obj.queries:
        s = re.sub(r"\s+", " ", str(q)).strip()[:100]
        if s and s.lower() != topic.lower() and s not in out:
            out.append(s)
        if len(out) >= REWRITE_MAX:
            break
    return out


_HYDE_PROMPT = """你在帮检索做 HyDE：先写一段**假设性的资料原文**，再拿它去撞真实材料。

给一个问题，写一段 120-200 字的假设答案。硬要求：
1. 用陈述句，写得像真资料里会出现的那一段（术语、专有名词、数字都可以写出来）；
2. **不要**写「我不知道」「根据资料」「可能」这类回避话——假设段落必须言之有物；
3. 不要复述问题，也不要提问；
4. 只输出这一段文字，不要标题、不要解释、不要代码块。"""


async def _complete(info, model: str, messages: list[dict], stream_fn=None) -> str:
    """一次自由文本补全（HyDE 要的是段落，不是 JSON）。`stream_fn` 是测试 mock seam。"""
    from app.core.llm import stream_chat

    _stream = stream_fn or stream_chat
    return "".join([c async for c in _stream(info, model, messages)]).strip()


async def hyde_passage(
    topic: str,
    model_id: str = "",
    *,
    stream_fn=None,
    native_fn=None,
    via_delegate: bool = False,
) -> str:
    """话题 → 一段假设性答案（HyDE）。"" 表示不可用，调用方退回原话检索。

    `native_fn` 只为与 `rewrite_queries` 保持同一组注入缝（调用方不必分两套传参）；
    这条路走的是自由文本，用不上原生结构化通道。`via_delegate` 见 `_delegate_text`。
    """
    del native_fn
    topic = (topic or "").strip()
    if not topic:
        return ""
    from app.core.report import resolve

    resolved = await resolve(model_id)
    if resolved is None:
        return ""
    info, model = resolved
    msgs = [
        {"role": "system", "content": _HYDE_PROMPT},
        {"role": "user", "content": f"问题：{topic}"},
    ]
    text = await _delegate_text(msgs, model_id) if via_delegate else ""
    if not text:
        text = await _complete(info, model, msgs, stream_fn=stream_fn)
    return re.sub(r"\s+", " ", text).strip()[:600]


_DECOMPOSE_PROMPT = """你在帮检索做「子问题分解」。把一个问题拆成 2-3 个**单跳**子问题：
每个子问题都能独立拿去检索，合起来覆盖原问题的全部信息需求。

只输出一个 JSON 对象，不要任何解释：

{"questions": ["子问题1", "子问题2"]}

硬要求：
1. 不要换话题；
2. 不要写「……是什么」这种把原话抄一遍的伪子问题；
3. 最多 3 条，宁少勿滥。"""


class _DecomposePlan(BaseModel):
    questions: list[str] = Field(default_factory=list)

    @field_validator("questions", mode="before")
    @classmethod
    def _as_list(cls, v):
        return _as_str_list(v)


async def decompose_questions(
    topic: str,
    model_id: str = "",
    *,
    stream_fn=None,
    native_fn=None,
    via_delegate: bool = False,
) -> list[str]:
    """话题 → 2-3 个单跳子问题（[] 表示不可用，调用方退回只搜原话）。"""
    topic = (topic or "").strip()
    if not topic:
        return []
    from app.core.report import resolve

    resolved = await resolve(model_id)
    if resolved is None:
        return []
    info, model = resolved

    msgs = [
        {"role": "system", "content": _DECOMPOSE_PROMPT},
        {"role": "user", "content": f"问题：{topic}"},
    ]
    from app.core.structured import extract_json

    obj = None
    if via_delegate:
        obj = _parse_plan(await _delegate_text(msgs, model_id), _DecomposePlan)
    if obj is None:
        obj, meta = await extract_json(
            info, model, msgs, _DecomposePlan, stream_fn=stream_fn, native_fn=native_fn
        )
        if obj is None:
            log.info("query decompose unavailable: %s", meta.error)
            return []
    out: list[str] = []
    for q in obj.questions:
        s = re.sub(r"\s+", " ", str(q)).strip()[:100]
        if s and s.lower() != topic.lower() and s not in out:
            out.append(s)
        if len(out) >= DECOMPOSE_MAX:
            break
    return out


async def deep_search(
    topic: str,
    top_k: int = 5,
    *,
    model_id: str = "",
    strategy: str = "rewrite",
    rewrite_fn=None,
    hyde_fn=None,
    decompose_fn=None,
    stream_fn=None,
    native_fn=None,
    via_delegate: bool = False,
) -> list[dict]:
    """引擎的「对照你自己的材料」：按策略取材料，合并去重、限块。

    策略池（P1c，三档并列，不是替代关系）：
      - `rewrite`（默认）：原话 + 几条**换说法**的检索式各搜一遍（现状，同层扩展）；
      - `hyde`：生成一段假设答案 → **段进向量路、原话进词法路**（形态不对称）；
      - `decompose`：拆 2-3 个**单跳**子问题 → 原话 + 子问题走既有 `search_multi`；
      - `auto`：用 `pick_strategy` 的确定性规则选一个。

    默认仍是 `rewrite`：新档要按「量出来的才上」的规矩先过金标，**默认值不抢跑**——
    那是 P1c 的验收结论，不是实现完成的副作用。

    任何一档**生成失败或没有模型**都退回只搜原话：这一层是为了提召回，不是为了
    挡住检索。代价是每次取材多一次便宜的模型调用。
    """
    topic = (topic or "").strip()
    if not topic:
        return []

    how = strategy if strategy in ("rewrite", "hyde", "decompose") else "rewrite"
    if strategy == "auto":
        how = pick_strategy(topic)

    # **只在真要走委托时才把这个 kwarg 递下去**：注入进来的生成函数（测试与尺子那两支）
    # 各自有自己的签名，不该因为多了一个默认关的开关就全得跟着改一遍。
    extra = {"via_delegate": True} if via_delegate else {}
    try:
        if how == "hyde":
            fn = hyde_fn or hyde_passage
            passage = (
                await fn(topic, model_id, stream_fn=stream_fn, native_fn=native_fn, **extra) or ""
            )
            if passage.strip():
                return await asyncio.to_thread(search_hyde, topic, passage, top_k)
            how = "rewrite"  # 生成不出来 → 退回改写，而不是空手而归
        if how == "decompose":
            fn = decompose_fn or decompose_questions
            subs = await fn(topic, model_id, stream_fn=stream_fn, native_fn=native_fn, **extra) or []
            queries = [topic, *(s for s in subs if s and s != topic)]
        else:
            fn = rewrite_fn or rewrite_queries
            variants = (
                await fn(topic, model_id, stream_fn=stream_fn, native_fn=native_fn, **extra) or []
            )
            queries = [topic, *(v for v in variants if v and v != topic)]
    except Exception:  # noqa: BLE001 - 生成挂了不该让检索也挂
        log.warning("query strategy %s failed", how, exc_info=True)
        queries = [topic]
    return await asyncio.to_thread(search_multi, queries, top_k)
