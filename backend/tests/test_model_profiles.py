"""模型画像（W7）的测试：**纪律那一半最要紧** —— 没有基线的画像不许生效。

三层：
1. 校验：越界的 temperature / max_rounds、没见过的 tool_choice 一律拒绝（错在写库之前）。
2. 纪律：没有基线 → 回落默认并说明原因；挂上基线 → 生效；改了画像 → 留一条 append-only
   的改动记录（「改画像有前后对照」）。
3. 接到产品上：`give_output_rule=False` 时那一轮真的不给输出规矩；`max_rounds` 真的限住轮数；
   账本里记着这一轮用的是哪份策略、有没有生效。
"""
import asyncio
import sys

import pytest

sys.path.insert(0, ".")

from app.core import model_profiles as mp  # noqa: E402
from app.db import engine  # noqa: E402
from app.models import Base  # noqa: E402

MODEL = "stub/m"


async def _reset() -> None:
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)
        await conn.run_sync(Base.metadata.create_all)


def _run(coro):
    return asyncio.run(coro)


# ---------- 1. 校验 ----------


def test_out_of_range_values_are_refused():
    for bad in ({"temperature": 3.0}, {"temperature": -0.1}, {"max_rounds": 0}, {"max_rounds": 99}):
        with pytest.raises(mp.ProfileError):
            mp.validate(bad)


def test_unknown_enum_values_are_refused():
    with pytest.raises(mp.ProfileError):
        mp.validate({"tool_choice": "sometimes"})
    with pytest.raises(mp.ProfileError):
        mp.validate({"length_policy": "裁剪"})


def test_empty_values_mean_the_default():
    out = mp.validate({"temperature": "", "max_rounds": None, "tool_choice": ""})
    assert out == {"temperature": None, "max_rounds": None, "tool_choice": ""}


def test_a_typo_in_the_number_says_which_field():
    with pytest.raises(mp.ProfileError) as e:
        mp.validate({"max_rounds": "六"})
    assert "max_rounds" in str(e.value)


# ---------- 2. 纪律：没有基线不生效 ----------


def test_a_profile_without_a_baseline_does_not_take_effect():
    """**W7 的核心纪律。** plan 的原话是「每个画像必须有一条 W1 跑出来的行为基线，否则不许上线」；
    这里翻译成「不生效 + 说明原因」，而不是「不许用这个模型」—— 把模型挡掉的代价落在用户头上，
    而一个没量过的 temperature 只是让行为回到默认。"""
    class Row:
        baseline_run_id = None
        temperature = 0.1
        max_rounds = 3
        tool_choice = "required"
        force_structure = True
        supports_structure = True
        length_policy = "truncate"
        give_output_rule = False
        notes = ""

    eff = mp.effective_from(Row())
    assert eff["source"] == "default"
    assert eff["temperature"] is None and eff["max_rounds"] is None
    assert eff["give_output_rule"] is True  # 输出规矩照给
    assert "还没有 W1 基线" in eff["why"]


def test_no_profile_at_all_is_also_default():
    eff = mp.effective_from(None)
    assert eff["source"] == "default" and eff["why"] == "没有画像"


def test_with_a_baseline_the_profile_takes_effect():
    class Row:
        baseline_run_id = 7
        temperature = 0.2
        max_rounds = 4
        tool_choice = ""
        force_structure = True
        supports_structure = True
        length_policy = "revise"
        give_output_rule = False
        notes = ""

    eff = mp.effective_from(Row())
    assert eff["source"] == "profile" and eff["max_rounds"] == 4
    assert eff["give_output_rule"] is False and eff["force_structure"] is True
    assert "基线 #7" in eff["why"]


def test_forced_structure_needs_both_want_and_capability():
    """想走强制结构化 ≠ 这个 provider 做得到。**默认假设做不到**（W2b 要按 provider 灰度）。"""
    class Wants:
        baseline_run_id = 1
        temperature = None
        max_rounds = None
        tool_choice = ""
        force_structure = True
        supports_structure = False
        length_policy = ""
        give_output_rule = True
        notes = ""

    assert mp.effective_from(Wants())["force_structure"] is False


# ---------- 3. 写画像 / 挂基线 / 改动历史 ----------


def test_saving_records_what_changed_and_keeps_the_old_version():
    async def go():
        await _reset()
        await mp.save(MODEL, {"temperature": 0.3, "max_rounds": 6}, note="第一版")
        await mp.save(MODEL, {"temperature": 0.5}, note="压一压循环")
        return await mp.history(MODEL)

    rows = _run(go())
    assert len(rows) == 2, "两次改动两条记录（append-only）"
    newest, oldest = rows[0], rows[1]
    assert newest["changed"] == {"temperature": [0.3, 0.5]}
    assert newest["note"] == "压一压循环"
    assert oldest["changed"]["temperature"] == [None, 0.3]
    assert oldest["changed"]["max_rounds"] == [None, 6]


def test_saving_the_same_value_writes_nothing():
    async def go():
        await _reset()
        await mp.save(MODEL, {"temperature": 0.3})
        out = await mp.save(MODEL, {"temperature": 0.3})
        return out, await mp.history(MODEL)

    out, rows = _run(go())
    assert out["changed"] == {} and "没有变化" in out["note"]
    assert len(rows) == 1


