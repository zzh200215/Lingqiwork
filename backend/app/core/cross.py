"""双轨接通（PLAN2）：让概念轨与卡片轨互相看见。

学模块有两条轨——概念轨（说通 ×2 = 掌握）与卡片轨（SM-2 → 成熟 ≥21 天）——各自都做到了位，
问题出在**它们互不引用**：一个概念可以已进掌握，而它的卡这周「重来」三回；反过来卡全成熟、
概念可能一场会话都没有。这个模块是 PLAN2 里唯一那座桥（T1 双轨互验 + T3 leech 前置回指
**共用它**）——两处各写一遍「卡 → 概念」的关联规则，迟早给出两个答案（`clamp_witness_days`
的教训）。

四条纪律：

1. **对质当场算、算完就散**（PLAN2 §3）：不落库、不新增表。要固化它就会长出第二套掌握标准，
   而那正是本规划要消灭的东西；
2. **只陈述两边的事实，不判谁对**（§8.2）：这张卡这周重来三回、那个概念你说通过两次，
   两句摆在一起，改不改判定是你的事；
3. **关联不上不是失败，是常态**（§2 T1 的风险条）：`Card.topic` 是出卡时模型写的话题词，
   `TutorSession.concept` 是会话结束时归一的概念，两者未必同形。匹配不上就少一行、少一句话，
   不报错、不硬凑；
4. **它不进零柒嘴里**（§6 红线，与 `metrics.py` 同一条）：这里没有任何**开口**的路
   （不 emit、不 compose、不 feed、不进问候）——台词由 `pet.compose()` 那一侧说，
   这个模块只产出事实。唯一的例外是 `pet.local_day_utc_bounds` 那一份本地日换算
   （回指采纳的窗口要按本地日切），与 `metrics.py` 同一条规矩：**只拿那一个函数**，
   而且只拿它做时间换算。两条测试盯着（跑完这条线宠物一个字都没说 + 源码里
   `pet.` 后面只允许出现那一个名字）。

关联规则（第一版，实测定稿见 §2 T1 的「实现时才定」）：**双向包含 + 别名展开**，走的正是
`tutor.canonical_concept` 那一套（归一化相等 → 一个包含另一个），**有歧义就不匹配**。

**P2-2 的语义兜底量过之后没有上线**（PLAN2 §11，校准脚本 `backend/smoke_cross.py` 可复跑）：
名字对名字的余弦分不开「同一件事」与「隔壁那件事」——正样本最低 0.579、负样本最高 0.780，
阈值扫一遍**没有任何一个操作点两边都干净**（0.6 放过 11 条负样本，0.7 吞掉 5 条正样本）。
所以这一层不是「还没做」，是**量完判了不上**；要再议先跑那个脚本，别直接加阈值。
"""
from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone

log = logging.getLogger(__name__)

# 矛盾的两个条件（PLAN2 §2 T1）：「概念已掌握」×「同 topic 的卡近 7 天重来 ≥2」。
# 少一个都不算——只说通过一次的不算矛盾（那还没到掌握），只重来一次也不算（一次是手滑）。
AGAIN_GRADE = 1  # 1 = 重来（`models.CardReview.grade` 定的四档里的第一档）
AGAIN_DAYS = 7
CONTRADICT_MIN_AGAIN = 2

# 递卡那句话最多往回扫多少张到期卡。扫的是队列顺序（due 最早在前），找到第一条矛盾就停：
# 气泡一次只说一句话。只读——不因为它排第几而改变什么，也不产生任何「该做没做」。
DUE_SCAN_CAP = 50

PREREQ_MAX = 3  # 候选最多三个：再多就不是「可能缺的那一段」，是一张待办清单了
HALF_LABEL = "半懂"
RECURRING_LABEL = "又卡住"


def _norm(text: str) -> str:
    """归一化。**用 `tutor.norm_concept`**——两套归一化就是两套关联结果。"""
    from app.core import tutor

    return tutor.norm_concept(text)


def _contains(a: str, b: str) -> bool:
    """一个包含另一个（开头/结尾，不做任意位置子串）。**用 `tutor._contains`**：
    它的两条边界（最短长度、不做中间子串）是量出来的，不在这里重写一遍。"""
    from app.core import tutor

    return tutor._contains(a, b)  # noqa: SLF001


