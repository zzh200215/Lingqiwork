"""A4：agent 看得见「手头那件事」（`Agent升级.md` §2）。

分三层，**每一层的失败模式不同**，所以分开测：

1. **纯函数**（`refers_to_thread` / `block`）——指涉判定、引用只列能打开的、200 字上限。
   这一层不碰库、不碰模型，是"上限"与"零注入"两条验收的落点。
2. **取数**（`threads.brief`）——最近一件事的名字/进度/引用清单，口径必须与
   `today.next_suggestion` 读的那份**同源**（都走 `recent()`），不另立一套。
3. **接线**（`/api/chat` 的 `_generate`）——走真的路由、真的 system 组装、真的库，
   只在最外面把 `run_agentic_chat` 换成记账的替身，抄下模型最终收到的 messages。
   `pet_context`（Z1）与 `delegate`（A1）各有一条同款；`docs/r-checklist.md` §1 第 14 条
   写着为什么非要有这一层：尺子那条路才是最可能静默坏掉的地方。
"""
import asyncio

import pytest
from sqlalchemy import delete as sa_delete
from sqlalchemy import select

from app.config import VAULT_DIR
from app.core import thread_context as tc
from app.core import threads as th
from app.db import SessionLocal
from app.models import Agent, Card, Conversation, Message, ModelProfile, ModelProfileChange
from app.models import ProviderConfig, Thread, ThreadItem


@pytest.fixture(autouse=True)
def _clean():
    """这个模块共用一个库：上一条用例种的事/会话会漏进下一条（同 `test_threads` 的形状）。"""

    async def _go() -> None:
        async with SessionLocal() as db:
            for model in (
                ThreadItem,
                Thread,
                Card,
                Message,
                Conversation,
                Agent,
                ProviderConfig,
                ModelProfileChange,
                ModelProfile,
            ):
                await db.execute(sa_delete(model))
            await db.commit()

    asyncio.run(_go())
    yield


# ---------- 第 1 层：指涉判定 ----------


@pytest.mark.parametrize(
    "text",
    [
        "继续推进那件事",
        "这件事我到哪了",
        "那个方案再改改",
        "接着上",
        "上次那个项目的进度怎么样",
        "帮我看看这个任务",
        "刚才那件事的结论是什么",
    ],
)
def test_a_reference_hits(text):
    assert tc.refers_to_thread(text)


@pytest.mark.parametrize(
    "text",
    [
        "帮我翻译这段话",
        "今天天气怎么样",
        "写个快排",
        "把这段代码改成异步的",
    ],
)
def test_a_plain_question_does_not_hit(text):
    """无关提问里不掺一段不属于它的事——这正是选「只在指涉时注入」换来的东西。"""
    assert not tc.refers_to_thread(text)


def test_junk_does_not_hit():
    assert not tc.refers_to_thread("")
    assert not tc.refers_to_thread("   ")
    assert not tc.refers_to_thread(None)


def test_spaces_inside_the_words_still_hit():
    """中文输入法下「这 件 事」并不罕见；抹掉空白再比一次，代价只是一次 split。"""
    assert tc.refers_to_thread("这 件 事 我 到 哪 了")


def test_the_read_tool_named_in_the_prompt_really_exists():
    """**这条是防「注入段指使模型去调一个不存在的工具」的。**

    方案原文随手写的是「read_file」，而工具的真名是 `vault_read_file`（`mcp.BUILTIN_TOOLS`
    里长出来的）。提示词里点错名字，模型会去调一个不存在的工具、白烧一轮——所以要拿两处
    现成的真值对：产品自己的工具表，以及子代理那份只读清单。
    """
    from app.core import delegate, mcp

    names = {t["name"] for t in mcp.BUILTIN_TOOLS}
    assert tc.READ_TOOL in names, f"{tc.READ_TOOL} 不是产品里真有的工具"
    assert tc.READ_TOOL in delegate.READONLY_TOOLS
    assert tc.READ_TOOL in tc.THREAD_HEAD, "注入段必须点名那把真工具"


# ---------- 第 1 层：注入段的形状与上限 ----------


def _thread(**kw) -> dict:
    base = {"id": 1, "name": "RAG 升级", "summary": "搞懂 2 · 留下 1"}
    return {**base, **kw}


