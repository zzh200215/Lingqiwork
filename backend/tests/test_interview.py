"""面试陪练（M3 · PLAN.md §3 G3）的离线测试。

三条验收，一条红线：

1. **题库**只读他自己那份 `vault/面试准备.md` + 半懂 / 又卡住概念 + 到期卡，来源标得出来；
2. **一场 5 题跑完出报告**：报告落 `vault/reports/`、四个格子与对话一致；
3. **≥1 次追问基于上一题的回答**：这件事由「声部」负责——面试官拿到的提示词里
   带着题库与**本场进度**（每轮重算），同一个薄弱点最多追三层、到 8 题必须收尾；
4. 🚩 **红线**：跑完报告，题库文件**一个字节都没变**（陪练产物绝不回写题库）。
"""
import asyncio
import atexit
import shutil
import sys
import tempfile
from pathlib import Path

import pytest

sys.path.insert(0, ".")

_TMP = Path(tempfile.mkdtemp(prefix="wb-interview-", dir=Path(".").resolve()))


def _cleanup() -> None:
    shutil.rmtree(_TMP, ignore_errors=True)


atexit.register(_cleanup)

from app.config import VAULT_DIR  # noqa: E402
from app.core import cards as cards_core  # noqa: E402
from app.core import interview as iv  # noqa: E402
from app.core import structured  # noqa: E402
from app.core import tutor  # noqa: E402
from app.db import SessionLocal, engine as _engine  # noqa: E402
from app.models import Base as _Base  # noqa: E402
from app.models import Card, CardReview, TutorSession, TutorTurn  # noqa: E402


async def _init_db() -> None:
    async with _engine.begin() as conn:
        await conn.run_sync(_Base.metadata.create_all)


asyncio.run(_init_db())


@pytest.fixture(autouse=True)
def _clean():
    from sqlalchemy import delete

    async def _go() -> None:
        async with SessionLocal() as db:
            for model in (CardReview, Card, TutorTurn, TutorSession):
                await db.execute(delete(model))
            await db.commit()

    asyncio.run(_go())
    shutil.rmtree(VAULT_DIR / iv.REPORT_DIR, ignore_errors=True)
    bank = VAULT_DIR / iv.BANK_FILE
    if bank.exists():
        bank.unlink()
    yield


BANK_TEXT = """# 面试准备

- 事件循环里 await 到底把控制权交给了谁
- GIL 之下多线程为什么还能跑 IO
2. 你做过最难的一次性能优化是什么

## 反问
> 这行是引用，不算题目
"""


def _write_bank(text: str = BANK_TEXT) -> Path:
    p = VAULT_DIR / iv.BANK_FILE
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(text, encoding="utf-8")
    return p


async def _session(mode: str = "interview", topic: str = "Python 后端") -> int:
    async with SessionLocal() as db:
        row = TutorSession(topic=topic, mode=mode, model_id="p/m")
        db.add(row)
        await db.commit()
        await db.refresh(row)
        return row.id


async def _turn(session_id: int, role: str, content: str) -> None:
    async with SessionLocal() as db:
        db.add(TutorTurn(session_id=session_id, role=role, content=content))
        await db.commit()


async def _one_round(sid: int, ask: str, answer: str) -> None:
    await _turn(sid, "assistant", ask)
    await _turn(sid, "user", answer)


# ---------- 题库：只读他自己的东西 ----------


def test_the_bank_file_is_parsed_into_questions():
    _write_bank()
    name, questions = iv._file_questions()
    assert name == iv.BANK_FILE
    assert questions[0] == "事件循环里 await 到底把控制权交给了谁"
    assert "GIL 之下多线程为什么还能跑 IO" in questions
    # 序号被剥掉、标题与引用不算题
    assert "你做过最难的一次性能优化是什么" in questions
    assert all(not q.startswith("#") and not q.startswith(">") for q in questions)


