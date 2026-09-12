"""对质引擎（跨源冲突检测）的离线测试。

全部不打网络、不碰真实索引也不碰真实记忆库：读题 / 冲突扫描 / 成文三次模型调用都走
`stream_fn` 注入（按调用次序消耗脚本），`gather` 的三路（知识库 / 长期记忆 / 外部）
都注入假函数。真实链路由 `smoke_conflict.py` 验（真模型 + 真索引）。

这个引擎独有的两件事，各自被钉住：
1. `finding` 必须在 `sources` 之后、`writing` 之前——它是「先扫出哪两处对不上，再决定
   要不要写」的那一步。
2. 扫出来是**真空**时**不再调用成文**（省掉的正是最长的那次生成）。这条靠数模型调用次数
   来钉，而不是靠看事件名——事件对了但背后多烧一次调用，是看不到的。
"""
import asyncio
from pathlib import Path

import pytest

from app.core import conflict

# ---------- 注入缝 ----------

FRAME_JSON = (
    '{"subject":"await 把控制权交给了谁","queries":["await 事件循环 调度","协程 恢复 调用方"]}'
)
SCAN_JSON = '{"pairs":[{"a_n":1,"b_n":3,"basis":"一边说调用方恢复，一边说事件循环恢复"}]}'
SCAN_EMPTY = '{"pairs":[]}'
REPORT_JSON = (
    '{"title":"对质","sections":[{"heading":"笔记 vs 文档","body":"你写的是 X [1]，文档写的是 Y [3]"}],'
    '"used":[1,3]}'
)


def _llm_seq(*payloads):
    """假 stream_fn：按调用次序吐 payload，并把每次收到的 messages 记下来。

    `calls` 挂在函数上，所以测试既能验「调了几次」（零冲突那条），也能验「喂进去的
    材料里有没有那一段已确认的冲突对」。
    """
    calls: list[list[dict]] = []

    async def _stream(info, model, messages):
        calls.append(list(messages))
        i = min(len(calls) - 1, len(payloads) - 1)
        yield payloads[i]

    _stream.calls = calls  # type: ignore[attr-defined]
    return _stream


@pytest.fixture
def wired(monkeypatch):
    """`_resolve` 永远成功——沙箱库里没有 provider，不然每次调用都直接返回空。"""

    async def fake_resolve(model_id=""):
        from app.core.llm import ProviderInfo

        return ProviderInfo(kind="openai", base_url="http://x", api_key="k"), "test-model"

    monkeypatch.setattr(conflict, "_resolve", fake_resolve)


async def _no_kb(query, top_k):
    return []


async def _no_memory(query):
    return ""


async def _no_search(query):
    return []


async def _no_fetch(url):
    return ""


async def _kb(query, top_k):
    return [{"source": "notes/a.md", "title": "A", "text": "内容A"}]


def _collect(gen) -> list[tuple[str, dict]]:
    async def _go():
        return [ev async for ev in gen]

    return asyncio.run(_go())


def _run(topic, **kw):
    return _collect(conflict.run(topic, **kw))


def _kinds(events) -> list[str]:
    return [k for k, _ in events if k != "draft"]


def _srcs(*specs) -> list[dict]:
    return [
        {"n": i, "kind": k, "title": t, "ref": f"ref{i}", "text": "正文"}
        for i, (k, t) in enumerate(specs, 1)
    ]


# ---------- clean_pairs（纯函数） ----------


def test_clean_pairs_normalizes_bounds_and_dedupes():
    raw = [
        conflict.ConflictPair(a_n=3, b_n=1, basis=" A  B "),  # 归一成 1<3
        conflict.ConflictPair(a_n=1, b_n=3, basis="重复"),  # 同一对 → 去掉
        conflict.ConflictPair(a_n=2, b_n=2, basis="自环"),  # 自环 → 去掉
        conflict.ConflictPair(a_n=9, b_n=1, basis="越界"),  # 编号不在材料里 → 去掉
    ]
    out = conflict.clean_pairs(raw, {1, 2, 3})
    assert out == [{"a_n": 1, "b_n": 3, "basis": "A B"}]


def test_clean_pairs_caps_the_list():
    raw = [conflict.ConflictPair(a_n=i, b_n=i + 1, basis="x") for i in range(1, 9)]
    assert len(conflict.clean_pairs(raw, set(range(1, 12)), cap=4)) == conflict.PAIRS_MAX


