"""校准曲线（PLAN2 T2 · N1）的离线测试。

这一格要钉住的不是算术，是**账怎么分堆**与**读不出来时说什么**：

1. **分堆只按 `judged` 分**：`judged=True` 只有一条写入路径（`retell.adjudicate` 判分成功）；
   判分挂了退回自评的那一行**是自评**——判分没跑成 ≠ 判过分；
2. **全自评时 `delta` 必须是 `null` 而不是 0**：0 读作「你和它判得一样准」，
   `null` 读作「还没对过账」，两回事；
3. **历史行不进**：v9 之前的行 `judged=False`，在「自评还是判过」这件事上是**未知**
   （那时候判过的行和自评的行长得一模一样）——这条是迁移不回填的**语义**理由，不是懒；
4. **红线：它不进零柒嘴里**——跑完曲线宠物一个字都没说，源码里一行 `pet.*` 都没有。

模型一次都不真调：判分器按 `judge_card` 注入（与 `test_retell.py` 同一条纪律）。
"""
import asyncio
import ast
import sys
from datetime import datetime, timedelta, timezone

import pytest

sys.path.insert(0, ".")

from app.core import cards as cards_core  # noqa: E402
from app.core import retell as rt  # noqa: E402
from app.db import SessionLocal, engine as _engine  # noqa: E402
from app.models import Base as _Base  # noqa: E402
from app.models import Card, CardReview, PetEvent  # noqa: E402


async def _init_db() -> None:
    async with _engine.begin() as conn:
        await conn.run_sync(_Base.metadata.create_all)


asyncio.run(_init_db())


@pytest.fixture(autouse=True)
def _clean():
    from sqlalchemy import delete

    async def _go() -> None:
        async with SessionLocal() as db:
            for model in (CardReview, Card, PetEvent):
                await db.execute(delete(model))
            await db.commit()

    asyncio.run(_go())
    yield


async def _card(front: str = "await 到底交给了谁", **kw) -> int:
    async with SessionLocal() as db:
        row = Card(front=front, back=kw.pop("back", "交给了事件循环"), **kw)
        db.add(row)
        await db.commit()
        await db.refresh(row)
        return row.id


async def _review(
    grade: int, *, judged: bool = False, days_ago: float = 0.0, sha: str = ""
) -> None:
    """直接写一行复习记录（**不走 `submit_review`**：这里要的是账本的各种历史形状）。

    `judged=True, sha=""` 就是 **v9–v10 之间那些行**的形状：判过，但不知道哪一版。
    """
    when = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(days=days_ago)
    async with SessionLocal() as db:
        db.add(
            CardReview(
                card_id=1, grade=grade, judged=judged, judged_sha=sha, reviewed_at=when
            )
        )
        await db.commit()


def _judge_returns(monkeypatch, payload: dict) -> None:
    async def fake(*_a, **_kw):  # noqa: ANN002, ANN003
        return payload

    monkeypatch.setattr(rt, "judge_card", fake)


async def _pet_lines() -> list:
    from sqlalchemy import select

    async with SessionLocal() as db:
        return list((await db.execute(select(PetEvent))).scalars().all())


# ---------- 纯函数：两个分布怎么分堆 ----------


def test_the_two_piles_are_split_by_who_graded_not_by_how_good_it_was():
    self_d, judged_d = cards_core.tally([(3, False), (1, False), (2, True), (4, True)])
    assert self_d == {1: 1, 2: 0, 3: 1, 4: 0}
    assert judged_d == {1: 0, 2: 1, 3: 0, 4: 1}
    # 四档的键**恒在**（没打过的档是 0）：界面画四根柱子，不该因为缺一档就少一根
    assert sorted(self_d) == [1, 2, 3, 4] and sorted(judged_d) == [1, 2, 3, 4]


