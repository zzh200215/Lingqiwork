"""Offline tests for the V1.4 memory upgrade: semantic dedup, relevance
recall, editing, and automemory JSON parsing.

Embeddings are faked with hand-picked 2-D vectors so no model is needed:
memory._embed_texts is the seam. Env must be set before app imports.
"""
import asyncio
import atexit
import shutil
import sys
import tempfile
from pathlib import Path

import pytest

sys.path.insert(0, ".")

# project-local scratch dir (system temp may be sandboxed)
_TMP = Path(tempfile.mkdtemp(prefix="wb-v14-", dir=Path(".").resolve()))


def _cleanup() -> None:
    try:
        asyncio.run(engine.dispose())
    except Exception:  # noqa: BLE001
        pass
    shutil.rmtree(_TMP, ignore_errors=True)


atexit.register(_cleanup)


from app.core import memory  # noqa: E402
from app.core.llm import ProviderInfo  # noqa: E402
from app.db import SessionLocal, engine  # noqa: E402
from app.models import Base, Memory  # noqa: E402


async def _create_all() -> None:
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)


asyncio.run(_create_all())


# 2-D fake embedding space:
#   python-related facts cluster near [1, 0]
#   food-related facts cluster near [0, 1]
FAKE_VECS: dict[str, list[float]] = {
    "用户偏好 Python": [1.0, 0.0],
    "用户主用 Python 写代码": [0.95, 0.31],  # cosine ≈ 0.95 with the above
    "用户喜欢喝咖啡": [0.0, 1.0],
    "用户常在早上跑步": [0.7, 0.7],
    "fastapi": [1.0, 0.0],
    "猫": [0.0, 1.0],
}


async def _fake_embed(texts: list[str]) -> list[list[float]]:
    out = []
    for t in texts:
        hit = next((v for k, v in FAKE_VECS.items() if k in t), None)
        out.append(hit if hit is not None else [0.6, 0.6])  # neutral fallback
    return out


@pytest.fixture(autouse=True)
def _env(monkeypatch):
    async def _clear():
        await memory.clear_all()
        memory._vec_cache.clear()

    asyncio.run(_clear())
    monkeypatch.setattr(memory, "_embed_texts", _fake_embed)
    yield


async def _add_raw(content: str, source: str = "manual", kind: str = "fact") -> int:
    async with SessionLocal() as db:
        row = Memory(content=content, source=source, kind=kind)
        db.add(row)
        await db.commit()
        await db.refresh(row)
        return row.id


async def _contents() -> list[str]:
    rows = await memory.list_memories()
    return [m.content for m in rows]


# ---------- add + dedup ----------


async def test_add_memory_exact_dedupe():
    assert (await memory.add_memory("用户偏好 Python")).startswith("已记住")
    again = await memory.add_memory("用户偏好 Python")
    assert "已存在" in again
    assert (await _contents()).count("用户偏好 Python") == 1


async def test_add_memory_semantic_dedupe():
    await memory.add_memory("用户偏好 Python")
    result = await memory.add_memory("用户主用 Python 写代码")  # cosine ≈ 0.95
    assert "已存在相似记忆" in result
    assert await _contents() == ["用户偏好 Python"]


async def test_add_memory_allows_different_topic():
    await memory.add_memory("用户偏好 Python")
    assert (await memory.add_memory("用户喜欢喝咖啡")).startswith("已记住")
    assert len(await _contents()) == 2


async def test_add_memory_source_and_length_guard():
    assert (await memory.add_memory("用户喜欢喝咖啡", source="auto")).startswith("已记住")
    rows = await memory.list_memories()
    assert rows[0].source == "auto"
    assert (await memory.add_memory("x" * 301)).startswith("[错误]")
    assert (await memory.add_memory("   ")).startswith("[错误]")


# ---------- relevance recall ----------


async def test_recall_small_collection_injects_all():
    await _add_raw("用户偏好 Python")
    await _add_raw("用户喜欢喝咖啡")
    block = await memory.format_memories("帮我写个 Python 脚本")
    assert "用户偏好 Python" in block and "用户喜欢喝咖啡" in block
    assert "按相关性选取" not in block


