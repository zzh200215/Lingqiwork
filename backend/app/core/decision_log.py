"""决策日志 + 校准分。

**它解决什么。** 判断做出来的时候，你心里其实有个把握程度；过几个月回头看，你只会记住
蒙对的那几次。把「判断 + 依据 + 信心」在**当时**钉下来，才谈得上校准——「你当时说七成
把握的那类事，实际应验了几成」。少了信心那一栏，判断日志就退化成一篇自我表扬。

**回看是拉取式**：没有队列、没有提醒的节奏、没有任何东西会催你。你什么时候想翻，就什么
时候翻——`outcome` 空着就是还没回看。校准分只在样本够了才给——一两条算不出「命中率」，
硬算出来的是噪音，会让人对这把尺子失去信任。

⚠️ **M4（2026-09-16）让开了一步，理由写在原地**（同一段也写在 `models.DecisionLog` 上，
两处说的是同一件事）。`witness()` 打破了「没有任何东西会催它」这条字面规矩，因为那条规矩
在 90 天这个尺度上有个可预见的坏结局：**纯拉取式的日志会变成死数据**——三个月前的判断没有
任何再被翻开的理由，`outcome` 永远空着，校准分永远凑不够样本，这张表就只剩自我表扬。

它让开的方式是**接进现有的 nudge 管线**（前端 `PetWidget.gatherNudges` 的第五个来源），
而不是新造一套提醒：一天一条、只念**这一个判断当时的事实**（原文 + 当时的依据 + 当时的
信心）、点一下就直达那一行、宠物关着就整条静默。台词里没有「你该回看了」「还欠几条」。

**为什么这是一列而不是一张表**：改主意要便宜。退回真·拉取式 = 删掉 `witness_days` 这一列
+ `witness()` + 前端那一支，没有历史数据要迁移（`created_at + witness_days` 是算出来的，
不是记下来的）。这条「让开一步」的代价因此是一次性的，而不是滚雪球。

`calibration()` 是**纯函数**：喂一组行，算命中率、按领域的命中率、按信心的校准。测试
不需要数据库、不需要模型。到期的判定（`due()`）同样是纯函数，同一个理由。
"""

import logging
from datetime import datetime, timedelta, timezone

from sqlalchemy import select

from app.db import SessionLocal
from app.models import DecisionLog, iso_utc, utcnow

log = logging.getLogger(__name__)

OUTCOMES = ("", "hit", "miss", "unclear")
MIN_SAMPLE = 3  # 一个分组至少要几条已回看才给命中率
# 默认多久之后值得回头看（天）。**首次上线 = 历史行集体到点**：老行按
# `created_at + 90 天` 立刻到期，但一天只念一条，所以是安静的（PLAN §3 G5 已经写明
# 「界面别把积压摆成一张待办清单」——`witness()` 因此只回一条 + 一个计数）。
WITNESS_DAYS = 90
WITNESS_MIN = 1  # 最短 1 天：0 或负数会让「刚写完就催你回看」，那不是见证是唠叨
WITNESS_MAX = 3650  # 十年封顶：再长就等于永不，那不如把这一列删掉
# (下界, 上界, 标签)。按信心分档是校准分的要点：不只是「准不准」，而是「你说的把握准不准」。
CONFIDENCE_BUCKETS = ((0, 50, "50 以下"), (50, 70, "50-69"), (70, 90, "70-89"), (90, 101, "90 以上"))


# ---------- 纯函数（不碰数据库） ----------


def _field(row, name, default=""):
    """行可能是 ORM 对象也可能是 dict——两种都吃。Pure."""
    if isinstance(row, dict):
        return row.get(name, default)
    return getattr(row, name, default)


def _when(row) -> datetime:
    """行的 `created_at` 摊成 aware UTC。Pure。

    SQLite 那列出来是 naive（写进去的一律是 `utcnow()` 的 UTC），但纯函数也可能被喂
    JSON 来的 ISO 串（前端、导出），所以两种都认。
    """
    v = _field(row, "created_at", None)
    dt = v if isinstance(v, datetime) else datetime.fromisoformat(str(v))
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def _view(row) -> dict:
    return {
        "id": row.id,
        "text": row.text,
        "basis": row.basis,
        "topic": row.topic,
        "confidence": row.confidence,
        "created_at": iso_utc(row.created_at),
        "reviewed_at": iso_utc(row.reviewed_at),
        "outcome": row.outcome,
        "note": row.note,
        "witness_days": int(_field(row, "witness_days", WITNESS_DAYS) or WITNESS_DAYS),
    }


