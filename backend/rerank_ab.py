"""rerank on/off 对照评测（方向 5 前置）：同一评估集、同一 top_k，只动重排开关。

**为什么是脚本**：设置页开关 + 评估页连跑两次也能做这件事，但人肉两次之间容易
顺手改了别的配置，历史 run 行也对不上号。这里把「关→跑→开→跑→还原」封成一步，
两次 run 行落库（`rerank` 快照列区分），控制台直接给出对比与逐题排序变化。

跑法（backend 目录下）：

    .venv/Scripts/python.exe rerank_ab.py               # 检索指标对照（不调 LLM，免费）
    .venv/Scripts/python.exe rerank_ab.py --judge       # 附带忠实度判分（走已配置模型，花钱）
    .venv/Scripts/python.exe rerank_ab.py --top-k 10    # 覆盖 rag_top_k
    .venv/Scripts/python.exe rerank_ab.py --json        # 机读输出

- 评估集就是评估页那份 `eval_items`（金标 `evals/retrieval/golden.jsonl` 的在库子集，
  2026-09-30 核对：34/34 全部能在金标文件里对上）。集合为空会直接报错退出。
- 重排模型加载失败**不会**静默出一份「没差别」的假对照：开跑前先用一条合成样本
  预热并验证 rerank 通道真的生效，失败即退出码 1。
- 注意：脚本直连同一份 SQLite 与 prefs 文件。服务正在跑时别同时开评估页/改设置——
  单人本地工具，不做跨进程锁。
- 两次 run 都写入 `eval_runs` 历史（评估页可查）；本脚本不改任何评估集数据。
"""
import argparse
import asyncio
import sys


async def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="rerank on/off 检索对照评测")
    parser.add_argument("--top-k", type=int, default=None, help="覆盖 rag_top_k（默认取设置）")
    parser.add_argument("--judge", action="store_true", help="附带 LLM 忠实度判分（默认只测检索）")
    parser.add_argument("--json", action="store_true", help="机读输出")
    args = parser.parse_args(argv)

    from app.core import reranker
    from app.core.evals import run_eval
    from app.core.prefs import load_config, rerank_enabled, save_config

    original = rerank_enabled(load_config())
    if original:
        print(f"[配置] rerank 当前已是开（{original!r}），对照仍按 关→开 顺序跑，结束时还原为开")

    # 预热 + 生效验证：rerank() 失败时会静默退回原序（reranker.py 的设计约定），
    # 那种失败在这里不能被吞——否则 B 组就是一份「没差别」的假数字。
    print("[预热] 加载 bge-reranker-base（CPU，冷启动约 6s）…", flush=True)
    probe = reranker.rerank("知识库检索重排", [{"text": "知识库检索重排的合成探针文本", "score": 0.0}], top_k=1)
    if not probe or "rerank" not in probe[0].get("channels", []):
        print("错误：rerank 通道未生效（模型加载或推理失败），对照中止。", file=sys.stderr)
        return 1
    print("[预热] 完成，rerank 通道生效。")

    async def one(rerank_on: bool) -> dict:
        save_config({"rerank_enabled": rerank_on})
        label = "A（关）" if not rerank_on else "B（开）"
        print(f"[跑] rerank {label}，top_k={args.top_k or '默认'}，judge={args.judge} …", flush=True)
        return await run_eval(top_k=args.top_k, judge=args.judge)

    try:
        a = await one(False)
        b = await one(True)
    finally:
        save_config({"rerank_enabled": original})
        print(f"[还原] rerank_enabled → {original}")

    rows = [
        ("hit@1", a["hit1"], b["hit1"]),
        ("hit@3", a["hit3"], b["hit3"]),
        ("hit@k", a["hitk"], b["hitk"]),
        ("MRR", a["mrr"], b["mrr"]),
        ("faithfulness", a["faithfulness"], b["faithfulness"]),
        ("耗时(s)", a["seconds"], b["seconds"]),
    ]
    detail = {
        "run_ids": [a["id"], b["id"]],
        "rerank_restored_to": original,
        "agg": {"A_off": {k: a[k] for k in ("hit1", "hit3", "hitk", "mrr", "faithfulness", "seconds")},
                "B_on": {k: b[k] for k in ("hit1", "hit3", "hitk", "mrr", "faithfulness", "seconds")}},
        "per_case": _rank_diff(a, b),
    }
    if args.json:
        import json

        print(json.dumps(detail, ensure_ascii=False, indent=2))
        return 0

    print()
    print(f"评估集 {a['total']} 题 · top_k={a['top_k']} · run#{a['id']}(关) vs run#{b['id']}(开)")
    print()
    print(f"  {'指标':<14}{'关':>10}{'开':>10}{'Δ':>10}")
    for name, va, vb in rows:
        if va is None and vb is None:
            continue
        if isinstance(va, (int, float)) and isinstance(vb, (int, float)):
            delta = f"{vb - va:+.{4 if abs(vb) < 10 else 1}f}"
            print(f"  {name:<14}{va!s:>10}{vb!s:>10}{delta:>10}")
        else:
            print(f"  {name:<14}{va!s:>10}{vb!s:>10}{'—':>10}")
    diffs = detail["per_case"]
    print()
    print(f"逐题排序变化：{len(diffs)} 题有变化（+变好 / -变差）")
    for d in diffs:
        mark = "+" if d["delta"] > 0 else "-"
        ra = "未中" if d["rank_a"] is None else d["rank_a"]
        rb = "未中" if d["rank_b"] is None else d["rank_b"]
        print(f"  {mark} #{ra}→#{rb}  {d['question'][:46]}")
    if not diffs:
        print("  （无一题排序变化）")
    print()
    print("结论口径：hit@1 / MRR 是排序质量，faithfulness 只在 --judge 时有值；耗时差是 CPU 重排的延迟成本。")
    print("两组 run 已落库（评估页历史可查），开关已还原。是否常开 rerank，拿这组数字定。")
    return 0


def _rank_diff(a: dict, b: dict) -> list[dict]:
    """逐题对比两次 run 的命中排名；rank 为 None（没命中）记 999，只报有变化的题。"""
    by_q_a = {r["question"]: r.get("rank") for r in a["detail"]}
    out = []
    for r in b["detail"]:
        qa = by_q_a.get(r["question"])
        qb = r.get("rank")
        if qa == qb:
            continue
        out.append({
            "question": r["question"],
            "rank_a": qa,
            "rank_b": qb,
            "delta": (_rank_num(qb) - _rank_num(qa)) * -1,  # 排名靠前 = 变好 = 正数
        })
    out.sort(key=lambda d: d["delta"], reverse=True)
    return out


def _rank_num(rank: int | None) -> int:
    return rank if rank else 999


if __name__ == "__main__":
    sys.exit(asyncio.run(main(sys.argv[1:])))
