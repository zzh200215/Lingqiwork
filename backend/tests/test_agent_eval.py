"""A0 任务级基线的测试（Agent升级.md §2 A0）：判据、聚合、以及那把尺子的纪律。

**一次模型都不调**：跑分那条路（`run_tasks`）要真花钱，它只在命令行那一轮跑；
这里喂的是拼出来的 record —— 与 `test_turn_eval.py` 同一个形状。

这一层最该钉住的三件事：
  1. **判据一处都不另写**：完成是 W1 的 code、底线是 `turn_quality.findings`（无条件跑，
     不靠用例声明）、A0 自己只加工具与预算三条；
  2. **跑挂了的任务不算办成**（这一条是量的时候才发现的：`turn_error` 不在完成判据里，
     照原样算会把「脚本自己挂了」读成绿的）；
  3. **红线**：金标不进运行时（没有任何运行路径 import 这个模块）、不进零柒嘴里。
"""
import sys
from pathlib import Path

sys.path.insert(0, ".")

from app.core import agent_eval as ae  # noqa: E402

APP = Path(__file__).resolve().parent.parent / "app"


def _rec(**patch) -> dict:
    base = {
        "id": "t",
        "tag": "deliver",
        "instruction": "把这周的进展整理成一份周报，存进产出。",
        "model_id": "stub/m",
        "reply": "",
        "artifacts": [],
        "error": "",
        "rounds": 1,
        "tools": 0,
        "tool_names": [],
        "saves": 0,
        "tokens_out": 0,
        "seconds": 1.0,
        "vault_files": 1,
        "findings": [],
    }
    base.update(patch)
    return base


def _codes(findings) -> set[str]:
    return {f["code"] for f in findings}


# ---------- 金标任务集本身：格式与纪律 ----------


def test_the_shipped_task_set_is_valid():
    tasks = ae.load_tasks()
    assert len(tasks) == 20  # 16 条（A0/A1）+ A2 的 3 条协作形状 + A4 的 1 条指涉
    assert ae.validate(tasks) == []
    ids = [t["id"] for t in tasks]
    assert len(ids) == len(set(ids))


def test_the_a4_task_measures_something_it_could_not_guess():
    """A4 那条任务的**全部意义**：事名只在注入段里出现。

    这一层单独立一条测试（`validate` 也拦），是因为「判据泄漏进了材料」这种错**不会**
    让任何东西变红——它只会让那条任务从此量不到注入、却照样报绿。金标里最贵的一类错。
    """
    task = next(t for t in ae.load_tasks() if t["id"] == "continue-recent-thing")
    from app.core import thread_context

    name = task["thread"]["name"]
    assert thread_context.refers_to_thread(task["instruction"]), (
        "题面得指涉「那件事」，否则 A4 根本不会触发（`--dry` 拦不住这种「任务与判据对不上」）"
    )
    visible = task["instruction"] + "\n".join(
        f"{rel}\n{text}" for rel, text in task["vault"].items()
    )
    assert name not in visible
    assert task["expected"]["answer_contains"] == [name]


def test_the_task_set_has_all_three_shapes():
    """三类都要有：**该办成的 / 不该办的 / 办不成的**。

    只有「该办成」的那一类，尺子会把「什么都存」判成满分——W3 那条负例纪律的
    任务级翻版（把闲聊变成产出比漏判烦人得多）。
    """
    tags = {t["tag"] for t in ae.load_tasks()}
    assert {"deliver", "qa", "refuse"} <= tags
    tasks = ae.load_tasks()
    assert sum(1 for t in tasks if t["expected"].get("must_not_save")) >= 5
    assert sum(1 for t in tasks if t["expected"].get("must_save")) >= 8


def test_every_delegate_expectation_can_actually_be_met():
    """A2：「该委托」的任务，白名单里**必须真的有** `delegate`。

    不然那条用例在要求一件做不到的事（A1 的 fail-closed 默认不给无人值守路径 `delegate`），
    跑出来的结论没法解释。这条在 `validate` 里也拦一道，这里再钉一次**出厂集子**。
    """
    for t in ae.load_tasks():
        if t["expected"].get("must_delegate"):
            assert "delegate" in ae.whitelist(t["expected"]), t["id"]
    assert sum(1 for t in ae.load_tasks() if t["expected"].get("must_delegate")) == 3


def test_the_same_instruction_appears_under_two_material_conditions():
    """同一句自然说法、两种材料条件、期望相反 —— W1 缺口五那条教训的复刻：

    「不带上下文条件的遵守率是误导」（同一句在空 vault 下 0/4、有素材时 15/16）。
    """
    tasks = ae.load_tasks()
    with_mat = next(t for t in tasks if t["id"] == "report-to-leader-with-material")
    without = next(t for t in tasks if t["id"] == "report-to-leader-no-material")
    assert with_mat["instruction"] == without["instruction"]
    assert with_mat["expected"]["must_save"] is True
    assert without["expected"]["must_not_save"] is True
    empty = next(t for t in tasks if t["id"] == "empty-vault-refuse")
    weekly = next(t for t in tasks if t["id"] == "weekly-report")
    assert empty["instruction"] == weekly["instruction"] and empty["vault"] == {}


