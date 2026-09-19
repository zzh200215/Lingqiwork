"""双轨接通（PLAN2 · T1 双轨互验 + T3 leech 前置回指）的离线测试。

这一格钉的是**桥的两端各自的事实**，以及桥不许变成第四种东西：

1. **关联规则**：一字不差 / 一个包含另一个（`tutor.canonical_concept` 那一套）、别名展开，
   **有歧义就不匹配**（挑错的那个会把「已掌握」标到别的概念上）；
2. **对质**：两边的事实都要成立才算矛盾（已掌握 × 近 7 天重来 ≥2），少一个都不算——
   而它**只陈述不判决**：不改任何判定、不落库（`contradiction` 是当场算出来的）；
3. **前置候选只来自半懂 / 又卡住**：掌握了的不进候选、最多 3 个、找不到就是空；
4. **拉取式**：搁置那一刻零柒一个字都不说（不是第六个提醒来源）；
5. **红线**：`cross.py` 里一行 `pet.*` 都没有——事实由这里出，台词由 `pet.compose()` 那边说。
"""
import asyncio
import ast
import re
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

sys.path.insert(0, ".")

from app.core import cards as cards_core  # noqa: E402
from app.core import cross  # noqa: E402
from app.core import tutor  # noqa: E402
from app.db import SessionLocal, engine as _engine  # noqa: E402
from app.models import Base as _Base  # noqa: E402
from app.models import Card, CardReview, PetEvent, TutorSession, utcnow  # noqa: E402


async def _init_db() -> None:
    async with _engine.begin() as conn:
        await conn.run_sync(_Base.metadata.create_all)


asyncio.run(_init_db())


@pytest.fixture(autouse=True)
def _clean():
    from sqlalchemy import delete

    async def _go() -> None:
        async with SessionLocal() as db:
            for model in (CardReview, Card, TutorSession, PetEvent):
                await db.execute(delete(model))
            await db.commit()

    asyncio.run(_go())
    yield


async def _session(
    concept: str,
    verdict: str,
    *,
    aliases: str = "",
    recalled: bool = False,
    days_ago: float = 0.0,
) -> int:
    when = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(days=days_ago)
    async with SessionLocal() as db:
        row = TutorSession(
            topic=concept,
            concept=concept,
            verdict=verdict,
            aliases=aliases,
            recalled=recalled,
            created_at=when,
            ended_at=when,
        )
        db.add(row)
        await db.commit()
        await db.refresh(row)
        return row.id


async def _card(topic: str = "", **kw) -> int:
    async with SessionLocal() as db:
        row = Card(front=kw.pop("front", "题面"), back="答案", topic=topic, **kw)
        db.add(row)
        await db.commit()
        await db.refresh(row)
        return row.id


async def _lapse(card_id: int, grade: int = 1, *, days_ago: float = 0.0) -> None:
    """一行「重来」。直接写账本：这里要的是历史形状，不是 `submit_review` 的调度。"""
    when = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(days=days_ago)
    async with SessionLocal() as db:
        db.add(CardReview(card_id=card_id, grade=grade, reviewed_at=when))
        await db.commit()


async def _pet_lines() -> list:
    from sqlalchemy import select

    async with SessionLocal() as db:
        return list((await db.execute(select(PetEvent))).scalars().all())


NAMES = {
    "asyncio 事件循环": {"event loop 调度"},
    "SQLite 锁机制": set(),
}


# ---------- 关联规则（纯函数） ----------


def test_an_exact_name_matches_even_when_typing_differs():
    """一字不差**归一化之后**的一字不差：大小写、空格、全角都不算差别。"""
    assert cross.match_topic("asyncio 事件循环", NAMES) == "asyncio 事件循环"
    assert cross.match_topic("  Asyncio  事件循环 ", NAMES) == "asyncio 事件循环"
    assert cross.match_topic("ＡＳＹＮＣＩＯ 事件循环", NAMES) == "asyncio 事件循环"


def test_an_alias_matches_too():
    """别名展开：几个月后重逢时用的词，往往正好是别名里的那一个。"""
    assert cross.match_topic("event loop 调度", NAMES) == "asyncio 事件循环"


def test_containment_matches_at_the_ends_only():
    """一个包含另一个（开头或结尾）。中间撞上的巧合太多，不做任意位置子串。"""
    assert cross.match_topic("asyncio 事件循环的实现", NAMES) == "asyncio 事件循环"
    assert cross.match_topic("聊聊 asyncio 事件循环", NAMES) == "asyncio 事件循环"


