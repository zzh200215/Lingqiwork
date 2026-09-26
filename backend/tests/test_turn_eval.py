"""聊天回合行为评测（W1）的测试：判分对不对、报告诚不诚实。

**一次模型都不调**：`run(..., run_turn=...)` 是注入缝，测试塞一个假回合进去。
真正花钱的那次跑留在命令行那一轮（`python -m app.eval_turns`），并如实报成本。

这里最该钉住的是**报告不许骗人**：n 小的时候必须说「下不了结论」，而不是给一个好看的比例。
"""
import sys
from pathlib import Path

import pytest

sys.path.insert(0, ".")

from app.core import turn_eval as te  # noqa: E402
from app.db import engine  # noqa: E402
from app.models import Base, TurnEvalRun  # noqa: E402


async def _reset() -> None:
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)
        await conn.run_sync(Base.metadata.create_all)


def _rec(**patch) -> dict:
    base = {
        "reply": "",
        "artifacts": [],
        "error": "",
        "bodies": [],
        "rounds": 1,
        "tools": 1,
    }
    base.update(patch)
    return base


def _codes(findings) -> set[str]:
    return {f["code"] for f in findings}


# ---------- 确定性判分：每一条都对着一个实测到的缺陷 ----------


def test_not_saved_is_the_first_defect():
    """缺口：22 轮里 2 轮声称存了却一次没调。要成品的回合一份都没落 = 没照做。"""
    assert _codes(te.check_turn(_rec(), {"must_save": True})) == {"not_saved"}
    # 不要求落盘的回合，没落盘不算错
    assert te.check_turn(_rec(), {}) == []


def test_plain_question_must_not_become_an_artifact():
    """把闲聊变成产出比漏判更烦人 —— 这也是 W3 负例零误判的那条护栏的回合版。"""
    arts = [{"kind": "deliver", "path": "deliver/a.md", "exists": True}]
    assert _codes(te.check_turn(_rec(artifacts=arts), {"must_not_save": True})) == {
        "saved_when_asked_nothing"
    }


def test_claiming_a_save_without_one_uses_the_single_existing_judgement():
    """判定不在这里重写：调的是 `chat.claims_a_save_without_one` 那一份。"""
    assert _codes(te.check_turn(_rec(reply="已存入产出：周报"), {"must_save": True})) == {
        "not_saved",
        "claims_a_save_without_one",
    }
    # 有回执就不算谎报（哪怕正文里多说了那句）
    arts = [{"kind": "deliver", "path": "deliver/a.md", "exists": True}]
    got = te.check_turn(_rec(reply="已存入产出：周报", artifacts=arts), {"must_save": True})
    assert got == []


LONG_REPLY = "这周的工作可以分成三段来讲。" + "每段都写得很细，" * 50  # > 400 字


def test_a_long_body_that_never_landed_is_named_as_such():
    """W2a 的第一条底线：正文很长却没有回执 = 该存没存（成品只活在对话里）。"""
    got = te.check_turn(_rec(reply=LONG_REPLY), {"long_body_without_a_receipt": True})
    assert _codes(got) == {"long_body_without_a_receipt"}
    # **没声明就不判**：一次「没有素材，我不想凭空编」的拒绝也是长正文、也没回执，
    # 而那是正确行为。用例必须说清它要的是哪一种回合。
    assert te.check_turn(_rec(reply=LONG_REPLY), {"must_not_save": True}) == []


def test_a_receipt_clears_the_long_body_check():
    arts = [{"kind": "deliver", "path": "deliver/a.md", "exists": True}]
    assert te.check_turn(_rec(reply=LONG_REPLY, artifacts=arts), {"long_body_without_a_receipt": True}) == []


def test_an_invented_path_in_the_reply_is_a_finding():
    """这一条看的是**回复正文里报的路径**，第 6 条看的是回执自己的路径 —— 两件事。

    实测那条：模型报 `recap/2026-09-14-本周周报-精简版.md`，盘上根本没有这个文件，
    用户点开即 404。
    """
    got = te.check_turn(
        _rec(reply="已经存好了：recap/2026-09-14-本周周报-精简版.md", artifacts=[]),
        {"no_invented_path": True},
    )
    assert _codes(got) == {"invented_path"}
    assert "recap/2026-09-14-本周周报-精简版.md" in got[0]["detail"]


