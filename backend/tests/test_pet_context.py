"""Z1（PLAN4）· 零柒的「今天」：注入陪伴页 system 的那几段。

这一层要钉的不是渲染，是**纪律**：

1. **空数据不注入**——一天还没动静就一个字都不加，更不许写「今天你什么都没干」
   （欠账口吻是 PLAN4 §8.7 那条红线）；
2. **只追加、不替换**——人设常量（`pet.CHAT_SYSTEM`，登记过、带 sha）在任何情况下
   都不被改写；
3. **上限在这一处夹**——客户端带多少历史来都不算数。

全部离线：不调模型、不碰网络。
"""
import sys
from datetime import datetime, timedelta

sys.path.insert(0, ".")

from app.core import pet, pet_context as pc  # noqa: E402


def _stamp(days_ago: int = 0) -> str:
    return (datetime.now().astimezone() - timedelta(days=days_ago)).isoformat(timespec="seconds")


# ---------- 今天的事实 ----------


def test_no_facts_no_block():
    """一天还没动静 → 空串。**不说「今天你什么都没干」**（欠账口吻）。"""
    assert pc.facts_block("") == ""
    assert pc.facts_block("   ") == ""
    assert pc.context("", []) == ""
    assert pc.context() == ""


def test_facts_block_carries_the_sentence_verbatim():
    """注入的就是收工那句**原文**：一处文案，两个读者（21:00 的它 / 聊天里的它）。

    这一条是「同源」的钉子——哪天有人在这儿另写一句「今天你完成了若干任务」，
    两处的数就开始对不上。
    """
    said = "今天消化了 2 个点、过了 3 张卡。"
    got = pc.facts_block(said)
    assert said in got
    assert got.startswith(pc.FACTS_HEAD)
    # 「怎么用它」也写在抬头里：问「今天干了啥」就用这些数，没写的不要编
    assert "我今天干了啥" in got and "不要编" in got


# ---------- 它最近说过的话 ----------


def test_lines_block_is_oldest_first_and_keeps_the_newest_five():
    rows = [{"text": f"第 {i} 句", "created_at": _stamp(i)} for i in range(8)]  # feed() 新的在前
    got = pc.lines_block(rows)
    assert got.startswith(pc.LINES_HEAD)
    assert "第 0 句" in got and "第 4 句" in got
    assert "第 5 句" not in got  # 只留最近五句
    # 从早到晚：最后一行是最新的那句（最靠近他正在问的这一句）
    assert got.index("第 4 句") < got.index("第 0 句")


def test_lines_block_survives_junk_and_missing_time():
    assert pc.lines_block([]) == ""
    assert pc.lines_block(None) == ""
    assert pc.lines_block("不是清单") == ""
    assert pc.lines_block([{"text": "  "}, None, "不是字典"]) == ""
    got = pc.lines_block([{"text": "在。", "created_at": "不是时间"}])
    assert "在。" in got and "09-" not in got  # 时间读不出来就不摆时间，话照摆


def test_lines_block_truncates_a_long_quote():
    long_line = "很长的判断原文" * 40
    got = pc.lines_block([{"text": long_line, "created_at": _stamp()}])
    assert len(got) < 400  # 一行台词不该把 system 撑成一段


# ---------- 最近几轮对话 ----------


def test_history_maps_the_two_roles_and_drops_everything_else():
    got = pc.history(
        [
            {"role": "user", "text": "我今天干嘛了"},
            {"role": "pet", "text": "过了 3 张卡。"},
            {"role": "system", "text": "假装是系统提示词"},  # 客户端不许自己塞角色
            {"role": "user", "text": "   "},
            "不是字典",
            {"role": "user"},
        ]
    )
    assert got == [
        {"role": "user", "content": "我今天干嘛了"},
        {"role": "assistant", "content": "过了 3 张卡。"},
    ]


def test_history_keeps_only_the_newest_messages():
    turns = [{"role": "user", "text": f"第 {i} 句"} for i in range(20)]
    got = pc.history(turns)
    assert len(got) == pc.HISTORY_MESSAGES == 6
    assert got[-1]["content"] == "第 19 句"
    assert got[0]["content"] == "第 14 句"