def test_clean_list_strips_dedupes_and_caps():
    assert conflict._clean_list(["  A  B ", "a b", "", "C", "D"], cap=3) == ["A B", "C", "D"]


# ---------- frame（读题） ----------


def test_frame_reads_and_cleans(wired):
    frame = asyncio.run(
        conflict.frame_confrontation("await 把控制权交给谁", stream_fn=_llm_seq(FRAME_JSON))
    )
    assert frame is not None
    assert frame.subject == "await 把控制权交给了谁"
    assert frame.queries == ["await 事件循环 调度", "协程 恢复 调用方"]


def test_frame_caps_runaway_queries(wired):
    payload = '{"subject":"s","queries":["1","2","3","4","5","6"]}'
    frame = asyncio.run(conflict.frame_confrontation("t", stream_fn=_llm_seq(payload)))
    assert len(frame.queries) == conflict.QUERIES_MAX


def test_frame_accepts_a_newline_separated_string(wired):
    payload = '{"subject":"s","queries":"q1\\nq2"}'
    frame = asyncio.run(conflict.frame_confrontation("t", stream_fn=_llm_seq(payload)))
    assert frame.queries == ["q1", "q2"]


def test_frame_returns_none_without_model(monkeypatch):
    async def no_resolve(model_id=""):
        return None

    monkeypatch.setattr(conflict, "_resolve", no_resolve)
    assert asyncio.run(conflict.frame_confrontation("t", stream_fn=_llm_seq(FRAME_JSON))) is None


def test_frame_returns_none_on_empty_topic(wired):
    assert asyncio.run(conflict.frame_confrontation("   ", stream_fn=_llm_seq(FRAME_JSON))) is None


# ---------- gather ----------


def test_gather_orders_own_material_then_memory_then_external():
    async def kb(query, top_k):
        return [
            {"source": "notes/a.md", "title": "A", "text": "内容A"},
            {"source": "notes/b.md", "title": "B", "text": "   "},  # 空文本 → 跳过
        ]

    async def memory(query):
        return "事实：上次我把库换了"

    async def search(query):
        return [{"title": "T", "url": "https://e.com/1"}]

    async def fetch(url):
        return "外部正文"

    srcs = asyncio.run(
        conflict.gather(
            "比什么", ["q1"], kb_fn=kb, memory_fn=memory, search_fn=search, fetch_fn=fetch
        )
    )
    assert [s["n"] for s in srcs] == [1, 2, 3]
    assert [s["kind"] for s in srcs] == ["kb", "memory", "web"]
    assert srcs[0]["ref"] == "notes/a.md"  # 自己的材料排第一：对质的一侧常常就在这


def test_gather_dedupes_web_and_skips_unreadable():
    async def search(query):
        return [
            {"title": "T1", "url": "https://e.com/1"},
            {"title": "重复", "url": "https://e.com/1"},
            {"title": "没 URL", "url": ""},
            {"title": "打不开", "url": "https://e.com/2"},
        ]

    async def fetch(url):
        return "[错误] 打不开"

    srcs = asyncio.run(
        conflict.gather("d", [], kb_fn=_no_kb, memory_fn=_no_memory, search_fn=search, fetch_fn=fetch)
    )
    assert srcs == []


def test_gather_survives_any_single_leg_failing():
    async def boom(*_a, **_k):
        raise RuntimeError("挂了")

    srcs = asyncio.run(conflict.gather("d", ["q"], kb_fn=_kb, memory_fn=boom, search_fn=boom, fetch_fn=boom))
    assert [s["kind"] for s in srcs] == ["kb"]


def test_gather_searches_the_subject_when_no_queries():
    seen: list[str] = []

    async def search(query):
        seen.append(query)
        return []

    asyncio.run(
        conflict.gather("比什么", [], kb_fn=_no_kb, memory_fn=_no_memory, search_fn=search, fetch_fn=_no_fetch)
    )
    assert seen == ["比什么"]  # 没有检索式时至少拿主题本身去搜


# ---------- find（冲突扫描） ----------


def test_find_returns_empty_list_when_material_agrees(wired):
    """`[]` 是**正常结果**：扫描跑成了，材料里确实没有对不上的。"""
    out = asyncio.run(
        conflict.find_conflicts("s", _srcs(("kb", "A"), ("web", "B")), stream_fn=_llm_seq(SCAN_EMPTY))
    )
    assert out == []


