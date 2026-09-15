"""提示词对照台（Q1）的离线测试：Wilson 区间、断言、golden set 结构、一次跑分。

**一次模型都不调**：`check()` 的模型调用是依赖注入的（`generate=`），测试塞一个假的进去。
真正花钱的那次跑留在浏览器验收那一轮，并如实报成本。

这里另有一组**结构测试**（fixture 的 key 必须在登记表里、断言名必须存在、why 不许空），
它们的作用和 `test_prompts.py` 的指纹一样：让「以后加一条用例时手滑」当场变红。
"""
import asyncio
import json
import sys

import pytest

sys.path.insert(0, ".")

from app.core import prompt_eval as pe  # noqa: E402
from app.core import prompts  # noqa: E402
from app.db import engine  # noqa: E402
from app.models import Base  # noqa: E402


async def _init_db() -> None:
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)


asyncio.run(_init_db())


# --- Wilson 区间：报告的硬要求 -------------------------------------------------


def test_wilson_matches_a_known_value():
    """8/8 的 95% Wilson 下界是 0.68 左右——这正是「全过也说明不了太多」的那件事。"""
    lo, hi = pe.wilson(8, 8)
    assert 0.6 < lo < 0.72
    assert hi == 1.0


def test_wilson_is_symmetric():
    """k 与 n-k 的区间互为镜像——写错公式最容易在这里露出来。"""
    lo, hi = pe.wilson(3, 10)
    lo2, hi2 = pe.wilson(7, 10)
    assert lo == pytest.approx(1 - hi2, abs=1e-9)
    assert hi == pytest.approx(1 - lo2, abs=1e-9)


def test_wilson_of_nothing_is_everything():
    assert pe.wilson(0, 0) == (0.0, 1.0)


def test_wilson_stays_inside_zero_one():
    for k in range(0, 11):
        lo, hi = pe.wilson(k, 10)
        assert 0.0 <= lo <= hi <= 1.0


def test_can_tell_needs_a_narrow_interval():
    """n=8 全过：区间宽 0.32，还下不了结论；n=40 全过：够了。"""
    assert pe.can_tell(*pe.wilson(8, 8)) is True  # 0.676–1.0，宽 0.324 ≤ 0.34
    assert pe.can_tell(*pe.wilson(3, 8)) is False  # 宽得多
    assert pe.can_tell(*pe.wilson(40, 40)) is True


# --- 断言 ---------------------------------------------------------------------


def test_every_check_says_which_sentence_it_comes_from():
    """加了断言却说不清它对应提示词的哪句话 = 那是「我觉得」，不是「它承诺过」。"""
    for name, (fn, why) in pe.CHECKS.items():
        assert callable(fn)
        assert len(why.strip()) >= 8, name


def test_run_checks_reports_the_failing_ones_with_reasons():
    ok, failed = pe.run_checks("事件循环是什么？", ["asks_a_question", "one_question_only"])
    assert ok is True and failed == []

    ok, failed = pe.run_checks("很好的解释！事件循环是什么？为什么这样？还有别的吗？", ["one_question_only", "no_flattery"])
    assert ok is False
    assert {f["name"] for f in failed} == {"one_question_only", "no_flattery"}
    assert all(f["why"] for f in failed)


def test_an_unknown_check_name_fails_loudly():
    """fixture 里写错一个断言名，不许静默算过——那等于这条用例没在测东西。"""
    ok, failed = pe.run_checks("这是问题吗？", ["asks_a_question", "typo_check"])
    assert ok is False
    assert [f["name"] for f in failed] == ["typo_check"]
    assert "未知断言名" in failed[0]["why"]


def test_a_list_is_a_list():
    assert pe.run_checks("1. 先讲调度\n2. 再讲 await", ["no_list"])[0] is False
    assert pe.run_checks("- 调度\n- await", ["no_list"])[0] is False
    assert pe.run_checks("那 await 让出去的那一下，谁记着这个函数？", ["no_list"])[0] is True


def test_concise_has_a_boundary():
    assert pe.run_checks("短" * pe.MAX_CHARS, ["concise"])[0] is True
    assert pe.run_checks("长" * (pe.MAX_CHARS + 1), ["concise"])[0] is False


def test_half_width_question_marks_count():
    assert pe.run_checks("Why is that?", ["one_question_only"])[0] is True


# --- golden set 的结构：加了用例却不接线，当场红 ---------------------------------


