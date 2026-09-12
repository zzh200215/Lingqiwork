"""Hybrid retrieval: BM25 (lexical) + vector (semantic), fused with RRF.

The BM25 corpus is rebuilt from ChromaDB documents whenever the index
changes (generation counter). Chinese/English tokenization via jieba.
Fusion uses Reciprocal Rank Fusion: score = sum(1 / (k + rank)), k=60.

外面还有三件：
- **按来源限块** `_diversify`：一次 top-6 里出现过 3 条来自同一个文件（实测），喂给引擎的
  「你的材料」就变成同一页的三份。限块之后广度优先，不够再原序回填，不会比原来更少。
- **结果缓存**：同一句查询不再重复付 BM25 + 向量 + cross-encoder 重排的钱。索引一变
  （`_cache_epoch`）整片失效。
- **多问几遍** `deep_search`：把话题改写成几种说法各搜一遍再合并。实测中→英改写一次能多
  带回 4-6 条原话撞不到的材料——材料是中英混杂的，而检索是拿一句话去撞的。
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


def hybrid_search(query: str, top_k: int = 5, candidate_k: int = 20) -> list[dict]:
    """Vector + BM25 fused with RRF (+ optional cross-encoder rerank), 限块 + 缓存。"""
    from app.core.prefs import load_config

    rerank_on = bool(load_config().get("rerank_enabled", True))
    # 缓存 key 要带上索引代次：索引一变（epoch +1），之前的结果整片作废
    key = ("hybrid", query, top_k, candidate_k, rerank_on, _cache_epoch)
    cached = _cache_get(key)
    if cached is not None:
        return cached

    # with a reranker we can afford a wider candidate pool before the cut
    pool = candidate_k if not rerank_on else max(candidate_k, top_k * 4)
    vec_hits = indexer.search(query, min(pool, max(top_k * 2, 10)))
    lex_hits = bm25_search(query, pool)

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
        out.append(hit)

    if not rerank_on:
        final = _diversify(out, top_k)
    else:
        from app.core import reranker

        # 重排本来就把候选全打一遍分，所以多要一些不额外花钱；限块会挤掉同源条目，
        # 得留够备选才能把 top_k 填满
        wide = reranker.rerank(query, out, max(top_k, min(len(out), top_k * 4)))
        final = _diversify(wide, top_k)
    _cache_put(key, final)
    return final


# ---------- 多问几遍 ----------


def search_multi(queries: list[str], top_k: int = 5) -> list[dict]:
    """多句查询各搜一遍，按 chunk 去重合并（同一条取最高分），再限块取前 top_k。

    「把这个话题多说几遍」是提召回最便宜的一招：同一个意思换种说法，撞到的 chunk 不一样。
    实测中→英改写一次能多带回 4-6 条原话撞不到的材料。只读索引。
    """
    merged: dict[str, dict] = {}
    for q in queries:
        q = str(q or "").strip()
        if not q:
            continue
        for h in indexer.search_auto(q, top_k):
            cid = _chunk_id_of(h) if h.get("source") is not None else str(h.get("id"))
            prev = merged.get(cid)
            if prev is None or (h.get("score") or 0.0) > (prev.get("score") or 0.0):
                merged[cid] = h
    ranked = sorted(merged.values(), key=lambda h: h.get("score") or 0.0, reverse=True)
    return _diversify(ranked, top_k)


_REWRITE_PROMPT = """你在帮检索「多问几遍」。给一个话题，写 3 条**换种说法**的检索式。
只输出一个 JSON 对象，不要任何解释：

{"queries": ["改写1", "改写2", "改写3"]}

硬要求：
1. 换说法，不是同义替换：换角度、换用词去问同一件事。
2. **至少一条用另一种语言**（中文话题给英文检索式，反之亦然）——材料里中英混杂，
   换一种语言往往能撞到原话撞不到的东西。
3. 不要重复原话；也不要写「研究一下」这种没有信息量的开头。"""


class _RewritePlan(BaseModel):
    queries: list[str] = Field(default_factory=list)

    @field_validator("queries", mode="before")
    @classmethod
    def _as_list(cls, v):
        if isinstance(v, str):
            return re.split(r"[\n；;]+", v) if v.strip() else []
        if isinstance(v, (list, tuple)):
            return [str(x).strip() for x in v if x is not None and str(x).strip()]
        return []


async def rewrite_queries(
    topic: str, model_id: str = "", *, stream_fn=None, native_fn=None
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

    from app.core.structured import extract_json

    obj, meta = await extract_json(
        info,
        model,
        [
            {"role": "system", "content": _REWRITE_PROMPT},
            {"role": "user", "content": f"话题：{topic}"},
        ],
        _RewritePlan,
        stream_fn=stream_fn,
        native_fn=native_fn,
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


async def deep_search(
    topic: str,
    top_k: int = 5,
    *,
    model_id: str = "",
    rewrite_fn=None,
    stream_fn=None,
    native_fn=None,
) -> list[dict]:
    """引擎的「对照你自己的材料」：原话 + 几条改写各搜一遍，合并去重、限块。

    改写**失败或没有模型**时退回只搜原话——这一层是为了提召回，不是为了挡住检索。
    代价是每次取材多一次便宜的模型调用。
    """
    topic = (topic or "").strip()
    if not topic:
        return []
    variants: list[str] = []
    try:
        fn = rewrite_fn or rewrite_queries
        variants = await fn(topic, model_id, stream_fn=stream_fn, native_fn=native_fn) or []
    except Exception:  # noqa: BLE001 - 改写挂了不该让检索也挂
        log.warning("query rewrite failed", exc_info=True)
    queries = [topic, *(v for v in variants if v and v != topic)]
    return await asyncio.to_thread(search_multi, queries, top_k)
