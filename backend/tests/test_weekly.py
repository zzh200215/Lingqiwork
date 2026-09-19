"""陈述式周报（M4 · PLAN.md §3 G4）的离线测试。

四件事，正好对着 PLAN 那两行验收与两行纪律：

1. **全是读出来的**：`facts()` 数的五样都从真表/真目录来，而且**只看本周**；
   周报里的数字与库、与目录一致；
2. **一句话**：`text()` 是纯函数，没有 provider 时那句问候照样成立——
   而**没数据的那一周只说晚安**（不补一句「这周什么也没干」）；
3. **挂在既有那句问候上**：周日 21:00 那一句改说这一周（不新增 cron），
   非周日还是「今天」；
4. **一键转播客念的就是那一句**：稿子来自 `text()`，**不过模型**。

模型一次都不真调：这里根本没有模型的位置——周报全是读出来的事实，
连模板兜底那句都带得动它。
"""
import asyncio
import os
import shutil
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

sys.path.insert(0, ".")

from app.config import VAULT_DIR  # noqa: E402
from app.core import pet as pet_core  # noqa: E402
from app.core import podcast  # noqa: E402
from app.core import weekly  # noqa: E402
from app.db import SessionLocal, engine as _engine  # noqa: E402
from app.models import Base as _Base  # noqa: E402
from app.models import DigestPoint, TutorSession  # noqa: E402


async def _init_db() -> None:
    async with _engine.begin() as conn:
        await conn.run_sync(_Base.metadata.create_all)


asyncio.run(_init_db())

# 「现在」与「这一周的周日」都从真实时钟推出来：库里那些行是**此刻**写进去的
# （`utcnow()` 默认值），钉死一个过去的日期会让它们落在窗口外，测试于是测了个寂寞。
NOW = datetime.now().astimezone()
MONDAY = (NOW - timedelta(days=NOW.weekday())).replace(hour=0, minute=0, second=0, microsecond=0)
# 周日那一刻**取现在的钟点**：问候语里的「早上/下午/晚上」按钟点算，
# 差一个时段就会让「那句普通问候」的比对莫名其妙地不相等。
SUNDAY = (MONDAY + timedelta(days=6)).replace(hour=NOW.hour, minute=0, second=0, microsecond=0)


@pytest.fixture(autouse=True)
def _clean():
    """每个用例前清空这两张表 + 产出目录。

    沙箱库本来就是空的（`conftest` 在每个模块前重建），所以「清空」不会伤到别人；
    但**周报数的是全表**，用例之间不隔离的话「这一周什么都没有」那条就永远测不到。
    """
    from sqlalchemy import delete

    async def _go() -> None:
        async with SessionLocal() as db:
            for model in (DigestPoint, TutorSession):
                await db.execute(delete(model))
            await db.commit()

    asyncio.run(_go())
    for d in (VAULT_DIR / "research", VAULT_DIR / "deliver", VAULT_DIR / "notes"):
        shutil.rmtree(d, ignore_errors=True)
    yield


def _naive_utc(when: datetime) -> datetime:
    """库里那几列的口径：naive UTC（`utcnow()` 写的 UTC，读出来不带时区）。"""
    return when.astimezone(timezone.utc).replace(tzinfo=None)


def _point(source: str, when: datetime, point: str = "一个点") -> None:
    async def go() -> None:
        async with SessionLocal() as db:
            db.add(DigestPoint(source=source, point=point, why="容易卡", created_at=_naive_utc(when)))
            await db.commit()

    asyncio.run(go())


def _session(concept: str, verdict: str, when: datetime, recalled: bool = False) -> None:
    async def go() -> None:
        async with SessionLocal() as db:
            db.add(
                TutorSession(
                    topic=f"聊 {concept}",
                    concept=concept,
                    verdict=verdict,
                    recalled=recalled,
                    created_at=_naive_utc(when),
                    ended_at=_naive_utc(when),
                )
            )
            await db.commit()

    asyncio.run(go())


def _output(rel: str, *, days_ago: float = 0.0) -> Path:
    """在产出目录里放一份真文件（`vault/research/*.md`），mtime 决定它算不算这一周的。"""
    p = VAULT_DIR / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text("# 一份成品\n", encoding="utf-8")
    ts = datetime.now().timestamp() - days_ago * 86400
    os.utime(p, (ts, ts))
    return p


# ---------- 窗口与那句话（纯函数） ----------


