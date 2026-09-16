"""W2b（强制结构化）的测试：**回执不可能说谎，因为它不是模型写的。**

三层：
1. `structured_turn.apply`：服务端自己落盘、自己拼回执；空 body / 未知体裁 / 份数超了
   都要**说清原因**，不许静默丢。
2. 闸门：走不走这条路由 W7 的画像（`force_structure` 且量过 `supports_structure`）× W3 的路由
   （是不是交付型）决定 —— 两个条件都不是猜的。
3. 真回合（写死的结构 + 真落盘）：交付型 + 画像是结构化 → 走结构、正文不进对话、
   回执指向的文件真在盘上；拿不到结构 → **回落 W2a 的工具循环**并如实记账。
"""
import asyncio
import json
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, ".")

from app.core import mcp, structured_turn as st  # noqa: E402

import pytest  # noqa: E402


@pytest.fixture
def vault_root():
    """一个空的产出根（与 `test_artifacts.py` 同一做法：这台机器的 pytest tmp_path 建不出来）。"""
    d = Path(tempfile.mkdtemp(prefix="wb-w2b-vault-", dir=Path(__file__).parent))
    try:
        yield d
    finally:
        import shutil

        shutil.rmtree(d, ignore_errors=True)


def _vault(monkeypatch, root):
    monkeypatch.setattr(mcp, "VAULT_DIR", root)
    return root


# ---------- 1. 服务端落盘 + 回执 ----------


def test_the_server_saves_every_draft_and_builds_the_receipt(monkeypatch, vault_root):
    _vault(monkeypatch, vault_root)
    payload = st.StructuredTurn(
        reply="",
        artifacts=[
            st.ArtifactDraft(kind="deliver", title="周报", body="## 周一\n- 做了 A"),
            st.ArtifactDraft(kind="recap", title="复盘", body="## 复盘\n- 学到 B"),
        ],
    )
    out = asyncio.run(st.apply(payload))
    assert len(out["artifacts"]) == 2 and not out["dropped"]
    assert [a["kind"] for a in out["artifacts"]] == ["deliver", "recap"]
    # 回执是**服务端拼的**（模型没给 reply）
    assert out["reply"].startswith("已存入产出：")
    for a in out["artifacts"]:
        p = vault_root / a["path"]
        assert p.is_file(), a["path"]
        assert a["href"].startswith("/notes?path=")
    assert (vault_root / "deliver").glob("*.md")
    assert len(list((vault_root / "recap").glob("*.md"))) == 1


def test_the_models_reply_is_kept_when_it_gives_one(monkeypatch, vault_root):
    _vault(monkeypatch, vault_root)
    payload = st.StructuredTurn(
        reply="已经存到产出区了，点上面的链接就能看。",
        artifacts=[st.ArtifactDraft(kind="deliver", title="周报", body="正文")],
    )
    out = asyncio.run(st.apply(payload))
    assert out["reply"].startswith("已经存到产出区")


def test_an_empty_body_is_dropped_with_a_reason(monkeypatch, vault_root):
    """有标题没正文 = 模型想蒙混。**不许静默丢** —— 原因要摆出来。"""
    _vault(monkeypatch, vault_root)
    payload = st.StructuredTurn(
        artifacts=[
            st.ArtifactDraft(kind="deliver", title="周报", body="   "),
            st.ArtifactDraft(kind="deliver", title="有正文的", body="正文"),
        ]
    )
    out = asyncio.run(st.apply(payload))
    assert len(out["artifacts"]) == 1 and len(out["dropped"]) == 1
    assert "body 是空的" in out["dropped"][0]["why"]


def test_an_unknown_kind_is_dropped_with_the_tools_own_message(monkeypatch, vault_root):
    _vault(monkeypatch, vault_root)
    payload = st.StructuredTurn(artifacts=[st.ArtifactDraft(kind="novel", title="x", body="正文")])
    out = asyncio.run(st.apply(payload))
    assert out["artifacts"] == [] and out["dropped"]
    assert "kind" in out["dropped"][0]["why"]


def test_too_many_drafts_are_refused_past_the_cap(monkeypatch, vault_root):
    """**两个上限是两件事，别混**：这个管「结构里塞了几份」（不同体裁各一份才算份数），
    W4 的 `MAX_SAVES_PER_KIND` 管「同体裁改了几版」。这里用四个**不同体裁**去撞份数上限。"""
    _vault(monkeypatch, vault_root)
    kinds = ["deliver", "recap", "research", "decide", "compose"]
    payload = st.StructuredTurn(
        artifacts=[
            st.ArtifactDraft(kind=k, title=f"第 {i} 份", body="正文") for i, k in enumerate(kinds)
        ]
    )
    out = asyncio.run(st.apply(payload))
    assert len(out["artifacts"]) == st.MAX_DRAFTS
    assert len(out["dropped"]) == len(kinds) - st.MAX_DRAFTS
    assert "最多" in out["dropped"][0]["why"]


