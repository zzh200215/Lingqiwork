"""重讲判分（M1 · PLAN.md §3 G1）的离线测试。

三件事要钉住（沿 `loops.md` 的验收文化：纯函数层 → 真行层 → 接线层）：

1. **纯函数**：档位读得出来才算数——`fallback`、胡话、空，一律"没有结论"，**绝不猜**
   （猜错会把一张卡按错误的间隔推走，或把一个概念写进「已掌握」）；
2. **真行**：判过之后落的行与自评**同构**（同一个 `submit_review`、同一组间隔字段），
   只是多一列重讲原文；判分挂了则**一个字节都不写**，而且自评那次还能把原文带上；
3. **那条环照常转**：「我来讲 · 让它判」走的是同一条 `end()`——半懂时「又卡住」照样触发
   （§3 的 else 分支一行都没改，这一条就是证明）。

模型一次都不真调：判分器按 `judge_card` / `_ask` 注入（与 `skill_eval` 同一条纪律）。
"""
import asyncio
import atexit
import shutil
import sqlite3
import sys
import tempfile
from pathlib import Path

import pytest

sys.path.insert(0, ".")

_TMP = Path(tempfile.mkdtemp(prefix="wb-retell-", dir=Path(".").resolve()))


def _cleanup() -> None:
    shutil.rmtree(_TMP, ignore_errors=True)


atexit.register(_cleanup)

from app.core import cards as cards_core  # noqa: E402
from app.core import pet as pet_core  # noqa: E402
from app.core import retell as rt  # noqa: E402
from app.core import tutor  # noqa: E402
from app.db import SessionLocal, engine as _engine  # noqa: E402
from app.models import Base as _Base  # noqa: E402
from app.models import Card, CardReview, PetEvent, TutorSession, TutorTurn  # noqa: E402


async def _init_db() -> None:
    async with _engine.begin() as conn:
        await conn.run_sync(_Base.metadata.create_all)


asyncio.run(_init_db())


@pytest.fixture(autouse=True)
def _clean():
    from sqlalchemy import delete

    async def _go() -> None:
        async with SessionLocal() as db:
            # TutorTurn 也要清：不清就会跨用例串味——SQLite 的 id 会从头再来，
            # 新会话拿到旧 id，`detail()` 于是"看得见"上一条用例留下的对话
            # （实测：空会话那条用例因此走到了模型那一步）。
            for model in (CardReview, Card, TutorTurn, TutorSession, PetEvent):
                await db.execute(delete(model))
            await db.commit()

    asyncio.run(_go())
    yield


async def _card(front: str = "await 到底交给了谁", back: str = "交给了事件循环", **kw) -> int:
    async with SessionLocal() as db:
        row = Card(front=front, back=back, source_excerpt=kw.pop("excerpt", "材料原文一句"), **kw)
        db.add(row)
        await db.commit()
        await db.refresh(row)
        return row.id


async def _reviews() -> list[CardReview]:
    from sqlalchemy import select

    async with SessionLocal() as db:
        return list((await db.execute(select(CardReview).order_by(CardReview.id))).scalars().all())


def _pet_lines(kind: str = "") -> list[dict]:
    try:
        rows = pet_core.feed(limit=50)
    except Exception:  # noqa: BLE001 - 表还没建过 = 一句话都没说过
        return []
    return [e for e in rows if not kind or e["kind"] == kind]


def _judge_returns(monkeypatch, payload: dict) -> None:
    """把判分整体换掉：这一层测的是**判完之后**的事，模型不是被测对象。"""

    async def _fake(*_a, **_kw) -> dict:
        return dict(payload)

    monkeypatch.setattr(rt, "judge_card", _fake)
    monkeypatch.setattr(rt, "judge_session", _fake)


# ---------- 纯函数：读得出档位才算数 ----------

def test_the_four_grades_map_to_the_review_scale():
    """`card_reviews.grade` 是 1 重来 | 2 困难 | 3 良好 | 4 简单——照它对齐，不另立一套。"""
    assert rt.parse_grade("重来") == 1
    assert rt.parse_grade("困难") == 2
    assert rt.parse_grade("良好") == 3
    assert rt.parse_grade("简单") == 4
    assert rt.parse_grade(3) == 3
    assert rt.parse_grade("2") == 2
    assert rt.parse_grade("Easy") == 4  # 模型偶尔回英文


