"""召回阈值与别名校准，可重复跑。

「记住你卡在哪」是这个方向唯一的独有价值；它「从没触发，或触发了
但没用」就砍掉。那两条判决只有在阈值本身是对的时候才作数 —— 阈值偏低会让每次都
接上三条不相关的记录（看起来就是「触发了但没用」），偏高会让它永远不响（看起来
就是「从没触发」）。两种都会因为一个常数而误杀这个方向。

所以这个脚本不猜，它量：拿真实 embedder（bge-small-zh-v1.5）算一组「本该命中」和
「本该不中」的配对，打印几种待召回文本拼法的分布，并检查线上那一种在
`tutor.RECALL_MIN_SIM` 上两边都对。

2026-09-06 之后多了一组**同义改写**的配对。原来 recall 只接得住同词汇域的重逢：
「Python 协程是在什么时机切换的」对当初那条 asyncio 记录只有 0.44-0.49，低于噪声
天花板，任何阈值都分不开。别名（`TutorSession.aliases`）就是为这一组加的，所以
这一组是它的验收 —— 别名没让这组过线，别名就该删掉。

拼法也在这里定：别名是**每个各成一条向量**而不是整行一条（`tutor.ALIAS_SEP` 存边界）。
那张表就是这个决定的依据 —— 手写的同质别名量不出两者的差别，真实模型写出来的
四个别名是四个不同角度，整行平均之后会把唯一对得上的那条稀释掉。所以第 0 条旧记录用
的是真实提取输出，不是手写的。

关于循环论证：除第 0 条以外的别名是照提示词要求手写的，所以「机制成立」和「模型真的
会写出这种别名」是两件事，这里只能证前者，后者靠 `--live` 和 `smoke_tutor_accept.py`
（真实模型跑完整会话）。同理脚本通过不等于阈值在真实数据上也对；它守的是换
embedder、改拼法、有人把常数调松这三件事。

安全边界：只读。`--live` 用只读方式打开真实库，只读 tutor_sessions 的
topic / concept / aliases / stuck / verdict，不写、不建表、不碰 vault 与向量库。

跑法：
  backend/.venv/Scripts/python.exe smoke_recall.py          # 固定样本
  backend/.venv/Scripts/python.exe smoke_recall.py --live   # 再加上你自己的真实会话
"""
import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, ".")
try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:  # noqa: BLE001 - 老 Python 或被重定向时无所谓
    pass

FAIL: list[str] = []

# (topic, concept, [aliases], stuck) —— 形状照 tutor_sessions 里存的那样。topic 是
# 用户自己打的问法，stuck 是一句错误理解。第 0 条的别名是 **qwen 真的写出来的那三/四条**
# （smoke_tutor_accept.py 某一跑，原样抄过来），其余几条是照
# `_EXTRACT_PROMPT` 的要求手写的「他下次想不起术语时会怎么打字」。第 0 条留真实输出是
# 因为手写别名太同质，量不出「整行一条 vs 每条一条」的差别 —— 那个差别正好决定线上用哪种。
#
# 快照要跟着真实输出刷新：2026-09-06 那次快照（「协程挂起后去哪」这组）没覆盖「何时
# 切换」这个面，改写对只到 0.582；换成最新一跑的原样输出（「协程怎么切换执行」）后
# 0.728，负样本最高反而从 0.568 降到 0.551。别名组漏了改写要找的那个面，是提取质量
# 的边界（accept drill 当场判：提取不出合格别名即 FAIL），不是阈值该让步的地方。
PAST: list[tuple[str, str, list[str], str]] = [
    (
        "asyncio 里 await 到底把控制权交给了谁",
        "asyncio 挂起",
        ["await 让出给谁了", "协程怎么切换执行", "异步任务谁管调度"],
        "以为协程挂起不进内核",
    ),
    (
        "闭包捕获的是变量还是值",
        "JS 闭包",
        ["内层函数为什么能拿到外层变量", "lexical scope 捕获", "函数带着环境走"],
        "以为闭包只是嵌套函数",
    ),
    (
        "Python 多线程为什么跑不满 CPU",
        "Python GIL",
        ["全局解释器锁", "多开线程为什么没变快", "CPython 的线程限制"],
        "以为 GIL 让多线程完全没用",
    ),
    (
        "为什么 React 的 useEffect 里拿到的是旧的 state",
        "React useEffect 依赖数组",
        ["effect 里读到过期的值", "依赖写空数组的后果", "effect 什么时候重跑"],
        "以为空数组等于只跑一次就永不重跑",
    ),
    (
        "SQLite 并发写会不会锁库",
        "SQLite WAL 模式",
        ["写前日志", "读和写互不阻塞", "并发写入怎么排队"],
        "以为 WAL 能让多个写入并发",
    ),
    (
        "检索里两路分数怎么合并",
        "RRF 混合检索融合",
        ["reciprocal rank fusion", "两路结果怎么合成一个排名", "关键词和向量分数量纲不同"],
        "以为分数可以直接相加",
    ),
]