def test_two_strings_that_are_not_substrings_of_each_other_match_nothing():
    """"asyncio 事件循环" vs "SQLite 锁机制"：关联不上是**常态**，不是失败。

    短于门槛（`tutor._contains` 里那个 4 字）也一样：宁可少一行，不乱认。
    """
    assert cross.match_topic("SQLite 的 WAL 模式", {"asyncio 事件循环": set()}) == ""
    assert cross.match_topic("GIL", {"asyncio 事件循环": set()}) == ""
    assert cross.match_topic("", NAMES) == ""


def test_an_ambiguous_match_is_no_match_at_all():
    """两个概念都答得上 → **不匹配**。挑错的那个会把「已掌握」标到别的概念上，
    而那是这座桥唯一不能犯的错。"""
    ambiguous = {
        "asyncio 事件循环": {"event loop"},
        "asyncio 的 event loop": {"event loop"},  # 别名撞车
    }
    assert cross.match_topic("event loop", ambiguous) == ""
    # 包含关系指向两边，同样不匹配
    two_ways = {"asyncio 事件循环机制": set(), "asyncio 事件循环": set()}
    assert cross.match_topic("asyncio 事件循环机制详解", two_ways) == ""


# ---------- 对照事实（纯函数） ----------


def test_a_contradiction_needs_both_sides():
    """已掌握 × 近 7 天重来 ≥2——**少一个都不算**（§2 T1）。"""
    m = {"asyncio 事件循环"}
    both = cross.crosscheck("asyncio 事件循环", 2, names=NAMES, mastered=m, said_n={"asyncio 事件循环": 2})
    assert both["contradiction"] is True and both["mastered"] is True and both["said_n"] == 2

    once = cross.crosscheck("asyncio 事件循环", 1, names=NAMES, mastered=m)
    assert once["contradiction"] is False  # 重来一次是手滑，不是落差

    not_mastered = cross.crosscheck("asyncio 事件循环", 5, names=NAMES, mastered=set())
    assert not_mastered["contradiction"] is False and not_mastered["mastered"] is False

    no_concept = cross.crosscheck("完全不相关的话题", 9, names=NAMES, mastered=m)
    assert no_concept == {
        "concept": "",
        "mastered": False,
        "said_n": 0,
        "again_7d": 9,
        "contradiction": False,
    }


def test_the_card_summary_adds_up_across_topic_words():
    """一个概念可能对应好几个话题词（出卡时每次写的都不一样）——问的是概念名下有多少卡。"""
    by_topic = {
        "asyncio 事件循环": {"n": 2, "mature": 1, "again_7d": 1},
        "event loop 调度": {"n": 1, "mature": 0, "again_7d": 2},
        "SQLite 的 WAL 模式": {"n": 4, "mature": 4, "again_7d": 0},  # 关联不上 → 不进
    }
    out = cross.concept_cards(by_topic, NAMES)
    # `topics` 是「这些数字按哪几个话题词算出来的」：学习地图那一行要点得动，
    # 而复习页是按 `Card.topic` 精确筛的（别名那种情况靠字符串搜索会少几张卡）。
    assert out == {
        "asyncio 事件循环": {
            "n": 3,
            "mature": 1,
            "again_7d": 3,
            "topics": ["asyncio 事件循环", "event loop 调度"],
        }
    }


# ---------- 前置候选（纯函数） ----------


def test_candidates_come_only_from_half_and_recurring():
    """掌握了的不进候选：它不可能是你卡住的原因；说通过一次还没掌握的也不进
    ——那不是「不通」，是「还没熟」。"""
    pool = ["已掌握的", "半懂的", "又卡住的", "两个都占的", "没碰过的", "第五个半懂的"]
    out = cross.prereq_candidates(
        pool, half={"半懂的", "两个都占的", "第五个半懂的"}, recurring={"又卡住的", "两个都占的"}
    )
    assert [c["concept"] for c in out] == ["半懂的", "又卡住的", "两个都占的"]  # 最多 3 个
    assert out[0]["status"] == "半懂"
    assert out[1]["status"] == "又卡住"
    assert out[2]["status"] == "半懂 · 又卡住"  # 两个都占就都写上


