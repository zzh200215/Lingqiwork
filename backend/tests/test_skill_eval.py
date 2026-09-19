"""技能包的量法（环一收口）的离线测试。

三条最要紧的：
1. **有它 / 没它都要问**，而且逐条差要算对 —— 这是「有没有用」的直接答案；
2. **没有用例 = 没有尺子**，直说，不拿模型自己出的题当成绩；
3. **内容改过之后旧成绩不作数**（sha 对不上 = `stale`），与 Q1 技能卡同一条纪律。

模型与判分器都注入：这条路的成本是「用例数 × 2 + 判分」，测试里一次真调用都不该有。
"""
import asyncio
import atexit
import json
import shutil
import sys
import tempfile
from pathlib import Path

import pytest

sys.path.insert(0, ".")

_TMP = Path(tempfile.mkdtemp(prefix="wb-se-", dir=Path(".").resolve()))


def _cleanup() -> None:
    shutil.rmtree(_TMP, ignore_errors=True)


atexit.register(_cleanup)

from app.core import skill_eval as se  # noqa: E402
from app.core import skills  # noqa: E402
from app.db import SessionLocal, engine as _engine  # noqa: E402
from app.models import Base as _Base  # noqa: E402

skills.SKILLS_DIR = _TMP / "skills"
se.FIXTURE_DIR = _TMP / "evals"
skills.SKILLS_DIR.mkdir(parents=True, exist_ok=True)


async def _init_db() -> None:
    async with _engine.begin() as conn:
        await conn.run_sync(_Base.metadata.create_all)


asyncio.run(_init_db())


@pytest.fixture(autouse=True)
def _clean():
    from sqlalchemy import delete

    async def _go() -> None:
        async with SessionLocal() as db:
            await db.execute(delete(_Base.metadata.tables["skill_eval_runs"]))
            await db.commit()

    shutil.rmtree(skills.SKILLS_DIR, ignore_errors=True)
    skills.SKILLS_DIR.mkdir(parents=True, exist_ok=True)
    shutil.rmtree(se.FIXTURE_DIR, ignore_errors=True)
    asyncio.run(_go())
    yield


def _skill(name: str = "评测复现", body: str = "# 复现评测口径\n\n1. 找主表。\n2. 记切分与种子。\n") -> str:
    skills.install(f"---\nname: {name}\ndescription: 复现一篇论文的评测口径时用它\n---\n\n{body}")
    return name


def _cases(name: str, asks: list[str]) -> None:
    se.save_cases(name, [{"id": f"c{i}", "intent": "应该按工序走", "ask": a} for i, a in enumerate(asks)])


def _gen(monkeypatch, pairs: list[tuple[str, str]]):
    """按用例发回复：每条用例一个 `(没它, 有它)`。顺带记下每次调用的消息。

    「有它」按**消息里有没有 system** 判定，而不是按调用序号 —— 序号是实现的细节，
    而「工序有没有进上下文」才是这一层真正在乎的事。
    """
    calls: list[list[dict]] = []

    async def fake(model_id, messages):
        calls.append(messages)
        has_system = any(m.get("role") == "system" for m in messages)
        idx = (len(calls) - 1) // 2
        pair = pairs[min(idx, len(pairs) - 1)]
        return pair[1] if has_system else pair[0]

    return fake, calls


def _judge(monkeypatch, score: int = 4):
    async def fake(model_id, method, ask, produced):
        return score, "按工序走了"

    return fake


# ---------- 一次跑分 ----------


async def test_it_asks_each_case_twice_and_reports_the_delta(monkeypatch):
    """没它 / 有它各问一次；有它过了、没它没过 = helped。

    「没它」那次给的是一堵超过字数上限的墙（`not_a_wall_of_text` 是本模块唯一与工序无关
    的确定性断言）——「有它之后更像一份能照着做的东西」就是它量的那件事。
    """
    _skill()
    _cases("评测复现", ["复现这篇论文", "按它的口径跑一遍"])
    gen, calls = _gen(
        monkeypatch,
        [("糊成一堵墙" * 400, "照着工序做的产出"), ("短", "还是短")],
    )

    report = await se.run("评测复现", model_id="p/m", generate=gen, judge=_judge(monkeypatch))

    assert len(calls) == 4  # 2 条用例 × 2 次
    # 第一次没有 system（没它），第二次有（有它）
    assert "system" not in [m["role"] for m in calls[0]]
    assert "system" in [m["role"] for m in calls[1]]
    assert report["total"] == 2
    assert report["deltas"] == {"helped": 1, "hurt": 0, "same": 1}
    assert report["follows_method"] == 4.0
    assert report["calls"] == 2 * 2 + 2  # 生成 ×2 + 判分 ×2（只判有它那一侧）


