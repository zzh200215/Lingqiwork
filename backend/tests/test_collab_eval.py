"""A2 协作尺子的测试（`collab_eval`）：判据、聚合、配对对比。**一次模型都不调。**

跑分那条路（`run_tasks`）要真花钱，只在命令行那一轮跑；这里喂的是拼出来的 result。
这一层最该钉住的三件事：
  1. **判据是机械的**：marker 没进纪要、某步没跑成、该并行没并行、某步越权用了工具；
  2. **`bare` 那一臂不许用工具**（用了就是臂串了——那样两臂比出来的东西说不清）；
  3. **完成率不看轮数/步数**：协作贵不贵是成本，办成没办成看的是「每步跑成 + 材料事实进了纪要」。
"""
import asyncio
import sys
from pathlib import Path

import pytest

sys.path.insert(0, ".")

from app.core import collab, collab_eval as ce  # noqa: E402

_TASK = {
    "id": "t",
    "pattern": "pipeline",
    "goal": "把材料看一遍写个小结",
    "agents": [
        {"name": "甲", "avatar": "🅰️", "system_prompt": "你是甲"},
        {"name": "乙", "avatar": "🅱️", "system_prompt": "你是乙"},
    ],
    "vault": {"notes/a.md": "# a\n\n0.6176\n"},
    "expected": {"required_markers": ["0.6176"], "min_steps": 2},
    "note": "测试用",
}

_FANOUT = {
    "id": "f",
    "pattern": "fanout",
    "goal": "三个角度各答一次再汇总",
    "agents": [
        {"name": "甲", "avatar": "🅰️", "system_prompt": "你是甲"},
        {"name": "乙", "avatar": "🅱️", "system_prompt": "你是乙"},
    ],
    "vault": {"notes/a.md": "# a\n\n0.6176\n"},
    "expected": {"required_markers": ["0.6176"], "min_steps": 3, "parallel": True},
    "note": "测试用",
}


def _result(task, texts, *, tools=None, parallel=None, error="", ok=True, seconds=1.0):
    """按任务的 step 拼一份结果（与 `run_tasks` 交给 `judge` 的形状一致）。"""
    steps = collab.build_steps(
        task["pattern"],
        task["agents"],
        sorted((task.get("vault") or {}).keys()) or None,
    )
    tools = tools or {}
    facts = []
    for i, s in enumerate(steps):
        facts.append(
            {
                "step": i + 1,
                "title": s["title"],
                "phase": s["phase"],
                "agent": s["agent"]["name"],
                "text": texts[i] if i < len(texts) else "",
                "tools": list(tools.get(s["title"]) or []),
                "seconds": seconds,
                "parallel": bool(s.get("parallel_group")),
                "error": "",
            }
        )
    return {
        "ok": ok,
        "transcript": "\n\n".join(f"## {f['title']}\n\n{f['text']}" for f in facts),
        "facts": facts,
        "meta": {"pattern": task["pattern"], "parallel": task["pattern"] == "fanout" if parallel is None else parallel},
        "error": error,
        "parallel_seconds": seconds if task["pattern"] == "fanout" else 0.0,
        "serial_sum_seconds": seconds * len(facts) if task["pattern"] == "fanout" else 0.0,
    }


def _codes(findings) -> set[str]:
    return {f["code"] for f in findings}


def test_markers_are_judged_on_the_step_outputs_not_the_capped_report():
    """**② 撞出来的尺子 bug**：`TRANSCRIPT_CAP` 是报告文件的上限（给人审），不是判据的输入。

    那一轮 fanout 拆成 10 步、产出 45190 字，报告里那份纪要按上限截到 4000——6 个 marker
    里 5 个掉在截断外，于是「每步都跑成了、事实都写出来了」被读成 `missing_marker`。
    判据要读 `facts` 里那些**全文**（报告里一直留全了，所以旧报告 `--rejudge` 就能纠正）。
    """
    res = _result(_TASK, ["0.6176 在这里", "小结"])
    res["transcript"] = "（报告里那份被截断过的纪要，什么数都没有）"
    assert _codes(ce.judge(_TASK, res, arm="tools")) == set()

    # 反过来：连全文里都没有 → 照旧判 missing_marker（这条修的不是「判据变松」）
    res2 = _result(_TASK, ["一个字都没有", "小结"])
    res2["transcript"] = "0.6176"
    assert "missing_marker" in _codes(ce.judge(_TASK, res2, arm="tools"))


