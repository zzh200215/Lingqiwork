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
    """两种形状各查各的：聊天型要有输入与断言；**判分型**（P2-1）要有卡三样 + 人工档位，
    它的判据是人工档位而不是断言——硬按聊天那份查，会把一整套判分用例判成不合格。"""
    for key, fx in pe.fixtures().items():
        ids = [c["id"] for c in fx["cases"]]
        assert len(ids) == len(set(ids)), f"{key} 里有重复的用例 id"
        if pe.is_grading(key):
            for c in fx["cases"]:
                assert c.get("front") and c.get("retell"), f"{key}/{c.get('id')} 缺卡三样或重讲"
                assert int(c.get("grade")) in (0, 1, 2, 3, 4), f"{key}/{c.get('id')} 档位不合法"
                assert c.get("intent"), f"{key}/{c.get('id')} 没写为什么是这一档"
            continue
        for c in fx["cases"]:
            assert c.get("user"), f"{key}/{c.get('id')} 没有 user 输入"
            assert c.get("checks"), f"{key}/{c.get('id')} 一条断言都没有"
            unknown = [n for n in c["checks"] if n not in pe.CHECKS]
            assert not unknown, f"{key}/{c.get('id')} 有未知断言 {unknown}"


def test_every_check_is_used_by_at_least_one_case():
    """写了断言却没人用 = 死代码；顺便提醒：加断言时要给它配一条用例。

    只数**聊天型**的用例：判分型的用例没有 `checks` 这个字段（它的判据是人工档位）。
    """
    used = {
        n
        for key, fx in pe.fixtures().items()
        if not pe.is_grading(key)
        for c in fx["cases"]
        for n in (c.get("checks") or [])
    }
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


def test_run_times_are_stamped_utc_for_the_browser():
    """`at` 必须带偏移。

    这一列是 `utcnow()` 写的、SQLite 往返之后是 naive；直接 `isoformat()` 给浏览器，
    `new Date(...)` 会当**本地时间**读——UTC+8 下刚跑完的一次会显示成「8 小时前」。
    小屋的技能卡第一版就是这么错的（和 P1 那个 `pet.status()` 的时区错同一个病）。
    """
    rep = asyncio.run(pe.check("FEYNMAN_PROMPT", model_id="tz/model", generate=_gen()))
    hist = asyncio.run(pe.history("FEYNMAN_PROMPT", limit=1))
    assert hist[0]["id"] == rep["run_id"]
    at = hist[0]["at"]
    assert at.endswith("+00:00"), f"at 没有时区：{at}"
    from datetime import datetime, timezone

    parsed = datetime.fromisoformat(at)
    assert parsed.tzinfo is not None
    # 与「现在」比，应该就在几十秒内（而不是差一个时区偏移）
    drift = abs((datetime.now(timezone.utc) - parsed).total_seconds())
    assert drift < 120, f"at 与现在差了 {drift:.0f} 秒，多半是时区错"


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


# --- 喂食：把一次事故变成一条用例（写的是 golden set 文件，不是提示词）-------------


@pytest.fixture()
def _restore_fixture():
    """用例文件会被改：每个用例跑完把原文写回去。

    这一组测的**就是**写文件，所以得自己收拾干净——不还原的话，`feynman.json` 会在跑测试
    的过程中慢慢长出垃圾用例。原文存一份、跑完盖回去，比事后手工清理可靠。
    """
    path = pe.FIXTURE_DIR / "feynman.json"
    original = path.read_text(encoding="utf-8")
    yield path
    path.write_text(original, encoding="utf-8")


def test_the_fixture_on_disk_is_canonical(_restore_fixture):
    """磁盘上的 golden set 必须是规范格式。

    理由很实际：从界面喂进来的用例走 `_canonical()` 写整份文件；手写的文件若不是规范格式，
    每喂一条就整篇重排，diff 就没法看了。
    """
    text = _restore_fixture.read_text(encoding="utf-8")
    assert pe.canonical_ok(text, json.loads(text)), "feynman.json 不是规范格式"
    assert text.endswith("\n")


