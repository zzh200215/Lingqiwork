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


# ---------- 睡眠期反思（reflect）：记忆流水 → kind=insight 的更高层观察 ----------


async def test_reflect_adds_insight(monkeypatch):
    monkeypatch.setattr(memory_tidy, "load_config", lambda: {"automemory_enabled": True})

    async def _insight_embed(texts: list[str]) -> list[list[float]]:
        # insight 文本给一个异维向量：不与 2-D 假嵌入空间里的任何事实撞 0.92 去重线
        out = []
        for t in texts:
            out.append([0.1, 0.1, 1.0] if "重心" in t else (await _fake_embed([t]))[0])
        return out

    monkeypatch.setattr(memory, "_embed_texts", _insight_embed)
    await _insert(
        [
            "用户偏好 Python",
            "用户主用 Python 写代码",
            "用户喜欢喝咖啡",
            "用户常在早上跑步",
            "用户在学 asyncio",
        ]
    )
    calls: list = []
    monkeypatch.setattr(
        memory_tidy,
        "stream_chat",
        _fake_llm('[{"text": "用户的重心在 Python 与并发底层", "based_on": [1, 2]}]', calls),
    )
    report = await memory_tidy.reflect({"ok": True})
    assert report["reflection"] == {"added": 1}
    async with SessionLocal() as db:
        rows = (
            await db.execute(select(Memory).where(Memory.kind == "insight").order_by(Memory.id))
        ).scalars().all()
    assert len(rows) == 1 and rows[0].source == "auto" and "重心" in rows[0].content
    # 提示词带编号流水与已有洞察节
    assert "记忆流水" in calls[0][1]["content"] and "已有洞察" in calls[0][1]["content"]


async def test_reflect_disabled_never_calls_llm(monkeypatch):
    monkeypatch.setattr(memory_tidy, "load_config", lambda: {"automemory_enabled": False})
    calls: list = []
    monkeypatch.setattr(memory_tidy, "stream_chat", _boom_llm(calls))
    report = await memory_tidy.reflect({})
    assert report["reflection"] == {"skipped": "automemory off"}
    assert calls == []


async def test_reflect_needs_min_facts(monkeypatch):
    monkeypatch.setattr(memory_tidy, "load_config", lambda: {"automemory_enabled": True})
    await _insert(["甲", "乙", "丙", "丁"])  # 4 < REFLECT_MIN_FACTS
    calls: list = []
    monkeypatch.setattr(memory_tidy, "stream_chat", _boom_llm(calls))
    report = await memory_tidy.reflect({})
    assert report["reflection"]["skipped"].startswith("记忆少于")
    assert calls == []


# ---------- 记忆证据链（DeepTutor 参考项：可检视记忆） ----------


def test_parse_evidence_tolerates_garbage():
    assert memory.parse_evidence("") == []
    assert memory.parse_evidence("not json") == []
    assert memory.parse_evidence('{"a": 1}') == []
    assert memory.parse_evidence('[{"text": "没 id"}]') == [{"id": -1, "text": "没 id"}]
    assert memory.parse_evidence('[{"id": "3", "text": "  带空白  "}]') == [{"id": 3, "text": "带空白"}]


def test_merge_evidence_dedups_and_caps():
    existing = memory.merge_evidence(
        "[]", [[{"id": 3, "text": "直接依据"}], [{"id": 3, "text": "重复的"}, {"id": 4, "text": "间接依据"}]]
    )
    assert [d["id"] for d in memory.parse_evidence(existing)] == [3, 4]  # 同 id 保留先出现的直接版
    # cap 丢最旧：链是给人看的，新依据总是更接近现状
    many = [[{"id": i, "text": f"t{i}"}] for i in range(12)]
    data = memory.parse_evidence(memory.merge_evidence("[]", many))
    assert len(data) == memory.EVIDENCE_CAP and data[-1]["id"] == 11
    # 已有证据不丢：追加时直接依据排最前，原有证据跟在后面
    merged = memory.merge_evidence(existing, [[{"id": 5, "text": "新依据"}]])
    ids = [d["id"] for d in memory.parse_evidence(merged)]
    assert ids == [5, 3, 4]


async def test_merge_records_absorbed_sources(monkeypatch):
    """合并行要能回答「这条是从哪来的」：被吸收的原行删掉了，文本快照留在证据里。"""
    ids = await _insert(["用户偏好 Python", "用户主用 Python 写代码"])
    monkeypatch.setattr(
        memory_tidy, "stream_chat", _fake_llm('{"action": "merge", "content": "用户主用 Python 写代码"}', [])
    )
    await memory_tidy.run_tidy()
    async with SessionLocal() as db:
        kept = await db.get(Memory, ids[0])
    evidence = memory.parse_evidence(kept.evidence_json)
    assert [e["id"] for e in evidence] == [ids[1]]
    assert evidence[0]["text"] == "用户主用 Python 写代码"


async def test_reflect_insight_carries_based_on_evidence(monkeypatch):
    """洞察的 based_on 编号映射回原句做快照：洞察不是模型的一句话，页面上要能
    展开看它从哪几条记忆拼出来。流水里不存在的编号（模型幻觉）丢弃。"""
    monkeypatch.setattr(memory_tidy, "load_config", lambda: {"automemory_enabled": True})
    ids = await _insert(
        [
            "用户偏好 Python",
            "用户主用 Python 写代码",
            "用户喜欢喝咖啡",
            "用户常在早上跑步",
            "用户在学 asyncio",
        ]
    )

    async def _insight_embed(texts: list[str]) -> list[list[float]]:
        out = []
        for t in texts:
            out.append([0.1, 0.1, 1.0] if "重心" in t else (await _fake_embed([t]))[0])
        return out

    monkeypatch.setattr(memory, "_embed_texts", _insight_embed)
    calls: list = []
    monkeypatch.setattr(
        memory_tidy,
        "stream_chat",
        _fake_llm(f'[{{"text": "用户的重心在 Python", "based_on": [{ids[0]}, 9999]}}]', calls),
    )
    report = await memory_tidy.reflect({"ok": True})
    assert report["reflection"] == {"added": 1}
    async with SessionLocal() as db:
        row = (await db.execute(select(Memory).where(Memory.kind == "insight"))).scalars().one()
    evidence = memory.parse_evidence(row.evidence_json)
    assert [e["id"] for e in evidence] == [ids[0]]  # 9999 不在流水里，丢弃
    assert evidence[0]["text"] == "用户偏好 Python"


async def test_run_tidy_reports_reflection_when_automemory_off(monkeypatch):
    # 合并没得做（无相近簇路径）也要报告反思这一步——一个 job，一份报告
    await _insert(["孤立的记忆甲", "孤立的记忆乙", "孤立的记忆丙", "孤立的记忆丁", "孤立的记忆戊"])
    monkeypatch.setattr(memory_tidy, "_cluster", lambda rows, vecs: [])
    report = await memory_tidy.run_tidy()
    assert "reflection" in report