# ---------- k 遍配对（A2 挂账①）----------


def _rep(arm: str, done_ids: list[str], *, all_ids=("a", "b", "c"), exhausted=0, steps=4) -> dict:
    """一份**单臂**报告的最小形状（只带配对要用的那几栏）。"""
    detail = []
    for tid in all_ids:
        facts = [
            {"title": f"s{i}", "tools": [], "rounds_exhausted": i < exhausted, "seconds": 1.0}
            for i in range(steps)
        ]
        detail.append(
            {
                "id": tid,
                "arm": arm,
                "facts": facts,
                "findings": [] if tid in done_ids else [{"code": "missing_marker"}],
            }
        )
    return {"arm": arm, "detail": detail, "tasks_sha": "x"}


def test_pairing_is_by_rep_not_by_arm():
    """**逐遍配对**：第 i 遍 vs 第 i 遍。

    合成一份再 `summarize` 是不行的：那个函数的配对照 `(任务, 臂)` 只留一条，
    同一臂的多遍会互相覆盖——3 遍静默只剩最后一遍，读起来却像 9 对。
    """
    reps = [
        _rep("tools", ["a", "b"]),
        _rep("tools", ["a"]),
        _rep("tools", []),
        _rep("bare", ["a"]),
        _rep("bare", ["a", "b"]),
        _rep("bare", ["c"]),
    ]
    out = ce.pair_reps(reps)
    assert out["reps"] == 3 and out["reports"] == 6
    # 配对单位是 (任务, 遍) → 3 条 × 3 遍 = **9 对**（不是 3 对）。逐遍看：
    #   第 1 遍 tools{a,b} vs bare{a} → a 平、b **胜**、c 平
    #   第 2 遍 tools{a}   vs bare{a,b} → a 平、b **负**、c 平
    #   第 3 遍 tools{}    vs bare{c}   → a 平、b 平、c **负**
    assert out["paired"] == {"win": 1, "tie": 6, "loss": 2, "unpaired": 0}
    assert out["per_task"]["a"] == {"tools": [1, 1, 0], "bare": [1, 1, 0], "win": 0, "tie": 3, "loss": 0}
    assert out["per_task"]["b"] == {"tools": [1, 0, 0], "bare": [0, 1, 0], "win": 1, "tie": 1, "loss": 1}
    assert out["per_task"]["c"] == {"tools": [0, 0, 0], "bare": [0, 0, 1], "win": 0, "tie": 2, "loss": 1}
    assert out["arms"]["tools"]["done"] == 3 and out["arms"]["bare"]["done"] == 4


def test_pairing_counts_the_burnout_reading_separately():
    """**② 的机制读数**：烧光了几步（不看完成率——步数变多本身会把完成率抬上去）。"""
    out = ce.pair_reps(
        [
            _rep("tools", ["a", "b", "c"], exhausted=2, steps=4),
            _rep("bare", ["a", "b", "c"], exhausted=0, steps=10),
        ]
    )
    assert out["arms"]["tools"]["exhausted_steps"] == 2 * 3
    assert out["arms"]["tools"]["exhausted_rows"] == 3
    assert out["arms"]["bare"]["exhausted_steps"] == 0
    assert out["arms"]["bare"]["steps"] == 30


