"""检索增强（PLAN §10.2「检索」）的离线测试。

三件：按来源限块、结果缓存、多问几遍。都是纯逻辑或可注入的，不碰真索引（真效果由
`smoke_retrieval.py` 在真库上量）。**没做**：语义分块——改切法会让 1039 个 chunk 静默
过期，那是第 10.1 节第 2 条（索引与真相源的版本契约）该先解决的事。
"""
import asyncio

from app.core import indexer, retriever


def _hit(ref, chunk, score):
    return {
        "id": f"{ref}::{chunk}",
        "text": "t",
        "source": ref,
        "title": "T",
        "chunk": chunk,
        "score": score,
        "channels": ["vec"],
    }


# ---------- 按来源限块 ----------


def test_diversify_caps_chunks_from_one_source():
    """实测过：一次 top-6 里 3 条来自同一个文件。限块之后先广度。"""
    hits = [_hit("clippings/f.md", i, 0.9 - i / 100) for i in range(3)] + [
        _hit("notes/a.md", 0, 0.5),
        _hit("notes/b.md", 0, 0.4),
    ]
    out = retriever._diversify(hits, 4)
    assert [h["source"] for h in out] == [
        "clippings/f.md", "clippings/f.md", "notes/a.md", "notes/b.md",
    ]


def test_diversify_backfills_so_it_is_never_shorter():
    """被挤掉的按原序回填——限块只改顺序，不减少条数。"""
    hits = [_hit("only.md", i, 0.9 - i / 100) for i in range(4)]
    out = retriever._diversify(hits, 4)
    assert [h["chunk"] for h in out] == [0, 1, 2, 3]


def test_diversify_respects_top_k():
    hits = [_hit(f"n{i}.md", 0, 0.9) for i in range(6)]
    assert len(retriever._diversify(hits, 3)) == 3


# ---------- 多问几遍 ----------


def test_search_multi_merges_dedupes_and_keeps_the_best_score(monkeypatch):
    table = {
        "原话": [_hit("a.md", 0, 0.6), _hit("b.md", 0, 0.5)],
        "改写": [_hit("a.md", 0, 0.9), _hit("c.md", 0, 0.7)],  # a.md 同一条，分更高
    }
    monkeypatch.setattr(
        indexer, "search_auto", lambda q, top_k=5, hybrid=None: list(table.get(q, []))
    )
    out = retriever.search_multi(["原话", "改写"], 5)
    by_ref = {h["source"]: h["score"] for h in out}
    assert set(by_ref) == {"a.md", "b.md", "c.md"}  # 按 chunk 去重后三条
    assert by_ref["a.md"] == 0.9  # 同一条取最高分
    assert [h["source"] for h in out] == ["a.md", "c.md", "b.md"]


def test_search_multi_skips_blank_queries(monkeypatch):
    seen: list[str] = []
    monkeypatch.setattr(
        indexer, "search_auto", lambda q, top_k=5, hybrid=None: seen.append(q) or []
    )
    retriever.search_multi(["", "   ", "真的"], 3)
    assert seen == ["真的"]


# ---------- deep_search ----------


def test_deep_search_searches_the_topic_and_every_rewrite(monkeypatch):
    seen: list[str] = []
    monkeypatch.setattr(
        indexer, "search_auto", lambda q, top_k=5, hybrid=None: seen.append(q) or []
    )

    async def rewrite(topic, model_id="", *, stream_fn=None, native_fn=None):
        return ["p1", "p2"]

    asyncio.run(retriever.deep_search("原话", 3, rewrite_fn=rewrite))
    assert seen == ["原话", "p1", "p2"]


def test_deep_search_falls_back_to_the_topic_when_rewrite_fails(monkeypatch):
    """改写挂了不该让检索也挂——这一层是为了提召回，不是为了挡住检索。"""
    seen: list[str] = []
    monkeypatch.setattr(
        indexer, "search_auto", lambda q, top_k=5, hybrid=None: seen.append(q) or []
    )

    async def boom(*_a, **_k):
        raise RuntimeError("挂了")

    asyncio.run(retriever.deep_search("原话", 3, rewrite_fn=boom))
    assert seen == ["原话"]


def test_deep_search_ignores_a_rewrite_that_repeats_the_topic(monkeypatch):
    seen: list[str] = []
    monkeypatch.setattr(
        indexer, "search_auto", lambda q, top_k=5, hybrid=None: seen.append(q) or []
    )

    async def rewrite(topic, model_id="", *, stream_fn=None, native_fn=None):
        return ["原话", "另一个"]

    asyncio.run(retriever.deep_search("原话", 3, rewrite_fn=rewrite))
    assert seen == ["原话", "另一个"]  # 原话不因为被改写重复而搜两遍


def test_deep_search_blank_topic_is_empty():
    assert asyncio.run(retriever.deep_search("   ", 3)) == []


# ---------- 结果缓存 ----------


def _stub_hybrid(monkeypatch, counter):
    """把 hybrid_search 的外部依赖全换成假的，只留下缓存与限块这两层要测的逻辑。"""
    monkeypatch.setattr(retriever, "_ensure_index", lambda: None)
    monkeypatch.setattr(retriever, "bm25_search", lambda q, k: [])

    def fake_search(q, top_k=5):
        counter["n"] += 1
        return [_hit("a.md", 0, 0.5)]

    monkeypatch.setattr(indexer, "search", fake_search)

    from app.core import reranker

    monkeypatch.setattr(
        reranker, "rerank", lambda q, hits, top_k=None: hits[:top_k] if top_k else hits
    )


def test_hybrid_search_hits_the_cache_for_a_repeated_query(monkeypatch):
    counter = {"n": 0}
    _stub_hybrid(monkeypatch, counter)
    retriever.invalidate()
    a = retriever.hybrid_search("同一句", 3)
    b = retriever.hybrid_search("同一句", 3)
    assert counter["n"] == 1  # 第二次没有再打检索
    assert a == b


def test_invalidate_drops_the_cache(monkeypatch):
    counter = {"n": 0}
    _stub_hybrid(monkeypatch, counter)
    retriever.invalidate()
    retriever.hybrid_search("同一句", 3)
    retriever.invalidate()
    retriever.hybrid_search("同一句", 3)
    assert counter["n"] == 2


def test_cache_hands_out_copies_so_callers_cannot_poison_it(monkeypatch):
    counter = {"n": 0}
    _stub_hybrid(monkeypatch, counter)
    retriever.invalidate()
    first = retriever.hybrid_search("同一句", 3)
    first[0]["score"] = 999
    first[0]["channels"].append("污染")
    again = retriever.hybrid_search("同一句", 3)
    assert again[0]["score"] != 999
    assert "污染" not in again[0]["channels"]