def concept_names(rows) -> dict[str, set[str]]:
    """概念 → 它的**全部叫法**（规范名 + 历次别名）。Pure。

    `TutorSession.aliases` 是 `tutor.ALIAS_SEP` 分隔的一行（它只有一个消费者、就是召回，
    见 `models.TutorSession` 那段注释）。关联这里要用的是同一份东西：几个月后你出卡时用的词，
    往往正好是别名里的那一个。
    """
    from app.core import tutor

    out: dict[str, set[str]] = {}
    for r in rows:
        concept = (r.concept or "").strip()
        if not concept:
            continue
        names = out.setdefault(concept, set())
        for alias in (r.aliases or "").split(tutor.ALIAS_SEP):
            alias = alias.strip()
            if alias and alias != concept:
                names.add(alias)
    return out


def match_topic(topic: str, names: dict[str, set[str]]) -> str:
    """一个话题词 → 它说的是哪个概念（匹配不上 = `""`）。**Pure：一次 embedder 都不碰。**

    顺序与 `tutor.canonical_concept` **同一套**：先「一字不差」，再「一个包含另一个」。
    别名也参与这两条（`concept_names` 给的就是概念名 + 别名），所以「他当初换了个说法」
    里**说法本身就是别名**的那些已经接得住。

    **有歧义就不匹配**：两个概念都答得上（别名撞车、或包含关系指向两边）时返回空串。
    宁可少一行摘要、少一句话，也不替它挑一个——挑错的那个会把「已掌握」标到别的概念上，
    而那是这个模块唯一不能犯的错。两边都不是对方的子串、或者都短于门槛（`tutor._contains`
    里那个 4 字），同样返回空串。

    **向量那一档为什么不在**（P2-2 的结论，PLAN2 §11）：量过，分不开。名字对名字的余弦里
    「隔壁那件事」比好几条真·改写还近（实测负样本最高 0.780 vs 正样本最低 0.579），
    阈值扫过 0.3–0.95 没有一个操作点两边都干净。它当**排序**用还行（取最近的那个，
    13 条正样本里 12 条落对），当**判据**用不行——而这里要的正是判据。复跑：
    `backend/.venv/Scripts/python.exe smoke_cross.py`。
    """
    needle = _norm(topic)
    if not needle:
        return ""

    exact = {c for c, aliases in names.items() if any(_norm(a) == needle for a in (c, *aliases))}
    if len(exact) == 1:
        return next(iter(exact))
    if len(exact) > 1:
        return ""

    loose = {c for c, aliases in names.items() if any(_contains(topic, a) for a in (c, *aliases))}
    return next(iter(loose)) if len(loose) == 1 else ""


def crosscheck(
    topic: str,
    again_7d: int,
    *,
    names: dict[str, set[str]],
    mastered: set[str],
    said_n: dict[str, int] | None = None,
) -> dict:
    """一张卡 vs 概念的对照事实。Pure——**只摆两边的事实，一个判断都不下**。

    - `concept`：这张卡说的是哪个概念（`""` = 关联不上，那是常态）；
    - `mastered`：那个概念**在概念轨上**算不算掌握（判据只有一个：`tutor.is_mastered`）；
    - `said_n`：你在它面前**说通过几次**（`verdict == "got"` 的场次数）。不是会话总数：
      「说通 1 次 + 半懂 3 次」按现有判据也算掌握（最近一次说通、总场次 ≥2），但台词要说的
      数字是**说通的次数**，读得出来才说；
    - `again_7d`：同 topic 的卡近 7 天判「重来」的次数；
    - `contradiction`：两边**都**成立才算（已掌握 × 重来 ≥2）。这就是镜子照出的那道落差。
    """
    concept = match_topic(topic, names)
    hit = bool(concept) and concept in mastered
    again = max(0, int(again_7d or 0))
    return {
        "concept": concept,
        "mastered": hit,
        "said_n": int((said_n or {}).get(concept, 0)) if concept else 0,
        "again_7d": again,
        "contradiction": bool(hit and again >= CONTRADICT_MIN_AGAIN),
    }


