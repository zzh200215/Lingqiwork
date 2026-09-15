"""形态（Q3）的离线测试：三个数怎么算、什么时候**不算数**、什么时候长出枝。

这一层最容易出的不是算术错，是**悄悄放宽**：为了让枝长出来，把「两条样本」也算成一个
命中率、把别的领域的会话借来凑「不止一场」、把没标源的题算进分母。所以下面每组都有一条
专门盯这类事的测试——它们是这个功能的护栏，不是覆盖率凑数。

全部离线：不调模型，只碰一个沙箱库和已存在的 golden set 文件。
"""
import asyncio
import json
import sys
from types import SimpleNamespace

sys.path.insert(0, ".")

from sqlalchemy import delete  # noqa: E402

from app.core import form as core  # noqa: E402
from app.core import prompt_eval as pe  # noqa: E402
from app.db import SessionLocal, engine  # noqa: E402
from app.models import Base, EvalItem, EvalRun, PromptEvalRun, TutorSession  # noqa: E402


async def _init_db() -> None:
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)


asyncio.run(_init_db())


async def _clear() -> None:
    async with SessionLocal() as db:
        for table in (EvalRun, EvalItem, TutorSession, PromptEvalRun):
            await db.execute(delete(table))
        await db.commit()


def _teach() -> str:
    """第一条 golden set 声明的领域。

    不写死字符串：领域是那份文件说的，测试跟着它走（写死了的话，改文件会顺手改测试，
    而这条链上真正要证明的是「卡片带着 golden set 的领域进形态」，不是那个字面量）。
    """
    return pe.fixtures()["FEYNMAN_PROMPT"]["domain"]


async def _items(domain: str, n: int, source: str = "notes/a.md") -> list[int]:
    """插 n 条同领域的样例题，返回 id。"""
    ids: list[int] = []
    async with SessionLocal() as db:
        for i in range(n):
            row = EvalItem(question=f"q{i}", expected_source=source, domain=domain)
            db.add(row)
            await db.flush()
            ids.append(row.id)
        await db.commit()
    return ids


async def _run(rows: list[dict], **kw) -> int:
    """插一次评测，detail_json 就是给进去的那些行。"""
    async with SessionLocal() as db:
        r = EvalRun(total=len(rows), detail_json=json.dumps(rows, ensure_ascii=False), **kw)
        db.add(r)
        await db.commit()
        await db.refresh(r)
        return r.id


async def _taught(concept: str, domain: str, verdict: str = "got", times: int = 2) -> None:
    """插同一概念的若干场教学会话。"""
    async with SessionLocal() as db:
        for _ in range(times):
            db.add(TutorSession(topic="t", concept=concept, domain=domain, verdict=verdict))
        await db.commit()


async def _skill_baseline(domain_cases: int = 8, passed: int = 3) -> None:
    """给 FEYNMAN_PROMPT 插一条基线（技能那一边的唯一原料是 PromptEvalRun）。"""
    lo, hi = pe.wilson(passed, domain_cases)
    async with SessionLocal() as db:
        db.add(
            PromptEvalRun(
                key="FEYNMAN_PROMPT",
                prompt_sha="0" * 12,
                cases=domain_cases,
                passed=passed,
                rate=round(passed / domain_cases, 3),
                ci_low=round(lo, 3),
                ci_high=round(hi, 3),
                model_id="test/model",
                detail_json="[]",
            )
        )
        await db.commit()


# ---------- 纯函数 -------------------------------------------------------------


def test_domain_of_trims_and_caps():
    assert core._domain_of("  法律 ") == "法律"
    assert core._domain_of(None) == ""
    assert len(core._domain_of("x" * 99)) == 30


def test_labelled_cases_needs_a_source():
    """没标源的题只测忠实度、不测命中——「检索得住」那句话它撑不起来。"""
    rows = [
        SimpleNamespace(id=1, domain="D", expected_source="notes/a.md"),
        SimpleNamespace(id=2, domain="D", expected_source="  "),
        SimpleNamespace(id=3, domain="", expected_source="notes/b.md"),
    ]
    assert core._labelled_cases(rows) == {"D": {1}}


def test_rows_in_run_survives_a_broken_detail():
    assert core._rows_in_run("not json", {1}) == []
    assert core._rows_in_run("", {1}) == []
    assert core._rows_in_run('{"a":1}', {1}) == []
    assert core._rows_in_run('[{"id":1,"rank":2}]', {1})[0]["rank"] == 2


