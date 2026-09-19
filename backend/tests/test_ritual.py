"""喂的仪式感（M2 · PLAN.md §3 G2）的离线测试。

三件事，恰好对应三条验收：

1. **写盘的人说话，数是真数出来的**：拆点 → 「我嚼完了，拆出 N 个点」、出卡 → 「出好了 N 张卡」、
   草稿 → 「还没量过，不算数」。重复做同一件事**不重复说**（去重之后没新增就不开口）。
2. **宠物关着一个字都不说**（`pet_enabled=False`）——三条线一起验。
3. **两件仪式挂在既有那句问候上**：开工问昨日拆出来的那个点（没有就普通问候）、
   收工陈述今天的事实（**绝不说「还欠」**）。

模型一次都不真调：拆点/出卡走真表（数是重点），草稿那一步换掉 `structured.extract_json`。
"""
import asyncio
import atexit
import shutil
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

sys.path.insert(0, ".")

_TMP = Path(tempfile.mkdtemp(prefix="wb-ritual-", dir=Path(".").resolve()))


def _cleanup() -> None:
    shutil.rmtree(_TMP, ignore_errors=True)


atexit.register(_cleanup)

from app.core import candidates as cand  # noqa: E402
from app.core import cards as cards_core  # noqa: E402
from app.core import pet as pet_core  # noqa: E402
from app.core import pet_state as ps  # noqa: E402
from app.core import skills  # noqa: E402
from app.core import structured  # noqa: E402
from app.core import tutor  # noqa: E402
from app.core.prefs import save_config  # noqa: E402
from app.db import SessionLocal, engine as _engine  # noqa: E402
from app.models import Base as _Base  # noqa: E402
from app.models import Card, CardReview, DigestPoint, PetEvent, TutorSession  # noqa: E402

skills.SKILLS_DIR = _TMP / "skills"
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
            for model in (CardReview, Card, DigestPoint, TutorSession, PetEvent):
                await db.execute(delete(model))
            await db.commit()

    asyncio.run(_go())
    shutil.rmtree(skills.SKILLS_DIR, ignore_errors=True)
    skills.SKILLS_DIR.mkdir(parents=True, exist_ok=True)
    save_config({"pet_enabled": True})
    yield


def _lines(kind: str = "") -> list[dict]:
    try:
        rows = pet_core.feed(limit=50)
    except Exception:  # noqa: BLE001 - 表还没建过 = 一句话都没说过
        return []
    return [e for e in rows if not kind or e["kind"] == kind]


async def _digest_point(point: str, *, when: datetime | None = None) -> int:
    async with SessionLocal() as db:
        row = DigestPoint(source="notes/x.md", point=point, why="容易卡在第一步")
        if when is not None:
            row.created_at = when
        db.add(row)
        await db.commit()
        await db.refresh(row)
        return row.id


# ---------- 三句话：写盘的人说，数是真数 ----------


async def test_digesting_a_material_says_how_many_points_landed():
    out = await tutor._remember_points(
        "notes/x.md",
        [
            {"title": "先看主表", "why": "容易跳过"},
            {"title": "记下随机种子", "why": ""},
        ],
        "2026-09-16-论文.md",
    )
    assert [p["title"] for p in out] == ["先看主表", "记下随机种子"]

    lines = _lines("digested")
    assert len(lines) == 1
    assert "2026-09-16-论文.md" in lines[0]["text"] and "2" in lines[0]["text"]


async def test_re_digesting_the_same_material_says_nothing():
    """去重之后没有新行 = 没有新事情发生，**不该再念一遍**（同一份材料重拆是常态）。"""
    same = [{"title": "先看主表", "why": ""}]
    await tutor._remember_points("notes/x.md", same, "论文.md")
    await tutor._remember_points("notes/x.md", same, "论文.md")
    assert len(_lines("digested")) == 1


