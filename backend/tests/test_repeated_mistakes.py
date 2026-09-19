"""「同一个概念又卡住」的判据与那句话（学习 → 宠物这条环）。

这一条的**全部价值在判据准不准**——宠物开口说错话比不说话贵得多，所以这里钉三件事：

1. 判据本身（纯函数）：只有「接住过、又没走通」才算数，五种不该算的都不算；
2. 派生查询对着**真 tutor_sessions 行**跑（不是给 `_by_concept` 喂假字典）：这条判据
   依赖 `recalled` 与「最近一次自评」的聚合语义，喂假数据测的是我自己的假设；
3. 冷却：同一个概念一天只念一遍 —— 而且必须读**已说过的话**（`pet_events`），
   不能另记一张表（那就是第二份真值）。
"""
import asyncio
from datetime import datetime, timedelta, timezone

import pytest

from app.core import pet as pet_core
from app.core import tutor as tut
from app.db import SessionLocal, engine as _engine
from app.models import Base as _Base
from app.models import TutorSession, iso_utc


async def _init_db() -> None:
    async with _engine.begin() as conn:
        await conn.run_sync(_Base.metadata.create_all)


asyncio.run(_init_db())


@pytest.fixture(autouse=True)
def _clean():
    from sqlalchemy import delete

    async def _go() -> None:
        async with SessionLocal() as db:
            await db.execute(delete(TutorSession))
            await db.commit()

    asyncio.run(_go())
    _drop_pet_events()
    yield


def _drop_pet_events() -> None:
    import sqlite3

    from app.config import settings

    try:
        conn = sqlite3.connect(settings.db_path)
        try:
            conn.execute("DELETE FROM pet_events WHERE kind = 'repeated'")
            conn.commit()
        finally:
            conn.close()
    except sqlite3.Error:
        pass


def _cutoff(days: int = 7) -> str:
    return iso_utc(datetime.now(timezone.utc) - timedelta(days=days)) or ""


def _concept(**over) -> dict:
    """`_by_concept` 会产出的一行（字段与它一一对应）。"""
    base = {
        "concept": "注意力机制",
        "verdict": "half",
        "stuck": "说不清 Q/K/V 各自在干什么",
        "stuck_resolved": False,
        "last_at": iso_utc(datetime.now(timezone.utc)),
        "last_session_id": 1,
        "sessions": 2,
        "recalled": 1,
    }
    return {**base, **over}


# ---------- 判据（纯函数） ----------


def test_a_recurring_mistake_is_one_the_system_already_flagged():
    """接住过、又没走通 —— 这才算数。"""
    assert tut.is_recurring_mistake(_concept(), cutoff=_cutoff())


def test_a_single_session_is_not_a_pattern():
    """只碰过一次不是「反复」：`recalled` 为 0 = 系统从没接住过他卡在哪儿。

    这一条把「碰过两次」这种噪音挡在外面 —— 判据要的不是次数，是**带着旧卡点回来**。
    """
    assert not tut.is_recurring_mistake(_concept(recalled=0), cutoff=_cutoff())


def test_mastering_it_ends_the_matter():
    """连着两次说通 = 已掌握 → 那不是旧毛病，是新起点。"""
    assert not tut.is_recurring_mistake(
        _concept(verdict="got", sessions=2, recalled=1), cutoff=_cutoff()
    )
    # 只说通过一次还不算掌握（一场是运气），但也不再算「又卡住」——最近一次是 got
    assert not tut.is_recurring_mistake(
        _concept(verdict="got", sessions=1, recalled=1), cutoff=_cutoff()
    )


def test_useless_never_counts():
    """自评「没用」不算数 —— 与 `concepts()` 同规矩：教学没成，证明不了水平。"""
    assert not tut.is_recurring_mistake(_concept(verdict="useless"), cutoff=_cutoff())
    assert not tut.is_recurring_mistake(_concept(verdict=""), cutoff=_cutoff())


def test_old_history_is_not_today_s_business():
    """七天前的事属于记录，不是此刻该说的一句。"""
    stale = iso_utc(datetime.now(timezone.utc) - timedelta(days=8))
    assert not tut.is_recurring_mistake(_concept(last_at=stale), cutoff=_cutoff())


# ---------- 派生查询（对着真行跑） ----------


async def _session(concept: str, verdict: str, *, days_ago: int = 0, recalled: bool = False,
                   stuck: str = "") -> int:
    async with SessionLocal() as db:
        row = TutorSession(
            topic=concept or "随便聊聊",
            concept=concept,
            verdict=verdict,
            stuck=stuck,
            recalled=recalled,
            created_at=datetime.now(timezone.utc) - timedelta(days=days_ago),
        )
        db.add(row)
        await db.commit()
        await db.refresh(row)
        return row.id