def test_fixtures_index_by_their_own_key():
    fx = pe.fixtures()
    assert "FEYNMAN_PROMPT" in fx
    assert fx["FEYNMAN_PROMPT"]["file"] == "feynman.json"


def test_every_fixture_points_at_a_registered_prompt():
    """golden set 的 key 必须在 `_SPECS` 里，且 module 对得上——否则跑分对象是空气。"""
    known = {p.name: p.module for p in prompts.inventory()}
    for key, fx in pe.fixtures().items():
        assert key in known, f"{key} 不在登记表里"
        assert (fx.get("module") or known[key]) == known[key], f"{key} 的 module 写错了"


def test_every_fixture_case_declares_only_real_checks():
    for key, fx in pe.fixtures().items():
        ids = [c["id"] for c in fx["cases"]]
        assert len(ids) == len(set(ids)), f"{key} 里有重复的用例 id"
        for c in fx["cases"]:
            assert c.get("user"), f"{key}/{c.get('id')} 没有 user 输入"
            assert c.get("checks"), f"{key}/{c.get('id')} 一条断言都没有"
            unknown = [n for n in c["checks"] if n not in pe.CHECKS]
            assert not unknown, f"{key}/{c.get('id')} 有未知断言 {unknown}"


def test_every_check_is_used_by_at_least_one_case():
    """写了断言却没人用 = 死代码；顺便提醒：加断言时要给它配一条用例。"""
    used = {n for fx in pe.fixtures().values() for c in fx["cases"] for n in c["checks"]}
    assert set(pe.CHECKS) - used == set(), f"没用上的断言：{set(pe.CHECKS) - used}"


# --- 一次跑分（注入假模型，零调用）--------------------------------------------


def _gen(reply="那 await 让出去以后，谁记着这个函数？"):
    calls = []

    async def fake(model_id, messages):
        calls.append(messages)
        return reply

    fake.calls = calls
    return fake


def test_check_of_a_registered_prompt_reports_and_persists():
    fake = _gen()
    rep = asyncio.run(pe.check("FEYNMAN_PROMPT", model_id="fake/model", generate=fake))

    assert rep["key"] == "FEYNMAN_PROMPT"
    assert rep["variant_sha"] == ""
    assert rep["total"] == len(pe.cases_for("FEYNMAN_PROMPT")["cases"]) == rep["calls"]
    assert len(fake.calls) == rep["total"]
    assert rep["rate"] == round(rep["passed"] / rep["total"], 3)
    assert 0.0 <= rep["ci"][0] <= rep["ci"][1] <= 1.0
    assert rep["assertions"]["total"] > rep["total"]  # 每条用例不止一条断言
    assert rep["context"].startswith("空上下文")
    assert isinstance(rep["tell"], bool)
    assert rep["run_id"] > 0

    # 落了库，而且能查回来
    hist = asyncio.run(pe.history("FEYNMAN_PROMPT"))
    assert hist and hist[0]["id"] == rep["run_id"]
    detail = json.loads(hist[0]["detail_json"])
    assert len(detail["cases"]) == rep["total"]


def test_check_replays_through_the_products_own_message_builder():
    """重放必须走 tutor 自己那条路（同 build_messages），否则测的是另一个产品。"""
    fake = _gen()
    asyncio.run(pe.check("FEYNMAN_PROMPT", model_id="fake/model", generate=fake))
    first = fake.calls[0]
    assert first[0]["role"] == "system"
    # 费曼提示词在 system 里（voice 是第一块）
    from app.core.tutor import FEYNMAN_PROMPT

    assert first[0]["content"] == FEYNMAN_PROMPT
    # 空上下文：只有 voice + 用户那一句，没有召回/材料/画像块
    assert len(first) == 2
    assert first[1]["role"] == "user"


def test_a_variant_run_is_not_the_baseline():
    """候选变体不能把自己跑成基准——否则「变好还是变坏」整个失去意义。"""
    good = _gen()
    base_rep = asyncio.run(pe.check("FEYNMAN_PROMPT", model_id="fake/model", generate=good))
    # 极简版换成「列清单」的回复：no_list 这条断言必然翻面
    rep = asyncio.run(
        pe.check(
            "FEYNMAN_PROMPT",
            variant="你是考官。反问。",
            variant_label="试：极简版",
            model_id="fake/model",
            generate=_gen("1. 先讲调度\n2. 再讲 await"),
        )
    )
    assert rep["variant_sha"] and rep["variant_label"] == "试：极简版"
    assert rep["baseline"] is not None  # 有基准可比
    assert rep["passed"] < base_rep["passed"]  # 变差了，而且看得见
    assert any(f["now"] is False for f in rep["flips"])

    base = asyncio.run(pe.baseline("FEYNMAN_PROMPT", model_id="fake/model"))
    assert base["variant_sha"] == ""  # 基准仍是登记内容那一跑
    assert base["id"] != rep["run_id"]


