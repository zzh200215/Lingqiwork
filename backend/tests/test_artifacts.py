"""`save_artifact` 工具 + `tool_result` 旁路（P1：长文卡改一行回执）。

三件事要钉住：
1. 存下来的成品**真的落在产出目录里**——回执链接指向的文件必须存在，否则
   「已存入产出」是句谎话，点开就是 404。
2. 副产物走 `_TOOL_META` 交给界面，且**并行工具不串味**。
3. `run_agentic_chat` 在工具跑完后触发 `emit_tool_result`；没接这条回调时
   行为与改动前完全一致（无人值守路径不关心回执）。

WB_* 环境变量在导入 app 前设置；vault 落在项目内临时目录。
"""
import asyncio
import atexit
import json
import os
import shutil
import sys
import tempfile
from pathlib import Path

import pytest
from fastapi import HTTPException
from sqlalchemy import select

sys.path.insert(0, ".")

_TMP = Path(tempfile.mkdtemp(prefix="wb-artifacts-", dir=Path(__file__).parent))
os.environ["WB_DB_PATH"] = str(_TMP / "test.db")
os.environ["WB_CONFIG_PATH"] = str(_TMP / "config.json")
os.environ["WB_VAULT_DIR"] = str(_TMP / "vault")


def _cleanup() -> None:
    shutil.rmtree(_TMP, ignore_errors=True)


atexit.register(_cleanup)

from app.config import VAULT_DIR  # noqa: E402
from app.core import llm, mcp  # noqa: E402
from app.core.llm import ProviderInfo, ToolCall  # noqa: E402
from app.db import SessionLocal, engine  # noqa: E402
from app.models import Base, Conversation, Message, ProviderConfig  # noqa: E402
from app.routers import chat  # noqa: E402


# --- 落盘 -------------------------------------------------------------------


def test_save_artifact_writes_into_the_kind_directory():
    """体裁决定落点目录——落对了才进得了工作页产出清单。"""
    out = asyncio.run(
        mcp._save_artifact({"kind": "research", "title": "向量库选型", "content": "正文一段。"})
    )
    assert "向量库选型" in out
    files = list((VAULT_DIR / "research").glob("*.md"))
    assert len(files) == 1
    text = files[0].read_text(encoding="utf-8")
    assert text.startswith("# 向量库选型")  # 没给 H1 时补上标题
    assert "正文一段。" in text


def test_save_artifact_keeps_an_existing_h1():
    """模型已经写了 H1 就不重复加标题——正文是给人看的成品，不该被重排。"""
    asyncio.run(
        mcp._save_artifact({"kind": "deliver", "title": "周报", "content": "# 本周进展\n\n做完了 A。"})
    )
    text = next((VAULT_DIR / "deliver").glob("*.md")).read_text(encoding="utf-8")
    assert text.count("# ") == 1
    assert text.startswith("# 本周进展")


def test_save_artifact_rejects_unknown_kind_and_empty_content():
    assert "错误" in asyncio.run(
        mcp._save_artifact({"kind": "nope", "title": "x", "content": "y"})
    )
    assert "错误" in asyncio.run(
        mcp._save_artifact({"kind": "research", "title": "x", "content": "   "})
    )
    # 拒绝的调用不该留下半个文件
    assert not (VAULT_DIR / "nope").exists()


def test_every_kind_lands_somewhere_pet_counts_as_output():
    """`_OUTPUT_DIRS` 是零柒算成长值读的目录。存进去的产出必须出现在那里，
    否则「你交出 N 份」的数会漏掉会话里存下来的。"""
    from app.core import pet

    for kind, (dir_name, _label) in mcp._ARTIFACT_KINDS.items():
        if dir_name != "notes":  # notes 是成文的自留地，不重复计入产出数
            assert dir_name in pet._OUTPUT_DIRS, f"{kind} → {dir_name} 不在产出目录里"


# --- meta 旁路 --------------------------------------------------------------


def test_meta_carries_a_clickable_href():
    art = asyncio.run(_call_and_take({"kind": "decide", "title": "上不上", "content": "结论：上。"}))[
        "artifact"
    ]
    assert art["kind"] == "decide"
    assert art["path"].startswith("decisions/")
    assert art["href"].startswith("/notes?path=")


def test_take_is_read_once_then_cleared():
    """take 读完即清——同一个 context 里再取就是 None，不会重复交出同一份。"""
    assert asyncio.run(_call_and_take_twice({"kind": "recap", "title": "复盘", "content": "x"}))


def test_meta_is_cleared_before_each_call():
    """上一次的 meta 必须不能漏给下一次：`vault_list_files` 不写 meta，
    但它跑完不能把上一个工具的产出当自己的交出去。"""
    assert asyncio.run(_call_then_take_after_plain_tool())


async def _call_and_take(args: dict) -> dict:
    # 必须在**同一个 context** 里取：ContextVar 跟着 asyncio.run 的 context 走，
    # 跑到外边读是另一个 context，读到的永远是 None。
    await mcp.McpManager().call_tool("save_artifact", args)
    meta = mcp.take_tool_meta()
    assert meta is not None
    return meta


