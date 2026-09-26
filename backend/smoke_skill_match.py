"""话题 × 技能 的匹配校准，可重复跑（PLAN3 S1）。

**为什么先量再定。** PLAN3 §2 S1 只写了「话题 × description（embedding 余弦），阈值照
`tutor.RECALL_MIN_SIM` 的做法」。那句话的含义就是这一页——**不能照着召回那个 0.62 抄**：
那里比的是「一句话问法 × 一段会话记录」，这里比的是「一个话题短语 × 一行『何时使用』」，
两边长度与信息量都不一样。PLAN2 的 P2-2 已经在**同一种文本形状**上栽过一次
（概念名 × 话题词：正样本最低 0.579、负样本最高 0.780，0.3–0.95 扫不出干净阈值）。

**判据先写死，免得看完数再改口径**（这一页最要紧的部分）：

  · **硬要求**：一个负样本都不许过线（`fire == 0`）——注入错的工序是这一层唯一的害处，
    而且它悄悄改的是模型的 system。
  · **可协商**：漏掉多少。漏 = **现状不变**（引擎照旧跑，只是没吃到这份技能），
    而且「本该注入却没注入」在留痕里看不见代价。所以漏不是免费的，但它不是害处。
  · **稳定性**：阈值必须在池子变大之后继续成立。S2 一上线就会往 `skills/` 里持续落草稿，
    池子只增不减；一个「小池子干净、大池子开始误报」的阈值会在你不知情的时候开始注错。
  · 另附 P2-2 那种**严口径**（`miss == 0 且 fire == 0`）的结果，供对照。

**这一页量过两轮，第二轮推翻了自己的样本**（记在这里，免得后人重犯）：第一轮把「5 份近重复」
塞进压力池，结果「周报模板给我一个」这条**负样本**跟着新技能「周报的模板」一起变近了——
它已经不是负样本了。**负样本的标签本身随池子变**，所以压力测试必须拆成两件事分开量：
  · §3 池子变大：只加**别领域**技能（报销 / 简历 / A-B / 投诉 / 发票），标签一个不动。
    这一栏量的是「池子大了会不会凭空拉高天花板」。
  · §3b 近重复：同一件事的两种写法。这一栏量的是「本该那一份还是不是第一名」，
    标签会漂，所以只摆事实、不下 PASS/FAIL。

**样本从哪来。** 真库 `skills/` 现在是**空的**（0 份 SKILL.md，2026-09-17 数过），
`backend/evals/skills/` 也不存在，所以这一跑用手写的代表性样本，形状照生产：技能 =
`candidates.draft` 落出来的那种（名字 + 一行「何时使用」），话题 = 引擎的 `topic`
（`ScheduledTask.prompt` / 路由入参，短句）。与 `smoke_cross.py` 同一套办法：
**形状照线上，判据是人话**；我自己都说不清该不该命中的样本一律不收。

跑法：
  cd backend && .venv/Scripts/python.exe smoke_skill_match.py

安全边界：只读本地 embedder，不碰库、不碰 vault、不发网络请求。
"""
import sys

sys.path.insert(0, ".")
try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:  # noqa: BLE001
    pass

FAIL: list[str] = []

# 技能池：(名字, description)。description 是**一行「何时使用」**——`candidates.CANDIDATE_SYSTEM`
# 第 4 条与 `skills._parse_skill_text` 都要求它是这个形状。
SKILLS: list[tuple[str, str]] = [
    ("给领导写汇报要结论先行", "要把工作结果汇报给领导、需要一页纸讲清结论时用"),
    ("竞品调研的对比口径", "做竞品调研、需要按统一维度横向对比时用"),
    ("论文复现的评测口径", "复现一篇论文的实验、要按它的评测协议跑时用"),
    ("代码审查清单", "审查一份别人写的代码改动、要逐项过清单时用"),
    ("线上故障的排查顺序", "线上出故障、要从现象倒着定位根因时用"),
    ("周报的写法", "写本周工作周报、要讲清进展与下周计划时用"),
    ("需求评审的提问清单", "评审一份需求文档、要挑出没说清的地方时用"),
    ("会议纪要整理成待办", "开完会把纪要整理成可执行的待办时用"),
    ("论文速读的三遍法", "要快速判断一篇论文值不值得细读时用"),
    ("慢查询的定位顺序", "数据库查询变慢、要定位是哪一步慢时用"),
    # ---- 2026-09-26 起，`skills/` 真库不再是空的：真成员逐字进池子，标尺跟着真池子走。
    # （写进报告模块的那批工序，源自 chinese-official-writing-skill 的浓缩；逐字 = 真库
    #   frontmatter 的原文，改了任何一边都要回来同步这份清单。）
    ("材料缺口分析", "基于知识库生成内容前，先校验材料是否充足；不足则列出缺口而非硬凑"),
    ("成稿去AI腔", "报告、汇报、总结、方案等正式材料成稿之后、交出去之前用——压掉AI腔与旁白，只留事实与办理事项"),
    ("报告文种纪律", "写报告、情况报告、工作汇报、周报、月报、总结，或把已有材料改写成这类文体时用——以汇报事实为主，材料没给的环节不补，评价要有据"),
    ("材料事实边界", "把用户的材料写成报告、总结、方案、邮件等成稿时用——数字、日期、引语、事实状态照实保留，拟议与进行中不升级"),
    ("限字压缩", "按字数写短稿、写邮件短稿、一页纸，或把长材料压缩成摘要时用——保住文种硬要素与事实，删铺垫与重复"),
]