def test_every_task_says_where_it_came_from():
    """每条都要有出处 —— 没有出处的那一条复核的人只能凭感觉点头。"""
    for t in ae.load_tasks():
        assert len(t["note"]) > 20, t["id"]


# ---------- validate：坏用例当场红 ----------


def test_validate_rejects_an_expectation_nobody_reads():
    """**声明了没人读的期望 = 以为在量、其实没量**（2026-09-20 补，拿真事换来的）。

    第一版 `artifact_kinds` 写进了 16 条任务，而 W1 的 `check_turn` **不查体裁**——
    这条期望从来没生效过，`--dry` 却报绿，直到付费跑分跑到第 6 条才发现，白杀一轮。
    现在 `--dry` 也查这一栏：键不认识（拼错 / 判据没实现）就当场红。
    """
    good = {
        "id": "x",
        "instruction": "写一份周报",
        "note": "出处：测试",
        "expected": {"must_save": True, "artifact_kinds": ["deliver"]},
    }
    assert ae.validate([good]) == []
    bad = {**good, "expected": {"must_save": True, "artefact_kinds": ["deliver"]}}  # 拼错一个字母
    assert any("没有判据消费" in p for p in ae.validate([bad]))
    # 每一栏都得在这个名单里 —— 名单本身也要跟着判据一起长
    assert {"must_save", "artifact_kinds", "tools_extra", "must_call", "rounds_budget"} <= set(
        ae.EXPECT_KEYS
    )
    # 旧的那一栏**必须查不到了**：留着它，「任务各写一遍只读工具」会悄悄长回来
    assert "tools_allowed" not in ae.EXPECT_KEYS


def test_every_shipped_expectation_key_is_consumed():
    """出厂的金标里也不许有「写了没人看」的栏。"""
    for t in ae.load_tasks():
        unknown = set(t["expected"]) - set(ae.EXPECT_KEYS)
        assert not unknown, f"{t['id']} 有没人读的期望：{unknown}"


def test_validate_catches_the_ways_a_task_can_be_broken():
    good = {
        "id": "x",
        "instruction": "写一份周报",
        "note": "出处：测试",
        "expected": {"must_save": True},
    }
    assert ae.validate([good]) == []

    def bad(**patch):
        t = {**good, **patch}
        return ae.validate([t])

    assert any("缺 expected" in p for p in bad(expected={}))
    # 有 expected 但两个完成判据都没写 → 这条量不了「办成没有」
    assert any("must_save / must_not_save" in p for p in bad(expected={"tools_extra": []}))
    assert any("恰好有一个" in p for p in bad(expected={"must_save": True, "must_not_save": True}))
    assert any("缺 instruction" in p for p in bad(instruction="  "))
    assert any("缺 id" in p for p in bad(id=""))
    assert any("缺 note" in p for p in bad(note=""))
    assert any("工具名不认识" in p for p in bad(expected={"must_save": True, "tools_extra": ["vault_reed_file"]}))
    # `must_call` 只该钉**只读**工具：拿它钉写工具就是把两种意思混在一栏里
    assert any("must_call" in p and "只读基线" in p for p in bad(expected={"must_save": True, "must_call": ["save_artifact"]}))
    # A2：不能要求一件做不到的事（该委托、却不给它 delegate）
    assert any("做不到" in p for p in bad(expected={"must_save": True, "must_delegate": True}))
    assert ae.validate([{**good, "expected": {"must_save": True, "must_delegate": True, "tools_extra": ["delegate"]}}]) == []
    assert any("布尔" in p for p in bad(expected={"must_save": True, "must_delegate": "yes"}))
    assert any("路径" in p for p in bad(vault={"../外面.md": "x"}))
    assert any("rounds_budget" in p for p in bad(expected={"must_save": True, "rounds_budget": 0}))
    assert any("artifact_kinds" in p for p in bad(expected={"must_not_save": True, "artifact_kinds": ["deliver"]}))
    assert ae.validate([good, dict(good)]) != []  # id 重复
    assert ae.validate([]) == ["任务集是空的"]


def test_load_tasks_refuses_a_broken_line(tmp_path):
    p = tmp_path / "t.jsonl"
    p.write_text('{"id": "a", "instruction": "x", "note": "n", "expected": {"must_save": true}}\n{坏行\n', encoding="utf-8")
    try:
        ae.load_tasks(p)
    except ValueError as e:
        assert "第 2 行" in str(e)
    else:  # pragma: no cover - 走到这里就是失败
        raise AssertionError("坏行应当当场炸，而不是被悄悄跳过")