def concept_cards(by_topic: dict[str, dict], names: dict[str, set[str]]) -> dict[str, dict]:
    """话题卡片汇总 → **概念**卡片汇总：`{concept: {n, mature, again_7d, topics}}`。Pure。

    一个概念可能对应好几个话题词（出卡时模型每次写的都不一样），所以是**累加**：
    问的是「这个概念名下的卡现在怎么样」，不是「这个字符串出现了几次」。
    匹配不上的话题进不了结果——关联不上不是失败，界面那边就不带这一行。

    `topics` 非空才有意义：它是**这一行数字是按哪些话题词算出来的**。学习地图那一行要点得动
    （跳到复习页只看这些卡），而「概念名 → 卡」在复习页是按 `Card.topic` 精确筛的——
    没有这一份，点过去只能靠字符串搜索，别名那种情况就会少几张。
    """
    out: dict[str, dict] = {}
    for topic, stat in (by_topic or {}).items():
        concept = match_topic(topic, names)
        if not concept:
            continue
        cur = out.setdefault(
            concept, {"n": 0, "mature": 0, "again_7d": 0, "topics": []}
        )
        cur["n"] += int(stat.get("n") or 0)
        cur["mature"] += int(stat.get("mature") or 0)
        cur["again_7d"] += int(stat.get("again_7d") or 0)
        if topic not in cur["topics"]:
            cur["topics"].append(topic)
    return out


def prereq_candidates(
    pool: list[str], *, half: set[str], recurring: set[str], limit: int = PREREQ_MAX
) -> list[dict]:
    """「可能缺的前置」——从 `pool` 里挑出**半懂 / 又卡住**的概念。Pure。

    - `pool` 按可信度排序（结构证据在前、语义在后，`concept_neighbors` 已经排好），
      输出保持这个顺序：它是**建议**，不是结论；
    - **已掌握的不进候选**：掌握了的概念不可能是你卡住的原因；说通过一次但还没到掌握的
      也不进——那不是「不通」，是「还没熟」，把它摆在这儿会给它扣一顶不是它的帽子；
    - 两个状态都占就都写上（「半懂 · 又卡住」）：那一栏是给人看的，不是给我的分组；
    - 候选空着**不是失败**：找不到就不显示，不硬凑（PLAN2 §2 T3 第 4 条）。
    """
    out: list[dict] = []
    seen: set[str] = set()
    for name in pool or []:
        name = (name or "").strip()
        if not name or name in seen:
            continue
        tags = []
        if name in half:
            tags.append(HALF_LABEL)
        if name in recurring:
            tags.append(RECURRING_LABEL)
        if not tags:
            continue
        seen.add(name)
        out.append({"concept": name, "status": " · ".join(tags)})
        if len(out) >= max(1, int(limit or PREREQ_MAX)):
            break
    return out


# ---------- 读真值（best-effort：桥塌了不该挡教学，也不该挡复习） ----------


# ---------- 度量：回指采纳（PLAN2 §6 第三条，只进仪表盘） ----------

ADOPT_DAYS = 90
ADOPT_RULE = (
    "分母 = 这 {days} 天里**翻过**「可能缺前置」候选的搁置卡数（`cards.prereq_seen_at`）；"
    "分子 = 其中**真从候选点进去开了课**的卡数（`tutor_sessions.prereq_card_id`）。"
    "拉取式功能「有没有人看」是它唯一的生死指标——没人看就撤，不留尸体。"
)
ADOPT_BIAS = (
    "「翻过」由界面在真去取候选那一下记一笔（`POST /{id}/prereq/seen`）："
    "取候选失败的那一次不会记进去，所以分母**只会偏小**（采纳率看起来偏好一点）。"
    "两个计数都摆出来，样本多大自己看。"
)


def adoption(seen: set[int], adopted: set[int]) -> tuple[int, int, float | None]:
    """`(采纳数, 翻过数, 采纳率)`。Pure。

    两边都是**卡的个数**（不是一个数课、一个数卡）：同一张卡可以开出好几场课，
    但那张卡只算「被采纳过一次」——否则同一张卡点两下就能把率刷上去。

    **一张都没翻过时比率是 `None` 而不是 0**：0 读作「翻了但一次都没点」，
    与「没人翻过」是两件事（差了整整一个功能）。采纳的卡**不在翻过的卡里**时
    照样只算分子那一个（界面理论上不会出现，真出现了就是数据有洞，别把它藏起来）。
    """
    denom = len(seen)
    if denom == 0:
        return 0, 0, None
    n = len(adopted)
    return n, denom, round(n / denom, 3)


