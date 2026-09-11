"""研究引擎（学习闭环的中间两跳）的离线测试。

全部不打网络、不碰真实索引：`plan_queries` / `synthesize` 的模型调用走 `stream_fn`
注入，`gather` 的搜索 / 取正文 / 知识库三个口都注入假函数。真实链路由
`smoke_research.py` 验（真模型 + 真网络）。纯函数部分（清洗、截断、md、编号）直接测。
"""
import asyncio
from pathlib import Path

import pytest

from app.core import research

# ---------- 注入缝 ----------


def _llm(payload: str):
    """假 stream_fn：无论问什么都吐 payload（extract_json 走 L2 清洗路径）。"""

    async def _stream(info, model, messages):
        yield payload

    return _stream


def _llm_seq(payloads: list[str]):
    """按调用次序吐 payload 的假 stream_fn（plan → synthesize 各一次）。"""
    it = iter(payloads)

    async def _stream(info, model, messages):
        yield next(it)

    return _stream


@pytest.fixture
def wired(monkeypatch):
    """`_resolve` 永远成功——沙箱库里没有 provider，不然 plan/synthesize 直接返回空。"""

    async def fake_resolve(model_id=""):
        from app.core.llm import ProviderInfo

        return ProviderInfo(kind="openai", base_url="http://x", api_key="k"), "test-model"

    monkeypatch.setattr(research, "_resolve", fake_resolve)


async def _no_kb(query, top_k):
    return []


async def _no_search(query):
    return []


async def _no_fetch(url):
    return ""


async def _collect(gen) -> list[tuple[str, dict]]:
    return [ev async for ev in gen]


# ---------- 纯函数 ----------


def test_clean_queries_dedupes_caps_and_strips():
    out = research._clean_queries(["  A  ", "a", "B", "", "   ", "C", "D", "E"], "话题")
    assert out == ["A", "B", "C", "D"]  # 大小写去重 + 去空 + 上限 PLAN_MAX_QUERIES=4


def test_trim_total_drops_web_before_kb(monkeypatch):
    monkeypatch.setattr(research, "TOTAL_CHARS", 2500)
    srcs = [
        {"n": 1, "kind": "kb", "text": "a" * 1000},
        {"n": 2, "kind": "web", "text": "b" * 1000},
        {"n": 3, "kind": "web", "text": "c" * 1000},
        {"n": 4, "kind": "kb", "text": "d" * 1000},
    ]
    kept = research._trim_total(srcs)
    # 总量 4000 > 2500：先丢末尾的网络条（n=3）→ 3000，仍超 → 再丢 n=2 → 2000 达标。
    # 自己的材料（两条 kb）一条不丢。
    assert [s["kind"] for s in kept] == ["kb", "kb"]


def test_trim_total_under_budget_is_unchanged():
    srcs = [{"n": 1, "kind": "web", "text": "x" * 10}]
    assert research._trim_total(srcs) == srcs


def test_format_sources_labels_and_numbers():
    block = research._format_sources(
        [
            {"n": 1, "kind": "kb", "title": "笔记", "ref": "notes/a.md", "text": "T1"},
            {"n": 2, "kind": "web", "title": "网页", "ref": "https://x", "text": "T2"},
        ]
    )
    assert "[1]（知识库 · notes/a.md）笔记" in block
    assert "[2]（网络 · https://x）网页" in block


def test_slug_falls_back_when_nothing_usable():
    assert research._slug("!!!") == "research"
    assert research._slug("asyncio 事件循环") == "asyncio-事件循环"


# ---------- gather ----------


