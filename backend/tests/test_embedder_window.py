"""超窗块的「窗口化 + 池化」——纯函数与分段记账，不加载模型。

512 是 BERT 绝对位置嵌入的硬上限，bge-small-zh-v1.5 装不下 800 字符的块，而
sentence-transformers 超窗**不报错、只静默丢尾部**。改法是：超窗块按窗口切开分别
编码，再把窗口向量合成一个——块的文本不动，所以 BM25/注入量/切分契约全都不受影响。

**线上采用的是逐维取最大（`_POOL_MODE = "max"`），不是平均**：等权与按 token 加权都
量过，两种都把头窗口的主方向摊薄（B 档 hit@1 0.6471→0.5588 / 0.5882），只有 max 净正
（配对 A 6/2、B 2/1，且是唯一抬动 paraphrase 短板的改动）。下面 `mode="mean"`
那几条留着，是因为它们钉的是**池化的通用契约**（不放大长度、不除零、权重语义），
将来谁要重开平均那一档，契约先立在这儿。见 RAG升级.md §3「P1a 修静默截断」五。

这里钉三件事（都是**量错就会静默错**的那种）：
  1. 装得下的文本必须**原样返回**，不许走 decode→encode 往返——否则 92% 的块会
     被无谓地改动，而「改动前后短块向量是否相同」这件事就再也说不清；
  2. 超窗文本要切成多条窗口，**覆盖到最后一个词**、相邻窗口有重叠；
  3. `embed` 的分段记账不能串位：N 个输入必须出 N 个向量，且每个都是单位向量。
"""
import sys

import numpy as np
import pytest

sys.path.insert(0, ".")

from app.core import embedder  # noqa: E402


class _StubTok:
    """最小可用的 HF tokenizer 替身：按空格切词，模拟 `return_overflowing_tokens`。

    只模拟**溢出契约**（滑动窗口 + 重叠），不管特殊 token 的占位——那是 tokenizer
    的事，不是这段逻辑的事。窗口宽度用「词数」当 token 数。
    """

    def __call__(
        self,
        text,
        *,
        truncation,
        max_length,
        stride,
        return_overflowing_tokens,
        add_special_tokens,
    ):
        assert truncation and return_overflowing_tokens and add_special_tokens
        words = text.split()
        out: list[list[str]] = []
        start = 0
        while True:
            out.append(words[start : start + max_length])
            if start + max_length >= len(words):
                break
            start += max_length - stride
        return {"input_ids": out or [[]]}

    def decode(self, ids, skip_special_tokens=True):
        assert skip_special_tokens
        return " ".join(ids)


def test_a_text_that_fits_is_returned_untouched():
    """装得下 → 原样一条。往返 decode→encode 会让短块的向量也不再逐位可比。"""
    tk = _StubTok()
    text = "甲 乙 丙 丁"
    assert embedder._window_texts(tk, text, window=8) == [text]


def test_an_over_window_text_is_split_into_overlapping_windows():
    """超窗 → 多条窗口；每条都在窗口内；**覆盖到最后一个词**；相邻窗口有重叠。"""
    tk = _StubTok()
    words = [f"w{i}" for i in range(30)]
    wins = embedder._window_texts(tk, " ".join(words), window=10)

    assert len(wins) > 1
    assert all(len(w.split()) <= 10 for w in wins)
    assert "w29" in wins[-1], "尾部没被覆盖——信号落在窗口之后的块就是白截"
    assert set(wins[0].split()) & set(wins[1].split()), "相邻窗口没有重叠"


def test_pool_of_a_single_vector_is_that_vector_normalized():
    assert embedder._pool([[3.0, 4.0]]) == pytest.approx([0.6, 0.8])


def test_pool_averages_normalized_window_vectors():
    """两个正交单位向量 → 平均仍是单位长度的 45°（池化不放大也不缩小长度）。"""
    out = embedder._pool([[1.0, 0.0], [0.0, 1.0]])
    assert out == pytest.approx([2**-0.5, 2**-0.5])
    assert sum(x * x for x in out) == pytest.approx(1.0)


def test_pool_of_an_empty_batch_is_empty():
    assert embedder._pool([]) == []


def test_pool_weights_windows_by_their_token_count():
    """尾窗口短就少说话——512 的头窗口不该被 300 的尾窗口摊平成一半。

    等权平均正是上一版踩的坑：B 档 hit@1 从 0.6471 掉到 0.5588，因为头窗口是块的
    主语所在，被平均掉之后这个块对「本来该匹配它」的查询就不再突出。
    """
    head, tail = [1.0, 0.0], [0.0, 1.0]
    even = embedder._pool([head, tail], mode="mean")
    weighted = embedder._pool([head, tail], weights=[512, 300], mode="mean")

    assert weighted[0] > even[0], "加权之后头窗口的权重反而更低了"
    norm = (512**2 + 300**2) ** 0.5
    assert weighted == pytest.approx([512 / norm, 300 / norm])


def test_pool_max_keeps_each_dimensions_strongest_window():
    """逐维取最大：头窗口的强项一个都不丢，尾窗口只是往上加维度。"""
    head, tail = [1.0, 0.0], [0.0, 1.0]
    out = embedder._pool([head, tail], mode="max")
    assert out == pytest.approx([2**-0.5, 2**-0.5])
    # 与等权平均同向，但它是「并集」语义：两个窗口各自最强的维度都留下了
    assert out == pytest.approx(embedder._pool([head, tail], mode="mean"))


def test_pool_max_never_dilutes_the_head_below_a_single_window():
    """一个方向明确占优的头窗口 + 一个方向随意的尾窗口：取最大后仍与头窗口同侧。"""
    head = [0.9, 0.1]
    tail = [-0.2, 0.3]
    out = embedder._pool([head, tail], mode="max")
    assert out[0] > 0.5, "头窗口的主方向被尾窗口摊薄了——那正是 mean 踩的坑"


def test_pool_ignores_non_positive_total_weight_instead_of_dividing_by_zero():
    assert embedder._pool([[1.0, 0.0]], weights=[0.0]) == pytest.approx([1.0, 0.0])


def test_pool_of_a_zero_vector_does_not_divide_by_zero():
    """全零输入不该炸在归一化上——它只是没有方向的向量。"""
    assert embedder._pool([[0.0, 0.0], [0.0, 0.0]]) == [0.0, 0.0]


def test_embed_windows_only_the_overflowing_blocks_and_keeps_alignment(monkeypatch):
    """分段记账：短块原样进模型、长块换成窗口文本、N 个输入出 N 个单位向量。"""

    class _StubModel:
        max_seq_length = 4
        tokenizer = _StubTok()
        seen: list[str] = []

        def encode(self, texts, normalize_embeddings=True, show_progress_bar=False):
            assert normalize_embeddings and not show_progress_bar
            _StubModel.seen = list(texts)
            rows = []
            for i in range(len(texts)):
                v = np.zeros(4, dtype="float32")
                v[i % 4] = 1.0
                rows.append(v)
            return np.asarray(rows)

    monkeypatch.setattr(embedder, "_get_model", lambda: _StubModel())
    short = "a b"
    long = " ".join(f"w{i}" for i in range(12))

    out = embedder.embed([short, long])
    seen = _StubModel.seen

    assert seen[0] == short, "短块被动了——常见路径必须原样进模型"
    assert all(w != long for w in seen[1:]), "长块没被窗口化"
    assert len(seen) > 2, "长块应该被切成多条窗口"
    assert len(out) == 2, "输入 2 条却出了别的条数——池化串位了"
    for v in out:
        assert sum(x * x for x in v) == pytest.approx(1.0, abs=1e-6)
