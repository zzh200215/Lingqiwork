"""产出引擎（学习闭环的出口跳）的离线测试。

全部不打网络、不碰真实索引也不碰真实记忆库：`synthesize` 的模型调用走 `stream_fn`
注入，`gather_inward` 的三路（知识库 / 长期记忆 / 日记）都注入假函数。真实链路由
`smoke_compose.py` 验（真模型 + 真索引）。
"""
import asyncio
from pathlib import Path

import pytest

from app.core import compose

# ---------- 注入缝 ----------


def _llm(payload: str):
    """假 stream_fn：无论问什么都吐 payload（extract_json 走 L2 清洗路径）。"""

    async def _stream(info, model, messages):
        yield payload

    return _stream


@pytest.fixture
def wired(monkeypatch):
    """`_resolve` 永远成功——沙箱库里没有 provider，不然 synthesize 直接返回空。"""

    async def fake_resolve(model_id=""):
        from app.core.llm import ProviderInfo

        return ProviderInfo(kind="openai", base_url="http://x", api_key="k"), "test-model"

    monkeypatch.setattr(compose, "_resolve", fake_resolve)


async def _no_kb(query, top_k):
    return []


async def _no_memory(query):
    return ""


def _no_journal(limit):
    return []


async def _collect(gen) -> list[tuple[str, dict]]:
    return [ev async for ev in gen]


# ---------- gather_inward ----------


def test_gather_orders_kb_then_memory_then_journal():
    async def kb(query, top_k):
        return [
            {"source": "notes/a.md", "title": "A", "text": "内容A"},
            {"source": "notes/b.md", "title": "B", "text": "   "},  # 空文本 → 跳过
        ]

    async def memory(query):
        return "偏好：喜欢先拆任务"

    def journal(limit):
        return [
            {"date": "2026-09-09", "time": "08:10", "text": "在想 RAG 的评测"},
            {"date": "2026-09-08", "time": "21:00", "text": "读了 Agentic RAG"},
        ]

    srcs = asyncio.run(
        compose.gather_inward("RAG", kb_fn=kb, memory_fn=memory, journal_fn=journal)
    )

    assert [s["n"] for s in srcs] == [1, 2, 3]
    assert [s["kind"] for s in srcs] == ["kb", "memory", "journal"]
    assert srcs[0]["ref"] == "notes/a.md"  # 自己的成品排第一
    assert "偏好：喜欢先拆任务" in srcs[1]["text"]
    assert "2026-09-09 08:10 在想 RAG 的评测" in srcs[2]["text"]


def test_gather_accepts_async_journal():
    async def journal(limit):
        return [{"date": "2026-09-09", "time": "09:00", "text": "异步日记"}]

    srcs = asyncio.run(
        compose.gather_inward(
            "t", kb_fn=_no_kb, memory_fn=_no_memory, journal_fn=journal
        )
    )
    assert [s["kind"] for s in srcs] == ["journal"]


def test_gather_survives_any_single_leg_failing():
    async def boom(*_a, **_k):
        raise RuntimeError("挂了")

    # 只有知识库活着——记忆与日记全挂，照常出一条材料
    async def kb(query, top_k):
        return [{"source": "notes/a.md", "title": "A", "text": "内容A"}]

    srcs = asyncio.run(
        compose.gather_inward("t", kb_fn=kb, memory_fn=boom, journal_fn=boom)
    )
    assert [s["kind"] for s in srcs] == ["kb"]


def test_gather_returns_empty_when_every_leg_fails():
    async def boom(*_a, **_k):
        raise RuntimeError("挂了")

    srcs = asyncio.run(compose.gather_inward("t", kb_fn=boom, memory_fn=boom, journal_fn=boom))
    assert srcs == []


def test_gather_skips_blank_memory():
    # `journal.recent()` 自身已过滤空条目（`_parse`），所以这里只测记忆这条真会空的路：
    # `memory.format_memories()` 在没有记忆时返回 ""。
    async def blank_memory(query):
        return "   "

    srcs = asyncio.run(
        compose.gather_inward(
            "t", kb_fn=_no_kb, memory_fn=blank_memory, journal_fn=_no_journal
        )
    )
    assert srcs == []


# ---------- save ----------


def test_save_writes_vault_notes_and_indexes(monkeypatch):
    seen: list[Path] = []

    def fake_index(path, **kw):
        seen.append(Path(path))
        return 3

    monkeypatch.setattr("app.core.indexer.index_file", fake_index)

    rep = compose.Report(
        title="RAG 笔记", sections=[compose.Section(heading="H", body="B [1]")], used=[1]
    )
    srcs = [{"n": 1, "kind": "kb", "title": "笔记", "ref": "notes/a.md", "text": "x"}]
    out = asyncio.run(compose.save(rep, srcs))

    assert out["chunks"] == 3
    assert out["filename"].startswith("notes/") and out["filename"].endswith(".md")
    dest = compose.COMPOSE_DIR / Path(out["filename"]).name
    assert dest.exists()
    assert "RAG 笔记" in dest.read_text(encoding="utf-8")
    assert seen == [dest]  # 落盘之后确实进了索引——「下次先捞你自己的」靠这一步


# ---------- run（完整生成器） ----------


def _run(topic, **kw):
    async def _go():
        return await _collect(compose.run(topic, **kw))

    return asyncio.run(_go())


def test_run_rejects_empty_topic(wired):
    assert _run("   ") == [("error", {"message": "话题不能为空"})]


def test_run_errors_without_provider(wired, monkeypatch):
    monkeypatch.setattr("app.core.providers.default_model_id", lambda: "")
    events = _run("话题")
    assert [e for e, _ in events] == ["error"]
    assert "provider" in events[0][1]["message"]


def test_run_errors_when_no_material(wired, monkeypatch):
    monkeypatch.setattr("app.core.providers.default_model_id", lambda: "test-model")
    events = _run(
        "话题", kb_fn=_no_kb, memory_fn=_no_memory, journal_fn=_no_journal
    )
    assert [e for e, _ in events] == ["gathering", "error"]


def test_run_happy_path(wired, monkeypatch):
    monkeypatch.setattr("app.core.providers.default_model_id", lambda: "test-model")

    async def kb(query, top_k):
        return [{"source": "notes/a.md", "title": "A", "text": "内容A"}]

    async def memory(query):
        return "偏好：喜欢先拆任务"

    stream = _llm('{"title":"R","sections":[{"heading":"H","body":"B [1]"}],"used":[1]}')
    events = _run("话题", kb_fn=kb, memory_fn=memory, journal_fn=_no_journal, stream_fn=stream)

    assert [e for e, _ in events] == ["gathering", "sources", "writing", "report"]
    sources = events[1][1]
    assert len(sources["sources"]) == 2 and sources["kb"] == 1
    assert set(sources["sources"][0]) == {"n", "kind", "title", "ref"}  # 不带正文
    report = events[3][1]
    assert report["title"] == "R"
    assert report["used"] == [1]
    assert report["model_id"] == "test-model"
    # 质量闭环的 join key：事件必须带上「这版提示词」的指纹，否则反馈没法按版本统计
    from app.core import report as report_mod

    assert report["prompt_sha"] == report_mod.prompt_sha(compose._SYNTH_PROMPT)
