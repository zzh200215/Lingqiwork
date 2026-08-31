"""Offline tests for sleep-time memory tidying: clustering, LLM merge
apply/keep/skip paths, report persistence, and reschedule config wiring.

Embeddings are faked via memory._embed_texts; the writer via
memory_tidy._resolve_writer; the LLM via memory_tidy.stream_chat.
Env must be set before app imports.
"""
import asyncio
import atexit
import os
import shutil
import sys
import tempfile
from pathlib import Path

import pytest
from sqlalchemy import select

sys.path.insert(0, ".")

# project-local scratch dir (system temp may be sandboxed)
_TMP = Path(tempfile.mkdtemp(prefix="wb-tidy-", dir=Path(".").resolve()))


def _cleanup() -> None:
    try:
        asyncio.run(engine.dispose())
    except Exception:  # noqa: BLE001
        pass
    shutil.rmtree(_TMP, ignore_errors=True)


atexit.register(_cleanup)

os.environ["WB_DB_PATH"] = str(_TMP / "test.db")
os.environ["WB_CONFIG_PATH"] = str(_TMP / "config.json")

from app.core import memory, memory_tidy  # noqa: E402
from app.core import scheduler as sched  # noqa: E402
from app.core.llm import ProviderInfo  # noqa: E402
from app.core.prefs import save_config  # noqa: E402
from app.db import SessionLocal, engine  # noqa: E402
from app.models import Base, Memory  # noqa: E402


async def _create_all() -> None:
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)


asyncio.run(_create_all())


# 2-D fake embedding space: python facts cluster near [1, 0], food near [0, 1]
FAKE_VECS: dict[str, list[float]] = {
    "用户偏好 Python": [1.0, 0.0],
    "用户主用 Python 写代码": [0.95, 0.31],  # cosine ≈ 0.95 with the above
    "用户喜欢喝咖啡": [0.0, 1.0],
    "用户常在早上跑步": [0.7, 0.7],
}


async def _fake_embed(texts: list[str]) -> list[list[float]]:
    out = []
    for t in texts:
        hit = next((v for k, v in FAKE_VECS.items() if k in t), None)
        out.append(hit if hit is not None else [0.6, 0.6])
    return out


async def _insert(contents: list[str]) -> list[int]:
    """Insert rows directly: add_memory's 0.92 dedup would refuse the drift
    pairs this module exists to clean up."""
    async with SessionLocal() as db:
        ids = []
        for c in contents:
            row = Memory(content=c)
            db.add(row)
            await db.flush()
            ids.append(row.id)
        await db.commit()
    return ids


async def _all_contents() -> list[str]:
    async with SessionLocal() as db:
        rows = (await db.execute(select(Memory).order_by(Memory.id))).scalars().all()
        return [r.content for r in rows]


async def _fake_writer():
    return ProviderInfo(kind="openai", base_url="", api_key=""), "fake-model"


def _fake_llm(response: str, calls: list):
    async def _gen(info, model, messages, **kwargs):
        calls.append(messages)
        yield response

    return _gen


def _boom_llm(calls: list):
    async def _gen(info, model, messages, **kwargs):
        calls.append(messages)
        raise RuntimeError("provider down")
        yield ""  # pragma: no cover - makes this an async generator

    return _gen


@pytest.fixture(autouse=True)
def _env(monkeypatch):
    async def _clear():
        await memory.clear_all()
        memory._vec_cache.clear()

    asyncio.run(_clear())
    monkeypatch.setattr(memory, "_embed_texts", _fake_embed)
    monkeypatch.setattr(memory_tidy, "_report_path", lambda: _TMP / "tidy.json")
    monkeypatch.setattr(memory_tidy, "_resolve_writer", _fake_writer)
    monkeypatch.setattr(memory_tidy, "stream_chat", _fake_llm("{}", []))
    yield
    save_config({"memory_tidy_enabled": False})


# ---------- clustering ----------


def test_cluster_pairs_and_chains():
    rows = [Memory(content=c) for c in ("a", "b", "c", "d")]
    vecs = [
        [1.0, 0.0],
        [0.99, 0.1],  # near a
        [0.95, 0.31],  # near b (chain), not directly near a
        [0.0, 1.0],
    ]
    got = memory_tidy._cluster(rows, vecs)
    assert sorted(sorted(g) for g in got) == [[0, 1, 2]]


def test_cluster_ignores_missing_vectors():
    rows = [Memory(content=c) for c in ("a", "b")]
    assert memory_tidy._cluster(rows, [None, [1.0, 0.0]]) == []


# ---------- _parse_merge ----------


def test_parse_merge_variants():
    assert memory_tidy._parse_merge('{"action": "merge", "content": "合并后"}') == "合并后"
    assert memory_tidy._parse_merge('好的 {"action": "merge", "content": "x"} 完毕') == "x"
    assert memory_tidy._parse_merge('{"action": "keep"}') is None
    assert memory_tidy._parse_merge("不是 JSON") is None
    assert memory_tidy._parse_merge('{"action": "merge", "content": "   "}') is None
    long = "字" * 300
    assert len(memory_tidy._parse_merge(f'{{"action": "merge", "content": "{long}"}}')) == 200


