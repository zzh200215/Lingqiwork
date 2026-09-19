"""判分金标集（PLAN2 P2-1）的离线测试。

这一格要钉住的不是「模型判得准不准」（那要花钱、要真 provider），是**这台机器的四件事**：

1. **金标集自己合格**：条数在 30–50、字段齐、档位合法、id 唯一、条条有 intent
   ——它是要长期维护的数据，坏了要当场知道（不是等跑完 36 次调用才发现）；
2. **判据是人工档位，不是断言**：只有完全一致才算过；「判不了」对 `k/n` **计为不过**
   但单独数出来（那是一个正当结论，可它跟判对不是一回事）；
3. **走产品自己那条路**：重放用的是 `retell.card_prompt` 拼装 + `judge_card` 那一次调用
   （只换模板），不是另写一套；跑出来的行落进**同一张** `PromptEvalRun`，所以对照台
   与校准曲线的页脚直接读得到；
4. **没说过的数不许编**：没跑过基线时页脚照实说没跑过；跑过旧版要说「那是上一版」。

模型一次都不真调：判分器按 `judge=` 注入（与 `test_retell.py` / `test_prompt_eval.py` 同一条纪律）。
"""
import asyncio
import json
import sys

import pytest

sys.path.insert(0, ".")

from app.core import judge_eval as je  # noqa: E402
from app.core import prompt_eval as pe  # noqa: E402
from app.core import retell as rt  # noqa: E402
from app.db import SessionLocal, engine as _engine  # noqa: E402
from app.models import Base as _Base  # noqa: E402
from app.models import PromptEvalRun  # noqa: E402


async def _init_db() -> None:
    async with _engine.begin() as conn:
        await conn.run_sync(_Base.metadata.create_all)


asyncio.run(_init_db())


@pytest.fixture(autouse=True)
def _clean():
    from sqlalchemy import delete

    async def _go() -> None:
        async with SessionLocal() as db:
            await db.execute(delete(PromptEvalRun))
            await db.commit()

    asyncio.run(_go())
    yield


def _judge(expect_by_retell: dict[str, int] | None = None, *, fallback_all: bool = False, calls=None):
    """一个假判分器：**按重讲原文查表**给档（这样每条用例的期望值可以随便摆）。"""

    async def fake(front, back, excerpt, retell, *, model_id="", template="", stream_fn=None):
        if calls is not None:
            calls.append({"front": front, "back": back, "excerpt": excerpt, "retell": retell, "template": template})
        if fallback_all:
            return {"ok": False, "grade": 0, "label": "", "reason": "它说判不了（材料不够）"}
        g = int((expect_by_retell or {}).get(retell, 3))
        if g == 0:  # 人工档位 0 = 该「判不了」：合格的判分器在这里就该说判不了
            return {"ok": False, "grade": 0, "label": "", "reason": "这张卡上没有答案"}
        return {
            "ok": True,
            "grade": g,
            "label": rt.grade_label(g),
            "missed_points": ["缺一点"] if g == 2 else [],
            "hint": "",
        }

    return fake


# ---------- 金标集自己的体检 ----------


def test_the_golden_set_matches_the_plan_spec():
    """PLAN2 P2-1 的数据规格：30–50 条，卡三样 + 重讲原文 + 人工档位。"""
    cases = je.load_cases()
    assert je.MIN_CASES <= len(cases) <= je.MAX_CASES
    assert je.validate(cases) == []
    for c in cases:
        assert c["front"] and c["retell"] and c["intent"]
        assert int(c["grade"]) in (*je.GRADES, je.NO_GRADE)


