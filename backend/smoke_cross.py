"""topic ↔ 概念 的**语义关联**校准，可重复跑（PLAN2 P2-2）。

**为什么先量再定。** PLAN2 P2-2 只写了一句「加 embedding 余弦兜底（阈值用
`tutor.RECALL_MIN_SIM` 同款纪律：先测噪声天花板再定）」。那句话的含义就是这一页：
名字对名字的余弦**不能照着召回那个 0.62 抄**——那里比的是「一句话问法 × 一段会话记录」，
这里比的是「一个话题词 × 一个概念名」，两边的文本长度与信息量都不一样。
`RECALL_MIN_SIM` 的注释里那句「bge-small-zh 把所有短中文技术短语挤在一个很窄的锥里」
在这里只会更严重。

**这一跑（2026-09-16，bge-small-zh-v1.5）的结论是：不上线。** 不是「还没做」——
按纪律量完，答案是没有可用阈值：

    · 候选拼法照线上（概念名 + 别名各一条取 max）后，正样本最低 0.579、中位 0.735；
      负样本最高 0.780、中位 0.426。**两条分布重叠约 0.2。**
    · 阈值扫过 0.3–0.95，**没有一行是「该中的没被吞 且 不该中的没过线」**：
      0.6 → 吞 2 条正样本、放过 11 条负样本；0.7 → 吞 5 条、放过 3 条；0.8 → 吞 10 条、放过 0 条。
    · 放过的那几条不是「噪声」，是**真的语义近邻**：「SQLite 锁机制」→「SQLite WAL 模式」
      (0.700)、「MySQL 的事务隔离级别和 PG 有什么不同」→「关系型数据库的事务隔离级别」
      (0.780)。模型分不开「同一件事」和「隔壁那件事」——而这里要的正是那个区分。
    · 当**排序**用它还行：不设阈值、永远取最近的那个，13 条正样本里 12 条落对概念。
      但那一栏没有阈值，15 条负样本也全会落到某个概念上——**接错比不接坏得多**：
      错的那个会把「已掌握」标到别的概念上，T1 那句台词与地图摘要都会跟着说错话。

所以这个脚本现在守的是一个**「不许上线」的结论**：谁要往 `cross.match_topic` 里加余弦
兜底，先跑它——分数分布还在这儿，改口径改不动它。

跑法：
  backend/.venv/Scripts/python.exe smoke_cross.py

安全边界：只读本地 embedder，不碰库、不碰 vault、不发网络请求。
"""
import sys
from pathlib import Path

sys.path.insert(0, ".")
try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:  # noqa: BLE001
    pass

FAIL: list[str] = []

# 概念池：形状照 `tutor_sessions.concept` / `aliases` 存的那样（真实跑出来的那种叫法）。
# 10 个概念覆盖五个领域，**故意让同领域里有一对相邻概念**（SQLite 的 WAL 与索引、
# asyncio 的事件循环与 await 语义）——它们就是最难的那几个负样本。
POOL: list[tuple[str, list[str]]] = [
    ("asyncio 事件循环", ["event loop 调度", "协程什么时候切换"]),
    ("Python GIL", ["全局解释器锁", "多线程为什么没变快"]),
    ("SQLite WAL 模式", ["写前日志", "读和写互不阻塞"]),
    ("SQLite 索引最左前缀", ["联合索引的顺序", "为什么跳列就不走索引"]),
    ("JS 闭包", ["内层函数为什么能拿到外层变量", "lexical scope 捕获"]),
    ("React useEffect 依赖数组", ["effect 里读到过期的值", "effect 什么时候重跑"]),
    ("RRF 混合检索融合", ["两路结果怎么合成一个排名", "关键词和向量分数量纲不同"]),
    ("B+ 树为什么适合做索引", ["磁盘页和树高", "范围查询为什么快"]),
    ("关系型数据库的事务隔离级别", ["脏读和幻读", "可重复读到底锁什么"]),
    ("Docker 镜像分层与缓存", ["为什么改一行就全量重建", "层是怎么复用的"]),
]

# (卡片上的话题词, 本该落到第几个概念 / None = 一个都不该落)
#
# 正样本选的全是**确定性规则接不住**的那些（否则量的是 `_contains`，不是向量）：
# 跨语言、同义改写、现象描述。这一栏的判据是「人会说他讲的是同一件事」。
POSITIVE: list[tuple[str, int]] = [
    ("asyncio 的 event loop", 0),  # 跨语言：包含规则接不住
    ("协程挂起之后谁接着跑", 0),
    ("多线程为什么跑不满 CPU", 1),  # 现象 → 术语
    ("CPython 的线程限制", 1),
    ("SQLite 并发写入是怎么排队的", 2),
    ("写前日志", 2),
    ("联合索引为什么要按顺序写条件", 3),
    ("函数返回之后局部变量为什么还活着", 4),
    ("组件重渲染之后 effect 里的 state 还是老的", 5),
    ("关键词检索和向量检索的结果怎么排在一起", 6),
    ("为什么数据库索引用 B+ 树而不是二叉树", 7),
    ("脏读和不可重复读差在哪", 8),
    ("为什么改一行 Dockerfile 就全量重建", 9),
]