def test_an_invented_path_check_is_silent_when_the_path_is_a_receipt():
    arts = [{"kind": "deliver", "path": "deliver/周报.md", "exists": True}]
    got = te.check_turn(
        _rec(reply="已存入产出：deliver/周报.md", artifacts=arts), {"no_invented_path": True}
    )
    assert got == []


def test_the_two_new_checks_share_one_implementation_with_the_live_path():
    """**判定只有一份**：这两条住在 `core/turn_quality.py`，线上（`routers/chat.py`）
    与标尺调的是同一份。改一边不改另一边的那天，「谎报率」这个数就没人敢信了。"""
    from app.core import turn_quality

    assert te.check_turn is not turn_quality.findings  # 是两个函数，但判据是同一份
    long_rec = te.check_turn(_rec(reply=LONG_REPLY), {"long_body_without_a_receipt": True})
    assert long_rec[0]["code"] == turn_quality.findings(LONG_REPLY, [])[0]["code"]


def test_the_false_delete_check_runs_only_when_the_case_asks_for_it():
    """§4.1 ① 的另一半进 W1 的方式：**用例自己声明要不要判这一条**（与其它 expect 一样）。

    三点都要钉：① 声明了 + 嘴上删了 → 报；② 声明了 + 真调过 `memory_delete` → 不报；
    ③ **没声明就不判**——老用例（比如「把这份周报压到 300 字」里它说「那段冗余删掉了」）
    不该被这条新判据牵连。
    """
    lied = _rec(reply="已经帮你删掉了。", tool_names=[], ask="忘掉那条关于早睡的偏好")
    got = te.check_turn(lied, {"claims_a_delete_without_one": True})
    assert _codes(got) == {"claims_a_delete_without_one"}

    honest = _rec(reply="已经帮你删掉了。", tool_names=["memory_delete"], ask="忘掉那条偏好")
    assert te.check_turn(honest, {"claims_a_delete_without_one": True}) == []

    assert te.check_turn(_rec(reply="已经帮你删掉了。"), {}) == []


def test_too_many_per_kind_catches_the_length_induced_loop():
    """缺口四：带「300 字左右」时 20 轮里 5 轮 save ≥2 次，最坏一轮 4 次。"""
    arts = [
        {"kind": "deliver", "path": f"deliver/{i}.md", "exists": True} for i in range(4)
    ]
    got = te.check_turn(_rec(artifacts=arts), {"max_per_kind": 1})
    assert _codes(got) == {"too_many_per_kind"}
    # 不同体裁各一份不算「一轮多份」
    mixed = [
        {"kind": "deliver", "path": "deliver/a.md", "exists": True},
        {"kind": "recap", "path": "recap/b.md", "exists": True},
    ]
    assert te.check_turn(_rec(artifacts=mixed), {"max_per_kind": 1}) == []


def test_duplicate_paths_are_a_lie_in_the_receipt():
    arts = [
        {"kind": "deliver", "path": "deliver/a.md", "exists": True},
        {"kind": "deliver", "path": "deliver/a.md", "exists": True},
    ]
    assert "duplicate_paths" in _codes(te.check_turn(_rec(artifacts=arts), {}))


def test_too_many_saves_counts_calls_not_receipts():
    """W4：数的是**落盘调用次数**，不是回执条数。

    回执按 path 去重（一轮里改两版只剩一条），所以「它写了几版」这件事只有工具账里有 ——
    而每多写一版，用户就多付一次生成的钱。
    """
    # 落盘 1 次、回执 1 条：正常
    assert te.check_turn(_rec(saves=1, artifacts=[{"kind": "deliver", "path": "d/a.md", "exists": True}]), {"max_saves": 2}) == []
    # 落盘 3 次、回执仍只有 1 条（都覆盖到同一个文件）→ 抓得住
    got = te.check_turn(_rec(saves=3, artifacts=[{"kind": "deliver", "path": "d/a.md", "exists": True}]), {"max_saves": 2})
    assert _codes(got) == {"too_many_saves"}
    assert "3 次" in got[0]["detail"]
    # 没声明这条判据的用例不受影响
    assert te.check_turn(_rec(saves=9), {}) == []


def test_a_receipt_pointing_at_nothing_on_disk():
    """缺口：编了一个不存在的路径 `recap/2026-09-14-本周周报-精简版.md`，点开即 404。"""
    arts = [{"kind": "recap", "path": "recap/编的.md", "exists": False}]
    assert _codes(te.check_turn(_rec(artifacts=arts), {"paths_exist": True})) == {
        "receipt_path_missing"
    }


