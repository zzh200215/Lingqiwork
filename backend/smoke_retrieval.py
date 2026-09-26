"""检索增强的度量：限块和改写到底有没有用。

**只读**——不改索引、不写 vault、默认不花钱（改写用写死的几句；`--live` 才调真模型）。
量三件事：

1. **广度**：一次 top-k 覆盖了几个不同来源（限块前，一个文档能霸占一半名额）。
2. **改写提召回**：原话拿到的条数 vs 加上几句换说法之后的并集条数。
3. **缓存**：同一句查两遍，第二遍快了多少。

跑法：
  backend/.venv/Scripts/python.exe smoke_retrieval.py
  backend/.venv/Scripts/python.exe smoke_retrieval.py --live   # 用真模型改写
"""
import asyncio
import math
import sys
import time
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
try:  # 中文与图标在 GBK 控制台上会炸
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:  # noqa: BLE001
    pass

from app.core import embedder, indexer, retriever  # noqa: E402

TOP_K = 6

# 写死的改写：不用模型也能量「多问几遍」值不值（真模型那条用 --live）
PROBES: list[tuple[str, list[str]]] = [
    ("RAG 检索增强", ["retrieval augmented generation 召回 提升", "RAG 召回率 优化"]),
    ("agent 的记忆怎么存", ["agent memory persistence design", "智能体 长期记忆 存储 方案"]),
    ("FastAPI 依赖注入", ["FastAPI dependency injection 依赖覆盖"]),
]


def _pct(xs: list[int], p: float) -> float:
    if not xs:
        return 0.0
    k = (len(xs) - 1) * p
    f, c = math.floor(k), math.ceil(k)
    return xs[f] if f == c else xs[f] * (c - k) + xs[c] * (k - f)


def _window_budget() -> int:
    """模型真正的输入窗口（token）。切法是字符数，窗口是 token 数——两者不能混着说。"""
    return int(embedder._get_model().max_seq_length)


def chunk_token_profile(budget: int = 500) -> dict:
    """全库块的 token 长度分布 + 「99 分位 ≤ budget token」的字符阈值。

    这是 P1a 的尺子（RAG升级.md §2 P1a）：CHUNK_SIZE 是**字符**数，而 bge-small-zh-v1.5
    的窗口是 512 **token**——超过窗口 sentence-transformers 不报错、只静默截断，块尾部
    根本没进向量。换算系数只能实测（中英混排实测约 0.53 token/字符，不是估的 1.3）。

    注意 `SentenceTransformer.tokenize` 已废弃且返回无意义的值，这里直接用底层的
    HF tokenizer——同一个分词器，不截断地数真实长度。

    `char_budget` 是在**现有块**上算的条件阈值（chars ≤ C 的子集 token p99 ≤ budget 的
    最大 C）。它只是候选值：真定参数要把语料按候选重切一遍再量（_tmp 探针干的那件事）。
    """
    from app.core import indexer

    col = indexer.get_collection()
    docs = col.get(include=["documents"])["documents"] if col.count() else []
    if not docs:
        return {"chunks": 0}
    tk = embedder._get_model().tokenizer
    toks = [len(tk(d, truncation=False, add_special_tokens=True)["input_ids"]) for d in docs]
    chars = [len(d) for d in docs]
    pairs = sorted(zip(chars, toks))
    win = _window_budget()
    char_budget = 0
    for c, _ in pairs:
        if _pct(sorted(t for cc, t in pairs if cc <= c), 0.99) <= budget:
            char_budget = c
    # 超窗块在**当前做法**下要切成几个窗口——这是「尾部有没有被覆盖」的直接答案
    over = [i for i, t in enumerate(toks) if t > win]
    windows = sum(len(embedder._window_texts(tk, docs[i], win)) for i in over)
    return {
        "chunks": len(docs),
        "window": win,
        "p50": round(_pct(sorted(toks), 0.5)),
        "p90": round(_pct(sorted(toks), 0.9)),
        "p99": round(_pct(sorted(toks), 0.99)),
        "max": max(toks),
        "over": len(over),
        "windows": windows,
        "ratio": round(sum(toks) / sum(chars), 3),
        "char_budget": char_budget,
        "embed_tag": embedder.VECTOR_TAG,
        "stale_embed": indexer.stats().get("stale_embed", 0),
    }


