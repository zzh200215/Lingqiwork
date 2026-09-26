"""学习小组圆桌：三 persona 串行两轮、纪要落盘可解析回播客块、路由回落卡点。

LLM 走降级链（stream_chat_fallback）与 provider 解析（tasks._candidates）都在
函数体内延迟导入，patch 各自的源模块即可；ROUND_DIR 指到项目内临时目录。
"""
import atexit
import shutil
import sys
import tempfile
from pathlib import Path

import pytest

sys.path.insert(0, ".")

_SCRATCH = Path(tempfile.mkdtemp(prefix="wb-roundtable-", dir=Path(__file__).parent))


def _cleanup() -> None:
    shutil.rmtree(_SCRATCH, ignore_errors=True)


atexit.register(_cleanup)

from fastapi import HTTPException  # noqa: E402

from app.core import roundtable as core  # noqa: E402
import app.routers.roundtable as router_mod  # noqa: E402


def _patch_dir(monkeypatch, name: str) -> Path:
    d = _SCRATCH / name
    monkeypatch.setattr(core, "ROUND_DIR", d)
    return d


async def _fake_candidates(_):
    return [("p", "m", "p/m")]


def _scripted_llm(script: list[str], calls: list):
    """stream_chat_fallback 替身：按调用次序吐 script 文本，并记录 messages。"""

    async def fake(candidates, messages):
        calls.append({"candidates": candidates, "messages": messages})
        text = script[len(calls) - 1] if len(calls) <= len(script) else script[-1]
        for piece in (text[:20], text[20:]):
            if piece:
                yield piece

    return fake


def _fail_llm(calls: list):
    async def fake(candidates, messages):
        calls.append(messages)
        raise RuntimeError("boom")
        yield ""  # pragma: no cover - 使其成为 async generator

    return fake


async def test_run_produces_transcript_and_file(monkeypatch):
    _patch_dir(monkeypatch, "one")
    calls: list = []
    monkeypatch.setattr("app.core.tasks._candidates", _fake_candidates)
    monkeypatch.setattr(
        "app.core.llm.stream_chat_fallback",
        _scripted_llm(
            ["我先问个问题", "说人话就是……", "给你个反例", "接着追问", "换个例子", "边界在这里"],
            calls,
        ),
    )
    out = await core.run("asyncio 事件循环")
    assert [t["persona"] for t in out["turns"]] == ["mentor", "peer", "skeptic"] * 2
    assert out["turns"][0]["name"] == "苏格拉底老师"
    # 每个人都看得到前面的发言：第 4 通电话的 user 内容里有前 3 人的话
    assert "我先问个问题" in calls[3]["messages"][1]["content"]
    text = Path(out["file"]).read_text(encoding="utf-8")
    assert text.startswith("# 学习小组圆桌：asyncio 事件循环")
    assert "## 第 1 轮" in text and "## 第 2 轮" in text
    assert "**费曼同侪**：说人话就是……" in text


async def test_parse_and_recent_roundtrip(monkeypatch):
    _patch_dir(monkeypatch, "two")
    monkeypatch.setattr("app.core.tasks._candidates", _fake_candidates)
    monkeypatch.setattr(
        "app.core.llm.stream_chat_fallback",
        _scripted_llm(["一句", "两句", "三句", "四句", "五句", "六句"], []),
    )
    out = await core.run("回忆的提取面")
    topic, turns = core.parse_file(Path(out["file"]))
    assert topic == "回忆的提取面"
    assert len(turns) == 6 and turns[0]["name"] == "苏格拉底老师"
    items = core.recent()
    assert items and items[0]["topic"] == "回忆的提取面" and items[0]["turns"] == 6


async def test_empty_topic_raises(monkeypatch):
    _patch_dir(monkeypatch, "three")
    with pytest.raises(ValueError):
        await core.run("   ")


async def test_all_turns_failing_raises_runtimeerror(monkeypatch):
    _patch_dir(monkeypatch, "four")
    monkeypatch.setattr("app.core.tasks._candidates", _fake_candidates)
    calls: list = []
    monkeypatch.setattr("app.core.llm.stream_chat_fallback", _fail_llm(calls))
    with pytest.raises(RuntimeError):
        await core.run("聊不出话的话题")


