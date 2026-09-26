"""A0 的尺子：任务级基线（Agent升级.md §2 A0）。

W1 量的是**底线**（谎报率、编造路径率），这一把量的是**胜任**：一句真实指令交出去，
事办成了没有、花了几轮、工具用对没有、底线守住了没有。原料全在 `turn_traces` 账本与
产出回执里 —— **不新增任何埋点**（见 `app/core/agent_eval.py` 开头）。

**要花钱**：每条任务 = 一次真实回合（1–N 次模型调用）。所以先给一条不花钱的路：
`--dry` 只体检金标任务集（条数、字段、完成判据恰好一个、工具名认不认识、路径越不越界），
一个字节都不发给模型。跑之前先花两秒确认「这套任务本身是合格的」。

用法：
    python smoke_agent.py --dry                 # 只体检，不调用
    python smoke_agent.py                       # 跑全部（默认模型），结果落 data/agent_baseline.json
    python smoke_agent.py --model qwen/qwen3-max
    python smoke_agent.py --only weekly-report,chitchat   # 只跑几条（省钱、查单条）
    python smoke_agent.py --no-save             # 跑但不落报告文件
    python smoke_agent.py --no-inject --only continue-recent-thing --no-save
                                                # A4 的「注入前」那一臂：同一个任务、同一个模型，
                                                # 只把这个进程里的 `thread_context_enabled` 压成 False
    python smoke_agent.py --no-stage --only continue-recent-thing --out ../data/wording_off_r1.json
                                                # 摘要那一行的「不给步名」那一臂（2026-09-22）：
                                                # 把 `threads.summary_line` 压回「只有 kind 计数」那一版，
                                                # 用来量「走到哪一步」这半句值不值（产品路径不用它）
    python smoke_agent.py --compare data/agent_baseline.json   # 与上一次比（A1 的「委托前后」）
    python smoke_agent.py --resummarize data/agent_baseline.json  # 只重算聚合，一个字节都不发给模型
    python smoke_agent.py --rejudge data/agent_baseline.json      # 只重算 A0 那几条判据（尺子改了、原始事实没变）

退出码：0 = 跑完（指标好不好看下面的明细）；1 = 金标不合格 / 真库欠迁移 / 没跑成。
"""
import asyncio
import json
import sys
from pathlib import Path

# 这台机器的控制台默认 gbk：不显式设一次，一个 ✅ 就能让脚本死在最后一行（钱花了、报告没打出来）。
# 长跑还要**行缓冲**：管道下 stdout 是块缓冲，收尾一炸就整轮输出全空（docs/testing.md §6.3）。
for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace", line_buffering=True)
    except Exception:  # noqa: BLE001
        pass

BACKEND = Path(__file__).parent
sys.path.insert(0, str(BACKEND))

from app.core import agent_eval  # noqa: E402

DEFAULT_OUT = BACKEND.parent / "data" / "agent_baseline.json"
MARK = {"": "✓"}


def _arg(name: str, default: str = "") -> str:
    if name not in sys.argv:
        return default
    i = sys.argv.index(name)
    return sys.argv[i + 1] if len(sys.argv) > i + 1 else default


def kinds_only_line(counts: object) -> str:
    """**对照臂**那一行：只有 kind 计数，不说走到哪一步（2026-09-22 之前的产品版本）。

    提成模块级函数只为一件事：它能被一条**免费**测试钉住。对照臂一旦跟着产品漂，
    那个 A/B 量的就不是「有没有步名」而是两件别的事了——而重跑一次对照组要花钱。
    """
    from app.core import threads as _threads

    parts: list[str] = []
    total = 0
    for k in _threads.KINDS:
        try:
            n = int((counts or {}).get(k) or 0)  # type: ignore[union-attr]
        except (AttributeError, TypeError, ValueError):
            n = 0
        if n > 0:
            total += n
            parts.append(f"{_threads.KIND_LABELS.get(k, k)} {n}")
    return f"挂着 {total} 份：" + " · ".join(parts) if parts else ""


