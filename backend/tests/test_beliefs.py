"""信念演化时间线：语义聚线（≥2 条成线）、命名取最近陈述、嵌入挂掉降级为空。"""
import asyncio
import atexit
import os
import shutil
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, ".")

_TMP = Path(tempfile.mkdtemp(prefix="wb-beliefs-", dir=Path(__file__).parent))


def _cleanup() -> None:
    try:
        asyncio.run(engine.dispose())
    except Exception:  # noqa: BLE001
        pass
    shutil.rmtree(_TMP, ignore_errors=True)


atexit.register(_cleanup)
os.environ["WB_DB_PATH"] = str(_TMP / "test.db")
os.environ["WB_CONFIG_PATH"] = str(_TMP / "config.json")

from sqlalchemy import delete  # noqa: E402

from app.core import beliefs as core  # noqa: E402
from app.core import memory as mem  # noqa: E402
from app.db import SessionLocal, engine  # noqa: E402
from app.models import Base, Memory  # noqa: E402


async def _init() -> None:
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)


asyncio.run(_init())


async def _reset_memories() -> None:
    async with SessionLocal() as db:
        await db.execute(delete(Memory))
        await db.commit()


async def _seed(*contents: str) -> None:
    async with SessionLocal() as db:
        for c in contents:
            db.add(Memory(content=c, source="auto", kind="fact"))
        await db.commit()


async def test_threads_cluster_related_assertions(monkeypatch):
    await _reset_memories()
    await _seed("我主要用 pnpm 管理依赖", "依赖管理统一用 pnpm，不再用 npm", "周六喜欢睡到自然醒")

    async def fake_embed(texts):
        return [[1.0, 0.1] if "pnpm" in t else [0.0, 1.0] for t in texts]

    monkeypatch.setattr(mem, "_embed_texts", fake_embed)
    ts = await core.threads()
    assert len(ts) == 1
    assert len(ts[0]["items"]) == 2
    assert all("pnpm" in it["content"] for it in ts[0]["items"])
    # 命名取该线最近的一条陈述；items 按 id 升序（≈ 时间序）
    assert "pnpm" in ts[0]["label"]
    assert ts[0]["items"][0]["id"] < ts[0]["items"][-1]["id"]


async def test_lonely_assertions_make_no_thread(monkeypatch):
    await _reset_memories()
    await _seed("完全无关的一条", "彼此也不相关的另一条")

    async def fake_embed(texts):
        return [[1.0, 0.0], [0.0, 1.0]]

    monkeypatch.setattr(mem, "_embed_texts", fake_embed)
    assert await core.threads() == []


async def test_threads_survive_embed_failure(monkeypatch):
    await _reset_memories()
    await _seed("A 事实", "B 事实", "C 事实")

    async def boom(texts):
        raise RuntimeError("embedder down")

    monkeypatch.setattr(mem, "_embed_texts", boom)
    assert await core.threads() == []  # 自我观察是甜点，不能是故障源