def test_the_fingerprint_changes_when_the_task_set_changes(tmp_path):
    a = tmp_path / "a.jsonl"
    b = tmp_path / "b.jsonl"
    line = '{"id": "a", "instruction": "x", "note": "n", "expected": {"must_save": true}}'
    a.write_text(line + "\n", encoding="utf-8")
    b.write_text(line + "\n" + '{"id": "b", "instruction": "y", "note": "n", "expected": {"must_not_save": true}}' + "\n", encoding="utf-8")
    assert ae.tasks_sha(a) != ae.tasks_sha(b)


# ---------- agent_findings：A0 自己那三条 ----------


def test_a_tool_outside_the_whitelist_is_a_finding():
    rec = _rec(tool_names=["vault_write_file"])
    got = ae.agent_findings(rec, {"tools_extra": ["save_artifact"]})
    assert _codes(got) == {"tool_not_allowed"}
    # 声明了的写工具不算
    assert ae.agent_findings(_rec(tool_names=["save_artifact"]), {"tools_extra": ["save_artifact"]}) == []
    # **没声明写工具 = 不许写**（不再是「没声明就不查」：只读是底盘，能不能写才是差别）
    assert _codes(ae.agent_findings(_rec(tool_names=["save_artifact"]), {})) == {"tool_not_allowed"}


def test_readonly_tools_are_allowed_for_every_task():
    """通则（2026-09-20 用户拍板）：五个只读工具是**所有任务**的底盘。

    这条是一次**假越界**换来的：`empty-vault-refuse`（空 vault 下正确拒绝）调了
    `memory_list` 去确认「真没有」，被记成工具越界——而查记忆确认无材料，正是拒绝类
    任务该做的事。当时的修法有两种：给那一条补个名字（**对着一次跑分拟合**，上次栽过），
    或者按类改。用户选了按类改。
    """
    for name in ae.BASE_TOOLS:
        assert ae.agent_findings(_rec(tool_names=[name]), {}) == [], name
        assert ae.agent_findings(_rec(tool_names=[name]), {"tools_extra": []}) == [], name
    # 那条真实用例的期望（refuse 类只声明「没有额外工具」）碰上 memory_list 不该响
    refuse = {"must_not_save": True, "tools_extra": [], "rounds_budget": 2}
    assert ae.agent_findings(_rec(tool_names=["memory_list", "kb_search"]), refuse) == []
    # 但底盘的**边界**仍在：底盘外的、又没声明 → 还是响
    assert _codes(ae.agent_findings(_rec(tool_names=["memory_list", "delegate"]), refuse)) == {
        "tool_not_allowed"
    }


def test_the_ruler_and_the_sub_agent_agree_on_what_readonly_means():
    """两处定义各自的漂移要被抓住。

    `BASE_TOOLS`（主循环这一轮允许调什么）与 `delegate.READONLY_TOOLS`（给子代理的默认工具子集）
    是**两件事**，但「只读」的含义必须一致：一边加了 `memory_delete`，另一边还当只读，
    这份白名单就会放出一次写操作。所以两边**不许各写各的**。
    """
    from app.core import delegate

    assert set(ae.BASE_TOOLS) == set(delegate.READONLY_TOOLS)
    assert not (set(ae.BASE_TOOLS) & set(delegate.WRITE_TOOLS))


def test_must_call_is_any_of():
    """`must_call` 钉的是「看没看材料」，不是「必须走哪个工具」—— 所以是 any-of。"""
    exp = {"must_call": ["vault_read_file", "kb_search", "vault_list_files"]}
    assert ae.agent_findings(_rec(tool_names=["kb_search"]), exp) == []
    assert ae.agent_findings(_rec(tool_names=["kb_search", "vault_list_files"]), exp) == []
    # 用了**允许但不在 must_call 里**的工具 → 只该响「该用的没调」（这里用只读的 memory_list：
    # 通则之后所有任务都能调它；换成 save_artifact 会**同时**响 tool_not_allowed，那是另一条判据）
    assert _codes(ae.agent_findings(_rec(tool_names=["memory_list"]), exp)) == {"tool_not_used"}
    assert ae.agent_findings(_rec(tool_names=[]), {}) == []


def test_a_wrong_artifact_kind_is_caught_because_w1_does_not_check_it():
    """`artifact_kinds` 是 A0 的判据 —— **W1 的 `check_turn` 只查「有没有落盘」，不查体裁**。

    不补这一条，fixture 里那一栏就是「写了没人看」：声明了期望体裁、报告却不会因为它
    变红。`wrong_artifact_kind` 必须在 A0 这一侧补上。
    """
    arts = [{"kind": "conflict", "path": "conflicts/a.md", "exists": True}]
    exp = {"must_save": True, "artifact_kinds": ["deliver", "compose"]}
    got = ae.agent_findings(_rec(artifacts=arts), exp)
    assert _codes(got) == {"wrong_artifact_kind"}
    # 期望里有的体裁 → 不算错
    ok = [{"kind": "compose", "path": "notes/a.md", "exists": True}]
    assert ae.agent_findings(_rec(artifacts=ok), exp) == []
    # 一份都没落的时候由 `not_saved` 说话，这里不重复报
    assert ae.agent_findings(_rec(), exp) == []
    # 没声明这一栏就不管
    assert ae.agent_findings(_rec(artifacts=arts), {"must_save": True}) == []


