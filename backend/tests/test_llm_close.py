"""流式中断的取消传播（PLAN.md 第 7 节台账）：调用方取消时，上游 HTTP 流必须
被显式关闭——没有 finally close，页面 abort 后底层响应要等 GC 兜底，上游继续
烧完整个回复。anthropic 分支靠 `async with` 已是确定性关闭，这里钉 openai 分支。
"""
import sys
from types import SimpleNamespace

sys.path.insert(0, ".")

from app.core.llm import ProviderInfo, stream_chat  # noqa: E402


class _FakeStream:
    def __init__(self, chunks: list):
        self.chunks = list(chunks)
        self.closed = False

    def __aiter__(self):
        return self

    async def __anext__(self):
        if not self.chunks:
            raise StopAsyncIteration
        return self.chunks.pop(0)

    async def close(self):
        self.closed = True


class _FakeClient:
    def __init__(self, stream: _FakeStream):
        self.chat = SimpleNamespace(
            completions=SimpleNamespace(create=self._create)
        )
        self._stream = stream
        self.closed = False

    async def _create(self, **kwargs):
        return self._stream

    async def close(self):
        self.closed = True


def _chunk(text: str):
    return SimpleNamespace(
        choices=[SimpleNamespace(delta=SimpleNamespace(content=text))], usage=None
    )


def _patch_client(monkeypatch, stream: _FakeStream) -> None:
    import app.core.llm as llm

    monkeypatch.setattr(llm, "_openai_client", lambda p: _FakeClient(stream))


async def test_cancel_consuming_closes_the_upstream_stream(monkeypatch):
    stream = _FakeStream([_chunk("你"), _chunk("好"), _chunk("！")])
    _patch_client(monkeypatch, stream)
    info = ProviderInfo(kind="openai", base_url="", api_key="k")

    gen = stream_chat(info, "m", [{"role": "user", "content": "hi"}])
    assert await gen.__anext__() == "你"  # 只读一个 delta 就走人
    await gen.aclose()  # ← 页面 abort / 断连到达这里

    assert stream.closed is True, "生成器被关闭时必须立即关掉上游流"


async def test_full_consume_also_closes(monkeypatch):
    stream = _FakeStream([_chunk("a"), _chunk("b")])
    _patch_client(monkeypatch, stream)
    info = ProviderInfo(kind="openai", base_url="", api_key="k")

    out = [c async for c in stream_chat(info, "m", [{"role": "user", "content": "hi"}])]
    assert out == ["a", "b"]
    assert stream.closed is True  # 正常读完也关，不靠 GC