def test_a_missing_bank_file_is_not_a_failure():
    """题库文件不在就只是没有它——面试照样能开（用概念和到期卡）。"""
    name, questions = iv._file_questions()
    assert name == "" and questions == []


async def test_the_bank_marks_where_each_question_comes_from():
    _write_bank()
    async with SessionLocal() as db:
        db.add(TutorSession(topic="t", concept="事件循环", verdict="half", mode="socratic"))
        # 「到期卡」按字面意思：做过至少一次、且已经到点的卡（新卡在 `fresh` 那一档里，
        # 不是"到期"——两档混起来，界面上那句「到期卡」就成了假话）
        db.add(Card(front="GIL 是什么", back="一把全局锁", reps=1, interval_days=1))
        await db.commit()

    b = await iv.bank()
    assert b["file"] == iv.BANK_FILE and len(b["questions"]) == 3
    assert [c["concept"] for c in b["concepts"]] == ["事件循环"]
    assert b["cards"] == ["GIL 是什么"]
    assert b["count"] == 3 + 1 + 1


async def test_recurring_concepts_come_first():
    """「又卡住」的排最前面：那是系统**接住过他卡在哪**的那些，最该再问一遍。"""
    async with SessionLocal() as db:
        db.add(TutorSession(topic="t", concept="偶尔半懂的", verdict="half"))
        db.add(TutorSession(topic="t", concept="老卡住的", verdict="half", recalled=True))
        db.add(TutorSession(topic="t", concept="老卡住的", verdict="half", recalled=True))
        await db.commit()

    b = await iv.bank()
    assert [c["concept"] for c in b["concepts"]] == ["老卡住的", "偶尔半懂的"]
    assert b["concepts"][0]["recurring"] is True


# ---------- 声部：一次一问、追三层、到点收尾 ----------


async def test_the_prompt_carries_the_bank_and_the_progress():
    """进度是**数出来的**（assistant 轮次），不是另存的计数器——不每轮带上，
    它问过三题就忘了自己问过什么。"""
    _write_bank()
    history = [
        {"role": "assistant", "content": "第一问"},
        {"role": "user", "content": "答一"},
        {"role": "assistant", "content": "追问"},
        {"role": "user", "content": "答二"},
    ]
    prompt = await iv.interviewer_prompt(history)
    assert "已经问过 2 题" in prompt
    assert "5–8 题" in prompt
    assert "事件循环里 await 到底把控制权交给了谁" in prompt
    assert "只问一个问题" in prompt  # 人设那几条还在
    assert "最多追三层" in prompt and "到 8 题必须收尾" in prompt


async def test_the_prompt_survives_a_broken_bank(monkeypatch):
    async def boom():
        raise RuntimeError("库坏了")

    monkeypatch.setattr(iv, "bank", boom)
    prompt = await iv.interviewer_prompt([])
    assert "只问一个问题" in prompt  # 题库挂了也得能面试


# ---------- 散场：报告 ----------


class _Meta:
    strategy = "prompt"


class _Provider:
    name, kind, base_url, api_key, enabled = "p", "openai", "http://x", "k", True


def _stub(monkeypatch, obj) -> None:
    from app.core import candidates

    async def fake_resolve(model_id, providers):
        return _Provider(), "m"

    async def fake_extract(info, model, messages, schema, **kw):
        return obj, _Meta()

    # `report()` 里头是延迟 import，所以要换**candidates 那一个**（同一份实现的那个属性）
    monkeypatch.setattr(candidates, "_resolve", fake_resolve)
    monkeypatch.setattr(structured, "extract_json", fake_extract)


GOOD = iv.InterviewReport(
    summary="整体能讲，一到并发就开始含糊。",
    solid=["GIL 之下 IO 能跑，讲清楚了"],
    stuck=["await 的归属说不清", "性能优化的量化口径没有"],
    teach_next=["async 调度", "性能剖析的基线"],
)


