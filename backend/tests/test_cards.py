"""Offline tests for the review-card core: SM-2, prompt composition, JSON parsing.

No LLM, no DB, no clock. `schedule()` returns a seconds offset rather than a
datetime precisely so these can be plain integer assertions.

The external-source tests need real files on disk, so they use a project-local
scratch dir — pytest's `tmp_path` lands under %TEMP%, which is not writable here.
Same pattern as tests/test_dirs.py.
"""
import atexit
import shutil
import sys
import tempfile
from pathlib import Path

import pytest

sys.path.insert(0, ".")

_TMP = Path(tempfile.mkdtemp(prefix="wb-cards-", dir=Path(__file__).parent))
atexit.register(lambda: shutil.rmtree(_TMP, ignore_errors=True))


def _scratch(name: str) -> Path:
    d = _TMP / name
    d.mkdir(parents=True, exist_ok=True)
    return d


from app.core import cards as cards_mod  # noqa: E402
from app.core.cards import (  # noqa: E402
    CLOZE_BLANK,
    CLOZE_MAX_SELECTION,
    GRADUATE_INTERVAL,
    KINDS,
    LEARNING_AGAIN_SEC,
    MAX_CARDS,
    MAX_EASE,
    MAX_FRONT_CHARS,
    MAX_INPUT_CHARS,
    MAX_INTERVAL,
    MIN_EASE,
    PANE_MAX_CHARS,
    SECOND_INTERVAL,
    collect_material,
    compose_gen_prompt,
    fuzz_interval,
    indexer_source_from_spec,
    make_cloze,
    parse_cards,
    schedule,
    spec_from_indexer_source,
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


def test_pane_cap_is_much_larger_than_the_model_budget(monkeypatch):
    # a real source file is routinely longer than a prompt: core/cards.py is 45k
    # chars, so serving the pane at the 15000-char model budget left two thirds of
    # it unselectable — found by actually carding an indexed source file
    from app.core import repos

    root = _scratch("repos-long")
    monkeypatch.setattr(repos, "REPOS_DIR", root)
    (root / "big").mkdir()
    (root / "big" / "long.py").write_text("行" * 40_000, encoding="utf-8")

    _, _, default = collect_material(source_path="repo:big/long.py")
    assert len(default) == MAX_INPUT_CHARS  # generation keeps the prompt budget
    _, _, pane = collect_material(source_path="repo:big/long.py", max_chars=PANE_MAX_CHARS)
    assert len(pane) == 40_000
    assert PANE_MAX_CHARS > MAX_INPUT_CHARS


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


# ---------- external sources (repo: / dir:) ----------


def test_unknown_repo_and_dir_are_rejected_as_such_not_as_vault_paths():
    # the message proves the scheme was recognised rather than lstrip-ed into a
    # vault-relative path, which is the whole point of using an illegal-on-Windows
    # character as the scheme separator
    with pytest.raises(ValueError, match="仓库"):
        collect_material(source_path="repo:nope/x.py")
    with pytest.raises(ValueError, match="目录"):
        collect_material(source_path="dir:nope/x.md")


@pytest.mark.parametrize("bad", ["repo:", "repo:onlyname", "dir:onlyname", "dir:/"])
def test_malformed_external_spec_is_rejected(bad):
    with pytest.raises(ValueError):
        collect_material(source_path=bad)


def test_repo_source_reads_the_file_and_echoes_a_stable_source_id(monkeypatch):
    from app.core import repos

    root = _scratch("repos-happy")
    monkeypatch.setattr(repos, "REPOS_DIR", root)
    (root / "myrepo" / "pkg").mkdir(parents=True)
    (root / "myrepo" / "pkg" / "a.py").write_text("x = 1  # " + "料" * 200, encoding="utf-8")

    source, label, material = collect_material(source_path="repo:myrepo/pkg/a.py")
    assert source == label == "repo:myrepo/pkg/a.py"
    assert material.startswith("x = 1")


def test_repo_path_escaping_its_root_is_rejected(monkeypatch):
    from app.core import repos

    root = _scratch("repos-escape")
    monkeypatch.setattr(repos, "REPOS_DIR", root)
    (root / "myrepo").mkdir()
    (root / "secret.md").write_text("料" * 200, encoding="utf-8")
    with pytest.raises(ValueError):
        collect_material(source_path="repo:myrepo/../secret.md")


def test_oversized_external_file_is_rejected(monkeypatch):
    from app.core import repos

    root = _scratch("repos-big")
    monkeypatch.setattr(repos, "REPOS_DIR", root)
    (root / "big").mkdir()
    (root / "big" / "huge.txt").write_text("x" * (cards_mod.MAX_MATERIAL_BYTES + 10))
    with pytest.raises(ValueError, match="太大"):
        collect_material(source_path="repo:big/huge.txt")


# ---------- indexer source id <-> carding spec ----------


@pytest.mark.parametrize(
    "source,spec",
    [
        ("repos/mylib/pkg/a.py", "repo:mylib/pkg/a.py"),
        ("dirs/docs/guide/intro.md", "dir:docs/guide/intro.md"),
        ("notes/项目笔记.md", "notes/项目笔记.md"),  # vault paths pass through
        ("说明文档.pdf", "说明文档.pdf"),
    ],
)
def test_spec_round_trips_with_the_indexer_source_id(source, spec):
    assert spec_from_indexer_source(source) == spec
    assert indexer_source_from_spec(spec) == source


@pytest.mark.parametrize("bare", ["repos/mylib", "dirs/docs"])
def test_a_bare_namespace_entry_is_not_cardable(bare):
    # "repos/<name>" with no file part is a namespace, not something to card
    assert spec_from_indexer_source(bare) == ""


def test_spec_conversion_is_the_inverse_of_collect_materials_scheme():
    # the two namings must stay in sync: whatever the converter emits has to be
    # something collect_material() recognises as external
    for source in ("repos/x/y.py", "dirs/x/y.md"):
        assert spec_from_indexer_source(source).startswith(cards_mod.EXTERNAL_SCHEMES)


# ---------- 划词挖空（纯字符串，零 LLM） ----------

PARA = "RRF 融合的分数是 1/(k + rank + 1)，k 默认取 60。\n\n下一段无关内容。"


def test_cloze_blanks_the_selection_and_keeps_the_paragraph_as_cue():
    start = PARA.index("60")
    card = make_cloze(PARA, start, start + 2)
    assert card is not None
    assert CLOZE_BLANK in card["front"]
    assert "RRF" in card["front"] and "60" not in card["front"]
    assert card["back"] == "60"
    assert card["kind"] == "cloze" and card["origin"] == "manual"
    # the excerpt keeps the block unblanked, so "where did this come from" is answerable
    assert "60" in card["excerpt"]
    # the next paragraph is a different block and must not leak in
    assert "下一段" not in card["front"]


def test_cloze_keeps_a_fenced_code_block_whole():
    text = "说明文字。\n\n```python\nfor i in range(10):\n    print(i)\n```\n\n后面。"
    start = text.index("range(10)")
    card = make_cloze(text, start, start + len("range(10)"))
    assert card is not None
    assert card["front"].startswith("```python")
    assert "print(i)" in card["front"]  # the rest of the block survived
    assert "说明文字" not in card["front"] and "后面" not in card["front"]


def test_cloze_falls_back_to_the_line_when_the_block_is_too_long():
    line = "配置项 timeout 的默认值是 30 秒。\n"
    text = "填充。" * 300 + "\n" + line + "尾巴。" * 300
    start = text.index("30 秒")
    card = make_cloze(text, start, start + 2)
    assert card is not None
    assert len(card["front"]) <= MAX_FRONT_CHARS
    assert "timeout" in card["front"]
    assert "填充。填充。" not in card["front"]


def test_cloze_window_fallback_always_fits_the_front_cap():
    text = "词" * 5000  # one enormous line, no blank lines anywhere
    card = make_cloze(text, 2500, 2600)
    assert card is not None
    assert len(card["front"]) <= MAX_FRONT_CHARS


def test_cloze_refuses_when_blanking_leaves_no_cue():
    # selecting the entire paragraph leaves a front that is just "____"
    text = "短短一句话。\n\n别的。"
    assert make_cloze(text, 0, len("短短一句话。")) is None


@pytest.mark.parametrize(
    "start,end",
    [(0, 0), (5, 3), (-1, 4), (0, 10_000)],
)
def test_cloze_rejects_degenerate_spans(start, end):
    assert make_cloze("一二三四五六七八九十", start, end) is None


def test_cloze_rejects_whitespace_only_and_overlong_selections():
    text = "前面的内容够长够长够长。   后面的内容也够长够长够长。"
    ws = text.index("   ")
    assert make_cloze(text, ws, ws + 3) is None
    long_text = "垫" * 50 + "答" * (CLOZE_MAX_SELECTION + 1) + "垫" * 50
    assert make_cloze(long_text, 50, 50 + CLOZE_MAX_SELECTION + 1) is None


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
