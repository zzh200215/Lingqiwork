"""Offline tests for the review-card core: SM-2, prompt composition, JSON parsing.

No LLM, no DB, no clock. `schedule()` returns a seconds offset rather than a
datetime precisely so these can be plain integer assertions.
"""
import sys

import pytest

sys.path.insert(0, ".")

from app.core import cards as cards_mod  # noqa: E402
from app.core.cards import (  # noqa: E402
    GRADUATE_INTERVAL,
    KINDS,
    LEARNING_AGAIN_SEC,
    MAX_CARDS,
    MAX_EASE,
    MAX_FRONT_CHARS,
    MAX_INPUT_CHARS,
    MAX_INTERVAL,
    MIN_EASE,
    SECOND_INTERVAL,
    collect_material,
    compose_gen_prompt,
    fuzz_interval,
    parse_cards,
    schedule,
)

# ---------- SM-2 ----------


def test_new_card_good_graduates_to_one_day():
    s = schedule(0.0, 2.5, 0, 0, 3)
    assert s.interval_days == GRADUATE_INTERVAL
    assert s.reps == 1
    assert s.ease == 2.5  # 良好 leaves ease alone
    assert s.due_seconds == int(GRADUATE_INTERVAL * 86400)
    assert s.lapsed is False


def test_second_good_uses_six_days():
    s = schedule(1.0, 2.5, 1, 0, 3)
    assert s.interval_days == SECOND_INTERVAL
    assert s.reps == 2


def test_mature_good_multiplies_by_ease():
    s = schedule(6.0, 2.5, 2, 0, 3)
    assert s.interval_days == pytest.approx(15.0)


def test_again_resets_and_comes_back_in_ten_minutes():
    s = schedule(15.0, 2.5, 3, 0, 1)
    assert s.interval_days == 0.0
    assert s.reps == 0
    assert s.due_seconds == LEARNING_AGAIN_SEC
    assert s.ease == pytest.approx(2.30)
    assert s.lapses == 1
    assert s.lapsed is True


def test_again_on_a_brand_new_card_is_not_a_lapse():
    """Flubbing a card you have never answered is learning, not forgetting.

    Counting it as a lapse (a) would let a rough first pass trip the leech rule
    at 8, and (b) penalizing the ease would handicap a good card permanently.
    """
    s = schedule(0.0, 2.5, 0, 0, 1)
    assert s.lapses == 0
    assert s.lapsed is False
    assert s.ease == 2.5  # learning-phase ease is untouched


def test_hard_lowers_ease_and_grows_slower_than_good():
    hard = schedule(10.0, 2.5, 3, 0, 2)
    good = schedule(10.0, 2.5, 3, 0, 3)
    assert hard.ease == pytest.approx(2.35)
    assert hard.interval_days < good.interval_days


def test_easy_raises_ease_and_grows_fastest():
    easy = schedule(10.0, 2.5, 3, 0, 4)
    good = schedule(10.0, 2.5, 3, 0, 3)
    assert easy.ease == pytest.approx(2.60)
    assert easy.interval_days > good.interval_days


def test_interval_is_strictly_increasing_at_minimum_ease():
    """round(1 * 1.2) == 1 would pin a card at one day forever."""
    s = schedule(1.0, MIN_EASE, 2, 0, 2)
    assert s.interval_days >= 2.0


def test_ease_floor_and_ceiling_hold():
    low = schedule(5.0, MIN_EASE, 3, 0, 1)
    assert low.ease == MIN_EASE
    high = schedule(5.0, MAX_EASE, 3, 0, 4)
    assert high.ease == MAX_EASE


def test_interval_capped_at_one_year():
    s = schedule(300.0, 2.8, 9, 0, 4)
    assert s.interval_days == MAX_INTERVAL


@pytest.mark.parametrize("grade", [0, 5, -1, 99])
def test_bad_grade_raises(grade):
    with pytest.raises(ValueError):
        schedule(1.0, 2.5, 1, 0, grade)


def test_fuzz_leaves_short_intervals_alone():
    assert fuzz_interval(1.0) == 1.0
    assert fuzz_interval(2.0) == 2.0