# §3 的池子变大：**只加别领域**的技能，与样本里任何一个话题都不沾边。
FAR_SKILLS: list[tuple[str, str]] = [
    ("报销单的填写顺序", "要报销一笔费用、不清楚单据怎么填时用"),
    ("简历筛选的硬条件", "筛一批简历、要先按硬条件过一遍时用"),
    ("A/B 实验的判定口径", "跑完一个 A/B 实验、要判断差异算不算显著时用"),
    ("客户投诉的应答口径", "收到客户投诉、要按统一口径回复时用"),
    ("发票信息怎么核对", "核对一张发票的抬头与税号时用"),
]
# §3b 的近重复：同一件事的另一种写法。它们会把**标签**弄漂（「周报模板给我一个」本来是
# 负样本，有了「周报的模板」就不是了），所以这一栏只摆事实。
NEAR_DUP: list[tuple[str, str]] = [
    ("汇报要点的一页纸写法", "要把结论写成一页纸交给领导时用"),
    ("周报的模板", "需要一个固定的周报模板时用"),
    ("代码改动的自查清单", "改完一批代码、要自己先过一遍时用"),
    ("故障复盘怎么写", "线上故障处理完之后要写复盘时用"),
    ("会议待办的跟进方式", "把会上的待办跟到完成为止时用"),
]

# (话题, 本该命中第几份技能)。话题写成**用户会真的打进去的那种短句**：一半是「换个说法」，
# 词面上接不住——那才是这一层存在的理由（照抄原词的那几条不算数，留一条当对照）。
POSITIVE: list[tuple[str, int]] = [
    ("给领导汇报这次项目的结论", 0),
    ("把这段时间的结果汇报给老板", 0),  # 口语化，词面不完全重合
    ("汇报要点：结论先行", 0),  # 词面重合（确定性也接得住，留一条当对照）
    ("竞品分析：飞书和钉钉", 1),
    ("把竞品的功能做个横向对比", 1),
    ("复现这篇论文的实验", 2),
    ("按论文的评测协议重跑一遍", 2),
    ("帮我把这次的代码改动审一遍", 3),
    ("review 一下这个 PR", 3),  # 中英混写：2-gram 完全接不住
    ("线上接口 502 了，怎么查", 4),
    ("服务超时，从哪里开始排查", 4),
    ("写这周的工作周报", 5),
    ("评审一下这份需求文档", 6),
    ("把会议纪要变成待办", 7),
    ("这篇论文值不值得细读", 8),
    ("数据库查询突然变慢了", 9),
    # ---- 2026-09-26：给真库新成员补的正样本（序号 = SKILLS 追加后的位置）。
    ("把已有的调研材料改写成周报", 12),
    ("本周工作总结", 12),
    ("写成邮件短稿", 14),
]

# 硬负样本：**同一个领域里的另一件事**。天花板主要由它们造成，所以必须留在负样本里——
# 把它们挪走，两条分布立刻变得漂亮，而这页尺子也就白跑了（照 `smoke_cross.py` 的规矩）。
ADJACENT: list[str] = [
    "把今天的会议录音转成文字",
    "论文的参考文献格式怎么改",
    "给这份代码补单元测试",
    "数据库表结构怎么设计",
    "故障之后要不要发公告",
    "需求文档的版本号怎么命名",
    "汇报里要不要放数据表",
    "周报模板给我一个",
]

