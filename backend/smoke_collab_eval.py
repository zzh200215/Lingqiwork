"""A2 的尺子：协作（含并行）到底办成了没有 —— 以及**带工具 vs 裸 LLM 的配对对比**。

**为什么单开一把尺子。** A0 量的是「一句话交出去，一个聊天回合办成了没有」；协作是另一种
形状：一句话交出去，几个 agent 分头做、再合成，产物是一段**纪要**而不是产出区的成品。
把协作任务塞进 A0，`rounds` / `tools` / `trace_missing` 那几栏就得改意思——A0 的完成率
会从「件事办成没有」变成两种东西的混合。判据与聚合在 `app/core/collab_eval.py`。

（**注意**：仓库里已经有一个 `smoke_collab.py`，那是 V14 的 **HTTP 级**冒烟（起一个临时库、
走 `/api/agents/collab` 的校验与 SSE 错误路径）。这一支是**尺子**，两者不是一回事。）

**它要回答的三个问题**（A2 的验收）：
  1. **每步工具白名单生效吗**：每一步的 `facts.tools` 是否都在「只读基线 ∪ 该步声明的」里；
  2. **并行是编排器说了算吗**：`fanout` 那一波真的同时在跑（同一波走 `gather`），
     而且**逐路相 join vs 取最大**的耗时差就是并行的收益；
  3. **带工具 ≥ 裸 LLM 吗**：同一批任务跑两臂（`--arm tools` / `--arm bare`），配对出胜平负。

用法：
    python smoke_collab_eval.py --dry                  # 只体检金标集，不调模型（免费）
    python smoke_collab_eval.py --arm tools            # 带工具那一臂（A2）
    python smoke_collab_eval.py --arm bare             # 裸 LLM 那一臂（v1 行为），做配对
    python smoke_collab_eval.py --only fanout-three-angles --arm tools
    python smoke_collab_eval.py --compare data/collab_bare.json   # 与另一臂那份报告比（两份合起来看）
    python smoke_collab_eval.py --rejudge data/collab_bare.json   # 改了判据：只重算，不重跑
    python smoke_collab_eval.py --arm tools --reps 3 --out ..\\data\\collab_k3_tools.json
                                       # 同一臂跑 k 遍（各存 -r1/-r2/-r3）——单遍的胜平负是掷硬币
    python smoke_collab_eval.py --pair "..\\data\\k3_tools-r*.json,..\\data\\k3_bare-r*.json"
                                       # 2k 份单臂报告 → **逐遍配对** + 符号检验（不花钱）。
                                       # 多个通配用逗号隔开——别把对照臂的报告一起扫进来
    python smoke_collab_eval.py --arm tools --only fanout-three-angles --reps 3 --no-split
                                       # ② 的对照臂：单段式 fanout（挂账②之前的那种形状）

退出码：0 = 跑完（好不好看报告）；1 = 金标不合格 / 真库欠迁移 / 没跑成。
"""
import asyncio
import json
import sys
from pathlib import Path

# 控制台默认 gbk：不显式设一次，一个 ✅ 就能让脚本死在最后一行（钱花了、报告没打出来）。
# 长跑还要**行缓冲**（docs/testing.md §6.3）。
for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace", line_buffering=True)
    except Exception:  # noqa: BLE001
        pass

BACKEND = Path(__file__).parent
sys.path.insert(0, str(BACKEND))

from app.core import collab_eval  # noqa: E402

DEFAULT_OUT = BACKEND.parent / "data" / "collab_baseline.json"


def _arg(name: str, default: str = "") -> str:
    if name in sys.argv:
        i = sys.argv.index(name)
        if i + 1 < len(sys.argv):
            return sys.argv[i + 1]
    return default


def _pending_migrations() -> list:
    try:
        from app.core import migrations

        return asyncio.run(migrations.pending())
    except Exception as e:  # noqa: BLE001 - 查不出来就不拦（真跑挂了会在任务里报出来）
        print(f"（迁移状态没查成：{type(e).__name__}: {e}）")
        return []


