"""陈述式周报（M4 · PLAN §3 G4）：周日晚上，零柒把这一周**已经发生的事**说一遍。

**它解决什么。** 一天一句「今天消化了 2 个点」说的是今天；跨到一周，你才看得出
「这周我到底往哪儿走了」。但这件事只有一种做法是安全的：**全部是读出来的事实**——
所以这里是**派生视图**，不落任何新表、新列（PLAN §4 那张表里 G4 那一行就写着
「实时读 cards / `tutor_sessions` / 目录，不落任何新东西」）。

**为什么挂在既有那句 21:00 问候上**（`pet.greeting` 的 evening 分支）：
`sched.set_daily` 只支持「每天一条」，为周报单开一条 cron 的结果是周日 21:00
**两句话同时冒出来**（一条「今天…」一条「这周…」）。同一时刻只该有一个声音，
所以是「在既有那句里判 `weekday()`」，不是新增一条定时。

**第一人称是谁。** 开口的是零柒（这句是它说的，播客也是它在念），事实的主语是「你」——
与既有那批台词同一套人称（「你把「X」搞懂了」「「X」交出去了」）。反过来把主语写成
「我」（「我这周消化了 3 份材料」）在别处是行不通的：那等于**把你的活儿记到它头上**，
而成长值那条线一直守着「算出来的、不是它发的奖」——同一句话里人称一乱，那条线就白守了。

**不说「还欠」。** 没有「答应我没教」，只有「这周有 2 个概念还停在半懂」。
一周没有数据就 `text == ""`，那句问候于是退回普通问候——**不硬凑一句「这周什么也没干」**
（与 `_day_said` 同一条纪律）。

**句子归一处。** `text()` 是纯函数，它同时是三件事的唯一出处：没有 provider 时那句
问候、`GET /api/pet/weekly-report` 给界面看的、以及转播客时念的稿子。模型只负责
「换种说法说同一批事实」（`pet.greeting` 里那一支），不负责决定说什么。
"""

import logging
from datetime import datetime, timedelta

from sqlalchemy import String, cast, func, select

from app.db import SessionLocal
from app.models import DigestPoint, TutorSession

log = logging.getLogger(__name__)

__all__ = [
    "RECURRING_CAP",
    "SUNDAY",
    "facts",
    "podcast_title",
    "report",
    "sunday_report",
    "text",
    "to_podcast",
    "window",
]

SUNDAY = 6  # `datetime.weekday()`：周一 = 0
RECURRING_CAP = 3  # 「又卡住」最多念几个：周报是陈述，不是错题清单


def window(now: datetime | None = None) -> tuple[str, str]:
    """这一周的 UTC 区间 `[周一 00:00 本地, 明天 00:00 本地)`，字符串格式与库里的列一致。

    **两端都从 `pet.local_day_utc_bounds` 出来**（那一份换算只能有一处）：本地日的
    换算本来就带着夏令时那类取舍，第二份实现迟早和它差一小时。

    上界取「明天 00:00」而不是「此刻」：库里不会有未来的行，两者等价，但这样上界
    与下界同源，不必再写第二个把 aware 时间格式化成 naive UTC 的函数。
    """
    from app.core import pet

    now = now or datetime.now()
    if now.tzinfo is None:
        now = now.astimezone()
    monday = (now - timedelta(days=now.weekday())).replace(
        hour=0, minute=0, second=0, microsecond=0
    )
    return pet.local_day_utc_bounds(monday)[0], pet.local_day_utc_bounds(now)[1]


def _in_window(col, start: str, end: str):  # noqa: ANN001 - SQLAlchemy 列表达式
    """列在区间里。`CAST(col AS TEXT)` 是仓库里读这三种时间口径时的既有写法
    （`pet_state.day_facts` 同一招）：定长格式的字典序就是时间序，不必赌存储格式。"""
    return (cast(col, String) >= start, cast(col, String) < end)


async def facts(now: datetime | None = None) -> dict:
    """本周的事实。**全是真数出来的**：读不出来就给 0 / 空表，绝不抛。

    五样（PLAN §3 G4 点名的就是这五样）：消化了几份材料（`digest_points.source`
    去重）与拆出几个点、说通几个概念、几个概念还停在半懂（`tutor_sessions.verdict`）、
    交出几份成品（`pet.is_output_path` 那几个目录）、「又卡住」的概念（`tutor.
    is_recurring_mistake` 那条判据——**不在这里重写一遍**）。
    """
    now = now or datetime.now()
    start, end = window(now)
    out: dict = {"sources": 0, "points": 0, "got": 0, "half": 0, "outputs": 0, "recurring": []}

    try:
        async with SessionLocal() as db:
            row = (
                await db.execute(
                    select(
                        func.count(func.distinct(DigestPoint.source)),
                        func.count(),
                    ).where(
                        DigestPoint.source != "",
                        *_in_window(DigestPoint.created_at, start, end),
                    )
                )
            ).one()
            out["sources"] = int(row[0] or 0)
            out["points"] = int(row[1] or 0)

            rows = (
                await db.execute(
                    select(
                        TutorSession.verdict,
                        func.count(func.distinct(TutorSession.concept)),
                    )
                    .where(
                        TutorSession.concept != "",
                        TutorSession.verdict.in_(("got", "half")),
                        *_in_window(
                            func.coalesce(TutorSession.ended_at, TutorSession.created_at),
                            start,
                            end,
                        ),
                    )
                    .group_by(TutorSession.verdict)
                )
            ).all()
            for verdict, n in rows:
                if verdict in ("got", "half"):
                    out[str(verdict)] = int(n or 0)
    except Exception:  # noqa: BLE001 - 派生视图：读不出来就少说一句，不是错误
        log.debug("weekly facts query failed", exc_info=True)

    try:
        # 成品按**改动时间**落在本周算（与 `day_facts` 数今天那几份同一把尺）。
        # 目录清单来自 `pet_state.output_files`——也就是 `pet.is_output_path` 那一份判据。
        import calendar

        from app.core import pet_state as state

        # `start` 是 naive UTC 串，必须**当 UTC** 取 epoch（`timegm`）。用 `.timestamp()`
        # 会按本机时区解释它：+08 下等于把周一 00:00 读早八小时，上周日的成品会被算进来。
        start_epoch = calendar.timegm(datetime.fromisoformat(start).timetuple())
        out["outputs"] = sum(1 for _rel, m in state.output_files() if m >= start_epoch)
    except Exception:  # noqa: BLE001
        log.debug("weekly facts output scan failed", exc_info=True)

    try:
        from app.core import tutor

        out["recurring"] = [
            str(c.get("concept") or "") for c in (await tutor.recurring_mistakes())[:RECURRING_CAP]
        ]
    except Exception:  # noqa: BLE001 - 少这一句不算失败
        log.debug("weekly recurring mistakes failed", exc_info=True)
    return out