def test_no_candidate_is_a_fine_answer():
    """找不到候选 → 空表，**不硬凑**（§2 T3 第 4 条）。"""
    assert cross.prereq_candidates([], half={"半懂的"}, recurring=set()) == []
    assert cross.prereq_candidates(["已掌握的", ""], half=set(), recurring=set()) == []
    assert cross.prereq_candidates(["a", "a", "a"], half={"a"}, recurring=set()) == [
        {"concept": "a", "status": "半懂"}
    ]  # 去重


# ---------- 真行：地图那一行摘要 ----------


async def test_the_map_carries_a_card_summary_only_when_there_are_cards():
    """学习地图：有卡的概念带 `cards_summary`，**没有卡的概念不带这个键**（只摆非零）。"""
    await _session("asyncio 事件循环", "got")
    await _session("asyncio 事件循环", "got", days_ago=0.1)  # 说通 ×2 = 已掌握
    await _session("SQLite 锁机制", "half")
    await _card("asyncio 事件循环", interval_days=30.0)  # 成熟
    await _card("asyncio 事件循环", interval_days=2.0)
    # 那张 leech 卡的「重来」：同 topic 近 7 天两次
    cid = await _card("asyncio 事件循环", interval_days=0.0)
    await _lapse(cid)
    await _lapse(cid)

    m = await tutor.learning_map()
    got = {c["concept"]: c for c in m["mastered"]}
    assert got["asyncio 事件循环"]["cards_summary"] == {
        "n": 3,
        "mature": 1,
        "again_7d": 2,
        "topics": ["asyncio 事件循环"],
    }
    half = {c["concept"]: c for c in m["learning"]}
    assert "cards_summary" not in half["SQLite 锁机制"]  # 没有卡 → 连键都没有


async def test_the_summary_only_counts_the_last_seven_days():
    await _session("asyncio 事件循环", "got")
    cid = await _card("asyncio 事件循环", interval_days=0.0)
    await _lapse(cid)
    await _lapse(cid, days_ago=20)  # 窗口外
    summaries = await cross.concept_summaries()
    assert summaries["asyncio 事件循环"]["again_7d"] == 1


# ---------- 真行：递卡那条对质 ----------


async def test_a_due_card_whose_concept_is_mastered_is_the_one_to_say_out_loud():
    await _session("asyncio 事件循环", "got")
    await _session("asyncio 事件循环", "got", days_ago=0.1)
    cid = await _card("asyncio 事件循环", interval_days=0.0)
    await _lapse(cid)
    await _lapse(cid)

    out = await cross.due_contradiction()
    fact = out["contradiction"]
    assert fact and fact["card_id"] == cid
    assert fact["concept"] == "asyncio 事件循环" and fact["mastered"] is True
    assert fact["said_n"] == 2 and fact["again_7d"] == 2


async def test_no_contradiction_when_the_concept_is_not_mastered():
    """概念还是半懂 → 没有落差可说，界面照旧念到期卡（`contradiction=null`）。"""
    await _session("asyncio 事件循环", "half")
    cid = await _card("asyncio 事件循环", interval_days=0.0)
    await _lapse(cid)
    await _lapse(cid)
    assert (await cross.due_contradiction())["contradiction"] is None


async def test_the_scan_never_sees_a_card_that_is_not_due_or_is_shelved():
    """扫的是**今天到期的**卡：还没到点的、搁置的都不算。"""
    await _session("asyncio 事件循环", "got")
    await _session("asyncio 事件循环", "got", days_ago=0.1)
    later = await _card("asyncio 事件循环", interval_days=5.0, due=utcnow() + timedelta(days=3))
    await _lapse(later)
    await _lapse(later)
    assert (await cross.due_contradiction())["contradiction"] is None

    shelved = await _card("asyncio 事件循环", interval_days=0.0, suspended=True)
    await _lapse(shelved)
    await _lapse(shelved)
    assert (await cross.due_contradiction())["contradiction"] is None


async def test_the_per_card_endpoint_says_the_same_thing():
    await _session("asyncio 事件循环", "got")
    await _session("asyncio 事件循环", "got", days_ago=0.1)
    cid = await _card("asyncio 事件循环", interval_days=0.0)
    await _lapse(cid)
    await _lapse(cid)
    out = await cross.card_crosscheck(cid)
    assert out["card_id"] == cid and out["contradiction"] is True and out["again_7d"] == 2
    assert await cross.card_crosscheck(999999) is None


# ---------- 真行：搁置卡的前置回指（T3） ----------


