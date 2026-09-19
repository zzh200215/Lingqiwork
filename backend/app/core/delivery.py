"""交付的事后见证（M5）：交出去的东西，过一阵子回头看一眼。

## 缺的是什么

一份交付落进 `vault/deliver/`、进索引、零柒说一句「交出去了」，然后就断了——没有任何地方
记得它，也没有任何东西会在几周后提一句「那份东西后来有回音吗」。`decision_log` 那边
（PLAN.md §3 G5）为同一个毛病让开过一次，理由写在 `models.py` 里：**纯拉取式的下场在几个月
这个尺度上是可预见的——那条日志会变成死数据**。

## 真值在文件系统（零新表零新列）

`routers/work.py` 早就立了这条：「产出没有登记表，真值是文件系统」。所以这里也不新记账：

  · **交出去的时刻** = 那份 md 的 **mtime**。`deliver/` 里的文件就是交出去的东西本身，
    落盘那一刻就是交出去那一刻（预览里点「存进 vault」= 你把它交出去了）。
  · **给谁写的 / 什么体裁** = 文件头的 frontmatter（M5 起 `deliver.save` 会写进去）。
  · **回看过了** = 有一条针对这份文件的 👍/👎，而且它落在交付 **24 小时之后**。
    为什么要有这个时差：当天点下去的那个赞说的是「这份写得不错」，不是「这事后来怎么样了」。
    **这条定义偏弱**（真正的回看动作只有那个 👍/👎 按钮），代价写在 PLAN3 §13。

## 只回一条 + 一个计数

照 `decision_log.witness()` 的形状：界面别把积压摆成一张待办清单，一天念一条就够。
"""
import logging
import time
from datetime import datetime, timezone
from pathlib import Path

log = logging.getLogger(__name__)

# 交出去多久之后值得回头看一眼（天）。14 天：一周报/一汇报的回音通常两周内就该有了；
# 再短会把「刚发出去」的东西也摆上来，再长人先忘了当初交的是什么。
WITNESS_DAYS = 14
# 点赞与交付之间至少要隔这么久才算「回看」（当天点的赞说的是「写得好」）。
MIN_REVIEW_LAG_HOURS = 24
_HOUR = 3600.0


def due_in_days(mtime: float, days: int = WITNESS_DAYS) -> float:
    """交付时刻 → 该回看时刻（epoch 秒）。Pure. 负数/0 一律按默认窗口算。"""
    span = int(days if (days or 0) > 0 else WITNESS_DAYS)
    return float(mtime) + span * 86400.0


def is_reviewed(mtime: float, feedback_at: list[float], lag_hours: int = MIN_REVIEW_LAG_HOURS) -> bool:
    """这份交付「回看过了」没有。Pure.

    判据只有一条：**存在一条隔了 `lag_hours` 以上的反馈**。同一个文件被 👍 过两次但都在当天，
    仍然算「还没回看」——那不是回看，那是当时的心情。
    """
    return any(at >= float(mtime) + lag_hours * _HOUR for at in feedback_at or [])


def parse_front(text: str) -> dict[str, str]:
    """文件头的 `--- key: value ---` → 字典（没有就空）。Pure.

    与 `skills._parse_skill_text` 同一个迷你形状：只认 `key: value` 行，不引 YAML 依赖。
    存疑的行直接跳过——读不出来就当没写，那比猜一个值诚实。
    """
    lines = (text or "").splitlines()
    if not lines or lines[0].strip() != "---":
        return {}
    out: dict[str, str] = {}
    for line in lines[1:]:
        if line.strip() == "---":
            break
        if ":" in line:
            k, _, v = line.partition(":")
            out[k.strip().lower()] = v.strip().strip("\"'")
    return out