def _print_report(rep: dict) -> None:
    print()
    print("=" * 78)
    print(
        f"协作基线 · {rep['tasks']} 条任务 · 臂 {collab_eval.ARM_LABELS.get(rep.get('arm'), rep.get('arm'))}"
        f" · 模型 {_arg('--model') or '(默认)'}"
    )
    print("=" * 78)
    print(f"办成              {rep['done']}/{rep['tasks']} = {rep['done_rate']:.0%}")
    t, b = rep["tools_arm"], rep["bare_arm"]
    if t["tasks"]:
        print(f"  带工具那一臂    {t['done']}/{t['tasks']} = {t['rate']:.0%}")
    if b["tasks"]:
        print(f"  裸 LLM 那一臂   {b['done']}/{b['tasks']} = {b['rate']:.0%}")
    p = rep["paired"]
    if p["win"] or p["tie"] or p["loss"]:
        print(f"配对             胜 {p['win']} / 平 {p['tie']} / 负 {p['loss']}")
    print(f"每步工具调用      {rep['tool_calls']} 次 · 共 {rep['steps']} 步")
    if rep.get("parallel_seconds"):
        saved = round(float(rep["serial_sum_seconds"]) - float(rep["parallel_seconds"]), 1)
        print(
            f"并行那一波       {rep['parallel_seconds']}s（逐路相加是串行要花的 "
            f"{rep['serial_sum_seconds']}s，省 {saved}s）"
        )
    print(f"耗时             {rep['seconds']}s · 金标指纹 {rep['tasks_sha']}")
    if rep.get("rag") is False:
        print("RAG              关（材料只能靠工具拿——两臂的差别就是 A2 加的那件事）")
    if rep.get("usage_rows_dropped"):
        print(f"用量行已收走     {rep['usage_rows_dropped']} 行（评测不属于用户自己的账）")

    if rep["counts"]:
        print("\n毛病逐条：")
        for code, n in sorted(rep["counts"].items(), key=lambda kv: -kv[1]):
            print(f"  {n:>3}  {code}")
    print("\n逐条：")
    for row in rep["detail"]:
        codes = sorted(collab_eval._codes(row.get("findings")))
        flag = "✅" if collab_eval.is_done(row) else "❌"
        tool_n = sum(len(f.get("tools") or []) for f in (row.get("facts") or []))
        print(
            f"  {flag} {row['id']:<26} {row['pattern']:<8} 步 {len(row.get('facts') or [])}"
            f" · 工具 {tool_n} · {row.get('seconds')}s"
            + (f" · {','.join(codes)}" if codes else "")
        )


def _print_pairing(pairing: dict) -> None:
    """`pair_reps` 的产出 → 给人看的那几行。"""
    print()
    print("=" * 78)
    print(f"k 遍配对 · {pairing['reps']} 遍 × 两臂 = {pairing['reports']} 份报告")
    print("=" * 78)
    for arm in collab_eval.ARMS:
        s = pairing["arms"].get(arm) or {}
        if not s.get("tasks"):
            continue
        print(
            f"{collab_eval.ARM_LABELS.get(arm, arm):<14} 办成 {s['done']}/{s['tasks']}"
            f" · {s['steps']} 步 · {s['tool_calls']} 次工具"
            f" · 烧光 {s['exhausted_steps']} 步（{s['exhausted_rows']} 条任务）"
        )
    p = pairing["paired"]
    print(
        f"\n逐遍配对        胜 {p['win']} / 平 {p['tie']} / 负 {p['loss']}"
        + (f" · 配不上 {p['unpaired']}" if p["unpaired"] else "")
    )
    print(
        f"符号检验双侧 p  {pairing['sign_test_p']}"
        "（平局丢掉；它只拦「5 胜 2 负 → 更好」这种读法，同一任务的多遍之间并不独立）"
    )
    print("\n逐条（每格 = 那一遍成没成）：")
    for tid, s in sorted(pairing["per_task"].items()):
        print(
            f"  {tid:<26} 带工具 {s['tools']} · 裸 {s['bare']}"
            f" → 胜{s['win']} 平{s['tie']} 负{s['loss']}"
        )