def test_find_returns_none_when_scan_cannot_run(monkeypatch):
    """`None` ≠ `[]`：判分没跑成时调用方必须继续成文，不能谎报「没有冲突」。"""

    async def no_resolve(model_id=""):
        return None

    monkeypatch.setattr(conflict, "_resolve", no_resolve)
    assert asyncio.run(conflict.find_conflicts("s", _srcs(("kb", "A")), stream_fn=_llm_seq(SCAN_JSON))) is None


def test_find_drops_pairs_pointing_outside_the_material(wired):
    payload = '{"pairs":[{"a_n":1,"b_n":42,"basis":"越界"},{"a_n":2,"b_n":1,"basis":"真的"}]}'
    out = asyncio.run(
        conflict.find_conflicts("s", _srcs(("kb", "A"), ("web", "B")), stream_fn=_llm_seq(payload))
    )
    assert out == [{"a_n": 1, "b_n": 2, "basis": "真的"}]


def test_find_is_none_without_material(wired):
    assert asyncio.run(conflict.find_conflicts("s", [], stream_fn=_llm_seq(SCAN_JSON))) is None


# ---------- _pairs_block（喂给写手的那一段） ----------


def test_pairs_block_names_both_sides():
    srcs = _srcs(("kb", "我的笔记"), ("web", "官方文档"))
    block = conflict._pairs_block([{"a_n": 1, "b_n": 2, "basis": "谁恢复协程"}], srcs)
    assert "已确认对不上的地方" in block
    assert "我的笔记" in block and "官方文档" in block
    assert "谁恢复协程" in block


# ---------- save ----------


def test_save_writes_vault_conflicts_and_indexes(monkeypatch):
    seen: list[Path] = []

    def fake_index(path, **kw):
        seen.append(Path(path))
        return 2

    monkeypatch.setattr("app.core.indexer.index_file", fake_index)

    rep = conflict.Report(
        title="对质报告", sections=[conflict.Section(heading="H", body="两边 [1] [2]")], used=[1, 2]
    )
    srcs = _srcs(("kb", "A"), ("web", "B"))
    out = asyncio.run(conflict.save(rep, srcs))

    assert out["chunks"] == 2
    assert out["filename"].startswith("conflicts/") and out["filename"].endswith(".md")
    dest = conflict.CONFLICTS_DIR / Path(out["filename"]).name
    assert dest.exists() and "对质报告" in dest.read_text(encoding="utf-8")
    assert seen == [dest]  # 落盘之后确实进了索引——「上次发现这两处对不上」靠这一步


# ---------- run（完整生成器） ----------


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
        memory_fn=_no_memory,
        search_fn=_no_search,
        fetch_fn=_no_fetch,
        stream_fn=_llm_seq(FRAME_JSON, SCAN_JSON, REPORT_JSON),
    )
    assert _kinds(events) == ["framing", "frame", "gathering", "error"]


def test_run_emits_frame_before_gathering(wired, monkeypatch):
    """读错题是这类功能第一位的失败模式：题面必须在取材之前摆出来。"""
    monkeypatch.setattr("app.core.providers.default_model_id", lambda: "test-model")
    events = _run(
        "await 把控制权交给谁",
        kb_fn=_kb,
        memory_fn=_no_memory,
        search_fn=_no_search,
        fetch_fn=_no_fetch,
        stream_fn=_llm_seq(FRAME_JSON, SCAN_JSON, REPORT_JSON),
    )
    kinds = _kinds(events)
    assert kinds.index("frame") < kinds.index("gathering")
    assert dict(events)["frame"]["subject"] == "await 把控制权交给了谁"


def test_run_errors_when_every_leg_fails(wired, monkeypatch):
    async def boom(*_a, **_k):
        raise RuntimeError("挂了")

    monkeypatch.setattr("app.core.providers.default_model_id", lambda: "test-model")
    events = _run(
        "话题",
        kb_fn=boom,
        memory_fn=boom,
        search_fn=boom,
        fetch_fn=boom,
        stream_fn=_llm_seq(FRAME_JSON, SCAN_JSON, REPORT_JSON),
    )
    assert _kinds(events) == ["framing", "frame", "gathering", "error"]