def test_blessing_a_run_creates_the_baseline_and_makes_the_profile_effective():
    async def go():
        await _reset()
        from app.db import SessionLocal
        from app.models import TurnEvalRun

        async with SessionLocal() as db:
            db.add(
                TurnEvalRun(
                    scenario="deliver_report",
                    scenario_sha="abc",
                    prompt_sha="def",
                    model_id=MODEL,
                    total=6,
                    deterministic=1.0,
                    judged=5.0,
                    seconds=203.1,
                    detail_json='[{"tokens_out": 900}, {"tokens_out": 1100}]',
                )
            )
            await db.commit()
        await mp.save(MODEL, {"temperature": 0.2, "max_rounds": 4})
        before = await mp.effective(MODEL)
        status = await mp.bless(MODEL)
        after = await mp.effective(MODEL)
        return before, status, after, await mp.history(MODEL)

    before, status, after, rows = _run(go())
    assert before["source"] == "default", "挂之前不生效"
    assert after["source"] == "profile" and after["max_rounds"] == 4
    assert status["pass"] == 6 and status["total"] == 6
    assert status["ci"][0] < status["ci"][1]
    assert status["seconds"] == 203.1
    assert status["tokens_out_per_turn"] == 1000.0  # 成本那一项 = 每轮输出 token 的均值
    assert rows[0]["baseline_run_id"] and "挂上基线" in rows[0]["note"]


def test_blessing_refuses_a_run_from_another_model():
    async def go():
        await _reset()
        from app.db import SessionLocal
        from app.models import TurnEvalRun

        async with SessionLocal() as db:
            row = TurnEvalRun(
                scenario="s", scenario_sha="a", prompt_sha="b", model_id="other/m",
                total=6, deterministic=1.0, seconds=1.0, detail_json="[]",
            )
            db.add(row)
            await db.commit()
            await db.refresh(row)
        # 明确指定那条跑分：这时才谈得上「不是这个模型的」
        return await mp.bless(MODEL, row.id)

    with pytest.raises(mp.ProfileError) as e:
        _run(go())
    assert "other/m" in str(e.value)


def test_blessing_without_any_run_says_what_to_do():
    async def go():
        await _reset()
        return await mp.bless(MODEL)

    with pytest.raises(mp.ProfileError) as e:
        _run(go())
    assert "eval_turns" in str(e.value)


def test_in_use_comes_from_the_enabled_providers_not_from_guesswork():
    async def go():
        await _reset()
        from app.db import SessionLocal
        from app.models import ProviderConfig

        async with SessionLocal() as db:
            db.add(ProviderConfig(name="on", kind="openai", enabled=True, models=["m1", "m2"]))
            db.add(ProviderConfig(name="off", kind="openai", enabled=False, models=["m3"]))
            await db.commit()
        return await mp.in_use()

    assert _run(go()) == ["on/m1", "on/m2"]


def test_overview_says_who_has_a_baseline_and_who_does_not():
    async def go():
        await _reset()
        from app.db import SessionLocal
        from app.models import ProviderConfig

        async with SessionLocal() as db:
            db.add(ProviderConfig(name="on", kind="openai", enabled=True, models=["m1"]))
            await db.commit()
        return await mp.overview()

    out = _run(go())
    assert [m["model_id"] for m in out["models"]] == ["on/m1"]
    m = out["models"][0]
    assert m["has_profile"] is False and m["has_baseline"] is False
    assert m["effective"]["source"] == "default"


# ---------- 4. CLI：`--list` 是只读的 ----------


def test_the_list_command_never_touches_the_database(monkeypatch):
    """`--list` 不该建表、不该迁移 —— §11 那次「只读命令碰了真库」的同类事故。

    与 `eval_turns --list` 那条测试同一形状：把 `ensure_schema` 换成会炸的东西，
    只读分支必须照样跑完。
    """
    import argparse

    from app import model_check
    from app.core import bootstrap

    async def boom() -> None:
        raise AssertionError("只读命令不该初始化数据库")

    monkeypatch.setattr(bootstrap, "ensure_schema", boom)

    async def go():
        await _reset()
        return await model_check._main(
            argparse.Namespace(
                list=True, set="", bless="", history="", run_id=None, temperature=None,
                max_rounds=None, tool_choice="", length_policy=None, output_rule=None,
                force_structure=None, supports_structure=None, note="", limit=20,
            )
        )

    assert _run(go()) == 0


def test_the_list_command_exits_nonzero_when_a_model_has_no_baseline(monkeypatch):
    """「每个在用模型都必须有基线」是纪律 —— 命令的退出码要能当闸用（CI 里一跑就知道）。"""

    async def go():
        await _reset()
        import argparse

        from app import model_check
        from app.db import SessionLocal
        from app.models import ProviderConfig

        async with SessionLocal() as db:
            db.add(ProviderConfig(name="on", kind="openai", enabled=True, models=["m1"]))
            await db.commit()
        return await model_check._main(
            argparse.Namespace(
                list=True, set="", bless="", history="", run_id=None, temperature=None,
                max_rounds=None, tool_choice="", length_policy=None, output_rule=None,
                force_structure=None, supports_structure=None, note="", limit=20,
            )
        )

    assert _run(go()) == 1