def test_pick_run_prefers_the_recent_run_that_covers_enough():
    """评测集会长大：最新那次可能还没包含这个领域的题，拿它算会得到一个假的 0/n。"""
    old = SimpleNamespace(id=1, detail_json=json.dumps([{"id": i} for i in (1, 2, 3)]))
    new = SimpleNamespace(id=2, detail_json=json.dumps([{"id": 3}]))
    picked = core._pick_run([new, old], {1, 2, 3})  # 调用方保证 id 倒序
    assert picked[0].id == 1
    assert len(picked[1]) == 3


def test_pick_run_falls_back_to_the_best_partial_cover():
    only = SimpleNamespace(id=1, detail_json=json.dumps([{"id": 1}, {"id": 2}]))
    picked = core._pick_run([only], {1, 2, 3, 4})
    assert picked[0].id == 1 and len(picked[1]) == 2


def test_retrieval_reports_the_interval_and_refuses_to_conclude():
    run = SimpleNamespace(id=7, created_at=None)
    # rank 有值 = 在 top_k 里找到了（第几名不重要）；None = 没找到，这次就是没命中
    rows = [{"id": 1, "rank": 1, "score": 5}, {"id": 2, "rank": None, "score": None}]
    r = core._retrieval((run, rows), labelled=2)
    assert r["enough"] is False  # 2 < MIN_CASES：命中率说不出口
    assert r["hits"] == 1
    assert r["hit_rate"] == 0.5
    assert r["ci_low"] < 0.5 < r["ci_high"]
    assert r["faithfulness"] == 5.0
    assert r["judged"] == 1  # 只判了一条，不是「平均水平」而是「判过的那条」
    assert "说不出口" in r["note"]


def test_retrieval_without_any_run_says_so():
    r = core._retrieval(None, labelled=4)
    assert r["enough"] is False and r["cases"] == 0
    assert r["run_id"] is None
    assert "还没有一次评测跑到过" in r["note"]


def test_concepts_counts_only_mastered():
    seen = [
        {"concept": "a", "last_at": "2026-09-01T00:00:00+00:00"},
        {"concept": "b", "last_at": "2026-09-01T00:00:00+00:00"},
    ]
    c = core._concepts({"seen": seen, "mastered": seen[:1]})
    assert c["mastered"] == 1 and c["seen"] == 2 and c["names"] == ["a"]
    assert c["enough"] is True


def test_skills_carry_their_own_interval():
    sk = core._skills(
        [
            {"name": "FEYNMAN_PROMPT", "purpose": "p", "passed": 3, "cases": 8, "rate": 0.375},
            {"name": "TINY", "purpose": "p", "passed": 1, "cases": 2, "rate": 0.5},
        ]
    )
    assert [s["name"] for s in sk] == ["FEYNMAN_PROMPT", "TINY"]  # 样本多的排前面
    assert sk[0]["enough"] is True
    assert sk[1]["enough"] is False  # 2 < MIN_CASES：这张卡自己样本不足


# ---------- branches()：三样都得站得住 -----------------------------------------


async def test_empty_is_empty():
    await _clear()
    out = await core.branches()
    assert out["domains"] == []
    assert out["min_cases"] == core.MIN_CASES


async def test_a_skill_alone_is_not_a_branch():
    """只跑过对照的提示词（ferynman 那条）本身就是个领域，但它还只是一样。"""
    await _clear()
    await _skill_baseline()
    out = await core.branches()
    d = next(b for b in out["domains"] if b["domain"] == _teach())
    assert d["grown"] is False
    assert len(d["skills"]) == 1
    assert d["retrieval"]["enough"] is False
    assert d["concepts"]["enough"] is False


async def test_untagged_evidence_creates_no_domain():
    """没归类的证据不进任何领域——「说不出口属于哪」不是「属于全部」。"""
    await _clear()
    await _items("", 3)
    await _taught("asyncio 事件循环", "")
    out = await core.branches()
    assert out["domains"] == []


async def test_two_labelled_cases_are_not_enough():
    await _clear()
    ids = await _items(_teach(), 2)
    await _run([{"id": i, "rank": 1, "score": 5} for i in ids])
    await _taught("asyncio 事件循环", _teach())
    await _skill_baseline()
    d = next(b for b in (await core.branches())["domains"] if b["domain"] == _teach())
    assert d["retrieval"]["cases"] == 2
    assert d["retrieval"]["enough"] is False
    assert d["grown"] is False


