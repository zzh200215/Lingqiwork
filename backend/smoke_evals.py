"""评测回归冒烟：对比历史 + 健康度诊断（只读）+ 可选跑一次评测。

默认只读，不跑模型、不写库，直接回答两个问题：
  1. 这次评测比上次好了还是坏了？（--compare）
  2. 评测集本身还能不能测出回归？（--health）

用法：
    python smoke_evals.py                 # 健康度 + 最近一次对比（只读）
    python smoke_evals.py --compare 5     # 对比最近 5 次（只读）
    python smoke_evals.py --run           # 跑一次完整评测（写一条 EvalRun，有成本）

退出码：0 = 通过；1 = 健康度有警告（评测集太小/全满分，测不出回归）。
"""
import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from app.core import evals  # noqa: E402


def _fmt_delta(d: float) -> str:
    sign = "↑" if d > 0 else "↓"
    return f"{sign}{abs(d):.4f}"


def _print_compare(cmp: dict) -> None:
    runs = cmp.get("runs") or []
    print("=" * 60)
    print(f"最近 {len(runs)} 次评测运行")
    print("=" * 60)
    for r in runs:
        faith = f"{r['faithfulness']:.2f}" if r["faithfulness"] is not None else "—"
        print(
            f"  run#{r['id']}  {r['created_at'] or ''}  top_k={r['top_k']} rerank={int(r['rerank'] or 0)}"
            f"  hit@1={r['hit1']} hit@3={r['hit3']} mrr={r['mrr']} faith={faith}"
        )
    print()
    if cmp.get("comparison") is None:
        print(f"结论：{cmp['conclusion']}")
        return
    c = cmp["comparison"]
    deltas = c["deltas"]
    if deltas:
        for m, d in deltas.items():
            print(f"    {m:<13} {_fmt_delta(d)}  ({'变差' if d < 0 else '变好'})")
    print(f"结论：{cmp['conclusion']}")
    print()


def _print_health(h: dict) -> None:
    print("=" * 60)
    print(f"评测集健康度 · {h['total']} 条（{h['labelled']} 标注 + {h['unlabelled']} 未标注）")
    print("=" * 60)
    if h["warnings"]:
        for w in h["warnings"]:
            print(f"  ⚠ {w}")
    else:
        print("  ✓ 评测集健康：条数充足、有区分度，能测出回归")
    print()


async def main() -> int:
    args = sys.argv[1:]
    do_run = "--run" in args
    compare_n = 2
    if "--compare" in args:
        try:
            compare_n = int(args[args.index("--compare") + 1])
        except (IndexError, ValueError):
            compare_n = 2

    if do_run:
        print("跑一次完整评测（会写一条 EvalRun，需要可用 provider + 已建索引）…\n")
        try:
            result = await evals.run_eval()
            print(f"run#{result['id']}  hit@1={result['hit1']} mrr={result['mrr']} "
                  f"faithfulness={result['faithfulness']}  ({result['seconds']}s)")
        except ValueError as e:
            print(f"FAIL: {e}")
            return 1

    health = await evals.eval_health()
    _print_health(health)
    cmp = await evals.compare_history(limit=compare_n)
    _print_compare(cmp)

    ok = not health["warnings"]
    print("SMOKE PASS ✅" if ok else "SMOKE WARN ⚠（评测集尚不能有效测回归）")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