def main() -> int:
    tasks = collab_eval.load_tasks()
    problems = collab_eval.validate(tasks)
    print("=" * 78)
    print(f"A2 协作金标：{len(tasks)} 条（{collab_eval.DEFAULT_TASKS.name}）")
    print("=" * 78, flush=True)
    if problems:
        print("金标不合格：")
        for p in problems:
            print(f"  · {p}")
        print("SMOKE FAIL ❌（先把它修好——坏用例会污染基线）")
        return 1
    print("体检通过：字段齐、pattern 认识、agents 有人设、marker 非空、vault 路径在界内\n", flush=True)

    if "--dry" in sys.argv:
        kinds: dict[str, int] = {}
        for t in tasks:
            kinds[str(t.get("pattern"))] = kinds.get(str(t.get("pattern")), 0) + 1
        print("形状分布：", kinds)
        print(f"并行任务：{sum(1 for t in tasks if (t.get('expected') or {}).get('parallel'))} 条")
        print("SMOKE PASS ✅（只体检，没有调用模型）")
        return 0

    # `--pair`：把 k 遍 × 两臂的单臂报告合起来做**逐遍配对**。**不花钱**——它只读报告。
    # 这条是 A2 挂账① 的口径：单遍的胜平负是掷硬币，要多遍配对才读得出方向。
    if "--pair" in sys.argv:
        import glob as _glob

        pattern = _arg("--pair")
        # 逗号分隔可以给多个通配（比如两臂分开放两个前缀的文件）——**只挑真属于这一次对比的
        # 那几份**：把对照臂的报告一起扫进来，配出来的数就不是这次实验的了。
        paths = sorted({p for pat in pattern.split(",") if pat.strip() for p in _glob.glob(pat.strip())})
        if not paths:
            print(f"--pair 没匹配到报告：{pattern!r}")
            return 1
        reports = []
        for p in paths:
            try:
                reports.append(json.loads(Path(p).read_text(encoding="utf-8")))
            except (OSError, ValueError) as e:
                print(f"读不了 {p}：{type(e).__name__}: {e}")
                return 1
        try:
            pairing = collab_eval.pair_reps(reports)
        except ValueError as e:
            print(f"配不起来：{e}")
            return 1
        _print_pairing(pairing)
        if "--out" in sys.argv:
            out = Path(_arg("--out"))
            out.write_text(json.dumps(pairing, ensure_ascii=False, indent=1), encoding="utf-8")
            print(f"\n配对结果落盘：{out}")
        return 0

    # `--rejudge`：**改了判据不用重跑**。原始事实（纪要正文、每步的工具与耗时）报告里留全了，
    # 所以判据的改动只重算一遍就行——与 A0 那边同一条纪律。默认**另存一份**，不覆盖原报告。
    if "--rejudge" in sys.argv:
        src = Path(_arg("--rejudge"))
        try:
            old = json.loads(src.read_text(encoding="utf-8"))
        except (OSError, ValueError) as e:
            print(f"读不了 {src}：{type(e).__name__}: {e}")
            return 1
        try:
            rows, diff = collab_eval.rejudge(old.get("detail") or [], tasks)
        except KeyError as e:
            print(f"重判失败：{e}")
            return 1
        print(f"按当前判据重算：{len(rows)} 条，变了 {len(diff)} 条")
        for d in diff:
            print(
                f"  · {d['id']}（{d['arm']}）：{'/'.join(d['before']) or '（干净）'}"
                f" → {'/'.join(d['after']) or '（干净）'}"
            )
        report = collab_eval.summarize(rows)
        report.update(
            {
                "at": old.get("at"),
                "seconds": old.get("seconds"),
                "tasks_sha": collab_eval.tasks_sha(tasks),
                "arm": old.get("arm"),
                "rag": old.get("rag"),
                "rejudged": True,
                "rejudged_from": str(src),
            }
        )
        _print_report(report)
        out = Path(_arg("--out", str(src.with_name(f"{src.stem}.rejudged{src.suffix}"))))
        out.write_text(json.dumps(report, ensure_ascii=False, indent=1), encoding="utf-8")
        print(f"\n重判后的报告落盘：{out}\n（跑分当时的报告原样留着：{src}）")
        return 0

    todo = _pending_migrations()
    if todo:
        print("真库还欠这几版迁移（协作的用量行也要写库，结构得先跟上）：")
        for m in todo:
            print(f"  · v{m.version} {m.name}")
        print("\n怎么补：重启一次后端，或在后端目录跑一次 migrations.run()。")
        return 1

    arm = _arg("--arm", "tools")
    if arm not in collab_eval.ARMS:
        print(f"--arm 只能是 {'/'.join(collab_eval.ARMS)}")
        return 1
    only = [x for x in _arg("--only").split(",") if x.strip()]
    todo_tasks = [t for t in tasks if not only or str(t.get("id")) in only]
    if not todo_tasks:
        print(f"--only 没匹配到任务：{only}")
        return 1

    print(f"要跑 {len(todo_tasks)} 条 × 臂「{collab_eval.ARM_LABELS[arm]}」——每条 2~5 次模型调用\n", flush=True)

    reps = 1
    if "--reps" in sys.argv:
        try:
            reps = max(1, int(_arg("--reps", "1")))
        except ValueError:
            print("--reps 要一个整数（比如 --reps 3）")
            return 1

    def on_task(rec: dict) -> None:
        codes = sorted(collab_eval._codes(rec.get("findings")))
        print(
            f"  {'✅' if collab_eval.is_done(rec) else '❌'} {rec['id']} · {rec['seconds']}s"
            + (f" · {','.join(codes)}" if codes else ""),
            flush=True,
        )

    # `--reps k`：同一臂跑 k 遍，**每遍各存一份**（单遍的胜平负是掷硬币，见 A2 挂账①）。
    # 存成 `-r1/-r2/...` 是为了让 `--pair` 能把两臂的各遍对起来。
    for rep_i in range(1, reps + 1):
        if reps > 1:
            print(f"\n—— 第 {rep_i}/{reps} 遍 ——", flush=True)
        try:
            report = asyncio.run(
                collab_eval.run_tasks(
                    todo_tasks,
                    model_id=_arg("--model"),
                    arm=arm,
                    rag="--no-rag" not in sys.argv,
                    # ② 的对照臂：单段式 fanout（读+成文挤在一步里），也就是挂账②之前的样子。
                    # 这是**量形状**的开关，不是产品行为——产品路径永远走拆开的那版。
                    split_reads="--no-split" not in sys.argv,
                    on_task=on_task,
                )
            )
        except Exception as e:  # noqa: BLE001 - 别把栈糊在报告上面
            print(f"没跑成：{type(e).__name__}: {e}")
            return 1

        cmp_path = _arg("--compare")
        if cmp_path and reps == 1:
            try:
                old = json.loads(Path(cmp_path).read_text(encoding="utf-8"))
                print("\n对比：" + collab_eval.compare(old, report))
            except (OSError, ValueError) as e:
                print(f"（对比没读成：{type(e).__name__}: {e}）")

        _print_report(report)
        if "--no-save" not in sys.argv:
            out = Path(_arg("--out", str(DEFAULT_OUT)))
            if reps > 1:
                out = out.with_name(f"{out.stem}-r{rep_i}{out.suffix}")
            out.write_text(json.dumps(report, ensure_ascii=False, indent=1), encoding="utf-8")
            print(f"\n报告落盘：{out}")

    if reps > 1 and "--no-save" not in sys.argv:
        out = Path(_arg("--out", str(DEFAULT_OUT)))
        print(
            f"\n（{reps} 遍各存一份：{out.stem}-r1..r{reps}{out.suffix}。"
            "两臂都跑完之后用 `--pair` 把它们对起来——不花钱）"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