async def _call_and_take_twice(args: dict) -> bool:
    await mcp.McpManager().call_tool("save_artifact", args)
    return mcp.take_tool_meta() is not None and mcp.take_tool_meta() is None


async def _call_then_take_after_plain_tool() -> bool:
    mgr = mcp.McpManager()
    await mgr.call_tool("save_artifact", {"kind": "recap", "title": "复盘", "content": "x"})
    assert mcp.take_tool_meta() is not None
    # 再来一个不写 meta 的工具：它跑完，meta 不能是上一个的残留
    await mgr.call_tool("save_artifact", {"kind": "recap", "title": "复盘2", "content": "y"})
    await mgr.call_tool("vault_list_files", {})
    return mcp.take_tool_meta() is None


# --- 并行不串味 -------------------------------------------------------------


def test_parallel_artifacts_do_not_cross_talk():
    """两个 save_artifact 并行跑，各自拿到自己的 meta。

    ContextVar 而非实例属性就是为这条：并行任务各有一份上下文，共享属性会打架——
    「甲」的回执绝不能写成「乙」的路径。
    """
    results = asyncio.run(_parallel_saves())
    assert set(results) == {"甲", "乙"}
    assert results["甲"]["artifact"]["title"] == "甲"
    assert results["乙"]["artifact"]["title"] == "乙"
    assert results["甲"]["artifact"]["path"] != results["乙"]["artifact"]["path"]


async def _parallel_saves() -> dict[str, dict]:
    async def one(title: str):
        await mcp.McpManager().call_tool(
            "save_artifact", {"kind": "compose", "title": title, "content": f"正文 {title}"}
        )
        return title, mcp.take_tool_meta()

    return dict(await asyncio.gather(one("甲"), one("乙")))


# --- emit_tool_result 接线 --------------------------------------------------


def test_emit_tool_result_fires_after_a_tool_runs(monkeypatch):
    captured: list = []
    asyncio.run(_drive(monkeypatch, captured))
    assert len(captured) == 1
    name, args, meta = captured[0]
    assert name == "save_artifact"
    assert args["title"] == "落点"
    assert meta["artifact"]["path"].startswith("notes/")


async def _drive(monkeypatch, captured):
    it = iter(
        [
            ("", [ToolCall("1", "save_artifact", {"kind": "compose", "title": "落点", "content": "正文"})]),
            ("done", []),
        ]
    )

    async def fake_openai_round(client, model, messages, tools, emit_text, usage_out=None):
        text, calls = next(it)
        return text, calls

    monkeypatch.setattr(llm, "_openai_round", fake_openai_round)
    monkeypatch.setattr(llm, "_openai_client", lambda p: _NoClose())

    async def run_tool(name, args):
        return await mcp.McpManager().call_tool(name, args)

    return await llm.run_agentic_chat(
        ProviderInfo(kind="openai", base_url="", api_key="k"),
        "m",
        [{"role": "user", "content": "存一份"}],
        [{"type": "function", "function": {"name": "save_artifact", "parameters": {}}}],
        run_tool=run_tool,
        emit_text=lambda t: None,
        emit_tool=lambda n, a: None,
        emit_tool_result=lambda n, a, m: captured.append((n, a, m)),
    )


def test_absent_emit_tool_result_is_not_an_error(monkeypatch):
    """无人值守的定时任务不接这条回调——缺了它，工具照跑，只是没人听回执。"""
    text = asyncio.run(_drive_without_emit(monkeypatch))
    assert text == "done"
    assert len(list((VAULT_DIR / "notes").glob("*.md"))) >= 1


async def _drive_without_emit(monkeypatch) -> str:
    it = iter(
        [
            ("", [ToolCall("1", "save_artifact", {"kind": "compose", "title": "无人值守", "content": "正文"})]),
            ("done", []),
        ]
    )

    async def fake_openai_round(client, model, messages, tools, emit_text, usage_out=None):
        text, calls = next(it)
        return text, calls

    monkeypatch.setattr(llm, "_openai_round", fake_openai_round)
    monkeypatch.setattr(llm, "_openai_client", lambda p: _NoClose())

    return await llm.run_agentic_chat(
        ProviderInfo(kind="openai", base_url="", api_key="k"),
        "m",
        [{"role": "user", "content": "x"}],
        [{"type": "function", "function": {"name": "save_artifact", "parameters": {}}}],
        run_tool=lambda name, args: mcp.McpManager().call_tool(name, args),
        emit_text=lambda t: None,
        emit_tool=lambda n, a: None,
    )


class _NoClose:
    async def close(self):
        pass


# --- 落库：只存产出、一个字没说的那一轮不能整个消失 -------------------------


async def _prepare_db(conv_id: int) -> None:
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    async with SessionLocal() as db:
        exists = (
            await db.execute(select(ProviderConfig).where(ProviderConfig.name == "stub"))
        ).scalar_one_or_none()
        if exists is None:
            db.add(ProviderConfig(name="stub", kind="openai", base_url="", enabled=True))
            await db.commit()
        if await db.get(Conversation, conv_id) is None:
            db.add(Conversation(id=conv_id, title="t", model_id="stub/m"))
            await db.commit()


async def _no_followups(*_a, **_k):
    return []


