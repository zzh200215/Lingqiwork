"""零柒的能力插件（B2，openpets 范式）。

openpets 把「能力」外置成插件：**权限 / 配额 / 存储 / 计划 / 事件 / 命令 / 面板**
由运行时统一提供，宠物本体不动就能长出能力。这里照搬这套七件套，内置两个先跑通：

- **喝水提醒** —— 到点提醒，面板显示今天几杯，命令 `drink` 记一杯；
- **专注计时** —— 命令 `start` / `stop`，到点了零柒主动说一声。

三条不破的规矩沿用宠物本体：**主动**（到点自己开口，不等你问）· **诚实**（数字来自
插件自己的存储，不编）· **克制**（配额封顶，且走 `pet.emit` 的隐私闸门——插件的台词
一样不许带路径与密钥）。

计划用现成的调度器注册**每个插件自己的作业**（`pet_plugin_<name>`）：喝水是每天几个
整点的 cron，专注是一次性的 `date` 作业（开始时定时、结束时取消）。这样一个插件一个
作业，既没有分钟级空转，也保住了「计划」是插件自己声明的这一层语义。

纯逻辑（`roll_day` / `water_due` / `focus_due`）与 DB 分开，测试不碰库也能覆盖规则。
"""
import json
import logging
from datetime import datetime, timedelta

log = logging.getLogger(__name__)

PERMISSIONS = ("notify", "store", "schedule", "command", "panel")

WATER_TARGET = 8
MOOD_SCALE = 5  # 心情 1–5（😞 到 😄）
MOOD_KEEP = 90  # 只留最近 90 天，storage_json 不至于天长地久地涨

# 内置插件的**声明**（唯一真值）。装好的一行 = 这份声明 + 它自己的存储。
BUILTINS: dict[str, dict] = {
    "water": {
        "label": "喝水提醒",
        "permissions": ["notify", "store", "schedule", "command", "panel"],
        "quota": {"events_per_day": 4},
        "schedule": {"hours": [10, 15, 20]},
        "panel": {"kind": "counter", "unit": "杯", "target": WATER_TARGET},
        "commands": ["drink"],
    },
    "focus": {
        "label": "专注计时",
        "permissions": ["notify", "store", "schedule", "command", "panel"],
        "quota": {"events_per_day": 30},
        "schedule": {"kind": "once"},
        "panel": {"kind": "timer", "default_minutes": 25},
        "commands": ["start", "stop"],
    },
    "mood": {
        "label": "心情打卡",
        "permissions": ["notify", "store", "schedule", "command", "panel"],
        "quota": {"events_per_day": 2},
        "schedule": {"hours": [21]},  # 晚上问一句——白天别打扰
        "panel": {"kind": "mood", "scale": MOOD_SCALE},
        "commands": ["set", "clear"],
    },
}

JOB_PREFIX = "pet_plugin_"


# ---------- pure logic (no DB) ----------


def roll_day(state: dict, today: str) -> dict:
    """跨天就把插件的日计数归零。返回新 dict（不原地改）。"""
    if (state or {}).get("day") == today:
        return dict(state or {})
    return {"day": today, "cups": 0, "reminded": []}


def water_due(state: dict, now: datetime, hours: list[int], target: int) -> bool:
    """这个整点该不该提醒你喝水：还没喝够、这个钟点在计划里、这个钟点没提醒过。"""
    if (state or {}).get("cups", 0) >= target:
        return False
    if now.hour not in (hours or []):
        return False
    return now.hour not in (state or {}).get("reminded", [])


def focus_remaining(state: dict, now: datetime) -> int | None:
    """专注还剩几秒；没在计时返回 None；已经到点返回 <= 0。"""
    started = _parse_iso((state or {}).get("started_at", ""))
    if started is None:
        return None
    minutes = int((state or {}).get("minutes") or 25)
    return int((started + timedelta(minutes=minutes) - now).total_seconds())


def focus_due(state: dict, now: datetime) -> bool:
    """专注到点了没有：在计时、且已过（或正好到）结束时刻。"""
    rem = focus_remaining(state, now)
    return rem is not None and rem <= 0


# ---------- 心情打卡：每天一格 1–5，留着当可回看的记录 ----------
#
# 存储形状 `{"days": {"2026-09-13": 4, ...}}`。**不做「连续几天没打卡」这类判定**——
# 心情是自己的记录，不是要维持的指标（与「无目标习惯」同一条立场）。


