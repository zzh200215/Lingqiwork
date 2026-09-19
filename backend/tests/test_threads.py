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
    # 这一格的左右两边**故意不一样**：kind 是 `session`（R3 从 `tutor` 改名），
    # 而路由仍然是 `/tutor`——页面路径是另一件事，改名去动路由与书签本份不做。
    assert th._href("session", "5") == "/tutor?session=5"
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


# ---------- 产物挂到一条「一件事」（M2，docs/work-module.md） ----------


async def test_resolve_reuses_the_thread_whose_name_matches():
    """题目就是这件事的名字：同名复用，不从第二件同名的事开始。"""
    t = await th.create("RAG 评测")
    hit = await th.resolve("RAG 评测的坑")  # 子串包含，与建议挂接同一把尺子
    assert hit["id"] == t["id"] and hit["created"] is False

    fresh = await th.resolve("向量库选型")
    assert fresh["created"] is True and fresh["id"] != t["id"]

    async with SessionLocal() as db:
        assert len((await db.execute(select(Thread))).scalars().all()) == 2


async def test_resolve_never_takes_back_an_archived_thread():
    """归档是你说「这件事完了」——它不该被下一轮工作又捡回去。"""
    t = await th.create("RAG")
    await th.update(t["id"], archived=True)
    again = await th.resolve("RAG")
    assert again["created"] is True and again["id"] != t["id"]


async def test_resolve_requires_a_title():
    for blank in ("", "   ", None):
        with pytest.raises(ValueError):
            await th.resolve(blank)  # type: ignore[arg-type]


async def test_a_session_attached_to_a_thread_reads_back_with_its_topic():
    """R3 的**接通性**测试：`kind="session"` 要能真的挂上、读回来、还能被教学那条线认出来。

    这条不是重复上面那些单点断言（`KINDS` 里有没有、`_href` 对不对），它盯的是
    **整条链**：写（`attach` 的 kind 守卫）→ 读（`_resolve` 那个 renaming 过的分支）
    → 反向消费（`tutor._neighbors_via_thread` 按同一个 kind 查）。

    为什么值得单独一条：改名 `tutor`→`session` 时，**每一处单独看都能改对，
    整条链却可能断在某一处漏改**——而那种断裂的表现是「挂接静默失败」或者
    「挂上了但标题是空、图标是灰的」，两条都不会报错。这里一次把三处都走一遍。
    """
    from app.models import TutorSession

    t = await th.create("读 asyncio")
    async with SessionLocal() as db:
        s = TutorSession(topic="asyncio 事件循环", concept="事件循环", verdict="got")
        db.add(s)
        await db.commit()
        await db.refresh(s)
        sid = s.id

    r = await th.attach(t["id"], "session", str(sid))
    assert r["attached"] is True
    # 幂等：同一条挂两次只留一条（与其它 kind 同一条规矩）
    assert (await th.attach(t["id"], "session", str(sid)))["attached"] is False

    items = (await th.detail(t["id"], suggest=False))["items"]
    assert len(items) == 1
    item = items[0]
    assert item["kind"] == "session"
    assert item["ref"] == str(sid)
    # **读得回来**：`_resolve` 里那个改名过的分支拿 TutorSession.topic 当标题；
    # 改漏了这里会 exists=False 且标题空（挂接看着挂上了，其实是个死引用）
    assert item["exists"] is True
    assert item["title"] == "asyncio 事件循环"
    assert item["href"] == f"/tutor?session={sid}"

    # 反向消费：教学那条线按**同一个 kind** 找「同一件事上的其它概念」。
    #
    # ⚠️ 这里直接考 `_neighbors_via_thread`，**不考 `concept_neighbors`**：
    #    后者还要过 `concepts()` 那层派生视图（按 verdict 过滤、按 `CONCEPTS_CAP` 截断），
    #    而那层的行为与本条要验的东西无关——用它当断言会变成「测派生视图的容量」。
    #    要验的是「改名之后，挂事这条路读得回来」，缝就在这个函数上。
    from app.core import tutor

    async with SessionLocal() as db:
        s2 = TutorSession(topic="JS 闭包", concept="闭包", verdict="got")
        db.add(s2)
        await db.commit()
        await db.refresh(s2)
        sid2 = s2.id
    await th.attach(t["id"], "session", str(sid2))

    # 同一件事上的另一个概念读得回来（`kind == "session"` 那两处查询）
    assert await tutor._neighbors_via_thread([sid]) == {"闭包"}
    # 而**没挂上**的会话不会被算进来（否则「同一件事」这个证据就是编的）
    assert await tutor._neighbors_via_thread([999999]) == set()

    # 旧名字不再是一个合法的 kind：两个名字并存 = 同一个东西两套写法（§4-7 要防的分叉）
    with pytest.raises(ValueError):
        await th.attach(t["id"], "tutor", str(sid))