def _stub_turn(monkeypatch, rounds):
    """把模型换成一份写死的剧本：每轮是 (这一轮吐的文本, 这一轮发的工具调用)。

    有工具调用的那一轮返回 ""，照抄 llm.py:155（tool turn 的 pre-text 被丢掉）。

    `rounds` 传列表 = 所有模型共用（单路够用）；传 {model: 列表} = 按模型分开。
    对比模式两路是并发跑的，共用一个迭代器会互相抢轮次——必须按模型分。
    """
    if isinstance(rounds, dict):
        by_model = {k: iter(v) for k, v in rounds.items()}

        def queue_for(model):
            return by_model[model]
    else:
        shared = iter(rounds)

        def queue_for(model):
            return shared

    async def fake_round(client, model, messages, tools, emit_text, usage_out=None):
        text, calls = next(queue_for(model), ("", []))
        for ch in text:
            emit_text(ch)
        return ("", calls) if calls else (text, calls)

    monkeypatch.setattr(llm, "_openai_round", fake_round)
    monkeypatch.setattr(llm, "_openai_client", lambda p: _NoClose())
    monkeypatch.setattr(chat, "_generate_followups", _no_followups)
    # 记忆/自动记忆会去碰 embedding，测落库不需要它们。
    monkeypatch.setattr(
        chat, "load_config", lambda: {"memory_enabled": False, "automemory_enabled": False}
    )


async def _drive_turn(conv_id: int, text: str) -> None:
    async for _frame in chat._generate(chat.ChatRequest(conversation_id=conv_id, content=text)):
        pass


async def _assistant_row(conv_id: int) -> Message | None:
    async with SessionLocal() as db:
        return (
            await db.execute(
                select(Message)
                .where(Message.conversation_id == conv_id, Message.role == "assistant")
                .order_by(Message.id.desc())
            )
        ).scalars().first()


def test_a_turn_with_no_text_but_a_saved_artifact_still_persists(monkeypatch):
    """P1 的病根：判据挂在「正文非空」上，于是只存产出、一个字没说的那一轮整个消失。

    模型把正文全塞进工具参数时，回复正文那头可以是空的（正文在 vault 文件里，
    不在对话里）。这一轮唯一有信息量的东西是**回执**——它不落库，刷新后就什么都没了，
    而库里留下的是空壳。所以判据得是「有没有东西可说」，不是「正文非空」。
    """
    asyncio.run(_prepare_db(9001))
    _stub_turn(
        monkeypatch,
        [
            ("", [ToolCall("1", "save_artifact", {"kind": "deliver", "title": "周报", "content": "正文"})]),
            ("", []),
        ],
    )
    asyncio.run(_drive_turn(9001, "存一份周报"))

    row = asyncio.run(_assistant_row(9001))
    assert row is not None, "没有正文但落了产出的一轮不该消失"
    assert row.content == ""  # 正文如实为空——不编一句假话来充数
    arts = json.loads(row.artifacts_json)
    assert [a["title"] for a in arts] == ["周报"]
    assert arts[0]["href"].startswith("/notes?path=")  # 刷新后点得开


def test_a_turn_with_neither_text_nor_artifact_still_persists_nothing(monkeypatch):
    """反向也钉住：既没说话也没产出的一轮，不该凭空多出一行。"""
    asyncio.run(_prepare_db(9002))
    _stub_turn(monkeypatch, [("", []), ("", [])])
    asyncio.run(_drive_turn(9002, "随便说说"))

    assert asyncio.run(_assistant_row(9002)) is None


def test_compare_mode_persists_artifacts_per_model(monkeypatch):
    """对比模式两路各存各的——`saved_by_uid` 分装就是为了这个，别串味。

    两路都没有正文、各存一份不同标题的产出：落库的两行必须各带各的回执。
    """
    asyncio.run(_prepare_db(9003))
    _stub_turn(
        monkeypatch,
        {
            "m": [
                ("", [ToolCall("1", "save_artifact", {"kind": "recap", "title": "甲", "content": "正文"})]),
                ("", []),
            ],
            "m2": [
                ("", [ToolCall("1", "save_artifact", {"kind": "recap", "title": "乙", "content": "正文"})]),
                ("", []),
            ],
        },
    )

    async def go():
        req = chat.ChatRequest(conversation_id=9003, content="存一份复盘", compare_model="stub/m2")
        async for _frame in chat._generate(req):
            pass

    asyncio.run(go())

    async def rows():
        async with SessionLocal() as db:
            return (
                await db.execute(
                    select(Message).where(
                        Message.conversation_id == 9003, Message.role == "assistant"
                    )
                )
            ).scalars().all()

    saved = asyncio.run(rows())
    assert len(saved) == 2
    titles = {json.loads(r.artifacts_json)[0]["title"] for r in saved}
    assert titles == {"甲", "乙"}


# --- 回放：落库的空正文那一轮，怎么变回喂给模型的一轮 -----------------------


def test_replay_gives_an_empty_artifact_turn_a_line_to_say():
    """空 content 有些 provider 不收；而且模型得知道自己已经存过了，不然会再存一遍
    （P1 的重复写就是这么来的）。"""
    m = Message(
        conversation_id=1,
        role="assistant",
        content="",
        artifacts_json=json.dumps([{"title": "周报"}], ensure_ascii=False),
    )
    assert chat._replay_message(m) == {"role": "assistant", "content": "（本轮已存入产出：周报）"}