def test_the_window_is_monday_to_the_end_of_today():
    start, end = weekly.window(NOW)
    # 两端都是**本地日**换算出来的 UTC：把周一 00:00 换回本地看，应当一分不差
    back = datetime.fromisoformat(start).replace(tzinfo=timezone.utc).astimezone()
    assert back == MONDAY
    assert back.weekday() == 0 and (back.hour, back.minute) == (0, 0)
    end_back = datetime.fromisoformat(end).replace(tzinfo=timezone.utc).astimezone()
    assert end_back == (NOW + timedelta(days=1)).replace(hour=0, minute=0, second=0, microsecond=0)


def test_the_sentence_says_exactly_the_numbers_it_was_given():
    got = weekly.text(
        {
            "sources": 2,
            "points": 5,
            "got": 3,
            "half": 1,
            "outputs": 2,
            "recurring": ["事件循环"],
        }
    )
    assert got == (
        "这周你消化了 2 份材料（拆出 5 个点）、说通了 3 个概念、交出 2 份成品。"
        "有 1 个概念停在半懂，「事件循环」还是没走通。"
    )


def test_zeroes_are_simply_not_mentioned():
    """只说真发生了的事——没出锅的成品不该在句子里留一个「0 份」的位置。"""
    got = weekly.text({"sources": 1, "points": 2, "got": 0, "half": 0, "outputs": 0, "recurring": []})
    assert got == "这周你消化了 1 份材料（拆出 2 个点）。"


def test_an_empty_week_produces_an_empty_sentence():
    """没数据的那一周**只说晚安**：这里绝不能补一句「这周什么也没干」。"""
    for facts in ({}, {"sources": 0, "points": 0, "got": 0, "half": 0, "outputs": 0, "recurring": []}):
        assert weekly.text(facts) == ""


def test_the_sentence_never_owes_anything():
    """「不欠账」是这一条的红线：陈述里不许出现催办口吻（与收工那句同一条纪律）。"""
    got = weekly.text(
        {"sources": 1, "points": 1, "got": 1, "half": 2, "outputs": 1, "recurring": ["闭包"]}
    )
    for bad in ("还欠", "还剩", "还没做", "到期", "没打勾", "应该", "该回看", "欠着"):
        assert bad not in got, got


# ---------- 事实：全部读出来的，而且只看本周 ----------


def test_facts_count_this_week_only():
    _point("notes/材料甲.md", NOW, "点一")
    _point("notes/材料甲.md", NOW, "点二")  # 同一份材料的第二个点
    _point("notes/上周的.md", MONDAY - timedelta(days=3), "上周的点")
    _session("事件循环", "got", NOW)
    _session("闭包", "half", NOW, recalled=True)
    _session("上周说通的", "got", MONDAY - timedelta(days=2))

    f = asyncio.run(weekly.facts(NOW))
    assert (f["sources"], f["points"]) == (1, 2)  # 材料按 source 去重，点是点数
    assert (f["got"], f["half"]) == (1, 1)  # 上周那场不算
    assert f["recurring"] == ["闭包"]  # 判据来自 `tutor.is_recurring_mistake`，不在这里重写


def test_the_same_concept_taught_twice_counts_once():
    """「说通了几个**概念**」不是「几场会话」——同一个概念这周讲通两次仍是一个。"""
    _session("事件循环", "got", NOW)
    _session("事件循环", "got", NOW + timedelta(hours=1))
    assert asyncio.run(weekly.facts(NOW))["got"] == 1


def test_recurring_names_are_capped():
    """周报是陈述，不是错题清单——「又卡住」最多念三个。"""
    for i in range(weekly.RECURRING_CAP + 2):
        _session(f"概念{i}", "half", NOW, recalled=True)
    f = asyncio.run(weekly.facts(NOW))
    assert len(f["recurring"]) == weekly.RECURRING_CAP


def test_outputs_count_this_weeks_products_only():
    _output("research/这周的.md")
    _output("deliver/也这周的.md")
    _output("research/上周的.md", days_ago=9)
    # 不是成品目录（`pet.is_output_path` 说了算）：mtime 再新也不算
    _output("notes/随手记.md")

    assert asyncio.run(weekly.facts(NOW))["outputs"] == 2


# ---------- 报告：给界面看的那一份 ----------


def test_report_text_is_the_same_sentence_the_module_composes():
    """`text()` 是这句话的**唯一出处**：界面显示的就是它会说的，没有第二份文案。"""
    _point("notes/材料.md", NOW)
    rep = asyncio.run(weekly.report(NOW))
    assert rep["text"] == weekly.text(rep["facts"])
    assert rep["empty"] is False
    assert rep["week"] == {"start": MONDAY.strftime("%Y-%m-%d"), "end": NOW.strftime("%Y-%m-%d")}