def test_pairing_refuses_an_unpairable_input():
    """两臂遍数不一样 → 当场抛。那种输入配出来的东西没人能解释。"""
    with pytest.raises(ValueError, match="遍数不一样"):
        ce.pair_reps([_rep("tools", ["a"]), _rep("bare", ["a"]), _rep("bare", ["a"])])
    with pytest.raises(ValueError, match="缺一臂"):
        ce.pair_reps([_rep("tools", ["a"])])
    with pytest.raises(ValueError, match="缺一臂"):
        ce.pair_reps([{"detail": []}])


def test_a_missing_task_on_one_side_counts_as_unpaired():
    out = ce.pair_reps(
        [_rep("tools", ["a"], all_ids=("a", "b")), _rep("bare", ["a"], all_ids=("a",))]
    )
    assert out["paired"]["unpaired"] == 1
    assert out["paired"]["tie"] == 1


@pytest.mark.parametrize(
    "win,loss,expected",
    [(0, 0, 1.0), (3, 0, 0.25), (9, 0, 0.0039), (5, 4, 1.0), (6, 3, 0.5078)],
)
def test_the_sign_test_is_a_brake_not_a_proof(win, loss, expected):
    """它的作用是拦住「5 胜 2 负 → 更好」这种读法（那在这个 n 下什么都不是）。"""
    assert ce.sign_test_p(win, loss) == expected


# ---------- 金标集本身 ----------


def test_the_shipped_collab_set_is_valid():
    tasks = ce.load_tasks()
    assert len(tasks) == 3
    assert ce.validate(tasks) == []
    assert sum(1 for t in tasks if (t.get("expected") or {}).get("parallel")) == 1
    assert {t["pattern"] for t in tasks} == {"pipeline", "review", "fanout"}


def test_validate_catches_the_ways_a_collab_task_can_be_broken():
    good = dict(_TASK)
    assert ce.validate([good]) == []

    def bad(**patch):
        t = {**good, **patch}
        return ce.validate([t])

    assert any("缺 goal" in p for p in bad(goal="  "))
    assert any("缺 note" in p for p in bad(note=""))
    assert any("pattern 不认识" in p for p in bad(pattern="brainstorm"))
    assert any("缺 system_prompt" in p for p in bad(agents=[{"name": "甲"}]))
    assert any("required_markers" in p for p in bad(expected={"required_markers": []}))
    assert any("没有判据消费" in p for p in bad(expected={"required_markers": ["x"], "must_save": True}))
    # 并行是编排器的事：pipeline 不许声明 parallel
    assert any("并行是编排器定的" in p for p in bad(expected={"required_markers": ["x"], "parallel": True}))
    assert any("vault" in p for p in bad(vault={"../外面.md": "x"}))
    assert ce.validate([]) == ["协作金标是空的"]


# ---------- 判据 ----------


def test_a_missing_material_fact_means_not_done():
    """材料里的具体事实没进纪要 = **没读到材料**，这条任务就没办成。"""
    got = ce.judge(_TASK, _result(_TASK, ["我读了材料，结论是很好", "风险是有的"]), arm="tools")
    assert _codes(got) == {"missing_marker"}
    assert "0.6176" in got[0]["detail"]
    assert ce.is_done({**_result(_TASK, ["0.6176"]), "findings": got}) is False
    # 事实进了纪要 → 干净
    ok = _result(_TASK, ["hit@1 是 0.6176", "风险：样本小"])
    assert ce.judge(_TASK, ok, arm="tools") == []
    assert ce.is_done({**ok, "findings": []}) is True


def test_a_failed_step_is_reported_and_blocks_done():
    res = _result(_TASK, ["写了一半", ""], ok=False)
    got = ce.judge(_TASK, res, arm="tools")
    assert "step_failed" in _codes(got)
    assert ce.is_done({**res, "findings": got}) is False


def test_a_run_that_never_started_is_one_finding():
    """整轮没跑起来（模型都解析不出来）→ **只报一条 `run_failed`**，不再往下数 marker。

    否则一次「压根没跑」会在报告里散成四五条毛病，读的人会以为模型做错了四五件事。
    """
    res = _result(_TASK, [], error="RuntimeError: 模型解析不出来")
    assert _codes(ce.judge(_TASK, res, arm="tools")) == {"run_failed"}
    # 而「跑起来了但两步都是空的」= 两条事实：某步没跑成 + 材料事实没进纪要
    empty = _result(_TASK, ["", ""], ok=False)
    assert _codes(ce.judge(_TASK, empty, arm="tools")) == {"step_failed", "missing_marker"}