async def test_recall_ranks_by_query_when_many(monkeypatch):
    monkeypatch.setattr(memory, "RECALL_THRESHOLD", 2)
    monkeypatch.setattr(memory, "RECALL_TOP_K", 2)
    await _add_raw("用户偏好 Python")
    await _add_raw("用户喜欢喝咖啡")
    await _add_raw("用户常在早上跑步")

    block = await memory.format_memories("写 Python 代码")  # query embeds to neutral…
    # neutral query is equidistant — just check the ranking note exists
    assert "按相关性选取" in block

    # a query hitting the python cluster must keep the python fact
    FAKE_VECS["帮我写 Python 脚本"] = [1.0, 0.0]
    try:
        block = await memory.format_memories("帮我写 Python 脚本")
        assert "用户偏好 Python" in block
        assert "用户喜欢喝咖啡" not in block
    finally:
        del FAKE_VECS["帮我写 Python 脚本"]


# ---------- edit ----------


async def test_update_memory():
    mid = await _add_raw("用户偏好 Java")
    result = await memory.update_memory(mid, "用户偏好 Python")
    assert result.startswith("已更新")
    rows = await memory.list_memories()
    assert rows[0].content == "用户偏好 Python"
    assert (await memory.update_memory(9999, "x")).startswith("[未找到]")
    assert (await memory.update_memory(mid, "  ")).startswith("[错误]")


# ---------- automemory ----------


def _fake_stream(reply: str):
    async def _gen(_info, _model, _messages):
        yield reply

    return _gen


async def test_auto_extract_saves_new_facts(monkeypatch):
    monkeypatch.setattr(
        memory,
        "stream_chat",
        _fake_stream('["用户主用 fastapi 写后端", "用户养了一只猫"]'),
    )
    info = ProviderInfo(kind="openai", base_url="", api_key="k")
    saved = await memory.auto_extract(info, "m", "我用 fastapi 写了后端，还提到我的猫", "好的")
    assert saved == ["用户主用 fastapi 写后端", "用户养了一只猫"]
    rows = await memory.list_memories()
    assert all(m.source == "auto" for m in rows)
    assert len(rows) == 2


async def test_auto_extract_skips_model_duplicate(monkeypatch):
    await _add_raw("用户偏好 Python")
    monkeypatch.setattr(memory, "stream_chat", _fake_stream('["用户偏好 Python"]'))
    info = ProviderInfo(kind="openai", base_url="", api_key="k")
    saved = await memory.auto_extract(info, "m", "我又提到 Python 了", "ok")
    assert saved == []
    assert len(await _contents()) == 1


async def test_auto_extract_garbage_reply_is_silent(monkeypatch):
    monkeypatch.setattr(memory, "stream_chat", _fake_stream("模型没有按格式回答"))
    info = ProviderInfo(kind="openai", base_url="", api_key="k")
    assert await memory.auto_extract(info, "m", "你好", "你好！") == []
    assert await _contents() == []


async def test_auto_extract_types_facts_into_kinds(monkeypatch):
    """分类粒度（参考管家类产品收窄成三类）：抽取出的记忆带 kind 落库，
    注入提示词时带上标签——模型才知道这是稳定偏好还是项目背景。"""
    monkeypatch.setattr(
        memory,
        "stream_chat",
        _fake_stream(
            '[{"kind": "preference", "text": "用户偏好 Python"},'
            '{"kind": "fact", "text": "用户养了一只猫"},'
            '{"kind": "habit", "text": "用户常在早上跑步"}]'
        ),
    )
    info = ProviderInfo(kind="openai", base_url="", api_key="k")
    saved = await memory.auto_extract(info, "m", "对话内容", "回复")
    assert len(saved) == 2  # AUTO_FACT_CAP = 2，第三条被砍
    kinds = {m.content: m.kind for m in await memory.list_memories()}
    assert kinds["用户偏好 Python"] == "preference"
    assert kinds["用户养了一只猫"] == "fact"


async def test_auto_extract_normalizes_bad_kinds(monkeypatch):
    """模型乱写 kind（mood/emotion 一类的）不能落进库——归 fact。"""
    monkeypatch.setattr(
        memory,
        "stream_chat",
        _fake_stream('[{"kind": "mood", "text": "用户今天心情不错"}, "裸字符串也收"]'),
    )
    info = ProviderInfo(kind="openai", base_url="", api_key="k")
    await memory.auto_extract(info, "m", "对话", "回复")
    assert {m.kind for m in await memory.list_memories()} == {"fact"}


async def test_format_memories_labels_kinds(monkeypatch):
    await _add_raw("用户偏好 uv 管理依赖", kind="preference")
    await _add_raw("用户在做 AI 工作台")
    block = await memory.format_memories()
    assert "【偏好】用户偏好 uv 管理依赖" in block
    assert "用户在做 AI 工作台" in block and "【事实】用户在做" not in block


async def test_add_memory_rejects_unknown_kind():
    await memory.add_memory("用户在学 Rust", kind="mood")
    assert (await memory.list_memories())[0].kind == "fact"