def _conf(row) -> int:
    try:
        return max(0, min(100, int(_field(row, "confidence", 0) or 0)))
    except (TypeError, ValueError):
        return 0


def _bucket(confidence: int) -> str:
    for lo, hi, label in CONFIDENCE_BUCKETS:
        if lo <= confidence < hi:
            return label
    return CONFIDENCE_BUCKETS[-1][2]


def rate(hits: int, misses: int) -> float | None:
    """命中率；样本不足返回 None（宁可不给，也不给一个会误导人的数）。Pure."""
    n = hits + misses
    return round(hits / n, 3) if n >= MIN_SAMPLE else None


def calibration(rows) -> dict:
    """已回看的判断 → 命中率 + 按领域 + 按信心分档。Pure.

    只把 hit / miss 计入命中率；**unclear（还看不出）单独计数、不进分母**——把「说不清」
    硬塞进去，会让你以为自己在某类事上不准，其实只是还没到能判断的时候。
    """
    reviewed = [r for r in rows if _field(r, "outcome") in ("hit", "miss")]
    hits = sum(1 for r in reviewed if _field(r, "outcome") == "hit")
    misses = len(reviewed) - hits
    unclear = sum(1 for r in rows if _field(r, "outcome") == "unclear")

    by_topic: dict[str, list[int]] = {}
    for r in reviewed:
        topic = str(_field(r, "topic") or "").strip()
        if topic:
            b = by_topic.setdefault(topic, [0, 0])
            b[0 if _field(r, "outcome") == "hit" else 1] += 1

    buckets: dict[str, list[int]] = {label: [0, 0] for _, _, label in CONFIDENCE_BUCKETS}
    for r in reviewed:
        b = buckets[_bucket(_conf(r))]
        b[0 if _field(r, "outcome") == "hit" else 1] += 1

    return {
        "total": len(rows),
        "reviewed": len(reviewed),
        "unclear": unclear,
        "pending": len(rows) - len(reviewed) - unclear,
        "overall": {"hits": hits, "misses": misses, "rate": rate(hits, misses), "min_sample": MIN_SAMPLE},
        # 只列样本够的领域——「架构选型 6/10」这种话，两条样本是说不出口的
        "by_topic": sorted(
            (
                {"topic": t, "hits": v[0], "misses": v[1], "rate": rate(v[0], v[1])}
                for t, v in by_topic.items()
                if rate(v[0], v[1]) is not None
            ),
            key=lambda d: -(d["hits"] + d["misses"]),
        ),
        "by_confidence": [
            {
                "bucket": label,
                "hits": buckets[label][0],
                "misses": buckets[label][1],
                "sample": sum(buckets[label]),
                "rate": rate(*buckets[label]),
            }
            for _, _, label in CONFIDENCE_BUCKETS
        ],
    }


# ---------- 到期：什么时候值得回头看一眼（纯函数，见模块开篇那段「让开一步」）----------


def clamp_witness_days(value, default: int = WITNESS_DAYS) -> int:
    """列值 / 入参 → 可用的天数。**这一处定规矩**（纯函数，写行与读行共用它）。

    空、0、读不出来的一律按默认 90 天——老行的列是 NULL、`add()` 的入参默认也是 90，
    两条路径必须给出同一个答案，各写一遍迟早分叉。明确给了正数就夹在 [1, 3650]。
    """
    try:
        days = int(value or 0)
    except (TypeError, ValueError):
        return default
    if days <= 0:
        return default
    return max(WITNESS_MIN, min(WITNESS_MAX, days))


def witness_due_at(row, default: int = WITNESS_DAYS) -> datetime:
    """这条判断哪天到点 = `created_at + witness_days`。Pure.

    列读不出来（老行/坏值）就按默认 90 天——这一列的默认值是**规矩的一部分**，
    不该因为一行数据坏了就变成「永不到点」（那正是这张表会退化成死数据的方式）。
    """
    return _when(row) + timedelta(days=clamp_witness_days(_field(row, "witness_days", None), default))