async def test_a_shelved_card_points_at_the_concept_that_is_still_half_understood():
    """一张 leech 卡，它自己那个概念还是半懂 → 候选里就有它：先讲通它，再刷它的卡。"""
    await _session("asyncio 事件循环", "half")
    cid = await _card("asyncio 事件循环", interval_days=0.0, lapses=8, suspended=True)
    out = await cross.prereq(cid)
    assert out["concept"] == "asyncio 事件循环" and out["suspended"] is True
    assert out["candidates"] == [{"concept": "asyncio 事件循环", "status": "半懂"}]


async def test_a_shelved_card_with_nothing_to_point_at_shows_nothing():
    """关联不上、也没有半懂/又卡住的概念 → 候选空着（**不是失败**，不硬凑）。"""
    cid = await _card("完全不相关的话题", interval_days=0.0, lapses=8, suspended=True)
    out = await cross.prereq(cid)
    assert out["concept"] == "" and out["candidates"] == []
    assert await cross.prereq(999999) is None


async def test_shelving_a_card_makes_the_pet_say_nothing(monkeypatch):
    """T3 的触发点不动，而且**搁置那一刻零柒一个字不说**（不进 nudge、不冒泡）。"""
    monkeypatch.setattr(cards_core, "fuzz_interval", lambda days, rnd=None: days)
    cid = await _card("asyncio 事件循环", interval_days=0.0, lapses=7, reps=9)

    out = await cards_core.submit_review(cid, 1)  # 第 8 次答错 → 自动搁置
    assert out["lapses"] == 8
    async with SessionLocal() as db:
        from sqlalchemy import select

        assert (await db.execute(select(Card))).scalars().one().suspended is True
    assert await _pet_lines() == []
    # 拉取式：看的时候才有——这时才翻得出候选
    assert (await cross.prereq(cid))["lapses"] == 8


# ---------- 度量：双轨矛盾率（§6，只进仪表盘） ----------


def test_the_gap_rate_is_none_when_there_is_nothing_mastered():
    """分母为 0 → `None`，不是 0：**还没有数据**与**一条矛盾都没有**是两件事。"""
    assert cross.gap_rate(set(), {"a"}) == (0, 0, None)
    assert cross.gap_rate({"a", "b"}, {"a"}) == (1, 2, 0.5)
    assert cross.gap_rate({"a"}, set()) == (0, 1, 0.0)  # 有分母、没有矛盾 = 真的 0


async def test_the_gap_rate_counts_mastered_concepts_whose_cards_still_come_back():
    await _session("asyncio 事件循环", "got")
    await _session("asyncio 事件循环", "got", days_ago=0.1)
    await _session("SQLite 锁机制", "got")
    await _session("SQLite 锁机制", "got", days_ago=0.1)
    cid = await _card("asyncio 事件循环", interval_days=0.0)
    await _lapse(cid)

    out = await cross.contradiction_rate()
    assert out["readable"] is True and (out["n"], out["denominator"]) == (1, 2)
    assert out["rate"] == 0.5 and "它降说明两条轨接上了" in out["rule"]
    # 30 天窗口：40 天前那次重来不算（这是覆盖率，不是活跃度）
    await _lapse(cid, days_ago=40)
    assert (await cross.contradiction_rate())["n"] == 1
    # 一条矛盾都没有时它是真 0（有分母）
    async with SessionLocal() as db:
        from sqlalchemy import delete

        await db.execute(delete(CardReview))
        await db.commit()
    zero = await cross.contradiction_rate()
    assert zero["rate"] == 0.0 and zero["denominator"] == 2


# ---------- 度量：回指采纳（§6 第三条） ----------


def test_adoption_is_none_when_nobody_looked():
    """一张都没翻过 → `None`，不是 0：0 读作「翻了但一次都没点」，
    「没人翻过」差的是整整一个功能。两边都是**卡的个数**，同一张卡点两下只算一次。"""
    assert cross.adoption(set(), set()) == (0, 0, None)
    assert cross.adoption({1, 2, 3, 4}, {1}) == (1, 4, 0.25)
    assert cross.adoption({1, 2}, set()) == (0, 2, 0.0)  # 有分母、没人点 = 真的 0
    assert cross.adoption({1, 2}, {1, 1, 1}) == (1, 2, 0.5)  # 集合天然去重