def test_add_case_writes_it_into_the_golden_set(_restore_fixture):
    before = len(pe.cases_for("FEYNMAN_PROMPT")["cases"])
    new = pe.add_case(
        "FEYNMAN_PROMPT",
        user="事件循环就是把所有协程塞进一个线程里串着跑。",
        intent="它该指出「串着跑」和「等的时候让出去」是两回事",
        checks=["asks_a_question", "no_list"],
    )
    after = pe.cases_for("FEYNMAN_PROMPT")
    assert len(after["cases"]) == before + 1
    assert [c["id"] for c in after["cases"]][-1] == new["id"]
    assert new["checks"] == ["asks_a_question", "no_list"]
    text = _restore_fixture.read_text(encoding="utf-8")
    assert pe.canonical_ok(text, json.loads(text))  # 仍是规范格式，下次追加不会重排
    # 直接能跑：新用例带着自己的断言进了对照
    rep = asyncio.run(pe.check("FEYNMAN_PROMPT", model_id="fake/model", generate=_gen()))
    assert any(c["id"] == new["id"] for c in rep["cases"])
    assert rep["total"] == before + 1


def test_add_case_refuses_a_case_nobody_can_judge(_restore_fixture):
    """三样缺一不可：真实输入、它当时应该怎样、至少一条断言。"""
    with pytest.raises(ValueError, match="真实输入"):
        pe.add_case("FEYNMAN_PROMPT", user="  ", intent="x", checks=["no_list"])
    with pytest.raises(ValueError, match="它当时应该怎样"):
        pe.add_case("FEYNMAN_PROMPT", user="输入", intent="", checks=["no_list"])
    with pytest.raises(ValueError, match="至少勾一条断言"):
        pe.add_case("FEYNMAN_PROMPT", user="输入", intent="意图", checks=[])
    with pytest.raises(ValueError, match="未知断言"):
        pe.add_case("FEYNMAN_PROMPT", user="输入", intent="意图", checks=["no_such_check"])
    with pytest.raises(ValueError, match="还没有 golden set"):
        pe.add_case("CHAT_SYSTEM", user="输入", intent="意图", checks=["no_list"])


def test_add_case_never_overwrites_an_existing_id(_restore_fixture):
    first = pe.add_case(
        "FEYNMAN_PROMPT", user="同一个输入", intent="第一次", checks=["no_list"], case_id="dup"
    )
    second = pe.add_case(
        "FEYNMAN_PROMPT", user="同一个输入", intent="第二次", checks=["no_list"], case_id="dup"
    )
    assert first["id"] == "dup"
    assert second["id"] == "dup-2"  # 不顶掉已有的那条
    ids = [c["id"] for c in pe.cases_for("FEYNMAN_PROMPT")["cases"]]
    assert ids.count("dup") == 1 and "dup-2" in ids


def test_remove_case_takes_it_back_out(_restore_fixture):
    before = len(pe.cases_for("FEYNMAN_PROMPT")["cases"])
    out = pe.remove_case("FEYNMAN_PROMPT", "vague-analogy")
    assert out == {"key": "FEYNMAN_PROMPT", "removed": "vague-analogy", "left": before - 1}
    assert "vague-analogy" not in [c["id"] for c in pe.cases_for("FEYNMAN_PROMPT")["cases"]]
    with pytest.raises(ValueError, match="没有这条用例"):
        pe.remove_case("FEYNMAN_PROMPT", "vague-analogy")


def test_remove_case_refuses_to_empty_the_set(_restore_fixture):
    ids = [c["id"] for c in pe.cases_for("FEYNMAN_PROMPT")["cases"]]
    for cid in ids[:-1]:
        pe.remove_case("FEYNMAN_PROMPT", cid)
    with pytest.raises(ValueError, match="最后一条"):
        pe.remove_case("FEYNMAN_PROMPT", ids[-1])


def test_feeding_cases_never_touches_the_prompt_itself(_restore_fixture):
    """喂食改的是**用例**——提示词一个字节都不动（这条是这一整个模块的护栏）。"""
    before = [(p.name, p.sha, p.content) for p in prompts.inventory()]
    pe.add_case("FEYNMAN_PROMPT", user="新的输入", intent="新的意图", checks=["no_list"])
    pe.remove_case("FEYNMAN_PROMPT", "vague-analogy")
    assert [(p.name, p.sha, p.content) for p in prompts.inventory()] == before


# --- 领域：形态（Q3）的分组键，写 golden set 里 ---------------------------------