async def test_a_grown_branch_needs_all_three_and_then_appears():
    await _clear()
    ids = await _items(_teach(), 3)
    await _run([{"id": i, "rank": 1, "score": 5} for i in ids])
    await _taught("asyncio 事件循环", _teach())
    await _skill_baseline()
    out = await core.branches()
    d = next(b for b in out["domains"] if b["domain"] == _teach())
    assert d["grown"] is True
    assert d["retrieval"]["hits"] == 3 and d["retrieval"]["enough"] is True
    assert d["concepts"]["mastered"] == 1
    assert any(s["enough"] for s in d["skills"])


async def test_losing_one_of_the_three_un_grows_it():
    """三样缺一就不是枝——其中一样被删掉，枝必须消失（这条是「只有一个数好看不算」）。"""
    await _clear()
    ids = await _items(_teach(), 3)
    await _run([{"id": i, "rank": 1, "score": 5} for i in ids])
    await _skill_baseline()
    d = next(b for b in (await core.branches())["domains"] if b["domain"] == _teach())
    assert d["grown"] is False  # 概念这一样还空着
    await _taught("asyncio 事件循环", _teach())
    d = next(b for b in (await core.branches())["domains"] if b["domain"] == _teach())
    assert d["grown"] is True


async def test_one_session_is_not_mastery():
    await _clear()
    await _taught("asyncio 事件循环", _teach(), times=1)
    d = next(b for b in (await core.branches())["domains"] if b["domain"] == _teach())
    assert d["concepts"]["seen"] == 1
    assert d["concepts"]["mastered"] == 0
    assert d["concepts"]["enough"] is False


async def test_a_single_session_never_borrows_from_another_domain():
    """同一个概念在两个领域各一场 = 两边都还没学会。

    合并计数会让 A 领域的第二场替 B 领域的第一场背书，而「一场是运气」这条规矩存在的
    全部理由就是不被这种事骗。这里故意把两场拆到两个领域。
    """
    await _clear()
    await _taught("asyncio 事件循环", "领域A", times=1)
    await _taught("asyncio 事件循环", "领域B", times=1)
    out = await core.branches()
    by = {b["domain"]: b for b in out["domains"]}
    assert by["领域A"]["concepts"]["mastered"] == 0
    assert by["领域B"]["concepts"]["mastered"] == 0


async def test_same_concept_can_be_mastered_in_two_domains_separately():
    await _clear()
    await _taught("asyncio 事件循环", "领域A", times=2)
    await _taught("sqlite 的 WAL", "领域B", times=2)
    by = {b["domain"]: b for b in (await core.branches())["domains"]}
    assert by["领域A"]["concepts"]["names"] == ["asyncio 事件循环"]
    assert by["领域B"]["concepts"]["names"] == ["sqlite 的 WAL"]


async def test_domains_from_any_one_source_are_listed():
    """诊断表要回答「为什么还没长出来」，所以只有一样证据的领域也得列出来。"""
    await _clear()
    await _items("只有题", 3)
    await _taught("一个概念", "只有概念")
    out = await core.branches()
    names = {b["domain"] for b in out["domains"]}
    assert {"只有题", "只有概念"} <= names
    assert all(b["grown"] is False for b in out["domains"])


async def test_a_thin_skill_card_is_marked_not_enough():
    await _clear()
    ids = await _items(_teach(), 3)
    await _run([{"id": i, "rank": 1, "score": 5} for i in ids])
    await _taught("asyncio 事件循环", _teach())
    await _skill_baseline(domain_cases=2, passed=2)  # 金标集只有 2 条
    d = next(b for b in (await core.branches())["domains"] if b["domain"] == _teach())
    assert d["skills"][0]["enough"] is False
    assert d["grown"] is False


async def test_run_timestamps_are_utc_stamped():
    """形态也带时间（诊断表上要写「哪次评测」）。naive UTC 直接给了浏览器会差 8 小时。"""
    await _clear()
    ids = await _items(_teach(), 3)
    await _run([{"id": i, "rank": 1} for i in ids])
    d = next(b for b in (await core.branches())["domains"] if b["domain"] == _teach())
    assert d["retrieval"]["at"].endswith("+00:00")