def mood_today(state: dict, today: str) -> int:
    """今天记了几分；没记返回 0（0 = 还没记，不是「心情 0」）。"""
    return int(((state or {}).get("days") or {}).get(today, 0) or 0)


def mood_set(state: dict, today: str, value: int) -> dict:
    """记下今天的心情（1–5）。返回新 state；只留最近 MOOD_KEEP 天。"""
    if not (1 <= int(value) <= MOOD_SCALE):
        raise ValueError(f"心情要在 1–{MOOD_SCALE} 之间")
    days = dict((state or {}).get("days") or {})
    days[today] = int(value)
    if len(days) > MOOD_KEEP:  # 按日期丢掉最旧的
        for d in sorted(days)[:-MOOD_KEEP]:
            days.pop(d, None)
    return {"days": days}


def mood_clear(state: dict, today: str) -> dict:
    days = dict((state or {}).get("days") or {})
    days.pop(today, None)
    return {"days": days}


def mood_recent(state: dict, n: int = 14) -> list[dict]:
    """最近 n 天记过的心情，旧→新（画一条小曲线用）。"""
    days = (state or {}).get("days") or {}
    picked = sorted(days)[-max(1, int(n)) :]
    return [{"day": d, "value": int(days[d])} for d in picked]


def _parse_iso(s: str) -> datetime | None:
    try:
        return datetime.fromisoformat(s)
    except (TypeError, ValueError):
        return None


def focus_fire_at(state: dict, now: datetime | None = None) -> datetime | None:
    """专注结束的**时刻**（用于注册一次性作业）；没在计时就 None。

    已经过去也照常返回（过去时刻）——重启补跑时 APScheduler 会立刻触发，等于补说
    一句「时间到了」，比永远不说好。
    """
    rem = focus_remaining(state, now or datetime.now())
    if rem is None:
        return None
    return (now or datetime.now()) + timedelta(seconds=rem)


# ---------- DB ----------


def _loads(s: str, fallback):
    try:
        v = json.loads(s or "")
        return v if isinstance(v, type(fallback)) else fallback
    except (TypeError, ValueError):
        return fallback


async def ensure() -> None:
    """把内置插件装进库（幂等）。空列表等于「这功能没装」——那是会被当成坏掉的样子。"""
    from sqlalchemy import select

    from app.db import SessionLocal
    from app.models import PetPlugin

    async with SessionLocal() as db:
        have = set((await db.execute(select(PetPlugin.name))).scalars().all())
        for name, spec in BUILTINS.items():
            if name in have:
                continue
            db.add(
                PetPlugin(
                    name=name,
                    label=spec["label"],
                    enabled=True,
                    spec_json=json.dumps(spec, ensure_ascii=False),
                    storage_json="{}",
                    quota_json="{}",
                )
            )
        await db.commit()


def _panel(name: str, spec: dict, state: dict, today: str) -> dict:
    """面板数据：插件当前状态 → 前端要显示的那几个数。"""
    panel = dict(spec.get("panel") or {})
    if name == "water":
        st = roll_day(state, today)
        panel["value"] = int(st.get("cups", 0))
        panel["target"] = WATER_TARGET
    elif name == "focus":
        rem = focus_remaining(state, datetime.now())
        panel["running"] = rem is not None
        panel["remaining"] = max(0, rem or 0)
        panel["minutes"] = int(state.get("minutes") or panel.get("default_minutes") or 25)
    elif name == "mood":
        panel["scale"] = MOOD_SCALE
        panel["value"] = mood_today(state, today)
        panel["days"] = len((state or {}).get("days") or {})
        panel["recent"] = mood_recent(state, 14)
    return panel


async def list_plugins() -> list[dict]:
    """装好的插件 + 各自的面板数据。首次调用会把内置两个装进去。"""
    from sqlalchemy import select

    from app.db import SessionLocal
    from app.models import PetPlugin

    await ensure()
    today = datetime.now().strftime("%Y-%m-%d")
    async with SessionLocal() as db:
        rows = (await db.execute(select(PetPlugin).order_by(PetPlugin.id))).scalars().all()
    out = []
    for r in rows:
        spec = _loads(r.spec_json, {})
        state = _loads(r.storage_json, {})
        used = int((_loads(r.quota_json, {}) or {}).get(today, 0))
        out.append(
            {
                "name": r.name,
                "label": r.label or spec.get("label", r.name),
                "enabled": bool(r.enabled),
                "permissions": spec.get("permissions", []),
                "commands": spec.get("commands", []),
                "panel": _panel(r.name, spec, state, today),
                "quota": {"used": used, "cap": int((spec.get("quota") or {}).get("events_per_day", 0))},
            }
        )
    return out