async def adoption_rate(days: int = ADOPT_DAYS) -> dict:
    """回指采纳（PLAN2 §6）：搁置卡的前置候选，翻过多少张、真开课了多少张。

    **只进仪表盘**——不设目标、不排名、不进零柒嘴里。这一条尤其不能变成目标：
    它的用途是「没人看就撤」，把它挂在墙上就会变成「多用几次」。
    """
    from sqlalchemy import func, select

    from app.core import pet
    from app.db import SessionLocal
    from app.models import Card, TutorSession

    span = max(1, min(int(days or ADOPT_DAYS), 3650))
    out = {
        "readable": False,
        "error": "",
        "days": span,
        "n": 0,
        "denominator": 0,
        "rate": None,
        "rule": ADOPT_RULE.format(days=span),
        "bias": ADOPT_BIAS,
    }
    try:
        # 窗口换算也在 try 里：读不动的时候这条数是**读不到**，不是 500。
        # ⚠️ `local_day_utc_bounds` 给的是**那一天**的区间，两头要分开取。
        today = datetime.now().astimezone().replace(hour=0, minute=0, second=0, microsecond=0)
        start, _ = pet.local_day_utc_bounds(today - timedelta(days=span - 1))
        _, end = pet.local_day_utc_bounds(today)
        async with SessionLocal() as db:
            seen = {
                int(r[0])
                for r in (
                    await db.execute(
                        select(Card.id).where(
                            Card.prereq_seen_at.is_not(None),
                            *_in_window2(Card.prereq_seen_at, start, end),
                        )
                    )
                ).all()
            }
            adopted = {
                int(r[0])
                for r in (
                    await db.execute(
                        select(func.distinct(TutorSession.prereq_card_id)).where(
                            TutorSession.prereq_card_id.is_not(None),
                            *_in_window2(TutorSession.created_at, start, end),
                        )
                    )
                ).all()
                if r[0] is not None
            }
    except Exception as e:  # noqa: BLE001 - 派生视图，坏了就说读不到
        log.warning("cross adoption query failed", exc_info=True)
        out["error"] = f"{type(e).__name__}: {e}"
        return out
    n, denom, rate = adoption(seen, adopted)
    out.update(readable=True, error="", n=n, denominator=denom, rate=rate)
    return out


def _in_window2(col, start: str, end: str):  # noqa: ANN001 - SQLAlchemy 列表达式
    """与 `metrics._in_window` 同一个写法（`CAST(col AS TEXT)` 的字典序就是时间序）。

    这里没有 import 那一份，是因为它住在度量模块里、而这是 T3 这条线自己的查询；
    写法只有两行，抄它的**形状**比跨模块借一个下划线函数更清楚。两处都有一句注释钉着。
    """
    from sqlalchemy import String, cast

    return (cast(col, String) >= start, cast(col, String) < end)


def _empty_index() -> dict:
    """空索引。`ok=False` 是**读不到**，不是「一条都没有」——调用方要能分开这两件事
    （矛盾率的分母为 0 只在 `ok=True` 时才等于「还没有已掌握的概念」）。"""
    return {
        "ok": False,
        "names": {},
        "mastered": set(),
        "half": set(),
        "recurring": set(),
        "said_n": {},
    }


async def concept_index() -> dict:
    """概念轨索引，一次查询算完：全部叫法 / 已掌握 / 半懂 / 又卡住 / 说通次数。

    **原料是 `tutor._concept_rows()`**（有概念、自评不是 useless 的会话）——与 `concepts()`、
    `learning_map()` 读的是同一批。不用公开的 `concepts()` 是因为它按 `CONCEPTS_CAP=200`
    截断，而关联不该因为「概念太多」而静默少认几个。

    四个集合各自的判据都**从 tutor 借**，不在这里重写：掌握 = `tutor.is_mastered`（唯一出处），
    半懂 = 最近一次 verdict（`_by_concept` 与 `profile()` 同一条），又卡住 = `tutor.is_recurring_mistake`
    （7 天窗口那个纯函数）。
    """
    from app.core import tutor
    from app.models import iso_utc

    try:
        rows = await tutor._concept_rows()  # noqa: SLF001
    except Exception:  # noqa: BLE001 - 派生视图，坏了返回空索引
        log.warning("cross concept rows failed", exc_info=True)
        return _empty_index()

    by = tutor._by_concept(rows)
    cutoff = iso_utc(
        datetime.now(timezone.utc) - timedelta(days=tutor.RECURRING_WINDOW_DAYS)
    ) or ""
    said_n: dict[str, int] = {}
    for r in rows:
        if r.verdict == "got":
            said_n[r.concept] = said_n.get(r.concept, 0) + 1
    return {
        "ok": True,
        "names": concept_names(rows),
        "mastered": {c for c, v in by.items() if tutor.is_mastered(v)},
        "half": {c for c, v in by.items() if v["verdict"] == "half"},
        "recurring": {
            c for c, v in by.items() if tutor.is_recurring_mistake(v, cutoff=cutoff)
        },
        "said_n": said_n,
    }