async def test_the_adoption_rate_reads_the_two_marks():
    """真行：翻过（`cards.prereq_seen_at`）与采纳（`tutor_sessions.prereq_card_id`）。"""
    a = await _card("asyncio 事件循环", interval_days=0.0, lapses=8, suspended=True)
    b = await _card("SQLite WAL 模式", interval_days=0.0, lapses=8, suspended=True)
    await _card("另一个话题", interval_days=0.0, lapses=8, suspended=True)  # 既不翻也不采纳
    assert await cross.mark_prereq_seen(a) is True
    assert await cross.mark_prereq_seen(b) is True
    assert await cross.mark_prereq_seen(999999) is False  # 卡不存在 → False（路由翻 404）

    await cross.due_contradiction()  # 与它无关：这条度量只看那两处痕迹
    async with SessionLocal() as db:
        from app.models import TutorSession

        db.add(TutorSession(topic="召回率", prereq_card_id=a, created_at=utcnow()))
        db.add(TutorSession(topic="随便说说", created_at=utcnow()))  # 不是从候选开的
        await db.commit()

    out = await cross.adoption_rate()
    assert out["readable"] is True
    assert (out["n"], out["denominator"], out["rate"]) == (1, 2, 0.5)
    assert "翻过" in out["rule"] and "偏小" in out["bias"]


async def test_a_session_started_from_a_candidate_carries_the_card(monkeypatch):
    """接线：`tutor.start(prereq_card_id=…)` 把「从哪张卡来的」记在会话行上。

    它只记事实——**那张卡一个字节都不动**（不开、不关、不计数给人看）。
    """
    from app.core import tutor

    cid = await _card("asyncio 事件循环", interval_days=0.0, lapses=8, suspended=True)
    out = await tutor.start("召回率", prereq_card_id=cid)
    async with SessionLocal() as db:
        from app.models import TutorSession

        row = await db.get(TutorSession, out["id"])
    assert row.prereq_card_id == cid
    # 不带就是 None（绝大多数开场都是这种）
    plain = await tutor.start("另一个话题")
    async with SessionLocal() as db:
        from app.models import TutorSession

        assert (await db.get(TutorSession, plain["id"])).prereq_card_id is None


async def test_the_adoption_rate_failure_is_not_a_zero_line(monkeypatch):
    from app.core import pet

    def bad_bounds(_day):  # noqa: ANN001
        raise RuntimeError("db down")

    monkeypatch.setattr(pet, "local_day_utc_bounds", bad_bounds)
    out = await cross.adoption_rate()
    assert out["readable"] is False and "db down" in out["error"]
    assert out["rate"] is None and out["denominator"] == 0


async def test_the_gap_rate_says_it_cannot_read_rather_than_zero(monkeypatch):
    """索引读不出来时**不许**说「还没有已掌握的概念」——那是把读不到说成一条都没有，
    而这张卡量的事情正是这个。"""
    async def boom() -> list:
        raise RuntimeError("db down")

    monkeypatch.setattr(tutor, "_concept_rows", boom)
    out = await cross.contradiction_rate()
    assert out["readable"] is False and out["rate"] is None and out["denominator"] == 0
    assert out["error"] == "概念索引读不出来"
    assert await _pet_lines() == []


# ---------- P2-2：语义兜底量过之后**没有上线** ----------


async def test_the_bridge_never_needs_an_embedder(monkeypatch):
    """`match_topic` 是纯函数：**一次 embedder 都不碰**。这条守的是两个东西。

    1. **结论**（PLAN2 §11）：P2-2 的余弦兜底量完判了不上——名字对名字的余弦分不开
       「同一件事」与「隔壁那件事」（`smoke_cross.py` 那两条分布重叠 0.2，阈值扫过
       0.3–0.95 没有一行两边都干净）。谁哪天顺手加一个兜底，T1 的地图那一行和那句台词
       就会开始把隔壁的卡算到这个概念头上。
    2. **成本**：挂件每 5 分钟拉一次提醒（`due_contradiction` 在那条路上），而 embedder
       首次加载是 6-7 秒、每次批量几十毫秒——为一行只读小字把它拽起来不划算。
       T3 的候选池**是**允许用向量的（那是「可能缺前置」的建议，`concept_neighbors`），
       所以这里只钉「匹配」那一路。
    """
    async def boom(_texts):
        raise RuntimeError("这条路上不该有人调 embedder")

    monkeypatch.setattr(tutor, "_embed", boom)  # `concept_neighbors` 会吞掉它，别的一律炸

    await _session("asyncio 事件循环", "got")
    await _session("asyncio 事件循环", "got", days_ago=0.1)
    cid = await _card("asyncio 事件循环", interval_days=0.0)
    await _lapse(cid)
    await _lapse(cid)

    idx = await cross.concept_index()
    assert idx["mastered"] == {"asyncio 事件循环"}  # 索引也全是查询算的，没借向量
    fact = await cross.card_crosscheck(cid)
    assert fact["concept"] == "asyncio 事件循环" and fact["contradiction"] is True
    assert (await cross.due_contradiction())["contradiction"]["card_id"] == cid
    assert (await cross.concept_summaries())["asyncio 事件循环"]["again_7d"] == 2
    assert (await tutor.learning_map())["mastered"][0]["cards_summary"]["n"] == 1