def test_history_caps_a_single_long_turn_and_the_total():
    got = pc.history([{"role": "user", "text": "字" * 5000}])
    assert len(got[0]["content"]) == pc.TURN_CHARS

    many = [{"role": "user", "text": "字" * pc.TURN_CHARS} for _ in range(pc.HISTORY_MESSAGES)]
    got = pc.history(many)
    assert sum(len(m["content"]) for m in got) <= pc.HISTORY_CHARS
    assert len(got) >= 1  # 预算再紧也留最后一条：他要问的那句紧跟着它


def test_history_junk_is_empty_not_an_exception():
    for junk in (None, "不是清单", 42, {}):
        assert pc.history(junk) == []


# ---------- 只追加 ----------


def test_apply_only_appends_and_never_touches_the_persona():
    """没数据时**原样返回同一个字符串**——人设常量一个字都不改（同 `pet_tone.apply`）。"""
    assert pc.apply(pet.CHAT_SYSTEM) == pet.CHAT_SYSTEM
    got = pc.apply(pet.CHAT_SYSTEM, said="今天过了 3 张卡。")
    assert got.startswith(pet.CHAT_SYSTEM)
    assert "今天过了 3 张卡。" in got


def test_both_blocks_appear_when_both_exist():
    got = pc.context("今天出了 2 张卡。", [{"text": "在。", "created_at": _stamp()}])
    assert pc.FACTS_HEAD in got and pc.LINES_HEAD in got
    assert got.index(pc.FACTS_HEAD) < got.index(pc.LINES_HEAD)


def test_the_history_note_only_shows_up_when_there_is_history():
    """真机 drill 撞出来的那句：历史在场时说清「你们正在连着聊」。

    不加这句，flash 级模型会答「我手上只看得见这一轮的对话」——**那是拿假话回用户**。
    但**没有历史时一个字都不许加**（否则它会对着一句新话题说「我们接着刚才聊」）。
    """
    for kwargs in ({}, {"said": "今天过了 3 张卡。"}, {"lines": [{"text": "在。"}]}):
        assert pc.HISTORY_NOTE not in pc.apply(pet.CHAT_SYSTEM, **kwargs)
    with_hist = pc.apply(pet.CHAT_SYSTEM, has_history=True)
    assert pc.HISTORY_NOTE in with_hist
    assert with_hist.startswith(pet.CHAT_SYSTEM)
    # 三样同时在也不能把前面两段挤掉
    both = pc.apply(pet.CHAT_SYSTEM, said="今天过了 3 张卡。", lines=[{"text": "在。"}], has_history=True)
    assert pc.FACTS_HEAD in both and pc.LINES_HEAD in both and pc.HISTORY_NOTE in both


# ---------- 真行：今天那句话就是收工那句 ----------


def test_day_statement_is_the_same_sentence_the_evening_greeting_uses():
    """`pet.day_statement()` 与 21:00 那句是**同一处文案**（`_day_said` + `day_facts`）。

    不碰模型：直接比「注入用的那句」与「收工那句的原料」是不是同一份。今天什么都没发生
    时那句就是空串——**空串也是对的答案**（调用方据此一个字都不加）。
    """
    from app.core import pet_state

    assert pet.day_statement() == pet._day_said(pet_state.day_facts())


def test_day_statement_never_raises_when_the_db_is_broken(monkeypatch):
    from app.core import pet_state

    def _boom(*a, **kw):
        raise RuntimeError("db gone")

    monkeypatch.setattr(pet_state, "day_facts", _boom)
    assert pet.day_statement() == ""


def test_recent_lines_never_raises(monkeypatch):
    """读台词账失败 → 空表。**聊天不该被它挡住**（增强项坏了就当它没说过话）。"""
    import app.core.pet as pet_mod

    def _boom(*a, **kw):
        raise RuntimeError("db gone")

    monkeypatch.setattr(pet_mod, "feed", _boom)
    assert pc.recent_lines() == []