async def test_making_cards_says_the_real_count():
    out = await cards_core.save_cards(
        [
            {"front": "await 交给了谁", "back": "事件循环"},
            {"front": "GIL 是什么", "back": "一把全局锁"},
            {"front": "await 交给了谁", "back": "重复的那张"},  # 同一批里的重复：不算
        ],
        source="notes/x.md",
        source_label="2026-09-16-论文.md",
    )
    assert out["added"] == 2

    lines = _lines("cards_made")
    assert len(lines) == 1
    assert "2026-09-16-论文.md" in lines[0]["text"] and "2" in lines[0]["text"]


async def test_making_no_new_cards_says_nothing():
    """全是重复题面 → 一张都没加，那就没什么可说的。"""
    body = [{"front": "await 交给了谁", "back": "事件循环"}]
    await cards_core.save_cards(body, source="notes/x.md", source_label="论文.md")
    await cards_core.save_cards(body, source="notes/x.md", source_label="论文.md")
    assert len(_lines("cards_made")) == 1


async def test_landing_a_skill_draft_says_it_does_not_count_yet(monkeypatch):
    """环一的落盘话：**顺便把纪律念出来**（草稿不算数）——它不能复用 `note_output`，
    因为 `skills/` 不在 `_OUTPUT_DIRS` 里，那个函数会正确地保持沉默。"""

    class _Provider:
        name, kind, base_url, api_key, enabled = "p", "openai", "http://x", "k", True

    class _Meta:
        strategy = "prompt"

    async def fake_resolve(model_id, providers):
        return _Provider(), "m"

    async def fake_extract_json(info, model, messages, schema, **kw):
        return (
            cand.SkillCandidate(
                usable=True,
                name="复现评测口径",
                description="要复现一篇论文的评测时用它",
                instructions="# 复现\n\n1. 找主表。\n2. 记下种子。\n",
                reason="有一套工序",
                existing=[],
            ),
            _Meta(),
        )

    monkeypatch.setattr(cand, "_resolve", fake_resolve)
    monkeypatch.setattr(structured, "extract_json", fake_extract_json)
    from app.config import VAULT_DIR

    src = VAULT_DIR / "notes" / "2026-09-16-论文.md"
    src.parent.mkdir(parents=True, exist_ok=True)
    src.write_text("材料正文" * 20, encoding="utf-8")

    out = await cand.draft(source_path="notes/2026-09-16-论文.md")
    assert out["written"] is True
    lines = _lines("skill_draft")
    assert len(lines) == 1
    assert "复现评测口径" in lines[0]["text"] and "不算数" in lines[0]["text"]


async def test_the_pet_being_off_silences_all_three():
    """宠物关着 → 一个字都不说（三条线一起验：闸门在 `emit` 里，不在各个写盘点）。"""
    save_config({"pet_enabled": False})
    await tutor._remember_points("notes/x.md", [{"title": "一点", "why": ""}], "论文.md")
    await cards_core.save_cards(
        [{"front": "题", "back": "答"}], source="notes/x.md", source_label="论文.md"
    )
    try:
        from app.core import pet

        pet.emit("skill_draft", name="x")
    except Exception:  # noqa: BLE001
        pass
    assert _lines("digested") == [] and _lines("cards_made") == [] and _lines("skill_draft") == []


# ---------- 开工一问：昨日拆出来的那个点 ----------


async def test_the_morning_question_is_yesterdays_point():
    """开工那句问的就是昨天喂进去的那个点——**更早的不算**（那是记录，不是此刻该问的一句）。"""
    now = datetime.now().astimezone()
    yesterday = now - timedelta(days=1, hours=1)
    await _digest_point("先看主表再谈复现", when=yesterday.astimezone(timezone.utc).replace(tzinfo=None))
    await _digest_point("上周那个点", when=(now - timedelta(days=6)).astimezone(timezone.utc).replace(tzinfo=None))

    got = ps.last_digest_point(now)
    assert got is not None and got["title"] == "先看主表再谈复现"


async def test_no_yesterday_no_question():
    """没有昨日拆出的点 → 普通问候，不硬凑一个问题出来。"""
    now = datetime.now().astimezone()
    await _digest_point("上周那个点", when=(now - timedelta(days=6)).astimezone(timezone.utc).replace(tzinfo=None))

    assert ps.last_digest_point(now) is None
    line = await pet_core.greeting("morning")  # 没有 provider → 模板兜底
    assert "昨天" not in line and "讲得清吗" not in line