# 完全无关的话题。
NEGATIVE: list[str] = [
    *ADJACENT,
    "唐诗里的意象怎么读",
    "这周该怎么安排时间",
    "怎么用 ffmpeg 把 mp4 转成 gif",
    "Rust 的所有权和借用检查",
    "Docker 镜像怎么减小体积",
    "React 的 key 是干什么的",
    "SQLite 的 WAL 模式",
    "健身计划怎么排",
    "帮我选一台笔记本",
    "把这张图裁剪成正方形",
]

# bge-small-zh-v1.5 的检索侧指令前缀（s2p）。仓库的 `embedder.embed` 不加它——
# 这里量一下加与不加的差别：「短 query 找短 doc」正是它被训练的那种形状。
BGE_QUERY_PREFIX = "为这个句子生成表示以用于检索相关文章："

N_POS, N_NEG = len(POSITIVE), len(NEGATIVE)
BIG = [*SKILLS, *FAR_SKILLS]
# 技能侧的三种文本形态。description 是「何时使用」，名字是那份工序的标题——
# 真实现里到底拿哪个去匹配，是要量的一个变体。
FORMS = (
    ("只用 description", lambda n, d: d),
    ("只用名字", lambda n, d: n),
    ("名字 + description", lambda n, d: f"{n} {d}"),
)
VARIANTS = (
    ("desc｜原样", False, False),
    ("desc｜话题加前缀", True, False),
    ("name+desc｜原样", False, True),
    ("name+desc｜话题加前缀", True, True),
)
# 打算出厂的 floor（先在 10 份池子上按「天花板 + 一点余量」定，再看 15 份上还成不成立）
DET_FLOOR = 0.30
EMB_FLOOR = 0.62


def ok(label: str, detail: str = "") -> None:
    print(f"  ok   {label}" + (f" — {detail}" if detail else ""))


def bad(label: str, detail: str = "") -> None:
    FAIL.append(label)
    print(f"  FAIL {label}" + (f" — {detail}" if detail else ""))


def head(title: str) -> None:
    print(f"\n== {title}")


def _bigrams(text: str) -> set[str]:
    """中文没有空格：2-gram 是最省事、也最不挑分词器的确定性表示。"""
    s = "".join(ch for ch in (text or "").lower() if ch.isalnum())
    return {s[i : i + 2] for i in range(len(s) - 1)} if len(s) > 1 else ({s} if s else set())


def _cover(topic: str, text: str) -> float:
    """话题的 2-gram 有多少出现在技能文本里（包含率，0–1）。"""
    t, d = _bigrams(topic), _bigrams(text)
    if not t or not d:
        return 0.0
    return len(t & d) / len(t)


def _det_rows(form, pool) -> tuple[list[list[float]], list[float], list[float]]:
    """(正样本逐条逐技能的分数, 正样本该命中那份的分数, 负样本的最高分)。"""
    rows = [[_cover(t, form(n, d)) for n, d in pool] for t, _w in POSITIVE]
    pos = [r[w] for r, (_t, w) in zip(rows, POSITIVE)]
    neg = [max(_cover(t, form(n, d)) for n, d in pool) for t in NEGATIVE]
    return rows, pos, neg


def _stats(pos: list[float], neg: list[float], rows: list[list[float]], floor: float) -> dict:
    """一档 floor 下的硬指标。"""
    return {
        "ceiling": max(neg),
        "miss": sum(1 for s in pos if s < floor),
        "hit": sum(1 for s in pos if s >= floor),
        "fire": sum(1 for s in neg if s >= floor),
        "extra": sum(
            1
            for k, (_t, want) in enumerate(POSITIVE)
            for i, s in enumerate(rows[k])
            if i != want and s >= floor
        ),
        "strict": min(pos) > max(neg),
    }


def _rowline(name: str, a: dict, b: dict, floor: float) -> str:
    return (
        f"  {name:<26} 天花板 {a['ceiling']:>5.3f} → {b['ceiling']:>5.3f}（{b['ceiling'] - a['ceiling']:+.3f}）"
        f"  floor={floor:.2f} 时 命中 {a['hit']:>2}→{b['hit']:>2}  误报 {a['fire']}→{b['fire']}"
        f"  多命中 {a['extra']}→{b['extra']}"
    )