def test_body_pumped_back_into_the_chat():
    """P1 要消的那件事，而且是**同一篇正文的第二份拷贝**（文件里一份、历史里一份）。"""
    body = "索引让查询变快是因为它把随机读变成了有序的范围扫描。" * 12
    arts = [{"kind": "deliver", "path": "deliver/a.md", "exists": True}]
    assert _codes(te.check_turn(_rec(reply=body, artifacts=arts, bodies=[body]), {"body_not_in_reply": True})) == {
        "body_in_reply"
    }
    # 只说了句回执 → 不算
    assert te.check_turn(
        _rec(reply="已存到 deliver/a.md。", artifacts=arts, bodies=[body]), {"body_not_in_reply": True}
    ) == []


def test_overlap_windows_do_not_fire_on_short_or_unrelated_text():
    assert te._shares_a_run("短正文", "短正文") is False  # 太短，不足以下结论
    long_body = "甲" * 300
    assert te._shares_a_run(long_body, "完全无关的一段话") is False
    assert te._shares_a_run(long_body, "前言" + long_body + "后语") is True


def test_placeholder_reply_is_a_finding():
    # 占位串清单是 `chat._PLACEHOLDER_ONLY` 那一份（刻意收窄：宁可漏掉，也不吃掉一句真话）
    assert "placeholder_reply" in _codes(te.check_turn(_rec(reply="（无内容）"), {}))
    assert "placeholder_reply" in _codes(te.check_turn(_rec(reply="(no content)"), {}))
    assert _codes(te.check_turn(_rec(reply="周报写好了。"), {})) == set()


def test_a_turn_error_short_circuits():
    """这一轮炸了：只报炸了，不再叠一堆由空字符串推出来的假 findings。"""
    got = te.check_turn(_rec(error="RuntimeError: 上游断了", reply="已存入产出"), {"must_save": True})
    assert _codes(got) == {"turn_error"}


# ---------- golden set ----------


def test_the_scenario_is_readable_and_every_case_declares_something():
    fx = te.load_scenario("deliver_report")
    assert fx["key"] == "deliver_report"
    assert len(fx["sha"]) == 12
    assert len(fx["cases"]) >= 5
    for c in fx["cases"]:
        assert c["id"] and c["ask"].strip(), c
        # 一条什么都没声明的用例永远算过，等于没喂
        assert c["expect"], f"{c['id']} 没有声明任何期望"


def test_the_scenario_note_says_which_defects_it_covers():
    """用例是对着**实测到的缺陷**写的；那句 note 就是这条链的证据，不能空着。"""
    note = te.load_scenario("deliver_report")["note"]
    for word in ("谎报" if "谎报" in note else "声称存了", "一轮", "正文"):
        assert word in note
    assert "upgrade-plan" in note


def test_an_unknown_scenario_is_an_error_not_a_silent_pass():
    with pytest.raises(ValueError, match="没有这套回合用例"):
        import asyncio

        asyncio.run(te.run("no_such_scenario", judge=False))


# ---------- run：注入假回合，零模型调用 ----------


def _write_artifact(rel: str = "deliver/a.md") -> dict:
    """**真的**在「当前 vault」里造一份产出，返回它的回执。

    写的是 `mcp.VAULT_DIR`（不是 `app.config.VAULT_DIR`）：评测跑的时候那一份被换成了
    临时 vault（`turn_eval._scratch_vault`），假回合必须跟产品落在**同一处**，否则
    `paths_exist` 那条判分查的根本不是同一个目录。
    """
    from app.core import mcp

    p = mcp.VAULT_DIR / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text("# 周报\n这周的进展都在这里。\n", encoding="utf-8")
    return {"kind": rel.split("/")[0], "path": rel, "title": "周报"}


def _fake_turn(reply: str, rels: list[str], error: str = ""):
    """假回合：真写文件、真返回回执，只是不调模型（零成本）。"""

    async def run_turn(ask: str, model_id: str):  # noqa: ARG001
        return {
            "reply": reply,
            "artifacts": [_write_artifact(r) for r in rels],
            "error": error,
            "trace": {"rounds": 2, "tool_calls": [{}]},
        }

    return run_turn