def test_no_thread_no_block():
    assert tc.block(None) == ""
    assert tc.block({}) == ""
    assert tc.block("RAG 升级") == ""


def test_a_thread_without_a_name_is_dropped():
    """事名是这一段唯一的身份。没有名字就没什么可说的——空串，不是「《》」。"""
    assert tc.block(_thread(name="")) == ""


def test_the_block_carries_the_name_the_progress_and_the_refs():
    items = [
        {"kind": "output", "ref": "research/2026-09-20-rag.md", "title": "RAG 升级·归档", "exists": True},
        {"kind": "material", "ref": "clippings/vec.md", "title": "向量库对比", "exists": True},
    ]
    out = tc.block(_thread(), items)
    assert out.startswith(tc.THREAD_HEAD)
    assert "《RAG 升级》" in out and "搞懂 2 · 留下 1" in out
    assert "成品《RAG 升级·归档》 research/2026-09-20-rag.md" in out
    assert "材料《向量库对比》 clippings/vec.md" in out


def test_only_refs_a_tool_can_open_are_listed():
    """卡片/教学/任务/判断的 ref 是**数据库主键**，agent 手里没有读它们的工具。

    列出来只会诱它拿 `vault_read_file` 去读一个数字、白烧一轮。那四类的事实在摘要计数里
    已经有了，不必再列一遍。
    """
    out = tc.block(
        _thread(summary="搞懂 1"),
        [
            {"kind": "card", "ref": "7", "title": "什么是 RRF", "exists": True},
            {"kind": "session", "ref": "3", "title": "asyncio", "exists": True},
            {"kind": "output", "ref": "deliver/x.md", "title": "成品", "exists": True},
        ],
    )
    assert "什么是 RRF" not in out and "asyncio" not in out
    assert "deliver/x.md" in out
    assert "搞懂 1" in out  # 那四类的进度还在计数里


def test_a_dead_ref_is_not_listed():
    """引用不在了（`threads._resolve` 标 `exists=False`）：别拿一条死路径占预算。"""
    out = tc.block(
        _thread(),
        [
            {"kind": "note", "ref": "notes/gone.md", "title": "（已不存在）", "exists": False},
            {"kind": "note", "ref": "notes/here.md", "title": "还在", "exists": True},
        ],
    )
    assert "notes/gone.md" not in out
    assert "notes/here.md" in out


def test_the_cap_drops_refs_before_the_identity():
    """超预算时**先丢引用行**——名字与进度最要紧，它们必须活到最后。"""
    items = [
        {"kind": "output", "ref": f"research/{i}-" + "长" * 60 + ".md", "title": "标题" * 20, "exists": True}
        for i in range(6)
    ]
    out = tc.block(_thread(name="长" * 100, summary="搞懂 9 · 留下 9"), items)
    assert len(out) <= tc.MAX_CHARS
    assert "《" in out and "搞懂 9 · 留下 9" in out  # 身份与进度活下来了
    assert out.count("\n") < 1 + tc.REFS  # 引用被丢到了上限以内


def test_at_most_refs_lines_are_listed():
    items = [
        {"kind": "note", "ref": f"notes/{i}.md", "title": f"第{i}条", "exists": True} for i in range(9)
    ]
    out = tc.block(_thread(), items)
    assert out.count("- ") == 1 + tc.REFS


def test_the_cap_is_hard_even_for_a_giant_head(monkeypatch):
    """最后那道硬截（表头 + 身份行本身就超预算）也得有——不然上限只是「通常成立」。"""
    monkeypatch.setattr(tc, "MAX_CHARS", 40)
    out = tc.block(_thread(), None)
    assert len(out) <= 40
    assert out.endswith("…")


def test_the_cap_hits_the_whole_block_not_just_the_body():
    """上限管的是**整段**（含表头）：验收原文是「注入段有上限，不超 200 字」。"""
    out = tc.block(_thread(), None)
    assert len(out) <= tc.MAX_CHARS


# ---------- 第 1 层：三支闸门 ----------


def test_no_trigger_means_no_injection():
    assert asyncio.run(tc.recent_block("帮我翻译这段话")) == ""


def test_the_switch_off_means_no_injection():
    assert asyncio.run(tc.recent_block("继续推进那件事", enabled=False)) == ""


