"""通道预判的单测：纯函数部分 + 两个真陷阱 + 金标卫生。

不加载模型（向量那一级全部走注入的假嵌入器）。真效果由 `smoke_channel.py` 在金标上量。
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, ".")

from app.core import channel  # noqa: E402

GOLDEN = Path(__file__).parent.parent / "evals" / "routes" / "channel.json"


# ---------- 寒暄：按整句判，不按子串判 ----------


def test_plain_small_talk_is_recognised():
    for ask in ("在吗", "你好", "早啊", "谢谢你了", "辛苦了", "嗯嗯", "哈哈", "你是谁"):
        assert channel.is_small_talk(ask), ask


def test_small_talk_is_not_matched_by_substring():
    """**误跳过是最贵的错**：这两句都含寒暄片段，但都要材料。"""
    assert not channel.is_small_talk("早点告诉我那份材料在哪")
    assert not channel.is_small_talk("你好，帮我看看这份材料里怎么说的")
    assert not channel.is_small_talk("在吗？顺便问一下无幻觉上下文长度是什么概念")


def test_blank_is_not_small_talk():
    assert not channel.is_small_talk("")
    assert not channel.is_small_talk("   ，。")


# ---------- 关系线索：中文插入疑问词会把词断开 ----------


def test_relational_matches_both_shapes():
    """`"有关系"` **不是** `"有什么关系"` 的子串（有,什,么,关,系）——两条都得在词表里。"""
    assert channel.is_relational("这两份材料有什么关系")
    assert channel.is_relational("为什么这两次事故有关系")
    assert channel.is_relational("A 和 B 之间的关联是什么")


def test_non_relational_is_not_caught():
    assert not channel.is_relational("用两句话讲一下数据库索引为什么能让查询变快")


# ---------- 要材料 ----------


def test_needs_material_by_question_task_or_kind():
    assert channel.needs_material("RAG 是什么")  # 疑问标记
    assert channel.needs_material("帮我翻译一下这句话")  # 任务动词
    assert channel.needs_material("把这份材料整理成一份周报存进产出")  # 体裁名词（借 W3 的公开入口）


# ---------- 三级与默认方向 ----------


def test_relational_wins_over_the_question_marker():
    """关系线索排在疑问标记之前——「A 和 B 有什么关系」两者都命中，通道该走图谱。"""
    assert channel.pick("A 方案和 B 方案之间的关联是什么").channel == "kg"


def test_small_talk_skips_retrieval():
    d = channel.pick("在吗")
    assert d.channel == "skip" and d.level == "rule"


def test_undecided_defaults_to_retrieval_not_skip():
    """**方向与 W3 相反**：漏判只是白付一次检索，误判是材料缺失且用户看不见。"""
    d = channel.pick("那个东西后来怎么样了")
    assert d.channel == "hybrid"
    assert d.level in ("rule", "vector", "default")


def test_a_stubbed_embedder_can_drive_the_vector_level():
    """向量那一级：够像且比另一类明显更像才判 skip，否则回落去检索。

    假嵌入器要**只让寒暄那类**落进 [1,0]——第一版按「含 在/你/谢」判，结果一条要材料的
    原型句（「我上周记的那条笔记在哪」）也含「在」，两类同分、margin 为 0，模块**正确地**
    回落到了「去检索」。那说明假嵌入器写粗了，不是模块错了。
    """
    skip_like = ("在呀", "在吗", "你好呀", "早啊", "谢谢你了", "辛苦了", "收到", "嗯嗯", "你觉得呢")

    def fake_embed(texts):
        return [[1.0, 0.0] if any(k in t for k in skip_like) else [0.0, 1.0] for t in texts]

    d = channel.pick("在呀在呀", embed_fn=fake_embed)
    assert d.channel == "skip" and d.level == "vector"


def test_an_injected_embedder_never_poisons_the_prototype_cache():
    """注入的 embedder **一律不进缓存**——这条是 `routing.py` 用真教训换来的：

    缓存是全局的，注入的是测试假实现；先跑一次假的，真嵌入器的向量就再也不会被算，
    于是「向量级认不出东西」这个结论其实是被测试自己造成的。
    """
    channel._PROTO_VECTORS = None
    channel._prototype_vectors(lambda texts: [[1.0, 0.0] for _ in texts])
    assert channel._PROTO_VECTORS is None, "注入的 embedder 污染了全局缓存"


def test_classify_fn_is_the_unwired_third_level():
    """第三级只在两级都没把握时才走——所以这里喂一个**不带任何线索**的问法。

    （第一版用了「那个东西后来怎么样了」，它含「怎么」，在**规则级**就被接走了，
    第三级根本没轮到——那是测试选错了样本。）
    """

    def blank_embed(texts):
        return [[0.0, 1.0] for _ in texts]  # 与寒暄原型零相似 → 向量级必然回落

    d = channel.pick("后来的那个东西", embed_fn=blank_embed, classify_fn=lambda ask: "skip")
    assert d.channel == "skip" and d.level == "model"


def test_a_raising_classify_fn_falls_back_to_retrieval():
    def boom(ask):
        raise RuntimeError("模型打不通")

    def blank_embed(texts):
        return [[0.0, 1.0] for _ in texts]

    d = channel.pick("后来的那个东西", embed_fn=blank_embed, classify_fn=boom)
    assert d.channel == "hybrid" and d.level == "default"


def test_describe_reads_like_a_ledger_line():
    text = channel.describe(channel.pick("在吗"))
    assert "跳过检索" in text and "rule" in text


# ---------- 金标卫生 ----------


def _doc() -> dict:
    return json.loads(GOLDEN.read_text(encoding="utf-8"))


def test_golden_cases_are_well_formed():
    cases = _doc()["cases"]
    assert len(cases) >= 30, f"通道金标只有 {len(cases)} 条"
    ids = [c["id"] for c in cases]
    assert len(ids) == len(set(ids)), "id 有重复"
    for c in cases:
        assert c["ask"].strip(), "ask 为空"
        assert c["channel"] in channel.CHANNELS, f"channel 非法: {c['channel']}"


def test_golden_covers_all_three_channels():
    got = {c["channel"] for c in _doc()["cases"]}
    assert got == set(channel.CHANNELS), f"金标没覆盖全部通道：{got}"


def test_golden_keeps_the_dangerous_cases():
    """「看着像寒暄其实要材料」那几条必须留在金标里——它们是零误跳过这条红线的依据。"""
    risky = [c for c in _doc()["cases"] if "误跳过红线" in (c.get("note") or "")]
    assert len(risky) >= 3, f"红线用例只剩 {len(risky)} 条"
    for c in risky:
        assert c["channel"] != "skip"
