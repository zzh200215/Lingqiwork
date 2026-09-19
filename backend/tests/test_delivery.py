"""交付的事后见证（M5）的离线测试：真值在文件系统——mtime 是交出去的时刻，frontmatter 是给谁写的。

这一层的全部价值在**不编**：没到点的不提、回看过的不提、时间读不出来的跳过、一份都没交过
就空着。所以测试钉的是这几条，而不是「台词好不好听」（那是前端与 nudge 管线的事）。
"""
import asyncio
import sys
import time
from pathlib import Path

import pytest

sys.path.insert(0, ".")

from app.core import deliver as deliver_engine  # noqa: E402
from app.core import delivery  # noqa: E402
from app.core import report as report_mod  # noqa: E402
from app.db import SessionLocal, engine  # noqa: E402
from app.models import ArtifactFeedback, Base  # noqa: E402

DAY = 86400.0


async def _init_db() -> None:
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)


asyncio.run(_init_db())


@pytest.fixture(autouse=True)
def _clean():
    """每个用例一份干净的交付目录与反馈表——否则上一个用例的交付会被当成新的。"""
    from sqlalchemy import delete

    from app.config import VAULT_DIR

    d = VAULT_DIR / "deliver"
    if d.exists():
        for p in d.glob("*.md"):
            p.unlink()
    d.mkdir(parents=True, exist_ok=True)

    async def _wipe() -> None:
        async with SessionLocal() as db:
            await db.execute(delete(ArtifactFeedback))
            await db.commit()

    asyncio.run(_wipe())
    yield


def _deliver_file(name: str, *, age_days: float, front: str = "", title: str = "周报") -> str:
    """造一份「交出去过」的交付：文件名带日期、mtime 是 `age_days` 天前。"""
    from app.config import VAULT_DIR

    p = VAULT_DIR / "deliver" / name
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(f"{front}# {title}\n\n正文\n", encoding="utf-8")
    stamp = time.time() - age_days * DAY
    import os

    os.utime(p, (stamp, stamp))
    return p.relative_to(VAULT_DIR).as_posix()


async def _feedback(ref: str, *, age_days: float, verdict: str = "good") -> None:
    from datetime import datetime, timedelta, timezone

    async with SessionLocal() as db:
        row = ArtifactFeedback(kind="deliver", verdict=verdict, ref=ref)
        row.created_at = datetime.now(timezone.utc) - timedelta(days=age_days)
        db.add(row)
        await db.commit()


# ---------- 纯函数 ----------


def test_due_in_days_uses_the_window_and_ignores_junk():
    assert delivery.due_in_days(1000.0) == 1000.0 + 14 * DAY
    assert delivery.due_in_days(1000.0, 3) == 1000.0 + 3 * DAY
    assert delivery.due_in_days(1000.0, 0) == 1000.0 + 14 * DAY  # 坏值/0 → 回默认窗口
    assert delivery.due_in_days(1000.0, -5) == 1000.0 + 14 * DAY


def test_is_reviewed_needs_a_later_look_not_the_same_day_thumbs_up():
    """当天点的赞说的是「这份写得不错」，不是「这事后来怎么样了」——所以要有 24 小时的时差。"""
    mtime = 1000.0
    assert delivery.is_reviewed(mtime, []) is False
    assert delivery.is_reviewed(mtime, [mtime + 3600]) is False  # 一小时后点的：还是当时的心情
    assert delivery.is_reviewed(mtime, [mtime + 2 * DAY]) is True
    assert delivery.is_reviewed(mtime, [mtime + 2 * DAY, mtime]) is True  # 有一条算就算


def test_parse_front_reads_the_ids_we_write():
    assert delivery.parse_front("---\ngenre: 周报\naudience: 领导\n---\n\n# 标题\n") == {
        "genre": "周报",
        "audience": "领导",
    }
    assert delivery.parse_front("# 没有 frontmatter\n") == {}
    assert delivery.parse_front("") == {}
    assert delivery.parse_front("---\n乱写的一行\n---\n") == {}