def test_without_the_read_tool_nothing_is_injected():
    """这一段写着「用 vault_read_file 打开」，而那个 agent 拿不到它——

    不能指使模型去调一个它没有的工具（同 `_OUTPUT_RULE` 的闸门）。
    """
    assert asyncio.run(tc.recent_block("继续推进那件事", can_read=False)) == ""


# ---------- 第 2 层：取数（口径同源） ----------


async def _add_thread(name: str, refs: list[tuple[str, str]]) -> int:
    async with SessionLocal() as db:
        t = Thread(name=name)
        db.add(t)
        await db.commit()
        await db.refresh(t)
        for kind, ref in refs:
            db.add(ThreadItem(thread_id=t.id, kind=kind, ref=ref))
        await db.commit()
        return t.id


async def _brief():
    return await th.brief()


def test_brief_is_none_when_nothing_is_hung_on_anything():
    """没有事 / 事上还没挂东西——两种都是 `None`（`recent()` 只认挂了东西的那条）。"""

    async def go():
        await _add_thread("空壳", [])
        return await th.brief()

    assert asyncio.run(go()) is None


def test_brief_is_the_most_recent_thread_with_its_refs():
    async def go():
        await _add_thread("旧事", [("note", "notes/old.md")])
        await _add_thread("新事", [("output", "deliver/new.md")])
        return await th.brief()

    b = asyncio.run(go())
    assert b["name"] == "新事"
    assert b["summary"]  # 与 `today` 同源那句进度
    assert [i["ref"] for i in b["items"]] == ["deliver/new.md"]
    assert b["items"][0]["title"]  # 过了解析（标题不是空）


# ---------- 第 3 层：真的走到 `/api/chat` 的 messages 里 ----------

def _write_vault(rel: str, title: str) -> None:
    p = VAULT_DIR / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(f"# {title}\n\n正文（这一段**不该**被搬进 system）。\n", encoding="utf-8")


def _seed_thing() -> int:
    """一条真挂了成品的「事」——vault 里也真有那个文件（`_resolve` 会去看它在不在）。"""
    _write_vault("research/2026-09-20-rag.md", "RAG 升级·归档")
    return asyncio.run(_add_thread("RAG 升级", [("output", "research/2026-09-20-rag.md")]))


def _seed_provider() -> None:
    async def go() -> None:
        async with SessionLocal() as db:
            db.add(
                ProviderConfig(
                    name="stub",
                    kind="openai",
                    base_url="https://stub",
                    api_key="k",
                    models=["stub-m"],
                    enabled=True,
                )
            )
            db.add(Conversation(id=9101, title="t", model_id="stub/stub-m"))
            await db.commit()
            await db.execute(sa_delete(ModelProfileChange))
            await db.execute(sa_delete(ModelProfile))

    asyncio.run(go())


def _capture(monkeypatch) -> dict:
    """把 `run_agentic_chat` 换成一个只记账的替身，抄下模型最终收到的 messages。"""
    from app.routers import chat

    seen: dict = {}

    async def fake(info, model, messages, tools, run_tool, emit_text, emit_tool, **kw):  # noqa: ARG001
        seen["messages"] = [dict(m) for m in messages]
        seen["system"] = "\n\n".join(
            str(m.get("content")) for m in messages if m.get("role") == "system"
        )
        emit_text("在。")
        return "在。"

    async def _no_followups(*_a, **_k):
        return []

    monkeypatch.setattr(chat, "run_agentic_chat", fake)
    monkeypatch.setattr(chat, "_generate_followups", _no_followups)
    return seen


def _drive_and_capture(monkeypatch, text: str, *, prefs: dict | None = None, agent_id=None) -> dict:
    from app.routers import chat

    conf = {"memory_enabled": False, "automemory_enabled": False}
    conf.update(prefs or {})
    monkeypatch.setattr(chat, "load_config", lambda: conf)
    seen = _capture(monkeypatch)

    async def go() -> None:
        async for _frame in chat._generate(
            chat.ChatRequest(conversation_id=9101, content=text, use_rag=False, agent_id=agent_id)
        ):
            pass

    asyncio.run(go())
    return seen