def test_rejudge_recomputes_a0_codes_and_leaves_w1_codes_alone():
    """**尺子改了、原始事实没变** → 重算判据即可，不必再花一次钱。

    边界必须钉住：`rejudge` 只重算 `agent_findings` 那几条。W1 那几条要**盘上的正文**
    （`body_not_in_reply`），而报告里没有 `bodies`——要是这里被改成「整条重算」，
    那几条就会拿着缺了输入的数据算出**看起来一样的结果**，正是「以为在量、其实没量」。
    """
    task = {"id": "t", "expected": {"must_save": True, "tools_extra": []}}
    rec = _rec(tool_names=["memory_list"], rounds=2)
    # 旧尺子留下的读数：只读工具被当成越界
    rec["findings"] = [
        {"code": "tool_not_allowed", "detail": "旧尺子"},
        {"code": "long_body_without_a_receipt", "detail": "W1 的，重判不许动它"},
    ]
    rows, diff = ae.rejudge([rec], [task])
    codes = _codes(rows[0]["findings"])
    assert "tool_not_allowed" not in codes  # 通则之后只读工具不再是越界
    assert "long_body_without_a_receipt" in codes  # W1 那条原样留着
    assert diff == [{"id": "t", "before": ["tool_not_allowed"], "after": []}]


def test_rejudge_refuses_a_report_whose_tasks_are_gone():
    """报告里有、当前金标里没有的任务：**不猜、不跳过**，当场停。

    跳过的后果是报告少了几条而看起来一切正常——那正是这套尺子最不想要的失败
    （和 `load_tasks` 坏行当场炸同一条纪律）。
    """
    rec = _rec()
    rec["findings"] = []
    try:
        ae.rejudge([rec], [{"id": "别的任务", "expected": {}}])
    except KeyError as e:
        assert "t" in str(e)
    else:  # pragma: no cover - 走到这里就是失败
        raise AssertionError("任务对不上就该当场停")


def test_must_delegate_is_a_capability_reading_not_a_completion_rule():
    """A2：`must_delegate` **不影响完成率**——委托省的是轮数与上下文，不是成功率。

    口径与 `over_budget` 那条一致（成本/能力事实，逐条数着，但不改「办成了没有」）。
    """
    exp = {"must_save": True, "must_delegate": True, "tools_extra": ["delegate"]}
    rec = _rec(delegations=[])
    got = ae.agent_findings(rec, exp)
    assert _codes(got) == {"not_delegated"}
    assert not (_codes(got) & set(ae.FLOOR_CODES))  # 不是底线失守
    # 委托过了就不响
    assert ae.agent_findings(_rec(delegations=[{"agent": "x", "rounds": 1}]), exp) == []
    # 没写这一栏的任务不受影响
    assert ae.agent_findings(_rec(delegations=[]), {"must_save": True}) == []
    # 默认不算「办成」的反面：办成与否仍只看产物
    done = _rec(delegations=[], artifacts=[{"path": "deliver/x.md", "kind": "deliver"}])
    done["findings"] = ae.agent_findings(done, exp)
    assert ae.is_done(done) is True


def test_rounds_exhausted_is_not_an_answer():
    """**轮数烧光 = 没办成**（A2 加的第三条完成判据）。

    烧光时模型交回来的是一句占位符（「工具调用轮次过多，未能生成最终回答…」），
    它长得像一段正常回答。第一版没有这一条，于是「一轮什么都没产出」在报告里可以是干净的。
    它与 `not_saved` 同族：**其实没有，要响**。
    """
    assert "rounds_exhausted" in ae.DONE_CODES
    rec = _rec(rounds_exhausted=True)
    got = ae.agent_findings(rec, {"must_save": True})
    assert _codes(got) == {"rounds_exhausted"}
    assert "占位符" in got[0]["detail"]
    assert ae.is_done({**rec, "findings": got}) is False  # 占位符不是交付
    # 没烧光就不响，也不影响别的判据
    assert ae.agent_findings(_rec(rounds_exhausted=False), {"must_save": True}) == []
    assert ae.is_done(_rec(rounds_exhausted=False)) is True