def test_the_golden_set_covers_every_grade_and_both_failure_modes():
    """四档 + 「不判」都得有用例，否则基线只量了它擅长的那些。

    另外两类**必须**在集合里，它们是判分器最容易犯的偏：
    「说得流利但核心错」（别被文风骗）与「口语化但讲对了」（别把语气当掌握程度）。
    """
    grades = {int(c["grade"]) for c in je.load_cases()}
    assert grades == {0, 1, 2, 3, 4}
    ids = {c["id"] for c in je.load_cases()}
    assert "await-归属说反了" in ids  # 流利但核心错
    assert "协程与线程-大白话但对了" in ids  # 口语化但核心对
    assert any(c.get("contested") for c in je.load_cases())  # 有争议的那条摆在明处


def test_validate_catches_the_things_that_would_poison_a_baseline():
    """体检要真的会报错：缺字段 / 档位越界 / 重复 id / 背面空着却给了档位。"""
    bad = [
        {"id": "a", "intent": "x", "front": "f", "back": "b", "excerpt": "", "retell": "r", "grade": 9},
        {"id": "a", "intent": "x", "front": "f", "back": "b", "excerpt": "", "retell": "r", "grade": 3},
        {"id": "c", "intent": "", "front": "f", "back": "", "excerpt": "", "retell": "r", "grade": 3},
    ]
    problems = "\n".join(je.validate(bad))
    assert "不在 0–4" in problems and "id 重复" in problems
    assert "back 是空的" in problems and "没有 intent" in problems
    assert "用例数" in problems  # 3 条，远少于 30


def test_the_fixture_is_canonical_and_wired_to_the_registry():
    """磁盘上的 JSON 必须是规范格式，key/module 必须对得上登记表（否则跑分对象是空气）。"""
    path = pe.FIXTURE_DIR / "JUDGE_SYSTEM.json"
    text = path.read_text(encoding="utf-8")
    assert pe.canonical_ok(text, json.loads(text))
    fx = pe.fixtures()["JUDGE_SYSTEM"]
    assert fx["module"] == "app.core.retell" and fx["kind"] == "grade"
    assert pe.is_grading("JUDGE_SYSTEM") is True
    assert pe.is_grading("FEYNMAN_PROMPT") is False


# ---------- 判据：一条用例怎么算过 ----------


def test_only_an_exact_match_counts():
    assert je.score_case(3, {"ok": True, "grade": 3})["passed"] is True
    one_off = je.score_case(3, {"ok": True, "grade": 2})
    assert one_off["passed"] is False and one_off["near"] is True and one_off["under"] is True
    far = je.score_case(4, {"ok": True, "grade": 1})
    assert far["passed"] is False and far["near"] is False and far["off"] == -3


def test_a_fallback_is_a_legitimate_answer_but_not_a_correct_one():
    """「判不了」不算判对（混在一起会让分数虚高），但要单独数出来。"""
    out = je.score_case(3, {"ok": False, "grade": 0, "reason": "判不了"})
    assert out == {"passed": False, "near": False, "fallback": True, "over": False, "under": False, "off": -1}


def test_when_the_card_has_no_answer_refusing_is_the_only_right_move():
    """人工档位 0 = 人工也认为该「判不了」：那时**给出任何档位都是错的**（提示词：不要编分）。"""
    assert je.score_case(0, {"ok": False, "grade": 0})["passed"] is True
    made_up = je.score_case(0, {"ok": True, "grade": 3})
    assert made_up["passed"] is False and made_up["over"] is True


def test_the_summary_reports_a_confusion_matrix_and_the_over_under_pair():
    """提示词自己承诺「宁可低判不高判」——高判/低判这一对就是那句话的尺子。"""
    rows = [
        {"id": "a", "expect": 3, "got": 3, "passed": True, "near": True, "fallback": False, "over": False, "under": False},
        {"id": "b", "expect": 3, "got": 4, "passed": False, "near": True, "fallback": False, "over": True, "under": False},
        {"id": "c", "expect": 2, "got": 1, "passed": False, "near": True, "fallback": False, "over": False, "under": True},
        {"id": "d", "expect": 4, "got": 0, "passed": False, "near": False, "fallback": True, "over": False, "under": False},
    ]
    out = je.summarize(rows)
    assert (out["passed"], out["total"], out["near"]) == (1, 4, 3)
    assert (out["over"], out["under"], out["fallback"]) == (1, 1, 1)
    assert out["matrix"]["3"]["3"] == 1 and out["matrix"]["3"]["4"] == 1 and out["matrix"]["2"]["1"] == 1
    lo, hi = out["ci"]
    assert 0.0 <= lo < out["rate"] < hi <= 1.0