def test_feynman_declares_a_domain():
    """形态的第三个数按 golden set 的 `domain` 找卡——没标就等于这个领域没有技能。

    所以这条不是格式检查，是**那条枝能不能长出来**的前提。
    """
    assert pe.fixtures()["FEYNMAN_PROMPT"]["domain"] != ""


def test_set_domain_writes_it_canonically(_restore_fixture):
    out = pe.set_domain("FEYNMAN_PROMPT", "教学")
    assert out == {"key": "FEYNMAN_PROMPT", "domain": "教学"}
    assert pe.fixtures()["FEYNMAN_PROMPT"]["domain"] == "教学"
    text = _restore_fixture.read_text(encoding="utf-8")
    assert pe.canonical_ok(text, json.loads(text))  # 仍是规范格式
    # 用例一条都没动：改的是标签，不是集合
    assert json.loads(text)["cases"] == pe.cases_for("FEYNMAN_PROMPT")["cases"]


def test_set_domain_normalizes_and_never_touches_the_prompt(_restore_fixture):
    before = [(p.name, p.sha, p.content) for p in prompts.inventory()]
    assert pe.set_domain("FEYNMAN_PROMPT", "  法律  ")["domain"] == "法律"
    assert len(pe.set_domain("FEYNMAN_PROMPT", "x" * 99)["domain"]) == 30
    assert pe.set_domain("FEYNMAN_PROMPT", "")["domain"] == ""  # 空 = 还没归类，合法
    assert [(p.name, p.sha, p.content) for p in prompts.inventory()] == before
    with pytest.raises(ValueError, match="还没有 golden set"):
        pe.set_domain("CHAT_SYSTEM", "教学")


def test_a_bad_domain_shape_reads_as_unclassified():
    """文件里把 domain 写成 null / 列表 / 数字都当空字符串。

    它是分组用的标签：一种坏写法不该让整套 golden set 读不出来（那会把技能卡一起弄没）。
    """
    path = pe.FIXTURE_DIR / "zz-domain-shape-probe.json"
    path.write_text(
        json.dumps({"key": "ZZ_PROBE", "domain": ["法律"], "cases": []}, ensure_ascii=False),
        encoding="utf-8",
    )
    try:
        assert pe.fixtures()["ZZ_PROBE"]["domain"] == ""
    finally:
        path.unlink()


def test_cards_carry_the_golden_set_domain():
    asyncio.run(pe.check("FEYNMAN_PROMPT", model_id="card/model", generate=_gen()))
    card = asyncio.run(pe.cards())[0]
    assert card["domain"] == pe.fixtures()["FEYNMAN_PROMPT"]["domain"]


# --- one_question_only：尺子与样本在 backend/smoke_question.py -----------------


def test_question_count_merges_an_option_menu():
    """「一个问题 + 一串选项」是**一个**问题 —— 这是当初记下来的那个缺陷。

    原来那条（数问号）在这里数出 4 个，把一次合格的回复判成失败。
    """
    assert pe.question_count("你想听我讲什么？…比如——注意力机制？梯度下降？Transformer架构？") == 1
    assert pe.question_count("你想先听哪一块？比如——索引的结构？B+ 树的分裂？还是查询优化？") == 1


def test_question_count_counts_a_blank_line_as_a_new_question():
    """「三个独立问题分三段抛出」是实测形状 —— 空行比标点可靠。"""
    assert pe.question_count("他说的调度是指什么？\n\n那个队列里排的是什么？\n\n谁来决定下一个跑谁？") == 3


def test_question_count_is_not_fooled_by_a_short_question():
    """**光看长度分不开「短选项」和「短问题」**（「B+ 树的分裂」 vs 「为什么」）。

    这一条就是那个区分：短的、又不含疑问词的，才是选项。少了这层，
    「然后呢？为什么？怎么办？」会被并成一个问题 —— 那是拿一个错换另一个错。
    """
    assert pe.question_count("然后呢？为什么？怎么办？") == 3
    assert pe.question_count("你说 await 让出去——让给谁？那个线程去哪了？事件循环怎么调度？") == 3


def test_question_count_ignores_a_question_mark_in_quotes():
    """引号里的问号不是这一轮在问。"""
    assert pe.question_count("你说「什么是闭包？」这个问题问反了。") == 0
    assert pe.question_count("我讲讲我的理解。") == 0
    assert pe.question_count("") == 0


