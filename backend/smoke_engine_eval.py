"""质量标尺 drill：在真模型上跑一遍四个引擎的 golden set。

**按引擎逐个跑并即时打印**——一次跑完四个要十分把钟，中间看不到任何东西，出了问题
也不知道卡在哪一个。每个引擎内部是用例并发的（`core/engine_eval.py`）。

打印每个引擎的**结构判分**（确定性、不花钱）与**接地判分**（LLM 0-5），以及每条
用例的具体 findings 与理由——findings 才是能动手的地方。

用法：
    python smoke_engine_eval.py                    # 四个引擎全跑
    python smoke_engine_eval.py recap              # 只跑一个
    python smoke_engine_eval.py decide --no-judge  # 只跑结构判分（不花模型钱）

退出码：0 = 至少跑出一个引擎的结果；1 = 一个都没跑成。
"""
import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from app.core import engine_eval  # noqa: E402

_ICON = {"research": "🔍", "compose": "📝", "recap": "📋", "decide": "🤔"}


def _print_run(run: dict) -> None:
    icon = _ICON.get(run["engine"], "📦")
    struct = f"{run['structural'] * 100:.0f}%"
    grounded = f"{run['grounded']:.2f}/5" if run["grounded"] is not None else "—"
    print(
        f"\n{icon} {run['engine']}  结构 {struct}  接地 {grounded}  "
        f"({run['total']} 条，{run['seconds']}s，提示词 {run['prompt_sha']})"
    )
    for d in run["detail"]:
        clean = not d["findings"] and not d["frame_findings"] and not d["error"]
        score = f"{d['score']}/5" if d["score"] is not None else "—"
        print(f"    {'✓' if clean else '✗'} {d['id']:<26} 接地 {score}  {d['reason'] or d['error']}")
        for f in d["frame_findings"]:
            print(f"        读题 · {f['code']}: {f['detail']}")
        for f in d["findings"]:
            print(f"        结构 · {f['code']}: {f['detail']}")


async def main() -> int:
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    engine = args[0] if args else None
    judge = "--no-judge" not in sys.argv

    if engine and engine not in engine_eval.ENGINES:
        print(f"未知引擎 {engine!r}，可选：{', '.join(engine_eval.ENGINES)}")
        return 1

    targets = [engine] if engine else list(engine_eval.ENGINES)
    print("=" * 66)
    print(f"质量标尺：{', '.join(targets)}   判分={'开' if judge else '关（只跑结构判分）'}")
    print(f"golden set 覆盖：{engine_eval.all_case_counts()}")
    print("=" * 66, flush=True)

    ran, grounded_all, skipped = 0, [], []
    for i, e in enumerate(targets, 1):
        print(f"\n[{i}/{len(targets)}] {e} 跑着…", flush=True)
        out = await engine_eval.run(e, judge=judge)
        if not out["runs"]:
            skipped.append(e)
            print(f"  {e}: 没有 golden set，跳过")
            continue
        run = out["runs"][0]
        ran += 1
        if out["judge_model"]:
            print(f"  判分模型：{out['judge_model']}")
        else:
            print("  没有可用模型，只跑了结构判分")
        _print_run(run)
        if run["grounded"] is not None:
            grounded_all.append(run["grounded"])

    print("\n" + "=" * 66)
    if grounded_all:
        print(f"合计：{ran} 个引擎，平均接地 {sum(grounded_all) / len(grounded_all):.2f}/5")
    else:
        print(f"合计：{ran} 个引擎，只跑了结构判分（没有可用模型）")
    if skipped:
        print(f"跳过（没有 golden set）：{', '.join(skipped)}")
    if not ran:
        print("SMOKE FAIL ❌（一个引擎都没跑成）")
        return 1
    print("SMOKE PASS ✅（跑完了；分数好不好看，见上面的 findings）")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