async def test_an_unknown_assertion_is_a_failure_not_a_shrug(monkeypatch):
    """用例文件里写了个不存在的断言名 → 那条用例算不过（**不静默忽略**）。

    这一条钉的是踩过的坑：第一版这里调的是 `prompt_eval.run_checks`，它查的是**提示词**
    那张断言表，于是本模块的断言在它眼里全成了「未知」——每条用例的两次都判失败，
    看着像模型的错。
    """
    _skill()
    se.save_cases("评测复现", [{"id": "c0", "ask": "复现这篇论文", "checks": ["根本没有这条"]}])
    gen, _ = _gen(monkeypatch, [("短", "短")])

    report = await se.run("评测复现", model_id="p/m", generate=gen, judge=_judge(monkeypatch))

    row = report["cases"][0]
    assert row["with_ok"] is False and row["without_ok"] is False
    assert any("未知断言" in f["why"] for f in row["with_failed"])


async def test_a_hurt_case_is_reported_not_hidden(monkeypatch):
    """有它反而没过：照样记下来 —— 报告只报"帮了多少"就是自欺。"""
    _skill()
    _cases("评测复现", ["复现这篇论文"])
    gen, _ = _gen(monkeypatch, [("短", "有它之后糊成一堵墙" * 400)])

    report = await se.run("评测复现", model_id="p/m", generate=gen, judge=_judge(monkeypatch))

    assert report["deltas"]["hurt"] == 1 and report["deltas"]["helped"] == 0
    assert report["cases"][0]["with_ok"] is False and report["cases"][0]["without_ok"] is True


async def test_one_generate_failure_is_one_failed_case(monkeypatch):
    """一次调用炸了 = 那一条用例失败，不是整次跑分失败（与 Q1 同一条纪律）。"""
    _skill()
    _cases("评测复现", ["复现这篇论文"])
    seen = {"n": 0}

    async def flaky(model_id, messages):
        seen["n"] += 1
        if seen["n"] == 1:
            raise RuntimeError("连接被掐了")
        return "短"

    report = await se.run("评测复现", model_id="p/m", generate=flaky, judge=_judge(monkeypatch))

    assert report["total"] == 1
    row = report["cases"][0]
    assert row["without_ok"] is False and "连接被掐了" in row["error_without"]
    assert row["judge_why"]  # 判分照跑（有它那一侧有产出）


async def test_the_judge_only_sees_the_with_skill_side(monkeypatch):
    """没它那一侧压根没有工序可跟 —— 不判，省一次调用。"""
    _skill()
    _cases("评测复现", ["a", "b"])
    gen, _ = _gen(monkeypatch, [("短", "短"), ("短", "短"), ("短", "短")])
    judged: list[str] = []

    async def spy(model_id, method, ask, produced):
        judged.append(produced)
        return 3, "ok"

    await se.run("评测复现", model_id="p/m", generate=gen, judge=spy)

    assert len(judged) == 2  # 两条用例各一次，都在有它那一侧


async def test_a_dead_judge_does_not_lose_the_run(monkeypatch):
    """判分没跑成（None）→ 报告照出，只是 `follows_method` 空着，不编一个 0 分。"""
    _skill()
    _cases("评测复现", ["a", "b"])
    gen, _ = _gen(monkeypatch, [("短", "短"), ("短", "短"), ("短", "短")])

    async def dead(model_id, method, ask, produced):
        return None, "判分没跑成"

    report = await se.run("评测复现", model_id="p/m", generate=gen, judge=dead)

    assert report["follows_method"] is None
    assert len(report["cases"]) == 2


# ---------- 尺子与边界 ----------


async def test_no_cases_means_no_measurement(monkeypatch):
    """没有用例就没有尺子：模型自己出题自己考，考的是它会不会出题。"""
    _skill()

    with pytest.raises(ValueError, match="还没有用例"):
        await se.run("评测复现", model_id="p/m", generate=_gen(monkeypatch, [("x", "x")])[0])


async def test_a_missing_skill_says_so(monkeypatch):
    with pytest.raises(ValueError):
        await se.run("根本没有这份", model_id="p/m", generate=_gen(monkeypatch, [("x", "x")])[0])


async def test_too_few_cases_is_declared_as_undecidable(monkeypatch):
    """用例太少 → `tell=False`，并说清还差几条。**不给一个好看的比例。**"""
    _skill()
    _cases("评测复现", ["a", "b"])
    gen, _ = _gen(monkeypatch, [("短", "短"), ("短", "短"), ("短", "短")])

    report = await se.run("评测复现", model_id="p/m", generate=gen, judge=_judge(monkeypatch))

    assert report["tell"] is False and report["cases_needed"] == 1


async def test_saving_the_run_and_reading_it_back(monkeypatch):
    """落库 → `latest()` 拿得回来；而且**这一版内容**的成绩才对得上 `stale=False`。"""
    _skill()
    _cases("评测复现", ["a", "b", "c"])
    gen, _ = _gen(monkeypatch, [("短", "短"), ("短", "短"), ("短", "短")])
    report = await se.run("评测复现", model_id="p/m", generate=gen, judge=_judge(monkeypatch, 5))
    assert report["run_id"]

    got = await se.latest("评测复现", sha=report["sha"])
    assert got and got["cases"] == 3 and got["follows_method"] == 5

    rep = await se.report()
    row = [s for s in rep["skills"] if s["name"] == "评测复现"][0]
    assert row["registered"] is True and row["stale"] is False and row["cases"] == 3
    assert rep["measured"] is True