def test_the_source_never_reaches_for_the_embedder():
    """源码层面也钉一次：`cross.py` 里没有 `embedder` / `_embed`（只借 `concept_neighbors`）。"""
    src = Path("app/core/cross.py").read_text(encoding="utf-8")
    assert "_embed(" not in src
    assert "from app.core import embedder" not in src
    assert "embedder." not in src
    # 反面：T3 的候选池确实走了邻居（那一路是允许用向量的，且它自己兜底）
    assert "concept_neighbors" in src


def test_the_calibration_ruler_still_has_its_hard_negatives():
    """尺子本身也要有人守。

    `smoke_cross.py` 的结论全靠那批负样本：把「同领域隔壁概念」从里面挪走，两条分布
    立刻变得漂亮，那个 FAIL 就会变成 PASS——而线上会开始说错话。所以：难的那几条必须在，
    而且正样本里被确定性规则接住的不能多（接住了就不该算在向量头上，样本会量不到东西）。
    """
    import smoke_cross as sc

    assert len(sc.POSITIVE) >= 10 and len(sc.NEGATIVE) >= 10
    assert len(sc.ADJACENT) >= 4 and set(sc.ADJACENT) <= set(sc.NEGATIVE)
    assert not ({t for t, _ in sc.POSITIVE} & set(sc.NEGATIVE)), "同一个话题不能两边都算"
    assert all(0 <= i < len(sc.POOL) for _t, i in sc.POSITIVE)
    assert len({c for c, _a in sc.POOL}) == len(sc.POOL)
    assert min(sc.SWEEP) <= 0.4 and max(sc.SWEEP) >= 0.9, "扫的区间要够宽，否则「没有干净点」不算结论"

    names = {c: set(a) for c, a in sc.POOL}
    caught = [t for t, _ in sc.POSITIVE if cross.match_topic(t, names)]
    assert len(caught) <= 2, f"正样本里 {len(caught)} 条被包含规则接住了，这套样本量不到向量"
    assert not [t for t in sc.NEGATIVE if cross.match_topic(t, names)], "包含规则不该误接负样本"


# ---------- 红线：桥只出事实，不出台词 ----------


async def test_the_bridge_never_speaks():
    """PLAN2 §6 的红线：这三个端点跑一遍，零柒一个字都不说；源码里也没有 pet 调用。"""
    await _session("asyncio 事件循环", "half")
    cid = await _card("asyncio 事件循环", interval_days=0.0, lapses=8, suspended=True)
    await cross.concept_summaries()
    await cross.card_crosscheck(cid)
    await cross.due_contradiction()
    await cross.contradiction_rate()
    await cross.adoption_rate()
    await cross.prereq(cid)
    await tutor.learning_map()
    assert await _pet_lines() == []

    src = Path("app/core/cross.py").read_text(encoding="utf-8")
    # **扫语法树，不扫字面**：这一段的注释里正当地写着「台词由 `pet.compose()` 那边说」，
    # 拿正则扫文本会把一句解释判成一次调用。
    tree = ast.parse(src)
    used = sorted(
        {
            n.attr
            for n in ast.walk(tree)
            if isinstance(n, ast.Attribute) and getattr(n.value, "id", "") == "pet"
        }
    )
    # 允许的只有那一份本地日换算（与 `metrics.py` 同一条规矩：只拿那一个函数）。
    # 开口的路（emit / compose / feed / note_output / greeting）一条都不许有——
    # 它们不是「查时间」，是「让宠物说话」。这份白名单就是这条红线的全部内容。
    assert used == ["local_day_utc_bounds"]
    assert "pet_events" not in src
    # 反面：它确实读了 tutor 的判据（借，不重写）
    assert "is_mastered" in src and "is_recurring_mistake" in src