def test_fuzz_stays_within_five_percent_and_is_seed_stable():
    import random

    a = fuzz_interval(30.0, random.Random(0))
    b = fuzz_interval(30.0, random.Random(0))
    assert a == b
    assert 28.5 <= a <= 31.5


def test_golden_sequence_catches_formula_drift():
    """Good x4 then Again then Good: snapshot the interval walk."""
    iv, ease, reps, lapses = 0.0, 2.5, 0, 0
    walk = []
    for grade in (3, 3, 3, 3, 1, 3):
        s = schedule(iv, ease, reps, lapses, grade)
        iv, ease, reps, lapses = s.interval_days, s.ease, s.reps, s.lapses
        walk.append(round(iv, 2))
    assert walk == [1.0, 6.0, 15.0, 37.5, 0.0, 1.0]


# ---------- prompt composition (pure) ----------


def test_prompt_declares_all_four_kinds_and_carries_material():
    system, user = compose_gen_prompt("材料正文", "PLAN.md", 8)
    for kind in KINDS:
        assert kind in system
    assert "材料正文" in user
    assert "PLAN.md" in user
    assert "8" in user


def test_prompt_count_is_capped_and_zero_rejected():
    _, user = compose_gen_prompt("材料", "x", 999)
    assert str(MAX_CARDS) in user
    with pytest.raises(ValueError):
        compose_gen_prompt("材料", "x", 0)


def test_prompt_kind_filter_appends_restriction():
    system, _ = compose_gen_prompt("材料", "x", 5, kinds=["cloze"])
    assert "只出以下类型" in system
    with pytest.raises(ValueError):
        compose_gen_prompt("材料", "x", 5, kinds=["bogus"])


def test_material_is_truncated_to_the_input_cap():
    _, user = compose_gen_prompt("A" * (MAX_INPUT_CHARS + 500), "x", 3)
    assert user.count("A") == MAX_INPUT_CHARS


# ---------- JSON parsing robustness ----------

_ONE = '[{"kind":"cloze","front":"F","back":"B"}]'


def test_bare_array_parses():
    cards, dropped = parse_cards(_ONE)
    assert len(cards) == 1 and dropped == 0
    assert cards[0]["kind"] == "cloze"


def test_wrapper_object_parses():
    cards, _ = parse_cards('{"cards": ' + _ONE + "}")
    assert len(cards) == 1


def test_markdown_fence_and_surrounding_prose_are_ignored():
    cards, _ = parse_cards("好的，这是卡片：\n```json\n" + _ONE + "\n```\n以上。")
    assert len(cards) == 1


def test_trailing_comma_is_repaired():
    cards, _ = parse_cards('[{"kind":"debug","front":"F","back":"B"},]')
    assert len(cards) == 1


@pytest.mark.parametrize(
    "raw", ["", "   ", "抱歉我无法完成", "{}", "[]", "[[1,2]]", '[{"front":"只有题面"}]']
)
def test_garbage_raises_valueerror(raw):
    """Card generation is a foreground action — a silent empty result looks broken."""
    with pytest.raises(ValueError):
        parse_cards(raw)


def test_chinese_kind_aliases_are_normalised():
    cards, _ = parse_cards(
        '[{"kind":"填空","front":"A","back":"B"},{"kind":"排错","front":"C","back":"D"}]'
    )
    assert [c["kind"] for c in cards] == ["cloze", "debug"]


def test_unknown_kind_falls_back_to_concept():
    cards, _ = parse_cards('[{"kind":"quiz","front":"A","back":"B"}]')
    assert cards[0]["kind"] == "concept"


def test_overlong_card_is_dropped_not_truncated():
    """A truncated answer is a wrong answer; wrong answers poison the queue."""
    raw = (
        '[{"kind":"concept","front":"'
        + "x" * (MAX_FRONT_CHARS + 10)
        + '","back":"B"},'
        + '{"kind":"concept","front":"ok","back":"B"}]'
    )
    cards, dropped = parse_cards(raw)
    assert len(cards) == 1 and dropped == 1