async def test_editing_the_skill_makes_the_old_score_stale(monkeypatch):
    """内容改过 → 旧成绩不作数（sha 对不上）。与 Q1 技能卡的 `stale` 同一个意思。"""
    _skill()
    _cases("评测复现", ["a", "b", "c"])
    gen, _ = _gen(monkeypatch, [("短", "短"), ("短", "短"), ("短", "短")])
    await se.run("评测复现", model_id="p/m", generate=gen, judge=_judge(monkeypatch))

    # 改一行正文
    skills.update(
        "评测复现",
        "---\nname: 评测复现\ndescription: 复现一篇论文的评测口径时用它\n---\n\n# 改了\n\n1. 先看附录。\n",
    )

    rep = await se.report()
    row = [s for s in rep["skills"] if s["name"] == "评测复现"][0]
    assert row["registered"] is False  # 这一版没量过
    assert row["stale"] is True  # 而且旧成绩确实在，只是不作数


async def test_report_lists_every_skill_and_where_cases_live(monkeypatch):
    _skill("甲")
    _skill("乙")
    rep = await se.report()

    assert [s["name"] for s in rep["skills"]] == ["乙", "甲"]  # 都没量过 → 按名字排
    assert all(s["registered"] is False for s in rep["skills"])
    assert rep["measured"] is False
    assert rep["fixture_dir"].endswith("evals")
    assert [c["name"] for c in rep["checks"]] == ["not_a_wall_of_text"]


async def test_report_carries_the_trial_line_and_its_window(monkeypatch):
    """S3：草稿卡上那一行事实（被用过几次）与**它的窗口**一起给出去。

    没被用过的技能是 `n=0` + `last_at=None`——**不编一个日期出来**；而窗口一定要跟着数据走，
    界面才能说「最近 N 次运行内」而不是「共 N 次」（PLAN3 §9.2 决策1）。
    """
    _skill("甲")
    from app.core import skill_trials as st

    rep = await se.report()

    one = rep["skills"][0]
    assert one["trials"] == {"n": 0, "last_at": None, "last_ts": None}
    assert rep["trial_window"] == st.WINDOW


# ---------- 用例文件的写 ----------


def test_cases_file_is_written_canonically_and_validated():
    _skill()
    out = se.save_cases("评测复现", [{"ask": "复现这篇论文", "intent": "按工序走"}])
    assert out["cases"] == 1

    raw = (se.FIXTURE_DIR / "评测复现.json").read_text(encoding="utf-8")
    assert json.loads(raw)["skill"] == "评测复现"
    assert raw.endswith("\n") and "\n  " in raw  # 规范格式：缩进两格、结尾一个换行

    with pytest.raises(ValueError):
        se.save_cases("评测复现", [{"ask": "   "}])


def test_cases_for_skips_a_broken_file():
    _skill()
    se.FIXTURE_DIR.mkdir(parents=True, exist_ok=True)
    (se.FIXTURE_DIR / "坏的.json").write_text("{ 这不是 json", encoding="utf-8")

    assert se.cases_for("坏的") is None  # 坏文件当没有，不炸
    assert se.all_cases() == {}


def test_cases_payload_gives_the_editor_what_it_needs():
    """编辑界面读的那份：用例 + 断言清单 + **默认会用哪条**。

    默认值由后端给（`DEFAULT_CHECK`）——前端自己抄一份名字，改一处忘一处。
    """
    _skill()
    se.save_cases("评测复现", [{"ask": "复现这篇论文", "intent": "按工序走"}])

    p = se.cases_payload("评测复现")

    assert p["skill"] == "评测复现" and p["file"] == "评测复现.json"
    assert [c["ask"] for c in p["cases"]] == ["复现这篇论文"]
    assert p["cases"][0]["checks"] == []  # 没写就是空：跑分时才落默认那条
    assert p["default_checks"] == [se.DEFAULT_CHECK]
    assert [c["name"] for c in p["checks"]] == list(se.CHECKS)


def test_the_default_check_is_a_real_one():
    """界面说「不勾就用默认那条」—— 那条必须真在表里（否则用例会全判「未知断言」）。"""
    assert se.DEFAULT_CHECK in se.CHECKS


async def test_a_case_without_checks_uses_the_default_at_run_time(monkeypatch):
    """用例没写 `checks` → 跑分时才落默认那条（文件里保持干净，默认值只有一处）。"""
    _skill()
    se.save_cases("评测复现", [{"id": "c0", "ask": "复现这篇论文"}])
    assert "checks" not in se.cases_for("评测复现")["cases"][0]
    gen, _ = _gen(monkeypatch, [("短", "短")])

    report = await se.run("评测复现", model_id="p/m", generate=gen, judge=_judge(monkeypatch))

    assert report["cases"][0]["with_ok"] is True  # 默认那条按字数判，两次都短 → 都过
