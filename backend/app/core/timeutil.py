"""SQLite 时间戳比较口径的唯一出处。

这张库的时间列（`models.utcnow` 一族）落盘是**空格分隔的 naive UTC**——SQLite 没有
时区类型，`DateTime(timezone=True)` 存进来的就是这个形状（实测
`2026-09-17 06:03:40.336082`）。SQL 里对这些列的 `>=`/`<=` 是**文本字典序**比较，
所以窗口边界必须产出一模一样的口径：`T` 分隔会因 `' ' < 'T'` 让边界日的行整片被丢，
带本地偏移（`+08:00`）则再错一个时区。历史上 `cost.py` 就因为这个少算预算
（2026-09-28 复审 P2-1），修法是把口径收进这里：谁要和数据库时间列比较，谁就调它。
"""
from datetime import datetime, timezone


def naive_utc_now() -> datetime:
    """现在（naive UTC）。Pure（无 I/O）。

    直接用 `datetime.utcnow()` 已被弃用；`datetime.now()` 拿的是本地墙钟，与落盘的
    UTC 差着时区。这里一次到位：UTC 时刻去掉 tzinfo。
    """
    return datetime.now(timezone.utc).replace(tzinfo=None)


def iso_cutoff(dt: datetime) -> str:
    """naive datetime → 与落盘格式一致的 `YYYY-MM-DD HH:MM:SS`（秒级）。

    秒级截断让「恰好卡在边界秒」的行仍然命中（`…:40.336082 >= …:40` 为真），
    窗口是闭区间左端，与既有写法（`skill_metrics.py`）一致。
    """
    return dt.isoformat(sep=" ", timespec="seconds")