def test_a_grade_it_cannot_read_is_no_grade_at_all():
    """**认不出来就退自评**——不猜。猜错是拿一个假的间隔把卡推走。"""
    for junk in ("嗯", "", None, 0, 5, 9, "不知道", True, [], {}):
        assert rt.parse_grade(junk) is None


def test_fallback_means_no_conclusion_even_with_a_grade_attached():
    """它说"判不了"时，顺带写了个档位也不作数——那句话比档位可信。"""
    got = rt.read_card(rt.CardVerdict(grade="良好", fallback=True))
    assert got["ok"] is False and got["grade"] == 0 and "判不了" in got["reason"]


def test_a_hard_grade_without_a_gap_still_counts():
    """缺口是**提示词的要求**，不是判据：读得出档位就算数，只是没有那句提示。"""
    got = rt.read_card(rt.CardVerdict(grade="困难"))
    assert got["ok"] is True and got["grade"] == 2 and got["missed_points"] == []


def test_a_stringy_missed_points_list_is_normalised():
    """模型把数组写成一个字符串是常态——别让格式把一次成功的判分变成失败。"""
    got = rt.read_card(rt.CardVerdict(grade="困难", missed_points="没讲清楚 await 的归属"))
    assert got["missed_points"] == ["没讲清楚 await 的归属"]
    assert rt.read_card(rt.CardVerdict(grade="困难", missed_points=[]))["ok"] is True


def test_the_session_verdicts_accept_their_own_words():
    assert rt.parse_verdict("got") == "got"
    assert rt.parse_verdict("HALF") == "half"
    assert rt.parse_verdict("说通了") == "got"
    assert rt.parse_verdict("半懂") == "half"
    assert rt.parse_verdict("不知道") is None
    assert rt.read_session(rt.SessionVerdict(verdict="嗯"))["ok"] is False
    assert rt.read_session(None)["ok"] is False


def test_the_judge_reads_the_card_answer_not_a_retrieved_chunk():
    """基准是**卡片自己的答案**：出处片段只是补充，空了也不去检索（PLAN §3 G1 的取舍）。"""
    prompt = rt.card_prompt("题面", "答案在这里", "", "我讲的")
    assert "答案在这里" in prompt and "（没有）" in prompt and "我讲的" in prompt
    assert "题面" in prompt


def test_a_long_session_keeps_both_ends():
    """太长就从中间砍：开头是题目、结尾是结论，两头都比中间值钱。"""
    turns = [{"role": "user", "content": "开头的问题"}]
    turns += [{"role": "assistant", "content": f"啰嗦 {i} " + "填充" * 30} for i in range(200)]
    turns += [{"role": "user", "content": "最后的结论"}]
    prompt = rt.session_prompt("话题", turns)
    assert "开头的问题" in prompt and "最后的结论" in prompt and "中间略" in prompt
    assert len(prompt) < 9000  # 砍到上限附近，不是把全文塞进去


# ---------- 真行：判过之后落的行 ----------