def test_the_chat_sees_the_thing_when_you_point_at_it(monkeypatch):
    _seed_provider()
    _seed_thing()
    seen = _drive_and_capture(monkeypatch, "继续推进那件事")

    assert tc.THREAD_HEAD in seen["system"]
    assert "《RAG 升级》" in seen["system"]
    assert "research/2026-09-20-rag.md" in seen["system"]
    # 纪律 1：**只给引用，不搬内容**——正文一个字都不许进 system
    assert "正文（这一段" not in seen["system"]


def test_a_plain_message_gets_no_thing(monkeypatch):
    """同一件事在场，但这一句没指涉它 → 一个字都不注入。"""
    _seed_provider()
    _seed_thing()
    seen = _drive_and_capture(monkeypatch, "帮我翻译这段话")
    assert tc.THREAD_HEAD not in seen["system"]
    assert "RAG 升级" not in seen["system"]


def test_no_thread_at_all_means_zero_injection(monkeypatch):
    """验收第 2 条：没有任何 Thread 时零注入——**也不许写「你还没有任何事」**。"""
    _seed_provider()
    seen = _drive_and_capture(monkeypatch, "继续推进那件事")
    assert tc.THREAD_HEAD not in seen["system"]
    for word in ("没有任何事", "还没有", "你手头"):
        assert word not in seen["system"]


def test_the_switch_off_means_zero_injection(monkeypatch):
    _seed_provider()
    _seed_thing()
    seen = _drive_and_capture(monkeypatch, "继续推进那件事", prefs={"thread_context_enabled": False})
    assert tc.THREAD_HEAD not in seen["system"]


def test_an_agent_without_the_read_tool_gets_no_thing(monkeypatch):
    """白名单里没有 `vault_read_file` → 这一段不许出现（它写着「用那把工具打开」）。

    两条一起钉：白名单**留着**那把工具时照常注入，只给 `vault_list_files` 时一个字都没有
    ——差别只可能来自那一个判据。
    """
    _seed_provider()
    _seed_thing()

    async def _add_agent(whitelist: str) -> int:
        async with SessionLocal() as db:
            a = Agent(name=f"a{whitelist or 'all'}", tool_whitelist=whitelist)
            db.add(a)
            await db.commit()
            await db.refresh(a)
            return a.id

    with_read = asyncio.run(_add_agent("vault_list_files vault_read_file"))
    without = asyncio.run(_add_agent("vault_list_files"))

    seen = _drive_and_capture(monkeypatch, "继续推进那件事", agent_id=with_read)
    assert tc.THREAD_HEAD in seen["system"]
    # 一次会话一条用户消息（`_drive` 会落库），是新一轮的对话所以不会被历史带上
    seen = _drive_and_capture(monkeypatch, "继续推进那件事", agent_id=without)
    assert tc.THREAD_HEAD not in seen["system"]


async def _add_agent_no_tools() -> int:
    async with SessionLocal() as db:
        a = Agent(name="none", tool_whitelist="none")
        db.add(a)
        await db.commit()
        await db.refresh(a)
        return a.id


def test_an_agent_with_no_tools_at_all_gets_no_thing(monkeypatch):
    _seed_provider()
    _seed_thing()
    aid = asyncio.run(_add_agent_no_tools())
    seen = _drive_and_capture(monkeypatch, "继续推进那件事", agent_id=aid)
    assert tc.THREAD_HEAD not in seen["system"]


# ---------- 第 4 层：这一轮读哪几份（编排器的材料清单）----------


def test_materials_of_keeps_only_what_a_tool_can_open():
    """给编排器的清单与注入段**同一把尺子**（`_readable`）：能打开的才给，排序去重。

    `card`/`session`/`task`/`decision` 的 ref 是数据库主键——拿给编排器只会让它派一路去读
    一个读不了的东西（白烧一轮），与注入段那边是同一条理由。
    """
    items = [
        {"kind": "output", "ref": "research/b.md", "exists": True},
        {"kind": "note", "ref": "notes/a.md", "exists": True},
        {"kind": "note", "ref": "notes/a.md", "exists": True},  # 重复 → 去重
        {"kind": "card", "ref": "7", "exists": True},  # 主键 → 不给
        {"kind": "material", "ref": "clippings/gone.md", "exists": False},  # 不在了 → 不给
        "junk",
    ]
    assert tc.materials_of(items) == ["notes/a.md", "research/b.md"]
    assert tc.materials_of(None) == []
    assert tc.materials_of([]) == []


