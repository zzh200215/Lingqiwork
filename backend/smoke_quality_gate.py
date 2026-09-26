"""P2 前置：质量门的**可分性重测**——确定性门到底建得起来吗。

方案 §2 P2 的前置原话：「质量门最自然的信号『top1 rerank 分』已经被 smoke_rerank.py 测死过
一次（a0ec0aa：相关/无关 top1 分无窗口）。P2 动工前必须先在 P0 金标上重测可分性……无论哪个
结论都入档。」

**为什么不能沿用旧结论**：那一次量的是 **rerank 分**，而 P1b 之后重排已经关掉，那个信号在
线上根本不存在。现在能用的是 hybrid 之后还活着的这些：RRF top1 分、top1−top3 分差、
top1 命中了几个通道、以及**向量路的原始相似度**（重排之前那一层）。

**样本分三组**（2026-09-20 补了负样本之后）：
- `good`      正样本且期望源出现在 top-k —— 门该说「够，直接答」；
- `bad`       正样本但期望源没进 top-k —— 门该说「不够，重搜」；
- `negative`  负样本（库里本来就没有答案，`golden.jsonl` 的 `no_answer`）—— 同样该说「不够」。

**门真正要过的口径是 `good` vs (`bad` ∪ `negative`)**：只把 `bad` 分开没用，门还必须认出
「这个问题库里根本没有」——那才是 CRAG 重搜的动机。

判据 AUC（秩和口径）= good 的信号大于 bad 的概率（并列算 0.5）。0.5 = 完全无窗口；
0.75 以上才谈得上取阈值。对 AUC 够的信号再给一张阈值表：**放行率(好)** 要高、
**误放率(坏)** 要低——后者才是 RAG 里危险的那一边（该重搜却直接答）。

免费：只用本地 embedder 与现有索引，不调任何模型。确定性，跑一遍就够。
跑法：backend/.venv/Scripts/python.exe smoke_quality_gate.py [--k 5] [--cv 20]

---

**2026-09-24 补的两件事（因为这张扫描表被读错过一次）**：

1. **「误放 ≤ 上限下放行率最高」是样本内最优，不是可达目标。** 规则族是几百上千条，
   在同一批 63 条上取最大，白捡几个点很正常。所以本尺子现在**自带交叉验证**：
   同样的规则族放进 5 折 × N 次重复，**只在训练折上挑、在留出折上算**。实测（见末尾那一节）
   留出误放率远高于扫描表承诺的上限——**换一批同样大小的样本，调出来的点并不成立**。
   读数怎么念：扫描表回答「门最多能做到多少」，交叉验证回答「这个数能不能信」。**别只看前者。**
2. **门分不开的是哪一种失败，要分桶看**：`AUC(good|bad)` 与 `AUC(good|no_answer)` 分开印。
   今天 `both_frac` 对 `no_answer` 是 0.797、对 `bad` 只有 0.594——**「库里没有」认得出，
   「找到了相近的一份」认不出**，而后者正是新补那 6 条失败样本的形状。
   CRAG 论文（arXiv 2401.15884 §4.2/§4.3）对这个问题的解法是**训一个 0.77B 的评估器**，
   而且即便那样也要留一个 `AMBIGUOUS` 中间档来降低对评估器精度的依赖——
   与本项目「绝不让模型判断检索好不好」的取舍方向一致（那条路要的不是提示词，是训练）。

另外四条**候选信号**（`qcover_k` / `qcover_1` / `vec_gap2` / `src_spread`）也在这里量：
它们**没有**进生产判据（理由同第 1 条），留在表里是因为「哪种信号对哪种失败有用」值得一直看得见。
"""
import random
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
try:  # gbk 控制台 + 长跑：见 docs/testing.md §6.3
    sys.stdout.reconfigure(encoding="utf-8", line_buffering=True)
except Exception:  # noqa: BLE001
    pass

from app.core import evals, indexer, retriever  # noqa: E402
from app.core import retrieval_gate as gate  # noqa: E402
from smoke_rag_eval import NEGATIVE_TAG, load_golden, positives  # noqa: E402

