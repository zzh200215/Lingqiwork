"""流式成文（`report.synthesize_streaming`）的离线测试。

它和 `synthesize` 的分工：**流式那遍不承担正确性**——画面早一点动起来是它唯一的活；
解析不了、上游炸了，都得原样退回 `synthesize` 的老路（含原生结构化）。所以这里重点
钉两件事：① draft 是**渐进**的、正文半截也留着；② 失败时**必须**还能拿到完整报告。
"""
import asyncio

from app.core import report as R
from app.core.llm import ProviderInfo

SOURCES = [
    {"n": 1, "kind": "kb", "title": "A", "ref": "notes/a.md", "text": "内容A"},
    {"n": 2, "kind": "web", "title": "B", "ref": "https://x/1", "text": "内容B"},
]

PAYLOAD = (
    '{"title":"R","sections":['
    '{"heading":"H1","body":"第一段正文 [1]"},'
    '{"heading":"H2","body":"第二段正文 [2]"}],"used":[1,2]}'
)


async def _resolve_ok(model_id=""):
    return ProviderInfo(kind="openai", base_url="http://x", api_key="k"), "test-model"


async def _resolve_none(model_id=""):
    return None


def _chunked(payload: str, size: int = 12):
    """把 payload 切成小段吐出来——模拟真实流式，也让 draft 能发好几次。"""

    async def _stream(info, model, messages):
        for i in range(0, len(payload), size):
            yield payload[i : i + size]

    return _stream


def _collect(gen):
    async def _go():
        return [ev async for ev in gen]

    return asyncio.run(_go())


def _run(topic="话题", sources=SOURCES, **kw):
    return _collect(
        R.synthesize_streaming(topic, sources, "SYS", "test-model", resolve_fn=_resolve_ok, **kw)
    )


# ---------- draft ----------


def test_streaming_emits_progressive_drafts():
    events = _run(stream_fn=_chunked(PAYLOAD))
    drafts = [p for e, p in events if e == "draft"]
    assert len(drafts) >= 2, "切这么碎只发了一帧，说明没有边收边发"

    # 单调：后面的 draft 不会比前面的短
    sizes = [len(d["title"]) + sum(len(s["heading"]) + len(s["body"]) for s in d["sections"]) for d in drafts]
    assert sizes == sorted(sizes)

    # 到最后一帧时两节都齐了
    assert [s["heading"] for s in drafts[-1]["sections"]] == ["H1", "H2"]
    assert events[-1][0] == "done"


def test_streaming_keeps_partial_body():
    """正文写到一半也要发出去——那一截正是用户想看的。"""
    events = _run(stream_fn=_chunked(PAYLOAD, size=8))
    last = [p for e, p in events if e == "draft"][-1]
    assert last["sections"], "最后一帧该有内容"
    assert last["title"] == "R"


def test_draft_payload_only_carries_title_and_sections():
    """draft 是渲染用的近似，别把 used/sources 这种只有最终产物才准的东西一起发。"""
    drafts = [p for e, p in _run(stream_fn=_chunked(PAYLOAD)) if e == "draft"]
    assert drafts
    for d in drafts:
        assert set(d) == {"title", "sections"}
        # 没有小节的帧不该发：只有一个半截标题，渲染出来是「闪一下」，没有信息量
        assert d["sections"], "发了一帧没有任何小节的 draft"
        for s in d["sections"]:
            assert set(s) == {"heading", "body"}


# ---------- 最终产物 ----------


def test_streaming_result_matches_non_streaming():
    """两条路的产物必须一模一样——否则「看的时候」和「存下来」的是两份东西。"""
    streamed = dict(_run(stream_fn=_chunked(PAYLOAD)))["done"]
    plain = asyncio.run(
        R.synthesize("话题", SOURCES, "SYS", "test-model", stream_fn=_chunked(PAYLOAD), resolve_fn=_resolve_ok)
    )
    assert streamed is not None and plain is not None
    assert R.to_markdown(streamed, SOURCES) == R.to_markdown(plain, SOURCES)
    assert streamed.used == [1, 2]


def test_streaming_filters_citations_outside_sources():
    payload = '{"title":"R","sections":[{"heading":"H","body":"[1] 和 [9]"}],"used":[1,9]}'
    rep = dict(_run(stream_fn=_chunked(payload)))["done"]
    assert rep.used == [1]  # [9] 不在材料里，丢掉


# ---------- 兜底 ----------


def test_streaming_falls_back_when_streamed_text_is_unparsable():
    """流式那遍拿到的不是 JSON 时，必须还能退回老路拿到完整报告。"""
    calls = {"n": 0}

    async def _flaky(info, model, messages):
        calls["n"] += 1
        if calls["n"] == 1:
            yield "抱歉，我先说说我的想法……"  # 没有 JSON
            return
        yield PAYLOAD

    rep = dict(_run(stream_fn=_flaky))["done"]
    assert rep is not None and rep.title == "R"
    assert calls["n"] == 2, "流式失败后应当再走一次非流式，而不是直接放弃"


def test_streaming_falls_back_when_upstream_raises():
    calls = {"n": 0}

    async def _flaky(info, model, messages):
        calls["n"] += 1
        if calls["n"] == 1:
            raise ConnectionError("上游断了")
        yield PAYLOAD

    rep = dict(_run(stream_fn=_flaky))["done"]
    assert rep is not None and calls["n"] == 2


def test_streaming_emits_no_draft_on_the_fallback_path():
    """退回非流式时不发 draft——那是「这一遍没在流」的诚实表现，别假装在流。"""
    calls = {"n": 0}

    async def _flaky(info, model, messages):
        calls["n"] += 1
        if calls["n"] == 1:
            yield "没有 JSON"
            return
        yield PAYLOAD

    events = _run(stream_fn=_flaky)
    assert [e for e, _ in events] == ["done"]


# ---------- 边界 ----------


def test_streaming_without_sources_is_none():
    assert _run(sources=[]) == [("done", None)]


def test_streaming_without_provider_is_none():
    events = _collect(
        R.synthesize_streaming("话题", SOURCES, "SYS", "", resolve_fn=_resolve_none)
    )
    assert events == [("done", None)]


def test_partial_sections_ignores_junk():
    assert R.partial_sections(None) == {"title": "", "sections": []}
    assert R.partial_sections({"title": 1, "sections": ["x", {"heading": "H"}]}) == {
        "title": "1",
        "sections": [{"heading": "H", "body": ""}],
    }