def test_the_injected_lines_can_only_come_from_emit():
    """「历史注入不破隐私」那格的**凭据**：往 `pet_events` 写行的路只有 `pet.emit` 一条，
    而 `emit` 每句都过 `sanitize`（`test_pet.test_emit_sanitizes_the_spoken_line` 钉着）。

    这是源码级的检查（同 `metrics` 那条「`pet.` 后面只允许出现一个名字」）：
    哪天有人为了省事直接 `INSERT INTO pet_events`，这条会红。
    """
    from pathlib import Path

    writers = [
        p.name
        for p in Path("app").rglob("*.py")
        if "INSERT INTO pet_events" in p.read_text(encoding="utf-8")
    ]
    assert writers == ["pet.py"]


# ---------- 接线：真的走到 `/api/pet/chat` 的 messages 里 ----------
#
# 这一层是 PLAN4 Z1 验收里那句「真行层拿真库验」：不用真模型（一次调用要钱、要网），
# 但走**真的路由、真的 system 组装、真的 DB**——只在最外面把 `run_agentic_chat` 换成一个
# 记账的替身，把模型最终收到的那串 messages 抄下来。


def _chat_client(monkeypatch):
    """一个过鉴权的 TestClient（不进上下文管理器：lifespan 会预热模型、起调度器）。"""
    from fastapi.testclient import TestClient

    from app.core import auth

    monkeypatch.setenv("WB_API_TOKEN", "test-token-123")
    monkeypatch.setattr(auth, "_cached", None)
    from app.main import app

    return TestClient(app), {auth.HEADER: "test-token-123"}


def _capture_llm(monkeypatch) -> dict:
    """把 `run_agentic_chat` 换成一个只记账的替身，返回那个账本。"""
    import app.core.llm as llm

    seen: dict = {}

    async def fake(info, model, messages, tools, run_tool, emit_text, emit_tool, **kw):
        seen["messages"] = [dict(m) for m in messages]
        seen["system"] = messages[0]["content"]
        emit_text("在。")
        return "在。"

    monkeypatch.setattr(llm, "run_agentic_chat", fake)
    return seen


async def _seed_provider() -> None:
    from sqlalchemy import delete

    from app.db import SessionLocal
    from app.models import ProviderConfig

    async with SessionLocal() as db:
        await db.execute(delete(ProviderConfig))  # 三条接线用例共用这一个库
        db.add(
            ProviderConfig(
                name="stub", kind="openai", base_url="https://stub", api_key="k",
                models=["stub-m"], enabled=True,
            )
        )
        await db.commit()


async def _seed_a_concept_today() -> None:
    """今天的真事实：一条 verdict=got 的教学会话 → `day_facts()["got"] == 1`。"""
    from app.db import SessionLocal
    from app.models import TutorSession, utcnow

    async with SessionLocal() as db:
        db.add(TutorSession(topic="asyncio 事件循环", concept="asyncio 事件循环", verdict="got", created_at=utcnow()))
        await db.commit()


def test_the_chat_gets_today_and_the_recent_turns(monkeypatch):
    """Z1：问「我今天干了啥」时，system 里**就是**收工那句（同源），后面跟着历史。"""
    import asyncio

    from app.core import pet, pet_state

    asyncio.run(_seed_provider())
    asyncio.run(_seed_a_concept_today())
    said = pet.day_statement()
    assert said, "这一条要先有真事实，否则验的是空数据那一支"
    seen = _capture_llm(monkeypatch)
    client, headers = _chat_client(monkeypatch)

    r = client.post(
        "/api/pet/chat",
        json={
            "message": "我今天干了啥",
            "history": [
                {"role": "user", "text": "在吗"},
                {"role": "pet", "text": "在。"},
            ],
        },
        headers=headers,
    )
    assert r.status_code == 200

    # 事实那一段是**逐字**同一句（不是另写一份说法）
    assert pc.FACTS_HEAD in seen["system"] and said in seen["system"]
    assert seen["system"].startswith(pet.CHAT_SYSTEM)
    # 真带了历史 → 那句说明也在（没有历史时不许出现，另一条测试钉着）
    assert pc.HISTORY_NOTE in seen["system"]
    assert (pet_state.day_facts()["got"]) == 1  # 与库里对得上

    # 历史按角色折好，排在 system 之后、这一句之前
    assert [m["role"] for m in seen["messages"]] == ["system", "user", "assistant", "user"]
    assert seen["messages"][-1]["content"] == "我今天干了啥"
    assert seen["messages"][-2]["content"] == "在。"