async def topic_cards(days: int = AGAIN_DAYS) -> dict[str, dict]:
    """话题词 → `{n, mature, again_7d}`。两条查询，纯汇总，坏掉返回空表。

    「成熟」用 `cards.MATURE_DAYS`（`cards.stats()` 那条规则，同一个字面量只留一份），
    「重来」用 `AGAIN_GRADE`。窗口是**滚动 N 天**（锚在「现在」），与 `cards.stats()` /
    `weak_sources()` 同一个口径。
    """
    from sqlalchemy import text as sql

    from app.core import cards as cards_core
    from app.db import SessionLocal

    span = max(1, int(days or AGAIN_DAYS))
    try:
        async with SessionLocal() as db:
            base = (
                await db.execute(
                    sql(
                        "SELECT topic, COUNT(*), "
                        "       SUM(CASE WHEN suspended = 0 AND interval_days >= :mature "
                        "                THEN 1 ELSE 0 END) "
                        "FROM cards WHERE topic <> '' GROUP BY topic"
                    ).bindparams(mature=cards_core.MATURE_DAYS)
                )
            ).all()
            again = (
                await db.execute(
                    sql(
                        "SELECT c.topic, COUNT(*) FROM cards c "
                        "JOIN card_reviews r ON r.card_id = c.id "
                        "WHERE c.topic <> '' AND r.grade = :g "
                        f"  AND r.reviewed_at >= datetime('now', '-{span} days') "
                        "GROUP BY c.topic"
                    ).bindparams(g=AGAIN_GRADE)
                )
            ).all()
    except Exception:  # noqa: BLE001 - 派生视图，坏了就当没有卡
        log.warning("cross topic cards failed", exc_info=True)
        return {}

    out: dict[str, dict] = {}
    for topic, n, mature in base:
        out[str(topic)] = {"n": int(n or 0), "mature": int(mature or 0), "again_7d": 0}
    for topic, n in again:
        t = str(topic)
        if t in out:
            out[t]["again_7d"] = int(n or 0)
    return out


async def _again_for_topic(topic: str, days: int = AGAIN_DAYS) -> int:
    """同 topic 的卡近 N 天判「重来」的次数（**所有同 topic 的卡**，不只这一张）。"""
    from sqlalchemy import text as sql

    from app.db import SessionLocal

    if not (topic or "").strip():
        return 0
    span = max(1, int(days or AGAIN_DAYS))
    try:
        async with SessionLocal() as db:
            n = (
                await db.execute(
                    sql(
                        "SELECT COUNT(*) FROM cards c "
                        "JOIN card_reviews r ON r.card_id = c.id "
                        "WHERE c.topic = :topic AND r.grade = :g "
                        f"  AND r.reviewed_at >= datetime('now', '-{span} days')"
                    ).bindparams(topic=topic, g=AGAIN_GRADE)
                )
            ).scalar()
    except Exception:  # noqa: BLE001
        log.warning("cross again-count failed", exc_info=True)
        return 0
    return int(n or 0)


async def concept_summaries() -> dict[str, dict]:
    """概念 → 它名下的卡现状 `{n, mature, again_7d}`（学习地图那一行小字）。

    **只在 n > 0 时才有这个键**（与「只摆非零」同一条规矩）；没有卡的概念不带它，
    界面就不显示那一行。整条坏掉返回空表——地图照常，只少一行小字。
    """
    idx = await concept_index()
    if not idx["names"]:
        return {}
    return concept_cards(await topic_cards(), idx["names"])


# ---------- 度量：双轨矛盾率（PLAN2 §6，只进仪表盘） ----------