async def test_a_retell_writes_the_same_review_row_as_a_self_grade(monkeypatch):
    """**双入口单账本**：两条路走的是同一个 `submit_review`，落下来的行同构，
    只差两列——重讲原文，以及 PLAN2 T2 那一列「这一档是不是判分器判的」。

    两张初始状态一样的卡（间隔 0 / ease 2.5 / reps 0），一张重讲、一张自评，给同一个档——
    除了那两列，两行必须**逐字段相同**。随机抖动（`fuzz_interval`）不是被测对象，
    这里固定掉它，否则这条断言会随种子飘。
    """
    monkeypatch.setattr(cards_core, "fuzz_interval", lambda days, rnd=None: days)
    a = await _card(front="题 A")
    b = await _card(front="题 B")
    _judge_returns(monkeypatch, {"ok": True, "grade": 3, "label": "良好", "missed_points": []})

    out = await rt.adjudicate(a, "我先 await，然后它挂起……", seconds=12.0)
    assert out["ok"] is True and out["grade"] == 3
    await cards_core.submit_review(b, 3, 12.0)

    rows = await _reviews()
    assert [r.card_id for r in rows] == [a, b]
    retold, self_graded = rows[0], rows[1]
    assert retold.retell.startswith("我先 await")
    assert self_graded.retell == ""  # 自评那一路照旧留空
    # 校准曲线分的那两堆：判分器判的 vs 你自评的（本文件是**唯一**写真的地方）。
    # 而且 v10 起还记着**是哪一版**判的（曲线按它分段）——指纹只有一个出处。
    assert (retold.judged, self_graded.judged) == (True, False)
    assert retold.judged_sha == cards_core.judge_sha() and len(retold.judged_sha) == 12
    assert self_graded.judged_sha == ""
    for field in (
        "grade",
        "seconds",
        "interval_before",
        "interval_after",
        "ease_before",
        "ease_after",
        "reps_before",
    ):
        assert getattr(retold, field) == getattr(self_graded, field), field


async def test_a_failed_judge_writes_nothing_at_all(monkeypatch):
    """判分失败 ≠ 差评：**不落分、不落文本**，界面据此退回自评。"""
    cid = await _card()
    _judge_returns(monkeypatch, {"ok": False, "reason": "判分没跑成（输出读不出来）", "grade": 0})

    out = await rt.adjudicate(cid, "我讲了一段")
    assert out["ok"] is False and "判分没跑成" in out["reason"]
    assert await _reviews() == []
    assert _pet_lines("retell") == []


async def test_the_self_grade_can_still_carry_the_retell_text(monkeypatch):
    """判分挂了、你自己定了档——那一天你**确实重讲了**，这件事不该跟着丢掉。

    北极星指标读的就是这一列（PLAN §7）：`card_reviews.retell` 非空 = 这一天重讲过。
    """
    cid = await _card()
    _judge_returns(monkeypatch, {"ok": False, "reason": "没有可用的模型", "grade": 0})
    await rt.adjudicate(cid, "我讲了一段")

    await cards_core.submit_review(cid, 2, 9.0, retell="我讲了一段")
    rows = await _reviews()
    assert len(rows) == 1 and rows[0].retell == "我讲了一段"

    conn = sqlite3.connect(_engine.url.database)
    try:
        n = conn.execute("SELECT COUNT(*) FROM card_reviews WHERE retell != ''").fetchone()[0]
    finally:
        conn.close()
    assert n == 1


async def test_an_empty_retell_never_reaches_the_model(monkeypatch):
    cid = await _card()
    called = {"n": 0}

    async def _fake(*_a, **_kw) -> dict:
        called["n"] += 1
        return {"ok": True, "grade": 3}

    monkeypatch.setattr(rt, "judge_card", _fake)
    out = await rt.adjudicate(cid, "   ")
    assert out["ok"] is False and called["n"] == 0


async def test_no_such_card_and_a_shelved_card_are_told_apart(monkeypatch):
    _judge_returns(monkeypatch, {"ok": True, "grade": 3})
    assert (await rt.adjudicate(999999, "讲了"))["reason"] == "卡片不存在"
    cid = await _card(suspended=True)
    assert (await rt.adjudicate(cid, "讲了"))["reason"] == "这张卡已搁置"


async def test_the_judge_line_says_what_the_grade_means(monkeypatch):
    """零柒接一句：**判词**，不是评分表——过、差一点（说得出缺口）、没讲通。"""
    cid = await _card(topic="事件循环")
    _judge_returns(
        monkeypatch,
        {"ok": True, "grade": 2, "label": "困难", "missed_points": ["await 的归属没说清"]},
    )
    await rt.adjudicate(cid, "讲了")
    lines = _pet_lines("retell")
    assert len(lines) == 1
    assert "事件循环" in lines[0]["text"] and "await 的归属没说清" in lines[0]["text"]

    _judge_returns(monkeypatch, {"ok": True, "grade": 4, "label": "简单", "missed_points": []})
    await rt.adjudicate(cid, "又讲了一遍")
    assert "你讲清楚了" in _pet_lines("retell")[0]["text"]

    _judge_returns(monkeypatch, {"ok": True, "grade": 1, "label": "重来", "missed_points": []})
    await rt.adjudicate(cid, "再讲一遍")
    assert "没讲通" in _pet_lines("retell")[0]["text"]


