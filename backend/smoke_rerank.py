"""rerank 对「讲解取材」质量的实测（取材的遗留问题），可重复跑。

问题：取材每轮无脑注入检索 top-3，无关话题拿到的也是「最不相关的三个」。已实测
余弦底线不可行（相关对最低 0.407 < 无关对最高 0.636），记下的杠杆是
`rerank_enabled`（bge-reranker-base 交叉编码器，本地已缓存）。但「杠杆」本身
从没被验证过 —— 这个脚本量三件事：

  1. 命中率：相关改写查询的 target chunk，在三种模式下各自排第几
       A 现网默认（hybrid off, rerank off = 纯向量）
       B hybrid on, rerank off（RRF 融合）
       C hybrid on, rerank on（交叉编码器重排）
  2. 分数可分性：C 模式下相关查询与无关查询的 top1 rerank 分数是否有窗口
     —— 有的话，取材注入就可以按 rerank 分数设底线，top-3 噪声问题才算真修掉
  3. 建议：给一句话结论（开 / 不开 + 是否有窗口）

安全边界：只读。只查询真实 chroma，不写、不改 config.json（模式切换在进程内
monkeypatch `load_config`）。embedder / reranker 模型全部用本地缓存。
"""
import sys
from pathlib import Path

sys.path.insert(0, ".")
try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:  # noqa: BLE001
    pass

# (改写后的查询, target 文件名里必须含的关键片段) —— 查询是用户重逢时会打的问法
RELATED: list[tuple[str, str]] = [
    ("为什么值得用 fastapi 来写接口", "fastapi"),
    ("大文件下载速度上不去该怎么分段", "chunked_parallel_download"),
    ("让程序借用我已经登录好的浏览器去发一条评论", "chapter15"),
    ("工具拿不到数据的时候应该怎么降级", "fallbacks"),
    ("跑自动化任务前要准备哪些输入字段", "task-input"),
    ("这个项目装了哪些开发依赖", "package.json"),
]

# 与库内容无关（前 6 条完全无关，后 6 条同领域不同主题 —— 难的那一半）
UNRELATED: list[str] = [
    "这周的时间该怎么安排",
    "怎么做一顿好吃的红烧肉",
    "唐诗里的意象怎么读",
    "去东京旅游七天怎么规划",
    "吉他入门先学什么",
    "股市大盘今天怎么样",
    "Rust 的所有权和借用检查",
    "Vue 的响应式是怎么追踪依赖的",
    "Docker 镜像分层怎么复用缓存",
    "MySQL 加了索引为什么查询没变快",
    "Python 多线程为什么跑不满 CPU",
    "React 的 useEffect 是怎么工作的",
]

MODES = [
    ("A 现网默认", {"hybrid_search": False, "rerank_enabled": False}),
    ("B hybrid", {"hybrid_search": True, "rerank_enabled": False}),
    ("C hybrid+rerank", {"hybrid_search": True, "rerank_enabled": True}),
]

FAIL: list[str] = []


def ok(label: str, detail: str = "") -> None:
    print(f"  ok   {label}" + (f" — {detail}" if detail else ""))


def bad(label: str, detail: str = "") -> None:
    FAIL.append(label)
    print(f"  FAIL {label}" + (f" — {detail}" if detail else ""))


def set_mode(cfg: dict) -> None:
    from app.core import indexer, prefs, reranker, retriever

    prefs.load_config = lambda: {**cfg}
    # reranker.rerank 每次都读 config 决定走不走；retriever 也是
    retriever.invalidate()


def run_search(query: str, top_k: int) -> list[dict]:
    from app.core import indexer

    return indexer.search_auto(query, top_k)


def main() -> int:
    from app.core import indexer

    col = indexer.get_collection()
    data = col.get(include=["documents", "metadatas"])
    docs, metas = data["documents"], data["metadatas"]
    first_chunk: dict[str, str] = {}
    for d, m in zip(docs, metas):
        s = str(m.get("source") or "")
        if s and s not in first_chunk and len(d) > 120:
            first_chunk[s] = d

    print(f"KB: {len(docs)} chunks / {len(first_chunk)} 文件\n")

    # 每个模式：相关查询的 target 排名 + 两类查询的 top1 分数
    report: dict[str, dict] = {}
    for name, cfg in MODES:
        set_mode(cfg)
        ranks: list[int | None] = []
        for q, frag in RELATED:
            hits = run_search(q, 10)
            rank = next(
                (i + 1 for i, h in enumerate(hits) if frag in str(h.get("source") or "")),
                None,
            )
            ranks.append(rank)
        rel_top1 = [run_search(q, 3)[0]["score"] for q, _ in RELATED]
        unr_top1 = [run_search(q, 3)[0]["score"] for q in UNRELATED]
        hit3 = sum(1 for r in ranks if r is not None and r <= 3)
        report[name] = {"ranks": ranks, "rel": rel_top1, "unr": unr_top1, "hit3": hit3}
        print(
            f"== {name}: hit@3 = {hit3}/{len(RELATED)}  "
            f"相关 top1 中位 {sorted(rel_top1)[len(rel_top1)//2]:.3f}  "
            f"无关 top1 最高 {max(unr_top1):.3f}"
        )
        print(f"   target 排名: {ranks}")

    # ---- 判定 ----
    print("\n== 结论")
    a, c = report["A 现网默认"], report["C hybrid+rerank"]
    if c["hit3"] > a["hit3"]:
        ok("rerank 提升命中率", f"hit@3 {a['hit3']} → {c['hit3']}")
    elif c["hit3"] == a["hit3"]:
        print(f"  ·    rerank 没有提升 hit@3（持平 {c['hit3']}）—— 精度收益要看分数可分性")
    else:
        bad("rerank 降低了命中率", f"hit@3 {a['hit3']} → {c['hit3']}")

    lo, hi = max(c["unr"]), min(c["rel"])
    if lo < hi:
        ok("rerank 分数把相关的和无关的分开了", f"窗口 [{lo:.3f}, {hi:.3f}]")
        mid = round((lo + hi) / 2, 2)
        print(f"  →    取材可以按 rerank 分数设底线 ≈ {mid}，top-3 噪声问题能真修掉")
    else:
        # 两种结果都是有效发现，不是失败：2026-09-06 实测本机 KB 无窗口
        # （无关最高 0.709 > 相关最低 0.551），交叉编码器也分不开 —— 底线这条路
        # 连 rerank 都救不回来，取材只能继续靠提示词兜底。
        print(f"  ·    rerank 分数没有可分窗口（无关最高 {lo:.3f} ≥ 相关最低 {hi:.3f}）")
        print("  →    按分数过滤不可行，取材继续靠提示词兜底；rerank 只改善排序")

    print(f"\n临时结论只对本机这份 KB（{len(first_chunk)} 文件）负责，样本见脚本顶部。")
    if FAIL:
        print(f"RERANK EVAL FAIL — {FAIL}")
        return 1
    print("RERANK EVAL PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