# (你会打进去的话题, 本该命中 PAST 里的第几条 / None = 一条都不该命中)
SAME_WORDS: list[tuple[str, int | None]] = [
    ("asyncio 里 await 到底把控制权交给了谁", 0),
    ("Python 多线程为什么跑不满 CPU", 2),
    ("为什么 React 的 useEffect 里拿到的是旧的 state", 3),
    ("闭包捕获的是变量还是值", 1),
    ("SQLite 并发写会不会锁库", 4),
    ("怎么优化 SQLite 并发写入", 4),  # 换了措辞的重逢，2026-09-06 实测 0.722
]

# 同义改写：想不起术语了，用现象描述重新问一遍。别名就是为这一组加的。
PARAPHRASE: list[tuple[str, int | None]] = [
    ("Python 协程是在什么时机切换的", 0),  # 无别名时实测 0.44-0.49，低于噪声天花板
    ("函数返回之后局部变量为什么还活着", 1),
    ("加了线程为什么速度没上去", 2),
    ("组件重渲染之后 effect 里的 state 还是老的", 3),
    ("关键词检索和向量检索的结果怎么排在一起", 5),
]

# 必须一条都不中。前三条是同领域技术话题 —— 真正难的就是这几个，因为 bge 把所有
# 中文技术短语挤在一个很窄的锥里，随便两条都有 0.4 以上。后三条是别名带来的新风险：
# 别名里有「什么时候切换」「为什么没变快」「怎么追踪」这种去掉了领域词的说法，正好
# 会去贴隔壁领域的同形问题。一条在这里响了就是「触发得不对」。
NEGATIVE: list[tuple[str, int | None]] = [
    ("Rust 的所有权和借用检查", None),
    ("Docker 镜像分层怎么复用缓存", None),
    ("怎么用 ffmpeg 把 mp4 转成 gif", None),
    ("唐诗里的意象怎么读", None),
    ("这周该怎么安排时间", None),
    ("Go 的 goroutine 调度器是怎么抢占的", None),  # 贴 asyncio 的别名；概念邻近但不是同一个
    ("MySQL 加了索引为什么查询没变快", None),  # 贴 GIL 的「多开线程为什么没变快」
    ("Vue 的响应式是怎么追踪依赖的", None),  # 贴 useEffect 的「依赖」
]

TOPICS = SAME_WORDS + PARAPHRASE + NEGATIVE

# 待召回文本的几种拼法。每行可以有多条文本，取分数最高的那条（max 而不是拼长）。
# 线上那一种是 SHIPPED，其余只为对照 —— 换拼法之前先在这张表里看见代价。
VARIANTS: list[tuple[str, object]] = [
    ("A 无别名（2026-09-06 之前）", lambda t, c, a, s: [f"{t} {c} {s}".strip()]),
    ("B 别名并进同一条", lambda t, c, a, s: [f"{t} {c} {' '.join(a)} {s}".strip()]),
    ("C 取 max，别名行 = concept + 别名", lambda t, c, a, s: [f"{t} {c} {s}".strip(), f"{c} {' '.join(a)}".strip()]),
    ("D 取 max，别名整行一条", lambda t, c, a, s: [f"{t} {c} {s}".strip(), " ".join(a).strip()]),
    ("E 取 max，每个别名各一条", lambda t, c, a, s: [f"{t} {c} {s}".strip(), *[x for x in a if x]]),
]
SHIPPED = "E 取 max，每个别名各一条"