# 第三个字段 = **这条信号进了生产判据没有**（`retrieval_gate.assess` 只用后两个 True 的）。
# 不是一个字段的三种读法：表里混着"线上真在用的"和"只是量着看的"，不标出来就会有人以为
# 门在用 `qcover_k`。
SIGNALS = (
    ("top1", "RRF 最高分", False),
    ("gap13", "top1−top3 分差", False),
    ("gap12", "top1−top2 分差", False),
    ("top1_ch", "top1 命中通道数", False),
    ("both_frac", "top-k 里双通道占比", True),
    ("vec_top1", "向量路原始相似度", True),
    ("n_hits", "返回条数", False),
    # 2026-09-24 加的候选。动机是**分桶**看出来的：门分得开「库里没有、答案不在」，
    # 分不开「找到了相近的一份」——而"相近"通常意味着**问题里那些词没真的落在材料里**。
    ("qcover_k", "问题内容词落在 top-k 的比例", False),
    ("qcover_1", "问题内容词落在 top-1 的比例", False),
    ("vec_gap2", "向量路 top1−top2 之差", False),
    ("src_spread", "top-k 覆盖了几个文件", False),
)


def _content_words(text: str) -> set[str]:
    """内容词：jieba 那把刀（`retriever.tokenize`，与 BM25 同一处）切完，只留带字母/数字的。

    滤掉纯标点是因为它们在"落在材料里没有"这件事上没有信息量，却会稀释比例。
    """
    return {t for t in retriever.tokenize(text) if any(c.isalnum() for c in t)}


def _coverage(query: str, hits: list[dict]) -> dict:
    """问题的内容词有多少真出现在材料里。**候选信号**，没进生产判据。Pure-ish。"""
    q = _content_words(query)
    if not q or not hits:
        return {"qcover_k": 0.0, "qcover_1": 0.0}
    allt: set[str] = set()
    for h in hits:
        allt |= _content_words(h.get("text") or "")
    return {
        "qcover_k": len(q & allt) / len(q),
        "qcover_1": len(q & _content_words(hits[0].get("text") or "")) / len(q),
    }


def _signals(query: str, k: int) -> dict:
    """一把检索 → 候选信号。门只能用**检索结果本身**里的东西（确定性、零成本）。

    `vec_top1` / `both_frac` **直接调生产函数**（`retrieval_gate`），不在这里另算一遍——
    之前这里用 `indexer.search(query, k)[0]["score"]` 单独取向量通道的 top1，实测与生产侧
    差到 **0.0635**（向量通道的 top1 有时被 RRF 融合与 `_diversify` 限块挤掉）。判据的定义
    只能有一处：量法与线上必须是同一个函数、同一份命中，否则阈值搬不过去。
    """
    hits = indexer.search_auto(query, k)
    if not hits:
        return {name: 0.0 for name, _, _ in SIGNALS}
    scores = [float(h.get("score") or 0.0) for h in hits]
    channels = [len(h.get("channels") or []) for h in hits]
    vecs = sorted(
        (float(h["vec"]) for h in hits if isinstance(h.get("vec"), (int, float))), reverse=True
    )
    return {
        "n_hits": float(len(hits)),
        "top1": scores[0],
        "top3": scores[2] if len(scores) >= 3 else 0.0,
        "gap13": scores[0] - (scores[2] if len(scores) >= 3 else 0.0),
        "gap12": scores[0] - (scores[1] if len(scores) >= 2 else 0.0),
        "top1_ch": float(channels[0]),
        "both_frac": gate.both_frac(hits),
        "vec_top1": gate.vec_top1(hits),
        "vec_gap2": (vecs[0] - vecs[1]) if len(vecs) >= 2 else 0.0,
        "src_spread": len({h.get("source") for h in hits}) / len(hits),
        **_coverage(query, hits),
    }


def _auc(good: list[float], bad: list[float]) -> float:
    """秩和口径的 AUC：好样本大于坏样本的概率（并列算 0.5）。O(n²)，n 小无所谓。"""
    if not good or not bad:
        return float("nan")
    wins = sum(1.0 if g > b else 0.5 if g == b else 0.0 for g in good for b in bad)
    return wins / (len(good) * len(bad))


def _quantiles(xs: list[float]) -> str:
    if not xs:
        return "—"
    s = sorted(xs)
    return f"{s[0]:.4f}/{s[len(s) // 2]:.4f}/{s[-1]:.4f}"


