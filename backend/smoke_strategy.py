"""P1c 的分档量法：同一个金标、同一批查询，把每档查询策略各跑一遍。

为什么单独一个脚本、不塞进 `evals.run_eval`：`EvalItem`/`EvalRun` 没有「策略」这一维，
而**四档要跑同一批查询**才有可比性（n 都是 34）。塞进去要先改表结构，而这一轮的量法
是「先看数据决定上线哪档」，不是「给评测器加维度」。所以这里只读、只印表：

  - `none`     单次检索（原话），P0 基线的同一形状，用来当对照；
  - `rewrite`  强制走改写；
  - `hyde`     强制走 HyDE（假设段落进向量、原话进词法）；
  - `decompose`强制走子问题分解；
  - `auto`     走 `pick_strategy` 的确定性规则（这一档才是「真上线会长什么样」）；
  - `X@delegate` 同一档策略、但**生成那一步走 A1 的委托通道**（Agent升级.md §5 的合流），
                并且给它只读工具——量的是「策略生成自己去看一眼材料」值不值。

**生成结果按 (档, 查询) 记忆**：`auto` 那一档复用前面已生成的产物，不会重复花钱。

跑法：
  backend/.venv/Scripts/python.exe smoke_strategy.py --dry        # 只体检金标与分派，不花钱
  backend/.venv/Scripts/python.exe smoke_strategy.py              # 默认 hybrid=on（B 档）
  backend/.venv/Scripts/python.exe smoke_strategy.py --hybrid-off # 线上现行（A 档）
  backend/.venv/Scripts/python.exe smoke_strategy.py --only none,rewrite,rewrite@delegate
                                                                  # 委托臂：同一个金标上配对

**先 `--dry`**（`docs/testing.md` §5 的规矩）：一轮三档 = 3×34 = 102 次模型调用，跑完才发现
金标少个字段就白花了。
"""
import asyncio
import sys
import time
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
try:  # 中文与图标在 GBK 控制台上会炸；line_buffering 让长跑能实时看进度，也避免
    # 解释器退出阶段（流式响应收尾偶发报错）把已算好的结果留在缓冲区里一起丢掉
    sys.stdout.reconfigure(encoding="utf-8", line_buffering=True)
except Exception:  # noqa: BLE001
    pass

from app.core import evals, indexer, retriever  # noqa: E402
from smoke_rag_eval import _per_tag, _set_cfg, load_golden  # noqa: E402


def _arg(name: str, default: str = "") -> str:
    if name in sys.argv:
        i = sys.argv.index(name)
        if i + 1 < len(sys.argv):
            return sys.argv[i + 1]
    return default

CONDITIONS = ("none", "rewrite", "hyde", "decompose", "auto")
# **委托臂**（Agent升级.md §5：查询策略走 A1 的委托通道）。带 `@delegate` 的条件用同一档策略、
# 但生成那一步交给子代理，而且**给它只读工具**——这样它可能自己去看一眼材料。
# 它不是默认：合流这件事本身买不到什么（账已经在 `usage_ledger` 里、隔离本来就有），
# 唯一可能有区别的就是「能看材料」，所以它得先过这把尺子。
DELEGATE_ARMS = ("rewrite@delegate", "hyde@delegate", "decompose@delegate")
_ALL_CONDITIONS = CONDITIONS + DELEGATE_ARMS
_CONCURRENCY = 3  # 便宜模型也架不住 34 路并发；3 与评测器同档
# 委托臂单独一档并发：一次生成 2~3 轮（要用工具），3 路并发会把每分钟额度打爆（见下面那段）。
_DELEGATE_CONCURRENCY = 1


def _split_cond(cond: str) -> tuple[str, bool]:
    """`rewrite@delegate` → `("rewrite", True)`。Pure。"""
    base, _, suffix = cond.partition("@")
    return base, suffix == "delegate"


def _memo(fn_name: str, memo: dict, calls: Counter, *, via_delegate: bool = False):
    """把一档的生成函数包成「同 (档, 查询) 只调一次」。

    `via_delegate=True` 时把同一个函数**从委托通道**走一遍（同一个提示词、同一档策略），
    所以它是同一个金标上的一次配对，而不是另写一套生成。
    """

    async def wrapped(
        topic, model_id="", *, stream_fn=None, native_fn=None, via_delegate=via_delegate
    ):
        key = (fn_name, topic, bool(via_delegate))
        if key not in memo:
            fn = getattr(retriever, fn_name)
            try:
                memo[key] = await fn(
                    topic,
                    model_id,
                    stream_fn=stream_fn,
                    native_fn=native_fn,
                    via_delegate=bool(via_delegate),
                )
            except Exception as e:  # noqa: BLE001 - 生成挂了按「不可用」记，不中断整轮
                memo[key] = "" if fn_name == "hyde_passage" else []
                print(f"   !! {fn_name} 失败（{topic[:24]}）: {type(e).__name__}: {e}")
            calls[fn_name + ("@delegate" if via_delegate else "")] += 1
        return memo[key]

    return wrapped


