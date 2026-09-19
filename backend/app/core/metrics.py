"""度量（PLAN §7）：**只画曲线，不进它嘴里**。

**它解决什么。** G1–G5 都做完了，但「到底有没有用」这件事一直没人回答。零柒的成长值
数是**累计**的（只增不减，永远向上），所以它回答不了「这周我走得稳吗」。北极星就是那一条
会上下起伏的曲线：**周内「重讲作答 ≥1 次 且 消化材料 ≥1 份」的天数 / 7**。

§7.2 的两条过程指标也在这里（同一个红线、同一套「读不到就说读不到」）：

- **半懂率按周**（`half_rate`）：八个自然周，每周「半懂 / (说通 + 半懂)」。
  北极星说这周**动没动**，这一条说动的那部分**有没有落下**；
- **判分档位分布**：在 T2 的校准曲线里（`cards.calibration` 的 `judged_dist`），
  不在这里重算一份——同一条事实不许有两个出处。

**两个来源钉死在 `core` 里**（PLAN §7 写死的口径，这里只做它的实现）：

- 「重讲作答」= 当天 `card_reviews.retell` **非空**的行——自评那一路照旧留空，
  所以自评再多也不进这条曲线（那正是「重讲」这个动作的凭据，M1 加的就是这一列）；
- 「消化材料」= 当天 `digest_points` 有新增行。**拆点即消化**：粘贴的材料走同一条路，
  也会落行；所以这里数的是**点**，不是文件。

**已知偏差写在明处**（PLAN §7 要求的）：同一份材料重拆一遍不新增行（按 `(source, point)`
去重），那天就不算。这是派生指标的代价——不为它加一张「今天消化过」的事件表。
界面上也照实写着这句，免得有人拿这个数去对「我明明又看了一遍」。

**红线（这句决定了本模块的形状）：**这些数只进仪表盘曲线——不设目标、不排名、
**不变成零柒嘴里的任何一句话**。所以本模块里**没有一行 `pet.*`**：不 emit、不讲话、
也不进问候。宠物那边说的是「你走到哪了」（累计），这里说的是「这周走得稳不稳」（起伏）——
两者混起来，曲线就会变成督促。这条红线有一条测试盯着（跑完曲线，宠物一个字都没说）。

**一天一次查询。** 7 天 × 2 张表 = 14 条带索引的小查询，个人库上是毫秒级；换来的好处是
本地日的换算**只用 `pet.local_day_utc_bounds` 那一份**——先捞全部行再在 Python 里换算
本地日期，等于给仓库里那三种时间口径再加一种。
"""

import logging
from datetime import datetime, timedelta

from sqlalchemy import String, cast, func, select

from app.db import SessionLocal
from app.models import CardReview, DigestPoint, TutorSession

log = logging.getLogger(__name__)

__all__ = [
    "WINDOW_DAYS",
    "WEEKS",
    "classify",
    "days",
    "fold_weeks",
    "half_rate",
    "north_star",
    "rate_of",
    "summary",
    "week_starts",
]

WINDOW_DAYS = 7
# 口径原文：界面上照抄这两句，别让「重讲作答」在代码里与在界面上是两个意思。
RETELL_RULE = "当天有重讲原文的复习记录（`card_reviews.retell` 非空）"
DIGEST_RULE = "当天拆出了新的点（`digest_points` 有新增行）"
KNOWN_BIAS = "同一份材料重拆不新增行（按来源+点去重），那天就不算——派生指标的代价，不为它加事件表。"

# ---------- §7.2 过程指标：半懂率按周 ----------
#
# **为什么是这条。** 北极星问「这周走得稳不稳」（动没动），这一条问「教的成色怎么样」
# （动的那部分有没有落下）。真值仍然只有 `tutor_sessions` 一处，不新增任何表。
WEEKS = 8  # 看八个自然周（含本周）；再多就不是「最近」了
HALF_RULE = "半懂率 = 那一周半懂的会话 / 那一周说通或半懂的会话（`tutor_sessions.verdict`）"
USELESS_RULE = "「没用」不进任何一个分母：教学没成，证明不了水平（与 `concepts()` / `is_mastered` 同一条规矩）"
WEEK_RULE = (
    "按**会话开始的本地时刻**分周（周一零点起算，与周报同一个约定）："
    "`created_at` 永远有值，而按结束时刻分组会让「有 verdict 但没 ended_at」的行静默消失"
    "——口径写清楚，好过静默少行。"
)


