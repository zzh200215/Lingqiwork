"""能力候选（环一）的离线测试：一份材料 → 一份 SKILL.md 草稿。

这一条的**全部价值在克制**：能出能力才出，出不了就直说；同名不覆盖；
而且**落盘 ≠ 登记**（没基线的东西不许当能力展示）。所以测试钉的也是这几条，
而不是「模型有没有写出漂亮的工序」——那要靠对照台量，不是靠断言形状。

模型那一步用桩：`structured.extract_json` 是抽取层唯一入口，换掉它既不需要 provider，
也不需要网络。
"""
import asyncio
import atexit
import shutil
import sys
import tempfile
from pathlib import Path

import pytest

sys.path.insert(0, ".")

_TMP = Path(tempfile.mkdtemp(prefix="wb-cand-", dir=Path(".").resolve()))


def _cleanup() -> None:
    shutil.rmtree(_TMP, ignore_errors=True)


atexit.register(_cleanup)

from app.core import candidates as cand  # noqa: E402
from app.core import skills  # noqa: E402
from app.core import structured  # noqa: E402
from app.core import cards as cards_core  # noqa: E402
from app.config import VAULT_DIR  # noqa: E402

skills.SKILLS_DIR = _TMP / "skills"
skills.SKILLS_DIR.mkdir(parents=True, exist_ok=True)


@pytest.fixture(autouse=True)
def _clean():
    """每个用例一份干净的 skills/ 目录 —— 落盘的东西跨用例可见，不收就会串味。"""
    shutil.rmtree(skills.SKILLS_DIR, ignore_errors=True)
    skills.SKILLS_DIR.mkdir(parents=True, exist_ok=True)
    yield


class _Meta:
    strategy = "prompt"
    error = ""


class _Provider:
    name = "p"
    kind = "openai"
    base_url = "http://x"
    api_key = "k"
    enabled = True


def _stub_model(monkeypatch, obj):
    """把「调模型拿结构化结果」换成常量（`extract_json` 是本模块唯一那一步）。"""

    async def fake_extract_json(info, model, messages, schema, **kw):
        return (obj, _Meta()) if obj is not None else (None, _Meta())

    monkeypatch.setattr(structured, "extract_json", fake_extract_json)


def _stub_provider(monkeypatch):
    async def fake_resolve(model_id, providers):
        return _Provider(), "m"

    monkeypatch.setattr(cand, "_resolve", fake_resolve)


def _write_material(rel: str, body: str) -> str:
    p = VAULT_DIR / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(body, encoding="utf-8")
    return rel


GOOD = cand.SkillCandidate(
    usable=True,
    name="论文评测复现",
    description="当你要复现一篇论文的评测口径时用它",
    instructions="# 复现评测口径\n\n1. 找出它报的主表与指标。\n2. 记下数据切分与随机种子。\n",
    reason="材料里有一套可复现的评测工序",
    existing=[],
)


# ---------- 出得了能力 ----------


async def test_a_material_with_a_process_lands_as_a_skill_draft(monkeypatch):
    _stub_provider(monkeypatch)
    _stub_model(monkeypatch, GOOD)
    src = _write_material("notes/2026-09-16-论文.md", "材料正文" * 20)

    out = await cand.draft(source_path=src)

    assert out["ok"] is True and out["written"] is True
    assert out["path"] == "skills/论文评测复现/SKILL.md"
    text = (skills.SKILLS_DIR / "论文评测复现" / "SKILL.md").read_text(encoding="utf-8")
    assert text.startswith("---\nname: 论文评测复现\n")
    assert "description: 当你要复现一篇论文的评测口径时用它" in text
    assert "1. 找出它报的主表与指标。" in text
    # 落盘 ≠ 登记：没基线就不许当能力展示
    assert out["registered"] is False
    # 而且它立刻能被既有机制发现（进索引、可 skill_load）
    assert [s["name"] for s in skills.list_skills()] == ["论文评测复现"]


async def test_free_text_works_too(monkeypatch):
    """没有文件也能出候选（粘贴一段：材料就在手里，只是不在盘上）。"""
    _stub_provider(monkeypatch)
    _stub_model(monkeypatch, GOOD)

    out = await cand.draft(text="一段够长的粘贴材料。" * 10)

    assert out["written"] is True and out["source"] == "（粘贴文本）"