def test_one_question_only_agrees_with_every_labelled_example():
    """线上那条必须与**每一条**人工判过的样本一致。

    样本（真实回复 + 文档里那条 + 构造的）住在 `smoke_question.py` 里：**只有一份**，
    所以它不可能悄悄和测试分叉。这条测试的作用是让「哪天有人再动这把尺子」当场变红。
    """
    import smoke_question as sq

    assert sq.SAMPLE, "金标不能是空的"
    wrong = [s["id"] for s in sq.SAMPLE if pe.question_count(s["reply"]) != s["want"]]
    assert wrong == [], f"与人工标签不一致：{wrong}"


def test_the_new_rule_beats_the_old_one_on_the_labelled_set():
    """改这把尺子要有证据：它在金标上必须**比原来那条准**，而且不许把原来判对的弄错。"""
    import smoke_question as sq

    names = {name: fn for name, fn in sq.RULES}
    old = names["A 数问号（原来那条）"]
    new = names[sq.SHIPPED]
    old_wrong = {s["id"] for s in sq.SAMPLE if old(s["reply"]) != (s["want"] == 1)}
    new_wrong = {s["id"] for s in sq.SAMPLE if new(s["reply"]) != (s["want"] == 1)}
    assert new_wrong < old_wrong, f"没有更准，或者把原来判对的弄错了：{new_wrong - old_wrong}"
    # 计划里建议的那版（数空行分段）量下来**更差** —— 它会把一段里的两个问题放过去
    blocks = names["B 数空行分隔的疑问段"]
    blocks_wrong = {s["id"] for s in sq.SAMPLE if blocks(s["reply"]) != (s["want"] == 1)}
    assert blocks_wrong == {"vague-analogy", "wrong-causal-claim", "three-short-questions-in-one-block", "quoted-question-mark"}


# --- 技能卡：只有跑过对照的才进屋 ---------------------------------------------


def test_cards_only_include_prompts_with_a_baseline():
    """「技能只有一个到手方式：它被证明有效过」——没基线的提示词不是技能。"""
    asyncio.run(pe.check("FEYNMAN_PROMPT", model_id="card/model", generate=_gen()))
    cards = asyncio.run(pe.cards())
    assert [c["name"] for c in cards] == ["FEYNMAN_PROMPT"]  # 另外 31 条一条都不出现
    card = cards[0]
    assert card["passed"] <= card["cases"] and card["cases"] > 0
    assert 0.0 <= card["ci_low"] <= card["ci_high"] <= 1.0
    assert card["stale"] is False  # 刚跑的就是这一版内容
    assert card["purpose"] and card["kind"]
    assert card["model_id"] == "card/model"


def test_a_card_goes_stale_when_the_prompt_changes(monkeypatch):
    """内容改过之后，卡上的分数就不是这一版的了——这件事得写在卡上，不能装作没事。"""
    asyncio.run(pe.check("FEYNMAN_PROMPT", model_id="card/model", generate=_gen()))
    real = pe._entry("FEYNMAN_PROMPT")

    class Fake:
        name = real.name
        module = real.module
        purpose = real.purpose
        kind = real.kind
        content = real.content + "\n（改过一行）"
        sha = "changed00000"

    monkeypatch.setattr(prompts, "inventory", lambda: [Fake()])
    cards = asyncio.run(pe.cards())
    assert cards and cards[0]["stale"] is True


def test_variant_runs_never_become_a_card():
    """候选变体跑得再好也不是技能：它不对应任何已登记的内容。

    这个文件的库是全文件共用的，前面已经有基线了——所以要验的不是「卡片数为零」，
    而是「卡片上写的是**基线**那次的成绩，候选那次没混进来」。
    """
    base = asyncio.run(pe.check("FEYNMAN_PROMPT", model_id="card/model", generate=_gen()))
    asyncio.run(
        pe.check(
            "FEYNMAN_PROMPT",
            variant="候选",
            variant_label="只有候选",
            model_id="card/model",
            generate=_gen("1. 清单\n2. 两项"),  # 丢掉 no_list，必挂
        )
    )
    cards = asyncio.run(pe.cards())
    assert [c["name"] for c in cards] == ["FEYNMAN_PROMPT"]  # 一张卡，不是两张
    assert cards[0]["passed"] == base["passed"]  # 卡上是基线那次的分
    assert cards[0]["cases"] == base["total"]


