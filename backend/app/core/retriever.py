"""Hybrid retrieval: BM25 (lexical) + vector (semantic), fused with RRF.

The BM25 corpus is rebuilt from ChromaDB documents whenever the index
changes (generation counter). Chinese/English tokenization via jieba.
Fusion uses Reciprocal Rank Fusion: score = sum(1 / (k + rank)), k=60.
"""
import logging
import threading

import jieba

from app.core import indexer

log = logging.getLogger(__name__)

_RRF_K = 60

_lock = threading.Lock()
_bm25 = None            # BM25Okapi | None when empty
_corpus_ids: list[str] = []  # chunk ids aligned with _bm25 corpus rows
_generation: int | None = None  # chroma count at build time


def tokenize(text: str) -> list[str]:
    return [t for t in jieba.lcut(text.lower()) if t.strip()]


def _build_corpus() -> tuple[list[str], list[dict]]:
    col = indexer.get_collection()
    data = col.get(include=["documents", "metadatas"])
    return data["documents"], data["metadatas"]


def _ensure_index() -> None:
    """Rebuild the BM25 index if the chroma collection changed."""
    global _bm25, _corpus_ids, _generation
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


def invalidate() -> None:
    """Force a rebuild on next search (call after indexing changes)."""
    global _generation
    with _lock:
        _generation = None


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


def hybrid_search(query: str, top_k: int = 5, candidate_k: int = 20) -> list[dict]:
    """Vector + BM25 fused with RRF (+ optional cross-encoder rerank)."""
    from app.core.prefs import load_config

    rerank_on = bool(load_config().get("rerank_enabled", True))
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
        return out[:top_k]

    from app.core import reranker

    return reranker.rerank(query, out, top_k)
