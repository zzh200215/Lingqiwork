"""引擎侧检索尺子（`core/gather_eval.py`）：**攒材料攒得全不全**。

这一层只钉纯函数与金标本身（尺子的尺子）。真正跑检索的那两臂在
`smoke_gather_eval.py` 里，不在这里——**它要钱**，而这一层一秒都不用。
"""
import sys

import pytest

sys.path.insert(0, ".")

from app.core import gather_eval as ge  # noqa: E402


def test_the_shipped_golden_set_is_sound():
    """金标本身：每题都有 topic 与 required，id 不重、required 不重。"""
    golden = ge.load_golden()
    assert len(golden) >= 8, "题太少，配对读不出东西"
    ids = [g["id"] for g in golden]
    assert len(set(ids)) == len(ids), "id 重了——配对会静默丢题"
    for g in golden:
        assert g["topic"].strip()
        assert len(set(g["required"])) == len(g["required"])
        # **每题都要说清「为什么是这几份」**：不然它就是一把没人能复核的尺子
        assert g["note"].strip(), f"{g['id']} 没有 note"


def test_the_golden_set_has_both_multi_and_single_source_tasks():
    """**对照组**：多份题用来量「攒得全不全」，单份题用来分辨「答不全」是真缺材料，
    还是这把尺子只会数多份题。两种都要有，否则读完表不知道该怀疑谁。"""
    sizes = [len(g["required"]) for g in ge.load_golden()]
    assert max(sizes) >= 3, "没有需要三份的题——『凑齐』这件事量不出来"
    assert min(sizes) == 1, "没有单份题——缺了对照组"


def test_a_broken_golden_line_raises_instead_of_being_skipped(tmp_path):
    """坏行**当场抛**：静默跳过一行，就是让一把尺子少了一题而没人知道。"""
    p = tmp_path / "g.jsonl"
    p.write_text('{"topic": "x"}\n', encoding="utf-8")
    with pytest.raises(ValueError, match="required"):
        ge.load_golden(p)
    p.write_text('{"required": ["a"]}\n', encoding="utf-8")
    with pytest.raises(ValueError, match="topic"):
        ge.load_golden(p)
    p.write_text('{"topic": "x", "required": ["a", "a"]}\n', encoding="utf-8")
    with pytest.raises(ValueError, match="重复"):
        ge.load_golden(p)
    p.write_text("\n\n", encoding="utf-8")
    with pytest.raises(ValueError, match="空"):
        ge.load_golden(p)


def test_validate_catches_a_source_that_is_not_in_the_corpus():
    """**这一道是防「写错路径」的**：写错了那一题的覆盖率永远到不了 1，
    而报告上只会显示「没凑齐」——读起来像检索不行。"""
    golden = [{"id": "g1", "required": ["repos/a.md", "repos/typo.md"]}]
    problems = ge.validate(golden, ["repos/a.md", "repos/b.md"])
    assert len(problems) == 1 and "typo.md" in problems[0]
    assert ge.validate(golden, ["repos/a.md", "repos/typo.md"]) == []
    # 空语料是「先跑索引」，不是「金标没问题」
    assert ge.validate(golden, []) and "索引" in ge.validate(golden, [])[0]


def test_coverage_counts_files_not_chunks():
    """**同一个文件的 8 块只算一份**：引擎要的是「哪几份材料」，不是「哪几块」。"""
    hits = [
        {"source": "repos/a.md", "text": "1"},
        {"source": "repos/a.md", "text": "2"},
        {"source": "repos/b.md", "text": "3"},
        {"source": "", "text": "垃圾"},
    ]
    got = ge.coverage(hits, ["repos/a.md", "repos/b.md", "repos/c.md"])
    assert got == {
        "total": 3,
        "hit": 2,
        "ratio": 0.6667,
        "full": False,
        "missing": ["repos/c.md"],
        "distinct": 2,
    }
    assert ge.coverage(hits, ["repos/a.md"])["full"] is True
    assert ge.coverage([], ["repos/a.md"])["ratio"] == 0.0


def test_summarize_keeps_full_rate_separate_from_coverage():
    """**两个数分开**：「平均命中 80%」和「八成的题凑齐了」是两件事——
    攒材料的失败常常是「差一份」，平均值把它抹平。"""
    rows = [
        {"ratio": 1.0, "full": True, "distinct": 3, "seconds": 1.0, "calls": 0},
        {"ratio": 0.5, "full": False, "distinct": 6, "seconds": 2.0, "calls": 1},
    ]
    s = ge.summarize(rows)
    assert s["tasks"] == 2
    assert s["coverage"] == 0.75
    assert s["full_rate"] == 0.5
    assert s["distinct"] == 4.5 and s["seconds"] == 3.0 and s["calls"] == 1
    assert ge.summarize([])["tasks"] == 0


def test_pair_is_per_task_and_refuses_mismatched_arms():
    """同题配对（与 `collab_eval.pair_reps` 同一条纪律）：题对不上就当场抛。"""
    a = [{"id": "g1", "ratio": 0.5}, {"id": "g2", "ratio": 1.0}, {"id": "g3", "ratio": 0.5}]
    b = [{"id": "g1", "ratio": 1.0}, {"id": "g2", "ratio": 1.0}, {"id": "g3", "ratio": 0.0}]
    d = ge.pair(a, b)
    assert (d["win"], d["tie"], d["loss"]) == (1, 1, 1)
    assert d["p"] == 1.0  # 一胜一负：符号检验读不出方向
    assert "g1 B 更全" in d["detail"][0]
    with pytest.raises(ValueError, match="两臂的题不一样"):
        ge.pair(a, b[:2])


def test_the_ruler_does_not_touch_the_file_level_one():
    """**两把尺子并列，不互相改口径**：那把量「找一条准的」（一行一个 `expected_source`），
    这把量「攒一把全的」（一行一个 `required` 列表）。共用同一个语料，**题各是各的**。

    **刻意不钉死条数**：文件级那把**本来就会长**（2026-09-23 就从 44 加到 63——补失败正样本
    那一笔就是往它里面加题）。钉死条数会把「谁改谁错」写成规矩，而那正好挡住该做的事；
    真正要守的不变式是**两套行的形状不同、谁也不许被对方顶掉**。
    """
    import json
    import pathlib

    file_level = pathlib.Path("evals/retrieval/golden.jsonl")
    assert file_level.exists(), "文件级那把不见了？"
    rows = [
        json.loads(l) for l in file_level.read_text(encoding="utf-8").splitlines() if l.strip()
    ]
    assert len(rows) >= 44, "文件级那把不该缩水——题只增不减"
    for r in rows:
        assert "query" in r and "expected_source" in r, f"文件级那把的行形状变了：{list(r)}"
        assert "required" not in r, "两把尺子的题串了：文件级那把不该有 required"
    mine = ge.load_golden()
    assert all("required" in g for g in mine)
    assert all("query" not in g for g in mine), "攒材料那把的行形状是另一套"