def text(f: dict) -> str:
    """事实 → 两句以内的人话。**纯函数**：它是这句周报的唯一出处（见模块开篇）。

    第一句是**已经做到的**（消化 / 说通 / 交出），第二句是**还没走通的**（半懂 / 又卡住）。
    分成两句是有意的：混在一串顿号里读起来像一张对账单，而这两件事的语气本来就不一样。

    一件都没有（含「又卡住」也没有）→ 空串。调用方据此退回普通问候，
    所以这里**绝不能**补一句「这周什么也没干」。
    """
    bits: list[str] = []
    sources, points = int(f.get("sources") or 0), int(f.get("points") or 0)
    if sources:
        bits.append(f"消化了 {sources} 份材料" + (f"（拆出 {points} 个点）" if points else ""))
    elif points:
        bits.append(f"拆出 {points} 个点")
    if int(f.get("got") or 0) > 0:
        bits.append(f"说通了 {int(f['got'])} 个概念")
    if int(f.get("outputs") or 0) > 0:
        bits.append(f"交出 {int(f['outputs'])} 份成品")
    head = f"这周你{'、'.join(bits)}。" if bits else ""

    rest: list[str] = []
    if int(f.get("half") or 0) > 0:
        rest.append(f"有 {int(f['half'])} 个概念停在半懂")
    names = [str(n).strip() for n in (f.get("recurring") or []) if str(n).strip()]
    if names:
        rest.append("".join(f"「{n}」" for n in names) + "还是没走通")
    tail = f"{'，'.join(rest)}。" if rest else ""
    return f"{head}{tail}"


async def report(now: datetime | None = None) -> dict:
    """给界面看的那份周报：事实 + 那句话 + 区间。**任何一天都能看**（拉取式）。

    区间是**本自然周**（周一 → 今天），所以周三点开时它说的是「这周到今天为止」——
    界面上把区间摆出来（`week`），别让一个半周的数和一整周的数看起来一样。
    """
    now = now or datetime.now()
    if now.tzinfo is None:
        now = now.astimezone()
    f = await facts(now)
    line = text(f)
    monday = now - timedelta(days=now.weekday())
    return {
        "week": {"start": monday.strftime("%Y-%m-%d"), "end": now.strftime("%Y-%m-%d")},
        "facts": f,
        "text": line,
        "empty": not line,
    }


async def sunday_report(now: datetime | None = None) -> dict | None:
    """周日晚上该说的那份周报；**不是周日、或这一周没数据 → None**（那就普通问候）。

    两个条件写在同一个地方：`greeting` 只问「今晚有没有周报要说」，不自己判 weekday——
    判据散成两处，改一处忘一处就是「周三突然开始念周报」这种安静的错。
    """
    now = now or datetime.now()
    if now.weekday() != SUNDAY:
        return None
    rep = await report(now)
    return rep if rep["text"] else None


def podcast_title(rep: dict) -> str:
    """这一期的标题：「周报 09-14–09-16」。Pure."""
    w = rep.get("week") or {}
    a, b = str(w.get("start") or "")[5:], str(w.get("end") or "")[5:]
    return f"周报 {a}–{b}".strip(" –") or "周报"


async def to_podcast(voice: str = "", now: datetime | None = None) -> dict:
    """周报 → 一段音频（单音色念稿，复用 `core/podcast`）。

    **不过模型**：稿子已经是成品文本（`text()`）。对话播客要的是编剧，这里要的只是
    一张嘴——所以走 `podcast.speak_text`，也因此在没有 provider 的机器上照样能用。
    """
    from app.core import podcast

    rep = await report(now)
    if not rep["text"]:
        # `empty` 是给路由看的状态位（它据此回 422 而不是 400）：别让调用方去
        # 猜错误文案里的字——那种耦合会在改一句话的时候安静地断掉。
        return {"ok": False, "empty": True, "error": "这一周还没有可陈述的事"}
    return await podcast.speak_text(rep["text"], title=podcast_title(rep), voice=voice)