async def test_attach_output_only_takes_products():
    """**成品**才挂：`tasks/` 是运行留痕、inbox 是待处理的材料、交接文件是中间的工序。

    挂错了，「这件事到哪了」里就会混进一堆其实不属于它的东西——这个仓库吃过两次口径
    不一致的亏（小屋架子 vs 工作页清单、`is_output_path` 的收口），所以这里钉住。
    """
    t = await th.create("选型")
    ok = await th.attach_output(t["id"], "research/2026-09-20-选型.md")
    assert ok["attached"] is True
    assert (await th.detail(t["id"], suggest=False))["items"][0]["ref"] == "research/2026-09-20-选型.md"

    for bad in (
        "tasks/x.md",  # 运行留痕，不是成品
        "meetings/inbox/a.md",  # 待处理的材料
        "tasks/handoff/a-to-b.md",  # 中间的工序
        "notes/2026-09-20-成文.md",  # 成文不算（不是工作链的产出）
        "deliver",  # 目录本身，不是一份成品
        "",
        "   ",
    ):
        out = await th.attach_output(t["id"], bad)
        assert out["attached"] is False, bad

    assert (await th.detail(t["id"], suggest=False))["total"] == 1  # 那七条一条都没进去


def test_is_product_knows_a_meeting_from_its_inbox():
    """M5：一场会议的产物算成品，`meetings/inbox/` 不算——判据只有一处（`is_product`）。

    会议这条路径是后加的（在这之前 `meetings` 根本不在成品目录里），而它多一层结构，
    所以「算不算成品」不能只看顶层目录：`meetings/<日期>-<录音名>/<文件>.md` 才是成品。
    """
    assert th.is_product("meetings/2026-09-13-周会/会议·纪要-2026-09-13-1030.md") is True
    assert th.is_product("meetings/inbox/待处理.md") is False
    assert th.is_product("meetings/2026-09-13-周会") is False  # 目录本身不是一份成品
    assert th.is_product("research/2026-09-20-选型.md") is True
    assert th.is_product("tasks/x.md") is False
    assert th.is_product("") is False


async def test_attach_output_is_idempotent_and_survives_a_missing_thread():
    """同一份产物挂两次只留一条；这件事不在了也只是不挂，不抛。"""
    t = await th.create("X")
    assert (await th.attach_output(t["id"], "deliver/a.md"))["attached"] is True
    assert (await th.attach_output(t["id"], "deliver/a.md"))["attached"] is False
    assert (await th.detail(t["id"], suggest=False))["total"] == 1

    gone = await th.attach_output(9999, "deliver/a.md")
    assert gone["attached"] is False and "这件事不在了" in gone["reason"]


async def test_attach_output_refuses_a_path_that_escapes_the_vault():
    """越界的引用不挂（`_clean_ref` 那层守卫），而且要说清为什么没挂。"""
    t = await th.create("X")
    out = await th.attach_output(t["id"], "../secrets.md")
    assert out["attached"] is False and out["reason"] == "ref 越界"
    assert (await th.detail(t["id"], suggest=False))["total"] == 0


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