def _print_task(rec: dict) -> None:
    codes = [f["code"] for f in rec["findings"]]
    mark = "✓" if not codes else ("~" if set(codes) <= {"over_budget"} else "✗")
    tools = ",".join(rec["tool_names"]) or "—"
    ledger = "（账本没读到）" if rec.get("trace_missing") else ""
    print(
        f"  {mark} {rec['id']:<30} {rec['rounds']} 轮 · {rec['tools']} 工具 · "
        f"{len(rec['artifacts'])} 份产出 · {rec['seconds']}s{ledger}"
    )
    print(f"      工具：{tools}")
    if codes:
        for f in rec["findings"]:
            print(f"      · [{f['code']}] {f['detail']}")
    if rec["error"]:
        print(f"      · 出错：{rec['error']}")


def _pending_migrations() -> list:
    """真库还欠哪几版迁移（**只读**）。A0 要往账本写行，所以结构得先跟上。

    这一道是量的时候撞出来的：真库停在 v14、`turn_traces` 缺 P3 那两列，于是**写行失败、
    读回来是空的**——而报告照样打「100% 完成 · 0 轮 · 0 工具」，看起来和「模型真的没调工具」
    一模一样。与其在报告里默默填 0，不如跑之前就拦住。
    """
    import asyncio as _a

    from app.core import migrations

    try:
        return _a.run(migrations.pending())
    except Exception as e:  # noqa: BLE001 - 查不到就别用它拦人（免得尺子因为无关原因跑不动）
        print(f"（迁移状态查不到：{type(e).__name__}: {e}——继续跑，账本读不到会单独标出来）")
        return []


def _print_report(rep: dict) -> None:
    print()
    print("=" * 78)
    print(f"A0 任务级基线 · {rep['tasks']} 条任务 · 模型 {rep['model_id'] or '(默认)'}")
    print("=" * 78)
    print(f"任务完成率        {rep['done']}/{rep['tasks']} = {rep['done_rate']:.0%}")
    print(f"完成且守规矩      {rep['clean']}/{rep['tasks']} = {rep['clean_rate']:.0%}")
    print(f"底线失守          {rep['floor_failures']} 条（谎报 / 编造路径 / 伪引用；长文没落盘单列，见下）")
    print(f"工具越界          {rep['tool_not_allowed']} 条 · 该用的没用 {rep['tool_not_used']} 条")
    print(f"超轮数预算        {rep['over_budget']} 条（成本事实，不算失败）")
    print(f"账本读不到        {rep['trace_missing']} 条（这几条的轮数/工具数是空的，不是 0）")
    print(
        f"委托（A1/A2）     {rep.get('delegated_turns', 0)} 个回合 · "
        f"{rep.get('delegate_calls', 0)} 次 · 子代理共 {rep.get('delegate_rounds', 0)} 轮"
        "（主循环的轮数不含它们）"
    )
    owed = int((rep.get("counts") or {}).get("not_delegated") or 0)
    if owed:
        # A2：这条不是失败，是「能力没用上」的读数。任务形状本来就适合委托的名额有几个、
        # 模型用了几个，这两个数要一起看——只看前者会以为它用了。
        print(
            f"该委托而没委托    {owed} 条（`must_delegate` 的任务；"
            f"委托名额 {rep.get('delegate_expected', 0)} 个 —— 完成率不受它影响）"
        )
    print(f"出错              {rep['errors']} 条")
    r = rep["rounds"]
    print(f"轮数             中位 {r['median']:.0f} · p90 {r['p90']:.0f} · 最多 {r['max']:.0f} · 均值 {r['mean']}")
    print(f"耗时             {rep['seconds']}s")
    print(f"指纹            任务集 {rep['tasks_sha']} · 输出规矩 {rep['prompt_sha'] or '—'}")
    # 这一轮是哪一臂：注入开关（A4）与摘要那一行给不给步名（#4 第三笔）。臂不同就不是同一份
    # 报告——所以印出来，别让人拿两臂的数当同一个数。
    print(
        f"这一轮哪一臂     注入 {'开' if rep.get('inject_enabled', True) else '关'}"
        f" · 摘要那一行 {'带走到哪一步' if rep.get('stage_in_line', True) else '只有挂着什么'}"
    )

    if rep["counts"]:
        print("\n毛病逐条：")
        for code, n in sorted(rep["counts"].items(), key=lambda kv: -kv[1]):
            print(f"  {n:>3}  {code}")
    print("\n按类型：")
    for tag, b in sorted(rep["by_tag"].items()):
        print(f"  {tag:<10} {b['done']}/{b['tasks']} 办成")
    if len(rep["by_model"]) > 1:
        print("\n按模型：")
        for mid, b in sorted(rep["by_model"].items()):
            print(
                f"  {mid:<34} 办成 {b['done']}/{b['tasks']} · 干净 {b['clean']} · 超预算 {b['over_budget']}"
            )


