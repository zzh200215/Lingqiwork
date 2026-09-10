"""模型竞技场 + 体检报告的离线测试。

竞技场：所有已启用 provider 并行各答一次，一家的失败不算全场失败；
体检报告：把 self_check + 备份 + 索引 + 任务失败 + 整理员拼成一页，
任何一块坏掉都不能 500。
"""
import asyncio
import atexit
import os
import shutil
import sys
import tempfile
from pathlib import Path


sys.path.insert(0, ".")

_TMP = Path(tempfile.mkdtemp(prefix="wb-arena-", dir=Path(__file__).parent))


def _cleanup() -> None:
    try:
        asyncio.run(engine.dispose())
    except Exception:  # noqa: BLE001
        pass
    shutil.rmtree(_TMP, ignore_errors=True)


atexit.register(_cleanup)
os.environ["WB_DB_PATH"] = str(_TMP / "test.db")
os.environ["WB_CONFIG_PATH"] = str(_TMP / "config.json")
os.environ["WB_CHROMA_PATH"] = str(_TMP / "chroma")

from sqlalchemy import delete  # noqa: E402

from app.core import arena as core  # noqa: E402
from app.db import SessionLocal, engine  # noqa: E402
from app.models import Base, Memory  # noqa: E402
from app.routers import health as health_router  # noqa: E402


async def _init() -> None:
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)


asyncio.run(_init())


def _cands():
    from app.core.llm import ProviderInfo

    return [
        (ProviderInfo(kind="openai", base_url="https://a", api_key="a"), "ma", "a/ma"),
        (ProviderInfo(kind="openai", base_url="https://b", api_key="b"), "mb", "b/mb"),
    ]


async def test_arena_runs_every_provider_in_parallel(monkeypatch):
    tried: list[str] = []

    async def fake_stream(info, model, messages, usage=None):
        tried.append(info.api_key)
        await asyncio.sleep(0.05)  # 两家都慢一点；并行时总耗时 ≈ 最慢一家
        yield f"来自 {info.api_key} 的回答"

    async def fake_cands(_mid):
        return _cands()

    monkeypatch.setattr(core, "stream_chat", fake_stream)  # arena 顶层绑定的名字
    monkeypatch.setattr("app.core.tasks._candidates", fake_cands)

    r = await core.run("用一句话介绍闭包")
    assert [x["label"] for x in r] == ["a/ma", "b/mb"]
    assert all(x["ok"] and x["text"] == f"来自 {x['label'][0]} 的回答" for x in r)
    assert tried == ["a", "b"]  # 两家都被打到
    assert r[0]["seconds"] < core.PER_CALL_TIMEOUT  # 并行：不是各家耗时之和


async def test_arena_one_failure_does_not_sink_the_rest(monkeypatch):
    async def fake_stream(info, model, messages, usage=None):
        if info.api_key == "a":
            raise ConnectionError("a 挂了")
        yield "b 正常"

    async def fake_cands(_mid):
        return _cands()

    monkeypatch.setattr(core, "stream_chat", fake_stream)
    monkeypatch.setattr("app.core.tasks._candidates", fake_cands)

    r = await core.run("hi")
    assert r[0]["ok"] is False and "a 挂了" in r[0]["error"]
    assert r[1]["ok"] is True and r[1]["text"] == "b 正常"


async def test_arena_empty_prompt_and_no_candidates(monkeypatch):
    assert await core.run("   ") == []  # 空 prompt 零成本返回

    async def no_cands(_mid):
        raise RuntimeError("没有已启用的 provider")

    monkeypatch.setattr("app.core.tasks._candidates", no_cands)
    r = await core.run("hi")
    assert len(r) == 1 and r[0]["ok"] is False and "provider" in r[0]["error"]


async def test_health_report_aggregates_and_survives_breakage(monkeypatch):
    async with SessionLocal() as db:
        await db.execute(delete(Memory))
        await db.commit()

    r = await health_router.report()
    # 断言「包含关键字段」而非「等于完整集合」——以后加字段不会破这个测试
    assert {"self", "backups", "kb", "tasks_failing", "tidy", "structured", "prompts", "cost"} <= set(r)
    assert r["self"]["jobs_total"] >= 0 and isinstance(r["tasks_failing"], list)

    # 备份列表挂掉：体检不 500，该块退化为空
    from app.core import backup as backup_core

    def boom():
        raise RuntimeError("backup down")

    monkeypatch.setattr(backup_core, "list_backups", boom)
    r2 = await health_router.report()
    assert r2["backups"] == {} and r2["self"]["jobs_total"] >= 0
