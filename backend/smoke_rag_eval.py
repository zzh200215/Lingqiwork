"""检索金标基线：jsonl → EvalItem 同步 + 一条命令出 hit@k/MRR/延迟 + 索引指纹。

P0 的交付物（RAG升级.md §2）。尺子（evals.py + EvalItem/EvalRun + 回归对比）早就
造好了，这个脚本只做它缺的三件事：

  1. 把 `backend/evals/retrieval/golden.jsonl`（source of truth，进 git 可审）
     同步进 EvalItem——jsonl 管版本、DB 管运行；按 question upsert，
     评测页里手加的条目不动；
  2. 跑一次检索-only 评测（judge=False，零 LLM 成本），打印 hit@1/@3/@5、MRR、
     延迟，外加**索引指纹**（chunker 版本/块数/文件数/embed 模型/stale）——
     没有指纹，压块前后和历史曲线没法归因；
  3. `--rerank-pair` 再跑一遍 rerank 关闭的对照，**按金标配对数 per-query 胜负**
     ——P1b 的判据：配对比较，不是总分差（30-50 条金标上 1 条就是 2-3 个点，
     总分差落在噪声里）。

金标纪律：golden.jsonl 只许被评测读到；任何检索策略把它读进来当运行时数据
都算踩红线 #3（routing.PROTOTYPES 同款规矩）。

用法：
  backend/.venv/Scripts/python.exe smoke_rag_eval.py                 # 同步 + 基线
  backend/.venv/Scripts/python.exe smoke_rag_eval.py --rerank-pair  # 基线 + 重排 on/off 配对
  backend/.venv/Scripts/python.exe smoke_rag_eval.py --no-sync      # 只跑评测，不动金标

安全边界：只读 chroma 与 vault；写库仅限 EvalItem（同步）与 EvalRun（每次评测一行）。
"""
import asyncio
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
try:  # 中文与图标在 GBK 控制台上会炸
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:  # noqa: BLE001
    pass

from sqlalchemy import select  # noqa: E402

GOLDEN = Path(__file__).parent / "evals" / "retrieval" / "golden.jsonl"
TAGS = ("lexical", "paraphrase", "competing")  # 有期望源、算 hit@k/MRR 的那三类
# 负样本（P2 前置）：库里**没有**答案的问题。hit@k/MRR 量不了它们（没有期望源），
# 它们只服务一件事——给质量门的阈值做标定（见 smoke_quality_gate.py）。
NEGATIVE_TAG = "no_answer"
ALL_TAGS = (*TAGS, NEGATIVE_TAG)


def load_golden() -> list[dict]:
    """读金标。正样本必须有期望源、负样本**必须没有**——两边都当场卡死。"""
    items: list[dict] = []
    seen: set[str] = set()
    for i, line in enumerate(GOLDEN.read_text(encoding="utf-8").splitlines(), 1):
        line = line.strip()
        if not line:
            continue
        row = json.loads(line)
        if not str(row.get("query") or "").strip():
            raise ValueError(f"golden.jsonl 第 {i} 行缺 query")
        tag = row.get("tag")
        if tag not in ALL_TAGS:
            raise ValueError(f"golden.jsonl 第 {i} 行 tag 非法: {tag}")
        has_src = bool(str(row.get("expected_source") or "").strip())
        if tag == NEGATIVE_TAG and has_src:
            raise ValueError(f"golden.jsonl 第 {i} 行是负样本却写了 expected_source")
        if tag != NEGATIVE_TAG and not has_src:
            raise ValueError(f"golden.jsonl 第 {i} 行缺 expected_source")
        if row["query"] in seen:
            raise ValueError(f"golden.jsonl 第 {i} 行 query 重复")
        seen.add(row["query"])
        items.append(row)
    return items


def positives(items: list[dict]) -> list[dict]:
    """有期望源的那些——hit@k/MRR 只看它们。Pure。"""
    return [it for it in items if it["tag"] != NEGATIVE_TAG]