# 负样本。**同领域隔壁概念**在最前面：那是真正难的几个（bge 会把它们挤得很近）。
# `ADJACENT` 标出的那几条就是「同一块知识里的另一件事」——天花板主要由它们造成。
# 它们必须留在负样本里：把这几条挪走，两条分布立刻变得漂亮，而这个脚本也就白跑了。
ADJACENT: list[str] = [
    "SQLite 索引为什么没走",
    "SQLite 锁机制",
    "await 到底把控制权交给了谁",
    "Python 多进程怎么共享内存",
    "React 的 key 是干什么的",
    "MySQL 的事务隔离级别和 PG 有什么不同",
]
NEGATIVE: list[str] = [
    *ADJACENT,
    "React 状态管理该选哪个库",
    "CSS 的层叠上下文",  # 前端，但完全另一件事
    "BM25 的打分公式",  # 贴检索融合那一侧
    "向量数据库怎么选",
    "Rust 的所有权和借用检查",
    "怎么用 ffmpeg 把 mp4 转成 gif",
    "唐诗里的意象怎么读",
    "这周该怎么安排时间",
    "磁盘 IO 和内存带宽",  # 贴 B+ 树那侧的「磁盘页」
]


def ok(label: str, detail: str = "") -> None:
    print(f"  ok   {label}" + (f" — {detail}" if detail else ""))


def bad(label: str, detail: str = "") -> None:
    FAIL.append(label)
    print(f"  FAIL {label}" + (f" — {detail}" if detail else ""))


def head(title: str) -> None:
    print(f"\n== {title}")


# 候选阈值扫一遍：每个操作点上「漏掉多少该中的 / 放过多少不该中的」。
# **这一栏就是「有没有可用阈值」的全部答案**——两个数不可能同时为 0 时，就没有。
SWEEP = [round(0.10 * i, 2) for i in range(3, 10)] + [0.95]