# ---------- 出不了能力（克制的那一半） ----------


async def test_no_process_means_no_skill_and_a_reason(monkeypatch):
    """只是背景知识 / 一堆结论 → 直说，不硬凑一份没人用的技能。"""
    _stub_provider(monkeypatch)
    _stub_model(
        monkeypatch,
        cand.SkillCandidate(usable=False, reason="这份材料只是一组结论，没有可执行的工序"),
    )
    src = _write_material("notes/plain.md", "结论一。结论二。" * 20)

    out = await cand.draft(source_path=src)

    assert out["ok"] is True and out["usable"] is False and out["written"] is False
    assert "没有可执行的工序" in out["reason"]
    assert skills.list_skills() == []  # 盘上什么都没多


async def test_usable_but_incomplete_never_lands(monkeypatch):
    """模型说能用、却缺 description/正文 → 不落盘（落下去 `_install_text` 也会拒）。"""
    _stub_provider(monkeypatch)
    _stub_model(monkeypatch, cand.SkillCandidate(usable=True, name="半成品", instructions=""))

    out = await cand.draft(text="材料。" * 50)

    assert out["written"] is False and out["usable"] is False
    assert "缺 name / description / instructions" in out["reason"]
    assert skills.list_skills() == []


async def test_the_same_name_never_overwrites_the_existing_skill(monkeypatch):
    """同名就停下，把决定交给人 —— 覆盖是显式动作（`overwrite=True`）。"""
    _stub_provider(monkeypatch)
    _stub_model(monkeypatch, GOOD)
    first = await cand.draft(text="材料。" * 50)
    assert first["written"] is True
    (skills.SKILLS_DIR / "论文评测复现" / "SKILL.md").write_text(
        "---\nname: 论文评测复现\ndescription: 我手改过的\n---\n\n正文\n", encoding="utf-8"
    )

    again = await cand.draft(text="材料。" * 50)

    assert again["written"] is False and again["already"] == "论文评测复现"
    assert "已存在" in again["reason"]
    # 手改过的那份一个字没动
    kept = (skills.SKILLS_DIR / "论文评测复现" / "SKILL.md").read_text(encoding="utf-8")
    assert "我手改过的" in kept

    forced = await cand.draft(text="材料。" * 50, overwrite=True)
    assert forced["written"] is True


# ---------- 读材料那一步的守卫 ----------


async def test_a_path_outside_the_vault_is_refused(monkeypatch):
    _stub_provider(monkeypatch)
    _stub_model(monkeypatch, GOOD)

    out = await cand.draft(source_path="../secrets.md")

    assert out["ok"] is False and "越出" in out["reason"]


async def test_a_missing_file_says_so_instead_of_crashing(monkeypatch):
    _stub_provider(monkeypatch)
    _stub_model(monkeypatch, GOOD)

    out = await cand.draft(source_path="notes/根本没有这篇.md")

    assert out["ok"] is False and "找不到文件" in out["reason"]


async def test_too_short_material_is_refused(monkeypatch):
    _stub_provider(monkeypatch)
    _stub_model(monkeypatch, GOOD)

    out = await cand.draft(text="太短")

    assert out["ok"] is False and "太短" in out["reason"]


async def test_no_provider_is_a_normal_answer_not_an_exception(monkeypatch):
    """没配模型：一句人话，不是 500 —— 它只是顺手做的一件事。"""

    async def boom(model_id, providers):
        raise RuntimeError("没有已启用且配置了模型的 provider")

    monkeypatch.setattr(cand, "_resolve", boom)

    out = await cand.draft(text="材料。" * 50)

    assert out["ok"] is False and "provider" in out["reason"]


async def test_a_model_that_returns_nothing_is_reported_honestly(monkeypatch):
    _stub_provider(monkeypatch)
    _stub_model(monkeypatch, None)

    out = await cand.draft(text="材料。" * 50)

    assert out["ok"] is False and out["reason"]


# ---------- 「没基线不许当能力展示」的唯一出处 ----------


async def test_report_says_every_skill_is_unmeasured(monkeypatch):
    """技能包还没有量法 → 如实说没量过，不编一个分数出来。"""
    _stub_provider(monkeypatch)
    _stub_model(monkeypatch, GOOD)
    await cand.draft(text="材料。" * 50)

    rep = await cand.report()

    assert rep["measured"] is False
    assert [s["name"] for s in rep["skills"]] == ["论文评测复现"]
    assert rep["skills"][0]["registered"] is False
    assert rep["skills"][0]["baseline"] is None


