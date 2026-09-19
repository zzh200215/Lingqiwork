"""判分金标集的 drill：在真模型上跑一遍 `JUDGE_SYSTEM`，看它跟人差多远（PLAN2 P2-1）。

**要花钱**：36 条用例 = 36 次模型调用，一次跑完大概一分钟上下（看 provider）。所以先给一条
不花钱的路：`--dry` 只校验金标集本身（条数、字段、档位、id 唯一），一个字节都不发给模型。

逐条打印而不是只给一个总分：**错在哪几条、错成什么样**才是能动手的地方（高判还是低判、
是不是把「判不了」编成了档位）。最后给 `k/n` + Wilson 与「差一档内」的第二个数。

用法：
    python smoke_judge_eval.py            # 真模型跑一遍（默认模型），存进对照台
    python smoke_judge_eval.py --dry      # 只体检金标集，不调用
    python smoke_judge_eval.py --model X  # 指定模型（默认 = 设置里的默认模型）
    python smoke_judge_eval.py --no-save  # 跑但不落库（只看看）

退出码：0 = 跑完（分数好不好看见下面的明细）；1 = 校验不过 / 没跑成。
"""
import asyncio
import sys
from pathlib import Path

# 这台机器的控制台默认是 gbk：不显式设一次，一个 ✅ 就能让脚本死在最后一行
# （实测：跑完 36 条、钱花掉了，报告却在打印那一行 UnicodeEncodeError）。同 `run_tests_fast.py`。
for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")
    except Exception:  # noqa: BLE001
        pass

sys.path.insert(0, str(Path(__file__).parent))

from app.core import judge_eval  # noqa: E402

_LABEL = {0: "不判", 1: "重来", 2: "困难", 3: "良好", 4: "简单"}


def _print_case(c: dict) -> None:
    mark = "✓" if c["passed"] else ("~" if c["near"] else "✗")
    got = _LABEL.get(c["got"], str(c["got"]))
    exp = _LABEL.get(c["expect"], str(c["expect"]))
    tag = "（有争议，不计分）" if c["contested"] else ""
    print(f"  {mark} {c['id']:<22} 人工 {exp:<2} 它判 {got:<2} {c['seconds']:>4}s{tag}")
    for f in c["failed"]:
        print(f"      · {f['why']}")
    if c["error"]:
        print(f"      · 调用出错：{c['error']}")


async def main() -> int:
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    model_id = ""
    if "--model" in sys.argv:
        i = sys.argv.index("--model")
        model_id = sys.argv[i + 1] if len(sys.argv) > i + 1 else ""
        args = [a for a in args if a != model_id]

    cases = judge_eval.load_cases()
    problems = judge_eval.validate(cases)
    print("=" * 72)
    print(f"判分金标集 {judge_eval.KEY}：{len(cases)} 条  目标 {judge_eval.MIN_CASES}–{judge_eval.MAX_CASES} 条")
    print("=" * 72, flush=True)
    if problems:
        print("金标集不合格：")
        for p in problems:
            print(f"  · {p}")
        print("SMOKE FAIL ❌（先把它修好——坏用例会污染基线）")
        return 1
    print("体检通过：字段齐、档位合法、id 唯一\n", flush=True)

    if "--dry" in sys.argv:
        by_grade: dict[str, int] = {}
        for c in cases:
            by_grade[str(c["grade"])] = by_grade.get(str(c["grade"]), 0) + 1
        print("档位分布（人工）：", {f"{k}({_LABEL.get(int(k), '?')})": v for k, v in sorted(by_grade.items())})
        print("SMOKE PASS ✅（只体检，没有调用模型）")
        return 0

    print("跑着…（每条一次模型调用）", flush=True)
    try:
        report = await judge_eval.check(model_id=model_id, save="--no-save" not in sys.argv)
    except ValueError as e:
        print(f"跑不了：{e}")
        print("SMOKE FAIL ❌")
        return 1

    print()
    for c in report["cases"]:
        _print_case(c)

    lo, hi = report["ci"]
    nlo, nhi = report["near_ci"]
    print("\n" + "=" * 72)
    print(f"完全一致 {report['passed']}/{report['total']}  ({report['rate']:.0%})  95% Wilson {lo:.0%}–{hi:.0%}")
    print(f"差一档内 {report['near']}/{report['total']}  ({report['near_rate']:.0%})  95% Wilson {nlo:.0%}–{nhi:.0%}")
    print(f"高判 {report['over']} · 低判 {report['under']} · 未判（fallback） {report['fallback']}")
    if report["contested"]:
        print(f"有争议、不计分：{', '.join(c['id'] for c in report['contested'])}")
    print(f"矩阵（行=人工，列=它判 0–4）：")
    for exp, row in report["matrix"].items():
        print(f"  {_LABEL.get(int(exp), exp):<2} {[row[k] for k in ('0', '1', '2', '3', '4')]}")
    print(f"\n模型 {report['model_id'] or '(默认)'} · {report['calls']} 次调用 · {report['seconds']}s"
          f" · 提示词 {report['prompt_sha']}")
    if not report["tell"]:
        print("⚠️ 区间太宽，这个 n 下不了结论（先看差一档内那个数）")
    if report.get("run_id"):
        print(f"已存进对照台（run #{report['run_id']}）——校准曲线的页脚会读它")
    print("SMOKE PASS ✅（跑完了；分数好不好看，见上面的明细）")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
