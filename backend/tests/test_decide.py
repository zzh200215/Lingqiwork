"""方案引擎（拿不准的事，理清楚再出方案）的离线测试。

全部不打网络、不碰真实索引也不碰真实记忆库：读题与成文两次模型调用都走 `stream_fn`
注入（按调用次序消耗脚本），`gather` 的三路（知识库 / 长期记忆 / 网络）都注入假函数。
真实链路由 `smoke_decide.py` 验（真模型 + 真索引）。
"""
import asyncio
from pathlib import Path

import pytest

from app.core import decide

# ---------- 注入缝 ----------

FRAME_JSON = (
    '{"decision":"选哪个向量库","options":["Chroma","Qdrant","pgvector"],'
    '"criteria":["部署成本","检索质量"],"queries":["本地向量库 选型","Qdrant 运维成本"]}'
)
REPORT_JSON = '{"title":"方案","sections":[{"heading":"到底在决定什么","body":"B [1]"}],"used":[1]}'


def _llm_seq(*payloads):
    """假 stream_fn：按调用次序吐 payload（耗尽后重复最后一个）。

    方案这条链路有**两次**模型调用（先读题、后成文），用同一个 payload 会串味——
    所以这里必须能按次序给不同脚本。
    """
    calls = {"n": 0}

    async def _stream(info, model, messages):
        i = min(calls["n"], len(payloads) - 1)
        calls["n"] += 1
        yield payloads[i]

    return _stream


@pytest.fixture
def wired(monkeypatch):
    """`_resolve` 永远成功——沙箱库里没有 provider，不然两次调用都直接返回空。"""

    async def fake_resolve(model_id=""):
        from app.core.llm import ProviderInfo

        return ProviderInfo(kind="openai", base_url="http://x", api_key="k"), "test-model"

    monkeypatch.setattr(decide, "_resolve", fake_resolve)


async def _no_kb(query, top_k):
    return []


async def _no_memory(query):
    return ""


async def _no_search(query):
    return []


async def _no_fetch(url):
    return ""


async def _collect(gen) -> list[tuple[str, dict]]:
    return [ev async for ev in gen]


def _run(topic, **kw):
    async def _go():
        return await _collect(decide.run(topic, **kw))

    return asyncio.run(_go())


# ---------- _clean_list ----------


def test_clean_list_dedupes_caps_and_strips():
    raw = ["  A  B ", "a b", "", "C", "D", "E"]
    assert decide._clean_list(raw, cap=3) == ["A B", "C", "D"]


def test_clean_list_truncates_width():
    assert decide._clean_list(["x" * 100], cap=1, width=10) == ["x" * 10]


# ---------- frame（读题） ----------


def test_frame_reads_and_cleans(wired):
    frame = asyncio.run(
        decide.frame_decision("本地向量库怎么选", stream_fn=_llm_seq(FRAME_JSON))
    )
    assert frame is not None
    assert frame.decision == "选哪个向量库"
    assert frame.options == ["Chroma", "Qdrant", "pgvector"]
    assert frame.criteria == ["部署成本", "检索质量"]
    assert frame.queries == ["本地向量库 选型", "Qdrant 运维成本"]


def test_frame_caps_runaway_options(wired):
    payload = '{"decision":"d","options":["1","2","3","4","5","6","7"]}'
    frame = asyncio.run(decide.frame_decision("t", stream_fn=_llm_seq(payload)))
    assert len(frame.options) == decide.OPTIONS_MAX


def test_frame_returns_none_without_model(monkeypatch):
    async def no_resolve(model_id=""):
        return None

    monkeypatch.setattr(decide, "_resolve", no_resolve)
    assert asyncio.run(decide.frame_decision("t", stream_fn=_llm_seq(FRAME_JSON))) is None


def test_frame_returns_none_on_empty_topic(wired):
    assert asyncio.run(decide.frame_decision("   ", stream_fn=_llm_seq(FRAME_JSON))) is None


# ---------- gather ----------