async def test_five_questions_end_with_a_report_on_disk(monkeypatch):
    """一场 5 题跑完 → 报告落 `vault/reports/`，四个格子与对话一致。"""
    _write_bank()
    _stub(monkeypatch, GOOD)
    sid = await _session()
    for i in range(5):
        await _one_round(sid, f"第 {i + 1} 问：说说 X", f"第 {i + 1} 答：我记得是 Y")

    out = await iv.report(sid)

    assert out["ok"] is True and out["asked"] == 5
    assert out["path"].startswith("reports/") and out["path"].endswith(".md")
    text = (VAULT_DIR / out["path"]).read_text(encoding="utf-8")
    assert "# 面试陪练复盘 · Python 后端" in text
    assert "一场 5 题" in text
    assert "整体能讲，一到并发就开始含糊。" in text
    assert "- await 的归属说不清" in text and "- 性能剖析的基线" in text
    assert out["sections"]["stuck"] == GOOD.stuck


async def test_the_report_never_touches_the_question_bank(monkeypatch):
    """🚩 红线：题库是**他的**东西，陪练产物只导出报告，不回写题库。"""
    p = _write_bank()
    before = (p.read_text(encoding="utf-8"), p.stat().st_mtime_ns)
    _stub(monkeypatch, GOOD)

    sid = await _session()
    await _one_round(sid, "问", "答")
    await iv.report(sid)

    assert p.read_text(encoding="utf-8") == before[0]
    assert p.stat().st_mtime_ns == before[1]


async def test_a_report_that_cannot_be_generated_says_so(monkeypatch):
    """模型给不出 JSON → `ok=false`，**不编一份报告**，也不落半个文件。"""
    _stub(monkeypatch, None)
    sid = await _session()
    await _one_round(sid, "问", "答")

    out = await iv.report(sid)
    assert out["ok"] is False and "没生成出来" in out["reason"]
    assert not (VAULT_DIR / iv.REPORT_DIR).exists()


async def test_an_empty_session_is_not_worth_a_call():
    sid = await _session()
    out = await iv.report(sid)
    assert out["ok"] is False and "还没有内容" in out["reason"]


def test_the_markdown_leaves_out_empty_sections():
    """没有卡壳就不摆一个空标题——空格子不是「一切正常」，是没东西可说。"""
    rep = iv.InterviewReport(summary="还行", solid=["A"])
    text = iv.to_markdown(rep, topic="T", asked=5, model_id="p/m", when=__import__("datetime").datetime(2026, 9, 16, 21, 0))
    assert "## 答得稳的" in text and "- A" in text
    assert "## 卡壳的" not in text and "## 建议回头搞懂" not in text
    assert "题库文件没有被改过" in text  # 如实写在正文里


# ---------- 接线：tutor 那条流换的是声部 ----------


async def test_an_interview_session_rides_the_tutor_stream(monkeypatch):
    """`mode='interview'` 是**一等模式**：`tutor.start` 认它，`tutor.say` 换声部。

    这一条钉的是「会话挂现有会话体系」是字面意义上的：不新增表、不新增流，
    只在那一个 `voice` 分支上接面试官的人设。
    """
    assert "interview" in tutor.MODES
    from app.core import providers

    monkeypatch.setattr(providers, "default_model_id", lambda: "p/m")
    out = await tutor.start("Python 后端", mode="interview")
    assert out["mode"] == "interview"
    sid = out["id"]
    await _turn(sid, "user", "第一句")

    seen: dict = {}

    async def fake_stream(model_id, messages, emit=None):
        seen["system"] = messages[0]["content"]
        yield "好。"

    monkeypatch.setattr(tutor, "_stream", fake_stream)
    monkeypatch.setattr(tutor, "recall_hits", _no_hits)
    async for _ev, _data in tutor.say(sid, "开始吧"):
        pass
    assert "你是面试官" in seen["system"]
    assert "已经问过 0 题" in seen["system"]


async def _no_hits(*_a, **_kw):
    return []
