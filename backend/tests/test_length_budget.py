"""W4 的字数判据（`core/length_budget.py`）—— 逐条钉住，并把「不许猜」也钉住。

这一层要守的是**它什么时候必须说「不认得」**：

- 认不出预算时返回 `None`，绝不猜。猜错的两个方向都比「不认」差：把闲聊按 300 字裁剪，
  或者给一句本来没约束的话加上约束（模型会为了满足一个不存在的预算多存一版，正是要治的病）。
- 「左右」与「不超过」不是同一件事：300 字左右写到 359 不算超，300 字以内写到 301 就算。
- 字数怎么数只有一份实现（与 `answer_chars`、回执里报的数同一个算法）。
"""
import sys

sys.path.insert(0, ".")

from app.core import length_budget as lb  # noqa: E402


# ---------- 怎么数 ----------


def test_count_strips_first():
    assert lb.count("  三百字  ") == 3
    assert lb.count("") == 0
    assert lb.count(None) == 0


def test_count_is_the_same_algorithm_as_answer_chars():
    """账本里的 `answer_chars` 就是 `len(content.strip())`；两个数不一样就是个坑。"""
    from app.routers.chat import _record_turn  # noqa: F401 - 只是提醒这条缝的存在

    text = "本周做了三件事。\n" * 10
    assert lb.count(text) == len(text.strip())


# ---------- 认预算 ----------


def test_arabic_and_chinese_numbers():
    cases = [
        ("把东西整理成一份 300 字左右的周报，存进产出。", 300, False),
        ("写一篇三百字左右的项目复盘。", 300, False),
        ("整理成一份给领导看的三百字周报。", 300, False),
        ("不超过 500 字。", 500, True),
        ("500 字以内。", 500, True),
        ("写一篇八百字左右的复盘。", 800, False),
        ("大概 1200 字的调研。", 1200, False),
        ("一千二百字左右。", 1200, False),
        ("不得超过 200 字。", 200, True),
        ("约 80 字。", 80, False),
    ]
    for ask, chars, hard in cases:
        b = lb.parse_budget(ask)
        assert b is not None, ask
        assert (b.chars, b.hard) == (chars, hard), ask


def test_no_budget_means_none_not_a_guess():
    for ask in (
        "用两句话讲一下数据库索引为什么能让查询变快。",
        "帮我看看这段代码。",
        "把本周进展整理成一份周报，存进产出。",
        "",
    ):
        assert lb.parse_budget(ask) is None, ask


def test_absurd_numbers_are_not_budgets():
    """「两个字」是词不是预算；「十万字」是小说的活儿 —— 都不是这个产品的长度约束。"""
    assert lb.parse_budget("这两个字不要写错。") is None
    assert lb.parse_budget("我要写一部 90000 字的小说。") is None
    assert lb.parse_budget("写 5 字。") is None


def test_the_first_number_wins_and_that_is_declared():
    """一句话里有两个字数时取第一个。歧义如实写在这里，不装作用户永远只说一个数。"""
    b = lb.parse_budget("先写八百字，再删到三百字。")
    assert b is not None and b.chars == 800


def test_a_bare_number_is_a_soft_target_not_a_hard_limit():
    """只说「三百字的周报」= 目标 300 字，不是「多一个字都不行」。

    这条判据要拦的是「模型为凑字数反复重写」，不是替用户挑刺 —— 把一个正常的 320 字周报
    报成「超了」，用户下次就不看这个标签了。
    """
    b = lb.parse_budget("整理成一份给领导看的三百字周报。")
    assert b is not None and b.hard is False and b.chars == 300


def test_hard_wins_when_both_markers_are_present():
    b = lb.parse_budget("不超过 300 字左右。")
    assert b is not None and b.hard is True


def test_the_phrase_is_kept_for_humans():
    b = lb.parse_budget("写一篇八百字左右的复盘")
    assert b is not None and b.phrase in ("八百字", "八百 字") or b.phrase == "八百字"


# ---------- 超没超 ----------


def test_soft_budget_tolerates_twenty_percent():
    b = lb.parse_budget("300 字左右")
    assert b is not None
    assert lb.verdict("好" * 359, b)["over"] is False  # 359 ≤ 360
    assert lb.verdict("好" * 361, b)["over"] is True
    assert lb.verdict("好" * 361, b)["over_by"] == 61


def test_hard_budget_has_no_tolerance():
    b = lb.parse_budget("不超过 300 字")
    assert b is not None
    assert lb.verdict("好" * 300, b)["over"] is False
    assert lb.verdict("好" * 301, b)["over"] is True
    assert lb.verdict("好" * 301, b)["over_by"] == 1


def test_no_budget_is_reported_as_no_budget():
    v = lb.verdict("好" * 9000, None)
    assert v["over"] is False and v["budget"] is None and v["chars"] == 9000


def test_describe_says_nothing_when_there_is_no_budget():
    assert lb.describe(None) == ""
    b = lb.parse_budget("不超过 500 字")
    assert b is not None and lb.describe(b) == "预算 500 字不超过"