def test_the_w4_revision_cap_still_bites_inside_a_structured_turn(monkeypatch, vault_root):
    """同体裁三份：W4 的上限（1 初稿 + 1 修订）先说话 —— 结构再能塞也不许写第三版。"""
    _vault(monkeypatch, vault_root)
    payload = st.StructuredTurn(
        artifacts=[
            st.ArtifactDraft(kind="deliver", title=f"周报 v{i}", body=f"第 {i} 版") for i in (1, 2, 3)
        ]
    )
    out = asyncio.run(st.apply(payload))
    # 前两份都真的落盘了（第二份覆盖第一份，同一个文件），第三份被 W4 的上限拦住
    assert len(out["artifacts"]) == 1, "同一个文件只有一条回执（按 path 去重）"
    assert len(out["dropped"]) == 1
    assert "修订额度" in out["dropped"][0]["why"]
    files = list((vault_root / "deliver").glob("*.md"))
    assert len(files) == 1
    assert "第 2 版" in files[0].read_text(encoding="utf-8"), "留在盘上的是第二次（那次修订）"


def test_the_same_kind_twice_revises_one_file(monkeypatch, vault_root):
    """结构里同体裁给两份 = 改自己刚写的那一份（与工具那条路的语义一致）。"""
    _vault(monkeypatch, vault_root)
    payload = st.StructuredTurn(
        artifacts=[
            st.ArtifactDraft(kind="deliver", title="周报 v1", body="第一版"),
            st.ArtifactDraft(kind="deliver", title="周报 v2", body="第二版"),
        ]
    )
    out = asyncio.run(st.apply(payload))
    files = list((vault_root / "deliver").glob("*.md"))
    assert len(files) == 1, "同体裁两份不该堆两个文件"
    assert len(out["artifacts"]) == 1, "回执只留最新那份（按 path 去重）"
    assert "第二版" in files[0].read_text(encoding="utf-8")


def test_no_artifacts_means_no_receipt_at_all(monkeypatch, vault_root):
    """**这一条就是「谎报率 = 0」在结构上的意思**：没有 artifacts 字段就没有回执 ——
    回执是服务端落盘之后自己拼的，模型碰不到它。"""
    _vault(monkeypatch, vault_root)
    payload = st.StructuredTurn(reply="已存入产出：周报（约 300 字）。", artifacts=[])
    out = asyncio.run(st.apply(payload))
    assert out["artifacts"] == []
    assert out["reply"] == "已存入产出：周报（约 300 字）。"  # 它的话不替它改
    # 但那一句谎话会被 W2a 的判据标出来（同一份判定，不另写一遍）
    from app.core import turn_quality

    codes = {f["code"] for f in turn_quality.findings(out["reply"], out["artifacts"])}
    assert "claims_a_save_without_one" in codes
    assert json.loads(json.dumps(out["artifacts"], ensure_ascii=False)) == []  # JSON 安全


# ---------- 2. 闸门 ----------


class _Decision:
    def __init__(self, delivery):
        self.delivery = delivery


def test_the_gate_needs_both_a_delivery_turn_and_a_measured_profile():
    on = {"force_structure": True}
    off = {"force_structure": False}
    assert st.enabled(on, _Decision(True))[0] is True
    assert st.enabled(on, _Decision(False))[0] is False
    assert st.enabled(off, _Decision(True))[0] is False
    why = st.enabled(off, _Decision(True))[1]
    assert "supports_structure" in why or "画像" in why


def test_the_reasons_are_human_readable():
    assert "交付型" in st.enabled({"force_structure": True}, _Decision(False))[1]
    assert "画像" in st.enabled({}, _Decision(True))[1]


# ---------- 3. 真回合：走结构 / 回落 ----------


def _chat_harness(monkeypatch, cid: int, *, structured_obj, profile_on=True):
    """把 `chat._generate` 跑一轮：模型换成一个写死的「最后一段文本」，画像是「结构化开着」。

    W2b 的结构化那一轮现在**仍然有读材料的工具**（只是没有 `save_artifact`），最后一段文本
    必须是那个 JSON —— 所以这里假的就是「工具循环最后返回的那段文本」。
    """
    import asyncio as _aio

    from app.core import model_profiles as mp
    from app.db import SessionLocal
    from app.models import Conversation, ProviderConfig, TurnEvalRun
    from app.routers import chat

    async def _prepare():
        async with SessionLocal() as db:
            from sqlalchemy import select

            if (
                await db.execute(select(ProviderConfig).where(ProviderConfig.name == "stub"))
            ).scalar_one_or_none() is None:
                db.add(ProviderConfig(name="stub", kind="openai", base_url="", enabled=True))
                await db.commit()
            if await db.get(Conversation, cid) is None:
                db.add(Conversation(id=cid, title="t", model_id="stub/m"))
                await db.commit()
        if profile_on:
            async with SessionLocal() as db:
                db.add(
                    TurnEvalRun(
                        scenario="deliver_report", scenario_sha="a", prompt_sha="b", model_id="stub/m",
                        total=6, deterministic=1.0, judged=5.0, seconds=9.0, detail_json="[]",
                    )
                )
                await db.commit()
            await mp.save("stub/m", {"force_structure": True, "supports_structure": True})
            await mp.bless("stub/m")

    _aio.run(_prepare())

    seen: dict = {"tools": [], "msgs": []}

    async def fake_round(client, model, messages, tools, emit_text, usage_out=None):  # noqa: ARG001
        seen["tools"] = tools or []
        seen["msgs"] = messages
        if structured_obj is None:
            emit_text("（模型没照形状回）")
            return "（模型没照形状回）", []
        text = json.dumps(structured_obj, ensure_ascii=False)
        emit_text(text)
        return text, []

    from app.core import llm

    monkeypatch.setattr(llm, "_openai_round", fake_round)

    class _NoClose:
        async def close(self):
            pass

    monkeypatch.setattr(llm, "_openai_client", lambda p: _NoClose())  # noqa: ARG005
    monkeypatch.setattr(chat, "_generate_followups", lambda *_a, **_k: _no_followups())
    monkeypatch.setattr(
        chat, "load_config", lambda: {"memory_enabled": False, "automemory_enabled": False}
    )
    return chat, seen