def ok(label: str, detail: str = "") -> None:
    print(f"  ok   {label}" + (f" — {detail}" if detail else ""))


def bad(label: str, detail: str = "") -> None:
    FAIL.append(label)
    print(f"  FAIL {label}" + (f" — {detail}" if detail else ""))


def head(title: str) -> None:
    print(f"\n== {title}")


def pct(xs: list[float], p: float) -> float:
    s = sorted(xs)
    return s[min(len(s) - 1, int(p * (len(s) - 1)))]


def score_matrix(build, topics: list[tuple[str, int | None]], past: list) -> list[list[float]]:
    """-> matrix[话题][旧记录] = 这一行拿得到的最高分。

    一行可以有多条待召回文本（别名单独成向量），取 max —— 拼法必须和
    `tutor.recall_hits` 里那一段一致，否则量的不是同一个东西。
    """
    from app.core import embedder
    from app.core.tutor import _cosine

    cand: list[str] = []
    owner: list[int] = []
    for i, (t, c, a, s) in enumerate(past):
        for text in build(t, c, a, s):
            if text:
                cand.append(text)
                owner.append(i)

    vq = embedder.embed([t for t, _ in topics])
    vc = embedder.embed(cand)
    out: list[list[float]] = []
    for q in vq:
        best = [0.0] * len(past)
        for v, i in zip(vc, owner):
            sc = _cosine(q, v)
            if sc > best[i]:
                best[i] = sc
        out.append(best)
    return out


def split(matrix: list[list[float]], topics: list[tuple[str, int | None]]):
    """matrix → (本该命中的分数, 本该不中的分数)。"""
    true_s: list[float] = []
    false_s: list[float] = []
    for (_topic, want), row in zip(topics, matrix):
        for i, sc in enumerate(row):
            (true_s if want == i else false_s).append(sc)
    return true_s, false_s


def report(name: str, true_s: list[float], false_s: list[float], floor: float) -> None:
    hi_false, lo_true = max(false_s), min(true_s)
    print(f"  {name}")
    print(f"    本该命中 n={len(true_s):<3} 最低 {lo_true:.3f}  中位 {pct(true_s, 0.5):.3f}")
    print(f"    本该不中 n={len(false_s):<3} 最高 {hi_false:.3f}  中位 {pct(false_s, 0.5):.3f}")
    print(f"    可用区间 [{hi_false:.3f}, {lo_true:.3f}]   当前阈值 {floor}")
    missed = [s for s in true_s if s < floor]
    fired = [s for s in false_s if s >= floor]
    if hi_false >= lo_true:
        bad("两条分布不重叠", f"不该中的最高 {hi_false:.3f} ≥ 该中的最低 {lo_true:.3f}，没有阈值能分开")
    if missed:
        bad("阈值不吞掉真实命中", f"{len(missed)}/{len(true_s)} 条该中的落在 {floor} 以下，最低 {min(missed):.3f}")
    else:
        ok("该中的全部过线", f"最低命中 {lo_true:.3f} ≥ {floor}")
    if fired:
        bad("阈值挡住误报", f"{len(fired)}/{len(false_s)} 条不该中的过了线，最高 {max(fired):.3f}")
    else:
        ok("不该中的全部挡住", f"最强误报 {hi_false:.3f} < {floor}")


def compare(floor: float) -> dict[str, list[list[float]]]:
    """五种拼法各量一遍，一张表列出代价。返回每种的矩阵供后面细看。"""
    mats: dict[str, list[list[float]]] = {}
    print(f"  {'拼法':<34} {'该中最低':>8} {'不该中最高':>10} {'间隔':>7} {'漏':>3} {'误':>3}")
    for name, build in VARIANTS:
        mat = score_matrix(build, TOPICS, PAST)
        mats[name] = mat
        t, f = split(mat, TOPICS)
        gap = min(t) - max(f)
        miss = sum(1 for s in t if s < floor)
        fire = sum(1 for s in f if s >= floor)
        mark = "→" if name == SHIPPED else " "
        print(
            f" {mark}{name:<34} {min(t):>8.3f} {max(f):>10.3f} {gap:>+7.3f} {miss:>3} {fire:>3}"
        )
    return mats