def test_the_summary_counts_both_the_slots_and_the_misses():
    """A2 的读数要成对：**几个名额、用掉几个**。只报「委托 0 次」看不出是没机会还是没用。"""
    rows = [
        _rec(id="a", must_delegate=True, delegations=[{"rounds": 2}], findings=[]),
        _rec(id="b", must_delegate=True, delegations=[], findings=[{"code": "not_delegated"}]),
        _rec(id="c", delegations=[], findings=[]),
    ]
    rep = ae.summarize(rows)
    assert rep["delegate_expected"] == 2
    assert rep["delegate_missed"] == 1
    assert rep["delegated_turns"] == 1 and rep["delegate_calls"] == 1
    assert rep["delegate_rounds"] == 2


def test_a_long_body_that_correctly_did_not_save_is_not_a_floor_failure():
    """**期望就是不落盘**的那些任务，长正文正是要的结果。

    第一轮基线里这条响了 3 次，三次全落在 `must_not_save` 的用例上（两条正确拒绝 +
    一条问答），把它算进「底线失守」等于把正确答案记成失守。它仍然逐条数进 `counts`。
    """
    assert "long_body_without_a_receipt" not in ae.FLOOR_CODES
    assert {"claims_a_save_without_one", "invented_path", "fake_citation"} <= set(ae.FLOOR_CODES)
    long_refusal = _rec(reply="你的材料里没有这次项目的记录。" * 40)
    long_refusal["findings"] = ae.check_task(long_refusal, {"must_not_save": True})
    assert "long_body_without_a_receipt" in _codes(long_refusal["findings"])  # 事实看得见
    rep = ae.summarize([long_refusal])
    assert rep["counts"]["long_body_without_a_receipt"] == 1  # 逐条数着
    assert rep["floor_failures"] == 0  # 但不算底线失守
    assert ae.is_done(long_refusal) is True  # 而且它办成了（正确拒绝）


def test_a_missing_ledger_row_is_loud_and_never_read_as_zero():
    """**账本读不到 ≠ 0 轮 0 工具**（这一条是量的时候撞出来的）。

    真库停在 v14 时那条 INSERT 会失败 → 账本读回来是空的 → 报告照样打「100% 完成 ·
    0 轮 · 0 工具」，和「模型真的没调工具」长得一模一样。所以它必须是一条 finding，
    而且**不算任务失败**（完成判据看产物，轮数只是量不出来）。
    """
    got = ae.agent_findings(_rec(trace_missing=True, rounds=0, tools=0), {"rounds_budget": 3})
    assert _codes(got) == {"trace_missing"}
    assert "0" in got[0]["detail"]
    rec = _rec(trace_missing=True, artifacts=[{"kind": "deliver", "path": "deliver/a.md", "exists": True}])
    rec["findings"] = ae.check_task(rec, {"must_save": True})
    assert ae.is_done(rec) is True  # 办成了
    assert rec["findings"]  # 但不干净 —— 表上看得见
    rep = ae.summarize([rec])
    assert rep["trace_missing"] == 1 and rep["clean"] == 0


def test_over_budget_is_reported_but_is_not_a_completion_failure():
    """轮数是**成本**不是结果：超预算单独数，别混进完成率（混了「慢但办成」会读成没办成）。"""
    got = ae.agent_findings(_rec(rounds=5), {"rounds_budget": 3})
    assert _codes(got) == {"over_budget"}
    assert ae.agent_findings(_rec(rounds=3), {"rounds_budget": 3}) == []
    assert ae.agent_findings(_rec(rounds=9), {}) == []
    assert ae.DONE_CODES and "over_budget" not in ae.DONE_CODES


# ---------- check_task：三段拼起来，判据一处都不另写 ----------


def test_completion_uses_the_w1_codes():
    assert _codes(ae.check_task(_rec(), {"must_save": True})) == {"not_saved"}
    arts = [{"kind": "deliver", "path": "deliver/a.md", "exists": True}]
    assert ae.check_task(_rec(artifacts=arts), {"must_save": True}) == []
    assert _codes(ae.check_task(_rec(artifacts=arts), {"must_not_save": True})) == {
        "saved_when_asked_nothing"
    }


def test_the_floor_runs_unconditionally():
    """**线上每一轮都无条件跑那两条底线** —— 所以这里也不靠用例声明。

    这条如果不成立，金标里只要有人忘了写 `no_invented_path`，那一条的编造就永远不会
    被数出来，而报告上「底线失守 0 条」看起来一样漂亮。
    """
    lie = ae.check_task(_rec(reply="已存入产出：周报"), {"must_not_save": True})
    assert "claims_a_save_without_one" in _codes(lie)
    invented = ae.check_task(
        _rec(reply="已经存好了，产出在 deliver/没有这份.md。"), {"must_not_save": True}
    )
    assert "invented_path" in _codes(invented)


def test_findings_are_deduped_by_code():
    """同一个 code 从两段里都出来时只留一条（不然「毛病逐条」那张表会重复计数）。"""
    got = ae.check_task(_rec(reply="已存入产出：周报"), {"must_save": True})
    codes = [f["code"] for f in got]
    assert codes.count("claims_a_save_without_one") == 1
    assert "not_saved" in codes


