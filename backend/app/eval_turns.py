"""聊天回合行为评测的 CLI（W1）—— 一条命令给出「这次改动让行为变好还是变坏」。

    backend/.venv/Scripts/python.exe -m app.eval_turns --list
    backend/.venv/Scripts/python.exe -m app.eval_turns deliver_report --repeat 3
    backend/.venv/Scripts/python.exe -m app.eval_turns deliver_report --no-judge   # 只跑确定性判分

**它是要花钱的**：一条用例 = 一次完整的聊天回合（工具循环 1..N 次模型调用），
`--judge`（默认开）再加一次判分调用。跑之前先看清 `--list` 里的用例数。
预算上限：`--max-calls`（估个上界，超了就拒绝开跑，而不是跑到一半才发现花超了）。

报告里**必须**带样本量与 Wilson 区间：裸比例会让人把噪声当结论，这个项目已经吃过一次。
"""
import argparse
import asyncio
import sys

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:  # noqa: BLE001 - 老 Python 或被重定向时无所谓
    pass

# 一条用例平均几轮工具循环 + 一次判分。只是**上界估算**，用来拦「一不小心花太多」。
CALLS_PER_CASE = 4


async def _main(args) -> int:
    from app.core import bootstrap, turn_eval

    # 独立入口先保证库是能用的：建表 + 迁移。少了这一步，报出来的会是一句
    # 「messages 没有 artifacts_json」——而真正的原因只是库没初始化过（实测就是这么栽的）。
    await bootstrap.ensure_schema()

    if args.list:
        names = turn_eval.scenarios()
        if not names:
            print("没有回合用例（backend/evals/turns/*.json）")
            return 0
        for k in names:
            fx = turn_eval.load_scenario(k)
            print(f"{k}  {len(fx['cases'])} 条用例  sha {fx['sha']}")
            if fx["note"]:
                print(f"  {fx['note'][:160]}")
        return 0

    if not args.scenario:
        print("要给一个场景名（用 --list 看有哪些）")
        return 2

    fx = turn_eval.load_scenario(args.scenario)
    if not fx["cases"]:
        print(f"没有这套回合用例：{args.scenario}")
        return 2

    reps = max(1, int(args.repeat or 1))
    turns = len(fx["cases"]) * reps
    est = turns * CALLS_PER_CASE + (turns if not args.no_judge else 0)
    print(f"{fx['key']}：{len(fx['cases'])} 条用例 × {reps} 遍 = {turns} 个回合")
    print(f"上界估算：约 {est} 次模型调用（一条用例最多 {CALLS_PER_CASE} 轮 + 判分）")
    if est > args.max_calls:
        print(f"超过 --max-calls {args.max_calls}：不跑。要跑就把上限调高，或者少跑几遍。")
        return 3

    out = await turn_eval.run(
        args.scenario,
        model_id=args.model or "",
        judge=not args.no_judge,
        repeat=reps,
    )

    print()
    print(f"回合 {out['total']} 个 ｜ 一个 finding 都没有的 {out['passed']} 个")
    print(
        f"确定性判分 {out['passed']}/{out['total']} = {out['deterministic']:.0%}"
        f"   95% Wilson {out['ci_low']:.0%}–{out['ci_high']:.0%}"
    )
    if not out["can_tell"]:
        print("  区间太宽：这个样本量下**下不了结论**（要下结论得加用例或加 --repeat）")
    if out["judged"] is not None:
        print(f"回执一行话（LLM 判分）：{out['judged']}/5（n={out['judged_n']}）")
    print(f"耗时 {out['seconds']}s ｜ 模型 {out['model_id'] or '(没跑模型)'}")
    print(f"用例指纹 {out['scenario_sha']} ｜ 输出规矩指纹 {out['prompt_sha']}")

    bad = [r for r in out["detail"] if r["findings"] or r["error"]]
    if bad:
        print(f"\n没过的 {len(bad)} 个，逐条摆出来：")
        for r in bad:
            print(f"  ✗ {r['id']}  「{r['ask'][:40]}」")
            if r["error"]:
                print(f"      错误：{r['error'][:160]}")
            for f in r["findings"]:
                print(f"      {f['code']}：{f['detail'][:160]}")
            if r["reply"]:
                print(f"      它说的是：{r['reply'][:120]}")
    else:
        print("\n这批用例全过。")
    return 0 if not bad else 1


def main() -> int:
    p = argparse.ArgumentParser(description="聊天回合的行为评测（W1）")
    p.add_argument("scenario", nargs="?", default="", help="场景名（backend/evals/turns/*.json 的文件名）")
    p.add_argument("--list", action="store_true", help="列出有哪些场景")
    p.add_argument("--model", default="", help="模型 id（provider/model）；缺省用默认模型")
    p.add_argument("--repeat", type=int, default=1, help="整套重跑几遍（行为是随机的，n=1 说明不了什么）")
    p.add_argument("--no-judge", action="store_true", help="跳过 LLM 判分，只跑确定性判分（省钱）")
    p.add_argument("--max-calls", type=int, default=200, help="上界估算超过它就拒绝开跑")
    return asyncio.run(_main(p.parse_args()))


if __name__ == "__main__":
    sys.exit(main())