def test_a_contested_case_is_shown_but_never_counted():
    """拿「我自己拿不准」计进分子或分母，都是在拿犹豫冒充一个数。"""
    rows = [
        {"id": "a", "expect": 3, "got": 3, "passed": True, "near": True, "fallback": False, "over": False, "under": False},
        {"id": "x", "expect": 0, "got": 1, "passed": False, "near": False, "fallback": False, "over": True,
         "under": False, "contested": True, "why": "两处口径撞车"},
    ]
    out = je.summarize(rows)
    assert (out["passed"], out["total"]) == (1, 1)  # 有争议那条不进 k/n
    assert out["contested"][0]["id"] == "x" and out["contested"][0]["why"]


# ---------- 一次跑分：走产品那条路、落同一张表 ----------


async def test_a_run_scores_every_case_and_uses_the_product_path():
    cases = je.load_cases()
    want = {c["retell"]: int(c["grade"]) for c in cases}
    calls: list[dict] = []
    report = await je.check(judge=_judge(want, calls=calls), save=False)

    assert report["report_kind"] == "grade"
    assert report["kind"] == "system"  # 提示词自己的种类没有被这个标记顶掉
    assert report["total"] == len(cases) - 1  # 有争议那条不计分
    assert report["passed"] == report["total"]  # 假判分器按人工档位回答 → 全一致
    assert report["calls"] == len(cases)
    assert report["calls"] == len(calls)
    # **走的是产品那条拼装路**：系统提示就是 `card_prompt` 拼出来的那一份（含题面/答案/重讲）
    first = calls[0]
    assert "【题面】" in first["template"] and "【主人的重讲】" in first["template"]
    assert first["retell"] and first["front"]
    assert first["template"] == rt.JUDGE_SYSTEM  # 没给候选，模板就是登记在册的那一份


async def test_a_run_persists_into_the_same_table_the_lab_reads():
    """同一张 `PromptEvalRun`、同一个 key：对照台的基线与历史是连着的。"""
    report = await je.check(judge=_judge({c["retell"]: int(c["grade"]) for c in je.load_cases()}))
    assert report.get("run_id")
    base = await pe.baseline(je.KEY, prompt_sha=report["prompt_sha"])
    assert base is not None
    assert (base["passed"], base["cases"]) == (report["passed"], report["total"])
    detail = json.loads(base["detail_json"])
    assert detail["near"] == report["near"] and "matrix" in detail
    assert detail["cases"][0]["expect"] in (0, 1, 2, 3, 4)


async def test_an_always_good_judge_gets_a_score_that_shows_what_it_misses():
    """一个「永远判良好」的判分器拿不到高分，而且跟合格的那一版**区间不重叠**——
    这正是这套金标集的用处：它分得开这两台判分器。"""
    want = {c["retell"]: int(c["grade"]) for c in je.load_cases()}
    lazy = await je.check(judge=_judge({}), save=False)  # 一律判「良好」
    good = await je.check(judge=_judge(want), save=False)  # 按人工档位回答
    assert lazy["passed"] < lazy["total"]
    assert lazy["over"] > 0 and lazy["under"] > 0  # 有的被高判、有的被低判
    assert lazy["near_rate"] > lazy["rate"]  # 它只是不精确，不是乱判
    assert lazy["ci"][1] < good["ci"][0], "两条区间重叠的话，这套集合分不开好坏判分器"
    assert lazy["tell"] is True and good["tell"] is True  # n=35：区间已经窄到能下结论


