"""检索增强的度量（PLAN §10.2「检索」）：限块和改写到底有没有用。

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
import sys
import time
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
try:  # 中文与图标在 GBK 控制台上会炸
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:  # noqa: BLE001
    pass

from app.core import indexer, retriever  # noqa: E402

TOP_K = 6

# 写死的改写：不用模型也能量「多问几遍」值不值（真模型那条用 --live）
PROBES: list[tuple[str, list[str]]] = [
    ("RAG 检索增强", ["retrieval augmented generation 召回 提升", "RAG 召回率 优化"]),
    ("agent 的记忆怎么存", ["agent memory persistence design", "智能体 长期记忆 存储 方案"]),
    ("FastAPI 依赖注入", ["FastAPI dependency injection 依赖覆盖"]),
]


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
