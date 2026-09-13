"""「一件事」的离线测试（§4-15）。

重点在三处最容易**悄悄**出错的地方：挂接幂等（同一条挂两次只能留一条）、候选派生
（撞得上才给，撞不上不许硬塞）、条目解析容错（引用指向已经删掉的东西时整页不能塌）。
存取那层只测往返与守卫。
"""
import asyncio

import pytest
from sqlalchemy import delete as sa_delete
from sqlalchemy import select

from app.core import threads as th
from app.db import engine as _engine
from app.db import SessionLocal
from app.models import Base as _Base
from app.models import Card, DecisionLog, ModelUsage, ScheduledTask, Thread, ThreadItem


async def _init_db() -> None:
    async with _engine.begin() as conn:
        await conn.run_sync(_Base.metadata.create_all)


asyncio.run(_init_db())


@pytest.fixture(autouse=True)
def _clean():
    async def _go() -> None:
        async with SessionLocal() as db:
            for model in (ThreadItem, Thread, ModelUsage, Card, DecisionLog, ScheduledTask):
                await db.execute(sa_delete(model))
            await db.commit()

    asyncio.run(_go())
    yield


async def _add_card(front: str, topic: str) -> str:
    async with SessionLocal() as db:
        row = Card(front=front, back="", topic=topic)
        db.add(row)
        await db.commit()
        await db.refresh(row)
        return str(row.id)


# ---------- 纯函数 ----------


def test_matches_is_substring_based():
    """中文没有词边界，分词帮不上忙；子串包含恰好能解释，也不猜语义。"""
    assert th._matches("RAG 评测", "RAG评测的坑")
    assert th._matches("RAG", "RAG 评测")
    assert not th._matches("RAG", "向量库选型")
    assert not th._matches("的", "RAG 评测")  # 一个字不参与，否则全命中
    assert not th._matches("", "RAG")


def test_every_kind_belongs_to_a_step():
    """加了新 kind 却忘了归到某一步 → 它会在页面上凭空消失。这条守住它。"""
    covered = {k for _s, _label, kinds in th.STEPS for k in kinds}
    assert covered == set(th.KINDS)


# ---------- 挂接 ----------


async def test_attach_is_idempotent():
    t = await th.create("RAG 评测")
    first = await th.attach(t["id"], "card", "1")
    again = await th.attach(t["id"], "card", "1")
    assert first["attached"] is True and again["attached"] is False
    async with SessionLocal() as db:
        assert len((await db.execute(select(ThreadItem))).scalars().all()) == 1


async def test_attach_guards_kind_and_ref():
    t = await th.create("X")
    with pytest.raises(ValueError):
        await th.attach(t["id"], "nope", "1")
    with pytest.raises(ValueError):
        await th.attach(t["id"], "note", "../secret.md")
    with pytest.raises(ValueError):
        await th.attach(t["id"], "note", "   ")
    with pytest.raises(LookupError):
        await th.attach(9999, "card", "1")


async def test_detach_removes_only_that_one():
    t = await th.create("X")
    await th.attach(t["id"], "card", "1")
    await th.attach(t["id"], "note", "notes/a.md")
    await th.detach(t["id"], "card", "1")
    d = await th.detail(t["id"], suggest=False)
    assert [(i["kind"], i["ref"]) for i in d["items"]] == [("note", "notes/a.md")]


# ---------- 详情 ----------


async def test_detail_groups_by_step_and_tolerates_dead_refs():
    """引用本身还在、它指的东西没了（卡片被删、文件被挪）→ 标出来，整页照常。"""
    t = await th.create("RAG")
    await th.attach(t["id"], "card", "4242")  # 不存在的卡片
    await th.attach(t["id"], "note", "notes/gone.md")  # 不存在的文件

    d = await th.detail(t["id"], suggest=False)
    assert [i["exists"] for i in d["items"]] == [False, False]
    assert all(i["title"] == "（已不存在）" for i in d["items"])
    assert d["by_step"]["learn"][0]["kind"] == "card"  # 分组照样成立
    assert d["by_step"]["keep"][0]["kind"] == "note"


async def test_detail_resolves_attached_things_and_their_landing_pages():
    cid = await _add_card("RAG 评测怎么做", "RAG 评测")
    t = await th.create("RAG 评测")
    await th.attach(t["id"], "card", cid)

    d = await th.detail(t["id"], suggest=False)
    (item,) = d["items"]
    assert item["title"] == "RAG 评测怎么做" and item["exists"] is True
    assert item["href"] == f"/review?card={cid}"  # 卡片落在队列页，但带上它自己的 id