def test_replay_leaves_a_normal_turn_alone():
    m = Message(conversation_id=1, role="assistant", content="已存入产出。", artifacts_json=None)
    assert chat._replay_message(m)["content"] == "已存入产出。"


def test_replay_keeps_an_empty_turn_empty_when_nothing_was_saved():
    """空正文又没有产出——回放还是空的，不编话。"""
    m = Message(conversation_id=1, role="assistant", content="", artifacts_json=None)
    assert chat._replay_message(m)["content"] == ""


def test_replay_survives_broken_artifacts_json():
    """坏 JSON / 老行不该让整轮对话打不开——当没有就行。"""
    m = Message(conversation_id=1, role="assistant", content="", artifacts_json="{not json")
    assert chat._replay_message(m)["content"] == ""


# --- 导出：回执也要跟着走 -----------------------------------------------


def test_the_markdown_export_carries_the_receipt(monkeypatch):
    """导出的 md 是**脱离应用**看的：这一轮正文那头可能是空的（正文在 vault 文件里），
    回执不带上的话导出来就是一片空白。给的是 vault 相对路径——`/notes?path=` 那种
    应用内路由在导出件里点不开，写进去是句废话。"""
    asyncio.run(_prepare_db(9005))
    _stub_turn(
        monkeypatch,
        [
            ("", [ToolCall("1", "save_artifact", {"kind": "deliver", "title": "周报", "content": "正文"})]),
            ("", []),
        ],
    )
    asyncio.run(_drive_turn(9005, "存一份周报"))

    async def go() -> str:
        from app.routers.conversations import export_conversation

        async with SessionLocal() as db:
            resp = await export_conversation(9005, db=db)
        return resp.body.decode("utf-8")

    md = asyncio.run(go())
    assert "**产出**" in md
    assert "周报" in md
    assert "deliver/" in md  # vault 相对路径：导出的文件里这条能照着去找
    assert "/notes?path=" not in md  # 应用内路由不该漏进导出件


def test_the_markdown_export_is_unchanged_without_artifacts(monkeypatch):
    """没产出的普通回合，导出件里不该多出一行。"""
    asyncio.run(_prepare_db(9006))
    _stub_turn(monkeypatch, [("普通回答。", [])])
    asyncio.run(_drive_turn(9006, "随便问问"))

    async def go() -> str:
        from app.routers.conversations import export_conversation

        async with SessionLocal() as db:
            resp = await export_conversation(9006, db=db)
        return resp.body.decode("utf-8")

    md = asyncio.run(go())
    assert "普通回答。" in md
    assert "**产出**" not in md


# --- 人工出口：把一条已有回答存成产出 ---------------------------------------


async def _seed_message(conv_id: int, role: str, content: str) -> int:
    async with SessionLocal() as db:
        m = Message(conversation_id=conv_id, role=role, content=content)
        db.add(m)
        await db.commit()
        await db.refresh(m)
        return m.id


def test_outputs_save_from_message_lands_the_receipt_on_the_message():
    """模型没自己存的那一轮，人工存完必须和工具那条路**完全一样**：
    文件真在产出区、回执写回消息（刷新后还在）。落盘逻辑走的是同一个工具。"""
    asyncio.run(_prepare_db(9007))
    mid = asyncio.run(_seed_message(9007, "assistant", "# 本周进展\n\n做完了 A。"))

    async def go():
        from app.routers.outputs import SaveFromMessageIn, save_from_message

        async with SessionLocal() as db:
            return await save_from_message(
                SaveFromMessageIn(conversation_id=9007, message_id=mid, kind="deliver"), db=db
            )

    art = asyncio.run(go())
    assert art["kind"] == "deliver"
    assert art["title"] == "本周进展"  # 标题从正文第一行推出来
    assert art["path"].startswith("deliver/")
    assert (VAULT_DIR / art["path"]).exists(), "回执指的文件必须真的在，不然点开就是 404"

    async def read_back():
        async with SessionLocal() as db:
            return (
                await db.execute(select(Message).where(Message.id == mid))
            ).scalar_one()

    row = asyncio.run(read_back())
    assert [a["title"] for a in json.loads(row.artifacts_json)] == ["本周进展"]


def test_outputs_save_from_message_refuses_what_it_should():
    """用户的话不是产出；空回答没有可存的东西；不存在的消息 404；乱给的体裁 400。"""
    asyncio.run(_prepare_db(9008))
    user_mid = asyncio.run(_seed_message(9008, "user", "帮我写份周报"))
    empty_mid = asyncio.run(_seed_message(9008, "assistant", "   "))
    ok_mid = asyncio.run(_seed_message(9008, "assistant", "正文"))

    async def go(mid: int, kind: str = "deliver"):
        from app.routers.outputs import SaveFromMessageIn, save_from_message

        async with SessionLocal() as db:
            return await save_from_message(
                SaveFromMessageIn(conversation_id=9008, message_id=mid, kind=kind), db=db
            )

    for bad in (user_mid, empty_mid):
        with pytest.raises(HTTPException) as e:
            asyncio.run(go(bad))
        assert e.value.status_code == 400
    with pytest.raises(HTTPException) as e404:
        asyncio.run(go(999999))
    assert e404.value.status_code == 404
    with pytest.raises(HTTPException) as ekind:
        asyncio.run(go(ok_mid, kind="nope"))
    assert ekind.value.status_code == 400