async def _hits(cond: str, query: str, top_k: int, gens: dict) -> list[dict]:
    base, via_delegate = _split_cond(cond)
    if base == "none":
        return await asyncio.to_thread(indexer.search_auto, query, top_k)
    return await retriever.deep_search(
        query,
        top_k,
        strategy=base,
        rewrite_fn=gens["rewrite_queries"],
        hyde_fn=gens["hyde_passage"],
        decompose_fn=gens["decompose_questions"],
        via_delegate=via_delegate,
    )


def _score(ranks: list[int | None]) -> dict:
    n = len(ranks) or 1
    return {
        "hit1": sum(1 for r in ranks if r == 1) / n,
        "hit3": sum(1 for r in ranks if r and r <= 3) / n,
        "hit5": sum(1 for r in ranks if r) / n,
        "mrr": sum(1 / r for r in ranks if r) / n,
    }


def _pair(base: dict[str, int | None], cand: dict[str, int | None]) -> tuple[int, int, int]:
    """配对胜负：cand 相对 base 的升/平/降（方案 §2 P1b 同款判据）。"""
    win = tie = loss = 0
    for q, b in base.items():
        c = cand.get(q)
        if b == c:
            tie += 1
        elif c is not None and (b is None or c < b):
            win += 1
        else:
            loss += 1
    return win, tie, loss


def _dry_run(items: list[dict]) -> int:
    """`--dry`：只体检金标与规则分派，**一个字节都不发给模型**（`docs/testing.md` §5）。

    真跑一轮是 3×34 = 102 次调用，先花两秒确认用例本身合格、并看清规则把多少条发给哪档
    ——P1c 的判决里「多数问题落到了最弱的一档」就是这么一眼看出来的。
    """
    print("金标体检：", len(items), "条 ·", dict(Counter(it["tag"] for it in items)))
    print("规则分派：", dict(Counter(retriever.pick_strategy(it["query"]) for it in items)))
    print(f"预计调用：三档各 {len(items)} 次 = {len(items) * 3} 次（auto 档复用，不额外算）")
    return 0


