"""确定性路由（W3）的测试：**先量，再说这一级该不该存在。**

三件事分开钉住：

1. **判据逐条**：什么算「要一份成品」、什么算「问一件事」，以及几条最容易搞错的分界
   （「这份周报为什么这么长？」是问题，不是要成品；「帮我写一份周报可以吗？」是要成品）。
2. **金标上的两个数**：准确率 ≥0.9，而且**负例零误判**（upgrade-plan §W3 的验收原话）。
   规则级单独量一次、加上向量级再量一次 —— 这样「第二级值不值得有」是个数，不是感觉。
3. **可回放**：同一句话永远得到同一个决策；每一级都写清 level / confidence / reason。
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, ".")

from app.core import routing  # noqa: E402

FIXTURE = Path(__file__).resolve().parents[1] / "evals" / "routes" / "deliver_or_chat.json"


def _cases() -> list[dict]:
    blob = json.loads(FIXTURE.read_text(encoding="utf-8"))
    return list(blob["cases"])


def _wilson(k: int, n: int) -> tuple[float, float]:
    from app.core.prompt_eval import wilson

    return wilson(k, n)


# ---------- 1. 规则级：逐条分界 ----------


def test_asking_to_save_is_a_delivery_even_without_a_genre():
    d = routing.route("把上面那份存起来。")
    assert d.delivery is True and d.level == "rule" and d.kind == ""


def test_imperative_plus_a_genre_is_a_delivery_and_names_the_kind():
    d = routing.route("把这周的进展整理成一份周报。")
    assert d.delivery is True and d.kind == "deliver"


def test_a_question_that_mentions_a_genre_is_still_a_question():
    """**最容易搞错的一条**：有体裁名词 ≠ 要一份成品。"""
    for ask in (
        "这份周报为什么这么长？",
        "周报应该包含哪些内容？",
        "我该怎么写复盘？",
    ):
        d = routing.route(ask)
        assert d.delivery is False, ask
        assert d.level == "rule", ask


def test_a_polite_question_that_asks_for_a_document_is_a_delivery():
    """反过来也要对：「帮我写一份周报可以吗？」是**要成品**（礼貌不改变产出物）。"""
    d = routing.route("帮我写一份周报可以吗？")
    assert d.delivery is True and d.kind == "deliver"


def test_a_genre_plus_a_length_is_a_delivery_even_without_a_verb():
    d = routing.route("一份三百字左右的周报。")
    assert d.delivery is True and d.kind == "deliver" and d.level == "rule"


def test_pure_chit_chat_gets_no_rule_and_lands_on_the_default():
    """规则认不出 → 向量；向量也没把握 → **按闲聊处理**（误判的代价更大）。"""
    d = routing.route("嗯，继续。")
    assert d.delivery is False
    assert d.level in ("vector", "default")


def test_every_decision_carries_its_own_reason():
    for ask in ("存进产出。", "为什么这么慢？", "我有点累了。"):
        d = routing.route(ask)
        assert d.reason and d.level in ("rule", "vector", "model", "default")
        assert 0.0 <= d.confidence <= 1.0


def test_the_same_ask_always_gets_the_same_decision():
    """可回放：路由结果连同输入写进账本，离线复算必须一模一样。"""
    ask = "整理成一份给领导看的周报。"
    first = routing.route(ask)
    for _ in range(3):
        assert routing.route(ask) == first


def test_kind_only_comes_from_a_genre_the_product_actually_has():
    from app.core.mcp import _ARTIFACT_KINDS

    for _kind, nouns in routing._KIND_NOUNS:
        assert _kind in _ARTIFACT_KINDS, _kind
    assert routing.find_kind("随便写点东西") == ""


def test_a_specific_genre_wins_over_a_generic_head_noun():
    """「报告」是最笼统的词（调研报告 / 事后报告 / 周报都能这么叫）——
    所以查表的顺序是**具体在前**，这决定了「调研报告」算哪一类。"""
    assert routing.find_kind("整理成一份调研报告") == "research"
    assert routing.find_kind("写一份事后报告") == "deliver"
    assert routing.find_kind("帮我做一份 RAG 方案的技术调研") == "research"
    assert routing.find_kind("给我两三个方案") == "decide"


# ---------- 2. 金标：两个数 ----------


def _score(router) -> dict:
    cases = _cases()
    pos = [c for c in cases if c["delivery"]]
    neg = [c for c in cases if not c["delivery"]]
    right = 0
    wrong: list[str] = []
    false_positives: list[str] = []
    for c in cases:
        d = router(c["ask"])
        ok = d.delivery == c["delivery"]
        right += ok
        if not ok:
            wrong.append(f"{c['id']} {c['ask']} → {d.delivery}({d.level})")
        if not c["delivery"] and d.delivery:
            false_positives.append(c["id"])
    return {
        "n": len(cases),
        "right": right,
        "pos": len(pos),
        "neg": len(neg),
        "wrong": wrong,
        "false_positives": false_positives,
    }


def test_the_gold_set_is_labelled_balanced_and_big_enough():
    cases = _cases()
    assert len(cases) >= 60, "验收要求 ≥60 条"
    pos = [c for c in cases if c["delivery"]]
    neg = [c for c in cases if not c["delivery"]]
    assert len(pos) == len(neg) >= 30
    assert len({c["id"] for c in cases}) == len(cases)
    # 带体裁的用例要能对上产品真有的那几类
    from app.core.mcp import _ARTIFACT_KINDS

    for c in pos:
        if c.get("kind"):
            assert c["kind"] in _ARTIFACT_KINDS, c["id"]


def test_rules_alone_are_already_above_the_bar():
    """只开规则级（含糊的按闲聊算）。"""
    out = _score(lambda ask: routing.route(ask, embed_fn=lambda texts: [[1.0]] * len(texts)))
    lo, hi = _wilson(out["right"], out["n"])
    acc = out["right"] / out["n"]
    assert acc >= 0.9, f"规则级 {out['right']}/{out['n']}：{out['wrong']}"
    assert out["false_positives"] == [], out["false_positives"]
    assert hi - lo <= 0.34 or acc == 1.0


def test_the_vector_level_never_fires_when_a_stub_embedder_is_injected():
    """注入的嵌入器一律**不缓存**（第一版被这个咬过：测试先用假嵌入器跑一遍，真嵌入器的
    向量就再也不会被算，于是「向量级认不出东西」这个结论其实是我自己造成的）。"""
    routing._PROTO_VECTORS = None
    d = routing.route("把这周的检索改动作一次复盘。", embed_fn=lambda texts: [[1.0]] * len(texts))
    assert d.level == "default"
    assert routing._PROTO_VECTORS is None, "假嵌入器的向量不许进缓存"


def test_the_vector_level_does_not_break_the_zero_false_positive_promise():
    """加上向量级之后：负例仍然零误判（这一条是硬底线，宁可少召回也不能误判）。"""
    out = _score(lambda ask: routing.route(ask))
    lo, hi = _wilson(out["right"], out["n"])
    assert out["false_positives"] == [], f"负例被误判：{out['false_positives']}"
    assert out["right"] / out["n"] >= 0.9, f"全量 {out['right']}/{out['n']}：{out['wrong']}"
    assert hi - lo <= 0.34 or out["right"] == out["n"]


def test_the_vector_level_earns_its_place():
    """第二级要**真的多认出东西**，否则它只是一段会出错的代码。

    实测（64 条金标）：规则级漏掉 2 条（「把这周的检索改动作一次复盘。」「帮我做一份 RAG
    方案的技术调研。」—— 两句话里都没有我们列出的祈使动词），向量级把那两条认了回来，
    而且**没有**把负例认成交付型。另外两条本来可能误判的负例正好被两个闸挡住：
    「帮我记住我下周三要去上海」相似度 0.606（差一点点到 0.62）、
    「谢谢，帮了大忙」两类只差 0.016（小于 0.04）。
    """
    rules_only = _score(lambda ask: routing.route(ask, embed_fn=lambda texts: [[1.0]] * len(texts)))
    full = _score(lambda ask: routing.route(ask))
    assert full["right"] > rules_only["right"], "第二级没多认出任何东西就该删掉它"
    assert full["false_positives"] == []


def test_a_broken_embedder_does_not_break_the_router():
    """嵌入器不可用（没下模型、磁盘满）时回落成「闲聊」，绝不抛。"""

    def boom(_texts):
        raise RuntimeError("no model")

    d = routing.route("随便写点东西吧", embed_fn=boom)
    assert d.delivery is False and d.level == "default"


def test_the_model_level_is_a_seam_that_is_off_by_default(monkeypatch):
    """第三级（小模型二分类）：**默认不接线**，传进来才走。

    理由是个数：前两级在金标上已经达标，而每接一条含糊的回合就多花一次调用。
    """
    called: list[str] = []
    d = routing.route("嗯，继续。", classify_fn=lambda ask: (called.append(ask), (False, ""))[1])
    assert called and d.level == "model"

    called.clear()
    # 默认调用（没给 classify_fn）：含糊的话落到 default，不会去碰模型
    d2 = routing.route("嗯，继续。")
    assert not called and d2.level in ("vector", "default")

    # 第三级说「是交付」也认，但它自己标 level=model（账本上看得出来源）
    d3 = routing.route("嗯，继续。", classify_fn=lambda _ask: (True, "compose"))
    assert d3.delivery is True and d3.level == "model" and d3.kind == "compose"


def test_describe_is_readable():
    assert "交付型" in routing.describe(routing.route("写一份周报"))
    assert "闲聊" in routing.describe(routing.route("在吗？"))