async def test_recurring_mistakes_reads_real_rows():
    """一场「接住过、半懂」+ 一场「半懂」= 又卡住了；另一个概念只碰过一次，不算。"""
    await _session("注意力机制", "half", days_ago=2, recalled=True, stuck="Q/K/V 分不清")
    await _session("注意力机制", "half", days_ago=0, stuck="还是 Q/K/V 分不清")
    await _session("位置编码", "half", days_ago=1)

    out = await tut.recurring_mistakes()
    assert [c["concept"] for c in out] == ["注意力机制"]
    assert out[0]["recalled"] == 1  # 召回确实命中过
    assert out[0]["stuck"] == "还是 Q/K/V 分不清"  # 最近一次的卡点
    assert out[0]["sessions"] == 2


async def test_a_mastered_concept_drops_out():
    """两次说通之后它就不在这个清单里了 —— 这条清单只回答「哪几个还在原地」。"""
    await _session("注意力机制", "half", days_ago=3, recalled=True)
    await _session("注意力机制", "got", days_ago=1, recalled=True)
    await _session("注意力机制", "got", days_ago=0)

    assert await tut.recurring_mistakes() == []


async def test_a_dead_query_returns_empty_not_an_exception():
    """派生视图的纪律：坏了返回空表，绝不挡教学。"""
    from unittest.mock import patch

    with patch.object(tut, "_concept_rows", side_effect=RuntimeError("boom")):
        assert await tut.recurring_mistakes() == []


async def test_the_route_hands_the_page_the_same_list():
    """界面上那个「又卡住」的标读的就是这条路由——**同一批判据**。

    前端不重算「算不算又卡住」（那会是第二份实现，两处迟早各指一批）；这条同时钉住
    注册那一层：直接调 `recurring_mistakes()` 验不出「路由挂上了没有」。
    """
    from app.main import app
    from app.routers import tutor as tutor_router

    assert "/api/tutor/recurring" in app.openapi()["paths"]

    await _session("注意力机制", "half", days_ago=2, recalled=True, stuck="Q/K/V 分不清")
    await _session("注意力机制", "half", days_ago=0, recalled=True)
    await _session("位置编码", "half", days_ago=1)  # 只碰过一次，不算

    out = await tutor_router.list_recurring()
    assert [c["concept"] for c in out["recurring"]] == ["注意力机制"]
    assert out["recurring"][0]["recalled"] == 2
    assert out["recurring"][0]["sessions"] == 2


# ---------- 那句话与冷却 ----------


async def test_it_says_the_line_once_and_names_where_you_stalled():
    await _session("注意力机制", "half", days_ago=2, recalled=True)
    await _session("注意力机制", "half", days_ago=1, recalled=True)

    await tut.note_recurring_mistake("注意力机制", "Q/K/V 分不清")
    lines = [e for e in pet_core.feed(limit=20) if e["kind"] == "repeated"]
    assert len(lines) == 1
    # `name` 是概念（冷却按它查），`detail` 是那次卡在哪
    assert lines[0]["name"] == "注意力机制"
    assert lines[0]["detail"] == "Q/K/V 分不清"
    assert "注意力机制" in lines[0]["text"] and "Q/K/V" in lines[0]["text"]
    assert "第 2 次" in lines[0]["text"]  # 次数是真数出来的，不是写死的


async def test_the_same_concept_is_not_named_twice_in_one_day():
    """「又错了」念第二遍就成了骚扰 —— 冷却读的是**已说过的话**，不另记一张表。"""
    await _session("注意力机制", "half", days_ago=2, recalled=True)
    await _session("注意力机制", "half", days_ago=1, recalled=True)

    await tut.note_recurring_mistake("注意力机制", "Q/K/V 分不清")
    midnight = datetime.now().astimezone().replace(hour=0, minute=0, second=0, microsecond=0)
    assert await tut._said_today("注意力机制", midnight) is True
    # 别的概念不受它的冷却影响
    assert await tut._said_today("位置编码", midnight) is False
    await tut.note_recurring_mistake("注意力机制", "Q/K/V 分不清")

    assert len([e for e in pet_core.feed(limit=20) if e["kind"] == "repeated"]) == 1


async def test_a_blank_concept_says_nothing():
    await tut.note_recurring_mistake("", "whatever")
    assert [e for e in pet_core.feed(limit=20) if e["kind"] == "repeated"] == []