def test_outputs_kinds_come_from_the_one_table():
    """体裁表只有一份真值（`mcp._ARTIFACT_KINDS`，它同时决定落点目录）。
    前端拿到的必须是那一份——多一份表就多一个漂移点。"""
    from app.routers.outputs import list_kinds

    got = asyncio.run(list_kinds())["kinds"]
    assert {k["kind"] for k in got} == set(mcp._ARTIFACT_KINDS)
    assert [k for k in got if k["kind"] == "compose"][0]["dir"] == "notes"
    assert all(k["label"] and k["dir"] for k in got)


# --- 规矩得在 system 层，不是在工具描述里 -----------------------------------


def _capture_rounds(monkeypatch) -> list[list[dict]]:
    """把每一轮真正喂给模型的消息录下来。"""
    seen: list[list[dict]] = []
    done = {"v": False}

    async def fake_round(client, model, messages, tools, emit_text, usage_out=None):
        seen.append([dict(m) for m in messages])
        if done["v"]:
            return "", []
        done["v"] = True
        return "好的。", []

    monkeypatch.setattr(llm, "_openai_round", fake_round)
    monkeypatch.setattr(llm, "_openai_client", lambda p: _NoClose())
    monkeypatch.setattr(chat, "_generate_followups", _no_followups)
    monkeypatch.setattr(
        chat, "load_config", lambda: {"memory_enabled": False, "automemory_enabled": False}
    )
    return seen


def test_the_output_rule_rides_in_the_system_layer(monkeypatch):
    """「成篇的成品要存进产出区」必须在 system 层。

    实测：这句话只写在 `save_artifact` 的工具描述里时，自然说法下 **0/10** 会遵守；
    提到 system 层后 **6/10**。工具描述对模型是建议，system 才是「怎么回答」的基准。
    谁把它挪回工具描述，这条测试就该响。
    """
    asyncio.run(_prepare_db(9009))
    seen = _capture_rounds(monkeypatch)
    asyncio.run(_drive_turn(9009, "帮我写份本周周报"))

    systems = [m["content"] for m in seen[0] if m["role"] == "system"]
    assert any("save_artifact" in s for s in systems), "规矩得在 system 层"
    assert seen[0][0]["role"] == "system", "规矩排在一切之前，别被人设/记忆挤到后面"


def test_the_output_rule_is_not_sent_when_tools_are_off(monkeypatch):
    """工具关掉的 agent 上不能说这条——那是指使模型去调一个它没有的工具。"""
    asyncio.run(_prepare_db(9010))

    async def seed_agent():
        from app.models import Agent

        async with SessionLocal() as db:
            db.add(Agent(id=77, name="no-tools", tools_enabled=False))
            await db.commit()

    asyncio.run(seed_agent())
    seen = _capture_rounds(monkeypatch)

    async def go():
        req = chat.ChatRequest(conversation_id=9010, content="帮我写份周报", agent_id=77)
        async for _frame in chat._generate(req):
            pass

    asyncio.run(go())
    systems = [m["content"] for m in seen[0] if m["role"] == "system"]
    assert not any("save_artifact" in s for s in systems)


# --- 一轮存多份：同轮同体裁只留最后一份，跨轮不覆盖 -------------------------
#
# 量测背景（20 轮真实模型，`sensenova-6.8-flash-lite`）：给一个「300 字左右」的
# 字数要求，模型会**写一版、存一版、回头数一遍、发现超了、再写再存**——
# 5/20 轮存了 ≥2 次，最坏一轮 4 次。去掉字数要求后 10/10 轮只存一次。
# 两种伤害：同日同标题互相覆盖（前几版静默消失，却留下 3 条指向同一文件的回执）；
# 换标题堆出 5 个半成品文件（产出清单和零柒成长值都按份数算）。


@pytest.fixture
def vault_root():
    """一个空的产出根。

    不用 pytest 的 `tmp_path`：这台机器的 `%TEMP%\\pytest-of-TX` 是个拒绝访问的
    残留目录（WinError 5），临时目录建不进去；`tempfile.mkdtemp` 在同一层是好的
    （conftest 就是这么做 sandbox 的）。
    """
    d = Path(tempfile.mkdtemp(prefix="wb-artifact-vault-", dir=Path(__file__).parent))
    try:
        yield d
    finally:
        shutil.rmtree(d, ignore_errors=True)


def _vault(monkeypatch, root):
    """把产出根指到空目录：产出目录是全 session 共用的 sandbox，数文件会飘。"""
    monkeypatch.setattr(mcp, "VAULT_DIR", root)
    return root