async def main() -> int:
    hybrid = "--hybrid-off" not in sys.argv
    top_k = 5

    from app.core.prefs import load_config

    _set_cfg({**load_config(), "hybrid_search": hybrid, "rerank_enabled": False})

    items = load_golden()
    if "--dry" in sys.argv:
        return _dry_run(items)

    # 前置：没有可用模型的话三档生成全废，早点说清楚而不是印一张假表
    from app.core.report import resolve

    if await resolve("") is None:
        print("!! 没有可用模型——HyDE / 分解 / 改写都要模型，先配一个 provider 再跑")
        return 1

    tag_map = {it["query"]: it["tag"] for it in items}

    memo: dict = {}
    calls: Counter = Counter()
    gens = {
        "rewrite_queries": _memo("rewrite_queries", memo, calls),
        "hyde_passage": _memo("hyde_passage", memo, calls),
        "decompose_questions": _memo("decompose_questions", memo, calls),
    }

    print("=" * 78)
    print(f"P1c 查询策略分档（金标 {len(items)} 条，top_k={top_k}，hybrid={hybrid}，rerank=off）")
    print("=" * 78)

    # `--only a,b`：只跑这几档（跑委托臂时不必把五档全跑一遍——那是钱）。
    only = [x for x in _arg("--only").split(",") if x.strip()]
    todo = [c for c in _ALL_CONDITIONS if not only or c in only]
    if only and not todo:
        print(f"--only 没匹配到任何一档：{only}（可选：{', '.join(_ALL_CONDITIONS)}）")
        return 1
    if only:
        print(f"只跑这几档：{todo}")

    # **委托臂的账**（只在这一轮真跑委托臂时挂上）：数「每次生成了几轮、用没用工具」。
    # 少了这一笔，「换了通道没差别」有两种完全不同的解释——**合流本身没用**，还是
    # **子代理压根没去用那些工具**（那这次就没量到「带工具的合流」）。测在尺子这一侧，
    # 产品代码一个字不动（同 A4 drill 里那个只抄不换的间谍）。
    stats: dict = {"calls": 0, "rounds": 0, "tools": Counter(), "fellback": 0}
    if any(_split_cond(c)[1] for c in todo):
        from app.core import delegate as _delegate

        _real_run = _delegate.run

        async def _counted(task, **kw):
            out = await _real_run(task, **kw)
            stats["calls"] += 1
            stats["rounds"] += int(out.get("rounds") or 0)
            # **退回直连的几次要数出来**：那几次跑的是**另一档的行为**（原话/直连生成），
            # 混进分数表里就成了「合流的成绩」——同 §6.2「检索失败被算成 miss」那一族：
            # 量的东西不在场，而报告照样出数。
            if out.get("error") or out.get("rounds_exhausted") or not str(out.get("text") or "").strip():
                stats["fellback"] += 1
            for c in out.get("tool_calls") or []:
                stats["tools"][str(c.get("name") or "?")] += 1
            return out

        _delegate.run = _counted

    ranks_by_cond: dict[str, dict[str, int | None]] = {}
    for cond in todo:
        t0 = time.time()
        # **委托臂并发 1**：一次生成要 2~3 轮（它真的会去用那些只读工具），3 路并发在 44 条上
        # 会把 provider 的每分钟额度直接打爆——2026-09-22 实测 429 `rpm exhausted`，
        # 而挨了 429 的那几次是**静默退回直连**的（分数表照样打出来）。
        sem = asyncio.Semaphore(_DELEGATE_CONCURRENCY if _split_cond(cond)[1] else _CONCURRENCY)

        async def one(it, cond=cond):
            async with sem:
                try:
                    hits = await _hits(cond, it["query"], top_k, gens)
                except Exception as e:  # noqa: BLE001 - 一条挂了不该毁掉整档
                    print(f"   !! {cond} 检索失败（{it['query'][:24]}）: {type(e).__name__}: {e}")
                    hits = []
                return it["query"], evals._rank_of(it["expected_source"], hits)

        pairs = await asyncio.gather(*(one(it) for it in items))
        ranks = dict(pairs)
        ranks_by_cond[cond] = ranks
        s = _score([ranks[q] for q in tag_map])
        print(
            f"\n·· {cond:<10} hit@1={s['hit1']:.4f}  hit@3={s['hit3']:.4f}  "
            f"hit@5={s['hit5']:.4f}  MRR={s['mrr']:.4f}  ({time.time() - t0:.0f}s)"
        )
        _per_tag(ranks, tag_map)

    print("\n" + "=" * 78)
    print("配对胜负（对照 = none 单次检索；方案 §2 P1b 同款判据）")
    base = ranks_by_cond.get("none")
    if base is None:
        # **没有对照就不打配对表**。第一版是「退而用第一条跑到的当对照」，于是
        # `--only rewrite@delegate` 那种单档运行会拿**自己**当对照、印出一整行
        # 「赢 0 / 平 44 / 输 0」——那看着像结论，其实什么都不是。要配对就把 none 带上。
        print("（这一轮没跑 none，没有对照 → 配对表略；要配对请带上 none）")
    else:
        for cond in todo:
            if cond == "none" or ranks_by_cond.get(cond) is None:
                continue
            win, tie, loss = _pair(base, ranks_by_cond[cond])
            print(f"   {cond:<18} 赢 {win:>2} / 平 {tie:>2} / 输 {loss:>2}")

    print(f"\n模型调用：{dict(calls)}（共 {sum(calls.values())} 次；auto 档复用，不重复调）")
    if stats["calls"]:
        print(
            f"委托臂的账：{stats['calls']} 次生成 · 共 {stats['rounds']} 轮 · "
            f"工具 {dict(stats['tools']) or '一次都没用'}"
        )
        if stats["fellback"]:
            # **这一行比分数表重要**：退回直连的那几次跑的是另一档的行为，
            # 它们混在里面时，上面那几行数字不是「委托臂的成绩」。
            print(
                f"⚠ 其中 {stats['fellback']}/{stats['calls']} 次**退回直连**（委托报错 / 空产出 / 轮数烧光）"
                "——这一轮的分数**不是干净的委托臂**（429 限流也会落到这里），要下结论请重跑"
            )
    print("\nSMOKE PASS ✅（只是度量，不判对错）")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