# ---------- run_tidy paths ----------


async def test_noop_with_single_memory():
    await _insert(["用户喜欢喝咖啡"])
    report = await memory_tidy.run_tidy()
    assert report["ok"] and report["clusters"] == 0 and report["before"] == 1


async def test_no_clusters_never_calls_llm(monkeypatch):
    await _insert(["用户喜欢喝咖啡", "用户常在早上跑步"])
    calls: list = []
    monkeypatch.setattr(memory_tidy, "stream_chat", _boom_llm(calls))
    report = await memory_tidy.run_tidy()
    assert report["ok"] and report["clusters"] == 0 and not calls
    assert sorted(await _all_contents()) == ["用户喜欢喝咖啡", "用户常在早上跑步"]


async def test_merge_applies_and_updates_oldest_id(monkeypatch):
    ids = await _insert(["用户偏好 Python", "用户主用 Python 写代码", "用户喜欢喝咖啡"])
    calls: list = []
    monkeypatch.setattr(
        memory_tidy, "stream_chat", _fake_llm('{"action": "merge", "content": "用户主用 Python 写代码"}', calls)
    )
    report = await memory_tidy.run_tidy()
    assert report["merged"] == 1 and report["after"] == 2
    assert report["details"][0]["ids"] == [ids[0], ids[1]]
    contents = await _all_contents()
    assert sorted(contents) == ["用户主用 Python 写代码", "用户喜欢喝咖啡"]
    # oldest id kept in place with the merged text, dropped id gone from cache
    async with SessionLocal() as db:
        kept = await db.get(Memory, ids[0])
        assert kept.content == "用户主用 Python 写代码"
    assert ids[1] not in memory._vec_cache
    assert len(calls) == 1


async def test_keep_action_changes_nothing(monkeypatch):
    await _insert(["用户偏好 Python", "用户主用 Python 写代码"])
    monkeypatch.setattr(memory_tidy, "stream_chat", _fake_llm('{"action": "keep"}', []))
    report = await memory_tidy.run_tidy()
    assert report["ok"] and report["clusters"] == 1 and report["skipped"] == 1
    assert report["merged"] == 0 and report["after"] == 2
    assert len(await _all_contents()) == 2


async def test_llm_errors_are_skipped(monkeypatch):
    ids = await _insert(["用户偏好 Python", "用户主用 Python 写代码"])
    calls: list = []
    monkeypatch.setattr(memory_tidy, "stream_chat", _boom_llm(calls))
    report = await memory_tidy.run_tidy()
    assert report["skipped"] == 1 and report["merged"] == 0
    assert sorted(await _all_contents()) == ["用户主用 Python 写代码", "用户偏好 Python"]
    assert ids == list(range(ids[0], ids[0] + 2))  # rows untouched


async def test_no_provider_reports_error(monkeypatch):
    await _insert(["用户偏好 Python", "用户主用 Python 写代码"])

    async def _none():
        return None

    monkeypatch.setattr(memory_tidy, "_resolve_writer", _none)
    report = await memory_tidy.run_tidy()
    assert report["ok"] is False and "provider" in report["error"]


async def test_embed_failure_degrades_to_noop(monkeypatch):
    await _insert(["用户偏好 Python", "用户主用 Python 写代码"])

    async def _boom(texts):
        raise RuntimeError("embedder offline")

    monkeypatch.setattr(memory, "_embed_texts", _boom)
    report = await memory_tidy.run_tidy()
    assert report["ok"] and report["clusters"] == 0


async def test_report_is_persisted(monkeypatch):
    await _insert(["用户偏好 Python", "用户主用 Python 写代码"])
    monkeypatch.setattr(
        memory_tidy, "stream_chat", _fake_llm('{"action": "merge", "content": "用户主用 Python 写代码"}', [])
    )
    await memory_tidy.run_tidy()
    saved = memory_tidy.last_report()
    assert saved.get("merged") == 1 and saved.get("after") == 1


# ---------- scheduling wiring ----------


def test_reschedule_reads_prefs(monkeypatch):
    calls: dict = {}

    def fake_set_daily(job_id, func, enabled, hhmm, default_hour=9):
        calls.update(id=job_id, enabled=enabled, hhmm=hhmm, dh=default_hour)

    monkeypatch.setattr(sched, "set_daily", fake_set_daily)
    save_config({"memory_tidy_enabled": True, "memory_tidy_time": "04:15"})
    memory_tidy.reschedule()
    assert calls == {"id": "memory_tidy", "enabled": True, "hhmm": "04:15", "dh": 3}
    save_config({"memory_tidy_enabled": False})
    memory_tidy.reschedule()
    assert calls["enabled"] is False
