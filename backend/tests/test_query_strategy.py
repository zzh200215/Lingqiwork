"""查询理解策略池（P1c）：确定性选档 + HyDE 的两路形态不对称 + 分派与退路。

不碰真索引、不调真模型——生成函数全部走注入缝（`hyde_fn` / `decompose_fn` /
`rewrite_fn`）。真效果由金标上分档量（`smoke_strategy.py`），这里只钉住
「哪档被选中」「段进哪一路」「生成失败退到哪」这三件会静默错的事。

**2026-09-22 加第四件**：委托通道（`Agent升级.md` §5 的合流）。它默认关，所以那几条测试
同时钉两件事——**开了真的走委托**、**不开一次都不碰它**。
"""
import asyncio

from app.core import delegate, indexer, retriever, structured


def _resolved():
    """一个假的 `report.resolve`：`rewrite_queries` 那一层要先解析出模型才往下走。"""

    async def fake(model_id=""):  # noqa: ARG001
        return (structured.ProviderInfo(kind="openai", base_url="https://stub", api_key="k"), "m")

    return fake


def _hit(ref, chunk, score):
    return {
        "id": f"{ref}::{chunk}",
        "text": "t",
        "source": ref,
        "title": "T",
        "chunk": chunk,
        "score": score,
        "channels": ["vec"],
    }


# ---------- 确定性选档 ----------


def test_multi_hop_cues_pick_decompose():
    for q in ("最小原子工具集为什么只留 9 个工具", "两者有什么区别", "A 和 B 相比哪个更合适"):
        assert retriever.pick_strategy(q) == "decompose", q


def test_statements_pick_hyde():
    """陈述型查询（没有任何疑问标记）——它更像「要写一段」，答案形态更好撞。"""
    for q in ("RAG 的一句话定义", "把网站上的付费课程整套弄到本地，路上离线看"):
        assert retriever.pick_strategy(q) == "hyde", q


def test_questions_pick_rewrite():
    for q in ("GA 的 mykey.py API 密钥怎么配置", "无幻觉上下文长度是什么概念"):
        assert retriever.pick_strategy(q) == "rewrite", q


def test_multi_hop_wins_over_the_question_marker():
    """「为什么…怎么…」两个标记同时出现时，多跳线索优先——不然复合问题永远拆不开。"""
    assert retriever.pick_strategy("为什么这么做，具体怎么落地") == "decompose"


def test_blank_query_falls_back_to_rewrite():
    assert retriever.pick_strategy("   ") == "rewrite"
    assert retriever.pick_strategy(None) == "rewrite"


# ---------- HyDE：两路各用最合适的形态 ----------


def test_search_hyde_sends_passage_to_vectors_and_original_to_bm25(monkeypatch):
    """HyDE 的全部意思就在这条不对称上：向量路吃假设段落，词法路只吃真词。"""
    seen = {}

    def fake_vec(q, top_k=5):
        seen["vec"] = q
        return [_hit("a.md", 0, 0.9)]

    def fake_bm25(q, top_k):
        seen["lex"] = q
        return [("a.md::0", 1.0)]

    monkeypatch.setattr(indexer, "search", fake_vec)
    monkeypatch.setattr(retriever, "bm25_search", fake_bm25)
    retriever.invalidate()

    out = retriever.search_hyde("问题原话", "假设答案段落", 3)
    assert seen["vec"] == "假设答案段落"
    assert seen["lex"] == "问题原话"
    assert [h["source"] for h in out] == ["a.md"]


def test_search_hyde_without_a_passage_is_plain_hybrid(monkeypatch):
    """生成不出来时不能空手而归：两路都用原话，等于没做 HyDE。"""
    seen = []

    def fake_vec(q, top_k=5):
        seen.append(("vec", q))
        return [_hit("a.md", 0, 0.9)]

    monkeypatch.setattr(indexer, "search", fake_vec)
    monkeypatch.setattr(retriever, "bm25_search", lambda q, top_k: [("a.md::0", 1.0)])
    retriever.invalidate()

    retriever.search_hyde("问题原话", "   ", 3)
    assert seen == [("vec", "问题原话")]


# ---------- 合并只写一份 ----------


def test_merge_hits_keeps_the_best_score_per_chunk():
    groups = [
        [_hit("a.md", 0, 0.6), _hit("b.md", 0, 0.5)],
        [_hit("a.md", 0, 0.9), _hit("c.md", 0, 0.7)],
    ]
    out = retriever.merge_hits(groups, 5)
    assert [h["source"] for h in out] == ["a.md", "c.md", "b.md"]
    assert out[0]["score"] == 0.9  # 同一条取最高分
    assert len(retriever.merge_hits(groups, 2)) == 2


