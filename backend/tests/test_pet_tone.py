"""性格微调（P2 · 按喂养分布改用词）的离线测试。

四件事，全是这一格的边界条件——它最容易出的错不是"不生效"，是**生效过头**：

1. **门槛**：一个领域要到 `MIN_SAMPLE` 个概念才算数（一两个概念就贴标签 = 拿噪声当性格）；
2. **只追加**：`apply()` 绝不替换人设，关掉或数不出领域时**原样返回**（`pet.CHAT_SYSTEM`
   是登记过的一等提示词，动它等于换人设版本）；
3. **三条自锁**写在提示词里（不夸 / 不评 / 不猜），并且**不是**嘴上说说——`TONE_RULE`
   文本里有、测试钉着；
4. **读不出来就不加**：库坏了、没领域、没配置，一律退回平常的说法。

模型一次都不调：这一格只生产**一段字符串**。
"""
import asyncio
import sys

import pytest

sys.path.insert(0, ".")

from app.core import pet  # noqa: E402
from app.core import pet_tone as tone  # noqa: E402
from app.core.prefs import save_config  # noqa: E402
from app.db import SessionLocal, engine as _engine  # noqa: E402
from app.models import Base as _Base  # noqa: E402
from app.models import TutorSession  # noqa: E402


async def _init_db() -> None:
    async with _engine.begin() as conn:
        await conn.run_sync(_Base.metadata.create_all)


asyncio.run(_init_db())


def _session(domain: str, concept: str, verdict: str = "got") -> None:
    async def go() -> None:
        async with SessionLocal() as db:
            db.add(TutorSession(topic=concept, concept=concept, domain=domain, verdict=verdict))
            await db.commit()

    asyncio.run(go())


@pytest.fixture(autouse=True)
def _clean():
    from sqlalchemy import delete

    async def _go() -> None:
        async with SessionLocal() as db:
            await db.execute(delete(TutorSession))
            await db.commit()

    asyncio.run(_go())
    save_config({"pet_tone": True})
    yield


# ---------- 分布与门槛 ----------


def test_feeding_reads_the_real_distribution():
    _session("教学", "费曼反转")
    _session("教学", "费曼反转")  # 同一个概念的第二场
    _session("教学", "支架式提问")
    _session("检索", "BM25 与向量的互补")

    rows = asyncio.run(tone.feeding())
    assert [(r["domain"], r["seen"]) for r in rows] == [("教学", 2), ("检索", 1)]
    # 「掌握」照 `is_mastered` 那条规矩如实给：一场是运气、两场才算
    assert rows[0]["mastered"] == 1 and rows[1]["mastered"] == 0


def test_a_domain_needs_enough_concepts_to_count():
    """一两个概念不给用户贴标签——**没有基线就不许说它行**的同一条纪律。"""
    _session("教学", "费曼反转")
    _session("教学", "支架式提问")
    assert asyncio.run(tone.hint()) == ""

    _session("教学", "最近发展区")
    got = asyncio.run(tone.hint())
    assert "教学" in got and "3 个概念" in got


def test_only_the_top_two_domains_are_named():
    for d, n in (("教学", 5), ("检索", 4), ("运维", 3)):
        for i in range(n):
            _session(d, f"{d}-{i}")
    got = asyncio.run(tone.hint())
    assert "教学" in got and "检索" in got
    assert "运维" not in got  # 说三个以上就成了给用户画学习画像


def test_sessions_without_a_domain_are_not_a_domain():
    """没归类的会话不进任何领域——「说不出口属于哪」不是「属于全部」。"""
    for i in range(5):
        _session("", f"散装-{i}")
    assert asyncio.run(tone.feeding()) == []
    assert asyncio.run(tone.hint()) == ""


# ---------- 开关与只追加 ----------


def test_the_switch_off_means_not_a_word():
    for i in range(5):
        _session("教学", f"教学-{i}")
    assert asyncio.run(tone.hint({"pet_tone": False})) == ""
    assert asyncio.run(tone.apply(pet.CHAT_SYSTEM, {"pet_tone": False})) == pet.CHAT_SYSTEM


def test_apply_only_appends_and_never_touches_the_persona():
    for i in range(4):
        _session("教学", f"教学-{i}")
    before = pet.CHAT_SYSTEM

    got = asyncio.run(tone.apply(before, {"pet_tone": True}))
    assert got.startswith(before) and len(got) > len(before)
    assert got != before
    # 人设常量本身一个字都没动（改它 = 换版本，质量闭环按 sha 分开统计）
    assert pet.CHAT_SYSTEM == before


def test_no_evidence_returns_the_string_untouched():
    """数不出领域时**原样返回同一个字符串**——不硬凑一句「他最近在学东西」。"""
    assert asyncio.run(tone.apply(pet.CHAT_SYSTEM, {"pet_tone": True})) == pet.CHAT_SYSTEM