def test_the_registered_content_is_never_written_back():
    """护栏的硬边界：跑分只读登记表，**从不写回内容**。

    这条用一个连 `content` 都想改的假生成器试不出来，所以换个做法：跑完之后登记表的
    指纹与内容必须一字不差。"""
    before = [(p.name, p.sha, p.content) for p in prompts.inventory()]
    asyncio.run(
        pe.check(
            "FEYNMAN_PROMPT",
            variant="完全另一段候选文本",
            variant_label="不该被采纳",
            model_id="fake/model",
            generate=_gen(),
        )
    )
    after = [(p.name, p.sha, p.content) for p in prompts.inventory()]
    assert before == after


def test_a_generation_error_fails_that_case_not_the_run():
    async def boom(model_id, messages):
        raise RuntimeError("provider 挂了")

    rep = asyncio.run(pe.check("FEYNMAN_PROMPT", model_id="fake/model", generate=boom))
    assert rep["passed"] == 0
    assert all(c["error"] for c in rep["cases"])
    assert rep["total"] == rep["calls"]


def test_unknown_key_and_missing_fixture_are_told_apart():
    with pytest.raises(ValueError, match="登记表里没有"):
        asyncio.run(pe.check("NO_SUCH_PROMPT", generate=_gen()))
    # 登记表里有，但还没有 golden set —— 报的是另一句话
    with pytest.raises(ValueError, match="还没有 golden set"):
        asyncio.run(pe.check("CHAT_SYSTEM", generate=_gen()))


def test_empty_variant_is_rejected():
    with pytest.raises(ValueError, match="候选内容是空的"):
        asyncio.run(pe.check("FEYNMAN_PROMPT", variant="   ", generate=_gen()))


def test_flips_compares_case_by_case():
    now = [{"id": "a", "passed": True}, {"id": "b", "passed": False}, {"id": "c", "passed": True}]
    before = {"detail_json": json.dumps([{"id": "a", "passed": False}, {"id": "b", "passed": False}])}
    assert pe._flips(now, before) == [{"id": "a", "was": False, "now": True}]
    assert pe._flips(now, None) == []
    assert pe._flips(now, {"detail_json": "不是 JSON"}) == []


def test_case_states_reads_both_shapes():
    """本模块写的是 `{"variant_text", "cases"}`，引擎那套是裸列表。

    第一版只认后者，于是 `_flips` 永远返回空——**「和基准比」静默地什么都没比**。
    这个 bug 是 `test_a_variant_run_is_not_the_baseline` 逮住的，这条把两种形状都钉住。
    """
    as_dict = json.dumps({"variant_text": "x", "cases": [{"id": "a", "passed": True}]})
    as_list = json.dumps([{"id": "a", "passed": True}])
    assert pe._case_states(as_dict) == {"a": True}
    assert pe._case_states(as_list) == {"a": True}
    assert pe._case_states("") == {}
    assert pe._case_states('{"cases": "不是列表"}') == {}
    assert pe._case_states(json.dumps([{"passed": True}, "怪东西"])) == {}


def test_history_is_newest_first_and_capped():
    for _ in range(3):
        asyncio.run(pe.check("FEYNMAN_PROMPT", model_id="fake/model", generate=_gen()))
    hist = asyncio.run(pe.history("FEYNMAN_PROMPT", limit=2))
    assert len(hist) == 2
    assert hist[0]["id"] > hist[1]["id"]


def test_check_names_are_exposed_for_the_ui():
    names = {c["name"] for c in pe.check_names()}
    assert names == set(pe.CHECKS)
    assert all(c["why"] for c in pe.check_names())


def test_the_new_table_is_created_by_create_all_not_by_an_alter():
    """新表由 `create_all` 建（`main.py` 的 lifespan 就是这条路），不用碰那个 ALTER 列表。

    证据不是「表名对」——是前面那些用例真的把行写进去了并且能查回来。
    """
    from app.models import PromptEvalRun

    assert PromptEvalRun.__tablename__ == "prompt_eval_runs"
    assert asyncio.run(pe.history("FEYNMAN_PROMPT", limit=1)), "前面跑的分应该落在这张表里"
