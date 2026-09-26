"""检索质量门与重搜策略的单测——纯函数，零模型、零索引。

方案 §2 P2 的验收里写着「**质量门纯函数 100% 单测覆盖**」，所以这一份要把
`retrieval_gate` 的每条分支都踩到：空结果、向量不达标、双通道不达标、恰好等于阈值
（边界是 `>=` 还是 `>`）、缺 `vec` 字段的条、以及重搜的换档与「不重搜」。
"""
import sys

sys.path.insert(0, ".")

from app.core import retrieval_gate as gate  # noqa: E402


def _hit(vec=None, channels=("vec", "bm25")):
    h = {"text": "t", "source": "a.md", "chunk": 0, "channels": list(channels)}
    if vec is not None:
        h["vec"] = vec
    return h


def _hits(vecs, channels=None):
    """一组命中：每条各带自己的向量相似度；`channels` 可以整组指定。"""
    return [
        _hit(v, channels if channels is not None else ("vec", "bm25"))
        for v in vecs
    ]


# ---------- vec_top1 ----------


def test_vec_top1_takes_the_max_of_the_vector_channel():
    assert gate.vec_top1(_hits([0.3, 0.7, 0.5])) == 0.7


def test_vec_top1_skips_hits_that_never_matched_the_vector_channel():
    """纯词法命的条没有 `vec`——**跳过它们**，别把缺失当 0 去拉低最高值。"""
    hits = _hits([0.42]) + [_hit(None, channels=("bm25",))]
    assert gate.vec_top1(hits) == 0.42


def test_vec_top1_is_zero_when_nothing_carries_a_vector_score():
    assert gate.vec_top1([_hit(None, channels=("bm25",))]) == 0.0
    assert gate.vec_top1([]) == 0.0


# ---------- both_frac ----------


def test_both_frac_counts_hits_that_matched_both_channels():
    hits = _hits([0.9], ("vec", "bm25")) + _hits([0.8], ("vec",))
    assert gate.both_frac(hits) == 0.5


def test_both_frac_of_nothing_is_zero():
    assert gate.both_frac([]) == 0.0


# ---------- assess ----------


def test_assess_passes_a_strong_retrieval():
    q = gate.assess(_hits([0.75, 0.7, 0.6]))
    assert q.ok and q.vec_top1 == 0.75 and q.both_frac == 1.0


def test_assess_rejects_an_empty_result():
    q = gate.assess([])
    assert not q.ok and "没有检索到" in q.reason


def test_assess_rejects_when_the_vector_channel_found_nothing_close():
    q = gate.assess(_hits([0.5, 0.4]))
    assert not q.ok and "向量路最高相似度" in q.reason


def test_assess_rejects_when_only_one_channel_carried_it():
    """向量够像，但五条里只有一条是双通道命中的——单通道的侥幸不算好。"""
    hits = _hits([0.9], ("vec", "bm25")) + _hits([0.88, 0.87, 0.86, 0.85], ("vec",))
    q = gate.assess(hits)
    assert not q.ok and "双通道占比" in q.reason


def test_assess_thresholds_are_inclusive():
    """边界是 `>=`：恰好等于阈值要通过——不然阈值表里的那一行就是假的。"""
    hits = _hits([gate.VEC_FLOOR] * 3)
    q = gate.assess(hits, vec_floor=gate.VEC_FLOOR, both_floor=1.0)
    assert q.ok, "恰好等于 vec_floor 被判掉了，阈值语义是 > 而不是 >="


def test_assess_honours_custom_thresholds():
    hits = _hits([0.5, 0.5])
    assert not gate.assess(hits).ok
    assert gate.assess(hits, vec_floor=0.5, both_floor=1.0).ok


# ---------- next_strategy ----------


def test_retry_walks_the_fixed_order():
    assert gate.next_strategy("rewrite") == "hyde"
    assert gate.next_strategy("hyde") == "decompose"


def test_retry_stops_after_the_last_strategy():
    """只重试一次是硬约束：轮完就到此为止，给现在这把材料去答。"""
    assert gate.next_strategy("decompose") is None


def test_unknown_strategy_starts_from_the_top():
    assert gate.next_strategy("") == "rewrite"
    assert gate.next_strategy("模型自己想的") == "rewrite"


# ---------- should_retry（重试预算）----------

_OK = gate.Quality(True, 0.9, 1.0, "够好")
_BAD = gate.Quality(False, 0.1, 0.2, "不够")


def test_retry_when_the_gate_says_no_and_budget_is_left():
    assert gate.should_retry(_BAD, retries=0) is True


def test_no_retry_when_the_gate_is_happy():
    """门说够好就到此为止——哪怕预算还在，也不许再搜一次（那是白花钱）。"""
    assert gate.should_retry(_OK, retries=0) is False


def test_no_retry_once_the_budget_is_spent():
    """只重试一次：花完预算就认了，拿现在这把材料去答。"""
    assert gate.should_retry(_BAD, retries=1) is False
    assert gate.should_retry(_BAD, retries=2) is False


def test_retry_budget_defaults_to_one():
    assert gate.MAX_RETRIES == 1