GAP_WINDOW_DAYS = 30
GAP_RULE = (
    "分母 = 已掌握的概念数（说通 ×2，判据只有 `is_mastered` 那一个）；"
    "分子 = 其中「同一个话题词的卡这些天判过重来」的概念数。"
    "**它降说明两条轨接上了**——概念轨说你懂了，卡片轨还在说你没懂，这个数就是那道落差。"
)


def gap_rate(mastered: set[str], bad: set[str]) -> tuple[int, int, float | None]:
    """`(分子, 分母, 比值)`。Pure。

    **分母为 0 时比值是 `None` 而不是 0**：一个概念都没掌握，与「一条矛盾都没有」
    是两件事——前者是还没有数据，后者是桥真的通了。
    """
    denom = len(mastered)
    if denom == 0:
        return 0, 0, None
    n = len(mastered & bad)
    return n, denom, round(n / denom, 3)


async def _again_topics(days: int) -> set[str]:
    """近 N 天判过「重来」的话题词（一条查询）。给矛盾率用——它要的是 30 天，
    而递卡那句对质要的是 7 天，两个窗口是两个数，不能混。"""
    from sqlalchemy import text as sql

    from app.db import SessionLocal

    span = max(1, int(days))
    async with SessionLocal() as db:
        rows = (
            await db.execute(
                sql(
                    "SELECT DISTINCT c.topic FROM cards c "
                    "JOIN card_reviews r ON r.card_id = c.id "
                    "WHERE c.topic <> '' AND r.grade = :g "
                    f"  AND r.reviewed_at >= datetime('now', '-{span} days')"
                ).bindparams(g=AGAIN_GRADE)
            )
        ).all()
    return {str(r[0]) for r in rows}


async def contradiction_rate(days: int = GAP_WINDOW_DAYS) -> dict:
    """双轨矛盾率（PLAN2 §6）：**只进仪表盘**——不设目标、不排名、不进零柒嘴里。

    读不出来时 `readable=false` 且 `rate=None`（不拿 0 充数）。这一条是本规划要消灭的
    那个东西，所以它必须能读得准；读不准的时候说读不准。
    """
    span = max(1, min(int(days or GAP_WINDOW_DAYS), 365))
    out = {
        "readable": False,
        "error": "",
        "days": span,
        "n": 0,
        "denominator": 0,
        "rate": None,
        "rule": GAP_RULE,
    }
    # 索引坏了（`ok=False`）时**不能**说「还没有已掌握的概念」：那是把「读不到」说成
    # 「一条都没有」——这张卡说的正是这件事，它自己更不能犯。
    idx = await concept_index()
    if not idx.get("ok"):
        out["error"] = "概念索引读不出来"
        return out
    try:
        bad = {
            c
            for c in (match_topic(t, idx["names"]) for t in await _again_topics(span))
            if c
        }
        n, denom, rate = gap_rate(idx["mastered"], bad)
    except Exception as e:  # noqa: BLE001 - 派生视图，坏了就说读不到
        log.warning("cross gap rate failed", exc_info=True)
        out["error"] = f"{type(e).__name__}: {e}"
        return out
    out.update(readable=True, n=n, denominator=denom, rate=rate)
    return out


async def card_crosscheck(card_id: int) -> dict | None:
    """一张卡的对照事实（T1）。卡不存在 → `None`（调用方翻译成 404）。"""
    from sqlalchemy import select

    from app.db import SessionLocal
    from app.models import Card

    try:
        async with SessionLocal() as db:
            card = (
                await db.execute(select(Card).where(Card.id == card_id))
            ).scalar_one_or_none()
    except Exception:  # noqa: BLE001
        log.warning("cross card lookup failed", exc_info=True)
        return None
    if card is None:
        return None

    idx = await concept_index()
    fact = crosscheck(
        card.topic or "",
        await _again_for_topic(card.topic or ""),
        names=idx["names"],
        mastered=idx["mastered"],
        said_n=idx["said_n"],
    )
    return {"card_id": card.id, **fact}