def paraphrase_gain(mats: dict[str, list[list[float]]], floor: float) -> None:
    """同义改写这一组：别名到底把分数抬了多少。别名的全部理由就在这张表里。"""
    base = mats["A 无别名（2026-09-06 之前）"]
    ship = mats[SHIPPED]
    off = len(SAME_WORDS)
    worst = 1.0
    for k, (topic, want) in enumerate(PARAPHRASE):
        b, s = base[off + k][want], ship[off + k][want]
        worst = min(worst, s)
        print(
            f"    {'响' if s >= floor else ' ·'} {b:.3f} → {s:.3f} ({s - b:+.3f})"
            f"  {topic[:24]:<24} → {PAST[want][1]}"
        )
    if worst >= floor:
        ok("同义改写全部过线", f"最低 {worst:.3f} ≥ {floor}")
    else:
        bad("同义改写全部过线", f"最低 {worst:.3f} < {floor} —— 别名没解决它要解决的那件事")


def live_rows() -> list[tuple[str, str, str, str, str]]:
    """真实库里的 (topic, concept, aliases, stuck, verdict)，只读打开。

    直接用 sqlite3 而不是 SQLAlchemy：`mode=ro` 是这里唯一在意的事，用 ORM 就得起
    async engine，而那条路会顺手建表。
    """
    from app.config import settings

    path = Path(settings.db_path)
    if not path.is_file():
        return []
    con = sqlite3.connect(f"file:{path.as_posix()}?mode=ro", uri=True)
    where = "WHERE verdict IN ('got','half') AND concept <> '' ORDER BY id"
    try:
        try:
            return con.execute(
                f"SELECT topic, concept, aliases, stuck, verdict FROM tutor_sessions {where}"
            ).fetchall()
        except sqlite3.OperationalError:
            # 库比这次改动早：aliases 列还没有。别名之前的行照旧只走 primary 那条文本
            rows = con.execute(
                f"SELECT topic, concept, stuck, verdict FROM tutor_sessions {where}"
            ).fetchall()
            print("    这个库还没有 aliases 列 —— 别名之前开的会话就是这样，按无别名算")
            return [(t, c, "", s, v) for t, c, s, v in rows]
    except sqlite3.Error as e:
        print(f"    读不到 tutor_sessions（{e}）—— 还没开过会话就是这样")
        return []
    finally:
        con.close()


def live_check(floor: float) -> None:
    """真实会话之间互相召回一遍：现在这个阈值在你自己的数据上会不会响。

    这才是要的那个查询。固定样本只能证明常数没被人调松。
    """
    rows = live_rows()
    if len(rows) < 2:
        print(f"    只有 {len(rows)} 条可召回的会话，还不够互相召回。跑完 3 次再看。")
        return

    from app.core import embedder
    from app.core.tutor import ALIAS_SEP, RECALL_TOP_K, _cosine

    # 拼法照 `recall_hits`：primary 一条 + 每个别名各一条，同一行内取 max
    vq = embedder.embed([r[0] for r in rows])
    prim = embedder.embed([f"{r[0]} {r[1]} {r[3]}".strip() for r in rows])
    alias_texts: list[str] = []
    alias_owner: list[int] = []
    for i, r in enumerate(rows):
        for alias in r[2].split(ALIAS_SEP):
            if alias.strip():
                alias_texts.append(alias.strip())
                alias_owner.append(i)
    alia = embedder.embed(alias_texts) if alias_texts else []

    print(f"    {len(set(alias_owner))}/{len(rows)} 条会话有别名，共 {len(alias_texts)} 条")
    fired = 0
    by_alias = 0
    for i, (topic, _c, _a, _s, _v) in enumerate(rows):
        best: dict[int, tuple[float, str]] = {
            j: (_cosine(vq[i], prim[j]), "concept") for j in range(len(rows)) if j != i
        }
        for v, j in zip(alia, alias_owner):
            if j == i:
                continue
            sc = _cosine(vq[i], v)
            if sc > best[j][0]:
                best[j] = (sc, "alias")
        ranked = sorted(((s, via, j) for j, (s, via) in best.items()), reverse=True)
        hits = [b for b in ranked[:RECALL_TOP_K] if b[0] >= floor]
        fired += bool(hits)
        by_alias += sum(1 for b in hits if b[1] == "alias")
        s0, via0, j0 = ranked[0]
        print(f"    {'响' if hits else ' ·'} {topic[:26]:<26} 最接近 {s0:.3f} [{via0}] {rows[j0][1][:18]}")
        for s, via, j in hits[1:]:
            print(f"       └ 还接上 {s:.3f} [{via}] {rows[j][1][:18]}")
    print(f"    {fired}/{len(rows)} 次会话会接上以前的记录（阈值 {floor}），其中 {by_alias} 条是别名命中的")
    if fired == 0:
        print("    一次都没响：「从没触发」就是这个形状。先看最接近那一列的分数 ——")
        print("    分数都在 0.5 上下说明你聊的东西彼此无关，不是阈值的问题；贴着阈值差一点")
        print("    才说明该调。")