# ---------- 路由 ----------


async def test_router_falls_back_to_latest_stuck_point(monkeypatch):
    _patch_dir(monkeypatch, "router")
    seen: dict = {}

    async def fake_stuck(days=90, cap=8):
        return [("卡点：SQLite WAL 模式（半懂）", "用户围绕 WAL 卡过：以为它锁全库")]

    async def fake_run(topic, context="", rounds=2):
        seen.update(topic=topic, context=context)
        return {"topic": topic, "turns": [], "file": "", "at": ""}

    monkeypatch.setattr("app.core.tutor.stuck_blocks", fake_stuck)
    monkeypatch.setattr(router_mod.roundtable, "run", fake_run)
    out = await router_mod.start_roundtable(router_mod.RoundtableIn(topic=""))
    assert seen["topic"] == "SQLite WAL 模式（半懂）" and "WAL" in seen["context"]
    assert out["topic"] == seen["topic"]


async def test_router_422_when_no_topic_and_no_stuck(monkeypatch):
    _patch_dir(monkeypatch, "router-empty")

    async def fake_stuck(days=90, cap=8):
        return []

    monkeypatch.setattr("app.core.tutor.stuck_blocks", fake_stuck)
    with pytest.raises(HTTPException) as ei:
        await router_mod.start_roundtable(router_mod.RoundtableIn(topic=""))
    assert ei.value.status_code == 422


async def test_router_podcast_parses_file_into_blocks(monkeypatch):
    _patch_dir(monkeypatch, "pod")
    turns = [
        {"persona": "mentor", "name": "苏格拉底老师", "text": "先问一句"},
        {"persona": "peer", "name": "费曼同侪", "text": "说人话是"},
    ]
    path = core._save("圆桌播客话题", turns)
    seen: dict = {}

    async def fake_generate(blocks, host_voice="", guest_voice="", title=""):
        seen.update(blocks=list(blocks), title=title)
        return {"ok": True, "id": "x", "file": "podcast.wav"}

    monkeypatch.setattr("app.core.podcast.generate_from_blocks", fake_generate)
    out = await router_mod.roundtable_podcast(router_mod.PodcastIn(file=str(path)))
    assert out["ok"] is True
    assert seen["blocks"][0] == ("圆桌·苏格拉底老师", "先问一句")
    assert "圆桌讨论 · 圆桌播客话题" in seen["title"]


# ---------- A2 的边界：圆桌**不给工具** ----------


async def test_roundtable_never_reaches_the_delegate_channel(monkeypatch):
    """A2 明文写死：**圆桌保持无工具**（`Agent升级.md` §2）。

    为什么：圆桌的价值是「视角碰撞」，它自己的注释写着「圆桌是接话，不是演讲」；
    给了工具（尤其能落盘/能委派）就变成一场小型执行，味道全变。

    这条测试**行为上**钉住它：把 `delegate.run` 换成一颗地雷，圆桌照常跑完 —— 说明
    它一步都没往委派通道走。另一半是结构性的：它的模型调用是
    `stream_chat_fallback(candidates, messages)`，**签名里根本没有 tools**
    （下面的替身也只接受这两个参数，多传一个就 TypeError）。
    """
    from app.core import delegate

    _patch_dir(monkeypatch, "no-tools")
    calls: list = []
    monkeypatch.setattr("app.core.tasks._candidates", _fake_candidates)
    monkeypatch.setattr(
        "app.core.llm.stream_chat_fallback",
        _scripted_llm(["先问一句", "说人话是", "给你个反例"], calls),
    )

    def mine(*_a, **_kw):
        raise AssertionError("圆桌不该走 delegate 通道")

    monkeypatch.setattr(delegate, "run", mine)
    out = await core.run("不给工具的话题")
    assert len(out["turns"]) == len(core.PERSONAS) * core.ROUNDS  # 两个人设轮次照旧跑满
    assert all("tools" not in c for c in calls)