def test_a_row_that_cannot_carry_a_grade_enters_neither_pile():
    """账面外的档位（0 / 9 / 负数）不进任何一侧——宁可少算，不猜它属于哪边。"""
    self_d, judged_d = cards_core.tally([(0, False), (9, True), (3, False)])
    assert cards_core.mean_of(self_d) == 3.0
    assert sum(judged_d.values()) == 0


def test_the_offset_is_self_minus_judged():
    """正数 = 给自己打分更高（PLAN2 §6 的口径）。"""
    self_d = {1: 0, 2: 0, 3: 2, 4: 0}  # 均值 3
    judged_d = {1: 1, 2: 1, 3: 0, 4: 0}  # 均值 1.5
    assert cards_core.offset(self_d, judged_d) == 1.5
    assert cards_core.offset(judged_d, self_d) == -1.5


def test_no_rows_on_one_side_is_none_not_zero():
    """**全自评 → `None`**：0 是「两边一样」，`None` 是「还没对过账」。"""
    empty = {1: 0, 2: 0, 3: 0, 4: 0}
    assert cards_core.mean_of(empty) is None
    assert cards_core.offset({1: 0, 2: 0, 3: 2, 4: 0}, empty) is None
    assert cards_core.offset(empty, {1: 0, 2: 0, 3: 2, 4: 0}) is None
    assert cards_core.offset(empty, empty) is None


# ---------- 真行：端点算出来的数 ----------


async def test_the_endpoint_counts_what_the_rows_say():
    await _review(3, judged=True)
    await _review(2, judged=True)
    await _review(4)  # 自评
    await _review(4)  # 自评
    await _review(4)  # 自评

    out = await cards_core.calibration()
    assert out["readable"] is True and out["error"] == ""
    assert out["judged_dist"] == {1: 0, 2: 1, 3: 1, 4: 0}
    assert out["self_dist"] == {1: 0, 2: 0, 3: 0, 4: 3}
    assert (out["n_self"], out["n_judged"]) == (3, 2)
    # 自评均值 4 − 判分均值 2.5 = 1.5：他给自己打的档，比判分器给的高一档半
    assert out["delta"] == 1.5


async def test_rows_outside_the_window_do_not_count():
    await _review(4, judged=True, days_ago=1)
    await _review(1, judged=True, days_ago=45)  # 窗口外
    out = await cards_core.calibration(days=30)
    assert out["n_judged"] == 1 and out["judged_dist"][4] == 1
    assert out["judged_dist"][1] == 0
    # 窗口是可以要的，但被夹在 [1, 365] 里
    assert (await cards_core.calibration(days=0))["days"] == 1
    assert (await cards_core.calibration(days=99999))["days"] == cards_core.CALIB_MAX_DAYS


async def test_a_pure_self_assessment_week_has_no_delta_at_all():
    """一周全是自评 → `n_judged=0` 且 `delta=None`（**不是 0**，见 `offset` 的 docstring）。"""
    for _ in range(3):
        await _review(3)
    out = await cards_core.calibration()
    assert out["n_self"] == 3 and out["n_judged"] == 0
    assert out["delta"] is None
    assert sum(out["judged_dist"].values()) == 0


async def test_a_judged_row_and_a_self_row_differ_by_that_one_column(monkeypatch):
    """走真路：判分成功落的那一行是真的，自评落的那一行是假的。

    两张卡都是「判分挂了退回自评」和「判分成功」这一对的兄弟——本用例只跑其中一张，
    另一张交给 `test_retell.py`（那边已经在断言两行逐字段同构）。
    """
    card = await _card()
    _judge_returns(monkeypatch, {"ok": True, "grade": 2, "label": "困难", "missed_points": []})
    out = await rt.adjudicate(card, "我讲一遍：await 把控制权交回事件循环")
    assert out["ok"] is True
    calib = await cards_core.calibration()
    assert calib["judged_dist"][2] == 1 and calib["n_judged"] == 1 and calib["n_self"] == 0