def test_report_on_an_empty_week_is_marked_empty():
    rep = asyncio.run(weekly.report(NOW))
    assert rep["empty"] is True and rep["text"] == ""
    assert rep["facts"]["outputs"] == 0


# ---------- 周日那句问候（挂在既有那一句上，不新增 cron） ----------


def test_not_sunday_there_is_no_weekly():
    assert asyncio.run(weekly.sunday_report(MONDAY)) is None


def test_a_sunday_with_an_empty_week_is_just_the_ordinary_greeting():
    assert asyncio.run(weekly.sunday_report(SUNDAY)) is None
    line = asyncio.run(pet_core.greeting("evening", now=SUNDAY))
    assert line == pet_core.compose("greeting")
    assert "这周" not in line


def test_the_sunday_greeting_states_the_week():
    _point("notes/材料.md", NOW)
    _session("闭包", "half", NOW, recalled=True)

    line = asyncio.run(pet_core.greeting("evening", now=SUNDAY))
    assert "这周你消化了 1 份材料" in line, line
    # 是**这一周**，不是今天：周报接管之后那句「今天…」不该再出现
    assert "今天消化了" not in line


def test_the_other_evenings_still_state_the_day():
    """非周日还是那句「今天」——两支不许同时开口（同一时刻只有一个声音）。"""
    if NOW.weekday() == weekly.SUNDAY:
        pytest.skip("今天就是周日：那一句本来就该是周报，见上一条用例")
    _point("notes/材料.md", NOW)
    line = asyncio.run(pet_core.greeting("evening", now=NOW))
    assert "今天消化了 1 个点" in line, line
    assert "这周你" not in line


# ---------- 一键转播客：念的就是那一句，且不过模型 ----------


def test_the_podcast_title_names_the_range():
    rep = asyncio.run(weekly.report(NOW))
    assert weekly.podcast_title(rep) == f"周报 {MONDAY:%m-%d}–{NOW:%m-%d}"


def test_to_podcast_reads_the_report_sentence(monkeypatch):
    """稿子必须是 `text()` 那一句——转播客最容易走偏的地方是「另写一份口播稿」。"""
    _point("notes/材料.md", NOW)
    seen: list[tuple[str, str, str]] = []

    async def fake_speak(text, title="", voice=""):
        seen.append((text, title, voice))
        return {"ok": True, "id": "pod-x", "file": "pod-x.wav"}

    monkeypatch.setattr(podcast, "speak_text", fake_speak)
    rep = asyncio.run(weekly.report(NOW))
    r = asyncio.run(weekly.to_podcast(voice="zh-CN-YunyangNeural", now=NOW))

    assert r["ok"] is True
    assert seen == [(rep["text"], weekly.podcast_title(rep), "zh-CN-YunyangNeural")]


def test_to_podcast_on_an_empty_week_says_so(monkeypatch):
    async def boom(text, title="", voice=""):  # pragma: no cover - 不该被调到
        raise AssertionError("空的一周不该去合成语音")

    monkeypatch.setattr(podcast, "speak_text", boom)
    r = asyncio.run(weekly.to_podcast(now=NOW))
    assert r["ok"] is False and r["empty"] is True


# ---------- HTTP 层 ----------


def test_http_endpoints(monkeypatch):
    monkeypatch.setenv("WB_API_TOKEN", "t")
    from fastapi.testclient import TestClient

    from app.core import auth
    from app.main import app

    monkeypatch.setattr(auth, "_cached", None)
    c = TestClient(app)
    h = {"X-WB-Token": "t"}

    assert c.get("/api/pet/weekly-report").status_code == 401  # 和其他 /api/* 一样要 token
    body = c.get("/api/pet/weekly-report", headers=h).json()
    assert body["empty"] is True and body["text"] == ""
    assert set(body["facts"]) >= {"sources", "points", "got", "half", "outputs", "recurring"}

    # 空的一周：转播客回 422 + 一句人话（不是 500，也不是 400 那种「你请求错了」）
    r = c.post("/api/pet/weekly-report/podcast", json={}, headers=h)
    assert r.status_code == 422 and "可陈述" in r.json()["detail"]

    # 音色不在可用列表里：拒绝，而不是悄悄换成默认音色
    assert c.post(
        "/api/pet/weekly-report/podcast", json={"voice": "zh-CN-不存在的"}, headers=h
    ).status_code == 422

    _point("notes/材料.md", NOW)
    body = c.get("/api/pet/weekly-report", headers=h).json()
    assert body["empty"] is False and "这周你消化了 1 份材料" in body["text"]