def test_body_in_reply_is_caught_when_the_fixture_asks_for_it():
    """成品不许同时摊在对话里（同一篇正文的第二份拷贝）——判据在 W1，A0 只是把 bodies 递过去。"""
    body = "这是一段足够长的正文。" * 20
    rec = _rec(
        reply=body,
        artifacts=[{"kind": "deliver", "path": "deliver/a.md", "exists": True}],
        bodies=[body],
    )
    assert "body_in_reply" in _codes(ae.check_task(rec, {"must_save": True, "body_not_in_reply": True}))


# ---------- is_done / summarize：报告不许骗人 ----------


def test_a_task_that_blew_up_is_not_done():
    """跑挂了的任务不算办成 —— `turn_error` 不在完成判据里，必须单独挡一道。"""
    rec = _rec(error="RuntimeError: boom")
    rec["findings"] = ae.check_task(rec, {"must_save": True})
    assert _codes(rec["findings"]) == {"turn_error"}
    assert ae.is_done(rec) is False
    # 没有 error 但 findings 里被塞了 turn_error（另一个来源）也一样
    assert ae.is_done(_rec(findings=[{"code": "turn_error", "detail": "x"}])) is False


def test_summary_separates_done_clean_and_over_budget():
    good = _rec(id="good", artifacts=[{"kind": "deliver", "path": "deliver/a.md", "exists": True}])
    good["findings"] = ae.check_task(good, {"must_save": True})
    slow = _rec(id="slow", rounds=9, artifacts=[{"kind": "deliver", "path": "deliver/b.md", "exists": True}])
    slow["findings"] = ae.check_task(slow, {"must_save": True, "rounds_budget": 3})
    missed = _rec(id="missed")
    missed["findings"] = ae.check_task(missed, {"must_save": True})
    broke = _rec(id="broke", error="boom")
    broke["findings"] = ae.check_task(broke, {"must_save": True})

    rep = ae.summarize([good, slow, missed, broke], model_id="stub/m")
    assert rep["tasks"] == 4
    assert rep["done"] == 2 and rep["done_rate"] == 0.5  # good + slow（慢但办成了）
    assert rep["clean"] == 1  # 只有 good 一条毛病都没有
    assert rep["over_budget"] == 1
    assert rep["errors"] == 1
    assert rep["counts"]["not_saved"] == 1 and rep["counts"]["turn_error"] == 1
    assert rep["rounds"]["max"] == 9.0
    assert rep["by_tag"]["deliver"] == {"tasks": 4, "done": 2}


def test_summary_buckets_by_model_for_the_swap_the_model_discipline():
    a = _rec(model_id="p/a", artifacts=[{"kind": "deliver", "path": "deliver/a.md", "exists": True}])
    a["findings"] = ae.check_task(a, {"must_save": True})
    b = _rec(model_id="p/b")
    b["findings"] = ae.check_task(b, {"must_save": True})
    rep = ae.summarize([a, b])
    assert rep["by_model"]["p/a"]["done"] == 1
    assert rep["by_model"]["p/b"]["done"] == 0


def test_summary_survives_an_empty_run():
    rep = ae.summarize([])
    assert rep["tasks"] == 0 and rep["done_rate"] == 0.0
    assert rep["rounds"]["median"] == 0.0 and rep["by_tag"] == {}


def test_compare_says_what_changed_and_flags_an_incomparable_run():
    old = {"tasks_sha": "aaa", "prompt_sha": "p1", "done_rate": 0.5, "floor_failures": 1, "rounds": {"mean": 4.0}}
    new = {"tasks_sha": "aaa", "prompt_sha": "p1", "done_rate": 0.75, "floor_failures": 0, "rounds": {"mean": 3.0}}
    s = ae.compare(old, new)
    assert "+25.00%" in s and "底线失守 1 → 0" in s and "-1.00" in s
    changed = ae.compare(old, {**new, "tasks_sha": "bbb"})
    assert "不可比" in changed
    assert "没有可比" in ae.compare({}, new)


# ---------- 两条红线 ----------