# ---------- deep_search 的分派与退路 ----------


def _capture(monkeypatch):
    """记下 search_multi 收到的那批检索式。"""
    seen = {}
    monkeypatch.setattr(retriever, "search_multi", lambda qs, k: seen.update(qs=list(qs)) or [])
    return seen


def test_default_strategy_is_still_rewrite(monkeypatch):
    """默认不抢跑：新档要按「量出来的才上」先过金标，默认值不改。

    这条查询按规则会被判成 hyde，但没显式要求就必须还走改写。
    """
    seen = _capture(monkeypatch)

    async def fake_rewrite(topic, model_id="", *, stream_fn=None, native_fn=None):
        return ["换个说法"]

    asyncio.run(
        retriever.deep_search("把网站上的付费课程整套弄到本地", 3, rewrite_fn=fake_rewrite)
    )
    assert seen["qs"] == ["把网站上的付费课程整套弄到本地", "换个说法"]


def test_decompose_searches_the_original_plus_sub_questions(monkeypatch):
    seen = _capture(monkeypatch)

    async def fake_decompose(topic, model_id="", *, stream_fn=None, native_fn=None):
        return ["子问题1", "子问题2"]

    asyncio.run(
        retriever.deep_search("A 和 B 有什么区别", 3, strategy="decompose", decompose_fn=fake_decompose)
    )
    assert seen["qs"] == ["A 和 B 有什么区别", "子问题1", "子问题2"]


def test_hyde_searches_with_the_generated_passage(monkeypatch):
    seen = {}
    monkeypatch.setattr(
        retriever, "search_hyde", lambda q, p, k: seen.update(q=q, p=p) or [_hit("a.md", 0, 1.0)]
    )

    async def fake_hyde(topic, model_id="", *, stream_fn=None, native_fn=None):
        return "假设段落"

    out = asyncio.run(retriever.deep_search("RAG 的一句话定义", 3, strategy="hyde", hyde_fn=fake_hyde))
    assert seen == {"q": "RAG 的一句话定义", "p": "假设段落"}
    assert [h["source"] for h in out] == ["a.md"]


def test_hyde_without_a_passage_falls_back_to_rewrite(monkeypatch):
    seen = _capture(monkeypatch)

    async def no_hyde(topic, model_id="", *, stream_fn=None, native_fn=None):
        return "   "

    async def fake_rewrite(topic, model_id="", *, stream_fn=None, native_fn=None):
        return ["换个说法"]

    asyncio.run(
        retriever.deep_search("RAG 的一句话定义", 3, strategy="hyde", hyde_fn=no_hyde, rewrite_fn=fake_rewrite)
    )
    assert seen["qs"] == ["RAG 的一句话定义", "换个说法"]


def test_auto_uses_the_deterministic_rule(monkeypatch):
    seen = {}
    monkeypatch.setattr(retriever, "search_hyde", lambda q, p, k: seen.update(p=p) or [])

    async def fake_hyde(topic, model_id="", *, stream_fn=None, native_fn=None):
        return "段落"

    asyncio.run(
        retriever.deep_search("把网站上的付费课程整套弄到本地", 3, strategy="auto", hyde_fn=fake_hyde)
    )
    assert seen["p"] == "段落"


def test_a_generator_that_raises_still_searches_the_original(monkeypatch):
    """生成挂了不该让检索也挂——这一层是为了提召回，不是为了挡住检索。"""
    seen = _capture(monkeypatch)

    async def boom(topic, model_id="", *, stream_fn=None, native_fn=None):
        raise RuntimeError("模型打不通")

    asyncio.run(retriever.deep_search("某个话题", 3, strategy="decompose", decompose_fn=boom))
    assert seen["qs"] == ["某个话题"]


# ---------- 委托臂（Agent升级.md §5：查询策略走 A1 的通道）----------