async def sync_golden(items: list[dict]) -> tuple[int, int]:
    """按 question upsert 进 EvalItem；tag 记在 note 里方便库里直读。

    **负样本不灌库**：`run_eval` 量的是 hit@k/MRR，负样本没有期望源、量不了它们；
    灌进去只会让 `eval_health` 多出一条「N 条没有期望源」的噪音警告。它们留在 jsonl 里
    服务一件事——给质量门的阈值做标定（`smoke_quality_gate.py` 直接读文件）。
    """
    from app.db import SessionLocal
    from app.models import EvalItem

    items = positives(items)
    added = updated = 0
    async with SessionLocal() as db:
        rows = (await db.execute(select(EvalItem))).scalars().all()
        by_q = {r.question: r for r in rows}
        for it in items:
            row = by_q.get(it["query"])
            if row is None:
                db.add(
                    EvalItem(
                        question=it["query"],
                        expected_source=it["expected_source"],
                        note=it["tag"],
                    )
                )
                added += 1
            elif row.expected_source != it["expected_source"] or (row.note or "") != it["tag"]:
                row.expected_source = it["expected_source"]
                row.note = it["tag"]
                updated += 1
        await db.commit()
    return added, updated


def fingerprint() -> dict:
    from app.core import indexer

    s = indexer.stats()
    return {
        "chunks": s.get("chunks"),
        "files": s.get("files"),
        "chunker": s.get("chunker"),
        "stale": s.get("stale"),
        "embed_model": s.get("embed_model"),
        "stale_embed": s.get("stale_embed"),
    }


def _set_cfg(cfg: dict) -> None:
    """进程内改检索开关，不碰 config.json——smoke_rerank 同款手法。
    各模块导入方式不一（有的顶层 from-import、有的函数内 import），
    逐个模块覆盖属性最稳。"""
    from app.core import evals as m_evals, indexer, prefs, retriever

    for m in (prefs, retriever, indexer, m_evals):
        if hasattr(m, "load_config"):
            m.load_config = lambda c=cfg: {**c}
    retriever.invalidate()