def _threshold_table(signal: str, good: list[float], bad: list[float]) -> None:
    """AUC 够的信号给一张阈值表：放行率(好) 要高、误放率(坏) 要低。"""
    cands = sorted({round(v, 4) for v in good + bad})
    if len(cands) > 9:  # 取 9 个等距分位，别把表撑爆
        step = (len(cands) - 1) / 8
        cands = [cands[round(i * step)] for i in range(9)]
    print(f"     阈值({signal})  放行率(好)  误放率(坏)")
    for t in cands:
        passed_good = sum(1 for v in good if v >= t)
        passed_bad = sum(1 for v in bad if v >= t)
        print(
            f"     >= {t:<10.4f} {passed_good / len(good):>9.0%} {passed_bad / len(bad):>11.0%}"
        )


def _sweep_rules(good: list[dict], bad: list[dict]) -> dict:
    """对几种**确定性规则**（单信号 / 两信号取与）扫阈值，回答「门该建成哪条」。

    报法：在「误放率（坏被放行）≤ 上限」的前提下，**好检索的放行率最高**能到多少。
    误放是 RAG 里危险的那一边（该重搜却直接答），所以拿它当约束、放行率当目标。
    规则必须是确定性的、可离线单测的——所以只扫「阈值 + 取与」，不上模型。
    """
    vec_t = sorted({round(r["vec_top1"], 4) for r in good + bad})
    both_t = sorted({round(r["both_frac"], 4) for r in good + bad})
    out: dict = {}
    for cap in (0.05, 0.10, 0.15, 0.20):
        best: tuple[float, float, str] | None = None
        for name, key, ts in (("vec", "vec_top1", vec_t), ("both", "both_frac", both_t)):
            for t in ts:
                g = sum(1 for r in good if r[key] >= t) / len(good)
                b = sum(1 for r in bad if r[key] >= t) / len(bad)
                if b <= cap and (best is None or g > best[0]):
                    best = (g, b, f"{name} ≥ {t}")
        for tv in vec_t:
            for tb in both_t:
                g = sum(1 for r in good if r["vec_top1"] >= tv and r["both_frac"] >= tb) / len(good)
                b = sum(1 for r in bad if r["vec_top1"] >= tv and r["both_frac"] >= tb) / len(bad)
                if b <= cap and (best is None or g > best[0]):
                    best = (g, b, f"vec ≥ {tv} 且 both_frac ≥ {tb}")
        out[cap] = best
    return out


def _grid(rows: list[dict], name: str, n: int = 15) -> list[float]:
    """一条信号的**粗阈值网格**（取分位，最多 n 档）。

    刻意粗：交叉验证要反复拟合几百次，用全量阈值会把「挑了第 37 个分位」这种噪声也当成规则。
    """
    vals = sorted({round(r[name], 4) for r in rows})
    if len(vals) <= n:
        return vals
    step = (len(vals) - 1) / (n - 1)
    return sorted({vals[round(i * step)] for i in range(n)})


def _rule_family(rows: list[dict]) -> list[tuple]:
    """候选规则族：每条信号一个阈值 + 两两取与（只看这几对有动机的组合）。

    **与 `_sweep_rules` 分开是刻意的**：那一张是「上线真会考虑的那两条信号」（vec/both），
    这一张还多带四条候选信号——两张表回答的问题不一样，别混成一张读。
    """
    names = [n for n, _, _ in SIGNALS]
    grids = {n: _grid(rows, n) for n in names}
    rules: list[tuple] = [(n, t, None, 0.0) for n in names for t in grids[n]]
    for a in ("vec_top1", "both_frac", "qcover_k", "qcover_1"):
        for b in ("both_frac", "vec_top1", "qcover_1", "qcover_k"):
            if a >= b:
                continue
            for ta in grids[a]:
                for tb in grids[b]:
                    rules.append((a, ta, b, tb))
    return rules


def _passes(row: dict, rule: tuple) -> bool:
    n, t, n2, t2 = rule
    return row[n] >= t and (n2 is None or row[n2] >= t2)


def _fit(train: list[dict], rules: list[tuple], cap: float):
    """训练折上：**误放率 ≤ 上限**的前提下，放行率最高的那条规则。挑不出来返回 None。"""
    g = [r for r in train if r["good"]]
    b = [r for r in train if not r["good"]]
    if not g or not b:
        return None
    best = None
    for rule in rules:
        if sum(1 for r in b if _passes(r, rule)) / len(b) > cap:
            continue
        gp = sum(1 for r in g if _passes(r, rule))
        if best is None or gp > best[0]:
            best = (gp, rule)
    return best


