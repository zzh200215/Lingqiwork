"""Daily habits: definitions, per-day logs, weekday-aware streaks.

Structurally the same problem as a review card at day granularity — "due today,
mark it, keep the streak" — which is why both render on the 今日 page and share
the proactive reminder. Deliberately NOT sharing code with `core/cards.py`
beyond that: see `streak()` and `_review_days()`.

Everything heavy is imported inside functions, same reason as `core/cards.py`:
this module is reached at startup through `routers/habits.py`, and a module-level
failure here would take down all of FastAPI, not just habits.
"""
import logging
import re
from datetime import date, timedelta

log = logging.getLogger(__name__)

MAX_HABITS = 20  # 40 行格子是苦役，不是习惯追踪
KINDS = ("check", "count")
AUTO_SOURCES = ("", "cards")
HEATMAP_DAYS = 30
MAX_TARGET = 10_000.0
OVERSHOOT = 3.0  # count 型单日最多记到 target 的这个倍数
DAY_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
WEEKDAYS_RE = re.compile(r"^[01]{7}$")  # 周一→周日
ALL_DAYS = "1111111"

# 一键播种：第一条就是自动打勾的那条，所以格子第一天不是空的
SEEDS = [
    {"name": "今日复习", "icon": "⟳", "kind": "check", "auto_source": "cards"},
    {"name": "写代码", "icon": "💻", "kind": "count", "target": 30.0, "unit": "分钟"},
    {"name": "读技术文档", "icon": "📖", "kind": "check"},
]


def today_str() -> str:
    return date.today().isoformat()


def is_scheduled(weekdays: str, d: date) -> bool:
    """Is this habit meant to be done on that date? weekdays[0] is Monday."""
    if not WEEKDAYS_RE.match(weekdays or ""):
        return True  # 数据坏了就当天天要做，不要静默漏掉一个习惯
    return weekdays[d.weekday()] == "1"


def _scheduled_back(weekdays: str, start: date):
    """Scheduled days, newest first, starting at `start`. Bounded."""
    d = start
    for _ in range(400):
        if is_scheduled(weekdays, d):
            yield d
        d -= timedelta(days=1)


def streak(done: set[str], weekdays: str = ALL_DAYS, today: date | None = None) -> int:
    """Consecutive scheduled days completed, counting back from today.

    Two rules the whole feature rests on:

    - **Yesterday still counts.** A streak only breaks once a full scheduled day
      has passed with nothing done, otherwise the number reads 0 every morning
      before you have done anything. Same rule as `cards._streak`.
    - **Unscheduled days are skipped, not breaks.** A "weekends only" habit judged
      day by day would sit at 0 forever, and a broken streak counter is worse than
      no streak counter at all.

    `today` is a parameter — rather than an internal `date.today()` call, which is
    what `cards._streak` does — so these tests do not depend on the system clock.
    """
    if not done:
        return 0
    days = _scheduled_back(weekdays, today or date.today())
    first = next(days, None)
    if first is None:  # weekdays == "0000000": scheduled on no day at all
        return 0
    if first.isoformat() not in done:
        nxt = next(days, None)  # today not done yet — the streak may still be alive
        if nxt is None or nxt.isoformat() not in done:
            return 0
    n = 1
    for d in days:
        if d.isoformat() not in done:
            break
        n += 1
    return n


def is_done(kind: str, value: float, target: float) -> bool:
    return value >= (target if kind == "count" else 1.0)


def clamp_value(kind: str, value: float, target: float) -> float:
    if kind != "count":
        return 1.0
    return max(0.0, min(value, max(target, 1.0) * OVERSHOOT))


# ---------- DB ----------


def validate(name: str, kind: str, target: float, weekdays: str, auto_source: str) -> None:
    """Raise ValueError on anything the rest of this module would then mis-handle."""
    if not (name or "").strip():
        raise ValueError("名称不能为空")
    if len(name.strip()) > 100:
        raise ValueError("名称最多 100 字")
    if kind not in KINDS:
        raise ValueError(f"kind 只能是 {'/'.join(KINDS)}")
    if kind == "count" and not (0 < target <= MAX_TARGET):
        raise ValueError(f"目标要在 0 到 {int(MAX_TARGET)} 之间")
    if not WEEKDAYS_RE.match(weekdays or ""):
        raise ValueError("weekdays 必须是 7 位 0/1（周一→周日）")
    if "1" not in weekdays:
        raise ValueError("至少要选一天")
    if auto_source not in AUTO_SOURCES:
        raise ValueError("auto_source 只能是空或 cards")


async def _review_days(db, days: int) -> set[str]:
    """Local calendar days with at least one card review — for auto habits.

    This SQL duplicates `cards._today_counts` on purpose: the alternative is
    reaching into card internals from here. `date(col,'localtime')` on the SQL
    side is also deliberate — a Python-side local date string compared against a
    UTC column is an off-by-timezone bug (`pet.py:162` still has that shape).
    """
    from sqlalchemy import text as sql

    rows = (
        await db.execute(
            sql(
                "SELECT DISTINCT date(reviewed_at, 'localtime') FROM card_reviews "
                f"WHERE reviewed_at >= datetime('now', '-{max(1, int(days))} days')"
            )
        )
    ).all()
    return {r[0] for r in rows if r[0]}


