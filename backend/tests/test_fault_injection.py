"""故障注入回归（maple-os 参考项 4）。用 tests/fake_llm.py 的脚本把
「连不上 / 流中断 / 超时 / 输出不是 JSON」打进真实执行路径，钉住四条纪律：

1. 零输出才降级——stream_chat_fallback 输出开始后绝不换下一家；
2. 教学 say() 流中断时部分回复照旧保留，错误是 SSE 事件而不是 500；
3. 任务重试循环在超时后由下一个 attempt 承接，最终落库为 ok；
4. 解析路径的坏 JSON 落成一句人话报错，不抛裸异常给页面。
"""
import asyncio
import atexit
import shutil
import sys
import tempfile
from pathlib import Path
from types import SimpleNamespace

import pytest

sys.path.insert(0, ".")
sys.path.insert(0, str(Path(__file__).parent))  # 便于 `import fake_llm`

from fake_llm import FakeLLM  # noqa: E402

_TMP = Path(tempfile.mkdtemp(prefix="wb-fault-", dir=Path(__file__).parent))


def _cleanup() -> None:
    try:
        asyncio.run(engine.dispose())
    except Exception:  # noqa: BLE001
        pass
    shutil.rmtree(_TMP, ignore_errors=True)


atexit.register(_cleanup)

from sqlalchemy import delete  # noqa: E402

from app.core import tasks as tasks_core  # noqa: E402
from app.core import tutor as tutor_core  # noqa: E402
from app.db import SessionLocal, engine  # noqa: E402
from app.models import Base, ProviderConfig, ScheduledTask, TaskRun  # noqa: E402


async def _init_db() -> None:
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)


asyncio.run(_init_db())


async def _only_provider(name: str) -> None:
    async with SessionLocal() as db:
        await db.execute(delete(ProviderConfig))
        db.add(
            ProviderConfig(
                name=name, kind="openai", base_url=f"https://{name}", api_key=name,
                models=["m"], enabled=True,
            )
        )
        await db.commit()


async def _two_providers() -> None:
    async with SessionLocal() as db:
        await db.execute(delete(ProviderConfig))
        for n in ("dead", "live"):
            db.add(
                ProviderConfig(
                    name=n, kind="openai", base_url=f"https://{n}", api_key=n,
                    models=["m"], enabled=True,
                )
            )
        await db.commit()


# ---------- 1. 零输出才降级 ----------


async def test_fallback_switches_only_on_zero_output(monkeypatch):
    import app.core.llm as llm
    from app.core.llm import ProviderInfo, stream_chat_fallback

    fake = FakeLLM("fail", ["降级成功"])
    monkeypatch.setattr(llm, "stream_chat", fake.stream)
    cands = [
        (ProviderInfo(kind="openai", base_url="https://a", api_key="a"), "m", "a/m"),
        (ProviderInfo(kind="openai", base_url="https://b", api_key="b"), "m", "b/m"),
    ]
    served: dict = {}
    got = [
        c
        async for c in stream_chat_fallback(cands, [{"role": "user", "content": "x"}], served=served)
    ]
    assert got == ["降级成功"] and served == {"label": "b/m"}
    assert [c["info"].api_key for c in fake.calls] == ["a", "b"]

    dead = FakeLLM("drop", ["不应到达"])
    monkeypatch.setattr(llm, "stream_chat", dead.stream)
    with pytest.raises(RuntimeError, match="中断"):
        [c async for c in stream_chat_fallback(cands, [{"role": "user", "content": "x"}])]
    assert len(dead.calls) == 1  # 输出已开始，绝不换下一家


async def test_tutor_stream_survives_a_dead_pinned_provider(monkeypatch):
    await _two_providers()
    import app.core.llm as llm

    fake = FakeLLM("fail", ["讲下去"])
    monkeypatch.setattr(llm, "stream_chat", fake.stream)
    got = [d async for d in tutor_core._stream("dead/m", [{"role": "user", "content": "x"}])]
    assert got == ["讲下去"]
    assert [c["info"].api_key for c in fake.calls] == ["dead", "live"]


# ---------- 2. say() 流中断：部分回复保留，错误是事件 ----------


async def test_say_keeps_the_partial_reply_when_the_stream_drops(monkeypatch):
    from app.core import providers

    monkeypatch.setattr(providers, "default_model_id", lambda: "dead/m")
    monkeypatch.setattr(providers, "is_unhealthy", lambda mid, cache=None: False)
    await _only_provider("dead")  # 只有这一家：drop 无处可降

    async def _fake_embed(texts):
        return [[1.0, 0.0] for _ in texts]

    async def _no_retrieve(query, top_k):
        return []

    monkeypatch.setattr(tutor_core, "_embed", _fake_embed)
    monkeypatch.setattr(tutor_core, "_retrieve", _no_retrieve)

    sid = (await tutor_core.start("asyncio 事件循环"))["id"]
    fake = FakeLLM("drop")
    import app.core.llm as llm

    monkeypatch.setattr(llm, "stream_chat", fake.stream)

    events = [e async for e in tutor_core.say(sid, "我想搞懂 await")]
    kinds = [k for k, _ in events]
    assert kinds[-1] == "error"
    assert any(d["text"] == "半句" for k, d in events if k == "delta")
    turns = await tutor_core.turns(sid)
    assert turns[-1] == {"role": "assistant", "content": "半句"}  # 打出来的半句不丢


# ---------- 3. 任务超时后由下一个 attempt 承接 ----------


async def test_task_retry_survives_a_timeout(monkeypatch):
    import app.core.llm as llm

    tasks_core._RETRY_DELAY_SECONDS = 0
    async with SessionLocal() as db:
        await db.execute(delete(TaskRun))
        await db.execute(delete(ScheduledTask))
        await db.execute(delete(ProviderConfig))
        db.add(
            ProviderConfig(name="p1", kind="openai", base_url="https://p1", api_key="p1",
                           models=["m"], enabled=True)
        )
        row = ScheduledTask(name="超时任务", prompt="做点事", cron="0 9 * * *", tools_enabled=False)
        db.add(row)
        await db.commit()
        await db.refresh(row)

    fake = FakeLLM("timeout", ["恢复后的回答"])
    monkeypatch.setattr(llm, "stream_chat", fake.stream)
    got = await tasks_core.run_task(row.id, trigger="cron")
    assert got["status"] == "ok"
    assert len(fake.calls) == 2  # 第一次超时（零输出），attempt 2 恢复


# ---------- 4. 解析路径的坏 JSON 落成人话 ----------


async def test_parse_schedule_bad_json_lands_as_a_human_error(monkeypatch):
    provider = SimpleNamespace(kind="openai", base_url="", api_key="k")

    async def _resolve(_model_id):
        return provider, "m"

    fake = FakeLLM("badjson")
    monkeypatch.setattr(tasks_core, "_resolve", _resolve)
    monkeypatch.setattr(tasks_core, "stream_chat", fake.stream)
    with pytest.raises(ValueError, match="JSON"):
        await tasks_core.parse_schedule("每天八点喝水")