# ---------- 场景 B：我来讲 + 让它判 ----------

async def _session(concept: str, verdict: str, *, recalled: bool = False, model_id: str = "") -> int:
    async with SessionLocal() as db:
        row = TutorSession(
            topic="讲给零柒听",
            concept=concept,
            verdict=verdict,
            recalled=recalled,
            model_id=model_id,
            mode="feynman",
        )
        db.add(row)
        await db.commit()
        await db.refresh(row)
        return row.id


async def _turn(session_id: int, role: str, content: str) -> None:
    from app.models import TutorTurn

    async with SessionLocal() as db:
        db.add(TutorTurn(session_id=session_id, role=role, content=content))
        await db.commit()


async def test_judging_a_session_lands_the_verdict_through_the_same_end(monkeypatch):
    """判出来的档位走**同一条 `end()`**：概念照常回写、会话照常收尾。"""
    from app.routers import tutor as tutor_router

    sid = await _session("", "")
    await _turn(sid, "user", "事件循环就是一个队列……")
    await _turn(sid, "assistant", "那 await 的时候，谁在跑？")

    _judge_returns(monkeypatch, {"ok": True, "verdict": "half", "missed_points": ["await 的归属"]})
    out = await tutor_router.judge_session(sid, None)

    assert out["judged"] is True and out["verdict"] == "half"
    async with SessionLocal() as db:
        row = await db.get(TutorSession, sid)
    assert row.verdict == "half" and row.ended_at is not None


async def test_a_half_verdict_still_fires_the_recurring_chain(monkeypatch):
    """这一条是**接线验收**：§3 的 else 分支一行都没改，半懂时「又卡住」照样开口。

    判据要求「系统接住过他卡在哪儿」（`recalled`）——所以先有一场接上过的旧会话。
    概念是 `end()` 里 `_extract` 抽出来的，这里把它换掉（模型不是被测对象）。
    """
    from app.routers import tutor as tutor_router

    await _session("事件循环", "half")  # 旧的一场
    sid = await _session("", "", recalled=True, model_id="p/m")  # 这一场接上了旧的卡点
    await _turn(sid, "user", "我觉得 await 是把控制权交回事件循环")
    await _turn(sid, "assistant", "那它交回给谁了？")

    async def _extract(*_a, **_kw) -> tuple[str, str, str, str, str]:
        return ("事件循环", "", "说不太清交回给谁", "", "asyncio")

    monkeypatch.setattr(tutor, "_extract", _extract)
    _judge_returns(monkeypatch, {"ok": True, "verdict": "half", "missed_points": []})
    await tutor_router.judge_session(sid, None)

    lines = _pet_lines("repeated")
    assert len(lines) == 1 and "事件循环" in lines[0]["text"]


async def test_a_judge_that_cannot_decide_falls_back_to_you(monkeypatch):
    """判不出来 → `judged=false`，**会话一个字都不动**（自评那条路照旧在）。"""
    from app.routers import tutor as tutor_router

    sid = await _session("", "")
    await _turn(sid, "user", "嗯")
    _judge_returns(monkeypatch, {"ok": False, "verdict": "", "reason": "判分没跑成"})

    out = await tutor_router.judge_session(sid, None)
    assert out["judged"] is False and "判分没跑成" in out["reason"] and out["ended"] is None
    async with SessionLocal() as db:
        row = await db.get(TutorSession, sid)
    assert row.verdict == "" and row.ended_at is None


async def test_an_empty_session_is_not_worth_a_call():
    """一场还没说过话的会话，连模型都不该叫——判不了是**如实说**，不是失败。"""
    from app.routers import tutor as tutor_router

    sid = await _session("", "")
    out = await tutor_router.judge_session(sid, None)
    assert out["judged"] is False and "还没有内容" in out["reason"]