def pick(items: list[dict], now: float) -> dict:
    """到点、且还没回看过的那些 → `{"due": 最老的一条 | None, "count": 还有几条}`。Pure.

    **一条 + 一个计数**（同 `decision_log.witness`）：到点最早的排前面，界面只念第一条。
    时间读不出来的条目跳过——宁可不提，也不提一条时间错的东西。
    """
    due = [
        it
        for it in items or []
        if isinstance(it.get("at"), (int, float))
        and not it.get("reviewed")
        and due_in_days(float(it["at"])) <= now
    ]
    due.sort(key=lambda it: (float(it["at"]), str(it.get("path") or "")))
    if not due:
        return {"due": None, "count": 0}
    return {"due": due[0], "count": len(due)}


def _title_of(path: Path) -> str:
    """第一个一级标题；没有就退回文件名（去掉日期前缀）。

    这是**第三处**「读 vault 文件的第一行 H1」（另两处：`threads._vault_title`、
    `routers/work.py::_title_of`）。三处读的是同一份盘上真值、同一个判据，所以先各读各的；
    真要合，就合到 `core/` 里一个 `vault_title()` 上（记在 PLAN3 §13）。
    """
    try:
        with path.open(encoding="utf-8", errors="ignore") as fh:
            for _ in range(40):
                line = fh.readline()
                if not line:
                    break
                s = line.strip()
                if s.startswith("# "):
                    return s[2:].strip() or path.stem
    except OSError:
        pass
    stem = path.stem
    return stem[11:] if len(stem) > 10 and stem[4] == "-" and stem[7] == "-" else stem


def _front_of(path: Path) -> dict[str, str]:
    try:
        with path.open(encoding="utf-8", errors="ignore") as fh:
            return parse_front(fh.read(400))
    except OSError:
        return {}


async def scan(now: float | None = None) -> list[dict]:
    """`vault/deliver/` 里的每一份交付 → 一条事实（含「回看过了没有」）。I/O 只在这里。

    读不到就说读不到：目录不在（一份都没交过）返回空表，不抛、也不编。
    """
    from sqlalchemy import select

    from app.config import VAULT_DIR
    from app.core.deliver import DELIVER_DIR
    from app.db import SessionLocal
    from app.models import ArtifactFeedback

    if not DELIVER_DIR.is_dir():
        return []

    try:
        async with SessionLocal() as db:
            rows = list(
                (
                    await db.execute(
                        select(ArtifactFeedback).where(ArtifactFeedback.kind == "deliver")
                    )
                )
                .scalars()
                .all()
            )
    except Exception:  # noqa: BLE001 - 观察面读不到就当作「还没回看过」，不抛
        log.warning("delivery witness feedback query failed", exc_info=True)
        rows = []

    seen: dict[str, list[float]] = {}
    for r in rows:
        ref = (r.ref or "").strip()
        if not ref or r.created_at is None:
            continue
        at = r.created_at
        seen.setdefault(ref, []).append(
            (at if at.tzinfo else at.replace(tzinfo=timezone.utc)).timestamp()
        )

    out: list[dict] = []
    for p in sorted(DELIVER_DIR.glob("*.md")):
        if not p.is_file():
            continue
        try:
            mtime = p.stat().st_mtime
        except OSError:
            continue
        rel = p.relative_to(VAULT_DIR).as_posix()
        front = _front_of(p)
        out.append(
            {
                "path": rel,
                "title": _title_of(p),
                "genre": front.get("genre", ""),
                "audience": front.get("audience", ""),
                "at": mtime,
                "at_iso": datetime.fromtimestamp(mtime).isoformat(timespec="seconds"),
                "due_in_days": WITNESS_DAYS,
                "reviewed": is_reviewed(mtime, seen.get(rel, [])),
            }
        )
    return out


async def witness(now: float | None = None) -> dict:
    """到点的一份交付 + 还有几份在等着（nudge 的第 6 个来源）。I/O，永不抛。"""
    stamp = time.time() if now is None else now
    items = await scan(stamp)
    picked = pick(items, stamp)
    return {"window_days": WITNESS_DAYS, "total": len(items), **picked}