async def test_a_failed_judge_leaves_a_self_row_with_the_retell_text(monkeypatch):
    """判分挂了 → 界面退回自评，自评那次**带上原文**（北星指标读它）。

    于是这一行是「自评」，而且**仍然带着重讲原文**——这正是为什么分堆不能按 `retell`
    非空来分，只能按 `judged` 分。
    """
    card = await _card()
    _judge_returns(monkeypatch, {"ok": False, "reason": "没模型", "grade": 0})
    out = await rt.adjudicate(card, "讲了但没判成")
    assert out["ok"] is False

    await cards_core.submit_review(card, 3, 0.0, retell="讲了但没判成")
    async with SessionLocal() as db:
        from sqlalchemy import select

        row = (await db.execute(select(CardReview))).scalars().one()
    assert row.judged is False and row.retell.strip() == "讲了但没判成"
    calib = await cards_core.calibration()
    assert calib["n_self"] == 1 and calib["n_judged"] == 0 and calib["delta"] is None


async def test_the_default_on_every_other_path_is_false():
    """`judged=True` **全仓只有一处**：不在任何 HTTP 入参里，客户端说自己「判过了」
    没有任何一方能核实——那是把账本交给调用方写。"""
    card = await _card()
    await cards_core.submit_review(card, 3)
    async with SessionLocal() as db:
        from sqlalchemy import select

        assert (await db.execute(select(CardReview))).scalars().one().judged is False

    from app.routers import cards as cards_router

    assert "judged" not in cards_router.ReviewIn.model_fields
    assert "judged" not in cards_router.RetellIn.model_fields


# ---------- 按判分器版本分段（PLAN2 §9.4） ----------


def test_segments_split_by_the_judge_version_that_graded_the_row():
    """换过版的判分行不是一把尺子：分段表要按 sha 分开，**版本未知的单独一格**。"""
    segs = cards_core.fold_segments(
        [
            (3, True, "aaaaaaaaaaaa"),
            (2, True, "aaaaaaaaaaaa"),
            (4, True, "bbbbbbbbbbbb"),
            (3, True, ""),  # v9–v10 之间的行：判过，不知道哪一版
            (1, False, ""),  # 自评：不进分段
            (3, False, ""),
        ]
    )
    assert [(s["sha"], s["n"], s["mean"]) for s in segs] == [
        ("aaaaaaaaaaaa", 2, 2.5),
        ("bbbbbbbbbbbb", 1, 4.0),
        ("", 1, 3.0),  # 未知版本永远排在最后：它最不可比
    ]


async def test_the_endpoint_marks_the_current_version_and_flags_a_mixed_curve():
    """窗口里混了不止一版时，**必须说出来**：pooled 的那个 delta 是两把尺子量出来的。"""
    current = cards_core.judge_sha()
    await _review(3, judged=True, sha=current)
    await _review(2, judged=True, sha=current)
    await _review(4, judged=True, sha="deadbeef0000")
    await _review(1, judged=True)  # 版本未知
    await _review(3)  # 自评

    out = await cards_core.calibration()
    assert out["mixed"] is True
    by_sha = {s["sha"]: s for s in out["segments"]}
    assert by_sha[current]["current"] is True and by_sha[current]["n"] == 2
    assert by_sha["deadbeef0000"]["current"] is False and by_sha["deadbeef0000"]["n"] == 1
    assert by_sha[""]["current"] is False and by_sha[""]["n"] == 1
    assert any("不止一版" in n for n in out["notes"])
    assert any("本版 2 条" in n for n in out["notes"])
    # pooled 的那两个数照旧（它们是这条曲线的现状，只是现在**知道**它混了）
    assert out["n_judged"] == 4 and out["n_self"] == 1


async def test_one_version_only_is_not_mixed():
    """只有一版时不说那句话——警告喊多了就没人看了。"""
    current = cards_core.judge_sha()
    await _review(3, judged=True, sha=current)
    out = await cards_core.calibration()
    assert out["mixed"] is False and len(out["segments"]) == 1
    assert not any("不止一版" in n for n in out["notes"])
    assert out["segments"][0]["current"] is True