def test_a_step_that_burned_its_rounds_is_not_a_success():
    """**轮数烧光 ≠ 跑成了**（2026-09-20 第二次真跑撞出来的）。

    烧光那一步返回的是一句**占位符**（「工具调用轮次过多，未能生成最终回答…」），
    它长得像一段正常回答：第一版的 `ok` 只看「有没有文字」，于是三路只读文件、一个字没写
    的那一轮被读成「干净」。这条与 `trace_missing` 同族——**其实没有，要响**。
    """
    res = _result(_TASK, ["(工具调用轮次过多，未能生成最终回答。)", "风险是有的"])
    for f in res["facts"]:
        f["rounds_exhausted"] = f["step"] == 1
    got = ce.judge(_TASK, res, arm="tools")
    assert "rounds_exhausted" in _codes(got)
    assert "占位符" in next(f for f in got if f["code"] == "rounds_exhausted")["detail"]
    assert ce.is_done({**res, "findings": got}) is False
    # **老报告只有那段文字、没有那个布尔**（这一条是重判旧报告时用的路）：
    # 认的是 `llm.ROUNDS_EXHAUSTED_TEXT` 这个常量，不是硬编码的句子。
    from app.core.llm import ROUNDS_EXHAUSTED_TEXT

    legacy = _result(_TASK, [ROUNDS_EXHAUSTED_TEXT, "风险是有的"])
    assert "rounds_exhausted" in _codes(ce.judge(_TASK, legacy, arm="tools"))
    # 没烧光就不响
    assert "rounds_exhausted" not in _codes(ce.judge(_TASK, _result(_TASK, ["0.6176", "风险"]), arm="tools"))


def test_parallel_is_the_orchestrators_business():
    """该并行的那一波没并行 → 一条 finding。**模型无从影响它**（它没有声明依赖的能力）。"""
    res = _result(_FANOUT, ["甲", "乙", "汇总"], parallel=False, tools={})
    assert "not_parallel" in _codes(ce.judge(_FANOUT, res, arm="tools"))
    res2 = _result(_FANOUT, ["甲", "乙", "汇总"])
    assert "not_parallel" not in _codes(ce.judge(_FANOUT, res2, arm="tools"))


def test_a_step_outside_its_tool_whitelist_is_a_finding():
    """A2 的验收之一。**尺子自己算一遍允许集**（不调被测代码的那把尺子，否则是自我证明）。

    写工具（`save_artifact`）与 `delegate` 都不在只读基线里，任何一步用了都该响。
    """
    title = collab.build_steps("pipeline", _TASK["agents"])[0]["title"]
    res = _result(_TASK, ["0.6176", "风险"], tools={title: ["save_artifact"]})
    got = ce.judge(_TASK, res, arm="tools")
    assert _codes(got) == {"tool_not_allowed"}
    assert "save_artifact" in got[0]["detail"]
    # 只读基线里的工具随便用（不必逐步声明）
    res2 = _result(_TASK, ["0.6176", "风险"], tools={title: ["kb_search", "vault_read_file"]})
    assert ce.judge(_TASK, res2, arm="tools") == []


def test_the_bare_arm_must_not_use_tools_at_all():
    title = collab.build_steps("pipeline", _TASK["agents"])[0]["title"]
    res = _result(_TASK, ["0.6176", "风险"], tools={title: ["kb_search"]})
    got = ce.judge(_TASK, res, arm="bare")
    assert _codes(got) == {"tools_expected_but_absent"}