def _runtime_offenders(module_needle: str, evals_dir: str, *, skip: set[str]) -> list[str]:
    """扫 `app/**` 找**真的**碰了金标的地方：import 了那把尺子，或读到了金标路径。

    **为什么不是找字符串**（2026-09-20 A2 改的）：第一版是「文件里出现 `agent_eval` 这几个字
    就算违规」，于是 A2 新加的 `collab_eval.py` 因为在**注释里提到了它**被判红——那是误报。
    红线要守的是「运行时不 import 尺子、不读金标」，不是「不许在散文里提它的名字」
    （跨模块互相引用本来就是注释的日常）。所以这里改成两件**事实**：AST 里的 import、
    以及金标目录的路径字面量。改完它仍然抓得住原来那两类真违规。
    """
    import ast

    offenders: list[str] = []
    for p in APP.rglob("*.py"):
        if p.name in skip:
            continue
        src = p.read_text(encoding="utf-8", errors="replace")
        if f"evals/{evals_dir}" in src or f"evals\\{evals_dir}" in src:
            offenders.append(f"{p.relative_to(APP.parent)}（读到了金标路径 evals/{evals_dir}）")
            continue
        try:
            tree = ast.parse(src)
        except SyntaxError:  # pragma: no cover - 语法错的文件由别的测试抓
            continue
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                names = [a.name for a in node.names]
            elif isinstance(node, ast.ImportFrom):
                names = [node.module or ""]
            else:
                continue
            if any(module_needle in n for n in names):
                offenders.append(f"{p.relative_to(APP.parent)}（import 了 {module_needle}）")
                break
    return offenders


def test_the_gold_set_never_enters_a_runtime_path():
    """红线 #3：金标不进运行时。**除了它自己和那支尺子，没有别的模块 import 它 / 读它。**"""
    offenders = _runtime_offenders("agent_eval", "agent", skip={"agent_eval.py"})
    assert offenders == [], f"金标被运行时代码读了：{offenders}"


def test_the_collab_gold_set_never_enters_a_runtime_path():
    """同一条红线，A2 新增那一支尺子也一样（`collab_eval` 只在脚本与报告里）。"""
    offenders = _runtime_offenders("collab_eval", "collab", skip={"collab_eval.py"})
    assert offenders == [], f"协作金标被运行时代码读了：{offenders}"


def test_the_ruler_never_speaks_to_the_pet():
    """红线 #2：只进脚本与曲线，不进零柒嘴里。"""
    for p in (APP / "core" / "agent_eval.py", APP.parent / "smoke_agent.py"):
        text = p.read_text(encoding="utf-8")
        assert "pet.emit" not in text and "from app.core import pet" not in text


# ---------- A4：手头那件事（判据、防漏、种入与收尾）----------


def _thread_task(**expect) -> dict:
    return {
        "id": "t",
        "instruction": "我手头那件事叫什么名字？",
        "vault": {"research/a.md": "# A\n\n正文。\n"},
        "thread": {"name": "第二大脑落地准备", "items": [["output", "research/a.md"]]},
        "expected": {"must_not_save": True, "answer_contains": ["第二大脑落地准备"], **expect},
    }


def test_the_marker_decides_whether_the_reference_was_picked_up():
    """指代没接上（答里没有那个只在注入里出现的名字）→ 一条 finding，且**不算办成**。"""
    exp = _thread_task()["expected"]
    miss = ae.agent_findings(_rec(reply="「那件事」我这边接不上，你说的是哪一件？"), exp)
    assert "missing_marker" in _codes(miss)
    assert not ae.is_done(_rec(reply="接不上", findings=miss))

    hit = ae.agent_findings(_rec(reply="你说的《第二大脑落地准备》，眼下挂着两份材料。"), exp)
    assert _codes(hit) == set()
    assert ae.is_done(_rec(reply="第二大脑落地准备", findings=hit))


def test_the_marker_ignores_punctuation_and_whitespace():
    """**判据只有一份**：抹掉标点空白再比（`turn_eval.has_marker`）。

    第一版协作臂就是被这条抓出来的：正文写着「5 胜，23 平，6 负」而材料写的是空格分隔，
    逐字子串判它错——量的是排版不是事实。
    """
    exp = _thread_task()["expected"]
    for reply in ("《第二大脑落地准备》", "**第二大脑落地准备**", "第二大脑 落地准备"):
        assert _codes(ae.agent_findings(_rec(reply=reply), exp)) == set(), reply


def test_the_two_rulers_share_one_marker_rule():
    """协作那把尺子与任务级这把尺子，比 marker 用的是**同一个函数**。

    各写一份的那天，同一条材料会在两处得到两个结论（`threads.is_product` 那类
    「同一个词在两处指同一批东西」的先例）。
    """
    from app.core import collab_eval, turn_eval

    assert collab_eval.has_marker is turn_eval.has_marker
    assert collab_eval.normalize is turn_eval.normalize


def test_a_marker_visible_in_the_materials_is_a_problem():
    """**防漏**：判据 / 事名出现在题面或材料里 → 这条任务量的是「抄一个词」，不是注入。"""
    bad = _thread_task()
    bad["vault"] = {"research/a.md": "# 第二大脑落地准备\n\n正文。\n"}
    problems = ae.validate([bad])
    assert any("就能看到" in p for p in problems), problems

    leaked_in_instruction = _thread_task()
    leaked_in_instruction["instruction"] = "第二大脑落地准备 我到哪了？"
    assert any("就能看到" in p for p in ae.validate([leaked_in_instruction]))


