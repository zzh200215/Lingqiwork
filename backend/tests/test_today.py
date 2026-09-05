"""Offline tests for the 今日页「下一步」建议 (PLAN 第0周).

`next_suggestion` is a pure function over a facts dict — no DB, no clock, no
network — so the priority ordering is testable with plain dicts. The priority is
the entire point: the background being broken must outrank an empty queue,
because a suggestion that relies on a broken model is worse than none.
"""
import sys

import pytest

sys.path.insert(0, ".")

from app.core.today import next_suggestion  # noqa: E402


def _facts(**kw) -> dict:
    base = {
        "default_model_broken": False,
        "jobs_failing": 0,
        "queue_total": 0,
        "total_cards": 5,
        "streak": 3,
        "habits_pending": 0,
    }
    base.update(kw)
    return base


def test_broken_default_model_outranks_everything():
    # even with a pile of cards due, a dead default model is the first thing you
    # should know — this is the 2026-09-04 shape
    s = next_suggestion(_facts(queue_total=12, default_model_broken=True))
    assert s["tone"] == "bad"
    assert s["action"]["kind"] == "settings"
    assert "后台" in s["text"]


def test_failing_jobs_is_bad_and_leads_to_settings():
    s = next_suggestion(_facts(queue_total=3, jobs_failing=2))
    assert s["tone"] == "bad"
    assert s["action"]["kind"] == "settings"
    assert "作业" in s["text"]


def test_due_cards_come_before_habits():
    s = next_suggestion(_facts(queue_total=4, habits_pending=2))
    assert s["tone"] == "normal"
    assert s["action"]["kind"] == "review"
    assert "4" in s["text"]


def test_no_due_cards_but_pending_habits():
    s = next_suggestion(_facts(queue_total=0, habits_pending=3))
    assert s["tone"] == "idle"
    assert s["action"]["kind"] == "none"
    assert "习惯" in s["text"]


def test_no_cards_at_all_suggests_making_the_first():
    s = next_suggestion(_facts(queue_total=0, total_cards=0, habits_pending=0))
    assert s["action"]["kind"] == "make_card"
    assert s["tone"] == "idle"


def test_everything_cleared_with_a_streak():
    s = next_suggestion(_facts(queue_total=0, habits_pending=0, streak=6))
    assert s["tone"] == "idle"
    assert "6" in s["text"]
    assert s["action"]["kind"] == "none"


def test_everything_cleared_no_streak():
    s = next_suggestion(_facts(queue_total=0, habits_pending=0, streak=0))
    assert s["tone"] == "idle"
    assert s["action"]["kind"] == "none"


def test_empty_facts_degrades_to_make_card_not_crash():
    # empty facts read like a fresh install: no cards, no model knowledge
    s = next_suggestion({})
    assert s["tone"] == "idle"
    assert s["action"]["kind"] == "make_card"


@pytest.mark.parametrize("bad", [None, "x", 42, {"queue_total": "一"}])
def test_garbage_facts_never_raise(bad):
    s = next_suggestion(bad)
    assert isinstance(s["text"], str) and s["tone"] in ("bad", "normal", "idle")


def test_fallback_does_not_depend_on_a_try_block_import():
    """`today_core` must be bound before fact assembly can fail.

    Regression guard: it used to be imported inside the same try whose except
    calls it, so an ImportError there raised UnboundLocalError instead of
    degrading — a 500 in exactly the "后台挂了" case the endpoint is for. Reading
    it off the module (not re-importing) is what pins the fix.
    """
    from app.routers import today as router_mod

    assert router_mod.today_core.next_suggestion({})["tone"] == "idle"