async def today_view(today: date | None = None) -> dict:
    """Everything the 今日 page needs in one request: values, streaks, heatmaps."""
    from sqlalchemy import select

    from app.db import SessionLocal
    from app.models import Habit, HabitLog

    d = today or date.today()
    day = d.isoformat()
    horizon = (d - timedelta(days=HEATMAP_DAYS - 1)).isoformat()
    async with SessionLocal() as db:
        habits = (
            (
                await db.execute(
                    select(Habit).where(Habit.archived.is_(False)).order_by(Habit.sort, Habit.id)
                )
            )
            .scalars()
            .all()
        )
        logs = (
            (await db.execute(select(HabitLog).where(HabitLog.day >= horizon))).scalars().all()
        )
        auto = (
            await _review_days(db, HEATMAP_DAYS)
            if any(h.auto_source == "cards" for h in habits)
            else set()
        )

    manual: dict[int, dict[str, float]] = {}
    for lg in logs:
        manual.setdefault(lg.habit_id, {})[lg.day] = lg.value

    items, pending = [], []
    for h in habits:
        recent = {k: 1.0 for k in auto if k >= horizon} if h.auto_source else manual.get(h.id, {})
        value = recent.get(day, 0.0)
        done = is_done(h.kind, value, h.target)
        scheduled = is_scheduled(h.weekdays, d)
        history = sorted(k for k, v in recent.items() if is_done(h.kind, v, h.target))
        if scheduled and not done:
            pending.append(h.name)
        items.append(
            {
                "id": h.id,
                "name": h.name,
                "icon": h.icon,
                "kind": h.kind,
                "target": h.target,
                "unit": h.unit,
                "weekdays": h.weekdays,
                "auto": h.auto_source or "",
                "sort": h.sort,
                "value": value,
                "done": done,
                "scheduled": scheduled,
                "streak": streak(set(history), h.weekdays, d),
                "history": history,
            }
        )
    live = [i for i in items if i["scheduled"]]
    return {
        "day": day,
        "habits": items,
        "done": sum(1 for i in live if i["done"]),
        "total": len(live),
        "pending": pending,
        "heatmap_days": HEATMAP_DAYS,
    }


async def tick(habit_id: int, day: str = "", value: float | None = None, note: str = "") -> dict:
    """Mark a day. `check` sets 1; `count` adds `value` (default +1), clamped.

    Idempotent by construction: one row per (habit, day) enforced by the unique
    index, so a double tap on a check habit cannot create a second row.
    Raises LookupError (no such habit) / ValueError (bad day, or an auto habit).
    """
    from sqlalchemy import select

    from app.db import SessionLocal
    from app.models import Habit, HabitLog

    day = (day or today_str()).strip()
    if not DAY_RE.match(day):
        raise ValueError("day 必须是 YYYY-MM-DD")
    async with SessionLocal() as db:
        h = (await db.execute(select(Habit).where(Habit.id == habit_id))).scalar_one_or_none()
        if h is None:
            raise LookupError(habit_id)
        if h.auto_source:
            raise ValueError("这个习惯由系统自动判定，不用手动打勾")
        kind, target = h.kind, h.target
        row = (
            await db.execute(
                select(HabitLog).where(HabitLog.habit_id == habit_id, HabitLog.day == day)
            )
        ).scalar_one_or_none()
        step = 1.0 if value is None else float(value)
        nxt = clamp_value(kind, (row.value if row else 0.0) + step, target) if kind == "count" else 1.0
        if row is None:
            db.add(HabitLog(habit_id=habit_id, day=day, value=nxt, note=note[:200]))
        else:
            row.value = nxt
            if note:
                row.note = note[:200]
        await db.commit()
    return {"ok": True, "habit_id": habit_id, "day": day, "value": nxt,
            "done": is_done(kind, nxt, target)}


async def untick(habit_id: int, day: str = "") -> dict:
    """Clear one day's record. A mis-tap must be undoable or you won't dare tap."""
    from sqlalchemy import delete

    from app.db import SessionLocal
    from app.models import HabitLog

    day = (day or today_str()).strip()
    if not DAY_RE.match(day):
        raise ValueError("day 必须是 YYYY-MM-DD")
    async with SessionLocal() as db:
        r = await db.execute(
            delete(HabitLog).where(HabitLog.habit_id == habit_id, HabitLog.day == day)
        )
        await db.commit()
    return {"ok": True, "deleted": int(r.rowcount or 0), "day": day}


async def seed() -> dict:
    """Write the suggested habits — but only into an empty table, so it's idempotent.

    Exists because an empty grid is what killed every other opt-in feature here:
    `skills/`, `data/repos/` and `data/podcasts/` are all still empty. One click
    has to be enough to make the page worth looking at.
    """
    from sqlalchemy import func, select

    from app.db import SessionLocal
    from app.models import Habit

    async with SessionLocal() as db:
        if ((await db.execute(select(func.count(Habit.id)))).scalar() or 0) > 0:
            return {"added": 0, "message": "已经有习惯了，不重复播种"}
        for i, s in enumerate(SEEDS):
            db.add(
                Habit(
                    name=s["name"],
                    icon=s.get("icon", ""),
                    kind=s.get("kind", "check"),
                    target=float(s.get("target", 1.0)),
                    unit=s.get("unit", ""),
                    auto_source=s.get("auto_source", ""),
                    sort=i,
                )
            )
        await db.commit()
    return {"added": len(SEEDS)}


async def pending_today() -> tuple[int, list[str]]:
    """(count, first few names) of habits due today and not done. Never raises."""
    try:
        v = await today_view()
        return len(v["pending"]), v["pending"][:3]
    except Exception:  # noqa: BLE001 - the reminder must not die on our account
        log.exception("habits pending_today failed")
        return 0, []