def test_the_stub_and_the_real_reader_agree_on_the_contract():
    """`collect_material` 的三元组形状是这一层依赖的唯一外部约定，钉一下。"""
    rel, label, material = cards_core.collect_material(text="一段够长的材料。" * 10)
    assert rel == "" and label == "粘贴文本" and material


# ---------- S2：从一次运行读能力（PLAN3 §2 S2） ----------
#
# 与「读材料」同一套落盘、同一套纪律；差异只在输入——**你自己干过的活**（题目 + 产出）。
# 所以这里钉的是：题目与产出真的进了材料、三步按 `thread_id` 归堆、只往回看、四硬规矩原样。

from app.db import SessionLocal, engine  # noqa: E402
from app.models import Base, ScheduledTask, TaskRun, Thread  # noqa: E402


async def _init_db() -> None:
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)


asyncio.run(_init_db())

TOPIC = "给领导汇报这次项目的结论"


def _capture_model(monkeypatch, obj):
    """桩模型 + 把送进去的 messages 记下来——「题目与产出有没有进材料」正是这一层要看的东西。"""
    seen: list[list[dict]] = []

    async def fake_extract_json(info, model, messages, schema, **kw):
        seen.append(messages)
        return (obj, _Meta()) if obj is not None else (None, _Meta())

    monkeypatch.setattr(structured, "extract_json", fake_extract_json)
    return seen


async def _mk_task(name: str = "每周产出", prompt: str = TOPIC) -> int:
    async with SessionLocal() as db:
        row = ScheduledTask(name=name, prompt=prompt, cron="0 9 * * *", action="compose")
        db.add(row)
        await db.commit()
        await db.refresh(row)
        return row.id


async def _mk_thread(name: str) -> int:
    async with SessionLocal() as db:
        row = Thread(name=name)
        db.add(row)
        await db.commit()
        await db.refresh(row)
        return row.id


async def _mk_run(task_id: int, answer: str, thread_id: int | None = None) -> int:
    async with SessionLocal() as db:
        row = TaskRun(task_id=task_id, answer=answer, status="ok", thread_id=thread_id)
        db.add(row)
        await db.commit()
        await db.refresh(row)
        return row.id


async def test_a_run_with_a_process_lands_as_a_skill_draft(monkeypatch):
    """真行：一次运行的题目 + 产出 → 一份草稿（落盘路径与「读材料」那条完全一样）。"""
    _stub_provider(monkeypatch)
    seen = _capture_model(monkeypatch, GOOD)
    tid = await _mk_task()
    rid = await _mk_run(tid, "## 结论\n先说结论。\n\n## 要点 1\n依据。")

    out = await cand.draft_from_run(rid)

    assert out["ok"] is True and out["written"] is True
    assert out["run_id"] == rid and out["runs"] == [rid]
    assert out["path"] == "skills/论文评测复现/SKILL.md"
    assert out["registered"] is False  # 落盘 ≠ 登记（四硬规矩第 4 条原样继承）
    # **题目与产出都进了材料**：模型就是照着这两样判「有没有一套工序」的
    msg = seen[0][1]["content"]
    assert TOPIC in msg and "先说结论" in msg


async def test_a_three_step_chain_goes_in_as_one_input(monkeypatch):
    """「处理一项工作」三步：**按 `task_runs.thread_id` 归堆**成一次输入，题目取那件「事」的
    名字（PLAN3 §9.2 决策2——三步本来就是三个任务，不是同一个任务下面的三次运行）。"""
    _stub_provider(monkeypatch)
    seen = _capture_model(monkeypatch, GOOD)
    th = await _mk_thread("手机换不换")
    first = await _mk_run(await _mk_task("工作·调研"), "调研：三条材料都指向再等一代", th)
    second = await _mk_run(await _mk_task("工作·方案"), "方案：两个选择，建议 B", th)
    last = await _mk_run(await _mk_task("工作·汇报稿"), "汇报稿：建议再等一代", th)

    out = await cand.draft_from_run(last)

    assert out["runs"] == [first, second, last]
    assert out["topic"] == "手机换不换"
    msg = seen[0][1]["content"]
    assert "手机换不换" in msg
    for bit in ("调研：三条材料都指向再等一代", "方案：两个选择，建议 B", "汇报稿：建议再等一代"):
        assert bit in msg