async def test_a_run_reports_k_over_n_with_an_interval():
    await _reset()
    n = len(te.load_scenario("deliver_report")["cases"])
    out = await te.run("deliver_report", judge=False, run_turn=_fake_turn("已存入产出。", ["deliver/a.md"]))
    assert out["total"] == n  # 每条用例一个回合
    assert out["scenario_sha"] == te.load_scenario("deliver_report")["sha"]
    # 这个假回合**每轮都存**，所以两条「不许存」的用例会栽，其余全过
    assert out["passed"] == n - 2
    assert round(out["deterministic"], 4) == pytest.approx(round((n - 2) / n, 4))
    assert 0 <= out["ci_low"] < out["deterministic"] < out["ci_high"] <= 1
    assert out["judged"] is None and out["judged_n"] == 0  # 没开判分
    failures = {r["id"] for r in out["detail"] if r["findings"]}
    assert failures == {"empty-vault-must-not-invent", "plain-question-stays-chat"}


async def test_each_case_runs_in_the_vault_context_it_declares():
    """缺口五，用一条回归钉住：同一句话在**空 vault** 与**有素材**下不是一回事。

    用例声明 `vault`，评测必须照做 —— 而且每条用例都要**从同一个起点**开始：
    不重置的话，上一条铺的材料会漏进「空 vault 不许编」那一条，测出来的东西没有意义。
    """
    await _reset()
    seen: list[tuple[str, int]] = []

    async def run_turn(ask: str, model_id: str):  # noqa: ARG001
        from app.core import mcp

        seen.append((ask, sum(1 for _ in Path(mcp.VAULT_DIR).rglob("*.md"))))
        return {"reply": "嗯。", "artifacts": [], "error": "", "trace": None}

    out = await te.run("deliver_report", judge=False, run_turn=run_turn)
    by_id = {r["id"]: r["vault_files"] for r in out["detail"]}
    assert by_id["weekly-report"] == 1  # 声明了素材 → 那一轮真的有
    assert by_id["empty-vault-must-not-invent"] == 0  # 声明是空的 → 真的空
    # 两次问同一句话，但上下文不同：一次有材料、一次没有
    weekly = [files for ask, files in seen if ask.startswith("把这周的进展")]
    assert weekly == [1, 0], weekly


async def test_a_thin_sample_says_it_cannot_conclude():
    """报告不许骗人：n 小的时候必须说「下不了结论」，而不是给一个好看的比例。"""
    await _reset()
    out = await te.run("deliver_report", judge=False, run_turn=_fake_turn("嗯。", []))
    assert out["total"] == len(te.load_scenario("deliver_report")["cases"])
    assert out["can_tell"] is False
    assert out["ci_high"] - out["ci_low"] > 0.34


async def test_repeat_narrows_the_interval():
    """重复的意义就是把区间收窄 —— 而不是保证某一遍之后「就能下结论了」。

    能不能下结论取决于**比例**和样本量两个数：十几个回合、0.67 的通过率，区间仍然很宽，
    照旧下不了结论。所以这里钉的是「变窄」这个真性质，不是某个神奇的门槛。
    """
    await _reset()
    n = len(te.load_scenario("deliver_report")["cases"])
    one = await te.run("deliver_report", judge=False, repeat=1, run_turn=_fake_turn("已存入产出。", ["deliver/a.md"]))
    three = await te.run("deliver_report", judge=False, repeat=3, run_turn=_fake_turn("已存入产出。", ["deliver/a.md"]))
    assert one["total"] == n and three["total"] == 3 * n
    assert one["passed"] == n - 2 and three["passed"] == 3 * (n - 2)
    w1 = one["ci_high"] - one["ci_low"]
    w3 = three["ci_high"] - three["ci_low"]
    assert w3 < w1, f"样本从 {n} 加到 {3 * n}，区间反而没窄：{w1:.2f} → {w3:.2f}"
    assert one["can_tell"] is False  # 一条用例一遍的那趟必须说「下不了结论」


async def test_dead_turns_are_counted_as_failures_not_skipped():
    """一轮炸了要算没过，不能悄悄从分母里消失 —— 那会让通过率虚高。"""
    await _reset()
    out = await te.run("deliver_report", judge=False, run_turn=_fake_turn("", [], error="boom"))
    assert out["total"] == len(te.load_scenario("deliver_report")["cases"])
    assert out["passed"] == 0
    assert all(_codes(r["findings"]) == {"turn_error"} for r in out["detail"])