def test_pick_returns_one_and_a_count_oldest_first():
    now = 100.0 * DAY
    items = [
        {"path": "deliver/b.md", "at": now - 20 * DAY},
        {"path": "deliver/a.md", "at": now - 30 * DAY},
        {"path": "deliver/c.md", "at": now - 1 * DAY},  # 还没到点
        {"path": "deliver/d.md", "at": now - 40 * DAY, "reviewed": True},  # 回看过了
        {"path": "deliver/e.md", "at": None},  # 时间读不出来
        {"path": "deliver/f.md"},  # 连这个字段都没有
    ]
    got = delivery.pick(items, now)
    assert got["count"] == 2 and got["due"]["path"] == "deliver/a.md"  # 到点最早的排前面
    assert delivery.pick([], now) == {"due": None, "count": 0}
    assert delivery.pick(items[:1], 10 * DAY) == {"due": None, "count": 0}  # 都没到点


# ---------- 真行 ----------


async def test_a_delivery_that_nobody_looked_at_comes_back():
    ref = _deliver_file("2026-09-01-周报.md", age_days=20, front="---\ngenre: 周报\naudience: 领导\n---\n")

    got = await delivery.witness()

    assert got["due"]["path"] == ref
    assert got["due"]["title"] == "周报"
    assert got["due"]["genre"] == "周报" and got["due"]["audience"] == "领导"
    assert got["due"]["reviewed"] is False
    assert got["count"] == 1 and got["window_days"] == delivery.WITNESS_DAYS


async def test_a_fresh_delivery_is_not_mentioned_yet():
    _deliver_file("2026-09-17-刚交的.md", age_days=1)

    got = await delivery.witness()

    assert got == {"window_days": delivery.WITNESS_DAYS, "total": 1, "due": None, "count": 0}


async def test_a_delivery_you_came_back_to_is_done():
    """**回看过了就不提**——这条不成立的话，nudge 会永远念同一份东西。"""
    ref = _deliver_file("2026-09-01-周报.md", age_days=20)
    await _feedback(ref, age_days=2)  # 交出去 18 天之后表了态

    got = await delivery.witness()

    assert got["due"] is None and got["total"] == 1


async def test_a_same_day_thumbs_up_does_not_count_as_a_look_back():
    """当天点的赞不算回看（`is_reviewed` 的时差），所以到点了照样提一句。"""
    ref = _deliver_file("2026-09-01-周报.md", age_days=20)
    await _feedback(ref, age_days=20)  # 交付当天点的

    got = await delivery.witness()

    assert got["due"]["path"] == ref


async def test_nothing_delivered_yet_is_an_empty_answer():
    got = await delivery.witness()
    assert got == {"window_days": delivery.WITNESS_DAYS, "total": 0, "due": None, "count": 0}


async def test_the_written_file_carries_genre_and_audience():
    """M5：存进 vault 之后**真的**还看得出这份是给谁写的（以前那句话是不成立的）。"""
    from app.config import VAULT_DIR

    rep = report_mod.Report(
        title="第 37 周周报", sections=[report_mod.Section(heading="结论", body="先说结论")], used=[]
    )

    def _no_index(path, **kw):  # 落盘即可，索引不是这一层的活
        return 0

    import app.core.indexer as indexer

    real = indexer.index_file
    indexer.index_file = _no_index
    try:
        out = await deliver_engine.save(rep, [], genre="weekly", audience="leader")
    finally:
        indexer.index_file = real

    text = (VAULT_DIR / out["filename"]).read_text(encoding="utf-8")
    assert text.startswith("---\ngenre: 周报\naudience: 领导\n---\n")
    assert "# 第 37 周周报" in text
    # 而且它立刻就能被这一层读出来（写进去的东西读得回来，才算真的写进去了）
    front = delivery.parse_front(text)
    assert front == {"genre": "周报", "audience": "领导"}


async def test_a_save_without_a_genre_writes_no_frontmatter():
    """别的引擎（与没给体裁的调用）文件格式一个字节没变。"""
    from app.config import VAULT_DIR

    rep = report_mod.Report(title="随手一篇", sections=[], used=[])
    out = await deliver_engine.save(rep, [])
    text = (VAULT_DIR / out["filename"]).read_text(encoding="utf-8")
    assert text.startswith("# 随手一篇")