def test_step_tools_come_from_the_orchestrator_not_the_model():
    """每一步要什么工具由 `_STEP_TOOLS` 决定（编排器），**模型没有任何字段能改它**。"""
    for pattern in collab.PATTERNS:
        for step in collab.build_steps(pattern, _TASK["agents"]):
            assert isinstance(step["tools"], list)
            assert "delegate" not in step["tools"]
    assert set(collab._STEP_TOOLS) >= {"work", "draft", "review", "revise", "merge"}


# ---------- 聚合与配对 ----------


def _row(tid, arm, *, done=True, findings=None, seconds=10.0):
    row = {
        "id": tid,
        "arm": arm,
        "pattern": "pipeline",
        "seconds": seconds,
        "facts": [{"tools": ["kb_search"], "seconds": seconds}],
        "findings": findings or [],
        "meta": {"parallel": False},
    }
    if not done:
        row["findings"] = findings or [{"code": "missing_marker", "detail": "x"}]
    return row


def test_summarize_splits_the_two_arms_and_pairs_them():
    rows = [
        _row("a", "tools", done=True),
        _row("a", "bare", done=False),
        _row("b", "tools", done=True),
        _row("b", "bare", done=True),
        _row("c", "tools", done=False),
        _row("c", "bare", done=True),
    ]
    rep = ce.summarize(rows)
    assert rep["tools_arm"] == {"tasks": 3, "done": 2, "rate": round(2 / 3, 4)}
    assert rep["bare_arm"] == {"tasks": 3, "done": 2, "rate": round(2 / 3, 4)}
    assert rep["paired"] == {"win": 1, "tie": 1, "loss": 1, "unpaired": 0}
    assert rep["tool_calls"] == 6 and rep["steps"] == 6


def test_summarize_reports_parallel_gain_from_the_same_run():
    """并行的收益**不额外跑一遍**：逐路相加（串行要花的） vs 取最大（并行实际花的）。"""
    fan = [
        {
            "id": "f",
            "arm": "tools",
            "pattern": "fanout",
            "seconds": 30.0,
            "facts": [{"tools": [], "seconds": 10.0}, {"tools": [], "seconds": 12.0}, {"tools": [], "seconds": 8.0}],
            "findings": [],
            "meta": {"parallel": True},
            "parallel_seconds": 12.0,
            "serial_sum_seconds": 30.0,
        }
    ]
    rep = ce.summarize(fan)
    assert rep["parallel_seconds"] == 12.0
    assert rep["serial_sum_seconds"] == 30.0


def _report(arm, rows, *, sha="same", rate=1.0):
    return {
        "arm": arm,
        "tasks_sha": sha,
        f"{arm}_arm": {"tasks": len(rows), "done": sum(1 for r in rows if ce.is_done(r)), "rate": rate},
        "detail": rows,
    }


def test_compare_reads_both_reports_not_just_one():
    """**两份报告合起来看**（2026-09-20 第一次真跑时这里出过错）。

    一次调用只跑一臂，所以每份报告里只有一个 `*_arm` 有数；第一版直接读 `new` 的那两栏，
    于是打印出「带工具 0.0 vs 裸 LLM 1.0（-100%）」，看着像带工具把任务全搞砸了。
    配对也必须跨报告按 id 配。
    """
    tools = _report(
        "tools",
        [
            {**_row("a", "tools", done=True), "parallel_seconds": 12.0, "serial_sum_seconds": 30.0},
            _row("b", "tools", done=False),
        ],
        rate=0.5,
    )
    bare = _report("bare", [_row("a", "bare", done=False), _row("b", "bare", done=True)], rate=0.5)

    line = ce.compare(bare, tools)
    assert "带工具 0.5 vs 裸 LLM 0.5" in line
    assert "配对 胜 1 / 平 0 / 负 1" in line  # a 带工具赢、b 裸 LLM 赢
    assert "省 18.0s" in line
    # 只有一臂的那一条要如实说，别默默当平局（a 两边都有 → 配上；b 只有裸 LLM 那一臂）
    assert "1 条只有一臂" in ce.compare(bare, _report("tools", [_row("a", "tools")]))
    # 金标换了就说不可比
    assert "不可比" in ce.compare(_report("bare", [], sha="a"), _report("tools", [], sha="b"))
    assert ce.compare({}, tools) == "没有可比的报告。"