def test_gather_kb_first_dedupe_and_numbering():
    async def kb(query, top_k):
        return [
            {"source": "notes/a.md", "title": "A", "text": "内容A"},
            {"source": "notes/b.md", "title": "B", "text": "   "},  # 空文本 → 跳过
        ]

    async def search(q):
        return [
            {"title": f"T-{q}", "url": f"https://x/{q}"},
            {"title": "dup", "url": "https://x/dup"},  # 跨检索式重复 → 只留一次
        ]

    async def fetch(url):
        return f"正文 {url}"

    srcs = asyncio.run(research.gather("话题", ["q1", "q2"], kb_fn=kb, search_fn=search, fetch_fn=fetch))

    assert [s["n"] for s in srcs] == [1, 2, 3, 4]
    assert srcs[0]["kind"] == "kb" and srcs[0]["ref"] == "notes/a.md"  # 自己的材料排第一
    refs = [s["ref"] for s in srcs]
    assert refs == ["notes/a.md", "https://x/q1", "https://x/dup", "https://x/q2"]


def test_gather_caps_fetch_count():
    urls = [f"https://x/{i}" for i in range(10)]

    async def search(q):
        return [{"title": q, "url": u} for u in urls]

    async def fetch(url):
        return "正文"

    srcs = asyncio.run(research.gather("t", ["q"], kb_fn=_no_kb, search_fn=search, fetch_fn=fetch))
    assert len(srcs) == research.FETCH_MAX


def test_gather_skips_fetch_errors_and_empty_pages():
    async def search(q):
        return [
            {"title": "bad", "url": "https://x/bad"},
            {"title": "empty", "url": "https://x/empty"},
            {"title": "good", "url": "https://x/good"},
        ]

    async def fetch(url):
        if url.endswith("bad"):
            raise RuntimeError("打不开")
        if url.endswith("empty"):
            return "[错误] URL 必须以 http:// 或 https:// 开头"
        return "正文"

    srcs = asyncio.run(research.gather("t", ["q"], kb_fn=_no_kb, search_fn=search, fetch_fn=fetch))
    assert [s["ref"] for s in srcs] == ["https://x/good"]


def test_gather_survives_every_source_failing():
    async def boom(*_a, **_k):
        raise RuntimeError("挂了")

    srcs = asyncio.run(research.gather("t", ["q"], kb_fn=boom, search_fn=boom, fetch_fn=boom))
    assert srcs == []


# ---------- plan / synthesize ----------


def test_plan_queries_parses_and_cleans(wired):
    payload = '{"queries": ["  A  ", "a", "B", "", "C", "D", "E"]}'
    out = asyncio.run(research.plan_queries("话题", stream_fn=_llm(payload)))
    assert out == ["A", "B", "C", "D"]


def test_plan_queries_bad_json_returns_empty(wired):
    assert asyncio.run(research.plan_queries("话题", stream_fn=_llm("不好意思我不知道"))) == []


def test_plan_queries_empty_topic_short_circuits(wired):
    assert asyncio.run(research.plan_queries("   ")) == []


def test_synthesize_filters_used_and_drops_empty_sections(wired):
    payload = (
        '{"title":"T","sections":[{"heading":"H","body":"正文 [1]"},{"heading":"空","body":"  "}],'
        '"used":[1,9,"x"]}'
    )
    srcs = [{"n": 1, "kind": "kb", "title": "a", "ref": "r", "text": "t"}]
    rep = asyncio.run(research.synthesize("话题", srcs, stream_fn=_llm(payload)))
    assert rep is not None
    assert rep.title == "T"
    assert [s.heading for s in rep.sections] == ["H"]  # 空段落丢弃
    assert rep.used == [1]  # 幻觉编号 9 与非整数 "x" 都被过滤


def test_synthesize_none_without_sources(wired):
    assert asyncio.run(research.synthesize("t", [])) is None


# ---------- to_markdown / save ----------


def test_to_markdown_marks_used_sources():
    report = research.ResearchReport(
        title="标题",
        sections=[research.Section(heading="小节", body="正文 [1]")],
        used=[1],
    )
    srcs = [
        {"n": 1, "kind": "kb", "title": "笔记", "ref": "notes/a.md"},
        {"n": 2, "kind": "web", "title": "网页", "ref": "https://x"},
    ]
    md = research.to_markdown(report, srcs)
    assert md.startswith("# 标题")
    assert "## 小节" in md and "正文 [1]" in md  # [n] 原样保留
    assert "## 来源" in md
    assert "1. 笔记 — notes/a.md（知识库） ✓" in md  # 被引用的标 ✓
    assert "2. 网页 — https://x（网络）" in md
    assert "2. 网页 — https://x（网络） ✓" not in md