def test_materials_for_needs_a_reference_and_a_thing():
    """没指涉 / 没那件事 / 开关关着 → 空表（调用方回落到「不分工」的老行为，不去猜）。"""
    assert asyncio.run(tc.materials_for("帮我写个快排")) == []

    async def go():
        _write_vault("research/2026-09-20-rag.md", "RAG 升级·归档")
        await _add_thread("RAG 升级", [("output", "research/2026-09-20-rag.md"), ("card", "7")])
        return (
            await tc.materials_for("继续推进那件事"),
            await tc.materials_for("继续推进那件事", enabled=False),
        )

    got, off = asyncio.run(go())
    assert got == ["research/2026-09-20-rag.md"]  # 只给能打开的那一份
    assert off == []


# ---------- 第 5 层：材料清单的第二个来源（用户钉的那几份，2026-09-22） ----------


def test_pinned_materials_keep_only_what_a_tool_can_open():
    """钉进来的 spec 也过 `_readable` 那一把尺子——**保序**，不是排序。

    三种被跳过的：`repo:` / `dir:`（vault 之外，`vault_read_file` 打不开）、不在 vault 里的
    路径、重复的。顺序按**你钉的先后**：fanout 的读步就是照这个顺序一路一份生成的。
    """
    _write_vault("notes/索引.md", "索引笔记")
    _write_vault("clippings/材料.md", "材料")

    got = tc.pinned_materials(
        [
            "clippings/材料.md",
            "repo:some-repo/a.md",
            "notes/不存在.md",
            "notes/索引.md",
            "clippings/材料.md",  # 重复
            "/notes/索引.md",  # 前导斜杠：形状不同、指的是同一份
            "  ",
            "",
        ]
    )
    assert got == ["clippings/材料.md", "notes/索引.md"]


def test_pinned_materials_caps_the_read_steps():
    """份数直接乘时间（每份 = 一个读步 = 一次模型调用），所以钉多了要有人刹车。"""
    for i in range(8):
        _write_vault(f"notes/p{i}.md", f"第 {i} 篇")
    specs = [f"notes/p{i}.md" for i in range(8)]

    assert len(tc.pinned_materials(specs)) == tc.MATERIAL_CAP
    assert tc.pinned_materials(specs) == specs[: tc.MATERIAL_CAP]
    assert tc.pinned_materials(specs, cap=2) == specs[:2]
    # 坏输入不抛：协作的路由不该因为这一栏形状不对而 500
    assert tc.pinned_materials(None) == []
    assert tc.pinned_materials("notes/p0.md") == []


def test_the_collab_route_takes_pinned_materials_as_a_second_source(monkeypatch):
    """**第二个来源**：你钉的那几份也进编排器，而且**不指涉那件事也行**——人指的不猜。

    三条一起钉：① 钉的排在推断出来的前面（与交付那条「钉进来的材料排在取材结果最前」
    同一个先后）；② 两边都有的只留一条；③ 读步打不开的（`repo:` / 路径不在）当场跳过。
    """
    from fastapi.testclient import TestClient

    from app.core import auth
    from app.routers import agents as agents_router

    _write_vault("research/2026-09-20-rag.md", "RAG 升级·归档")
    _write_vault("notes/索引.md", "索引笔记")
    _write_vault("clippings/材料.md", "材料")
    assert asyncio.run(
        _add_thread(
            "RAG 升级",
            [("output", "research/2026-09-20-rag.md"), ("note", "notes/索引.md")],
        )
    )

    async def _seed_agents_and_conv() -> list[int]:
        async with SessionLocal() as db:
            db.add(Conversation(id=9202, title="t", model_id="stub/stub-m"))
            for name in ("甲", "乙"):
                db.add(Agent(name=name))
            await db.commit()
            return list((await db.execute(select(Agent.id))).scalars())

    agent_ids = asyncio.run(_seed_agents_and_conv())

    seen: dict = {}

    async def fake_run(goal, agents, pattern, resolve, retrieve, **kw):  # noqa: ARG001
        seen.update({"goal": goal, "materials": kw.get("materials")})
        yield "meta", {"pattern": pattern, "parallel": False, "steps": []}
        yield "done", {"facts": [], "transcript": ""}

    monkeypatch.setattr(agents_router.collab, "run", fake_run)
    monkeypatch.setenv("WB_API_TOKEN", "test-token-123")
    monkeypatch.setattr(auth, "_cached", None)
    from app.main import app

    client = TestClient(app)

    def _post(goal: str, pinned: list[str]):
        return client.post(
            "/api/agents/collab",
            json={
                "conversation_id": 9202,
                "goal": goal,
                "agent_ids": agent_ids,
                "pattern": "fanout",
                "pinned": pinned,
            },
            headers={auth.HEADER: "test-token-123"},
        )

    # ① 不指涉那件事：清单**只有**钉的那几份（不去猜），且按钉的顺序
    r = _post("帮我写个快排", ["clippings/材料.md", "repo:x/a.md", "notes/不存在.md"])
    assert r.status_code == 200, r.text
    assert seen["materials"] == ["clippings/材料.md"], seen["materials"]

    # ② 指涉那件事：钉的在前，那件事挂着的补在后面，重的只留一条
    seen.clear()
    r2 = _post("继续推进那件事", ["notes/索引.md"])
    assert r2.status_code == 200, r2.text
    assert seen["materials"] == [
        "notes/索引.md",
        "research/2026-09-20-rag.md",
    ], "钉的没排在前面，或与那件事挂着的那份没去重"

    # ③ 一条都没钉、也不指涉 → 仍然是 None（老行为：不分工，不去猜）
    seen.clear()
    r3 = _post("帮我写个快排", [])
    assert r3.status_code == 200, r3.text
    assert seen["materials"] is None