def days(now: datetime | None = None, span: int = WINDOW_DAYS) -> list[datetime]:
    """最近 `span` 个**本地日**的零点，旧 → 新（最后一个是今天）。Pure。

    返回的是本地朴素时间（当天 00:00）——它是喂给 `pet.local_day_utc_bounds` 的输入，
    不是拿去比数据库的东西：本地日 ↔ UTC 边界**只有那一处换算**。
    """
    now = now or datetime.now()
    if now.tzinfo is None:
        now = now.astimezone()
    today = now.replace(hour=0, minute=0, second=0, microsecond=0)
    return [today - timedelta(days=i) for i in range(max(1, int(span)) - 1, -1, -1)]


def classify(marks: list[dict]) -> list[dict]:
    """每天的两条事实 → 加一栏 `counted`（那天两件事都发生了）。Pure。

    **两个都 ≥1 才算一天**，这是北极星的定义，也是最容易被悄悄放宽的地方
    （只重讲不算、只消化也不算——「讲」是输出、「消化」是输入，缺一半转不起来）。
    """
    out: list[dict] = []
    for m in marks:
        retell = int(m.get("retell") or 0)
        digested = int(m.get("digested") or 0)
        out.append(
            {
                "date": str(m.get("date") or ""),
                "retell": retell,
                "digested": digested,
                "counted": retell >= 1 and digested >= 1,
            }
        )
    return out


def rate_of(curve: list[dict]) -> float | None:
    """`数出来的天数 / 窗口长度`。空曲线 → None（**不给 0**：没有窗口就没有比率）。Pure."""
    if not curve:
        return None
    return round(sum(1 for d in curve if d.get("counted")) / len(curve), 3)


def summary(curve: list[dict]) -> dict:
    """曲线 → 那个数。`denominator` 就是窗口长度（7），不写死 7：窗口改了这里跟着改。Pure."""
    counted = sum(1 for d in curve if d.get("counted"))
    return {"counted": counted, "denominator": len(curve), "rate": rate_of(curve)}


def _in_window(col, start: str, end: str):  # noqa: ANN001 - SQLAlchemy 列表达式
    """列在区间里。`CAST(col AS TEXT)` 与 `pet_state.day_facts` 是同一个写法：
    定长格式的字典序就是时间序，不必赌存储格式。"""
    return (cast(col, String) >= start, cast(col, String) < end)


async def _day_counts(now: datetime | None = None, span: int = WINDOW_DAYS) -> list[dict]:
    """最近 `span` 天：每天各有多少条重讲、多少个新的点。读不出来就抛（调用方兜底）。"""
    from app.core import pet

    marks: list[dict] = []
    async with SessionLocal() as db:
        for d in days(now, span):
            start, end = pet.local_day_utc_bounds(d)
            retell = (
                await db.execute(
                    select(func.count(CardReview.id)).where(
                        CardReview.retell != "",
                        *_in_window(CardReview.reviewed_at, start, end),
                    )
                )
            ).scalar() or 0
            digested = (
                await db.execute(
                    select(func.count(DigestPoint.id)).where(
                        *_in_window(DigestPoint.created_at, start, end)
                    )
                )
            ).scalar() or 0
            marks.append(
                {"date": d.strftime("%Y-%m-%d"), "retell": int(retell), "digested": int(digested)}
            )
    return marks


async def north_star(now: datetime | None = None, span: int = WINDOW_DAYS) -> dict:
    """北极星曲线：最近 `span` 天，每天两条事实 + 那天算不算数，外加那个数。

    **读不出来时 `readable=False`**（而不是给一条全零的曲线）：零是「什么都没发生」，
    与「读不到」是两回事——曲线要是会在这两种情况下长得一样，这把尺子就不值得信了。
    """
    window = days(now, span)
    curve: list[dict] = []
    try:
        curve = classify(await _day_counts(now, span))
    except Exception as e:  # noqa: BLE001 - 派生视图，坏了照实说，不假装零
        log.warning("north star query failed", exc_info=True)
        return {
            "readable": False,
            "error": f"{type(e).__name__}: {e}",
            "window": {"start": window[0].strftime("%Y-%m-%d"), "end": window[-1].strftime("%Y-%m-%d"), "days": len(window)},
            "days": [],
            **summary([]),
            "rules": {"retell": RETELL_RULE, "digested": DIGEST_RULE, "bias": KNOWN_BIAS},
        }
    return {
        "readable": True,
        "error": "",
        "window": {
            "start": curve[0]["date"] if curve else "",
            "end": curve[-1]["date"] if curve else "",
            "days": len(curve),
        },
        "days": curve,
        **summary(curve),
        "rules": {"retell": RETELL_RULE, "digested": DIGEST_RULE, "bias": KNOWN_BIAS},
    }