def test_same_kind_twice_in_one_turn_lands_in_one_file(monkeypatch, vault_root):
    """同一轮里同体裁的第二次落盘 = 模型在改自己刚写的那份 → 覆盖同一个文件。

    标题变了也一样（实测模型会存成「本周周报」→「本周周报（精简版）」→
    「本周周报（100 字版）」，5 份都在说同一件事）。
    """
    _vault(monkeypatch, vault_root)

    async def go():
        mcp.begin_turn()
        await mcp._save_artifact(
            {"kind": "recap", "title": "本周周报", "content": "第一版 485 字"}
        )
        first = mcp.take_tool_meta()["artifact"]
        await mcp._save_artifact(
            {"kind": "recap", "title": "本周周报（精简版）", "content": "第二版 300 字"}
        )
        second = mcp.take_tool_meta()["artifact"]
        return first, second

    first, second = asyncio.run(go())
    files = list((vault_root / "recap").glob("*.md"))
    assert len(files) == 1, "一轮里同体裁的第二次不该新开文件"
    assert first["path"] == second["path"]
    assert second["action"] == "更新"
    assert "第二版" in files[0].read_text(encoding="utf-8")


def test_different_kinds_in_one_turn_each_keep_a_file(monkeypatch, vault_root):
    """同轮**不同体裁**是两份东西（复盘 vs 交付稿），不能互相盖掉。"""
    _vault(monkeypatch, vault_root)

    async def go():
        mcp.begin_turn()
        await mcp._save_artifact({"kind": "recap", "title": "复盘", "content": "甲"})
        mcp.take_tool_meta()
        await mcp._save_artifact({"kind": "deliver", "title": "交付", "content": "乙"})
        mcp.take_tool_meta()

    asyncio.run(go())
    assert len(list((vault_root / "recap").glob("*.md"))) == 1
    assert len(list((vault_root / "deliver").glob("*.md"))) == 1


# ---------- W4：长度约束的确定性执行（单次受限修订 + 服务端报字数） ----------


def test_a_third_save_in_one_turn_is_refused_and_writes_nothing(monkeypatch, vault_root):
    """一回合 1 次初稿 + 1 次修订，**第三次直接拒绝**。

    实测最坏一轮存了 4 次：模型估不准字数，写一版、存一版、再估、再写。每一次重写都要用户
    多付一次生成的钱，所以在服务端给它一个硬上限 —— 而不是继续指望它自己数对。
    """
    _vault(monkeypatch, vault_root)

    async def go():
        mcp.begin_turn()
        out = []
        for i in range(3):
            out.append(
                await mcp._save_artifact(
                    {"kind": "recap", "title": f"第 {i + 1} 版", "content": "正文" * (10 + i)}
                )
            )
            mcp.take_tool_meta()
        return out

    first, second, third = asyncio.run(go())
    assert first.startswith("已存为") and second.startswith("已更新")
    assert third.startswith("[错误]") and "修订额度" in third
    files = list((vault_root / "recap").glob("*.md"))
    assert len(files) == 1, "被拒绝的那一次不许写盘"
    assert "第 2 版" in files[0].read_text(encoding="utf-8"), "留在盘上的是最后一次真的存下来的"


def test_the_revision_slot_is_per_kind(monkeypatch, vault_root):
    """额度按体裁算：复盘写两版用完了，交付稿还是有它自己的一次。"""
    _vault(monkeypatch, vault_root)

    async def go():
        mcp.begin_turn()
        for _ in range(2):
            await mcp._save_artifact({"kind": "recap", "title": "复盘", "content": "甲"})
            mcp.take_tool_meta()
        out = await mcp._save_artifact({"kind": "deliver", "title": "交付", "content": "乙"})
        mcp.take_tool_meta()
        return out

    assert asyncio.run(go()).startswith("已存为")


def test_a_new_turn_gets_its_slots_back(monkeypatch, vault_root):
    _vault(monkeypatch, vault_root)

    async def go():
        mcp.begin_turn()
        for _ in range(2):
            await mcp._save_artifact({"kind": "recap", "title": "复盘", "content": "甲"})
            mcp.take_tool_meta()
        mcp.begin_turn()  # 下一轮
        out = await mcp._save_artifact({"kind": "recap", "title": "复盘", "content": "乙"})
        mcp.take_tool_meta()
        return out

    assert asyncio.run(go()).startswith("已另存为")


def test_the_server_counts_the_chars_and_says_whether_it_is_over(monkeypatch, vault_root):
    """「超没超」由**服务端**数、服务端判，并写进回执与工具返回 —— 不再是模型的自我叙述。"""
    from app.core import length_budget as lb

    _vault(monkeypatch, vault_root)

    async def go():
        budget = lb.parse_budget("整理成一份三百字左右的周报。")
        mcp.begin_turn(budget)
        out = await mcp._save_artifact(
            {"kind": "deliver", "title": "周报", "content": "正" * 400}
        )
        art = mcp.take_tool_meta()["artifact"]
        return out, art

    text, art = asyncio.run(go())
    assert art["budget"] == 300 and art["budget_source"] == "ask" and art["hard"] is False
    assert art["chars"] == 400 and art["over"] is True and art["over_by"] == 100
    assert "服务端数过" in text and "超了 100 字" in text
    assert "还剩 1 次修订额度" in text


