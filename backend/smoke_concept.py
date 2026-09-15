"""概念归一的标定：同一个概念，两次提取给出的名字，能不能被认出来是同一个。

**为什么需要它。** Q3（形态）的第二个数是「这个领域搞懂过几个概念」，按 `concept`
**精确相等** 分组 + 「不止一场才算学会」。而 `concept` 是模型每次现写的自由文本：
Q3 验收里两场**内容完全相同**的课，模型给出同一个领域（`HNSW`），却给出两个不同的概念名
（「HNSW 层级几何分布抽样」/「HNSW 分层近邻图」）。名字漂了，那根枝就永远长不出来。
所以「要不要把新叫法并进已有概念」是一个**必须先量再决定**的问题，不是拍脑袋加个模糊匹配。

**这个脚本不猜。** 它拿真实 embedder（bge-small-zh-v1.5）算两组配对的分数：

- **该并的**（正样本）：同一个话题的两次（第三次）提取 —— 这是**构造出来的真值**，
  不是我手工标的「我觉得这两个是一个概念」。同一话题跑三次 = 三份名字，两两都该并。
- **不该并的**（负样本）：不同话题之间的名字对，**故意混进同一领域里的两个不同概念**
  （SQLite 的 WAL 模式 vs SQLite 的锁机制）和**同一片技术领域的两个概念**
  （asyncio 事件循环 vs Python GIL）—— 真正难的就是这些，
  因为 bge 把所有中文技术短语挤在一个很窄的锥里，随便两条都有 0.4 以上。

**代价是不对称的，所以尺子要偏保守。** 误并（把两个不同的概念合成一个）会同时污染
「搞懂过几个概念」和召回；漏并只是维持现状。**零误并是硬要求，然后才谈并上多少。**

**正样本是乐观的，而且是个代理指标 —— 这句话要读清楚。** 我用「同一个话题」当「同一个
概念」的真值（因为那是我能构造出来、不用手工标的唯一一种），但两件事并不等同：同一个话题
跑三次，模型完全可能抽出这个话题下的**三个不同侧面**（实测 HNSW 那组就是「HNSW 索引」
「HNSW 分层近邻图」「HNSW 随机分层插入」）。所以：

- 那一列的「漏并」里**有一部分不是漏** —— 它们本来就是不同的概念，不并才对；
- 换句话说真实收益 **≥ 报出来的这个数**，而「零误并」那一列才是承重的那个数。

**正样本同时还是乐观的**：同一话题的重复提取，输入一模一样，差异只来自模型抖动；
真实使用里两场课的内容不同，名字只会差得更远。所以「这条规则能并上」要通过，
先得看它在**最有利**的情况下过不过；它不过，就不用谈真实情况。

跑法（**`--gen` 要花钱**：5 话题 × 3 次 = 15 次提取调用，bge 是本地的不花钱）：
  backend/.venv/Scripts/python.exe smoke_concept.py           # 固定快照 + 本地 embedder，零模型调用
  backend/.venv/Scripts/python.exe smoke_concept.py --gen     # 重跑真实提取刷新快照（写 .tmp-pet/）
  backend/.venv/Scripts/python.exe smoke_concept.py --live    # 再加上你库里真实会话的概念（只读）

安全边界：默认模式与 `--live` **只读**（`--live` 用 `mode=ro` 打开真实库）。`--gen` 必须
指到副本（`WB_DATA_DIR`），它要建会话、花模型调用。
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, ".")
try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:  # noqa: BLE001 - 老 Python 或被重定向时无所谓
    pass

FAIL: list[str] = []

# ---------------------------------------------------------------------------
# 固定快照：**真实提取的输出，原样抄过来**（`--gen` 生成，别手写）。
# 每个话题三次：前两次输入完全相同（只测模型抖动），第三次换成同一概念的另一段自述
# （更接近真实使用：两场课内容不同）。括号里是快照日期。
# ---------------------------------------------------------------------------
SNAPSHOT: list[dict] = [
    {
        "topic": "HNSW 索引在向量库里怎么工作",
        "runs": [
            {
                "concept": "HNSW 索引",
                "domain": "HNSW",
                "aliases": ["向量搜索的分层图怎么导航", "ANN 搜索为什么要分多层", "上层稀疏下层稠密是啥意思"],
                "stuck": "",
            },
            {
                "concept": "HNSW 分层近邻图",
                "domain": "ANN",
                "aliases": ["向量搜索为什么要分很多层", "图索引怎么做近邻搜索", "小世界图怎么用来搜向量"],
                "stuck": "",
            },
            {
                "concept": "HNSW 随机分层插入",
                "domain": "HNSW",
                "aliases": ["向量索引怎么一层层建起来", "插入点怎么选最高层级", "每层的小世界网络怎么形成"],
                "stuck": "以为层级分配是均匀随机而非几何分布",
            },
        ],
    },
    {
        "topic": "SQLite 的 WAL 模式为什么快",
        "runs": [
            {
                "concept": "SQLite WAL 模式",
                "domain": "SQLite",
                "aliases": ["SQLite 怎么做到读写不互相等", "先写日志再改主库的好处", "SQLite 写入时为什么不锁整个文件"],
                "stuck": "以为读者完全不需要读 WAL 文件",
            },
            {
                "concept": "SQLite WAL 模式",
                "domain": "SQLite",
                "aliases": ["SQLite 的写前日志到底快在哪", "SQLite 读写为什么不会互相阻塞", "WAL 模式和回滚日志性能差别"],
                "stuck": "认为WAL快只因读写不阻塞",
            },
            {
                "concept": "SQLite WAL 模式",
                "domain": "SQLite",
                "aliases": ["为什么 SQLite 能同时读写", "预写日志和普通日志有啥区别", "为什么开了 WAL 之后写入变快了"],
                "stuck": "只知顺序写的好处，不知道并发读写才是关键",
            },
        ],
    },
    {
        "topic": "SQLite 的锁机制和锁粒度",
        "runs": [
            {
                "concept": "SQLite 库级锁",
                "domain": "SQLite",
                "aliases": ["SQLite为什么一次只能写入", "SQLite读写是怎么互斥的", "SQLite数据库锁有哪些级别"],
                "stuck": "",
            },
            {
                "concept": "SQLite 锁机制",
                "domain": "SQLite",
                "aliases": [
                    "SQLite 怎么知道有别的进程在写",
                    "SQLite 一个连接开着是不是整个库就锁了",
                    "SQLite 能不能两个进程同时写",
                    "读的时候会不会挡住别人写",
                ],
                "stuck": "",
            },
            {
                "concept": "SQLite 文件级锁",
                "domain": "SQLite",
                "aliases": ["SQLite 怎么加锁", "SQLite 为什么写很慢", "SQLite 并发写怎么解决", "SQLite 支持行锁吗"],
                "stuck": "",
            },
        ],
    },
    {
        "topic": "asyncio 的事件循环什么时候切换协程",
        "runs": [
            {
                "concept": "asyncio 事件循环调度",
                "domain": "asyncio",
                "aliases": ["await 之后什么时候恢复执行", "协程切换的时机是什么", "事件循环按什么顺序处理任务"],
                "stuck": "以为所有就绪回调跑完才统一恢复原协程",
            },
            {
                "concept": "asyncio 事件循环协程切换",
                "domain": "asyncio",
                "aliases": [
                    "await 之后控制权怎么回到事件循环的",
                    "协程在什么条件下把 CPU 让出来",
                    "事件循环靠什么决定下一个跑谁",
                ],
                "stuck": "",
            },
            {
                "concept": "asyncio 事件循环调度",
                "domain": "asyncio",
                "aliases": ["asyncio 什么时候切换任务", "事件循环怎么决定下一步跑谁", "单线程里多个协程怎么交替执行"],
                "stuck": "以为切换只由 epoll 就绪触发",
            },
        ],
    },
    {
        "topic": "Python 的 GIL 是怎么限制多线程的",
        "runs": [
            {
                "concept": "CPython GIL",
                "domain": "CPython",
                "aliases": ["为什么多线程跑Python不并行", "Python线程池为什么没加速", "全局锁怎么限制多线程执行"],
                "stuck": "",
            },
            {
                "concept": "CPython GIL",
                "domain": "CPython",
                "aliases": [
                    "为什么 Python 多线程跑不快",
                    "全局互斥锁到底锁住了什么",
                    "有核多的机器上为什么没提速",
                    "线程怎么就被串行执行了",
                ],
                "stuck": "",
            },
            {
                "concept": "CPython GIL 全局解释器锁",
                "domain": "CPython",
                "aliases": ["为什么Python多线程跑不出多核效果", "Python那个全局锁怎么卡线程的", "多线程只能串行跑的原因"],
                "stuck": "以为GIL只在IO阻塞时才释放，忽略了5ms时间片也会切锁",
            },
        ],
    },
]

# 2026-09-15 生成（`--gen`，15 次提取调用，模型 sensenova/sensenova-6.8-flash-lite）。
# 两次输入**逐字相同**、第三次换同一概念的另一段自述。生成出来的第一件事就值得记：
# **领域词自己也会漂** —— HNSW 那组三次里有一次给了 `ANN` 而不是 `HNSW`，
# 尽管 `_EXTRACT_PROMPT` 明说「同一个领域每次必须一模一样」。所以任何「先要求领域相同」
# 的规则都会把这组正样本判成不该并（见规则 F 的漏并）。
SNAPSHOT_NOTE = "2026-09-15 · 5 话题 × 3 次真实提取（15 次调用）"

# 该并的硬要求：零误并。区间只报事实，不设「至少并上 N 个」这种目标。
SAME = "该并"
DIFF = "不该并"

# 2026-09-15 那批数据里，「不该并」那一侧**只比 concept 时**的最高分。线上阈值必须高出它，
# 而且余量要写在明面上 —— 常数和实测对不上就等于注释在骗人（照 smoke_recall.py 的做法）。
MEASURED_NEG_CEILING = 0.700
MIN_MARGIN = 0.05  # 阈值与天花板之间至少留这么多；否则一条没见过的负样本就能翻过去


# ---------------------------------------------------------------------------
# 几种候选规则。每条 = (名字, 判定函数)。判定函数吃两个「名字集」：
#   {"concept": 规范名, "aliases": [其他叫法], "domain": 领域词}
# 返回 True = 认为这两个是同一个概念。
#
# 为什么要列这么多：模糊相似度是**有代价**的（误并会污染掌握判定与召回），
# 所以先把确定性的几条摆出来 —— 它们过了就不需要向量。
# ---------------------------------------------------------------------------

# 确定性规则的实现**直接引用产品里那一份**（`tutor.norm_concept` / `tutor._contains`）：
# 尺子和产品必须是同一把，脚本另写一份就等于在量别的东西。
_PUNCT = "，。、；：！？,.，;:!?（）()《》<>「」『』\"'`~·-—_ 　"


def norm(text: str) -> str:
    """产品的归一化（薄壳，只为在下面读起来短一点）。"""
    from app.core.tutor import norm_concept

    return norm_concept(text)


def _texts(name_set: dict) -> list[str]:
    """一个概念的全部待比文本：规范名一条 + 每个别名各一条。

    照 `tutor.recall_hits` 的拼法（每个别名各成一条向量、取 max）——
    那一版是 2026-09-06 量出来的（整行一条会把唯一对得上的那条稀释掉）。
    """
    return [t for t in [name_set.get("concept", ""), *(name_set.get("aliases") or [])] if t.strip()]


def rule_exact(a: dict, b: dict) -> bool:
    """A 现状：概念名一字不差。"""
    return a.get("concept", "") == b.get("concept", "")


def rule_norm(a: dict, b: dict) -> bool:
    """B 归一化后相等（不花钱、不可能误并）。"""
    return bool(norm(a.get("concept", ""))) and norm(a["concept"]) == norm(b.get("concept", ""))


def rule_contain(a: dict, b: dict) -> bool:
    """C 一个包含另一个（产品里那一份 `tutor._contains`：只认两头、且要够长）。"""
    from app.core.tutor import _contains

    return _contains(a.get("concept", ""), b.get("concept", ""))


def _cos(a: str, b: str) -> float:
    from app.core import embedder
    from app.core.tutor import _cosine

    return _cosine(embedder.embed([a])[0], embedder.embed([b])[0])


# 向量只算一次：15 个名字集 × 5 条文本，比「每对配对各算一次」少两个数量级
_VECS: dict[int, list[list[float]]] = {}


def _vecs(name_set: dict) -> list[list[float]]:
    from app.core import embedder

    key = id(name_set)
    if key not in _VECS:
        texts = _texts(name_set)
        _VECS[key] = embedder.embed(texts) if texts else []
    return _VECS[key]


def _maxcos(a: dict, b: dict) -> float:
    """两边所有文本两两取 max —— 照 `tutor.recall_hits` 的拼法。Pure（向量已缓存）。"""
    from app.core.tutor import _cosine

    va, vb = _vecs(a), _vecs(b)
    if not va or not vb:
        return 0.0
    return max(_cosine(x, y) for x in va for y in vb)


def _concossim(a: dict, b: dict) -> float:
    """只比 concept 那一条。"""
    from app.core.tutor import _cosine

    va, vb = _vecs(a), _vecs(b)
    if not va or not vb:
        return 0.0
    return _cosine(va[0], vb[0])


def rule_cos(floor: float):
    """D 只看 concept 那条文本。"""

    def f(a: dict, b: dict) -> bool:
        return _concossim(a, b) >= floor

    return f


def rule_cos_max(floor: float):
    """E 照线上召回的拼法：两边所有文本两两取 max。"""

    def f(a: dict, b: dict) -> bool:
        return _maxcos(a, b) >= floor

    return f


def rule_cos_same_domain(floor: float):
    """F E + 必须同一个领域词（领域是提取时就被要求「每次写成同一个词」的那个）。"""
    base = rule_cos_max(floor)

    def f(a: dict, b: dict) -> bool:
        da, db = (a.get("domain") or "").strip(), (b.get("domain") or "").strip()
        return bool(da) and da == db and base(a, b)

    return f


# ---------------------------------------------------------------------------
# 打分：把快照拆成配对
# ---------------------------------------------------------------------------


def pairs() -> tuple[list[tuple[dict, dict, str]], list[tuple[dict, dict, str]]]:
    """-> (该并的配对, 不该并的配对)，每项 = (甲, 乙, 说明)。Pure."""
    pos: list[tuple[dict, dict, str]] = []
    neg: list[tuple[dict, dict, str]] = []
    for topic in SNAPSHOT:
        runs = topic.get("runs") or []
        for i in range(len(runs)):
            for j in range(i + 1, len(runs)):
                pos.append((runs[i], runs[j], f"{topic['topic']}（第 {i + 1} 次 vs 第 {j + 1} 次）"))
    for i, t1 in enumerate(SNAPSHOT):
        for t2 in SNAPSHOT[i + 1 :]:
            for a in t1.get("runs") or []:
                for b in t2.get("runs") or []:
                    neg.append((a, b, f"{t1['topic']} × {t2['topic']}"))
    return pos, neg


def shipped(a: dict, b: dict) -> bool:
    """**线上那一条**：先归一化相等，再一个包含另一个，最后 concept 一条向量过线。

    顺序与 `tutor.canonical_concept()` 一致 —— 尺子量的必须是产品真正会走的那条路。
    """
    from app.core.tutor import CONCEPT_MERGE_SIM, _contains

    na, nb = norm(a.get("concept", "")), norm(b.get("concept", ""))
    if na and na == nb:
        return True
    if _contains(a.get("concept", ""), b.get("concept", "")):
        return True
    return _concossim(a, b) >= CONCEPT_MERGE_SIM


def evaluate(name: str, decide, pos, neg, verbose: bool = True, judge: bool = False) -> dict:
    """一条规则的代价：并上了多少该并的，误并了多少不该并的。

    `judge=True` 才会 FAIL —— 候选规则之间互相比是**证据**（比如「别名在这件事上帮倒忙」
    就是从这个表里看出来的），只有线上那一条的误并才算产品的问题。
    """
    hit = [d for a, b, d in pos if decide(a, b)]
    miss = [(a, b, d) for a, b, d in pos if not decide(a, b)]
    fire = [(a, b, d) for a, b, d in neg if decide(a, b)]
    print(
        f"  {name:<30} 该并 {len(hit):>2}/{len(pos):<2}  误并 {len(fire):>2}/{len(neg):<3}"
        f"  {'←' if not fire and hit else ''}"
    )
    if verbose:
        for a, b, d in fire:
            print(f"        误并 {a['concept']}  ⊕  {b['concept']}   （{d}）")
        for a, b, d in miss:
            print(f"        漏并 {a['concept']}  ⊘  {b['concept']}   （{d}）")
    if judge and fire:
        FAIL.append(f"{name} 误并 {len(fire)} 对")
    return {"hit": len(hit), "miss": len(miss), "fire": len(fire)}


def score_window(verbose: bool = True) -> dict:
    """该并的最低分 vs 不该并的最高分 —— 有没有阈值能分开它们。

    这里**不下结论**：两条分布重叠是这批数据的事实（也是「不追求全并上」的理由），
    但线上那条规则不要求全并上。判决在 `judged_shipped()` 里。
    返回两个「最高分」供后面用。
    """
    pos, neg = pairs()
    if not pos or not neg:
        print("  快照为空 —— 先跑 --gen")
        return {}

    out: dict[str, float] = {}
    for label, fn in (
        ("只比 concept 一条", _concossim),
        ("concept + 每个别名取 max（线上召回那种）", _maxcos),
    ):
        p = sorted(fn(a, b) for a, b, _ in pos)
        n = sorted(fn(a, b) for a, b, _ in neg)
        lo, hi = p[0], n[-1]
        print(f"\n  {label}")
        print(f"    该并   n={len(p):<3} 最低 {lo:.3f}  中位 {p[len(p) // 2]:.3f}")
        print(f"    不该并 n={len(n):<3} 最高 {hi:.3f}  中位 {n[len(n) // 2]:.3f}")
        if hi >= lo:
            print(f"    可用区间 **不存在**（不该并的最高 {hi:.3f} ≥ 该并的最低 {lo:.3f}）")
            print("    → 所以线上不追求「该并的全并上」；剩下那几对由人指认（merge_concepts）")
        else:
            print(f"    可用区间 [{hi:.3f}, {lo:.3f}]  宽 {lo - hi:+.3f}")
        if verbose and "concept 一条" in label:
            worst = sorted(((fn(a, b), a["concept"], b["concept"]) for a, b, _ in pos))[:3]
            for s, x, y in worst:
                print(f"      最低的该并 {s:.3f}  {x} ⊘ {y}")
            top = sorted(((fn(a, b), a["concept"], b["concept"], d) for a, b, d in neg), reverse=True)[:3]
            for s, x, y, d in top:
                print(f"      最高的不该并 {s:.3f}  {x} ⊕ {y}   （{d}）")
        out[label] = hi
    return out


def judged_shipped(ceilings: dict) -> None:
    """**判决**：线上那一条规则在零误并下并上了多少，余量有多大。

    两条硬要求，与召回那次同一种：
    1. 误并必须是 0（并错会同时污染「搞懂过几个概念」和召回，比漏并贵得多）；
    2. 阈值必须高出实测的不该并天花板至少 `MIN_MARGIN`，否则一条没见过的负样本就翻过去。
    """
    from app.core.tutor import CONCEPT_MERGE_SIM

    pos, neg = pairs()
    r = evaluate(f"线上：C/D @ {CONCEPT_MERGE_SIM}", shipped, pos, neg, verbose=True, judge=True)
    print(f"    该并 {r['hit']}/{len(pos)}、漏 {r['miss']} 对 —— 漏的那些由人指认，不是失败")

    ceiling = ceilings.get("只比 concept 一条")
    if ceiling is not None:
        if abs(ceiling - MEASURED_NEG_CEILING) <= 0.02:
            print(f"  ok   不该并天花板与记录一致（实测 {ceiling:.3f}，记的 {MEASURED_NEG_CEILING}）")
        else:
            FAIL.append(
                f"不该并天花板飘了：实测 {ceiling:.3f}，注释写的 {MEASURED_NEG_CEILING} —— 阈值要重定"
            )
    margin = CONCEPT_MERGE_SIM - MEASURED_NEG_CEILING
    if margin >= MIN_MARGIN:
        print(f"  ok   余量 {margin:+.3f} ≥ {MIN_MARGIN}（阈值 {CONCEPT_MERGE_SIM} − 天花板 {MEASURED_NEG_CEILING}）")
    else:
        FAIL.append(f"余量不足：{margin:+.3f} < {MIN_MARGIN}")


def live_concepts() -> list[dict]:
    """真实库里的 (concept, aliases, domain)，只读打开。

    用 sqlite3 而不是 ORM：`mode=ro` 是这里唯一在意的事（照 `smoke_recall.py`）。
    """
    import sqlite3

    from app.config import settings

    path = Path(settings.db_path)
    if not path.is_file():
        return []
    con = sqlite3.connect(f"file:{path.as_posix()}?mode=ro", uri=True)
    try:
        rows = con.execute(
            "SELECT concept, aliases, domain, topic FROM tutor_sessions"
            " WHERE verdict IN ('got','half') AND concept <> '' ORDER BY id"
        ).fetchall()
    except sqlite3.OperationalError:
        rows = [
            (c, a, "", t)
            for c, a, t in con.execute(
                "SELECT concept, aliases, topic FROM tutor_sessions"
                " WHERE verdict IN ('got','half') AND concept <> '' ORDER BY id"
            ).fetchall()
        ]
    except sqlite3.Error as e:
        print(f"    读不到 tutor_sessions（{e}）")
        return []
    finally:
        con.close()
    from app.core.tutor import ALIAS_SEP

    return [
        {"concept": c, "aliases": [x for x in (a or "").split(ALIAS_SEP) if x.strip()], "domain": d, "topic": t}
        for c, a, d, t in rows
    ]


def live_check() -> None:
    """你库里真实的概念之间，归一会不会并错。

    真值不是构造的（我不知道你哪两场说的是同一个概念），所以这里**只报事实**：
    哪些对会被并上、分数多少、都是什么话题 —— 判断留给你看。
    """
    rows = live_concepts()
    if len(rows) < 2:
        print(f"    只有 {len(rows)} 条带概念的会话，还不够互相比。")
        return
    print(f"    {len(rows)} 条会话，{len(set(r['concept'] for r in rows))} 个不同概念名")
    from app.core import embedder
    from app.core.tutor import _cosine

    for r in rows:
        _vecs(r)
    for i in range(len(rows)):
        for j in range(i + 1, len(rows)):
            if rows[i]["concept"] == rows[j]["concept"]:
                continue
            s = _maxcos(rows[i], rows[j])
            mark = "并" if s >= 0.80 else " ·"
            print(
                f"    {mark} {s:.3f}  {rows[i]['concept'][:22]:<22} ⊕ {rows[j]['concept'][:22]:<22}"
                f" 〔{rows[i]['domain'] or '-'} / {rows[j]['domain'] or '-'}〕"
            )
    del embedder, _cosine


# ---------------------------------------------------------------------------
# 生成快照（要花钱）
# ---------------------------------------------------------------------------

GEN_TOPICS: list[tuple[str, list[str]]] = [
    (
        "HNSW 索引在向量库里怎么工作",
        [
            "HNSW 就是分层的近邻图：上层稀疏负责长途跳，下层稠密负责收尾。",
            "图上每一层都是一个小世界网络，插入的时候随机决定这个点最高进到第几层。",
        ],
    ),
    (
        "SQLite 的 WAL 模式为什么快",
        [
            "WAL 是写前日志：先追加到日志文件，读的人照旧读主库，所以读写不互相阻塞。",
            "它把随机写变成了顺序追加，checkpoint 的时候才把改动并回主库。",
        ],
    ),
    (
        "SQLite 的锁机制和锁粒度",
        [
            "SQLite 的锁是整库级的：SHARED 和 EXCLUSIVE 之间还有 RESERVED 和 PENDING。",
            "同一时刻只能有一个写事务，所以它没有行锁这个说法。",
        ],
    ),
    (
        "asyncio 的事件循环什么时候切换协程",
        [
            "遇到 await 让出控制权，事件循环把就绪的回调排进队列，跑完再切回来。",
            "它本质是一个单线程里的轮询：epoll 说哪些 fd 就绪，就唤醒对应的协程。",
        ],
    ),
    (
        "Python 的 GIL 是怎么限制多线程的",
        [
            "GIL 是一把全局互斥锁，同一时刻只有一个线程能执行字节码。",
            "所以 CPU 密集的多线程跑不满多核，IO 等待的时候才会放锁给别人。",
        ],
    ),
]


async def gen() -> int:
    """真实跑一遍提取，把输出打印成可以直接抄进 SNAPSHOT 的 JSON。

    **要花钱**：每个话题 len(turns) 次提取调用。用副本库（`WB_DATA_DIR`），别指真库。
    """
    from app.config import settings

    print(f"  数据库 {settings.db_path}")
    if "q3" not in str(settings.db_path) and "tmp" not in str(settings.db_path).lower():
        print("  拒绝生成：库看起来不是副本（--gen 会建会话、花调用）—— 先设 WB_DATA_DIR")
        return 2

    from app.core import providers, tutor
    from app.db import engine
    from app.models import Base

    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    # 副本是从真库拷的，`create_all` **不给老表加列** —— 必须走应用自己那条迁移。
    # 这条裂缝（迁移无版本）就是 upgrade-plan 的 P0；这里只是不重复一份 DDL。
    from app.main import _migrate  # noqa: SLF001

    await _migrate()

    model = providers.default_model_id() or ""
    print(f"  模型 {model}")
    if not model:
        print("  没有可用模型：先在设置里配一个 provider")
        return 2

    out: list[dict] = []
    for topic, turns in GEN_TOPICS:
        runs = []
        # 前两次输入**完全一样**（只测模型抖动），第三次换一段自述（更像真实使用）
        seq = [turns[0], turns[0], turns[1]]
        for k, turn in enumerate(seq):
            sid = (await tutor.start(topic))["id"]
            await tutor.add_turn(sid, "user", turn)
            concept, aliases, stuck, transfer, domain = await tutor._extract(sid, topic, model)
            print(f"    [{k + 1}/3] {topic[:20]:<20} → {concept!r} 领域 {domain!r}")
            runs.append(
                {
                    "concept": concept,
                    "domain": domain,
                    "aliases": [x for x in aliases.split(tutor.ALIAS_SEP) if x.strip()],
                    "stuck": stuck,
                }
            )
        out.append({"topic": topic, "runs": runs})

    text = json.dumps(out, ensure_ascii=False, indent=2)
    path = Path("../.tmp-pet/concept_snapshot.json")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text + "\n", encoding="utf-8")
    print(f"\n  写好了：{path}")
    print("  把下面这段抄进 smoke_concept.py 的 SNAPSHOT（原样，别手改）：\n")
    print(text)
    return 0


def main() -> int:
    if "--gen" in sys.argv:
        import asyncio

        return asyncio.run(gen())

    from app.core import embedder

    print(f"== 0 参数\n  embedder={embedder.MODEL_NAME}  快照={SNAPSHOT_NOTE}")
    if not SNAPSHOT:
        print("\n  快照是空的：先跑 `--gen`（要花钱），再把输出抄进 SNAPSHOT。")
        return 1

    pos, neg = pairs()
    print(f"  配对：该并 {len(pos)} 对（同一话题的重复提取）· 不该并 {len(neg)} 对（跨话题）")

    print("\n== 1 确定性规则（不花钱，不可能误并）")
    for name, fn in (("A 现状：一字不差", rule_exact), ("B 归一化后相等", rule_norm), ("C 一个包含另一个", rule_contain)):
        evaluate(name, fn, pos, neg)

    print("\n== 2 向量规则：先看有没有可用区间")
    ceilings = score_window()

    print("\n== 3 候选规则在各阈值上的代价（这些是证据，不是判决）")
    for floor in (0.70, 0.75, 0.80, 0.85, 0.90):
        evaluate(f"D 只比 concept @ {floor}", rule_cos(floor), pos, neg, verbose=False)
    for floor in (0.70, 0.75, 0.80, 0.85, 0.90):
        evaluate(f"E concept+别名 max @ {floor}", rule_cos_max(floor), pos, neg, verbose=False)
    for floor in (0.75, 0.80, 0.85):
        evaluate(f"F E + 同领域 @ {floor}", rule_cos_same_domain(floor), pos, neg, verbose=False)

    print("\n== 4 线上那一条（判决）")
    judged_shipped(ceilings)

    print("\n== 5 你库里真实的概念")
    if "--live" in sys.argv:
        live_check()
    else:
        print("    跳过（加 --live 才读真实库）")

    print("\n== 结果")
    if FAIL:
        print(f"  CALIBRATION FAIL — {len(FAIL)} 项：")
        for f in FAIL:
            print(f"    · {f}")
        return 1
    print("  CALIBRATION PASS — 有一条规则零误并且并上了该并的")
    return 0


if __name__ == "__main__":
    sys.exit(main())
