"""零柒的小屋（P4 · 维度四）：把「你攒下了什么」变成**它屋里的一件东西**。

这个模块只回答一个问题：**零柒现在屋里摆着什么、这些东西是什么时候到手的。**

三条规矩，与 `pet.growth()` 同源：

1. **算出来的，不是发的奖。** 屋里每一件东西都是某个真实累计量跨过某个门槛的结果。
   没有物品表、没有一次「发奖」写库、没有 hook 要挂到五个模块里去。产出文件一落盘，
   它就多一件东西——**宠物不需要被通知，它读同一份真值**（P2 的原话）。
2. **只增不减。** 门槛只往上走，到手的东西不因为「今天没做」而消失。
3. **不欠账。** 屋里没有「还差 N 件解锁」的清单，也没有「它饿了」。空的屋子只是空的，
   不是催你的账单。

## 时间有三种口径（这个仓库踩过三次，这里一次说清）

- `messages` / `task_runs` / `tutor_sessions` / `card_reviews` 这些 ORM 表存的是
  **naive UTC**（`models.utcnow()` 写的；SQLite 把时区丢了）；
- `pet_events.created_at` 是**本地 aware** 的 ISO 串（`pet.emit()` 写的）；
- `habit_logs.day` 是**本地日历日**字符串，vault 文件的 mtime 是**本地 epoch**。

全部先归一成 aware datetime，再输出两个字段给前端：`at`（本地墙钟串，给人看）
与 `at_ts`（epoch，给排序和「多久以前」用）。**前端就不必猜时区了**——这是这一层
存在的意义，也是它唯一复杂的部分。
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime, timezone, tzinfo

from app.config import VAULT_DIR
from app.core import pet

log = logging.getLogger(__name__)


@dataclass(frozen=True)
class Tier:
    """一个门槛：累计到 `n` 的时候，屋里多这么一件东西。"""

    n: int
    label: str
    icon: str
    kind: str  # "badge" = 第一次（它记住的那一下）；"prop" = 屋里的一件摆设


@dataclass(frozen=True)
class Ladder:
    """一条累计线 + 它上面挂着的门槛。

    `unit` 用来拼「第 N …」那句事实（`detail`），不参与判定。
    """

    key: str  # 与 `_instants()` 的键一一对应
    module: str  # work | learning | teach | habits | review | focus
    unit: str
    tiers: tuple[Tier, ...]


# 模块名只写一份：房间里的分组标签、投喂清单上的归属，都用它。
MODULES = {
    "work": "工作",
    "learning": "学习",
    "teach": "教它",
    "habits": "坚持",
    "review": "复习",
    "focus": "专注",
}

# 门槛表。**每条线的第一档都是 badge**（「第一次」那一下值得单独一枚），
# 往上是屋里越攒越多的摆设。
LADDERS: tuple[Ladder, ...] = (
    Ladder(
        "work",
        "work",
        "份成品",
        (
            Tier(1, "第一份成品", "📄", "badge"),
            Tier(5, "一摞成果", "📦", "prop"),
            Tier(25, "成果柜", "🗄", "prop"),
            Tier(100, "成品库", "🏛", "prop"),
        ),
    ),
    Ladder(
        "learning",
        "learning",
        "个搞懂的概念",
        (
            Tier(1, "第一个搞懂的概念", "📖", "badge"),
            Tier(5, "一排书", "📚", "prop"),
            Tier(25, "一整架书", "🗃", "prop"),
        ),
    ),
    Ladder(
        "teach",
        "teach",
        "个讲通的概念",
        (
            Tier(1, "第一次把它讲通", "🎓", "badge"),
            Tier(5, "一块小黑板", "🧑‍🏫", "prop"),
            Tier(20, "一间小教室", "🏫", "prop"),
        ),
    ),
    Ladder(
        "runs_ok",
        "work",
        "次跑成的工作流",
        (
            Tier(1, "第一次跑成", "⚙️", "badge"),
            Tier(10, "一张工具台", "🛠", "prop"),
            Tier(50, "一间车间", "🏭", "prop"),
        ),
    ),
    Ladder(
        "reviews",
        "review",
        "次复习",
        (
            Tier(1, "第一张卡", "🃏", "badge"),
            Tier(50, "一个卡片盒", "🗂", "prop"),
            Tier(500, "一个卡片柜", "🗄", "prop"),
        ),
    ),
    Ladder(
        "habit_days",
        "habits",
        "个打卡日",
        (
            Tier(1, "第一天打卡", "👣", "badge"),
            Tier(7, "一周的火", "🔥", "prop"),
            Tier(30, "长出一棵小植物", "🌿", "prop"),
            Tier(100, "一棵树", "🌳", "prop"),
        ),
    ),
    # 专注那一档只从**改过之后**才开始记：`pet_events.detail` 里带了插件名，
    # 而在此之前，插件事件是三条线混在一个 `kind="plugin"` 里的（见 `_emit_for`）。
    # 没有历史就是没有历史——不拿文本去猜哪条是专注。
    Ladder(
        "focus",
        "focus",
        "次专注",
        (
            Tier(1, "第一次专注", "💡", "badge"),
            Tier(10, "一盏台灯", "🕯", "prop"),
            Tier(50, "一把好椅子", "🪑", "prop"),
        ),
    ),
)

# 今天喂了它什么。**这不是一张要还的账单**：一件都没有时，界面说的是「它不饿」。
MEALS = {
    "work": ("🛠", "成品 {n} 份"),
    "runs_ok": ("⚙️", "工作流 {n} 条"),
    "learning": ("📖", "说通 {n} 个概念"),
    "teach": ("🎓", "讲给它 {n} 个"),
    "habit_days": ("🔥", "打了 {n} 项卡"),
    "reviews": ("⟳", "过了 {n} 张卡"),
    "focus": ("💡", "专注 {n} 次"),
}


# ---------- 三种时间口径的解析（纯函数，可单独测） ----------


def _parse_utc_text(text: str) -> datetime | None:
    """ORM 列里那个（naive）UTC 值 → aware。空值 / 坏值 → None。

    带偏移的 ISO（`tutor` 的 `iso_utc()` 产出）也走这里：解析出什么就用什么，
    不给它硬套 UTC——那会把一个已经正确的时刻再挪一次。
    """
    s = (text or "").strip()
    if not s:
        return None
    try:
        dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
    except ValueError:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def _parse_local_text(text: str, tz: tzinfo) -> datetime | None:
    """**本地 aware** 的 ISO 串（`pet_events.created_at`）→ aware。"""
    s = (text or "").strip()
    if not s:
        return None
    try:
        dt = datetime.fromisoformat(s)
    except ValueError:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=tz)


def _parse_local_day(text: str, tz: tzinfo) -> datetime | None:
    """**本地日历日** `YYYY-MM-DD` → 那天零点的 aware 时刻。"""
    s = (text or "").strip()[:10]
    if not s:
        return None
    try:
        d = datetime.strptime(s, "%Y-%m-%d")
    except ValueError:
        return None
    return d.replace(tzinfo=tz)


def _stamp(dt: datetime, tz: tzinfo) -> tuple[str, float]:
    """aware 时刻 → （本地墙钟串, epoch）。给前端两个字段，省得它猜时区。"""
    return dt.astimezone(tz).replace(tzinfo=None).isoformat(timespec="seconds"), dt.timestamp()


# ---------- 采集 ----------


def _texts(conn, sql: str) -> list[str]:
    """一列时间文本。表不在 / 列不存在（新库）→ 空表，绝不让房间读崩。"""
    try:
        return [str(r[0]) for r in conn.execute(sql).fetchall() if r[0] is not None]
    except Exception:  # noqa: BLE001
        return []


def _output_files():
    """vault 里那几类成品的 md。目录清单与成长值共用 `pet._OUTPUT_DIRS`。"""
    for d in pet._OUTPUT_DIRS:  # noqa: SLF001 - 同包内共用一份真值
        p = VAULT_DIR / d
        if not p.is_dir():
            continue
        for f in p.glob("*.md"):
            if f.is_file():
                yield f


def _instants(conn, mastered: list[dict] | None, tz: tzinfo) -> dict[str, list[datetime]]:
    """每条线的事件时刻（升序）。

    `mastered` 由调用方从 `tutor.mastery_events()` 取来——**「已掌握」的规则只有
    那一份**（一场是运气、两场才算），这里不重写第二遍。
    """
    src: dict[str, list[datetime]] = {lad.key: [] for lad in LADDERS}

    for f in _output_files():
        try:
            src["work"].append(datetime.fromtimestamp(f.stat().st_mtime, tz=timezone.utc))
        except OSError:
            continue

    for e in mastered or []:
        dt = _parse_utc_text(str(e.get("at") or ""))
        if dt:
            src["learning"].append(dt)

    # 「把零柒教会」的谓词来自 `pet.TAUGHT_GOT`——数次数与数时刻是同一条规则。
    src["teach"] = [
        d
        for d in (
            _parse_utc_text(t)
            for t in _texts(
                conn,
                "SELECT COALESCE(ended_at, created_at) FROM tutor_sessions "
                f"WHERE {pet.TAUGHT_GOT}",
            )
        )
        if d
    ]
    src["runs_ok"] = [
        d
        for d in (
            _parse_utc_text(t)
            for t in _texts(conn, "SELECT started_at FROM task_runs WHERE status = 'ok'")
        )
        if d
    ]
    src["reviews"] = [
        d
        for d in (
            _parse_utc_text(t)
            for t in _texts(conn, "SELECT reviewed_at FROM card_reviews")
        )
        if d
    ]
    src["habit_days"] = [
        d
        for d in (
            _parse_local_day(t, tz)
            for t in _texts(conn, "SELECT day FROM habit_logs")
        )
        if d
    ]
    src["focus"] = [
        d
        for d in (
            _parse_local_text(t, tz)
            for t in _texts(
                conn,
                "SELECT created_at FROM pet_events "
                "WHERE kind = 'plugin' AND detail = 'focus'",
            )
        )
        if d
    ]

    for times in src.values():
        times.sort()
    return src


def _meals(src: dict[str, list[datetime]], tz: tzinfo, now: datetime) -> list[dict]:
    """今天它吃了什么：**每条线今天的真实成果**，一条一件。

    与精力（能量）刻意不同：那是「此刻」的瞬时量，跨天归零；这里是**已经发生的事**，
    明天再看会变成屋里的一件东西，而不是一笔要还的账。
    """
    today = now.astimezone(tz).date()
    out: list[dict] = []
    for lad in LADDERS:
        n = sum(1 for dt in src.get(lad.key, []) if dt.astimezone(tz).date() == today)
        if n <= 0:
            continue
        icon, tpl = MEALS.get(lad.key, ("·", "{n}"))
        out.append(
            {
                "key": lad.key,
                "module": lad.module,
                "module_label": MODULES.get(lad.module, ""),
                "icon": icon,
                "label": tpl.format(n=n),
                "count": n,
            }
        )
    return out


def _things_from(src: dict[str, list[datetime]], tz: tzinfo) -> list[dict]:
    """门槛判定本身：**只看「第 n 个事件在不在」**，不看今天。纯函数，可单独测。"""
    out: list[dict] = []
    for lad in LADDERS:
        times = src.get(lad.key) or []
        for tier in lad.tiers:
            if len(times) < tier.n:
                continue
            at, ts = _stamp(times[tier.n - 1], tz)
            out.append(
                {
                    "id": f"{lad.key}:{tier.n}",
                    "kind": tier.kind,
                    "module": lad.module,
                    "module_label": MODULES.get(lad.module, ""),
                    "icon": tier.icon,
                    "label": tier.label,
                    "detail": f"第 {tier.n} {lad.unit}",
                    "at": at,
                    "at_ts": ts,
                    "count": tier.n,
                }
            )
    # 同一秒里落盘的两件东西要有确定顺序——用 id 兜底，不然顺序会随排序实现漂。
    return sorted(out, key=lambda t: (t["at_ts"], t["id"]), reverse=True)


def _now_and_tz(
    now: datetime | None, tz: tzinfo | None
) -> tuple[datetime, tzinfo]:
    now = now or datetime.now().astimezone()
    if now.tzinfo is None:
        now = now.astimezone()
    return now, tz or now.tzinfo


def carried(
    current: dict | None,
    shelf: list[dict] | None,
    *,
    tz: tzinfo | None = None,
) -> dict | None:
    """它最近**叼回来**的那件：门槛到手的那件与架上最新那份成品，谁新算谁。

    为什么不能只报门槛那件：门槛是稀疏的（第 1、5、25、100 份），而「交出一份成品 →
    零柒叼回来」**每一份都发生**。所以身上挂的是这条，不是 `things[0]`。
    纯函数：传入的那份 `shelf` 来自 `routers/work.list_outputs`（列产出只此一处）。
    """
    rows: list[dict] = []
    for r in shelf or []:
        if not isinstance(r, dict):
            continue
        try:
            float(r.get("mtime") or 0)
        except (TypeError, ValueError):
            continue
        if r.get("mtime"):
            rows.append(r)
    if not rows:
        return current

    row = max(rows, key=lambda r: float(r["mtime"]))
    when = datetime.fromtimestamp(float(row["mtime"]), tz=timezone.utc)
    at, ts = _stamp(when, tz or datetime.now().astimezone().tzinfo)
    if current is not None and float(current.get("at_ts") or 0) >= ts:
        return current
    kind = str(row.get("label") or "").strip()
    return {
        "id": f"file:{row.get('path') or ''}",
        "kind": "output",
        "module": "work",
        "module_label": MODULES["work"],
        "icon": "📄",
        "label": str(row.get("title") or kind or "一份成品"),
        "detail": f"{kind} · {row.get('date') or ''}".strip(" ·"),
        "at": at,
        "at_ts": ts,
        "count": 1,
    }


def _collect(mastered: list[dict] | None, tz: tzinfo) -> dict[str, list[datetime]]:
    import sqlite3

    from app.config import settings

    conn = sqlite3.connect(settings.db_path)
    try:
        return _instants(conn, mastered, tz)
    finally:
        conn.close()


def things(
    mastered: list[dict] | None = None,
    *,
    now: datetime | None = None,
    tz: tzinfo | None = None,
) -> list[dict]:
    """屋里已经到手的东西，新 → 旧。

    每一件的 `at` 是**跨过那个门槛的那一刻**（第 5 份成品落盘的时间），不是「现在」——
    所以它稳定：明天再多交两份，第 5 份那件东西的日期还是那天。
    """
    _, tz = _now_and_tz(now, tz)
    return _things_from(_collect(mastered, tz), tz)


def room(
    mastered: list[dict] | None = None,
    *,
    now: datetime | None = None,
    tz: tzinfo | None = None,
) -> dict:
    """小屋：它攒下的东西 + 今天喂了它什么。

    `shelf`（架上那几份真产出）与 `carried` 的升级由**路由**补进来：列产出是
    `routers/work.py` 的事，核心层不该反过来去引路由（那份实现连标题提取在内只有
    一处，不抄第二份）。这里给的是「没有任何产出时」的答案。
    """
    now, tz = _now_and_tz(now, tz)
    src = _collect(mastered, tz)
    got = _things_from(src, tz)
    return {
        "things": got,
        # 它身上挂着的那件：没有产出时，就是屋里最新到手的那件摆设/徽章。
        "carried": got[0] if got else None,
        "today": {
            "meals": _meals(src, tz, now),
            "date": now.astimezone(tz).date().isoformat(),
        },
        # 空的屋子只是空的：界面据此说「还什么都没攒下」，而不是「你欠它一件」。
        "empty": not got,
    }