def test_gather_orders_kb_then_memory_then_web():
    async def kb(query, top_k):
        return [
            {"source": "notes/a.md", "title": "A", "text": "内容A"},
            {"source": "notes/b.md", "title": "B", "text": "   "},  # 空文本 → 跳过
        ]

    async def memory(query):
        return "偏好：宁可多点运维也不想被云厂商绑住"

    async def search(query):
        return [{"title": "T", "url": "https://e.com/1"}]

    async def fetch(url):
        return "正文"

    srcs = asyncio.run(
        decide.gather(
            "选哪个", ["q1"], kb_fn=kb, memory_fn=memory, search_fn=search, fetch_fn=fetch
        )
    )

    assert [s["n"] for s in srcs] == [1, 2, 3]
    assert [s["kind"] for s in srcs] == ["kb", "memory", "web"]
    assert srcs[0]["ref"] == "notes/a.md"  # 自己的材料排第一
    assert "宁可多点运维" in srcs[1]["text"]
    assert srcs[2]["ref"] == "https://e.com/1"


def test_gather_dedupes_web_and_skips_unreadable():
    async def search(query):
        return [
            {"title": "T1", "url": "https://e.com/1"},
            {"title": "T1 重复", "url": "https://e.com/1"},  # 同一 URL → 只取一次
            {"title": "空", "url": ""},  # 没 URL → 跳过
            {"title": "T2", "url": "https://e.com/2"},
        ]

    async def fetch(url):
        return "" if url.endswith("/2") else "正文"

    srcs = asyncio.run(
        decide.gather(
            "d", [], kb_fn=_no_kb, memory_fn=_no_memory, search_fn=search, fetch_fn=fetch
        )
    )
    assert [s["ref"] for s in srcs] == ["https://e.com/1"]


def test_gather_drops_error_page_bodies():
    async def search(query):
        return [{"title": "T", "url": "https://e.com/x"}]

    async def fetch(url):
        return "[错误] 打不开"

    srcs = asyncio.run(
        decide.gather(
            "d", [], kb_fn=_no_kb, memory_fn=_no_memory, search_fn=search, fetch_fn=fetch
        )
    )
    assert srcs == []


def test_gather_survives_any_single_leg_failing():
    async def boom(*_a, **_k):
        raise RuntimeError("挂了")

    async def kb(query, top_k):
        return [{"source": "notes/a.md", "title": "A", "text": "内容A"}]

    # 只有知识库活着——记忆与网络全挂，照常出一条材料
    srcs = asyncio.run(
        decide.gather(
            "d", ["q"], kb_fn=kb, memory_fn=boom, search_fn=boom, fetch_fn=boom
        )
    )
    assert [s["kind"] for s in srcs] == ["kb"]


def test_gather_returns_empty_when_every_leg_fails():
    async def boom(*_a, **_k):
        raise RuntimeError("挂了")

    srcs = asyncio.run(
        decide.gather("d", [], kb_fn=boom, memory_fn=boom, search_fn=boom, fetch_fn=boom)
    )
    assert srcs == []


def test_gather_falls_back_to_decision_when_no_queries():
    seen: list[str] = []

    async def search(query):
        seen.append(query)
        return []

    asyncio.run(
        decide.gather(
            "选哪个", [], kb_fn=_no_kb, memory_fn=_no_memory, search_fn=search, fetch_fn=_no_fetch
        )
    )
    assert seen == ["选哪个"]  # 没有检索式时至少拿决策本身去搜


# ---------- save ----------


def test_save_writes_vault_decisions_and_indexes(monkeypatch):
    seen: list[Path] = []

    def fake_index(path, **kw):
        seen.append(Path(path))
        return 3

    monkeypatch.setattr("app.core.indexer.index_file", fake_index)

    rep = decide.Report(
        title="向量库选型", sections=[decide.Section(heading="H", body="B [1]")], used=[1]
    )
    srcs = [{"n": 1, "kind": "kb", "title": "笔记", "ref": "notes/a.md", "text": "x"}]
    out = asyncio.run(decide.save(rep, srcs))

    assert out["chunks"] == 3
    assert out["filename"].startswith("decisions/") and out["filename"].endswith(".md")
    dest = decide.DECISIONS_DIR / Path(out["filename"]).name
    assert dest.exists()
    assert "向量库选型" in dest.read_text(encoding="utf-8")
    assert seen == [dest]  # 落盘之后确实进了索引——「上次我是怎么权衡的」靠这一步


# ---------- run（完整生成器） ----------


def test_run_rejects_empty_topic(wired):
    assert _run("   ") == [("error", {"message": "话题不能为空"})]


def test_run_errors_without_provider(wired, monkeypatch):
    monkeypatch.setattr("app.core.providers.default_model_id", lambda: "")
    events = _run("话题")
    assert [e for e, _ in events] == ["error"]
    assert "provider" in events[0][1]["message"]