# ---------- 跑分那条路的**管道**（模型是假的，所以不花钱） ----------


def test_run_tasks_plumbing_works_end_to_end_with_a_stubbed_model(monkeypatch):
    """`run_tasks` 的管道：起 run → 拼 facts → 判据 → 聚合 → **把用量行收走**。

    它才是最有可能**静默坏掉**的地方（真跑一次要十几分钟、几条命），而模型是注入缝
    （`delegate.run_agentic_chat`），所以这里能免费把管道走一遍。
    **故意用空材料**（`vault: {}`）：那样就不碰 embedder 与临时向量库，测试快且不依赖模型文件。
    """
    from app.core import delegate

    task = {**_TASK, "vault": {}, "expected": {"required_markers": ["嗯"], "min_steps": 2}, "note": "管道测试"}
    seen_models: list[str] = []

    async def fake(provider, model, messages, tools, run_tool, emit_text, emit_tool, **kw):  # noqa: ARG001
        seen_models.append(model)
        # 模拟 `usage_ledger` 在跑的时候写行（真实路径就是这样）：跑完必须被收走。
        # **不模拟这一下，「收走了 0 行」与「一行都没写」在报告里长得一模一样**——
        # 而这个项目最不想要的就是分不清这两件事。
        from app.db import SessionLocal

        from app.models import ModelUsage

        async with SessionLocal() as db:
            db.add(
                ModelUsage(kind="collab", ref="评测", model_id=model, tokens_in=1, tokens_out=1, calls=1)
            )
            await db.commit()
        text = "嗯"
        emit_text(text)
        trace = kw.get("trace")
        if trace is not None:
            trace["rounds"] = 1
            trace["tool_calls"] = []
        return text

    monkeypatch.setattr(delegate, "run_agentic_chat", fake)

    async def fake_resolve(_mid):
        return ("fake-info", "fake-model")

    monkeypatch.setattr("app.core.report.resolve", fake_resolve)

    async def count_collab_rows() -> int:
        from sqlalchemy import func, select

        from app.db import SessionLocal

        from app.models import ModelUsage

        async with SessionLocal() as db:
            return int(
                (
                    await db.execute(
                        select(func.count()).select_from(ModelUsage).where(ModelUsage.kind == "collab")
                    )
                ).scalar()
                or 0
            )

    async def go():
        before = await count_collab_rows()
        rep = await ce.run_tasks([task], arm="tools", rag=False)
        return rep, before, await count_collab_rows()

    rep, before, after = asyncio.run(go())
    assert rep["tasks"] == 1 and rep["done"] == 1
    assert rep["arm"] == "tools" and rep["rag"] is False
    # **发给服务端的是 provider 侧的名字**，不是 `p/m` 那种 id（A2 那次 400 就是它）
    assert seen_models == ["fake-model", "fake-model"]
    # 跑的时候写下 2 行（两步各一行）→ 收走 2 行，跑完一行都不剩
    assert before == 0 and rep["usage_rows_dropped"] == 2, "评测写的用量行必须被收走"
    assert after == 0, "用户自己的账上不该留下评测跑出来的协作用量"
    row = rep["detail"][0]
    assert len(row["facts"]) == 2  # pipeline 两步都记了账
    assert row["findings"] == []
    assert rep["tools_arm"]["rate"] == 1.0 and rep["bare_arm"]["tasks"] == 0
    assert rep["tasks_sha"] == ce.tasks_sha([task])


def test_run_tasks_rejects_an_unknown_arm():
    try:
        asyncio.run(ce.run_tasks([_TASK], arm="带工具"))
    except ValueError as e:
        assert "tools" in str(e)
    else:  # pragma: no cover - 走到这里就是失败
        raise AssertionError("臂的名字写错了要当场停，不能默默跑一臂")
