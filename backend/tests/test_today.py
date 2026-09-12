"""Offline tests for 「今天下一步」.

`next_suggestion` is a pure function over a facts dict — no DB, no clock, no
network — so the priority ordering is testable with plain dicts. The priority is
the entire point: the background being broken must outrank everything else,
because a suggestion that relies on a broken model is worse than none.

自 2026-09-05 起这里还钉着一件事：**它不许再提到卡片、习惯、连续天数**。复习与习惯
封存了，判断标准是任何机制一旦产生「欠着没做」的感觉就是滑回上一版 ——
这一条建议是全站唯一一句会主动开口的文案，所以由测试守着它别长回待办。

§4-17 加的「一件事」那一档由同一套词表守着：它只说你最近动过什么、到哪了。
"""
import re
import sys

import pytest

sys.path.insert(0, ".")

from app.core.today import next_suggestion  # noqa: E402

# 封存词表：任何一个出现在建议文案里，就说明待办从后门回来了
_DEBT_WORDS = ("卡", "到期", "复习", "习惯", "打勾")
# 连续天数单独用形状匹配 —— 「连续失败」是报障，「连着 6 天」才是该禁的那种
_STREAK = re.compile(r"连[续着]\s*\d+\s*天")


def _facts(**kw) -> dict:
    base = {"default_model_broken": False, "jobs_failing": 0}
    base.update(kw)
    return base


def test_broken_default_model_is_the_first_thing_you_hear():
    # 2026-09-04 的形状：后台挂了，但每个界面看起来都正常
    s = next_suggestion(_facts(default_model_broken=True))
    assert s["tone"] == "bad"
    assert s["action"]["kind"] == "settings"
    assert "后台" in s["text"]


def test_failing_jobs_is_bad_and_leads_to_settings():
    s = next_suggestion(_facts(jobs_failing=2))
    assert s["tone"] == "bad"
    assert s["action"]["kind"] == "settings"
    assert "2" in s["text"] and "作业" in s["text"]


def test_a_dead_model_outranks_failing_jobs():
    """两个都坏时先说模型：作业失败大多是模型失败的后果。"""
    s = next_suggestion(_facts(default_model_broken=True, jobs_failing=3))
    assert "默认模型" in s["text"]


def test_nothing_broken_says_nothing_to_do():
    s = next_suggestion(_facts())
    assert s["tone"] == "idle"
    assert s["action"]["kind"] == "none"


def test_empty_facts_degrades_to_idle_not_crash():
    s = next_suggestion({})
    assert s["tone"] == "idle"
    assert s["action"]["kind"] == "none"


@pytest.mark.parametrize("bad", [None, "x", 42, {"jobs_failing": "一"}])
def test_garbage_facts_never_raise(bad):
    s = next_suggestion(bad)
    assert isinstance(s["text"], str) and s["tone"] in ("bad", "idle")


@pytest.mark.parametrize(
    "facts",
    [
        {},
        {"default_model_broken": True},
        {"jobs_failing": 4},
        # 旧字段就算还被谁传进来，也不该让待办文案复活
        {"queue_total": 12, "habits_pending": 3, "streak": 9, "total_cards": 46},
    ],
)
def test_no_branch_ever_mentions_cards_habits_or_streaks(facts):
    text = next_suggestion(facts)["text"]
    assert not [w for w in _DEBT_WORDS if w in text], text
    assert not _STREAK.search(text), text


def test_stale_card_facts_are_ignored_rather_than_honoured():
    """封存后 queue_total 不再是输入。传进来也只能得到「没什么要处理的」，
    绝不能变成「今天有 12 张卡到期」。"""
    s = next_suggestion({"queue_total": 12, "total_cards": 46, "streak": 9})
    assert s["tone"] == "idle"
    assert s["action"]["kind"] == "none"


def test_no_action_kind_points_at_a_sealed_page():
    """`thread` 是活的（/threads），另外两个是报障与"没事"。"""
    for facts in ({}, {"default_model_broken": True}, {"jobs_failing": 1}):
        assert next_suggestion(facts)["action"]["kind"] in ("settings", "none", "thread")


# ---------- 「一件事」那一档（§4-17） ----------


def test_a_recent_thread_surfaces_only_when_nothing_is_broken():
    facts = _facts(threads=[{"id": 3, "name": "RAG 评测", "summary": "搞懂 2 · 交付 1"}])
    s = next_suggestion(facts)
    assert s["tone"] == "idle"
    assert s["action"]["kind"] == "thread" and s["action"]["thread_id"] == 3
    assert "RAG 评测" in s["text"] and "搞懂 2" in s["text"]

    # 有故障先说故障：那是报障，这只是"从哪接着看"
    broken = next_suggestion({**facts, "default_model_broken": True})
    assert broken["action"]["kind"] == "settings"


def test_thread_tier_is_state_not_a_debt_list():
    """只说它到哪了，不说你还欠哪一步——这个产品的红线是不做债。"""
    s = next_suggestion(_facts(threads=[{"id": 1, "name": "X", "summary": "搞懂 2"}]))
    assert not [w for w in _DEBT_WORDS if w in s["text"]], s["text"]
    assert not _STREAK.search(s["text"])


@pytest.mark.parametrize("bad", [[], None, "x", [{}], [{"name": ""}], [1, 2]])
def test_junk_thread_facts_degrade_to_idle(bad):
    assert next_suggestion(_facts(threads=bad))["action"]["kind"] == "none"


def test_fallback_does_not_depend_on_a_try_block_import():
    """`today_core` must be bound before fact assembly can fail.

    Regression guard: it used to be imported inside the same try whose except
    calls it, so an ImportError there raised UnboundLocalError instead of
    degrading — a 500 in exactly the "后台挂了" case the endpoint is for. Reading
    it off the module (not re-importing) is what pins the fix.
    """
    from app.routers import today as router_mod

    assert router_mod.today_core.next_suggestion({})["tone"] == "idle"