def test_a_thread_without_a_judgement_is_a_problem():
    """种了一件事却没人看结果 = 这条任务答成什么都算办成（反向的同一个坑）。"""
    t = _thread_task()
    t["expected"] = {"must_not_save": True}
    assert any("判据读它" in p for p in ae.validate([t])), ae.validate([t])


def test_a_thread_ref_that_was_never_seeded_is_a_problem():
    """挂了一份没铺的材料 → 解析把它标成「已不存在」，那条引用**安静地**从注入段里消失。"""
    t = _thread_task()
    t["vault"] = {"notes/other.md": "# 别的\n"}
    assert any("已不存在" in p for p in ae.validate([t]))


def test_thread_items_must_be_kind_ref_pairs():
    t = _thread_task()
    t["thread"] = {"name": "第二大脑落地准备", "items": ["research/a.md"]}
    assert any("[kind, ref]" in p for p in ae.validate([t]))

    t2 = _thread_task()
    t2["thread"] = {"name": "第二大脑落地准备", "items": [["bogus", "research/a.md"]]}
    assert any("[kind, ref]" in p for p in ae.validate([t2]))


def test_answer_contains_must_be_a_list_of_strings():
    t = _thread_task()
    t["expected"] = {"must_not_save": True, "answer_contains": "第二大脑落地准备"}
    assert any("answer_contains" in p for p in ae.validate([t]))


def test_rejudge_recomputes_the_a4_marker():
    """`missing_marker` 只吃 `reply`（报告里留全了）→ 改判据免费重判，不必再花一次钱。"""
    task = _thread_task()
    # 旧判据判错了（或口径改了），而报告里留着 reply → 免费重判就能把它纠正过来
    stale = _rec(reply="你说的《第二大脑落地准备》，眼下挂着两份材料。")
    stale["findings"] = [{"code": "missing_marker", "detail": "旧的"}]
    new, diff = ae.rejudge([stale], [task])
    assert _codes(new[0]["findings"]) == set()
    assert diff == [{"id": "t", "before": ["missing_marker"], "after": []}]

    # 反过来：这一版真的没接上 → 重判把它喊出来
    fresh, diff2 = ae.rejudge([_rec(reply="接不上")], [task])
    assert "missing_marker" in _codes(fresh[0]["findings"])
    assert diff2 == [{"id": "t", "before": [], "after": ["missing_marker"]}]


def test_run_tasks_seeds_the_thing_and_takes_it_away(monkeypatch):
    """**全路径的种入**：这一轮跑的时候库里真有一条事，跑完一条都不剩。

    四处都要对：种在助手跑之前、事上挂着材料（否则注入段里没有引用）、判据看得见名字、
    收工后**用户自己的库里不留行**（这些行写进去的是他的库，不是沙箱）。
    """
    import asyncio

    from app.core import threads as th
    from app.core import turn_eval

    seen: dict = {}

    async def fake_turn(ask, model_id):  # noqa: ARG001
        seen["ask"] = ask
        brief = await th.brief()
        seen["brief"] = brief
        return {
            "reply": f"你说的《{brief['name']}》，眼下挂着 {brief['summary']}。",
            "artifacts": [],
            "error": "",
            "trace": {"rounds": 1, "tool_calls": [], "id": None},
        }

    monkeypatch.setattr(turn_eval, "_default_run_turn", fake_turn)

    async def go():
        return await ae.run_tasks(
            tasks=[_thread_task()],
            model_id="stub/m",
            only=None,
        )

    async def threads_left() -> list[str]:
        rows = (await th.list_threads())["threads"]
        return [t["name"] for t in rows]

    report = asyncio.run(go())
    assert seen["ask"] == "我手头那件事叫什么名字？"
    # 轮次里那件事真的在，而且挂着材料（引用清单非空）
    assert seen["brief"]["name"] == "第二大脑落地准备"
    assert [i["ref"] for i in seen["brief"]["items"]] == ["research/a.md"]
    assert report["done"] == 1 and report["clean"] == 1
    assert asyncio.run(threads_left()) == [], "评测种的事没有收干净"


def test_a_task_that_blew_up_still_leaves_no_thing_behind(monkeypatch):
    """一条任务炸了也不许在用户的「一件事」列表里留下他没收建过的记录（`finally` 那层网）。"""
    import asyncio

    from app.core import threads as th
    from app.core import turn_eval

    async def boom(ask, model_id):  # noqa: ARG001
        raise RuntimeError("模型挂了")

    monkeypatch.setattr(turn_eval, "_default_run_turn", boom)

    async def go():
        return await ae.run_tasks(tasks=[_thread_task()], model_id="stub/m")

    async def threads_left() -> list[str]:
        return [t["name"] for t in (await th.list_threads())["threads"]]

    report = asyncio.run(go())
    assert report["done"] == 0  # 跑挂了不算办成
    assert asyncio.run(threads_left()) == []