async def due_contradiction(limit: int = DUE_SCAN_CAP) -> dict:
    """今天到期的卡里，**最该说破的那一条**矛盾事实（T1 场景 A）。没有 → `null`。

    扫队列顺序（due 最早在前）的前 `limit` 张，找到第一条矛盾就停。**没有一个已掌握的概念
    时直接返回空**——那是最常见的一种情况，也是这条查询最便宜的短路。

    它**不是新的一个提醒来源**：服务的是原来那条「到期卡」，只换那句话的内容，不加来源、
    不动优先级（PLAN2 §2 T1）。
    """
    from sqlalchemy import select

    from app.db import SessionLocal
    from app.models import Card, utcnow

    cap = max(1, min(int(limit or DUE_SCAN_CAP), 200))
    try:
        async with SessionLocal() as db:
            rows = (
                (
                    await db.execute(
                        select(Card)
                        .where(Card.suspended.is_(False), Card.due <= utcnow())
                        .order_by(Card.due)
                        .limit(cap)
                    )
                )
                .scalars()
                .all()
            )
    except Exception:  # noqa: BLE001
        log.warning("cross due scan failed", exc_info=True)
        return {"contradiction": None}
    if not rows:
        return {"contradiction": None}

    idx = await concept_index()
    if not idx["mastered"]:
        return {"contradiction": None}
    by_topic = await topic_cards()
    for card in rows:
        stat = by_topic.get(card.topic or "", {})
        fact = crosscheck(
            card.topic or "",
            int(stat.get("again_7d") or 0),
            names=idx["names"],
            mastered=idx["mastered"],
            said_n=idx["said_n"],
        )
        if fact["contradiction"]:
            return {"contradiction": {"card_id": card.id, **fact}}
    return {"contradiction": None}


async def mark_prereq_seen(card_id: int) -> bool:
    """记一笔「这张卡的候选被翻过」（PLAN2 §6 回指采纳的分母）。卡不存在 → False。

    **单独一个写入口，不在那条 GET 里顺手写**：读路径带副作用的话，翻页、重试、
    浏览器预取都会把它记账，而「看过」是一个必须说得准的数——说不准就会把一个没人
    用的功能判成有人用（这一条的用途正是「没人看就撤」）。
    """
    from sqlalchemy import select

    from app.db import SessionLocal
    from app.models import Card, utcnow

    try:
        async with SessionLocal() as db:
            card = (
                await db.execute(select(Card).where(Card.id == card_id))
            ).scalar_one_or_none()
            if card is None:
                return False
            card.prereq_seen_at = utcnow()
            await db.commit()
    except Exception:  # noqa: BLE001 - 记不上这一笔不该让界面出错
        log.warning("cross mark prereq seen failed", exc_info=True)
        return False
    return True


async def prereq(card_id: int) -> dict | None:
    """一张卡「可能缺的前置」（T3）。卡不存在 → `None`。

    **拉取式**：被点到才算一次，没有任何东西会催你（不进 nudge、不冒泡、不计数）。
    候选池的构成：这张卡的话题命中到的概念**自己**（如果它还是半懂，那它就是缺的那一段：
    先讲通它再刷它的卡），加上它的邻居——邻居那一路是 `tutor.concept_neighbors` 的三份证据
    （同一件事 / 同一份材料 / 语义相近），命不中概念名时它退化成纯语义最近的那几个。

    候选是**建议不是结论**：界面上写「可能缺前置」。
    """
    from sqlalchemy import select

    from app.core import tutor
    from app.db import SessionLocal
    from app.models import Card

    try:
        async with SessionLocal() as db:
            card = (
                await db.execute(select(Card).where(Card.id == card_id))
            ).scalar_one_or_none()
    except Exception:  # noqa: BLE001
        log.warning("cross prereq card lookup failed", exc_info=True)
        return None
    if card is None:
        return None

    idx = await concept_index()
    topic = card.topic or ""
    concept = match_topic(topic, idx["names"])
    pool: list[str] = [concept] if concept else []
    try:  # 邻居那一路要靠 embedder；挂了就只剩「概念自己」那一份
        for n in await tutor.concept_neighbors(concept or topic, limit=tutor.NEIGHBOR_LIMIT):
            pool.append(n.get("concept") or "")
    except Exception:  # noqa: BLE001
        log.warning("cross prereq neighbors failed", exc_info=True)

    return {
        "card_id": card.id,
        "topic": topic,
        "concept": concept,
        "suspended": bool(card.suspended),
        "lapses": int(card.lapses or 0),
        "candidates": prereq_candidates(
            pool, half=idx["half"], recurring=idx["recurring"]
        ),
    }