async def test_a_judge_that_always_says_it_cannot_tell_is_scored_as_such():
    report = await je.check(judge=_judge(fallback_all=True), save=False)
    assert report["fallback"] == report["total"]
    assert report["passed"] == 1  # 只有那条「卡上没有答案」是对的（人工也说不判）
    assert report["passed"] + report["fallback"] == report["total"] + 1


async def test_a_candidate_variant_replays_through_the_same_path():
    """候选提示词只换模板：拼装、调用、落库都是同一条路（否则测的是另一个产品）。"""
    calls: list[dict] = []
    variant = "候选模板：【题面】{front}【答案】{back}【材料】{excerpt}【重讲】{retell}"
    report = await je.check(variant=variant, variant_label="试·换一版", judge=_judge({}, calls=calls), save=False)
    assert report["variant_sha"] and report["variant_sha"] != report["prompt_sha"]
    assert calls[0]["template"] == variant
    assert report["variant_label"] == "试·换一版"


async def test_a_broken_case_fails_that_case_not_the_whole_run():
    """一次调用炸了是一条用例失败，不是整次跑分失败（与 `prompt_eval` 同一条纪律）。"""
    async def boom(*_a, **_kw):
        raise RuntimeError("provider 掉了")

    report = await je.check(judge=boom, save=False)
    assert report["total"] > 0 and report["passed"] == 1  # 只有「该判不了」那条还对
    assert all(c["error"].startswith("RuntimeError") for c in report["cases"])
    assert report["calls"] == len(report["cases"])


async def test_the_wrong_runner_refuses_loudly_instead_of_scoring_nothing():
    """`prompt_eval.check()` 拿聊天那套跑判分提示词会**静默**产出一条什么都不测的基线——
    比没有基线更坏，因为它看起来像一条。所以它必须当场拒绝并指路。"""
    with pytest.raises(ValueError) as e:
        await pe.check(je.KEY)
    assert "判分型" in str(e.value) and "judge_eval" in str(e.value)
    with pytest.raises(ValueError) as e2:
        pe.add_case(je.KEY, user="随便", intent="随便", checks=["concise"])
    assert "判分金标集" in str(e2.value)
    # 出口也不在界面上：条数有下限，一条条删会把整套跑到跑不动
    with pytest.raises(ValueError) as e3:
        pe.remove_case(je.KEY, je.load_cases()[0]["id"])
    assert "下限" in str(e3.value)
    assert len(je.load_cases()) == 36  # 一条都没被删掉


# ---------- 校准曲线的页脚：三种情况分开说 ----------


def test_the_footer_says_which_of_the_three_situations_we_are_in():
    base = {"passed": 21, "cases": 35, "ci_low": 0.43, "ci_high": 0.75}
    ran = je.baseline_note(base)
    assert "21/35" in ran and "43%–75%" in ran

    stale = je.baseline_note(None, stale={"prompt_sha": "abcdef123456", "passed": 20, "cases": 35})
    assert "上一版" in stale and "abcdef" in stale and "这一版还没跑过" in stale

    never = je.baseline_note(None, count=36)
    assert "还没跑过金标集" in never and "36 条" in never and "读趋势不读绝对值" in never


async def test_the_curve_reads_the_baseline_when_there_is_one():
    """T2 曲线页脚那一行是**数据驱动**的：跑过就说数，没跑过就说没跑过。"""
    from app.core import cards

    fresh = await cards.calibration()
    assert any("还没跑过金标集" in n for n in fresh["notes"])

    await je.check(judge=_judge({c["retell"]: int(c["grade"]) for c in je.load_cases()}))
    after = await cards.calibration()
    assert any("判分器基线" in n for n in after["notes"])
    assert any("完全一致" in n for n in after["notes"])
    assert len(after["notes"]) == 3  # 三条须知：基线 + 历史行 + 没存版本