def main() -> int:
    # `--rejudge`：**改了判据（尺子）不用重新花钱**。它和 `--resummarize` 是两件事：
    # 前者重算 findings，后者只重算聚合。**边界**（见 `agent_eval.rejudge`）：只重算 A0 那几条
    # （工具/预算/体裁/账本），W1 那几条要盘上正文，报告里没有——不重算，原样留着。
    if "--rejudge" in sys.argv:
        src = Path(_arg("--rejudge"))
        try:
            old = json.loads(src.read_text(encoding="utf-8"))
        except (OSError, ValueError) as e:
            print(f"读不了 {src}：{type(e).__name__}: {e}")
            return 1
        try:
            rows, diff = agent_eval.rejudge(old.get("detail") or [], agent_eval.load_tasks())
        except KeyError as e:
            print(f"判据重算失败：{e}")
            return 1
        print(f"按当前金标重算 A0 判据：{len(rows)} 条，变了 {len(diff)} 条")
        for d in diff:
            print(f"  · {d['id']}：{'/'.join(d['before']) or '（干净）'} → {'/'.join(d['after']) or '（干净）'}")
        report = agent_eval.summarize(rows, model_id=old.get("model_id") or "")
        report.update(
            {
                "at": old.get("at"),
                "seconds": old.get("seconds"),
                "prompt_sha": old.get("prompt_sha"),
                "tasks_sha": agent_eval.tasks_sha(agent_eval.load_tasks()),
                "rejudged": True,
                "rejudged_from": str(src),
                "detail": rows,
            }
        )
        _print_report(report)
        # 默认**另存一份**，不覆盖原报告：重判后的数与跑分当时的数都要留得住，
        # 「尺子换了之后差在哪」才有得对（要覆盖就显式 `--out` 指回原文件）。
        default_out = src.with_name(f"{src.stem}.rejudged{src.suffix}")
        out = Path(_arg("--out", str(default_out)))
        out.write_text(json.dumps(report, ensure_ascii=False, indent=1), encoding="utf-8")
        print(f"\n重判后的报告落盘：{out}")
        print(f"（跑分当时的报告原样留着：{src}）")
        return 0

    # `--resummarize`：**改了聚合口径不用重新花钱**。跑分那一步的原始事实（轮数/工具/
    # 产物/回复）都在旧报告的 detail 里，重算只是把 `summarize` 再跑一遍。
    if "--resummarize" in sys.argv:
        src = Path(_arg("--resummarize"))
        try:
            old = json.loads(src.read_text(encoding="utf-8"))
        except (OSError, ValueError) as e:
            print(f"读不了 {src}：{type(e).__name__}: {e}")
            return 1
        report = agent_eval.summarize(old.get("detail") or [], model_id=old.get("model_id") or "")
        report.update(
            {
                "at": old.get("at"),
                "seconds": old.get("seconds"),
                "prompt_sha": old.get("prompt_sha"),
                "tasks_sha": old.get("tasks_sha"),
                "resummarized": True,
                "detail": old.get("detail") or [],
            }
        )
        _print_report(report)
        out = Path(_arg("--out", str(src)))
        out.write_text(json.dumps(report, ensure_ascii=False, indent=1), encoding="utf-8")
        print(f"\n重算后的报告落盘：{out}")
        return 0

    tasks = agent_eval.load_tasks()
    problems = agent_eval.validate(tasks)
    print("=" * 78)
    print(f"A0 金标任务集：{len(tasks)} 条（{agent_eval.DEFAULT_TASKS.name}）")
    print("=" * 78, flush=True)
    if problems:
        print("任务集不合格：")
        for p in problems:
            print(f"  · {p}")
        print("SMOKE FAIL ❌（先把它修好——坏用例会污染基线）")
        return 1
    print("体检通过：字段齐、完成判据恰好一个、工具名认识、vault 路径都在界内\n", flush=True)

    if "--dry" in sys.argv:
        tags: dict[str, int] = {}
        for t in tasks:
            tags[str(t.get("tag") or "?")] = tags.get(str(t.get("tag") or "?"), 0) + 1
        print("类型分布：", tags)
        print("SMOKE PASS ✅（只体检，没有调用模型）")
        return 0

    only = [x for x in _arg("--only").split(",") if x.strip()]
    # A4 的「注入前」那一臂：把这个进程里的 `thread_context_enabled` 压成 False。
    # 压的是**同一个 pref 键**（不是另走一条代码路径），缝在模块属性上、跑完还原——
    # 与 `turn_eval._scratch_vault` 换 `VAULT_DIR` 是同一类做法。报告里记下这一轮是哪一臂。
    inject = "--no-inject" not in sys.argv
    _restore = None
    if not inject:
        from app.routers import chat as _chat

        _real_load_config = _chat.load_config
        _chat.load_config = lambda: {**_real_load_config(), "thread_context_enabled": False}
        _restore = lambda: setattr(_chat, "load_config", _real_load_config)  # noqa: E731
        print("（这一轮**关掉**了「手头那件事」的注入：--no-inject）", flush=True)

    # 摘要那一行的对照臂（2026-09-22）：把 `threads.summary_line` 压回「只有 kind 计数」那一版
    # （2026-09-22 前一版：`挂着 2 份：笔记 1 · 成品 1`）。**量的是「走到哪一步」这半句值不值** ——
    # 换措辞这种改动没法事后重跑旧版，所以对照臂得留在尺子上（与 `--no-inject` / `--no-split`
    # 同一类做法：缝在模块属性上、跑完还原，报告里记下这一轮是哪一臂）。
    stage = "--no-stage" not in sys.argv
    if not stage:
        from app.core import threads as _threads

        _real_summary_line = _threads.summary_line
        _threads.summary_line = kinds_only_line  # type: ignore[assignment]
        _prev_restore = _restore
        _restore = lambda: (  # noqa: E731
            setattr(_threads, "summary_line", _real_summary_line),
            _prev_restore() if _prev_restore else None,
        )
        print("（这一轮那一行**只说挂着什么、不说走到哪一步**：--no-stage）", flush=True)
    todo = _pending_migrations()
    if todo:
        print("真库还欠这几版迁移（A0 要往回合账本写行，结构得先跟上）：")
        for m in todo:
            print(f"  · v{m.version} {m.name}")
        print(
            "\n怎么补：**重启一次后端**（应用启动时会自己跑，跑前自动备份），"
            "或在后端目录显式跑一次 `python -c \"import asyncio;from app.core import migrations;"
            "print(asyncio.run(migrations.run()))\"`。\n"
            "不补的话：账本行写不进去，轮数/工具数会全是 0 —— 那份报告读不了，所以这里先拦住。"
        )
        return 1

    try:
        report = asyncio.run(
            agent_eval.run_tasks(
                tasks,
                model_id=_arg("--model"),
                only=only or None,
                on_task=_print_task,
            )
        )
    except ValueError as e:
        print(f"跑不起来：{e}")
        return 1
    finally:
        if _restore is not None:
            _restore()
    report["inject_enabled"] = inject
    report["stage_in_line"] = stage

    _print_report(report)

    old_path = _arg("--compare")
    if old_path:
        try:
            old = json.loads(Path(old_path).read_text(encoding="utf-8"))
            print("\n与上一次比：" + agent_eval.compare(old, report))
        except (OSError, ValueError) as e:
            print(f"\n比不了（{old_path}）：{type(e).__name__}: {e}")

    if "--no-save" not in sys.argv:
        out = Path(_arg("--out", str(DEFAULT_OUT)))
        try:
            out.parent.mkdir(parents=True, exist_ok=True)
            out.write_text(json.dumps(report, ensure_ascii=False, indent=1), encoding="utf-8")
            print(f"\n报告落盘：{out}")
        except OSError as e:
            print(f"\n报告没落盘（{out}）：{type(e).__name__}: {e}")

    if report["trace_missing"]:
        print(
            f"\n!! 有 {report['trace_missing']} 条的账本读不到：上面那张轮数/工具数表**读不了**，"
            "别把空当成 0（先看真库的迁移跑没跑完）"
        )

    print("\nSMOKE PASS ✅（跑完了；指标好不好看上面那张表）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