def test_a_broken_database_does_not_break_the_pet(monkeypatch):
    async def boom():
        raise RuntimeError("db down")

    monkeypatch.setattr("app.core.tutor.concepts_by_domain", boom)
    assert asyncio.run(tone.feeding()) == []
    assert asyncio.run(tone.apply(pet.CHAT_SYSTEM, {"pet_tone": True})) == pet.CHAT_SYSTEM


# ---------- 三条自锁 ----------


def test_the_rule_carries_its_own_prohibitions():
    """自锁必须写在**模型看得见的那段文本**里：不夸、不评、不猜。

    这一格离「变成教练」只有一句话的距离，所以红线跟提示词走，不靠调用方记得。
    """
    assert "不要夸他" in tone.TONE_RULE
    assert "不要点评他的进度" in tone.TONE_RULE
    assert "建议他接下来该学什么" in tone.TONE_RULE
    assert "别硬凑" in tone.TONE_RULE  # 没数据时不许编
    # 它只谈用词，不谈立场
    assert "词可以直接用" in tone.TONE_RULE


def test_the_hint_says_how_many_concepts_so_it_is_checkable():
    """分布是**数出来的**：带上"几个概念"，用户能自己去学习地图对一眼。"""
    for i in range(3):
        _session("检索", f"检索-{i}")
    got = asyncio.run(tone.hint())
    assert "「检索」（3 个概念）" in got


def test_the_default_is_on():
    """默认开：默认关掉的功能在这个仓库里死过一次（`models.Habit` 那段注释）。"""
    from app.core.prefs import load_config

    save_config({})  # 什么都不设 = 回默认
    assert load_config().get("pet_tone", True) is True
    assert tone.enabled(load_config()) is True
    assert tone.flavor_enabled(load_config()) is True


# ---------- Z4（PLAN4）：称号旁那一行风味小注 ----------


def test_flavor_is_one_factual_sentence_with_checkable_numbers():
    """那一行说的是**事实**（哪个领域、几个概念），用户能自己去学习地图对一眼。"""
    for i in range(3):
        _session("检索", f"检索-{i}")
    got = asyncio.run(tone.flavor())
    assert got == "这阵子喂它最多的是「检索」（3 个概念）。"


def test_flavor_names_at_most_two_domains_and_says_which_is_second():
    for d, n in (("教学", 5), ("检索", 4), ("运维", 3)):
        for i in range(n):
            _session(d, f"{d}-{i}")
    got = asyncio.run(tone.flavor())
    assert "教学" in got and "检索" in got and "其次" in got
    assert "运维" not in got  # 说三个以上就成了给用户画学习画像


def test_flavor_needs_the_same_evidence_threshold_as_the_hint():
    """同一个门槛 `MIN_SAMPLE`：一两个概念不给用户贴标签——**不猜、不硬凑**。"""
    _session("教学", "费曼反转")
    _session("教学", "支架式提问")
    assert asyncio.run(tone.flavor()) == ""

    _session("教学", "最近发展区")
    assert "教学" in asyncio.run(tone.flavor())


def test_flavor_has_its_own_switch():
    """与 `pet_tone` 分开：一个改它怎么说话，一个只是成长页上多一行字。"""
    for i in range(3):
        _session("教学", f"教学-{i}")
    assert asyncio.run(tone.flavor({"pet_flavor": False, "pet_tone": True})) == ""
    assert asyncio.run(tone.hint({"pet_flavor": False, "pet_tone": True})) != ""
    assert asyncio.run(tone.flavor({"pet_flavor": True, "pet_tone": False})) != ""


def test_flavor_is_a_mirror_not_a_verdict():
    """三条自锁跟着这一行走：不夸、不评、不猜——它只是把分布说成一句话。

    这一格离「变成教练」只有一句话的距离：一旦它开始说「很努力」「继续保持」，
    那就不再是镜子了。
    """
    for i in range(3):
        _session("检索", f"检索-{i}")
    got = asyncio.run(tone.flavor())
    for word in ("努力", "加油", "继续保持", "建议", "应该", "还差", "欠", "进步"):
        assert word not in got, word


def test_flavor_line_handles_zero_one_and_two_domains():
    """纯函数那一层：空表给空串（界面上那一行不出现），一到两个领域各说各的。"""
    assert tone._flavor_line([]) == ""
    assert tone._flavor_line([{"domain": "检索", "seen": 3}]) == "这阵子喂它最多的是「检索」（3 个概念）。"
    two = tone._flavor_line([{"domain": "检索", "seen": 3}, {"domain": "教学", "seen": 4}])
    assert two == "这阵子喂它最多的是「检索」（3 个概念），其次是「教学」（4 个概念）。"