def test_href_lands_on_the_thing_itself():
    """每条引用都得落到**它自己**身上，不只停在那一类的页面（免得点开还要自己找）。"""
    assert th._href("card", "7") == "/review?card=7"
    assert th._href("decision", "9") == "/dashboard?decision=9"
    assert th._href("task", "3") == "/work?task=3"
    assert th._href("tutor", "5") == "/tutor?session=5"
    # 笔记 / 产出本来就有 path 深链，直接落文件
    assert th._href("note", "notes/a.md") == "/notes?path=notes/a.md"
    assert th._href("output", "deliver/b.md") == "/notes?path=deliver/b.md"


async def test_suggestions_are_derived_and_skip_what_is_already_attached():
    """「不手打标签」靠这个：撞得上的列出来，挂过的不再出现。"""
    cid = await _add_card("RAG 评测怎么做", "RAG 评测")
    await _add_card("晚上吃什么", "做饭")

    t = await th.create("RAG 评测")
    titles = [s["title"] for s in (await th.detail(t["id"]))["suggestions"]]
    assert "RAG 评测怎么做" in titles
    assert "晚上吃什么" not in titles  # 撞不上的不许硬塞

    await th.attach(t["id"], "card", cid)
    refs = [(s["kind"], s["ref"]) for s in (await th.detail(t["id"]))["suggestions"]]
    assert ("card", cid) not in refs


async def test_suggest_for_item_finds_the_thread_by_the_item_label():
    cid = await _add_card("RAG 评测怎么做", "RAG 评测")
    await th.create("RAG 评测")
    await th.create("完全无关")

    out = await th.suggest_for_item("card", cid)
    assert [t["name"] for t in out["threads"]] == ["RAG 评测"]


# ---------- 未归类 ----------


async def test_unclassified_lists_only_what_is_not_attached():
    cid = await _add_card("A", "t")
    t = await th.create("t")

    # 沙箱 vault 里可能有别的测试留下的文件，所以只断言「这一条在不在」——
    # 这才是本测试的不变量：挂上的会从未归类里消失。
    def has(items):
        return any(i["kind"] == "card" and i["ref"] == cid for i in items)

    assert has((await th.unclassified())["items"])
    await th.attach(t["id"], "card", cid)
    assert not has((await th.unclassified())["items"])


# ---------- 事本身 ----------


async def test_archived_threads_leave_the_list():
    t = await th.create("X")
    assert len((await th.list_threads())["threads"]) == 1
    await th.update(t["id"], archived=True)
    assert (await th.list_threads())["threads"] == []
    assert len((await th.list_threads(include_archived=True))["threads"]) == 1


async def test_delete_drops_the_index_not_the_things():
    """vault 与库里的东西一件都不能少——删的只是这一层索引。"""
    cid = await _add_card("A", "t")
    t = await th.create("t")
    await th.attach(t["id"], "card", cid)
    await th.delete(t["id"])

    async with SessionLocal() as db:
        assert (await db.execute(select(Card))).scalars().all()
        assert (await db.execute(select(ThreadItem))).scalars().all() == []


async def test_name_cannot_be_blank():
    with pytest.raises(ValueError):
        await th.create("   ")
    t = await th.create("X")
    with pytest.raises(ValueError):
        await th.update(t["id"], name="  ")
    with pytest.raises(LookupError):
        await th.update(9999, name="y")
    with pytest.raises(LookupError):
        await th.detail(9999)
    with pytest.raises(LookupError):
        await th.delete(9999)


# ---------- 成本按事记（§4-16） ----------


