"""辅助 LLM 调用的记账接线测试（方向 4）。

压缩摘要（compaction）与追问（followups）都在烧 token，但哪条腿都没进——修法是给
它们开 `usage_ledger.span`，让 `note()` 有处可落。这里测的是**接线**：span 真的开了、
假模型调用的 note() 真被收进了对应 kind 的行；缓存命中没有模型调用就不该有行；
`stream_chat` 只在 span 内才向 provider 要 usage（带 accumulator 的旧路径不许被破坏）。
"""
import asyncio
import sys
from types import SimpleNamespace

from sqlalchemy import delete, select

sys.path.insert(0, ".")

from app.core import usage_ledger as ul  # noqa: E402
from app.db import SessionLocal, engine as _engine  # noqa: E402
from app.models import Base as _Base, ModelUsage  # noqa: E402


async def _init_db():
    async with _engine.begin() as conn:
        await conn.run_sync(_Base.metadata.create_all)


asyncio.run(_init_db())


async def _clear(kind: str) -> None:
    async with SessionLocal() as db:
        await db.execute(delete(ModelUsage).where(ModelUsage.kind == kind))
        await db.commit()


async def _kind_rows(kind: str) -> list[ModelUsage]:
    async with SessionLocal() as db:
        return (
            (await db.execute(select(ModelUsage).where(ModelUsage.kind == kind)))
            .scalars()
            .all()
        )


def _provider():
    from app.core.llm import ProviderInfo

    return ProviderInfo(kind="openai", base_url="", api_key="k")


def _history() -> list[dict]:
    # 超过 HISTORY_CHAR_BUDGET 的一半才切得出要压缩的 src
    return [
        {"role": "user" if i % 2 == 0 else "assistant", "content": "x" * 3000} for i in range(10)
    ]


async def test_compaction_notes_into_the_ledger(monkeypatch):
    from app.core import compaction

    async def fake_stream(provider, model, messages, usage=None):  # noqa: ARG001
        ul.note(model, 100, 50)
        yield "摘要"

    monkeypatch.setattr(compaction, "stream_chat", fake_stream)
    await _clear("compaction")
    summary, _tail = await compaction.compact(
        _provider(), "m1", 90001, _history()
    )
    assert summary == "摘要"
    rows = await _kind_rows("compaction")
    assert len(rows) == 1, "span 内的调用必须落成一行"
    assert rows[0].model_id == "m1"
    assert rows[0].tokens_in == 100 and rows[0].tokens_out == 50


async def test_compaction_cache_hit_writes_no_rows(monkeypatch):
    from app.core import compaction

    calls = {"n": 0}

    async def fake_stream(provider, model, messages, usage=None):  # noqa: ARG001
        calls["n"] += 1
        ul.note(model, 7, 7)
        yield "摘要"

    monkeypatch.setattr(compaction, "stream_chat", fake_stream)
    await _clear("compaction")
    await compaction.compact(_provider(), "m1", 90002, _history())
    n1 = len(await _kind_rows("compaction"))
    await compaction.compact(_provider(), "m1", 90002, _history())
    assert calls["n"] == 1, "同一份转写第二次该走缓存，不再调模型"
    assert len(await _kind_rows("compaction")) == n1 == 1, "缓存命中不该多出账"


async def test_followups_notes_into_the_ledger(monkeypatch):
    from app.core import structured
    from app.models import ProviderConfig
    from app.routers import chat

    async def fake_extract_json(info, model, msgs, schema):  # noqa: ARG001
        ul.note(model, 20, 10)
        return SimpleNamespace(items=["q1", "q2", "q3"]), SimpleNamespace()

    monkeypatch.setattr(structured, "extract_json", fake_extract_json)
    await _clear("followups")
    resolved = chat.ResolvedModel(
        provider=ProviderConfig(name="stub", kind="openai", base_url=""), model="m1"
    )
    out = await chat._generate_followups(resolved, [{"role": "user", "content": "hi"}], "答案")
    assert out == ["q1", "q2", "q3"]
    rows = await _kind_rows("followups")
    assert len(rows) == 1 and rows[0].tokens_in == 20 and rows[0].tokens_out == 10


class _FakeStream:
    def __init__(self, chunks):
        self._chunks = chunks

    def __aiter__(self):
        return self._gen()

    async def _gen(self):
        for c in self._chunks:
            yield c

    async def close(self):
        pass


class _FakeClient:
    def __init__(self):
        self.captured = {}
        self.chat = SimpleNamespace(completions=SimpleNamespace(create=self._create))

    async def _create(self, **kwargs):
        self.captured.update(kwargs)
        return _FakeStream(
            [
                SimpleNamespace(
                    choices=[SimpleNamespace(delta=SimpleNamespace(content="hi"))], usage=None
                ),
                SimpleNamespace(
                    choices=[], usage=SimpleNamespace(prompt_tokens=11, completion_tokens=7)
                ),
            ]
        )

    async def close(self):
        pass


async def test_stream_chat_asks_for_usage_only_inside_a_span(monkeypatch):
    from app.core import llm

    client = _FakeClient()
    monkeypatch.setattr(llm, "_openai_client", lambda p: client)

    # span 外（旧行为）：没有 accumulator 就不向 provider 要 usage
    out = [d async for d in llm.stream_chat(_provider(), "m1", [{"role": "user", "content": "x"}])]
    assert out == ["hi"]
    assert "stream_options" not in client.captured

    # span 内：要 usage，回的 token 进账本对应 kind
    await _clear("probe")
    async with ul.span("probe"):
        out = [
            d async for d in llm.stream_chat(_provider(), "m1", [{"role": "user", "content": "x"}])
        ]
    assert out == ["hi"]
    assert client.captured.get("stream_options") == {"include_usage": True}
    rows = await _kind_rows("probe")
    assert len(rows) == 1 and rows[0].tokens_in == 11 and rows[0].tokens_out == 7