def test_latest_baselines_picks_the_newest_run_per_key():
    asyncio.run(pe.check("FEYNMAN_PROMPT", model_id="card/model", generate=_gen("问题？")))
    first = asyncio.run(pe.latest_baselines())["FEYNMAN_PROMPT"]
    asyncio.run(pe.check("FEYNMAN_PROMPT", model_id="card/model", generate=_gen("1. 清单\n2. 两项")))
    second = asyncio.run(pe.latest_baselines())["FEYNMAN_PROMPT"]
    assert second["id"] > first["id"]


# --- R1 补齐：提示词评测上墙（PLAN5 §2-2 点名的九条之一）-----------------------


def test_board_counts_what_has_been_measured():
    """墙上那一格：分母是登记表，分子是**跑过 golden set 且有成绩**的那些。"""
    asyncio.run(pe.check("FEYNMAN_PROMPT", model_id="board/model", generate=_gen()))
    b = asyncio.run(pe.board())
    assert b["readable"] is True and b["error"] == ""
    assert b["registered"] == len(prompts.inventory()) > 0
    assert b["measured"] >= 1
    assert b["cases"] >= 1
    assert 0 <= b["decidable"] <= b["measured"]
    assert 0 <= b["stale"] <= b["measured"]
    for key in ("registered", "measured", "decidable", "stale"):
        assert b["rules"][key]
    assert b["bias"]


def test_the_board_is_not_a_leaderboard():
    """§4-2：这一格量的是「尺子有没有被量过」，**不是「哪条提示词更好」**。

    `cards()` 是按 rate 倒序排的（那是小屋的技能卡）——原样搬上墙就成了一面排行榜，
    而墙上的数一旦能比大小，下一个人就会去追它。所以这里连一条提示词的名字都不许有。
    """
    asyncio.run(pe.check("FEYNMAN_PROMPT", model_id="board/model", generate=_gen()))
    b = asyncio.run(pe.board())
    blob = json.dumps(b, ensure_ascii=False)
    assert "FEYNMAN_PROMPT" not in blob  # 没有名字
    assert "rate" not in b and "top" not in b and "ranking" not in b
    # 「站得住」用的必须是**同一个判据**（`can_tell`），不许在这一格另算一份
    base = asyncio.run(pe.latest_baselines())["FEYNMAN_PROMPT"]
    want = 1 if pe.can_tell(base["ci_low"], base["ci_high"]) else 0
    assert b["decidable"] == want


def test_board_counts_a_stale_baseline_as_stale(monkeypatch):
    """内容改过之后那个分数就不是这一版的了——墙上要数得出来。"""
    asyncio.run(pe.check("FEYNMAN_PROMPT", model_id="board/model", generate=_gen()))
    real = pe._entry("FEYNMAN_PROMPT")

    class Fake:
        name = real.name
        module = real.module
        purpose = real.purpose
        kind = real.kind
        content = real.content + "\n（改过一行）"
        sha = "changed00000"

    monkeypatch.setattr(prompts, "inventory", lambda: [Fake()])
    b = asyncio.run(pe.board())
    assert b["registered"] == 1
    assert b["measured"] == 1
    assert b["stale"] == 1


def test_board_tells_read_failure_apart_from_zero(monkeypatch):
    """§4-8：**读不到 ≠ 零**。库里一条都没有是 `readable=true` + 0；读不出来是另一件事。"""
    empty = asyncio.run(pe.board())
    assert empty["readable"] is True  # 这一条是「读到了」（前面已经跑出成绩了）

    async def boom(*a, **k):
        raise RuntimeError("db down")

    monkeypatch.setattr(pe, "_latest_rows", boom)
    broken = asyncio.run(pe.board())
    assert broken["readable"] is False
    assert "db down" in broken["error"]
    assert broken["measured"] == 0  # 不是「零条量过」，是「没读到」——靠 readable 区分


def test_reading_the_board_makes_the_pet_say_nothing():
    """红线（与 `metrics` / `calibration` / 回合读数同一条）：跑完这一格，宠物一个字都没说。"""
    asyncio.run(pe.check("FEYNMAN_PROMPT", model_id="board/model", generate=_gen()))
    asyncio.run(pe.board())

    from app.core import pet as pet_core

    assert pet_core.feed(limit=50) == []