async def test_an_unknown_version_alone_is_not_mixed_either():
    """全是 v9–v10 的行时也只有一格（`sha: ""` + 「版本未知」）——它不是「混版」，
    它是「这一整段都不知道哪一版」，页脚另外那句正是在说这件事。"""
    await _review(3, judged=True)  # 不带 sha
    out = await cards_core.calibration()
    assert out["mixed"] is False and [(s["sha"], s["n"]) for s in out["segments"]] == [("", 1)]
    assert any("历史行" in n for n in out["notes"])


async def test_only_the_judge_path_fills_the_version():
    """`judged_sha` 全仓只有一处写入方：判分成功那一次。自评（含判分挂了退回自评）是空串。

    候选变体只在对照台里活（那是另一张表），所以产品这条路落下来的**永远是登记在册
    那一版的指纹**——曲线不会被一次实验性跑分污染。
    """
    card = await _card()
    await cards_core.submit_review(card, 3)
    async with SessionLocal() as db:
        from sqlalchemy import select

        row = (await db.execute(select(CardReview))).scalars().one()
    assert row.judged is False and row.judged_sha == ""
    # 传进来的指纹会被截到 12 位，而且**两列一起写**（不许只写真、不写版本）
    await cards_core.submit_review(card, 3, judged_sha="ffffffffffffffff")
    async with SessionLocal() as db:
        from sqlalchemy import select

        rows = (await db.execute(select(CardReview).order_by(CardReview.id))).scalars().all()
    assert rows[1].judged is True and rows[1].judged_sha == "ffffffffffff"


# ---------- 口径与红线 ----------

async def test_the_footer_says_where_the_judge_stands():
    """页脚那三行由后端给，界面不自己编一份说法。

    第一行是**动态**的（PLAN2 P2-1）：没跑过金标集就说没跑过、跑过就给数、跑过旧版就说
    那是上一版。三种情况的说法与它们各自的用例在 `test_judge_eval.py`（那边造得出基线），
    这里只钉**没跑过**这一种（测试库里本来就没有基线）与另外两行。
    """
    out = await cards_core.calibration()
    assert any("还没跑过金标集" in n for n in out["notes"])
    assert any("历史行" in n for n in out["notes"])
    # 判分器指纹：从登记表取（当前那版 JUDGE_SYSTEM），不是在这里重算一遍 sha
    assert out["judge_sha"] == cards_core.judge_sha()
    assert len(out["judge_sha"]) == 12


async def test_reading_it_does_not_make_the_pet_say_anything():
    """红线（PLAN2 §6）：这条曲线**永远不进它嘴里**——不设目标、不排名、不变成台词。

    两个层面都钉：跑一遍之后没有 `pet_events` 行；源码里一处 `pet` 调用都没有。
    """
    await _review(1, judged=True)
    await _review(3)
    await cards_core.calibration()
    assert await _pet_lines() == []

    from pathlib import Path

    src = Path("app/core/cards.py").read_text(encoding="utf-8")
    lines = src.splitlines()
    start = next(i for i, ln in enumerate(lines) if ln.startswith("# ---------- 校准曲线"))
    end = next(i for i, ln in enumerate(lines) if ln.startswith("# ---------- 主动层"))
    # 扫的是**调用**（语法树里的属性调用），不是那几个字：这一段的注释里正当地解释
    # 了「为什么不进它嘴里」，拿文本扫会把一句解释判成一次调用。
    assert not [
        n.lineno
        for n in ast.walk(ast.parse(src))
        if isinstance(n, ast.Call)
        and isinstance(n.func, ast.Attribute)
        and getattr(n.func.value, "id", "") == "pet"
        and start < n.lineno < end
    ]
    assert "pet_events" not in "\n".join(lines[start:end])
