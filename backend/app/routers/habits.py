"""Daily habits: definitions, ticking, the 今日 rollup.

Thin HTTP layer — the rules live in `app/core/habits.py`. Two shapes copied from
`routers/cards.py` on purpose:

- Literal paths (`/today`, `/seed`) are declared BEFORE `/{habit_id}`. FastAPI
  matches in declaration order, and `/{habit_id}` annotated `int` would
  structurally match `/today` and then fail with a 422 rather than falling
  through.
- DELETE removes the child rows explicitly. This project never turns on
  `PRAGMA foreign_keys`, so a declared cascade would be documentation only.
"""
import logging

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.core import habits as core

router = APIRouter(prefix="/api/habits", tags=["habits"])
log = logging.getLogger(__name__)


class HabitIn(BaseModel):
    name: str
    icon: str = ""
    kind: str = "check"
    target: float = 1.0
    unit: str = ""
    weekdays: str = core.ALL_DAYS
    auto_source: str = ""
    sort: int = 0


class HabitPatch(BaseModel):
    name: str | None = None
    icon: str | None = None
    kind: str | None = None
    target: float | None = None
    unit: str | None = None
    weekdays: str | None = None
    sort: int | None = None
    archived: bool | None = None


class TickIn(BaseModel):
    day: str = ""
    value: float | None = None
    note: str = ""


def _out(h) -> dict:
    return {
        "id": h.id,
        "name": h.name,
        "icon": h.icon,
        "kind": h.kind,
        "target": h.target,
        "unit": h.unit,
        "weekdays": h.weekdays,
        "auto": h.auto_source or "",
        "sort": h.sort,
        "archived": h.archived,
    }


# ---------- literal paths (must precede /{habit_id}) ----------


@router.get("/today")
async def today():
    return await core.today_view()


@router.post("/seed")
async def seed():
    return await core.seed()


@router.get("")
async def list_habits(include_archived: bool = False):
    from sqlalchemy import select

    from app.db import SessionLocal
    from app.models import Habit

    q = select(Habit).order_by(Habit.sort, Habit.id)
    if not include_archived:
        q = q.where(Habit.archived.is_(False))
    async with SessionLocal() as db:
        rows = (await db.execute(q)).scalars().all()
    return {"habits": [_out(h) for h in rows]}


@router.post("")
async def create_habit(body: HabitIn):
    from sqlalchemy import func, select

    from app.db import SessionLocal
    from app.models import Habit

    try:
        core.validate(body.name, body.kind, body.target, body.weekdays, body.auto_source)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    async with SessionLocal() as db:
        n = (
            await db.execute(select(func.count(Habit.id)).where(Habit.archived.is_(False)))
        ).scalar() or 0
        if n >= core.MAX_HABITS:
            raise HTTPException(400, f"最多 {core.MAX_HABITS} 个习惯（再多就是苦役了）")
        row = Habit(
            name=body.name.strip(),
            icon=body.icon[:8],
            kind=body.kind,
            target=1.0 if body.kind == "check" else body.target,
            unit=body.unit[:20],
            weekdays=body.weekdays,
            auto_source=body.auto_source,
            sort=body.sort,
        )
        db.add(row)
        await db.commit()
        await db.refresh(row)
    return _out(row)


# ---------- per-habit paths ----------


@router.put("/{habit_id}")
async def update_habit(habit_id: int, body: HabitPatch):
    from sqlalchemy import select

    from app.db import SessionLocal
    from app.models import Habit

    patch = {k: v for k, v in body.model_dump().items() if v is not None}
    if not patch:
        raise HTTPException(400, "没有要修改的字段")
    async with SessionLocal() as db:
        h = (await db.execute(select(Habit).where(Habit.id == habit_id))).scalar_one_or_none()
        if h is None:
            raise HTTPException(404, "习惯不存在")
        merged = {
            "name": patch.get("name", h.name),
            "kind": patch.get("kind", h.kind),
            "target": patch.get("target", h.target),
            "weekdays": patch.get("weekdays", h.weekdays),
            "auto_source": h.auto_source,  # 自动来源不给改，避免把自动习惯变成手动的
        }
        try:
            core.validate(**merged)
        except ValueError as e:
            raise HTTPException(400, str(e)) from e
        for k, v in patch.items():
            setattr(h, k, v.strip() if k == "name" and isinstance(v, str) else v)
        if h.kind == "check":
            h.target = 1.0
        await db.commit()
        await db.refresh(h)
    return _out(h)


@router.post("/{habit_id}/tick")
async def tick(habit_id: int, body: TickIn | None = None):
    """Mark today. The body is optional on purpose — a keypress should not have
    to carry a JSON envelope just to say "done"."""
    b = body or TickIn()
    try:
        return await core.tick(habit_id, b.day, b.value, b.note)
    except LookupError as e:
        raise HTTPException(404, "习惯不存在") from e
    except ValueError as e:
        raise HTTPException(400, str(e)) from e


@router.delete("/{habit_id}/tick")
async def untick(habit_id: int, day: str = ""):
    try:
        return await core.untick(habit_id, day)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e


@router.delete("/{habit_id}")
async def delete_habit(habit_id: int):
    from sqlalchemy import delete, select

    from app.db import SessionLocal
    from app.models import Habit, HabitLog

    async with SessionLocal() as db:
        h = (await db.execute(select(Habit).where(Habit.id == habit_id))).scalar_one_or_none()
        if h is None:
            raise HTTPException(404, "习惯不存在")
        await db.execute(delete(HabitLog).where(HabitLog.habit_id == habit_id))
        await db.delete(h)
        await db.commit()
    return {"ok": True}