async def test_deliver_into_charges_the_thread_and_attaches_the_output(monkeypatch):
    """在做的当下就知道这笔钱为谁花的——不是事后拿 ref 去猜归属。"""
    from app.core import compose
    from app.core import deliver as deliver_engine
    from app.core import report as _report
    from app.core import usage_ledger

    async def fake_gather(topic, **kw):
        return [{"n": 1, "kind": "kb", "title": "A", "ref": "notes/a.md", "text": "x"}]

    async def fake_synth(topic, sources, prompt, *a, **kw):
        usage_ledger.note("test/model", 100, 50)  # 假装模型回了一次 usage
        return _report.Report(
            title="汇报要点", sections=[_report.Section(heading="结论", body="B [1]")], used=[1]
        )

    async def fake_save(rep, sources):
        return {"filename": "deliver/2026-09-12-汇报要点.md", "title": rep.title, "chunks": 2}

    monkeypatch.setattr(compose, "gather_inward", fake_gather)
    monkeypatch.setattr(_report, "synthesize", fake_synth)
    monkeypatch.setattr(deliver_engine, "save", fake_save)

    t = await th.create("RAG 评测")
    out = await th.deliver_into(t["id"], "briefing", "leader")
    assert out["filename"].startswith("deliver/")

    d = await th.detail(t["id"], suggest=False)
    assert d["cost"]["total"] == 150 and d["cost"]["calls"] == 1
    assert d["cost"]["by_model"] == {"test/model": {"in": 100, "out": 50, "calls": 1}}
    # 产出顺手挂上了这件事
    assert ("output", out["filename"]) in [(i["kind"], i["ref"]) for i in d["items"]]


async def test_deliver_into_guards_genre_and_thread(monkeypatch):
    from app.core import compose

    async def fake_gather(topic, **kw):
        return [{"n": 1, "kind": "kb", "title": "A", "ref": "notes/a.md", "text": "x"}]

    monkeypatch.setattr(compose, "gather_inward", fake_gather)
    t = await th.create("X")

    with pytest.raises(ValueError):
        await th.deliver_into(t["id"], "nope", "self")
    with pytest.raises(LookupError):
        await th.deliver_into(9999, "weekly", "self")


async def test_deliver_into_falls_back_when_there_is_no_material(monkeypatch):
    from app.core import compose

    async def no_material(topic, **kw):
        return []

    monkeypatch.setattr(compose, "gather_inward", no_material)
    t = await th.create("X")
    with pytest.raises(ValueError, match="没有可用的材料"):
        await th.deliver_into(t["id"], "weekly", "self")


async def test_deliver_into_pins_what_is_attached_to_the_thread(monkeypatch):
    """「这件事用过哪些材料」直接变成这次产出的材料（§4-14 的"加进这次产出"）。"""
    from app.core import cards as cards_core
    from app.core import compose
    from app.core import deliver as deliver_engine
    from app.core import report as _report

    monkeypatch.setattr(
        cards_core,
        "collect_material",
        lambda source_path="", text="", max_chars=0: (source_path, "钉的", "钉进来的正文"),
    )

    async def gathered(topic, **kw):
        return [{"n": 1, "kind": "kb", "title": "捞的", "ref": "notes/b.md", "text": "捞的正文"}]

    seen: dict = {}

    async def fake_synth(topic, sources, prompt, *a, **kw):
        seen["sources"] = sources
        return _report.Report(
            title="T", sections=[_report.Section(heading="H", body="B [1]")], used=[1]
        )

    async def fake_save(rep, sources):
        return {"filename": "deliver/x.md", "title": "T", "chunks": 1}

    monkeypatch.setattr(compose, "gather_inward", gathered)
    monkeypatch.setattr(_report, "synthesize", fake_synth)
    monkeypatch.setattr(deliver_engine, "save", fake_save)

    t = await th.create("RAG")
    await th.attach(t["id"], "note", "notes/a.md")
    await th.deliver_into(t["id"], "weekly", "self")

    srcs = seen["sources"]
    assert [s["ref"] for s in srcs] == ["notes/a.md", "notes/b.md"]  # 钉的在前
    assert [s["n"] for s in srcs] == [1, 2]  # 合并后重新编号
    assert srcs[0]["text"] == "钉进来的正文"


async def test_a_thread_with_nothing_on_it_costs_nothing():
    t = await th.create("X")
    d = await th.detail(t["id"], suggest=False)
    assert d["cost"]["total"] == 0 and d["cost"]["by_model"] == {}


# ---------- 「今天从哪开始」（§4-17） ----------


async def test_recent_reports_state_not_a_debt_list():
    """只说它到哪了，不说你还欠哪一步——这个产品的红线就是不做债。"""
    t = await th.create("RAG 评测")
    assert await th.recent() == []  # 空的一件事不占位

    await th.attach(t["id"], "card", "7")
    (row,) = await th.recent()
    assert row["id"] == t["id"] and row["name"] == "RAG 评测"
    assert row["summary"] == "搞懂 1"
    assert "缺" not in row["summary"] and "未" not in row["summary"]