async def set_enabled(name: str, enabled: bool) -> dict:
    from sqlalchemy import select

    from app.db import SessionLocal
    from app.models import PetPlugin

    async with SessionLocal() as db:
        row = (
            await db.execute(select(PetPlugin).where(PetPlugin.name == name))
        ).scalar_one_or_none()
        if row is None:
            raise LookupError(name)
        row.enabled = bool(enabled)
        await db.commit()
    reschedule()
    return {"ok": True, "name": name, "enabled": bool(enabled)}


async def command(name: str, cmd: str, args: dict | None = None) -> dict:
    """跑一个插件命令。`drink` / `start` / `stop`。返回新面板状态。"""
    args = args or {}
    from sqlalchemy import select

    from app.db import SessionLocal
    from app.models import PetPlugin

    today = datetime.now().strftime("%Y-%m-%d")
    async with SessionLocal() as db:
        row = (
            await db.execute(select(PetPlugin).where(PetPlugin.name == name))
        ).scalar_one_or_none()
        if row is None:
            raise LookupError(name)
        spec = _loads(row.spec_json, {})
        if cmd not in (spec.get("commands") or []):
            raise ValueError(f"{name} 不认识命令 {cmd}")
        state = _loads(row.storage_json, {})

        if name == "water" and cmd == "drink":
            st = roll_day(state, today)
            st["cups"] = min(WATER_TARGET, int(st.get("cups", 0)) + 1)
            row.storage_json = json.dumps(st, ensure_ascii=False)
            said = None
            if st["cups"] == WATER_TARGET:
                said = await _say_inline(db, row, f"今天第 {WATER_TARGET} 杯，够了。", today)
        elif name == "focus" and cmd == "start":
            minutes = int(args.get("minutes") or (spec.get("panel") or {}).get("default_minutes") or 25)
            minutes = max(1, min(minutes, 240))
            now = datetime.now()
            row.storage_json = json.dumps(
                {"started_at": now.isoformat(timespec="seconds"), "minutes": minutes},
                ensure_ascii=False,
            )
            said = None
        elif name == "focus" and cmd == "stop":
            row.storage_json = "{}"
            said = None
        elif name == "mood" and cmd == "set":
            row.storage_json = json.dumps(mood_set(state, today, args.get("value")), ensure_ascii=False)
            said = None
        elif name == "mood" and cmd == "clear":
            row.storage_json = json.dumps(mood_clear(state, today), ensure_ascii=False)
            said = None
        else:
            raise ValueError(f"未实现的命令 {name}/{cmd}")

        await db.commit()
        state = _loads(row.storage_json, {})
        panel = _panel(name, spec, state, today)

    if name == "focus":  # 只有专注的开始/停止会改变那一次性作业
        reschedule()
    return {"ok": True, "name": name, "command": cmd, "panel": panel, "said": said}


async def _say_inline(db, row, text: str, today: str) -> str | None:
    """命令里顺口说的一句（例如「够了」）。受配额约束，走 emit 的隐私闸门。"""
    from app.core import pet

    spec = _loads(row.spec_json, {})
    cap = int((spec.get("quota") or {}).get("events_per_day", 0))
    quota = _loads(row.quota_json, {})
    if cap and int(quota.get(today, 0)) >= cap:
        return None
    pet.emit("plugin", text=text)
    quota[today] = int(quota.get(today, 0)) + 1
    row.quota_json = json.dumps(quota, ensure_ascii=False)
    return text


# ---------- scheduled jobs ----------


async def _emit_for(name: str, text: str) -> bool:
    """插件到点开口：查配额 → emit（走隐私闸门）→ 记配额。返回说没说成。"""
    from sqlalchemy import select

    from app.core import pet
    from app.db import SessionLocal
    from app.models import PetPlugin

    today = datetime.now().strftime("%Y-%m-%d")
    async with SessionLocal() as db:
        row = (
            await db.execute(select(PetPlugin).where(PetPlugin.name == name))
        ).scalar_one_or_none()
        if row is None or not row.enabled:
            return False
        spec = _loads(row.spec_json, {})
        cap = int((spec.get("quota") or {}).get("events_per_day", 0))
        quota = _loads(row.quota_json, {})
        if cap and int(quota.get(today, 0)) >= cap:
            return False
        pet.emit("plugin", text=text)
        quota[today] = int(quota.get(today, 0)) + 1
        row.quota_json = json.dumps(quota, ensure_ascii=False)
        await db.commit()
    return True


