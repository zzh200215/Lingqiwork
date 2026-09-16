"""模型画像的命令行（W7）：**每个在用模型都必须有一条基线**，这条命令把它摆出来。

    python -m app.model_check                      # 列出在用模型：画像、基线（分数/成本/延迟）、生不生效
    python -m app.model_check --set m --temperature 0.3 --max-rounds 6 --note "压循环"
    python -m app.model_check --bless m            # 把最近的 W1 跑分挂成基线（画像从此生效）
    python -m app.model_check --history m          # 改画像的前后对照

`--list` 是**只读**的：不建表、不迁移（§11 那次「只读命令碰了真库」的教训）。
"""
from __future__ import annotations

import argparse
import asyncio
import json
import sys


def _fmt_model(m: dict) -> str:
    b = m["baseline"]
    eff = m["effective"]
    if b:
        score = f"{b['pass']}/{b['total']}（{b['ci'][0]:.0%}–{b['ci'][1]:.0%}）" if b.get("ci") else f"{b['pass']}/{b['total']}"
        base = (
            f"基线 run#{b['run_id']} {score}"
            f" ｜ 延迟 {b['seconds']}s ｜ 每轮输出 {b['tokens_out_per_turn']} token"
            f" ｜ 判分 {b['judged']}"
        )
    else:
        base = "**没有基线**"
    where = "画像生效" if eff["source"] == "profile" else f"回落默认（{eff['why']}）"
    keys = []
    for k in ("temperature", "max_rounds", "tool_choice", "length_policy", "give_output_rule", "force_structure"):
        v = eff.get(k)
        if v not in (None, "", True) or k == "give_output_rule":
            keys.append(f"{k}={v}")
    return f"{m['model_id']}\n    {base}\n    {where} ｜ {' '.join(keys)}"


async def _main(args) -> int:
    from app.core import model_profiles

    if args.list:
        # **只读**：这里不调 `ensure_schema()`（那会建表/迁移 = 写库）
        out = await model_profiles.overview()
        if not out["models"]:
            print("没有在用的模型（provider 配置里一个都没启用）")
            return 0
        missing = [m["model_id"] for m in out["models"] if not m["has_baseline"]]
        for m in out["models"]:
            print(_fmt_model(m))
        print()
        print(f"在用模型 {len(out['models'])} 个 ｜ 有基线的 {len(out['models']) - len(missing)} 个")
        if missing:
            print(f"**没有基线的 {len(missing)} 个**（画像不生效）：{'、'.join(missing)}")
            print("挂基线：python -m app.eval_turns deliver_report --model <模型> 然后 --bless <模型>")
        return 0 if not missing else 1

    from app.core import bootstrap

    await bootstrap.ensure_schema()

    if args.set:
        fields = {}
        if args.temperature is not None:
            fields["temperature"] = args.temperature
        if args.max_rounds is not None:
            fields["max_rounds"] = args.max_rounds
        if args.tool_choice:
            fields["tool_choice"] = args.tool_choice
        if args.length_policy is not None:
            fields["length_policy"] = args.length_policy
        if args.output_rule is not None:
            fields["give_output_rule"] = args.output_rule
        if args.force_structure is not None:
            fields["force_structure"] = args.force_structure
        if args.supports_structure is not None:
            fields["supports_structure"] = args.supports_structure
        try:
            out = await model_profiles.save(args.set, fields, note=args.note)
        except model_profiles.ProfileError as e:
            print(f"没写成：{e}")
            return 2
        print(json.dumps(out, ensure_ascii=False, indent=2))
        if out.get("changed"):
            print("\n提醒：改了画像之后，基线是**旧的** —— 换策略要重跑一遍 W1 再挂一次。")
        return 0

    if args.bless:
        try:
            out = await model_profiles.bless(args.bless, args.run_id, note=args.note)
        except model_profiles.ProfileError as e:
            print(f"没挂上：{e}")
            return 2
        print(json.dumps(out, ensure_ascii=False, indent=2))
        return 0

    if args.history:
        rows = await model_profiles.history(args.history, args.limit)
        if not rows:
            print(f"{args.history} 还没有改动记录")
            return 0
        for r in rows:
            print(f"#{r['id']} {r['at']} 基线 run={r['baseline_run_id']} {r['note']}")
            for k, (old, new) in (r["changed"] or {}).items():
                print(f"    {k}: {old} → {new}")
        return 0

    print(__doc__)
    return 0


def main() -> int:
    p = argparse.ArgumentParser(description="模型画像与基线（W7）")
    p.add_argument("--list", action="store_true", help="列出在用模型的画像与基线（只读）")
    p.add_argument("--set", default="", help="给这个模型写一份画像（model_id）")
    p.add_argument("--bless", default="", help="把最近的 W1 跑分挂成这个模型的基线")
    p.add_argument("--history", default="", help="看这个模型的画像改动历史")
    p.add_argument("--run-id", type=int, default=None, help="指定哪一条 TurnEvalRun 当基线")
    p.add_argument("--temperature", type=float, default=None)
    p.add_argument("--max-rounds", type=int, default=None)
    p.add_argument("--tool-choice", default="")
    p.add_argument("--length-policy", default=None, choices=["", "revise", "truncate"])
    p.add_argument("--output-rule", default=None, type=lambda v: v.lower() not in ("0", "false", "no"))
    p.add_argument("--force-structure", default=None, type=lambda v: v.lower() not in ("0", "false", "no"))
    p.add_argument("--supports-structure", default=None, type=lambda v: v.lower() not in ("0", "false", "no"))
    p.add_argument("--note", default="", help="这次改动/挂基线的一句话说明")
    p.add_argument("--limit", type=int, default=20)
    return asyncio.run(_main(p.parse_args()))


if __name__ == "__main__":
    sys.exit(main())