async def test_the_morning_greeting_carries_the_question_even_without_a_model():
    """没有 provider 时那句问候**照样要问**——仪式不该依赖模型在不在。"""
    now = datetime.now().astimezone()
    await _digest_point(
        "先看主表再谈复现", when=(now - timedelta(days=1, hours=1)).astimezone(timezone.utc).replace(tzinfo=None)
    )
    line = await pet_core.greeting("morning")
    assert "先看主表再谈复现" in line and "讲得清吗" in line


# ---------- 收工陈述：今天的事实，不是账 ----------


async def _facts_today() -> None:
    """造今天的真事：拆 1 个点、出 2 张卡、说通 1 个概念、过 1 张卡。"""
    now = datetime.now().astimezone()
    await _digest_point("今天拆的点", when=now.astimezone(timezone.utc).replace(tzinfo=None))
    await cards_core.save_cards(
        [{"front": "题一", "back": "答一"}, {"front": "题二", "back": "答二"}],
        source="notes/x.md",
        source_label="论文.md",
    )
    async with SessionLocal() as db:
        # 这些列是 **naive UTC**（ORM 的 `utcnow()` 那么写的）：塞 aware 的话，
        # SQLite 存下带偏移的串，和本地日的 UTC 边界一比就差一个时区——
        # 正是仓库里记着三种时间口径的那个坑。
        db.add(
            TutorSession(
                topic="t",
                concept="事件循环",
                verdict="got",
                ended_at=now.astimezone(timezone.utc).replace(tzinfo=None),
            )
        )
        db.add(CardReview(card_id=1, grade=3))
        await db.commit()


@pytest.fixture()
def _not_sunday(monkeypatch):
    """把那句问候钉在**非周日**那一支上（M4 起周日 21:00 改说周报）。

    `greeting` 在周日会让位给 `weekly.sunday_report`（PLAN §3 G4：不新增 cron，
    就在既有那句里判 weekday）。下面两条说的是**另一支**——「今天的事实」。
    不按住的话，这两条用例会在周日变红：**日历在决定测试结果**，最坏的一种红。
    周报那一支有自己的用例（`tests/test_weekly.py`），这里只把它让开。
    """
    from app.core import weekly

    async def _none(now=None):  # noqa: ANN001
        return None

    monkeypatch.setattr(weekly, "sunday_report", _none)


async def test_day_facts_count_only_today():
    await _facts_today()
    now = datetime.now().astimezone()
    async with SessionLocal() as db:
        old = DigestPoint(source="notes/o.md", point="昨天的点", why="")
        old.created_at = (now - timedelta(days=1, hours=2)).astimezone(timezone.utc).replace(tzinfo=None)
        db.add(old)
        await db.commit()

    f = ps.day_facts(now)
    assert f["digested"] == 1 and f["cards_made"] == 2 and f["got"] == 1 and f["reviews"] == 1


async def test_the_evening_greeting_states_facts_and_never_owes_anything(_not_sunday):
    await _facts_today()
    line = await pet_core.greeting("evening")
    for bit in ("消化了 1 个点", "出了 2 张卡", "说通了 1 个概念", "过了 1 张卡"):
        assert bit in line, line
    # 「不欠账」是这一条的红线：陈述里不许出现催办口吻
    for bad in ("还欠", "还剩", "还没做", "没打勾", "到期"):
        assert bad not in line, line


async def test_a_days_with_nothing_to_say_says_nothing_extra(_not_sunday):
    """全周无数据 → 只说那句普通问候（不加一句「今天什么也没干」）。

    注意别拿「今天」两个字当判据：普通问候里本来就有「今天的事我盯着」。
    要看的是**有没有那句陈述**。
    """
    line = await pet_core.greeting("evening")
    assert line == pet_core.compose("greeting")
    for bit in ("消化了", "出了", "说通了", "交出", "过了"):
        assert bit not in line, line