def test_card_count_is_capped():
    raw = "[" + ",".join(
        f'{{"kind":"concept","front":"F{i}","back":"B"}}' for i in range(MAX_CARDS + 8)
    ) + "]"
    cards, _ = parse_cards(raw)
    assert len(cards) == MAX_CARDS


# ---------- material collection (filesystem) ----------


def test_both_or_neither_input_is_rejected():
    with pytest.raises(ValueError):
        collect_material()
    with pytest.raises(ValueError):
        collect_material(source_path="a.md", text="x" * 200)


def test_short_pasted_text_is_rejected():
    with pytest.raises(ValueError):
        collect_material(text="太短了")


def test_pasted_text_returns_no_source():
    source, label, material = collect_material(text="料" * 200)
    assert source == "" and label == "粘贴文本"
    assert material.startswith("料")


@pytest.mark.parametrize("bad", ["../../etc/passwd", "..\\..\\x.md", "/../secrets.md"])
def test_path_escaping_the_vault_is_rejected(bad):
    with pytest.raises(ValueError):
        collect_material(source_path=bad)


def test_missing_vault_file_is_rejected():
    with pytest.raises(ValueError):
        collect_material(source_path="definitely-not-here-9f3a.md")


# ---------- dedup (embedder seam monkeypatched) ----------


def _vec(x: float, y: float) -> list[float]:
    return [x, y]


async def test_near_duplicate_against_existing_is_flagged(monkeypatch):
    async def fake_embed(texts: list[str]) -> list[list[float]]:
        return [_vec(1.0, 0.02) if "新" in t else _vec(1.0, 0.0) for t in texts]

    monkeypatch.setattr(cards_mod, "_embed_texts", fake_embed)
    cards_mod._vec_cache.clear()
    out, ok = await cards_mod.find_duplicates(
        [{"front": "新问题", "back": "B"}], [(7, "老问题")]
    )
    assert ok is True
    assert out[0]["duplicate_of"] == 7
    assert out[0]["similarity"] >= cards_mod.DEDUP_SIMILARITY


async def test_semantically_different_front_is_not_flagged(monkeypatch):
    async def fake_embed(texts: list[str]) -> list[list[float]]:
        return [_vec(0.0, 1.0) if "新" in t else _vec(1.0, 0.0) for t in texts]

    monkeypatch.setattr(cards_mod, "_embed_texts", fake_embed)
    cards_mod._vec_cache.clear()
    out, ok = await cards_mod.find_duplicates(
        [{"front": "新问题", "back": "B"}], [(7, "老问题")]
    )
    assert ok is True and out[0]["duplicate_of"] is None


async def test_exact_duplicate_caught_even_without_embeddings(monkeypatch):
    async def boom(_texts):
        raise RuntimeError("no model")

    monkeypatch.setattr(cards_mod, "_embed_texts", boom)
    cards_mod._vec_cache.clear()
    out, ok = await cards_mod.find_duplicates([{"front": "同一题", "back": "B"}], [(3, "同一题")])
    assert ok is False  # honest: semantic dedup did not run
    assert out[0]["duplicate_of"] == 3


async def test_embedding_failure_never_raises(monkeypatch):
    async def boom(_texts):
        raise RuntimeError("no model")

    monkeypatch.setattr(cards_mod, "_embed_texts", boom)
    cards_mod._vec_cache.clear()
    out, ok = await cards_mod.find_duplicates([{"front": "全新题", "back": "B"}], [(3, "别的题")])
    assert ok is False and out[0]["duplicate_of"] is None


def test_streak_counts_back_from_today_and_survives_yesterday_only():
    from datetime import date, timedelta

    today = date.today()
    days = {(today - timedelta(days=n)).isoformat() for n in (0, 1, 2)}
    assert cards_mod._streak(days) == 3
    assert cards_mod._streak({(today - timedelta(days=1)).isoformat()}) == 1
    assert cards_mod._streak({(today - timedelta(days=3)).isoformat()}) == 0
    assert cards_mod._streak(set()) == 0