async def _no_followups():
    return []


def test_a_delivery_turn_with_a_measured_profile_goes_structured(monkeypatch, vault_root):
    _vault(monkeypatch, vault_root)
    from app.core import turn_trace

    cid = 9401
    chat, seen = _chat_harness(
        monkeypatch,
        cid,
        structured_obj={
            "reply": "存好了。",
            "artifacts": [{"kind": "deliver", "title": "周报", "body": "## 周一\n- 做了 A"}],
        },
    )

    async def go():
        frames = [
            f
            async for f in chat._generate(
                chat.ChatRequest(conversation_id=cid, content="整理成一份周报，存进产出。", model_id="stub/m")
            )
        ]
        traces = (await turn_trace.recent(limit=5))["traces"]
        return frames, next((t for t in traces if t["conversation_id"] == cid), None)

    frames, trace = asyncio.run(go())
    assert trace is not None
    assert trace["quality"]["structured"]["saved"] == 1
    assert trace["quality"]["structured"]["drafts"] == 1
    assert trace["answer_chars"] == len("存好了。")  # 正文没进对话（最后那段 JSON 没被当成答复）
    # **读材料的工具还在，`save_artifact` 不在** —— 结构化换掉的是交付那一步
    names = {(t.get("function") or {}).get("name") for t in seen["tools"]}
    assert "save_artifact" not in names
    assert "vault_read_file" in names or "kb_search" in names, names
    # 回执那帧给了界面，正文在盘上
    assert any(f.startswith("event: tool_result") and "周报" in f for f in frames)
    files = list((vault_root / "deliver").glob("*.md"))
    assert len(files) == 1 and "做了 A" in files[0].read_text(encoding="utf-8")


def test_when_the_structure_cannot_be_parsed_it_is_treated_as_a_plain_answer(monkeypatch, vault_root):
    """最后一段不是 JSON → 按普通答复处理（交给 W2a 那套判据），**不装作走了结构化**。"""
    _vault(monkeypatch, vault_root)
    from app.core import turn_trace

    cid = 9402
    chat, _ = _chat_harness(monkeypatch, cid, structured_obj=None)

    async def go():
        frames = [
            f
            async for f in chat._generate(
                chat.ChatRequest(conversation_id=cid, content="整理成一份周报，存进产出。", model_id="stub/m")
            )
        ]
        traces = (await turn_trace.recent(limit=5))["traces"]
        return frames, next((t for t in traces if t["conversation_id"] == cid), None)

    frames, trace = asyncio.run(go())
    assert trace is not None
    assert trace["quality"]["structured"]["fell_back"] is True
    assert trace["answer_chars"] > 0, "回落之后那一轮照样有答复"
    assert any("模型没照形状回" in f for f in frames)


def test_a_chat_turn_never_goes_structured(monkeypatch, vault_root):
    """普通聊天路径**一个字节都不动**（plan 风险表里那条）。"""
    _vault(monkeypatch, vault_root)
    from app.core import turn_trace

    cid = 9403
    chat, seen = _chat_harness(
        monkeypatch, cid, structured_obj={"reply": "不该走到这里", "artifacts": []}
    )

    async def go():
        frames = [
            f
            async for f in chat._generate(
                chat.ChatRequest(conversation_id=cid, content="讲讲数据库索引为什么能让查询变快。", model_id="stub/m")
            )
        ]
        traces = (await turn_trace.recent(limit=5))["traces"]
        return frames, next((t for t in traces if t["conversation_id"] == cid), None)

    frames, trace = asyncio.run(go())
    assert trace["quality"]["structured"]["off"] is True
    assert "交付型" in trace["quality"]["structured"]["why"]
    assert trace["answer_chars"] > 0
    # 闲聊那一轮的工具表**没被动过**（save_artifact 照旧在）
    names = {(t.get("function") or {}).get("name") for t in seen["tools"]}
    assert "save_artifact" in names, names