def due(rows, now: datetime | None = None) -> list[dict]:
    """**还没回看、且已经到点**的判断，到点最早的在前。Pure。

    三条一起定在这里，因为它们必须同时成立：

    1. 只认 `outcome == ""` —— 回看过的不是「到点了」，是「已经看过了」；
    2. 到点时间升序 —— 欠得最久的排最前。老行首次上线会集体到点，先念最老的
       那条：它最可能已经见分晓，也最可能已经忘干净（而这两个恰好是回看的前提）；
    3. `age_days` 是**从写下那天算起**，不是从到点算起——台词说的是「三个月前你判断」，
       说的是那条判断的年纪。时间读不出来的行直接跳过：宁可少念一条，也不编一个年纪。
    """
    now_utc = now or utcnow()
    now_utc = now_utc if now_utc.tzinfo else now_utc.replace(tzinfo=timezone.utc)
    out: list[dict] = []
    for r in rows:
        if str(_field(r, "outcome", "") or ""):
            continue
        try:
            at, created = witness_due_at(r), _when(r)
        except (TypeError, ValueError):
            continue
        if at <= now_utc:
            out.append(
                {
                    **_view(r),
                    "due_at": iso_utc(at),
                    "age_days": max(0, int((now_utc - created).total_seconds() // 86400)),
                }
            )
    out.sort(key=lambda d: str(d.get("due_at") or ""))
    return out


# ---------- 存取 ----------


async def list_decisions(limit: int = 200) -> dict:
    """全部条目（新的在前）+ 校准分。校准喂的是**全部**行，不受 limit 影响。"""
    async with SessionLocal() as db:
        rows = (
            (await db.execute(select(DecisionLog).order_by(DecisionLog.id.desc()).limit(limit)))
            .scalars()
            .all()
        )
        all_rows = (await db.execute(select(DecisionLog))).scalars().all()
    return {"entries": [_view(r) for r in rows], "calibration": calibration(all_rows)}


async def witness(now: datetime | None = None) -> dict:
    """到点的见证：**一条** + 还有几条在等着（nudge 的第 5 个来源，M4 · PLAN §3 G5）。

    **只回一条**（`due()[0]`，欠得最久的那条）而不是一整张列表：这是「到点提醒」，
    不是待办清单。老行上线时会集体到点，一次全摆出来就等于把 90 天前的一堆判断
    变成一张「你还欠」的账单——那是这个仓库封存过的机制。前端那条管线本来就
    一天只念一条（`localStorage` 按日期记账），这里再收一次口，两处都不会漏。

    读不出来（表都没有）就回空：一句提醒不值得让宠物面板红。
    """
    try:
        async with SessionLocal() as db:
            rows = (
                (await db.execute(select(DecisionLog).where(DecisionLog.outcome == "")))
                .scalars()
                .all()
            )
    except Exception:  # noqa: BLE001 - 派生视图，坏了当没有
        log.warning("decision witness query failed", exc_info=True)
        return {"due": None, "count": 0}
    ds = due(rows, now)
    return {"due": ds[0] if ds else None, "count": len(ds)}


async def add(
    text: str,
    basis: str = "",
    topic: str = "",
    confidence: int = 70,
    witness_days: int = WITNESS_DAYS,
) -> dict:
    text = (text or "").strip()
    if not text:
        raise ValueError("判断不能为空")
    try:
        conf = max(0, min(100, int(confidence)))
    except (TypeError, ValueError):
        conf = 70
    days = clamp_witness_days(witness_days)
    row = DecisionLog(
        text=text[:2000],
        basis=(basis or "").strip()[:2000],
        topic=(topic or "").strip()[:30],
        confidence=conf,
        witness_days=days,
    )
    async with SessionLocal() as db:
        db.add(row)
        await db.commit()
        await db.refresh(row)
        return _view(row)


async def review(decision_id: int, outcome: str, note: str = "") -> dict:
    """记下应验结果。`outcome=""` 可以撤销回看（回到「还没回看」）。"""
    outcome = (outcome or "").strip()
    if outcome not in OUTCOMES:
        raise ValueError(f"unknown outcome '{outcome}'")
    async with SessionLocal() as db:
        row = await db.get(DecisionLog, decision_id)
        if row is None:
            raise LookupError("没有这条判断")
        row.outcome = outcome
        row.note = (note or "").strip()[:2000]
        row.reviewed_at = utcnow() if outcome else None
        await db.commit()
        await db.refresh(row)
        return _view(row)


async def remove(decision_id: int) -> None:
    async with SessionLocal() as db:
        row = await db.get(DecisionLog, decision_id)
        if row is None:
            raise LookupError("没有这条判断")
        await db.delete(row)
        await db.commit()