def test_the_delegate_arm_really_goes_through_the_delegate_channel(monkeypatch):
    """开了 `via_delegate` → 生成那一步真的交给子代理，**而且给它只读工具**。

    「给它工具」是这条通道唯一买得到的东西（账与隔离本来就有）：所以它必须是
    `with_readonly=True`——不然这次合流只是换个地方调同一个模型。
    """
    from app.core import report

    seen: dict = {}

    async def fake_run(task, **kw):
        seen.update({"task": task, **kw})
        return {"text": '{"queries": ["换种说法", "another angle"]}', "error": "", "rounds_exhausted": False}

    monkeypatch.setattr(report, "resolve", _resolved())
    monkeypatch.setattr(delegate, "run", fake_run)

    out = asyncio.run(retriever.rewrite_queries("向量库怎么选", via_delegate=True))
    assert out == ["换种说法", "another angle"]
    assert seen["with_readonly"] is True, "委托臂要给只读工具，否则这次合流买不到任何东西"
    assert seen["messages"][-1]["content"] == "话题：向量库怎么选"
    assert "改写" in seen["messages"][0]["content"]  # 提示词还是这一档自己的提示词


def test_the_default_path_never_touches_the_delegate(monkeypatch):
    """**默认关**：不开 `via_delegate` 时一次都不许碰委托通道（钉一颗地雷）。

    这条很重要：`deep_search` 是引擎每次取材都要走的路径，默认那条路上多一次委托
    = 多一个 Task + 多一次模型解析，而收益是零。
    """
    from app.core import report

    async def boom(*a, **kw):  # noqa: ARG001
        raise AssertionError("默认路径不该走委托通道")

    async def fake_stream(info, model, messages):  # noqa: ARG001
        yield '{"queries": ["直连的结果"]}'

    monkeypatch.setattr(report, "resolve", _resolved())
    monkeypatch.setattr(delegate, "run", boom)
    out = asyncio.run(retriever.rewrite_queries("向量库怎么选", stream_fn=fake_stream))
    assert out == ["直连的结果"]


def test_a_dead_delegate_falls_back_to_the_direct_path(monkeypatch):
    """委托没走通（报错 / 没文字 / 轮数烧光）→ **退回直连**，而不是整个策略不可用。"""
    from app.core import report

    async def dead_run(task, **kw):  # noqa: ARG001
        return {"text": "", "error": "解析不出模型 (默认)", "rounds_exhausted": False}

    async def fake_stream(info, model, messages):  # noqa: ARG001
        yield '{"queries": ["退回来的直连结果"]}'

    monkeypatch.setattr(report, "resolve", _resolved())
    monkeypatch.setattr(delegate, "run", dead_run)
    out = asyncio.run(
        retriever.rewrite_queries("向量库怎么选", stream_fn=fake_stream, via_delegate=True)
    )
    assert out == ["退回来的直连结果"]


def test_hyde_via_delegate_uses_the_passage_it_brings_back(monkeypatch):
    """HyDE 那一档走委托时，拿回来的那段就是喂给向量路的「假设答案」。"""
    from app.core import report

    async def fake_run(task, **kw):  # noqa: ARG001
        return {
            "text": "这是一段假设性的资料原文，写得像真材料。",
            "error": "",
            "rounds_exhausted": False,
        }

    monkeypatch.setattr(report, "resolve", _resolved())
    monkeypatch.setattr(delegate, "run", fake_run)
    got = asyncio.run(retriever.hyde_passage("RAG 的一句话定义", via_delegate=True))
    assert got.startswith("这是一段假设性的资料原文")


def test_deep_search_only_passes_the_flag_when_it_is_on(monkeypatch):
    """注入进来的生成函数**不该被强迫认识这个开关**：默认那条路一个多余 kwarg 都不传。

    （测试与尺子那两支生成函数各有自己的签名；多一个默认关的开关就要它们全改一遍，
    那是拿测试换实现。）**断言落在「变体真的进了检索」上**：多传一个 kwarg 会 TypeError，
    而那个异常会被 `except` 吞掉、退成「只搜原话」——只看没抛错是看不出来的。
    """
    seen: dict = {}
    monkeypatch.setattr(retriever, "search_multi", lambda qs, k: seen.update(qs=list(qs)) or [])

    async def gen(topic, model_id="", *, stream_fn=None, native_fn=None):  # noqa: ARG001
        return ["变体"]

    asyncio.run(retriever.deep_search("话题", 3, rewrite_fn=gen))
    assert seen["qs"] == ["话题", "变体"], "默认那条路把生成的变体弄丢了（多半是多传了 kwarg）"

    async def gen2(topic, model_id="", *, stream_fn=None, native_fn=None, via_delegate=False):  # noqa: ARG001
        seen["via"] = via_delegate
        return ["变体"]

    asyncio.run(retriever.deep_search("话题", 3, rewrite_fn=gen2, via_delegate=True))
    assert seen["via"] is True
    assert seen["qs"] == ["话题", "变体"]