def test_the_board_has_no_way_to_speak():
    """比上一条更硬：真正的风险是下一个人顺手在这一格 emit 一句「还有 5 条没量过」。"""
    import re
    from pathlib import Path

    src = Path(pe.__file__).read_text(encoding="utf-8")
    body = src.split('"""', 2)[2]  # 去掉模块 docstring
    for banned in ("emit", "note_output", "compose", "feed", "greeting"):
        assert f"pet.{banned}" not in body, banned
    assert re.findall(r"\bpet_events\b", body) == []


def test_http_board_endpoint(monkeypatch):
    """墙上的那一格走 `/api/dashboard/prompt-eval`（R1 决定：扩现有 /dashboard，不新增导航）。"""
    asyncio.run(pe.check("FEYNMAN_PROMPT", model_id="board/model", generate=_gen()))
    monkeypatch.setenv("WB_API_TOKEN", "t")
    from fastapi.testclient import TestClient

    from app.core import auth
    from app.main import app

    monkeypatch.setattr(auth, "_cached", None)
    c = TestClient(app)
    h = {"X-WB-Token": "t"}

    assert c.get("/api/dashboard/prompt-eval").status_code == 401
    body = c.get("/api/dashboard/prompt-eval", headers=h).json()
    assert body["readable"] is True
    assert body["measured"] >= 1
    assert "registered" in body["rules"]


# --- 取消：半趟跑分不许污染质量闭环（2026-09-26）-------------------------------


def test_cancel_stops_between_cases_and_writes_no_run():
    """跑到一半被停：**留下跑完的那几条、但不落记录、也不给区间**。

    为什么不落记录：这个数的全部意义是「这一版内容在**一整套**用例上怎么样」。跑了一半的
    k/n 会被读成「变差了」，而它只是被打断了——那正是质量闭环最怕的污染。
    为什么不给区间：Wilson 区间是给一个**完整**样本算的；半趟给的区间是编的。
    """
    from sqlalchemy import delete, func, select

    from app.core import inflight
    from app.db import SessionLocal
    from app.models import PromptEvalRun

    token = "prompt-eval:FEYNMAN_PROMPT"
    inflight._running.clear()
    inflight._cancels.clear()
    assert inflight.try_acquire(token) is True

    calls: list[str] = []

    async def gen(_model_id: str, messages: list[dict]) -> str:
        calls.append(messages[-1]["content"][:20])
        # **第一条正跑着的时候，用户点了「停止」**
        inflight.request_cancel(token)
        return "1. 先讲调度\n2. 再讲 await"

    async def count_runs() -> int:
        async with SessionLocal() as db:
            await db.execute(delete(PromptEvalRun).where(PromptEvalRun.key == "FEYNMAN_PROMPT"))
            await db.commit()
            n = (await db.execute(
                select(func.count()).select_from(PromptEvalRun).where(PromptEvalRun.key == "FEYNMAN_PROMPT")
            )).scalar_one()
            return int(n)

    try:
        asyncio.run(count_runs())  # 先清干净，好数「这次有没有写」
        rep = asyncio.run(pe.check("FEYNMAN_PROMPT", model_id="fake/model", generate=gen, cancel_key=token))
        after = asyncio.run(count_runs())
    finally:
        inflight.release(token)

    assert rep["stopped"] is True
    assert len(calls) == 1, "应该在第一条之后停下，不该把整套跑完"
    assert rep["total"] == 1 and rep["planned"] > 1
    assert rep["rate"] is None and rep["ci"] is None, "半趟不该给比率与区间"
    assert rep["tell"] is False
    assert after == 0, "半趟跑分落库了——那会污染质量闭环"


def test_without_a_cancel_key_nothing_polls():
    """不传 `cancel_key` = 不看取消标记（内部调用方走的就是这条）。

    一次纯函数式的跑分不该因为进程里别处的状态而半路停下。
    """
    from app.core import inflight

    inflight._running.clear()
    inflight._cancels.clear()
    inflight.try_acquire("prompt-eval:FEYNMAN_PROMPT")
    inflight.request_cancel("prompt-eval:FEYNMAN_PROMPT")

    async def gen(_model_id: str, _messages: list[dict]) -> str:
        return "1. 先讲调度\n2. 再讲 await"

    try:
        rep = asyncio.run(pe.check("FEYNMAN_PROMPT", model_id="fake/model", generate=gen))
    finally:
        inflight.release("prompt-eval:FEYNMAN_PROMPT")

    assert rep.get("stopped") is not True
    assert rep["rate"] is not None
