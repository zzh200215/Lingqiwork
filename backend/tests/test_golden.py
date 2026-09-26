"""金标集的静态校验：字段齐、tag 合法、query 唯一、两条配比纪律。

评测器本体的回归在 `smoke_evals.py`（健康度/对比）；这里只守 `golden.jsonl` 这个
source of truth 的卫生——文件进 git，谁改坏一行、或把某类样本抽稀到阈值以下，测试当场红。

**两类样本，两套纪律**（P2 前置 2026-09-20 起）：
- **正样本**（lexical / paraphrase / competing）有期望源，算 hit@k/MRR。出题纪律见
  RAG升级.md §2 P0：词汇鸿沟型必须占三成以上；单来源不许绑架尺子。
- **负样本**（no_answer）**必须没有**期望源，不参与 hit@k/MRR——它只服务质量门的阈值
  标定（`smoke_quality_gate.py`）。它的纪律是**不许只有容易的那一档**：全出「明显域外」
  的话，门只要学会「话题不像就不开」就够了，而那正是它没用的地方。所以「贴着语料但确实
  没写」的硬负样本要占够数。
"""

import json
from pathlib import Path

GOLDEN = Path(__file__).resolve().parent.parent / "evals" / "retrieval" / "golden.jsonl"
TAGS = {"lexical", "paraphrase", "competing"}
NEGATIVE = "no_answer"
ALL_TAGS = TAGS | {NEGATIVE}

# 负样本的两档（写在 note 里）：明显域外 / 贴着语料但没写。后者才是门真正要判的。
FAR = "明显域外"
NEAR = "贴着语料"


def _rows() -> list[dict]:
    return [json.loads(l) for l in GOLDEN.read_text(encoding="utf-8").splitlines() if l.strip()]


def _positives() -> list[dict]:
    return [r for r in _rows() if r["tag"] != NEGATIVE]


def _negatives() -> list[dict]:
    return [r for r in _rows() if r["tag"] == NEGATIVE]


def test_every_row_has_a_query_and_a_legal_tag():
    rows = _rows()
    assert len(rows) >= 30, f"金标只有 {len(rows)} 条，测不出回归"
    for r in rows:
        assert r["query"].strip(), "query 为空"
        assert r["tag"] in ALL_TAGS, f"tag 非法: {r['tag']}"


def test_positives_have_a_source_and_negatives_do_not():
    """两边的字段纪律是反的：正样本缺期望源就没法判排序，负样本写了期望源就自相矛盾。"""
    for r in _positives():
        assert r["expected_source"].strip(), f"{r['query'][:20]} 是正样本却没有期望源"
    for r in _negatives():
        assert not r["expected_source"].strip(), f"{r['query'][:20]} 是负样本却写了期望源"


def test_unique_queries():
    queries = [r["query"] for r in _rows()]
    assert len(queries) == len(set(queries)), "query 重复：同题两问会双计权重"


def test_paraphrase_share_at_least_30pct():
    """配比按**正样本**算——负样本不参与 hit@k，混进来会把比例稀释掉。"""
    pos = _positives()
    n = len(pos)
    p = sum(1 for r in pos if r["tag"] == "paraphrase")
    assert p / n >= 0.3, f"词汇鸿沟型只占 {p}/{n}——截断伤的是向量路，这类抽稀了收益害处都量不出"


def test_no_duplicate_expected_source_bias():
    """金标不该把权重压在少数几个文件上——单文件题过多会让指标跟着那个文件走。"""
    pos = _positives()
    by_src: dict[str, int] = {}
    for r in pos:
        by_src[r["expected_source"]] = by_src.get(r["expected_source"], 0) + 1
    max_share = max(by_src.values()) / len(pos)
    assert max_share <= 0.2, f"单一来源占 {max_share:.0%}，尺子被一个文件绑架"


# ---------- 负样本：质量门标定用的那一半 ----------


def test_negatives_are_enough_to_calibrate_a_threshold():
    """门要在「好/坏」之间取阈值，坏样本太少就调不出也验不了。

    4 条的时候就吃过这个亏：AUC 0.79 是在 4 个样本上算的，置信区间宽到没有决策价值
    （见 RAG升级.md §3「P2 前置 · 质量门可分性」）。所以这里卡一个下限。
    """
    neg = _negatives()
    assert len(neg) >= 8, f"负样本只有 {len(neg)} 条，阈值标定不了"


def test_negatives_cover_both_difficulties():
    """不许只出「明显域外」：门只要学会「话题不像就不开」就够了，而那正是它没用的地方。

    硬负样本（贴着语料但确实没写）才是它要判的——检索会返回**主题相邻**的材料，
    分数还挺高，门必须仍然说「不够」。
    """
    notes = [r.get("note") or "" for r in _negatives()]
    far = sum(1 for n in notes if FAR in n)
    near = sum(1 for n in notes if NEAR in n)
    assert far >= 3, f"明显域外的负样本只有 {far} 条"
    assert near >= 3, f"硬负样本（贴着语料）只有 {near} 条——门没被真正考过"