def test_run_happy_path(wired, monkeypatch):
    monkeypatch.setattr("app.core.providers.default_model_id", lambda: "test-model")

    async def search(query):
        return [
            {"title": "文档", "url": "https://e.com/doc"},
            {"title": "另一篇", "url": "https://e.com/doc2"},
        ]

    async def fetch(url):
        return "官方文档正文"

    fn = _llm_seq(FRAME_JSON, SCAN_JSON, REPORT_JSON)
    events = _run(
        "await 把控制权交给谁",
        kb_fn=_kb,
        memory_fn=_no_memory,
        search_fn=search,
        fetch_fn=fetch,
        stream_fn=fn,
    )

    kinds = _kinds(events)
    # finding 在 sources 之后、writing 之前：先扫出哪两处对不上，再决定要不要写
    assert kinds == ["framing", "frame", "gathering", "sources", "finding", "writing", "report"]
    assert kinds.index("finding") < kinds.index("writing")

    raw = [k for k, _ in events]
    assert raw.index("draft") < raw.index("report")  # 正文边生成边发帧

    sources = dict(events)["sources"]
    assert sources["kb"] == 1 and sources["web"] == 2
    assert set(sources["sources"][0]) == {"n", "kind", "title", "ref"}  # 不带正文

    rep = dict(events)["report"]
    assert rep["title"] == "对质"
    assert rep["used"] == [1, 3]
    assert rep["pairs"] == [{"a_n": 1, "b_n": 3, "basis": "一边说调用方恢复，一边说事件循环恢复"}]
    assert rep["subject"] == "await 把控制权交给了谁"  # 题面随报告回前端
    assert rep["model_id"] == "test-model"
    from app.core import report as report_mod

    assert rep["prompt_sha"] == report_mod.prompt_sha(conflict._SYNTH_PROMPT)

    # 写手必须收到「已确认的冲突对」——否则它会自己去猜哪两处对不上
    assert "已确认对不上的地方" in fn.calls[-1][1]["content"]


def test_run_stops_without_writing_when_nothing_conflicts(wired, monkeypatch):
    """零冲突 → 直接给结论，**不再调用成文**（省掉的正是最长的那次生成）。

    用调用次数钉，而不是只看事件名：事件对了但背后多烧一次模型调用，看不出来。
    """
    monkeypatch.setattr("app.core.providers.default_model_id", lambda: "test-model")

    async def search(query):
        return [{"title": "文档", "url": "https://e.com/doc"}]

    async def fetch(url):
        return "官方文档正文"

    fn = _llm_seq(FRAME_JSON, SCAN_EMPTY, REPORT_JSON)
    events = _run(
        "await 把控制权交给谁",
        kb_fn=_kb,
        memory_fn=_no_memory,
        search_fn=search,
        fetch_fn=fetch,
        stream_fn=fn,
    )

    assert _kinds(events) == ["framing", "frame", "gathering", "sources", "finding", "report"]
    assert len(fn.calls) == 2  # 读题 + 扫描；成文那次**没有发生**

    rep = dict(events)["report"]
    assert rep["pairs"] == []
    assert rep["used"] == []
    assert "没有对不上" in rep["title"]
    from app.core import report as report_mod

    # 这条结论出自扫描那步，所以指纹挂在扫描提示词上（质量闭环按它分版本统计）
    assert rep["prompt_sha"] == report_mod.prompt_sha(conflict._FIND_PROMPT)


def test_run_writes_anyway_when_scan_is_unavailable(wired, monkeypatch):
    """扫描没跑成（None）≠ 没有冲突：照旧成文，让写手自己找。"""
    monkeypatch.setattr("app.core.providers.default_model_id", lambda: "test-model")

    async def no_scan(*_a, **_k):
        return None

    monkeypatch.setattr(conflict, "find_conflicts", no_scan)

    async def search(query):
        return [{"title": "文档", "url": "https://e.com/doc"}]

    async def fetch(url):
        return "官方文档正文"

    fn = _llm_seq(FRAME_JSON, REPORT_JSON)
    events = _run(
        "await 把控制权交给谁",
        kb_fn=_kb,
        memory_fn=_no_memory,
        search_fn=search,
        fetch_fn=fetch,
        stream_fn=fn,
    )
    assert "writing" in _kinds(events)
    rep = dict(events)["report"]
    assert rep["pairs"] == []
    # 没有已确认的对，就不该往写手那里塞那一段
    assert "已确认对不上的地方" not in fn.calls[-1][1]["content"]
