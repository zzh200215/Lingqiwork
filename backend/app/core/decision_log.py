"""决策日志 + 校准分。

**它解决什么。** 判断做出来的时候，你心里其实有个把握程度；过几个月回头看，你只会记住
蒙对的那几次。把「判断 + 依据 + 信心」在**当时**钉下来，才谈得上校准——「你当时说七成
把握的那类事，实际应验了几成」。少了信心那一栏，判断日志就退化成一篇自我表扬。

**拉取式**：没有到期时间、没有队列、没有提醒。回看是你自己决定何时去做，
`outcome` 空着就是还没回看，没有任何东西会催它。校准分只在样本够了才给——一两条算不出
「命中率」，硬算出来的是噪音，会让人对这把尺子失去信任。

`calibration()` 是**纯函数**：喂一组行，算命中率、按领域的命中率、按信心的校准。测试
不需要数据库、不需要模型。
"""

import logging

from sqlalchemy import select

from app.db import SessionLocal
from app.models import DecisionLog, iso_utc, utcnow

log = logging.getLogger(__name__)

OUTCOMES = ("", "hit", "miss", "unclear")
MIN_SAMPLE = 3  # 一个分组至少要几条已回看才给命中率
# (下界, 上界, 标签)。按信心分档是校准分的要点：不只是「准不准」，而是「你说的把握准不准」。
CONFIDENCE_BUCKETS = ((0, 50, "50 以下"), (50, 70, "50-69"), (70, 90, "70-89"), (90, 101, "90 以上"))


# ---------- 纯函数（不碰数据库） ----------


def _field(row, name, default=""):
    """行可能是 ORM 对象也可能是 dict——两种都吃。Pure."""
    if isinstance(row, dict):
        return row.get(name, default)
    return getattr(row, name, default)


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


# ---------- 存取 ----------


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
    }


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


async def add(text: str, basis: str = "", topic: str = "", confidence: int = 70) -> dict:
    text = (text or "").strip()
    if not text:
        raise ValueError("判断不能为空")
    try:
        conf = max(0, min(100, int(confidence)))
    except (TypeError, ValueError):
        conf = 70
    row = DecisionLog(
        text=text[:2000],
        basis=(basis or "").strip()[:2000],
        topic=(topic or "").strip()[:30],
        confidence=conf,
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