def test_within_budget_it_says_not_to_rewrite(monkeypatch, vault_root):
    """没超就明说「不要再为字数重写一版」——这是 W4 想消掉的那个动作。"""
    from app.core import length_budget as lb

    _vault(monkeypatch, vault_root)

    async def go():
        mcp.begin_turn(lb.parse_budget("不超过 500 字。"))
        out = await mcp._save_artifact({"kind": "deliver", "title": "短稿", "content": "正" * 480})
        art = mcp.take_tool_meta()["artifact"]
        return out, art

    text, art = asyncio.run(go())
    assert art["over"] is False and art["hard"] is True and art["chars"] == 480
    assert "没超" in text and "不要再为字数重写一版" in text


def test_no_budget_means_the_tail_says_nothing(monkeypatch, vault_root):
    """用户那一句里没有字数 → 回执里一个字都不多说（不编一个「不限」出来）。"""
    _vault(monkeypatch, vault_root)

    async def go():
        mcp.begin_turn()
        out = await mcp._save_artifact({"kind": "note" if False else "compose", "title": "随记", "content": "正文"})
        art = mcp.take_tool_meta()["artifact"]
        return out, art

    text, art = asyncio.run(go())
    assert art["budget"] is None and art["chars"] == 2
    assert "服务端数过" not in text and "预算" not in text


def test_the_tool_argument_is_only_a_fallback(monkeypatch, vault_root):
    """服务端从用户那句话里认出来的预算**优先**；认不出才用工具参数里的数。

    顺序不能反：预算是**用户说的**，模型自己填一个 300 然后按 300 交差，正是 W4 要治的病。
    """
    from app.core import length_budget as lb

    _vault(monkeypatch, vault_root)

    async def go():
        # ① 服务端认出来了（用户说的是 300）→ 工具参数里的 8000 不作数
        mcp.begin_turn(lb.parse_budget("三百字左右。"))
        await mcp._save_artifact(
            {"kind": "deliver", "title": "甲", "content": "正" * 400, "length_budget": 8000}
        )
        a = mcp.take_tool_meta()["artifact"]
        # ② 服务端认不出 → 用工具参数里的数，并如实标出来源
        mcp.begin_turn(None)
        await mcp._save_artifact(
            {"kind": "deliver", "title": "乙", "content": "正" * 400, "length_budget": 200}
        )
        b = mcp.take_tool_meta()["artifact"]
        return a, b

    a, b = asyncio.run(go())
    assert (a["budget"], a["budget_source"]) == (300, "ask")
    assert (b["budget"], b["budget_source"]) == (200, "tool")
    assert b["over"] is True


def test_same_title_in_a_new_turn_does_not_overwrite(monkeypatch, vault_root):
    """跨轮的同名不覆盖：之前那一版可能是上一轮、甚至上一个话题的东西。

    静默盖掉它就是丢用户的数据。改成另存一个不冲突的名字，并如实说「另存」。
    """
    _vault(monkeypatch, vault_root)

    async def go():
        mcp.begin_turn()
        await mcp._save_artifact(
            {"kind": "deliver", "title": "本周周报", "content": "上一轮那份"}
        )
        a = mcp.take_tool_meta()["artifact"]
        mcp.begin_turn()  # 新的一轮
        await mcp._save_artifact(
            {"kind": "deliver", "title": "本周周报", "content": "这一轮那份"}
        )
        b = mcp.take_tool_meta()["artifact"]
        return a, b

    a, b = asyncio.run(go())
    assert a["path"] != b["path"]
    assert b["action"] == "另存"
    texts = [f.read_text(encoding="utf-8") for f in (vault_root / "deliver").glob("*.md")]
    assert len(texts) == 2
    assert any("上一轮那份" in t for t in texts), "上一轮那份不能被静默盖掉"
    assert any("这一轮那份" in t for t in texts)


def test_an_identical_resave_does_not_pile_up_another_file(monkeypatch, vault_root):
    """逐字一样的第二次落盘不写、也不另存。

    实测里出现过同一轮存两次、正文完全相同的两个 128 字版本（相似度 1.00）。
    """
    _vault(monkeypatch, vault_root)

    async def go():
        mcp.begin_turn()
        await mcp._save_artifact({"kind": "recap", "title": "周报", "content": "一模一样"})
        mcp.take_tool_meta()
        mcp.begin_turn()
        out = await mcp._save_artifact({"kind": "recap", "title": "周报", "content": "一模一样"})
        return out

    out = asyncio.run(go())
    assert len(list((vault_root / "recap").glob("*.md"))) == 1
    assert "一模一样" in out


def test_two_saves_of_one_kind_leave_exactly_one_receipt(monkeypatch):
    """同轮同体裁存两次 → 文件一个、回执也只能一条。

    两条指向同一个文件的回执是谎话：用户点开看到的是同一份东西。
    """
    asyncio.run(_prepare_db(9014))
    _stub_turn(
        monkeypatch,
        [
            (
                "",
                [
                    ToolCall("1", "save_artifact", {"kind": "deliver", "title": "周报", "content": "第一版"}),
                    ToolCall("2", "save_artifact", {"kind": "deliver", "title": "周报", "content": "第二版"}),
                ],
            ),
            ("", []),
        ],
    )
    asyncio.run(_drive_turn(9014, "写一份周报"))

    row = asyncio.run(_assistant_row(9014))
    arts = json.loads(row.artifacts_json)
    assert len(arts) == 1, "同一份东西只该有一条回执"