async def _water_job() -> None:
    """每天计划里的整点：没喝够就提醒一句，并记下这个钟点已提醒。"""
    from sqlalchemy import select

    from app.db import SessionLocal
    from app.models import PetPlugin

    now = datetime.now()
    today = now.strftime("%Y-%m-%d")
    async with SessionLocal() as db:
        row = (
            await db.execute(select(PetPlugin).where(PetPlugin.name == "water"))
        ).scalar_one_or_none()
        if row is None or not row.enabled:
            return
        spec = _loads(row.spec_json, {})
        hours = (spec.get("schedule") or {}).get("hours") or []
        st = roll_day(_loads(row.storage_json, {}), today)
        if not water_due(st, now, hours, WATER_TARGET):
            return
        st["reminded"] = sorted({*st.get("reminded", []), now.hour})
        row.storage_json = json.dumps(st, ensure_ascii=False)
        await db.commit()
    await _emit_for("water", f"喝口水吧（今天第 {st.get('cups', 0)} 杯）。")


async def _focus_job() -> None:
    """专注到点：说一声，然后清空计时（这样重启也不会重复说）。"""
    from sqlalchemy import select

    from app.db import SessionLocal
    from app.models import PetPlugin

    async with SessionLocal() as db:
        row = (
            await db.execute(select(PetPlugin).where(PetPlugin.name == "focus"))
        ).scalar_one_or_none()
        if row is None or not row.enabled:
            return
        state = _loads(row.storage_json, {})
        if not focus_due(state, datetime.now()):
            return
        minutes = int(state.get("minutes") or 25)
        row.storage_json = "{}"
        await db.commit()
    await _emit_for("focus", f"{minutes} 分钟到，抬头歇一下。")


async def _mood_job() -> None:
    """晚上问一句心情（今天还没记才问）。一天只在这个钟点跑一次，无需额外状态。"""
    from sqlalchemy import select

    from app.db import SessionLocal
    from app.models import PetPlugin

    today = datetime.now().strftime("%Y-%m-%d")
    async with SessionLocal() as db:
        row = (
            await db.execute(select(PetPlugin).where(PetPlugin.name == "mood"))
        ).scalar_one_or_none()
        if row is None or not row.enabled:
            return
        if mood_today(_loads(row.storage_json, {}), today):
            return
    await _emit_for("mood", "今天心情怎么样？记一笔就好。")


# 「计划」是 hours 型的插件 → 它的整点作业。加一个新的同类插件，这里补一行即可。
_HOURLY_JOBS = {"water": _water_job, "mood": _mood_job}


def _sync_rows() -> list[dict]:
    """给 sync 的 reschedule() 用的直读（与 pet.status 同一路子）。"""
    import sqlite3

    from app.config import settings

    try:
        conn = sqlite3.connect(settings.db_path)
        try:
            rows = conn.execute(
                "SELECT name, enabled, spec_json, storage_json FROM pet_plugins"
            ).fetchall()
        finally:
            conn.close()
    except Exception:  # noqa: BLE001 - 表还没建时不注册作业
        return []
    return [
        {"name": r[0], "enabled": bool(r[1]), "spec": _loads(r[2], {}), "state": _loads(r[3], {})}
        for r in rows
    ]


def reschedule() -> None:
    """按插件自己的「计划」重排作业。幂等，任何时候都能调。"""
    from app.core import scheduler as sched
    from app.core.prefs import load_config

    enabled = bool(load_config().get("pet_enabled", True))
    keep: set[str] = set()
    for r in _sync_rows():
        if not enabled or not r["enabled"]:
            continue
        job_id = JOB_PREFIX + r["name"]
        hours = (r["spec"].get("schedule") or {}).get("hours")
        handler = _HOURLY_JOBS.get(r["name"])
        if hours and handler:  # hours 型（喝水 / 心情）：每天整点的 cron
            expr = "0 " + ",".join(str(int(h)) for h in hours) + " * * *"
            try:
                sched.set_cron(job_id, handler, expr)
                keep.add(job_id)
            except ValueError:
                log.warning("bad schedule %r for %s", expr, r["name"])
        elif r["name"] == "focus":  # 一次性到点作业（没在计时就不注册）
            fire = focus_fire_at(r["state"])
            if fire is not None:
                sched.set_once(job_id, _focus_job, fire)
                keep.add(job_id)
    sched.prune_jobs(JOB_PREFIX, keep)
