"""Offline tests for habits (core/habits.py): streak rules, tick semantics, guards.

No DB and no clock: `streak()` takes `today` as a parameter precisely so these
are plain assertions about a set of date strings.
"""
import sys
from datetime import date

import pytest

sys.path.insert(0, ".")

from app.core.habits import (  # noqa: E402
    ALL_DAYS,
    MAX_TARGET,
    OVERSHOOT,
    clamp_value,
    is_done,
    is_scheduled,
    streak,
    validate,
)

# 2026-09-04 is a Friday; weekday() == 4
FRI = date(2026, 9, 4)


def days(*iso: str) -> set[str]:
    return set(iso)


# ---------- streak ----------


def test_streak_counts_consecutive_days_including_today():
    assert streak(days("2026-09-02", "2026-09-03", "2026-09-04"), ALL_DAYS, FRI) == 3


def test_yesterday_only_still_counts_as_a_live_streak():
    # otherwise the number reads 0 every morning before you have done anything
    assert streak(days("2026-09-02", "2026-09-03"), ALL_DAYS, FRI) == 2


def test_a_whole_missed_day_breaks_the_streak():
    assert streak(days("2026-09-01", "2026-09-02"), ALL_DAYS, FRI) == 0


def test_empty_history_is_zero():
    assert streak(set(), ALL_DAYS, FRI) == 0


def test_today_done_but_gap_before_it_counts_only_today():
    assert streak(days("2026-08-30", "2026-09-04"), ALL_DAYS, FRI) == 1


def test_unscheduled_days_are_skipped_not_breaks():
    # weekends-only habit: Sat+Sun. Judged day-by-day it would read 0 forever.
    weekends = "0000011"
    done = days("2026-08-29", "2026-08-30")  # Sat + Sun last week
    assert streak(done, weekends, FRI) == 2
    # add the weekend before that and it keeps walking back over the weekdays
    done |= days("2026-08-22", "2026-08-23")
    assert streak(done, weekends, FRI) == 4


def test_missing_a_scheduled_day_still_breaks_a_weekday_habit():
    weekdays_only = "1111100"
    # Thu 09-03 done, Wed 09-02 missed → streak stops at 1
    assert streak(days("2026-09-01", "2026-09-03"), weekdays_only, FRI) == 1


def test_streak_is_zero_when_nothing_is_ever_scheduled():
    assert streak(days("2026-09-04"), "0000000", FRI) == 0


def test_is_scheduled_reads_monday_first_and_tolerates_bad_data():
    assert is_scheduled("0000100", FRI) is True  # index 4 == Friday
    assert is_scheduled("1111000", FRI) is False
    # a corrupt string must not silently hide a habit
    assert is_scheduled("garbage", FRI) is True
    assert is_scheduled("", FRI) is True


# ---------- done / clamp ----------


def test_check_habit_is_done_at_one_regardless_of_target():
    assert is_done("check", 1.0, 1.0) is True
    assert is_done("check", 0.0, 1.0) is False


def test_count_habit_is_done_at_target():
    assert is_done("count", 29.0, 30.0) is False
    assert is_done("count", 30.0, 30.0) is True
    assert is_done("count", 31.0, 30.0) is True


def test_check_value_is_always_pinned_to_one():
    assert clamp_value("check", 7.0, 1.0) == 1.0


def test_count_value_is_clamped_to_a_sane_overshoot():
    assert clamp_value("count", 10.0, 30.0) == 10.0
    assert clamp_value("count", 10_000.0, 30.0) == 30.0 * OVERSHOOT
    assert clamp_value("count", -5.0, 30.0) == 0.0


# ---------- validation ----------


def test_valid_definitions_pass():
    validate("写代码", "count", 30.0, ALL_DAYS, "")
    validate("今日复习", "check", 1.0, "1111100", "cards")


@pytest.mark.parametrize(
    "args",
    [
        ("", "check", 1.0, ALL_DAYS, ""),  # 空名称
        ("x" * 101, "check", 1.0, ALL_DAYS, ""),  # 名称过长
        ("a", "quiz", 1.0, ALL_DAYS, ""),  # 未知 kind
        ("a", "count", 0.0, ALL_DAYS, ""),  # 目标为 0
        ("a", "count", MAX_TARGET + 1, ALL_DAYS, ""),  # 目标过大
        ("a", "check", 1.0, "111", ""),  # weekdays 位数不对
        ("a", "check", 1.0, "111111x", ""),  # weekdays 含非 0/1
        ("a", "check", 1.0, "0000000", ""),  # 一天都不做
        ("a", "check", 1.0, ALL_DAYS, "magic"),  # 未知 auto_source
    ],
)
def test_bad_definitions_are_rejected(args):
    with pytest.raises(ValueError):
        validate(*args)