# --- 落库前过滤纯占位串 ------------------------------------------------------


def test_a_lone_placeholder_is_not_kept_as_the_reply():
    """模型把整篇正文塞进工具参数时，回复正文可能只剩一个字面量占位串。

    实测见过 `(empty)`——它是模型吐出来的真东西（不是代码里编的），但落进历史只是
    噪音，下一轮还会被当成「它真这么说过」再喂回去。
    """
    for text in ["(empty)", "  (EMPTY) ", "（空）", "[empty]", "(无内容)"]:
        assert chat._without_placeholder(text) == ""


def test_a_sentence_that_merely_mentions_a_placeholder_is_kept():
    """只在**整条内容就是**占位串时才丢。多说了半个字就原样保留。

    这条是刻意收窄的：宁可漏掉一个没认出来的占位，也不能因为匹配太宽而吃掉一句真话。
    """
    for text in ["已存入产出。(empty)", "(empty) 但我还是说了一句", "empty 不是占位串"]:
        assert chat._without_placeholder(text) == text.strip()
    assert chat._without_placeholder("正常回答") == "正常回答"


# --- 落了产出的那一轮，正文不再被回填第二份 ---------------------------------


def test_a_turn_that_saved_an_artifact_does_not_keep_the_streamed_body(monkeypatch):
    """正文先流出来、再作为参数存进 vault 时，不能再被回填进历史。

    `llm.py` 明确把「工具轮之前的 pre-text」丢掉了；`chat.py` 那句
    `"".join(streamed_parts)` 是给「吐了半句就报错」兜底的。一旦这一轮落了产出，
    它回填的就是**同一篇正文的第二份拷贝**（文件里一份、历史里一份）——P1 要消的
    正是这个。实测有落库正文 518 字、同时 vault 里也有一份的轮次。
    """
    asyncio.run(_prepare_db(9011))
    _stub_turn(
        monkeypatch,
        [
            (
                "这里是满满一屏正文，本不该进历史……",
                [ToolCall("1", "save_artifact", {"kind": "deliver", "title": "回填", "content": "正文"})],
            ),
            ("", []),
        ],
    )
    asyncio.run(_drive_turn(9011, "帮我写一份周报"))

    row = asyncio.run(_assistant_row(9011))
    assert row is not None, "落了产出的那一轮不能整个消失"
    assert row.content == "", "正文已经在 vault 里了，不该再进历史"
    assert json.loads(row.artifacts_json), "回执才是这一轮的正身"


def test_streamed_text_is_still_rescued_when_nothing_was_saved(monkeypatch):
    """上面那条不能把兜底一起删掉。

    只调了普通工具、最后正文一个字没留下的那一轮，之前流出去的文字还得保住——
    否则「吐了半句就出错」会变成一条空消息。
    """
    asyncio.run(_prepare_db(9012))
    _stub_turn(
        monkeypatch,
        [
            ("半句话就断了……", [ToolCall("1", "vault_list_files", {})]),
            ("", []),
        ],
    )
    asyncio.run(_drive_turn(9012, "看看 vault"))

    row = asyncio.run(_assistant_row(9012))
    assert row is not None and "半句话" in row.content


# --- 谎报落盘：说了存，其实一次都没调 ----------------------------------------
#
# 实测（2 轮 × 12 组）：22 轮里有 2 轮回复写着「已存入产出（约 100 字）」，但那一轮
# `save_artifact` 一次都没调。**不是回放提示教的**——量过，`_replay_message` 那条还原行
# 一次都没出现在模型眼前；它是在模仿自己上一轮的开场白。
#
# 例句和前端 `frontend/src/artifacts.test.ts` 是**同一批**，改一边另一边就红。

_LYING = [
    "已存入产出（约 100 字）。",
    "已存入产出：**本周周报**。本周：导出需求收敛…",
    "已存为复盘「本周周报」→ recap/x.md",
    "已更新交付「本周周报」→ deliver/x.md",
    "已另存为交付「本周周报」→ deliver/x-2.md",
]

_HONEST = [
    "这是本周周报的正文：\n\n# 本周周报\n\n…",
    "我没法写，工作区里没有素材。",
    "",
]


def test_a_claim_without_a_save_is_flagged():
    for text in _LYING:
        assert chat.claims_a_save_without_one(text, []), text
        assert chat.claims_a_save_without_one(text, None), text


def test_a_claim_with_a_receipt_is_not_flagged():
    """有回执就说明真存了——那句话是模型多说的，东西确实在产出区，不该误报。"""
    for text in _LYING:
        assert not chat.claims_a_save_without_one(text, [{"path": "recap/x.md"}]), text


def test_a_normal_answer_is_not_flagged():
    for text in _HONEST:
        assert not chat.claims_a_save_without_one(text, []), text


def test_every_artifact_kind_has_a_update_claim_marker():
    """工具成功时回「已更新{体裁}「X」→ 路径」，模型会照抄——每个体裁都得认出来。"""
    from app.core import mcp

    for _, label in mcp._ARTIFACT_KINDS.values():
        assert chat.claims_a_save_without_one(f"已更新{label}「周报」→ x.md", []), label