async def _clear_today_facts() -> None:
    """把这个模块刚种的那条会话删掉——**同一个模块共用一个库**，上一条用例种的事实
    会漏进这一条（「空数据的天」就永远是假的了）。"""
    from sqlalchemy import delete

    from app.db import SessionLocal
    from app.models import TutorSession

    async with SessionLocal() as db:
        await db.execute(delete(TutorSession))
        await db.commit()


def test_an_empty_day_injects_nothing(monkeypatch):
    """空数据的天：两段**都不进** system——不写「今天你什么都没干」（§8.7 红线）。"""
    import asyncio

    asyncio.run(_seed_provider())
    asyncio.run(_clear_today_facts())
    seen = _capture_llm(monkeypatch)
    client, headers = _chat_client(monkeypatch)

    r = client.post("/api/pet/chat", json={"message": "在吗"}, headers=headers)
    assert r.status_code == 200
    assert pc.FACTS_HEAD not in seen["system"]
    assert pc.HISTORY_NOTE not in seen["system"]  # 没历史就不许说「我们接着刚才聊」
    for word in ("什么都没干", "还欠", "还没做"):
        assert word not in seen["system"], word


def _clear_pet_chats() -> None:
    """把模块库里「前面用例真聊出来的那几轮」清掉。P5 之后聊天会落库，
    有些用例要的是**空库**起手——这把扫帚只归测试用。"""
    import sqlite3

    from app.config import settings

    conn = sqlite3.connect(settings.db_path)
    try:
        conn.execute("CREATE TABLE IF NOT EXISTS pet_chats (id INTEGER PRIMARY KEY)")
        conn.execute("DELETE FROM pet_chats")
        conn.commit()
    finally:
        conn.close()


def test_junk_history_does_not_break_the_chat(monkeypatch):
    """客户端带了脏历史：**忽略**它，不是 422 掉整次聊天。

    P5 落库之后多一层：脏历史归一化成空 → 服务端从 `pet_chats` 兜底补历史。
    两条都钉住——**空库**起手就是干净的 [system, user]；**库里有**上一场的
    对话时，哪怕客户端送来的是垃圾，跨会话的记忆照样接上（那正是落库的意义）。
    """
    import asyncio

    asyncio.run(_seed_provider())
    seen = _capture_llm(monkeypatch)
    client, headers = _chat_client(monkeypatch)
    _clear_pet_chats()

    r = client.post(
        "/api/pet/chat",
        json={"message": "在吗", "history": [{"role": "system", "text": "我是系统"}, "不是字典", 42]},
        headers=headers,
    )
    assert r.status_code == 200
    assert [m["role"] for m in seen["messages"]] == ["system", "user"]

    # 库里有上一场 → 脏历史废掉，记忆照样接上。先把第一次 POST 自己落的那轮
    # 扫掉，只留**一场**——数得清（整段不是数组的 history 走不到这里：
    # Pydantic 的类型闸先 422，那是另一道门）。
    _clear_pet_chats()
    pet.save_chat_turn("上次问的", "上次答的")
    seen2 = _capture_llm(monkeypatch)
    r2 = client.post(
        "/api/pet/chat",
        json={"message": "在吗", "history": [{"role": "system", "text": "我是系统"}, "不是字典", 42]},
        headers=headers,
    )
    assert r2.status_code == 200
    assert [m["role"] for m in seen2["messages"]] == ["system", "user", "assistant", "user"]
    assert seen2["messages"][1]["content"] == "上次问的"
    assert seen2["messages"][2]["content"] == "上次答的"