def _spread(hits: list[dict]) -> tuple[int, str]:
    """(覆盖了几个不同来源, 霸榜的那个来源)"""
    c = Counter(str(h.get("source") or "") for h in hits)
    if not c:
        return 0, ""
    top, n = c.most_common(1)[0]
    return len(c), f"{top}（{n} 条）"


async def rewrites(topic: str, fixed: list[str], live: bool) -> list[str]:
    if not live:
        return fixed
    out = await retriever.rewrite_queries(topic)
    if not out:
        print("  ⚠ 改写没跑成（没有可用模型？）——退回写死的几句")
        return fixed
    return out


async def main() -> int:
    live = "--live" in sys.argv
    print("=" * 64)
    print(f"检索度量（top_k={TOP_K}，改写={'真模型' if live else '写死'}）")
    print("=" * 64)

    # P1a 的尺子：块 token 分布。压块前后差别最大的就是这一行。
    p = chunk_token_profile()
    if p.get("chunks"):
        over_pct = 100 * p["over"] / p["chunks"]
        print(
            f"\n·· 块 token 分布（切法是字符，窗口是 token）"
            f"\n   chunker={indexer.CHUNKER_VERSION} · CHUNK_SIZE={indexer.CHUNK_SIZE} "
            f"· {p['chunks']} 块 · 模型窗口 {p['window']} token"
            f"\n   token: p50={p['p50']} p90={p['p90']} p99={p['p99']} max={p['max']}"
            f" · 超窗 {p['over']} 块（{over_pct:.1f}%）"
            f"\n   向量法 = {p['embed_tag']}"
            f"\n   → 超窗块按窗口池化嵌入（{p['over']} 块 → {p['windows']} 个窗口），**尾部不丢**；"
            f"块文本不变，BM25 与注入量不受影响"
            f"\n   token/字符 = {p['ratio']}（实测换算，别拿 1.3 估）"
            f"\n   → 「99 分位 ≤ 500 token」的字符阈值 ≈ {p['char_budget']}"
            + (f"\n   !! 有 {p['stale_embed']} 块是别的模型/做法 embed 的——重建后这行数字才作数"
               if p.get("stale_embed") else "")
        )
    else:
        print("\n·· 块 token 分布：索引为空")

    for topic, fixed in PROBES:
        paras = await rewrites(topic, fixed, live)

        base = indexer.search_auto(topic, TOP_K)          # 已含限块
        merged = retriever.search_multi([topic, *paras], TOP_K)

        bs, btop = _spread(base)
        ms, mtop = _spread(merged)
        print(f"\n·· {topic}")
        print(f"   原话：{len(base):2d} 条 · 覆盖 {bs} 个来源 · 最多的一家 {btop or '—'}")
        print(f"      改写：{' / '.join(paras) or '（没有）'}")
        print(f"   并集：{len(merged):2d} 条 · 覆盖 {ms} 个来源 · 最多的一家 {mtop or '—'}")

    # 缓存：同一句查两遍
    print("\n·· 缓存")
    retriever.invalidate()
    q = PROBES[0][0]
    t0 = time.perf_counter()
    retriever.hybrid_search(q, TOP_K)
    cold = time.perf_counter() - t0
    t0 = time.perf_counter()
    retriever.hybrid_search(q, TOP_K)
    warm = time.perf_counter() - t0
    print(f"   第一次 {cold * 1000:.0f}ms → 第二次 {warm * 1000:.0f}ms"
          f"（省 {(1 - warm / cold) * 100:.0f}%）" if cold > 0 else "   （索引是空的）")

    print("\nSMOKE PASS ✅（只是度量，不判对错）")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