def test_the_collab_route_hands_the_thing_to_the_orchestrator(monkeypatch):
    """**全管道**：题面指涉「那件事」时，协作路由真的把材料清单交给了编排器。

    这是 A2 挂账②那条边界的正面证据。在那之前 `collab.run` 拿到的 `materials` **恒为 None**
    （只有尺子在传），所以「分材料 + 拆读步」在线上从来没生效过——量得再准也只是尺子里的形状。
    """
    from fastapi.testclient import TestClient

    from app.core import auth
    from app.routers import agents as agents_router

    _write_vault("research/2026-09-20-rag.md", "RAG 升级·归档")
    _write_vault("notes/索引.md", "索引笔记")
    _write_vault("clippings/材料.md", "材料")
    assert asyncio.run(
        _add_thread(
            "RAG 升级",
            [
                ("output", "research/2026-09-20-rag.md"),
                ("note", "notes/索引.md"),
                ("material", "clippings/材料.md"),
            ],
        )
    )

    async def _seed_agents_and_conv() -> list[int]:
        async with SessionLocal() as db:
            db.add(Conversation(id=9201, title="t", model_id="stub/stub-m"))
            for name in ("甲", "乙"):
                db.add(Agent(name=name))
            await db.commit()
            return list((await db.execute(select(Agent.id))).scalars())

    agent_ids = asyncio.run(_seed_agents_and_conv())

    seen: dict = {}

    async def fake_run(goal, agents, pattern, resolve, retrieve, **kw):  # noqa: ARG001
        seen.update({"goal": goal, "materials": kw.get("materials")})
        yield "meta", {"pattern": pattern, "parallel": False, "steps": []}
        yield "done", {"facts": [], "transcript": ""}

    monkeypatch.setattr(agents_router.collab, "run", fake_run)
    monkeypatch.setenv("WB_API_TOKEN", "test-token-123")
    monkeypatch.setattr(auth, "_cached", None)
    from app.main import app

    client = TestClient(app)

    def _post(goal: str):
        return client.post(
            "/api/agents/collab",
            json={
                "conversation_id": 9201,
                "goal": goal,
                "agent_ids": agent_ids,
                "pattern": "fanout",
            },
            headers={auth.HEADER: "test-token-123"},
        )

    r = _post("继续推进那件事")
    assert r.status_code == 200, r.text
    assert seen["goal"] == "继续推进那件事"
    assert seen["materials"] == [
        "clippings/材料.md",
        "notes/索引.md",
        "research/2026-09-20-rag.md",
    ], "路由没把这件挂在的材料交给编排器"

    # 不指涉那件事时**不许瞎给**：宁可不分工，也别塞一批"可能相关"的材料
    seen.clear()
    r2 = _post("帮我写个快排")
    assert r2.status_code == 200, r2.text
    assert seen["materials"] is None