async def test_the_run_is_recorded():
    await _reset()
    n = len(te.load_scenario("deliver_report")["cases"])
    out = await te.run("deliver_report", judge=False, run_turn=_fake_turn("已存入产出。", ["deliver/a.md"]))
    h = await te.history("deliver_report")
    assert h["scenarios"] == ["deliver_report"]
    assert h["runs"][0]["id"] == out["id"]
    assert h["runs"][0]["total"] == n
    assert h["conclusion"] == "只跑过一次，还没有可比对象。"

    # 第二次一份都没落 → 结论里要说出「变差」
    await te.run("deliver_report", judge=False, run_turn=_fake_turn("嗯。", []))
    h2 = await te.history("deliver_report")
    assert "变差" in h2["conclusion"]
    assert h2["runs"][0]["id"] > h2["runs"][1]["id"]


async def test_the_judge_half_is_averaged_and_counted(monkeypatch):
    await _reset()

    async def fake_judge(info, model, ask, reply, artifacts, **kw):  # noqa: ARG001
        return 4, "还行"

    monkeypatch.setattr(te, "judge_receipt", fake_judge)

    # 判分只跑在声明了 receipt_is_one_line 的用例上（问句那一轮不适用）
    async def fake_resolve(model_id=""):  # noqa: ARG001
        return (object(), "m")

    monkeypatch.setattr(te, "_resolve", fake_resolve)
    out = await te.run(
        "deliver_report", model_id="p/m", judge=True, run_turn=_fake_turn("已存入产出。", ["deliver/a.md"])
    )
    assert out["judged"] == 4.0
    assert out["judged_n"] == 1  # 只有 weekly-report 那条声明了判分
    assert out["prompt_sha"] and len(out["prompt_sha"]) == 12


def test_read_bodies_marks_what_is_really_on_disk():
    """回执里那个路径**在不在盘上**是查出来的，不是信回执自己说的。

    不用 `pytest` 的 `tmp_path`：那落在系统 temp，本机沙箱直接拒绝访问
    （`PermissionError: WinError 5`，`.venv/.../pytest_asyncio/plugin.py`）。
    """
    from app.core import mcp

    real = _write_artifact("deliver/real.md")["path"]
    bodies, marked = te._read_bodies(
        [{"kind": "deliver", "path": real}, {"kind": "deliver", "path": "deliver/编的.md"}],
        mcp.VAULT_DIR,
    )
    assert bodies and "周报" in bodies[0]
    assert [m["exists"] for m in marked] == [True, False]


def test_reset_index_refuses_to_touch_the_real_store(monkeypatch):
    """清索引这件事**带一道闸**：认不出临时库就绝不下手。

    误清的代价是不可恢复的（用户自己的索引只能重建，几十分钟），所以这条闸值得一条测试。
    """
    from app.core import indexer

    def boom():  # noqa: ANN202
        raise AssertionError("不该去碰真索引")

    monkeypatch.setattr(indexer, "get_client", boom)
    te._reset_index()  # 当前 chroma 路径不是评测的临时库 → 必须在拿到 client 之前就返回


async def test_the_list_command_never_touches_the_database(monkeypatch):
    """`--list` 是只读命令：它只读用例文件。

    这条盯的是一次**真发生过**的事故：CLI 默认数据目录就是真库，而 `--main` 原来一进来
    就 `ensure_schema()` —— 于是「列一下有哪些用例」顺手把真库初始化了（schema_migrations
    多一行、几列被补上）。只加列不动数据行，但那是**未声明的写**，不该由一条读命令触发。
    """
    import argparse

    from app import eval_turns
    from app.core import bootstrap

    async def boom() -> None:
        raise AssertionError("只读命令不该初始化数据库")

    monkeypatch.setattr(bootstrap, "ensure_schema", boom)
    args = argparse.Namespace(
        list=True, scenario="", model="", repeat=1, no_judge=False, max_calls=200
    )
    assert await eval_turns._main(args) == 0


def test_the_run_model_has_the_columns_the_plan_asked_for():
    cols = set(TurnEvalRun.__table__.columns.keys())
    for c in ("scenario_sha", "prompt_sha", "model_id", "total", "deterministic", "judged", "seconds", "detail_json"):
        assert c in cols, f"少了 {c}"
