"""引用验证（P3）的测试：哪些编号算编造、剥的时候一个字不许多吃。

这一层最贵的两种错法是**反的**：漏剥留一个假指针（用户点不开、看不见），误剥吃掉一句
真话（用户一样看不出来）。所以下面两组用例是分开钉的——`verify` 那半边钉「认不认得出来」，
`strip_fake` 那半边钉「有没有多吃」。

判据只有 `core/citations.py` 一处，线上（`routers/chat.py`）与离线（`core/turn_eval.py`）
都调它；这个文件是它的单测，`smoke_citations.py` 是同一批用例的尺子。
"""
import sys

sys.path.insert(0, ".")

from app.core import citations  # noqa: E402


# ---------- verify：认得出来吗 ----------


def test_in_range_numbers_are_real_citations():
    rep = citations.verify("阈值是 0.62[来源 3]，另外[来源 5]也提过。", 5)
    assert rep.cited == (3, 5)
    assert rep.fake == ()
    assert rep.ok
    assert rep.sources_cited == 2
    assert rep.reason == ""


def test_a_number_past_the_list_is_fabricated():
    """这一轮只注入了 5 条，写 [来源 7] 就是编的 —— 用户点开什么都没有。"""
    rep = citations.verify("这一条来自更早的讨论[来源 7]。", 5)
    assert rep.fake == (7,)
    assert not rep.ok
    assert "7" in rep.reason and "5" in rep.reason


def test_zero_is_never_a_source():
    """编号是 `enumerate(sources, 1)` 发的，从 1 起 —— 0 与负数都不是合法引用。"""
    assert citations.verify("见[来源 0]。", 5).fake == (0,)


def test_nothing_injected_means_every_marker_is_fabricated():
    """**这一条是有代价的取舍**（写死在模块开头）：没检索的那一轮，正文里任何 `[来源 N]`
    都按编造处理 —— 它跨轮引用上一轮的编号时会被一起剥掉。方向照 `channel.py`：
    假指针比少个角标贵。"""
    rep = citations.verify("材料里写着[来源 1]。", 0)
    assert rep.fake == (1,) and rep.cited == ()


def test_the_numbers_are_deduped_in_order_of_first_appearance():
    rep = citations.verify("[来源 5]…[来源 2]…[来源 5]", 5)
    assert rep.cited == (5, 2)
    assert rep.markers == 3, "标次数要数总次数（含重复），去重的是编号列表"


def test_a_broken_upper_bound_does_not_explode():
    """`injected` 是外部传进来的（`len(sources)`）—— 传了 None / 负数也得给个结论。"""
    assert citations.verify("[来源 1]", None).fake == (1,)
    assert citations.verify("[来源 1]", -3).fake == (1,)
    assert citations.verify("", 5).markers == 0


def test_lookalikes_are_not_citations():
    """**匹配写窄是刻意的**：这几种都不是本产品的标记，一个字都不该动。
    宽匹配吃掉的是真话 —— 比漏一个假编号贵（模块开头那句）。"""
    for text in ("[来源 N]", "[资料来源 3]", "[来源 七]", "[来源 1-2]", "【来源 7】", "见来源 3"):
        rep = citations.verify(text, 5)
        assert rep.markers == 0 and rep.fake == () and rep.cited == (), text
        clean, removed = citations.strip_fake(text, 5)
        assert clean == text and removed == [], text


def test_spacing_inside_the_brackets_is_tolerated():
    """模型常写成 `[来源1]` / `[ 来源 2 ]` —— 它确实是那个引用，得认。"""
    assert citations.verify("见[来源1]与[ 来源 2 ]", 2).cited == (1, 2)


# ---------- strip_fake：有没有多吃 ----------


def test_stripping_only_removes_the_fabricated_marker():
    clean, removed = citations.strip_fake("结论就是这样[来源 4]，别的没错。", 2)
    assert clean == "结论就是这样，别的没错。"
    assert removed == [4]


def test_real_citations_survive_next_to_a_fabricated_one():
    """同一句里一半真一半假：真的留着，假的拿走。"""
    clean, removed = citations.strip_fake("时区错是周一修的[来源 1]，另外[来源 9]也提过。", 5)
    assert clean == "时区错是周一修的[来源 1]，另外也提过。"
    assert removed == [9]
    assert citations.verify(clean, 5).cited == (1,)


def test_the_space_left_behind_by_a_removal_is_collected():
    """`"先结论 [来源 7] 后文"` 删完会剩两个连续空格 —— 那是**我们这次删除的痕迹**，
    不是用户的原文，收成一个。**只收空格，不动标点**（空括号、被删空的一行都留着）。"""
    assert citations.strip_fake("先给结论 [来源 7] 再说细节。", 1)[0] == "先给结论 再说细节。"
    assert citations.strip_fake("（[来源 7]）", 0)[0] == "（）"


def test_stripping_is_idempotent_and_never_touches_clean_text():
    """幂等：补跑那一轮会再验一遍（`chat` 里就是这么走的），第二遍不许再改一个字。"""
    clean, _ = citations.strip_fake("先给结论 [来源 7] 再说细节。", 1)
    again, removed = citations.strip_fake(clean, 1)
    assert again == clean and removed == []
    untouched = "一句完全正常的话，一个标记都没有。"
    assert citations.strip_fake(untouched, 0) == (untouched, [])


def test_a_reply_that_is_nothing_but_a_fake_marker_becomes_empty():
    assert citations.strip_fake("[来源 7]", 0) == ("", [7])


def test_duplicate_fakes_are_only_counted_once():
    """拿掉的是**标记**（两个都拿），记的是**编号**（一个，去重）。"""
    clean, removed = citations.strip_fake("[来源 9]…[来源 9]", 3)
    assert clean == "…" and removed == [9]


# ---------- 进账本的形状 ----------


def test_the_report_serialises_to_plain_facts():
    """`quality_json` 里存的是事实，不是分数（W5 账本那条红线）。"""
    rep = citations.verify("[来源 2] 与 [来源 8]", 5)
    assert rep.as_dict() == {"injected": 5, "markers": 2, "cited": [2], "fake": [8]}
    # json.dumps 能直接吃（`turn_trace._write` 就是这么落库的）
    import json

    assert json.loads(json.dumps(rep.as_dict()))["fake"] == [8]


def test_an_empty_reply_is_a_clean_sheet():
    rep = citations.verify("", 5)
    assert rep.ok and rep.sources_cited == 0 and rep.markers == 0