def main() -> int:
    live = "--live" in sys.argv
    from app.core import embedder
    from app.core.tutor import RECALL_MIN_SIM, RECALL_MIN_SIM_NOISE_CEILING, RECALL_TOP_K

    head("0 参数")
    print(f"  embedder={embedder.MODEL_NAME}  阈值={RECALL_MIN_SIM}  top_k={RECALL_TOP_K}")
    print(f"  样本：{len(SAME_WORDS)} 同词汇 + {len(PARAPHRASE)} 同义改写 + {len(NEGATIVE)} 必不中，× {len(PAST)} 条旧记录")

    head("1 五种拼法的代价（漏=该中的被吞，误=不该中的过线）")
    mats = compare(RECALL_MIN_SIM)

    head("2 线上那一种")
    true_s, false_s = split(mats[SHIPPED], TOPICS)
    report(SHIPPED, true_s, false_s, RECALL_MIN_SIM)

    # 常数本身也钉一下：注释里写的噪声天花板是当初定阈值的依据，飘了就等于注释在骗人
    if RECALL_MIN_SIM > RECALL_MIN_SIM_NOISE_CEILING:
        ok("阈值高于记录在案的噪声天花板", f"{RECALL_MIN_SIM} > {RECALL_MIN_SIM_NOISE_CEILING}")
    else:
        bad("阈值高于记录在案的噪声天花板", f"{RECALL_MIN_SIM} ≤ {RECALL_MIN_SIM_NOISE_CEILING}")
    if abs(max(false_s) - RECALL_MIN_SIM_NOISE_CEILING) <= 0.02:
        ok("噪声天花板和注释里写的一致", f"实测 {max(false_s):.3f}")
    else:
        bad("噪声天花板和注释里写的一致", f"实测 {max(false_s):.3f}，注释写的 {RECALL_MIN_SIM_NOISE_CEILING}")

    head("3 同义改写：别名把分数抬了多少（无别名 → 线上）")
    paraphrase_gain(mats, RECALL_MIN_SIM)

    head("4 每个话题排第一的是谁")
    ship = mats[SHIPPED]
    for (topic, want), row in zip(TOPICS, ship):
        i0 = max(range(len(PAST)), key=lambda i: row[i])
        s0 = row[i0]
        flag = "响" if s0 >= RECALL_MIN_SIM else " ·"
        wrong = "" if want == i0 or s0 < RECALL_MIN_SIM else "   ← 触发得不对"
        print(f"    {flag} {s0:.3f}  {topic[:26]:<26} → {PAST[i0][1]}{wrong}")

    head("5 你的真实会话")
    if live:
        live_check(RECALL_MIN_SIM)
    else:
        print("    跳过（加 --live 才读真实库）")

    head("结果")
    if FAIL:
        print(f"  CALIBRATION FAIL — {len(FAIL)} 项：{FAIL}")
        return 1
    print(f"  CALIBRATION PASS — 阈值 {RECALL_MIN_SIM} 把这批相关的和不相关的分开了")
    return 0


if __name__ == "__main__":
    sys.exit(main())