def main() -> int:  # noqa: C901 - 一页尺子，摊开写比拆成函数好读
    from app.core import embedder
    from app.core.tutor import _cosine

    head("0 参数")
    print(f"  embedder={embedder.MODEL_NAME}")
    print(f"  样本：{N_POS} 该命中 + {N_NEG} 必不中（其中 {len(ADJACENT)} 条是同领域隔壁工序）")
    print(f"  池子：目标 {len(SKILLS)} 份 → §3 加 {len(FAR_SKILLS)} 份别领域 → §3b 另加 {len(NEAR_DUP)} 份近重复")
    print("  真库 skills/ 现在是空的，样本是手写的**代表性**形状")
    print("  判据：硬要求 fire==0；可协商的是漏多少（漏 = 现状不变）；**两个池子都要成立**")

    # ---------- 1 确定性（两个池子） ----------
    head("1 确定性基线：2-gram 包含率（纯函数，不调模型）")
    det10: dict[str, dict] = {}
    det15: dict[str, dict] = {}
    for form_label, form in FORMS:
        r10, p10, n10 = _det_rows(form, SKILLS)
        r15, p15, n15 = _det_rows(form, BIG)
        det10[form_label] = _stats(p10, n10, r10, DET_FLOOR)
        det15[form_label] = _stats(p15, n15, r15, DET_FLOOR)
        print(_rowline(form_label, det10[form_label], det15[form_label], DET_FLOOR))

    # ---------- 2 余弦（两个池子） ----------
    topics = [t for t, _ in POSITIVE] + NEGATIVE
    emb10: dict[str, dict] = {}
    emb15: dict[str, dict] = {}
    mats10: dict[str, list[list[float]]] = {}
    for pool_label, pool, store, matstore in (("池子 10 份", SKILLS, emb10, mats10), ("池子 15 份", BIG, emb15, {})):
        head(f"2 余弦 · {pool_label}")
        for label, prefix, with_name in VARIANTS:
            cand = [f"{n} {d}" if with_name else d for n, d in pool]
            vq = embedder.embed([(BGE_QUERY_PREFIX + t) if prefix else t for t in topics])
            vc = embedder.embed(cand)
            mat = [[_cosine(q, c) for c in vc] for q in vq]
            matstore[label] = mat
            pos = [mat[k][w] for k, (_t, w) in enumerate(POSITIVE)]
            neg = [max(mat[N_POS + k]) for k in range(N_NEG)]
            store[label] = _stats(pos, neg, mat, EMB_FLOOR)
            store[label]["ceiling_hard"] = max(
                (neg[k] for k, t in enumerate(NEGATIVE) if t in ADJACENT), default=0.0
            )
            store[label]["pos_min"] = min(pos)
            print(f"  {label:<22} 天花板 {store[label]['ceiling']:.3f}"
                  f"（隔壁 {store[label]['ceiling_hard']:.3f}）该命中最低 {min(pos):.3f}"
                  f"｜floor={EMB_FLOOR} 命中 {store[label]['hit']:>2}/{N_POS} 误报 {store[label]['fire']}"
                  f"｜严口径={store[label]['strict']}")
        print("  天花板是谁造成的（前 3）")
        mat = mats10["name+desc｜话题加前缀"] if pool_label.startswith("池子 10") else None
        if mat is not None:
            errors = sorted(
                ((max(mat[N_POS + k]), t, SKILLS[max(range(len(SKILLS)), key=lambda i: mat[N_POS + k][i])][0], t in ADJACENT)
                 for k, t in enumerate(NEGATIVE)),
                reverse=True,
            )
            for s, t, skill, adj in errors[:3]:
                print(f"    {s:.3f}  {t[:22]:<22} → {skill}{'   ← 隔壁工序' if adj else ''}")

    # ---------- 3 池子变大（标签不动） ----------
    head(f"3 池子 {len(SKILLS)} → {len(BIG)} 份（只加别领域技能，样本标签一个没动）")
    for form_label, _f in FORMS:
        print(_rowline(form_label, det10[form_label], det15[form_label], DET_FLOOR))
    for label, _p, _n in VARIANTS:
        print(_rowline(label, emb10[label], emb15[label], EMB_FLOOR))
    worst_det = max(det15[l]["ceiling"] for l, _f in FORMS)
    worst_emb = max(emb15[l]["ceiling"] for l, _p, _n in VARIANTS)
    print(f"  加别领域技能之后：确定性最高天花板 {worst_det:.2f}，余弦最高 {worst_emb:.3f}")

    # ---------- 3b 近重复（标签会漂，只摆事实） ----------
    head("3b 近重复：同一件事的两种写法（这一栏不下 PASS/FAIL——负样本的标签自己会漂）")
    pool = [*SKILLS, *NEAR_DUP]
    for form_label, form in FORMS:
        rows, pos, neg = _det_rows(form, pool)
        ceil = max(neg)
        top1 = [max(range(len(pool)), key=lambda i: rows[k][i]) for k in range(N_POS)]
        stolen = [
            (POSITIVE[k][0], pool[top1[k]][0], pool[w][0])
            for k, (_t, w) in enumerate(POSITIVE)
            if top1[k] != w and rows[k][top1[k]] >= DET_FLOOR
        ]
        print(f"  [{form_label}] 天花板 {ceil:.2f}；第一名被近重复抢走 {len(stolen)} 条 {stolen}")
    rows, pos, neg = _det_rows(dict(FORMS)["名字 + description"], pool)
    for k, (t, w) in enumerate(POSITIVE):
        if rows[k][w] >= DET_FLOOR:
            extra = [(round(s, 2), pool[i][0]) for i, s in enumerate(rows[k]) if i != w and s >= DET_FLOOR]
            if extra:
                print(f"    多命中：「{t}」本该「{pool[w][0]}」，也过了线 {extra}")
    print("  → 近重复拉高的不是天花板，是**多命中**；按分数取前 2 就够（S1 本来也只注入 ≤2 份）。")
    print("     S2 的「同名不覆盖」管不住「同一件事两种写法」，记在案上。")

    # ---------- 4 结论 ----------
    head("4 结论")
    det_ok = [l for l, _f in FORMS if det15[l]["fire"] == 0 and det15[l]["hit"] >= det10[l]["hit"] - 1]
    emb_ok = [l for l, _p, _n in VARIANTS if emb15[l]["fire"] == 0]
    print(f"  在 15 份池子上仍然不误报、且命中没有塌：确定性 {det_ok or '（无）'}；余弦 {emb_ok or '（无）'}")
    if not det_ok and not emb_ok:
        bad("有一档阈值在两个池子上都成立", "没有——这一层买不到")
        print("  → S1 不做自动匹配：注入清单留空，等有真实技能与真实话题时重跑这一页再谈。")
        return 1
    # 选型：确定性优先——同样的命中数下，纯函数、零模型依赖、结果可复现；
    # 余弦只在「换个说法」上多接住一两条，却要拖一个模型依赖和一条降级路径。
    pick = max(det_ok, key=lambda l: det15[l]["hit"]) if det_ok else None
    if pick:
        ok("确定性匹配上线", f"{pick} · floor={DET_FLOOR} · 命中 {det10[pick]['hit']}→{det15[pick]['hit']}/{N_POS} · 误报 0")
    else:
        pick = max(emb_ok, key=lambda l: emb15[l]["hit"])
        ok("余弦匹配上线", f"{pick} · floor={EMB_FLOOR} · 命中 {emb10[pick]['hit']}→{emb15[pick]['hit']}/{N_POS}")
    rows, pos, neg = _det_rows(dict(FORMS)[pick], BIG)
    sb = _stats(pos, neg, rows, DET_FLOOR)
    print(f"  漏掉的是哪几条（floor={DET_FLOOR}，漏 = 现状不变，不是害处）：")
    for k, (t, w) in enumerate(POSITIVE):
        if rows[k][w] < DET_FLOOR:
            print(f"    {rows[k][w]:.2f}  {t}（本该用「{BIG[w][0]}」）")
    print(f"  余弦那一档的账（留在案上，脚本可复跑）：10 份天花板 "
          f"{emb10['name+desc｜话题加前缀']['ceiling']:.3f}、15 份 "
          f"{emb15['name+desc｜话题加前缀']['ceiling']:.3f}；floor=0.62 时命中 "
          f"{emb10['name+desc｜话题加前缀']['hit']}→{emb15['name+desc｜话题加前缀']['hit']}、"
          f"误报 {emb10['name+desc｜话题加前缀']['fire']}→{emb15['name+desc｜话题加前缀']['fire']}")
    head("结果")
    if FAIL:
        print(f"  CALIBRATION FAIL — {len(FAIL)} 项：{FAIL}")
        return 1
    print(f"  CALIBRATION PASS — {pick} · floor {DET_FLOOR}：两个池子都一个错的都不注入，"
          f"该注入的吃到 {sb['hit']}/{N_POS}")
    print("  → 这几个数写进 `core/skill_match.py` 的模块注释；余弦那一档的漂移量也写进去，")
    print("     并留一句「池子再大就重跑这一页」。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
