"""生成质量闭环：记录「这次我满意吗」，并按 (kind, prompt_sha, model_id) 聚合。

**为什么需要它。** research / compose / recap / decide / conflict 都通过 `core/report.py` 成文，但
**没有一处记录过用户满不满意**——只有聊天消息有 feedback、教学有自评。后果是：改了提示词、
换了 provider，只能靠"看起来对不对"判断；而四个引擎共用一条脊梁，一次提示词回归
同时打穿四个功能，**却没有任何网接着**。

聚合的 join key 是 (kind, prompt_sha, model_id)。`prompt_sha` 取自 `core/report.py`
（与 `core/prompts.py` 同一个算法），所以提示词一改，新旧版本的满意率自然分开统计，
不用人工记"这版是哪个"。

护栏（PLAN 第 2 节）：评价是**事后的一次点击**，不是待办——不计数、不催、不设目标，
没有「你还有 N 篇没评」这种东西。
"""

import logging
from datetime import datetime, timedelta, timezone

from sqlalchemy import select

from app.db import SessionLocal
from app.models import ArtifactFeedback

log = logging.getLogger(__name__)

KINDS = ("research", "compose", "recap", "decide", "conflict")
VERDICTS = ("good", "bad")
REASON_CAP = 200
RECENT_BAD = 10  # 最近几条差评连原因一起带出来——那才是能动手的部分


def _aware(dt: datetime | None) -> datetime | None:
    """SQLite 的 `DateTime(timezone=True)` 回读是 naive 的，比较前补上 UTC。

    这个坑在本仓库有前科（见 `models.iso_utc` 的注释），所以这里显式补，不靠
    SQLAlchemy 的隐式转换。
    """
    if dt is None:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


async def record(
    kind: str,
    verdict: str,
    *,
    prompt_sha: str = "",
    model_id: str = "",
    reason: str = "",
    ref: str = "",
) -> dict:
    """记一条评价。kind / verdict 非法抛 ValueError（路由层转 400）。

    **不做去重**：同一次生成改主意（先 👎 后 👍）是正常的——评价是流水，不是状态。
    """
    kind, verdict = (kind or "").strip(), (verdict or "").strip()
    if kind not in KINDS:
        raise ValueError(f"unknown kind '{kind}'")
    if verdict not in VERDICTS:
        raise ValueError(f"unknown verdict '{verdict}'")

    row = ArtifactFeedback(
        kind=kind,
        verdict=verdict,
        prompt_sha=(prompt_sha or "").strip()[:12],
        model_id=(model_id or "").strip()[:120],
        reason=(reason or "").strip()[:REASON_CAP],
        ref=(ref or "").strip()[:200],
    )
    async with SessionLocal() as db:
        db.add(row)
        await db.commit()
        await db.refresh(row)
    return {
        "id": row.id,
        "kind": row.kind,
        "verdict": row.verdict,
        "created_at": _aware(row.created_at).isoformat() if row.created_at else None,
    }


async def summary(days: int = 90) -> dict:
    """按 (kind, prompt_sha, model_id) 聚合满意率 + 最近几条差评的原因。不抛异常。"""
    cutoff = datetime.now(timezone.utc) - timedelta(days=max(1, days))
    try:
        async with SessionLocal() as db:
            rows = list((await db.execute(select(ArtifactFeedback))).scalars().all())
    except Exception:  # noqa: BLE001 - 看板是观察面，不能变成故障源
        log.warning("quality summary query failed", exc_info=True)
        return {"days": days, "total": 0, "good": 0, "bad": 0, "rate": 0.0, "groups": [], "recent_bad": []}

    kept = [r for r in rows if (_aware(r.created_at) or cutoff) >= cutoff]

    groups: dict[tuple, dict] = {}
    for r in kept:
        key = (r.kind, r.prompt_sha, r.model_id)
        g = groups.setdefault(
            key,
            {
                "kind": r.kind,
                "prompt_sha": r.prompt_sha,
                "model_id": r.model_id,
                "good": 0,
                "bad": 0,
            },
        )
        g["good" if r.verdict == "good" else "bad"] += 1

    out = []
    for g in groups.values():
        n = g["good"] + g["bad"]
        g["total"] = n
        g["rate"] = round(g["good"] / n, 3) if n else 0.0
        out.append(g)
    out.sort(key=lambda g: (-g["total"], g["kind"], g["prompt_sha"]))

    recent_bad = [
        {
            "kind": r.kind,
            "model_id": r.model_id,
            "prompt_sha": r.prompt_sha,
            "reason": r.reason,
            "created_at": _aware(r.created_at).isoformat() if r.created_at else None,
        }
        for r in sorted(kept, key=lambda r: (_aware(r.created_at) or cutoff), reverse=True)
        if r.verdict == "bad"
    ][:RECENT_BAD]

    total = sum(g["total"] for g in out)
    good = sum(g["good"] for g in out)
    return {
        "days": days,
        "total": total,
        "good": good,
        "bad": total - good,
        "rate": round(good / total, 3) if total else 0.0,
        "groups": out,
        "recent_bad": recent_bad,
    }