def main() -> int:
    from app.core import cross, embedder
    from app.core.tutor import ALIAS_SEP  # noqa: F401  (与线上同一个分隔符，留个念想)
    from app.core.tutor import _cosine

    head("0 参数")
    print(f"  embedder={embedder.MODEL_NAME}")
    print(f"  样本：{len(POSITIVE)} 该命中 + {len(NEGATIVE)} 必不中，概念池 {len(POOL)} 个")
    print("  候选文本的拼法照线上：**概念名 + 每个别名各一条，取 max**（同 `tutor.recall_hits` 的 E 拼法）")

    head("1 先看确定性规则接住了几条（接住的那些不该算在向量头上）")
    names = {c: set(a) for c, a in POOL}
    det_pos = [t for t, _ in POSITIVE if cross.match_topic(t, names)]
    det_neg = [t for t in NEGATIVE if cross.match_topic(t, names)]
    print(f"  正样本里被包含规则接住的：{len(det_pos)}/{len(POSITIVE)} {det_pos}")
    print(f"  负样本里被包含规则误接的：{len(det_neg)}/{len(NEGATIVE)} {det_neg}")
    if det_neg:
        bad("包含规则不误接", f"{det_neg} —— 这些会在向量那一步之前就落错概念")

    # 题目：话题 × 概念池的余弦矩阵。方向与拼法都照线上：query = 话题词，
    # 每个概念的候选文本 = 概念名 + 它的别名，**取 max**（别名那一条常常才是对得上的）。
    texts = [t for t, _ in POSITIVE] + NEGATIVE
    vq = embedder.embed(texts)
    cand, owner = [], []
    for i, (name, aliases) in enumerate(POOL):
        for text in (name, *aliases):
            cand.append(text)
            owner.append(i)
    vc = embedder.embed(cand)
    mat = [[0.0] * len(POOL) for _ in texts]
    for qi, q in enumerate(vq):
        for v, i in zip(vc, owner):
            mat[qi][i] = max(mat[qi][i], _cosine(q, v))

    true_s: list[float] = []
    for k, (_t, want) in enumerate(POSITIVE):
        true_s.append(mat[k][want])
    false_s: list[float] = []
    for k, (_t, want) in enumerate(POSITIVE):  # 正样本 × 别的概念
        false_s += [s for i, s in enumerate(mat[k]) if i != want]
    for k in range(len(POSITIVE), len(texts)):  # 全部负样本
        false_s += mat[k]

    head("2 两条分布（话题词 → 概念名 + 别名，取 max）")
    st, sf = sorted(true_s), sorted(false_s)
    lo_true, hi_false = min(true_s), max(false_s)

    def med(xs: list[float]) -> float:
        return xs[len(xs) // 2]

    print(f"  本该命中 n={len(true_s):<3} 最低 {lo_true:.3f}  中位 {med(st):.3f}  最高 {st[-1]:.3f}")
    print(f"  不该命中 n={len(false_s):<3} 最高 {hi_false:.3f}  中位 {med(sf):.3f}")
    print(f"  可用区间 [{hi_false:.3f}, {lo_true:.3f}]（宽 {lo_true - hi_false:+.3f}）")
    if hi_false >= lo_true:
        bad(
            "两条分布不重叠",
            f"不该中的最高 {hi_false:.3f} ≥ 该中的最低 {lo_true:.3f}：**没有阈值能分开**",
        )
    else:
        ok("两条分布不重叠", f"可用区间宽 {lo_true - hi_false:.3f}")

    head("3 阈值扫一遍：有没有哪个操作点两边都干净")
    print(f"  {'阈值':>5} {'该中的被吞':>10} {'不该中的过线':>12}")
    clean: list[float] = []
    for f in SWEEP:
        miss = sum(1 for s in true_s if s < f)
        fire = sum(1 for s in false_s if s >= f)
        print(f"  {f:>5} {miss:>10} {fire:>12}{'   ← 两边都干净' if miss == 0 and fire == 0 else ''}")
        if miss == 0 and fire == 0:
            clean.append(f)
    if not clean:
        bad("存在一个两边都干净的操作点", "整张表里没有一行是 0 / 0 —— 这一层买不到")
    else:
        ok("存在一个两边都干净的操作点", f"{clean}")

    head("3b 天花板是谁造成的（前 5 高的误报）")
    errors = sorted(
        (
            (mat[len(POSITIVE) + k][i], topic, POOL[i][0], topic in ADJACENT)
            for k, topic in enumerate(NEGATIVE)
            for i in range(len(POOL))
        ),
        reverse=True,
    )
    for s, topic, concept, adj in errors[:5]:
        print(f"    {s:.3f}  {topic[:30]:<30} → {concept}{'   ← 同领域隔壁概念' if adj else ''}")
    top_adjacent = next((s for s, _t, _c, adj in errors if adj), 0.0)
    top_unrelated = next((s for s, _t, _c, adj in errors if not adj), 0.0)
    print(f"  隔壁概念造成的天花板 {top_adjacent:.3f}；完全无关话题造成的 {top_unrelated:.3f}")
    if top_unrelated >= top_adjacent:
        print("  （无关话题比隔壁概念还近——那不是「难」，那是噪声本身高）")

    head("4 逐条：第一名是谁、领先第二名多少（「有歧义就不匹配」的依据）")
    lead = 0.05
    wrong, hit_pos = 0, 0
    for k, (topic, want) in enumerate([*POSITIVE, *((t, -1) for t in NEGATIVE)]):
        row = mat[k]
        order = sorted(range(len(row)), key=lambda i: row[i], reverse=True)
        i0, i1 = order[0], order[1]
        margin = row[i0] - row[i1]
        hit = i0 == want and want >= 0
        hit_pos += hit
        print(
            f"    {row[i0]:.3f} 领先 {margin:+.3f}  {topic[:30]:<30} → {POOL[i0][0]}"
            f"{'' if hit else ('   ← 一条都不该落' if want < 0 else f'   ← 该落 {POOL[want][0]}')}"
        )
        wrong += 0 if hit else 1
    print(f"  不设阈值（永远取最近的那个）：落对 {hit_pos}/{len(POSITIVE)}；剩下 {wrong - hit_pos} 条落错或误报")
    print("  ⚠️ 这一节**没有用阈值**：它说明的是「最近的那个往往就是对的」，而第 2、3 节说明的是")
    print("     「它有多近」分不开——两件事不是一回事，这是这一层最容易被误读的地方。")

    head("5 代价与收益")
    print(f"  只有确定性规则时接住 {len(det_pos)}/{len(POSITIVE)}")
    print(f"  不设阈值（永远取最近的概念）时接住 {hit_pos}/{len(POSITIVE)}，但会把 {len(NEGATIVE)} 条负样本里的")
    print("  绝大部分也接到某个概念上——**在「这张卡说的是哪个概念」这件事上，接错比不接坏得多**")
    print("  （错的那个会把「已掌握」标到别的概念上：T1 台词与地图摘要都会跟着说错话）")

    head("结果")
    if FAIL:
        print(f"  CALIBRATION FAIL — {len(FAIL)} 项：{FAIL}")
        print("  这个 FAIL 是**结论**，不是待修的 bug：名字对名字的余弦分不开「同一件事」与")
        print("  「隔壁那件事」，所以 P2-2 这一层不该上线（PLAN2 §11）。")
        return 1
    print("  CALIBRATION PASS — 有一个阈值能把相关的和隔壁的分开")
    return 0


if __name__ == "__main__":
    sys.exit(main())