# ---------- §7.2 过程指标 ----------


def week_starts(now: datetime | None = None, weeks: int = WEEKS) -> list[datetime]:
    """最近 `weeks` 个**本地自然周**的周一零点，旧 → 新（最后一个是本周）。Pure。

    周一是一周的开始——与 `weekly.window()`（那篇周报）同一个约定，不另立一个。
    返回的是本地朴素时间，喂给 `pet.local_day_utc_bounds`：本地 ↔ UTC 只有那一处换算。
    """
    now = now or datetime.now()
    if now.tzinfo is None:
        now = now.astimezone()
    today = now.replace(hour=0, minute=0, second=0, microsecond=0)
    monday = today - timedelta(days=today.weekday())
    return [monday - timedelta(weeks=i) for i in range(max(1, int(weeks)) - 1, -1, -1)]


def fold_weeks(counts: dict[str, dict], starts: list[datetime]) -> list[dict]:
    """每周的 `{got, half}` → 曲线。Pure。

    `counts` 的键是那一周周一的 `YYYY-MM-DD`（`_week_counts` 产出的形状），缺的周当 0。

    **那一周一场会话都没有时 `rate` 是 `None` 而不是 0**：0 读作「这周教的全都说通了」，
    与「这周没开过教学」是两件事——两种情况长得一样的话，这条线就会替不存在的一周报喜。
    """
    out: list[dict] = []
    for i, s in enumerate(starts):
        c = counts.get(s.strftime("%Y-%m-%d"), {}) or {}
        got, half = int(c.get("got") or 0), int(c.get("half") or 0)
        n = got + half
        out.append(
            {
                "start": s.strftime("%Y-%m-%d"),
                "end": (s + timedelta(days=6)).strftime("%Y-%m-%d"),
                "got": got,
                "half": half,
                "n": n,
                "rate": round(half / n, 3) if n else None,
                "is_current": i == len(starts) - 1,
            }
        )
    return out


def total_of(curve: list[dict]) -> dict:
    """整段窗口的合计（不是比率——合计里没有「周」这个概念了）。Pure。"""
    got = sum(int(w.get("got") or 0) for w in curve)
    half = sum(int(w.get("half") or 0) for w in curve)
    n = got + half
    return {"got": got, "half": half, "n": n, "rate": round(half / n, 3) if n else None}


async def _week_counts(now: datetime | None = None, weeks: int = WEEKS) -> dict[str, dict]:
    """每个自然周各有多少场说通 / 半懂。**一周一条查询**（只分那两档），坏掉就抛。"""
    from app.core import pet

    out: dict[str, dict] = {}
    async with SessionLocal() as db:
        for s in week_starts(now, weeks):
            start = pet.local_day_utc_bounds(s)[0]
            end = pet.local_day_utc_bounds(s + timedelta(days=7))[0]
            rows = (
                await db.execute(
                    select(TutorSession.verdict, func.count(TutorSession.id))
                    .where(
                        TutorSession.verdict.in_(("got", "half")),
                        *_in_window(TutorSession.created_at, start, end),
                    )
                    .group_by(TutorSession.verdict)
                )
            ).all()
            out[s.strftime("%Y-%m-%d")] = {str(v): int(n or 0) for v, n in rows}
    return out


async def half_rate(now: datetime | None = None, weeks: int = WEEKS) -> dict:
    """半懂率按周（PLAN §7.2）：八个自然周，每周「半懂 / (说通 + 半懂)」。

    与北极星同一条纪律：**只画曲线**（不设目标、不排名、不进零柒嘴里）、
    **读不到就说读不到**（`readable=False`，不给八格全零充数）、
    **空的一周是 `None` 不是 0**（见 `fold_weeks`）。

    它回答的是「教的成色」：北极星说这周动没动，这一条说动的那部分有多少没落下。
    """
    starts = week_starts(now, weeks)
    meta = {
        "window": {
            "start": starts[0].strftime("%Y-%m-%d"),
            "end": (starts[-1] + timedelta(days=6)).strftime("%Y-%m-%d"),
            "weeks": len(starts),
        },
        "rules": {"half": HALF_RULE, "useless": USELESS_RULE, "week": WEEK_RULE},
    }
    try:
        curve = fold_weeks(await _week_counts(now, weeks), starts)
    except Exception as e:  # noqa: BLE001 - 派生视图，坏了照实说，不假装零
        log.warning("half rate query failed", exc_info=True)
        return {"readable": False, "error": f"{type(e).__name__}: {e}", "weeks": [], "totals": total_of([]), **meta}
    return {"readable": True, "error": "", "weeks": curve, "totals": total_of(curve), **meta}