async def test_only_the_runs_up_to_this_one_go_in(monkeypatch):
    """按钮挂在哪一次，就按哪一次**之前**的活判断——后面那几步不算（否则会把还没发生的产出
    也读进去，沉淀出来的「工序」是照着结局编的）。"""
    _stub_provider(monkeypatch)
    seen = _capture_model(monkeypatch, GOOD)
    th = await _mk_thread("一件事")
    first = await _mk_run(await _mk_task("第一步"), "第一步的产出", th)
    second = await _mk_run(await _mk_task("第二步"), "第二步的产出", th)
    await _mk_run(await _mk_task("第三步"), "第三步还没轮到的产出", th)

    out = await cand.draft_from_run(second)

    assert out["runs"] == [first, second]
    assert "第三步还没轮到的产出" not in seen[0][1]["content"]


async def test_at_most_three_steps(monkeypatch):
    """同一件事上干过很多趟时只带最近三步：再多就是把不同趟的活混在一起。"""
    _stub_provider(monkeypatch)
    _capture_model(monkeypatch, GOOD)
    th = await _mk_thread("干过很多次的一件事")
    ids = [await _mk_run(await _mk_task(f"第 {i} 次"), f"第 {i} 次的产出", th) for i in range(1, 6)]

    out = await cand.draft_from_run(ids[-1])

    assert out["runs"] == ids[-3:]


async def test_a_result_only_run_is_refused(monkeypatch):
    """一次性的结果（没有下次能照着做的工序）→ 直说，不硬凑——与读材料那条同一个尺子。"""
    _stub_provider(monkeypatch)
    _stub_model(
        monkeypatch,
        cand.SkillCandidate(usable=False, reason="这次只是一份一次性的结果，没有可复用的工序"),
    )
    rid = await _mk_run(await _mk_task(), "结论：再等一代。")

    out = await cand.draft_from_run(rid)

    assert out["ok"] is True and out["usable"] is False and out["written"] is False
    assert "一次性的结果" in out["reason"]
    assert skills.list_skills() == []  # 盘上什么都没多


async def test_a_missing_run_says_so_instead_of_crashing(monkeypatch):
    _stub_provider(monkeypatch)
    _stub_model(monkeypatch, GOOD)

    out = await cand.draft_from_run(999999)

    assert out["ok"] is False and "999999" in out["reason"]


async def test_a_run_without_output_says_so(monkeypatch):
    """跑失败 / 还没跑完的那次没有产出可读——直说，别拿一句空话去问模型。"""
    _stub_provider(monkeypatch)
    _stub_model(monkeypatch, GOOD)
    rid = await _mk_run(await _mk_task(), "")

    out = await cand.draft_from_run(rid)

    assert out["ok"] is False and "没有可读的产出" in out["reason"]


async def test_the_same_name_never_overwrites_from_a_run(monkeypatch):
    """四硬规矩原样继承：同名不覆盖，覆盖是显式动作。"""
    _stub_provider(monkeypatch)
    _stub_model(monkeypatch, GOOD)
    rid = await _mk_run(await _mk_task(), "一套可复用的工序")

    first = await cand.draft_from_run(rid)
    assert first["written"] is True

    again = await cand.draft_from_run(rid)
    assert again["written"] is False and again["already"] == "论文评测复现"
    assert "已存在" in again["reason"]

    forced = await cand.draft_from_run(rid, overwrite=True)
    assert forced["written"] is True


async def test_the_router_delegates_to_it(monkeypatch):
    """端点只是三行委派，但它得真的在路由表里，并且接的是同一个函数
    （前端按 `/api/skills/draft-from-run` 这个名字调）。"""
    from app.routers import skills as skills_api

    assert "/api/skills/draft-from-run" in {r.path for r in skills_api.router.routes}

    _stub_provider(monkeypatch)
    _stub_model(monkeypatch, GOOD)
    rid = await _mk_run(await _mk_task(), "一套可复用的工序")

    out = await skills_api.draft_from_run(skills_api.DraftFromRunIn(run_id=rid))

    assert out["written"] is True and out["run_id"] == rid