def _cross_validate(rows: list[dict], rules: list[tuple], caps, repeats: int, folds: int) -> dict:
    """**只在训练折上挑规则，在留出折上算**——扫描表那个数能不能信，就靠这一节。

    分层折（好/坏各自均分）是因为两组样本量差得多（39 vs 24）；40 次重复是为了让
    「分到哪一折」这件事的平均值稳定下来，而不是靠一次划分的运气。
    """
    good = [r for r in rows if r["good"]]
    bad = [r for r in rows if not r["good"]]
    out: dict = {}
    for cap in caps:
        gm, bm = [], []
        for seed in range(repeats):
            rnd = random.Random(seed)
            gsh, bsh = good[:], bad[:]
            rnd.shuffle(gsh)
            rnd.shuffle(bsh)
            tot = [0, 0, 0, 0]
            for f in range(folds):
                held = {id(r) for r in gsh[f::folds]} | {id(r) for r in bsh[f::folds]}
                test = [r for r in gsh[f::folds]] + [r for r in bsh[f::folds]]
                train = [r for r in good + bad if id(r) not in held]
                best = _fit(train, rules, cap)
                if best is None:
                    continue
                tg = [r for r in test if r["good"]]
                tb = [r for r in test if not r["good"]]
                tot[0] += sum(1 for r in tg if _passes(r, best[1]))
                tot[1] += len(tg)
                tot[2] += sum(1 for r in tb if _passes(r, best[1]))
                tot[3] += len(tb)
            if tot[1] and tot[3]:
                gm.append(tot[0] / tot[1])
                bm.append(tot[2] / tot[3])
        out[cap] = (sum(gm) / len(gm), sum(bm) / len(bm), min(gm), max(gm), min(bm), max(bm))
    return out


