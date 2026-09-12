"""Offline tests for 「今天下一步」.

`next_suggestion` is a pure function over a facts dict — no DB, no clock, no
network — so the priority ordering is testable with plain dicts. The priority is
the entire point: the background being broken must outrank everything else,
because a suggestion that relies on a broken model is worse than none.

自 2026-09-05 起这里还钉着一件事：**它不许再提到卡片、习惯、连续天数**。第 3 节把复习
与习惯封存了，第 2 节的判断标准是任何机制一旦产生「欠着没做」的感觉就是滑回上一版 ——
这一条建议是全站唯一一句会主动开口的文案，所以由测试守着它别长回待办。
"""
import re
import sys

import pytest

sys.path.insert(0, ".")

from app.core.today import next_suggestion  # noqa: E402

# 封存词表：任何一个出现在建议文案里，就说明待办从后门回来了
_DEBT_WORDS = ("卡", "到期", "复习", "习惯", "打勾")
# 连续天数单独用形状匹配 —— 「连续失败」是报障，「连着 6 天」才是第 2 节禁的那种
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
    """第 3 节封存后 queue_total 不再是输入。传进来也只能得到「没什么要处理的」，
    绝不能变成「今天有 12 张卡到期」。"""
    s = next_suggestion({"queue_total": 12, "total_cards": 46, "streak": 9})
    assert s["tone"] == "idle"
    assert s["action"]["kind"] == "none"


def test_no_action_kind_points_at_a_sealed_page():
    for facts in ({}, {"default_model_broken": True}, {"jobs_failing": 1}):
        assert next_suggestion(facts)["action"]["kind"] in ("settings", "none")


def test_fallback_does_not_depend_on_a_try_block_import():
    """`today_core` must be bound before fact assembly can fail.

    Regression guard: it used to be imported inside the same try whose except
    calls it, so an ImportError there raised UnboundLocalError instead of
    degrading — a 500 in exactly the "后台挂了" case the endpoint is for. Reading
    it off the module (not re-importing) is what pins the fix.
    """
    from app.routers import today as router_mod

    assert router_mod.today_core.next_suggestion({})["tone"] == "idle"