def injection_volume(tag_map: dict[str, str], top_k: int) -> tuple[int, int]:
    """每个金标问题按当前配置检索一次，数 top_k 条命中文本的总字符数。

    为什么单列这一个数：压块（P1a）在 PER_SOURCE_MAX/top_k 不动的前提下**会缩注入量**
    ——块小了，5 个名额装下的内容就少。recall 涨、注入量掉到没法回答，是另一种坏。
    这笔账不记，压块前后就只看得见一半。返回 (中位数, 均值)。

    跑在 run_eval 之后：同一批查询已在检索缓存里，这次复算几乎不花钱。
    """
    from app.core import indexer

    sizes = sorted(
        sum(len(h.get("text") or "") for h in indexer.search_auto(q, top_k))
        for q in tag_map
    )
    if not sizes:
        return 0, 0
    return sizes[len(sizes) // 2], round(sum(sizes) / len(sizes))


def _per_tag(ranks: dict[str, int | None], tag_map: dict[str, str]) -> None:
    buckets: dict[str, list[int | None]] = {}
    for q, r in ranks.items():
        buckets.setdefault(tag_map.get(q, "?"), []).append(r)
    for tag in TAGS:
        rs = buckets.get(tag) or []
        if not rs:
            continue
        n = len(rs)
        h1 = sum(1 for r in rs if r == 1) / n
        h3 = sum(1 for r in rs if r and r <= 3) / n
        mrr = sum(1 / r for r in rs if r) / n
        print(f"   [{tag:<10}] n={n:<3} hit@1={h1:.2f}  hit@3={h3:.2f}  MRR={mrr:.2f}")


async def run_once(tag_map: dict[str, str], label: str) -> tuple[dict, dict[str, int | None]]:
    from app.core import evals

    t0 = time.time()
    out = await evals.run_eval(judge=False)
    wall = round(time.time() - t0, 1)
    ranks = {d["question"]: d.get("rank") for d in out["detail"]}
    print(f"\n== {label}  (run#{out['id']}, {wall}s, top_k={out['top_k']})")
    print(f"   hit@1={out['hit1']}  hit@3={out['hit3']}  hit@5={out['hitk']}  MRR={out['mrr']}  eval耗时={out['seconds']}s")
    _per_tag(ranks, tag_map)
    med, avg = injection_volume(tag_map, out["top_k"])
    print(f"   注入总量：中位数 {med} 字符 / 均值 {avg} 字符（top_k 条命中文本之和）")
    return out, ranks


def pair_compare(on: dict[str, int | None], off: dict[str, int | None]) -> None:
    """P1b 的量法：同查询 on/off 各一次，数 per-query 胜负，不算总分差。"""
    win = loss = tie = 0
    lines: list[str] = []
    for q, r_on in on.items():
        r_off = off.get(q)
        if r_on == r_off:
            tie += 1
        elif r_on is None or (r_off is not None and r_on > r_off):
            loss += 1
            lines.append(f"    off 赢: {q[:34]}  (on={'miss' if r_on is None else f'@{r_on}'} / off={'miss' if r_off is None else f'@{r_off}'})")
        else:
            win += 1
            lines.append(f"    on  赢: {q[:34]}  (on=@{r_on} / off={'miss' if r_off is None else f'@{r_off}'})")
    print(f"\n== 配对胜负 rerank on vs off (n={len(on)}): on 赢 {win} / 平 {tie} / off 赢 {loss}")
    for ln in lines:
        print(ln)


async def main() -> int:
    args = sys.argv[1:]
    do_sync = "--no-sync" not in args
    do_pair = "--rerank-pair" in args
    force_hybrid = "--hybrid-on" in args
    force_rerank = "--rerank-on" in args

    fp = fingerprint()
    print("索引指纹:", json.dumps(fp, ensure_ascii=False))
    if fp["stale"]:
        print(f"!! 索引有 {fp['stale']} 条 stale（chunker 代次混杂）——先重建索引再跑，基线才算干净一代的")
        return 1
    if fp["stale_embed"]:
        print(
            f"!! 索引有 {fp['stale_embed']} 条是**别的模型或别的建向量做法** embed 的"
            "（戳 = 模型#方法版本）——混着比相似度没有意义，先重建"
        )
        return 1
    if not fp["chunks"]:
        print("!! 索引为空——先导入/重建索引")
        return 1

    items = load_golden()
    pos = positives(items)
    from app.core import indexer

    srcs = set(indexer.list_sources())
    ghosts = sorted({it["expected_source"] for it in pos} - srcs)
    if ghosts:
        print("!! 金标指向索引里不存在的源（先修 golden.jsonl 再跑）:")
        for g in ghosts:
            print("   ", g)
        return 1
    n_by_tag = {t: sum(1 for i in pos if i["tag"] == t) for t in TAGS}
    n_neg = len(items) - len(pos)
    print(
        f"金标 {len(items)} 条:",
        "  ".join(f"{t}={n_by_tag[t]}" for t in TAGS),
        f"  {NEGATIVE_TAG}={n_neg}（负样本不参与 hit@k/MRR，只给质量门标定）",
    )

    if do_sync:
        added, updated = await sync_golden(items)
        print(f"同步 EvalItem：新增 {added}、更新 {updated}")

    # 预热：embedder/reranker 首次加载的好几秒不算进评测延迟
    await asyncio.to_thread(indexer.search_auto, "预热查询", 3)

    tag_map = {it["query"]: it["tag"] for it in pos}
    from app.core.prefs import load_config, rerank_enabled as _rerank_on

    base_cfg = load_config()
    if force_hybrid:
        # 线上配置可能是 hybrid=False（纯向量）——重排只在 hybrid 路径里生效，
        # 要量重排就得把 hybrid 强制打开，否则配对全程是平局、白跑
        base_cfg = {**base_cfg, "hybrid_search": True}
    if force_rerank:
        # 同理：线上 rerank_enabled 可能是 False——配对要把 on 档强制出来才有对照意义
        base_cfg = {**base_cfg, "rerank_enabled": True}
    _set_cfg({**base_cfg})
    hybrid = bool(base_cfg.get("hybrid_search", True))
    rerank = _rerank_on(base_cfg)  # 显示用；默认值只在 prefs._DEFAULTS 里写一次
    # 预热跟当档配置走：hybrid off 时 reranker 根本不会加载，计时才是稳态
    await asyncio.to_thread(indexer.search_auto, "预热查询", 3)
    out_on, ranks_on = await run_once(tag_map, f"基线（hybrid={hybrid}, rerank={rerank}）")

    if do_pair:
        _set_cfg({**base_cfg, "rerank_enabled": False})
        try:
            await asyncio.to_thread(indexer.search_auto, "预热查询", 3)
            out_off, ranks_off = await run_once(tag_map, "对照（rerank=False）")
        finally:
            _set_cfg(base_cfg)
        pair_compare(ranks_on, ranks_off)
        print(f"延迟对比：rerank on {out_on['seconds']}s vs off {out_off['seconds']}s（检索部分，不含判分）")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