def test_save_writes_vault_and_indexes(monkeypatch):
    seen: list[Path] = []

    def fake_index(path, **kw):
        seen.append(Path(path))
        return 4

    monkeypatch.setattr("app.core.indexer.index_file", fake_index)

    report = research.ResearchReport(
        title="测试研究", sections=[research.Section(heading="H", body="B [1]")], used=[1]
    )
    srcs = [{"n": 1, "kind": "kb", "title": "笔记", "ref": "notes/a.md", "text": "x"}]
    out = asyncio.run(research.save(report, srcs))

    assert out["chunks"] == 4
    assert out["filename"].startswith("research/") and out["filename"].endswith(".md")
    dest = research.VAULT_DIR / out["filename"]
    assert dest.exists()
    assert "测试研究" in dest.read_text(encoding="utf-8")
    assert seen == [dest]  # 落盘之后确实进了索引——「下次先捞你自己的」靠这一步


# ---------- run（完整生成器） ----------


def _run(topic, **kw):
    async def _go():
        return await _collect(research.run(topic, **kw))

    return asyncio.run(_go())


def test_run_rejects_empty_topic(wired):
    assert _run("   ") == [("error", {"message": "话题不能为空"})]


def test_run_errors_without_provider(wired, monkeypatch):
    monkeypatch.setattr("app.core.providers.default_model_id", lambda: "")
    events = _run("话题")
    assert [e for e, _ in events] == ["error"]
    assert "provider" in events[0][1]["message"]


def test_run_errors_when_no_material(wired, monkeypatch):
    monkeypatch.setattr("app.core.providers.default_model_id", lambda: "test-model")
    events = _run(
        "话题",
        kb_fn=_no_kb,
        search_fn=_no_search,
        fetch_fn=_no_fetch,
        stream_fn=_llm('{"queries":["q1"]}'),
    )
    assert [e for e, _ in events] == ["plan", "gathering", "error"]


def test_run_happy_path(wired, monkeypatch):
    monkeypatch.setattr("app.core.providers.default_model_id", lambda: "test-model")

    async def kb(query, top_k):
        return [{"source": "notes/a.md", "title": "A", "text": "内容A"}]

    async def search(q):
        return [{"title": "网页", "url": "https://x/1"}]

    async def fetch(url):
        return "正文"

    stream = _llm_seq(
        [
            '{"queries":["q1","q2"]}',
            '{"title":"R","sections":[{"heading":"H","body":"B [1]"}],"used":[1]}',
        ]
    )
    events = _run("话题", kb_fn=kb, search_fn=search, fetch_fn=fetch, stream_fn=stream)

    kinds = [e for e, _ in events]
    # 流式：正文边生成边发 draft；滤掉它之后仍是原来的五步，且 draft 必在 report 之前
    assert [k for k in kinds if k != "draft"] == ["plan", "gathering", "sources", "writing", "report"]
    assert kinds.index("draft") < kinds.index("report")

    by_event = dict(events)
    plan = by_event["plan"]
    assert plan["queries"] == ["q1", "q2"]
    sources = by_event["sources"]
    assert sources["kb"] == 1 and len(sources["sources"]) == 2
    assert set(sources["sources"][0]) == {"n", "kind", "title", "ref"}  # 不带正文
    report = by_event["report"]
    assert report["title"] == "R"
    assert report["used"] == [1]
    assert report["model_id"] == "test-model"
    # 质量闭环的 join key：事件必须带上「这版提示词」的指纹，否则反馈没法按版本统计
    from app.core import report as report_mod

    assert report["prompt_sha"] == report_mod.prompt_sha(research._SYNTH_PROMPT)