def test_run_emits_frame_before_gathering(wired, monkeypatch):
    """`frame` 是这一条独有的、**给人看的**事件：读错题是第一位失败模式。"""
    monkeypatch.setattr("app.core.providers.default_model_id", lambda: "test-model")

    async def kb(query, top_k):
        return [{"source": "notes/a.md", "title": "A", "text": "内容A"}]

    events = _run(
        "本地向量库怎么选",
        kb_fn=kb,
        memory_fn=_no_memory,
        search_fn=_no_search,
        fetch_fn=_no_fetch,
        stream_fn=_llm_seq(FRAME_JSON, REPORT_JSON),
    )
    kinds = [e for e, _ in events]
    kinds = [e for e, _ in events]
    # 流式：正文边生成边发 draft；滤掉它之后仍是原来的六步，且 draft 必在 report 之前
    assert [k for k in kinds if k != "draft"] == [
        "framing", "frame", "gathering", "sources", "writing", "report",
    ]
    assert kinds.index("draft") < kinds.index("report")
    assert kinds.index("frame") < kinds.index("gathering")  # 先摆题，再去取材料

    frame = dict(events)["frame"]
    assert frame["decision"] == "选哪个向量库"
    assert frame["options"] == ["Chroma", "Qdrant", "pgvector"]
    assert frame["criteria"] == ["部署成本", "检索质量"]


def test_run_falls_back_to_topic_when_frame_fails(wired, monkeypatch):
    """读题挂了不该毁掉整次运行：退回把话题本身当决策，检索式退回话题。"""
    monkeypatch.setattr("app.core.providers.default_model_id", lambda: "test-model")
    payload = '{"decision":"d","options":[]}'

    async def kb(query, top_k):
        return [{"source": "notes/a.md", "title": "A", "text": "内容A"}]

    async def failing_resolve(model_id=""):
        return None

    monkeypatch.setattr(decide, "_resolve", failing_resolve)
    events = _run(
        "要不要上微调",
        kb_fn=kb,
        memory_fn=_no_memory,
        search_fn=_no_search,
        fetch_fn=_no_fetch,
        stream_fn=_llm_seq(payload),
    )
    frame = dict(events)["frame"]
    assert frame["decision"] == "要不要上微调"
    assert frame["options"] == []


def test_run_errors_when_no_material(wired, monkeypatch):
    monkeypatch.setattr("app.core.providers.default_model_id", lambda: "test-model")
    events = _run(
        "话题",
        kb_fn=_no_kb,
        memory_fn=_no_memory,
        search_fn=_no_search,
        fetch_fn=_no_fetch,
        stream_fn=_llm_seq(FRAME_JSON, REPORT_JSON),
    )
    assert [e for e, _ in events] == ["framing", "frame", "gathering", "error"]


def test_run_happy_path(wired, monkeypatch):
    monkeypatch.setattr("app.core.providers.default_model_id", lambda: "test-model")

    async def kb(query, top_k):
        return [{"source": "notes/a.md", "title": "A", "text": "内容A"}]

    async def memory(query):
        return "偏好：数据要留在本机"

    async def search(query):
        return [{"title": "T", "url": "https://e.com/1"}]

    async def fetch(url):
        return "正文"

    events = _run(
        "本地向量库怎么选",
        kb_fn=kb,
        memory_fn=memory,
        search_fn=search,
        fetch_fn=fetch,
        stream_fn=_llm_seq(FRAME_JSON, REPORT_JSON),
    )
    kinds = [e for e, _ in events]
    assert [k for k in kinds if k != "draft"] == [
        "framing", "frame", "gathering", "sources", "writing", "report",
    ]

    sources = dict(events)["sources"]
    assert sources["kb"] == 1 and sources["web"] == 1
    assert set(sources["sources"][0]) == {"n", "kind", "title", "ref"}  # 不带正文

    report = dict(events)["report"]
    assert report["title"] == "方案"
    assert report["used"] == [1]
    assert report["model_id"] == "test-model"
    assert report["frame"]["decision"] == "选哪个向量库"  # 题面随报告一起回前端
    # 质量闭环的 join key：事件必须带上「这版提示词」的指纹，否则反馈没法按版本统计
    from app.core import report as report_mod

    assert report["prompt_sha"] == report_mod.prompt_sha(decide._SYNTH_PROMPT)
