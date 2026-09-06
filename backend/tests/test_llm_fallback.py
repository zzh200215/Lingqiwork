"""stream_chat_fallback（maple-os 参考项 2：降级链的迷你版）。

只钉两条纪律：零输出才允许换下一家（连不上、坏 key 这类建连期失败才值得
救）；文本一旦开始流动就不再换——中途换源会把已经发给用户的半句话重复或
弄串。`app.core.llm.stream_chat` 被 monkeypatch，不碰任何网络。
"""
import sys

sys.path.insert(0, ".")

import pytest  # noqa: E402

from app.core.llm import ProviderInfo, stream_chat_fallback  # noqa: E402


def _info(name: str) -> ProviderInfo:
    return ProviderInfo(kind="openai", base_url=f"https://{name}.example", api_key=name)


def _cands(*names: str):
    return [(_info(n), "m", f"{n}/m") for n in names]


async def _collect(agen) -> list:
    return [c async for c in agen]


async def test_switches_to_next_candidate_when_first_fails_before_output(monkeypatch):
    import app.core.llm as llm

    tried: list[str] = []

    async def fake_stream(info, model, messages, usage=None):
        tried.append(info.api_key)
        if info.api_key == "dead":
            raise ConnectionError("connection refused")
        for c in ("a", "b"):
            yield c

    monkeypatch.setattr(llm, "stream_chat", fake_stream)
    served: dict = {}
    got = await _collect(
        stream_chat_fallback(
            _cands("dead", "live"), [{"role": "user", "content": "x"}], served=served
        )
    )
    assert got == ["a", "b"]
    assert tried == ["dead", "live"]
    assert served == {"label": "live/m"}


async def test_never_switches_after_output_started(monkeypatch):
    import app.core.llm as llm

    tried: list[str] = []

    async def fake_stream(info, model, messages, usage=None):
        tried.append(info.api_key)
        yield "半句"
        raise RuntimeError("流中断")

    monkeypatch.setattr(llm, "stream_chat", fake_stream)
    with pytest.raises(RuntimeError, match="流中断"):
        await _collect(stream_chat_fallback(_cands("a", "b"), [{"role": "user", "content": "x"}]))
    assert tried == ["a"]  # 第二家没有被尝试


async def test_all_candidates_failing_raises_the_last_error(monkeypatch):
    import app.core.llm as llm

    async def fake_stream(info, model, messages, usage=None):
        raise ConnectionError(f"{info.api_key} 挂了")
        yield ""  # noqa: unreachable — 只为把函数变成 async generator

    monkeypatch.setattr(llm, "stream_chat", fake_stream)
    with pytest.raises(ConnectionError, match="c 挂了"):
        await _collect(stream_chat_fallback(_cands("a", "b", "c"), [{"role": "user", "content": "x"}]))


async def test_usage_accumulates_across_the_serving_candidate(monkeypatch):
    import app.core.llm as llm

    async def fake_stream(info, model, messages, usage=None):
        if usage is not None and info.api_key == "live":
            usage["input"] = usage.get("input", 0) + 7
        if info.api_key == "dead":
            raise ConnectionError("down")
        yield "ok"

    monkeypatch.setattr(llm, "stream_chat", fake_stream)
    usage: dict = {}
    got = await _collect(
        stream_chat_fallback(_cands("dead", "live"), [{"role": "user", "content": "x"}], usage=usage)
    )
    assert got == ["ok"] and usage == {"input": 7}