def main() -> int:
    k = 5
    if "--k" in sys.argv:
        k = int(sys.argv[sys.argv.index("--k") + 1])
    repeats = 20
    if "--cv" in sys.argv:
        repeats = int(sys.argv[sys.argv.index("--cv") + 1])

    items = load_golden()
    pos = positives(items)
    neg = [it for it in items if it["tag"] == NEGATIVE_TAG]
    fp = indexer.stats()
    print("=" * 76)
    print(f"P2 前置 · 质量门可分性（正样本 {len(pos)} 条 + 负样本 {len(neg)} 条，top_k={k}）")
    print(f"索引：{fp['chunks']} 块 / {fp['files']} 文件 · chunker={fp['chunker']} · stale={fp['stale']}")
    print("=" * 76)

    good: list[dict] = []
    bad: list[dict] = []
    for it in pos:
        hits = indexer.search_auto(it["query"], k)
        rank = evals._rank_of(it["expected_source"], hits)
        row = {"tag": it["tag"], "rank": rank, "good": bool(rank), **_signals(it["query"], k)}
        (good if rank else bad).append(row)
    negrows = [
        {"tag": NEGATIVE_TAG, "rank": None, "good": False, **_signals(it["query"], k)} for it in neg
    ]

    print(f"\n三组样本：good {len(good)}（期望源在 top-{k}）/ bad {len(bad)}（没进）/ negative {len(negrows)}（库里没有）")
    print(f"           分档（好/坏）：" + "  ".join(
        f"{t}={sum(1 for r in good if r['tag'] == t)}/{sum(1 for r in bad if r['tag'] == t)}"
        for t in ("lexical", "paraphrase", "competing")
    ))

    print(f"\n{'信号':<12}{'说明':<24}{'good 下/中/上':>24}{'neg 下/中/上':>24}"
          f"{'AUC(好|坏)':>12}{'AUC(好|无答案)':>15}{'AUC(门口径)':>13}")
    print("           （★ = 生产判据真在用的；`bad`/`no_answer` 两列**分开读**——门分不开的是哪一边，就在这里）")
    gate_aucs: list[tuple[float, str]] = []
    for name, desc, shipped in SIGNALS:
        g = [r[name] for r in good]
        b = [r[name] for r in bad]
        n = [r[name] for r in negrows]
        a_bad, a_neg = _auc(g, b), _auc(g, n)
        a_gate = _auc(g, b + n)
        gate_aucs.append((a_gate, name))
        print(
            f"{'★' if shipped else ' '}{name:<11}{desc:<24}{_quantiles(g):>24}{_quantiles(n):>24}"
            f"{a_bad:>12.3f}{a_neg:>15.3f}{a_gate:>13.3f}"
        )

    best_auc, best = max(gate_aucs)
    print(f"\n·· 门口径下最强的信号：{best}（AUC {best_auc:.3f}）")
    if best_auc >= 0.70:
        _threshold_table(best, [r[best] for r in good], [r[best] for r in bad + negrows])
    else:
        print("   AUC < 0.70 —— 按方案的判据，这个信号建不起确定性门。")

    print("\n·· 规则扫描：在「误放率 ≤ 上限」下，好检索的放行率最高能到多少")
    print(f"   {'误放率上限':<12}{'放行率(好)':>12}{'实际误放率':>12}   规则")
    for cap, b in _sweep_rules(good, bad + negrows).items():
        if b is None:
            print(f"   {cap:<12.0%}{'—':>12}{'—':>12}   该上限下没有可行规则")
            continue
        g, bb, rule = b
        print(f"   {cap:<12.0%}{g:>12.0%}{bb:>12.0%}   {rule}")

    print("\n·· 自检：把**要上线的那个门**（`retrieval_gate.assess`）原样跑一遍")
    n_good = n_bad = good_pass = bad_pass = 0
    for it in pos + neg:
        hits = indexer.search_auto(it["query"], k)  # 命中缓存，等于白跑
        ok = gate.assess(hits).ok
        is_good = it["tag"] != NEGATIVE_TAG and evals._rank_of(it["expected_source"], hits) is not None
        if is_good:
            n_good += 1
            good_pass += ok
        else:
            n_bad += 1
            bad_pass += ok
    print(f"   好检索 {n_good} 条：放行 {good_pass}（{good_pass / n_good:.0%}）")
    print(f"   坏检索 {n_bad} 条：误放 {bad_pass}（{bad_pass / n_bad:.0%}）")
    print(f"   （这就是上线的运行点，应当与上面规则扫描里阈值 {gate.VEC_FLOOR} / {gate.BOTH_FLOOR} 那一行一致）")

    n_all = len(good) + len(bad) + len(negrows)
    live_g, live_b = good_pass / n_good, bad_pass / n_bad
    if repeats > 0:
        folds = 5
        rows = good + bad + negrows
        rules = _rule_family(rows)
        sweep = _sweep_rules(good, bad + negrows)
        print(f"\n·· 诚实一点：上面那张扫描表是**样本内最优**——{len(rules)} 条候选规则在同样这 {n_all} 条上取最大，"
              f"白捡几个点很正常。")
        print(f"   同一个规则族放进 {folds} 折 × {repeats} 次重复：**只在训练折上挑、在留出折上算**")
        cv = _cross_validate(rows, rules, (0.10, 0.15, 0.20), repeats, folds)
        print(f"   {'误放上限':<10}{'样本内 放行/误放':>18}{'留出 放行/误放':>18}   各次重复的范围")
        for cap, (gm, bm, gmin, gmax, bmin, bmax) in cv.items():
            in_g, in_b = sweep[cap][0], sweep[cap][1]
            inside = f"{in_g:.0%} / {in_b:.0%}"
            holdout = f"{gm:.0%} / {bm:.0%}"
            print(f"   {cap:<10.0%}{inside:>18}{holdout:>18}"
                  f"   放行 {gmin:.0%}~{gmax:.0%} · 误放 {bmin:.0%}~{bmax:.0%}")
        print(f"   基准 = 现在上线的那个运行点（**拍的、没拟合**，所以它不需要交叉验证）："
              f"放行 {live_g:.0%} / 误放 {live_b:.0%}")
        over = [c for c, (gm, bm, *_) in cv.items() if bm > c]
        win = [c for c, (gm, bm, *_) in cv.items() if gm > live_g and bm < live_b]
        print(f"   → 留出误放率超过扫描表承诺上限的档：{len(over)}/{len(cv)}"
              f"（{'、'.join(f'{c:.0%}' for c in over) if over else '无'}）")
        if not win:
            print("   → **没有一档在留出上同时赢过基准**（放行更高且误放更低）："
                  f"在这 {n_all} 条上再调阈值，调出来的是噪声。")
            print(f"     要动运行点，先扩样本——尤其那 {len(bad)} 条**硬负样本**"
                  f"（门分不开的正是这一边，见上面 AUC 那两列）。")

    print("\nSMOKE PASS ✅（只是度量，不判对错）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
