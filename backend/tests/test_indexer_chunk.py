"""chunk_text 分块行为测试。

之前分块逻辑零测试覆盖——改坏切分（比如误删中文句号分隔符）没有任何测试会红。
这里钉住：短文本不切、二级标题边界、中文句子边界、chunk 长度上限、overlap。

下半部分钉的是「结构感知」那三件（PLAN §10.2「检索」的语义分块）：丢纯符号块、
孤立标题并回正文、碎块并进邻居。它们是**量出来**的——真库上 652 个块里 16% 短于
200 字符，还有一批就是一行 `---`。
"""
import sys

sys.path.insert(0, ".")

from app.core.indexer import (
    CHUNK_OVERLAP,
    CHUNK_SIZE,
    CHUNK_SOFT_MAX,
    CHUNKER_VERSION,
    MIN_CHUNK,
    chunk_text,
)


def test_short_text_stays_one_chunk():
    text = "这是一段短文本，远小于 chunk_size，不应被切开。"
    chunks = chunk_text(text)
    assert len(chunks) == 1
    assert chunks[0] == text


def test_empty_and_whitespace_text():
    assert chunk_text("") == []
    assert chunk_text("   \n\n  \t") == []


def test_chunks_stay_within_budget():
    # 无标题的纯长文本，必然触发切分；每个 chunk 都不应超 chunk_size（+overlap 余量）
    text = "这是正文内容，用逗号和句号分隔。这是第二句，继续填充内容。" * 60
    chunks = chunk_text(text)
    assert len(chunks) >= 2
    for c in chunks:
        assert len(c) <= CHUNK_SIZE + CHUNK_OVERLAP, f"chunk 超长: {len(c)}"


def test_h2_heading_is_a_split_boundary():
    # 两个二级章节，每章都足够长：应在 \n## 边界切开，第二章成为独立 chunk 的开头
    para = "这是章节正文，用于填充内容使章节足够长以触发切分。"
    text = "## 第一章 架构\n\n" + para * 40 + "\n\n## 第二章 实现\n\n" + para * 40
    chunks = chunk_text(text)
    assert len(chunks) >= 2
    # 某个 chunk 以二级标题开头，且标题没有被孤立成小块
    assert any(c.startswith("## 第二章") for c in chunks)
    # 标题不该被孤立：以标题开头的 chunk 应包含正文（长度远大于标题本身）
    for c in chunks:
        if c.startswith("## "):
            assert len(c) > 40, f"标题被孤立成小块: {c[:20]}..."


def test_chinese_punctuation_used_as_separator():
    # 若删掉中文句号分隔符，长中文文本会在任意字符处硬切。这里验证切分边界
    # 落在中文标点处（RecursiveCharacterTextSplitter 把句号归到下一块开头，
    # 所以内部 chunk 以句号开头，而不是句子中间硬切）。
    text = "这是一个完整的句子，用于验证中文标点切分。" * 80
    chunks = chunk_text(text)
    assert len(chunks) >= 2
    internal = chunks[1:]  # 除第一个外，内部 chunk 都从上一块的切分点开始
    sentence_boundary = sum(1 for c in internal if c.startswith("。") or c.startswith("，"))
    assert sentence_boundary == len(internal), "切分未落在中文标点处，疑似删了中文分隔符"


def test_overlap_between_adjacent_chunks():
    # 相邻 chunk 应有 overlap（后一个的开头 overlap 字符出现在前一个里）
    text = "这是用于验证重叠的正文内容，句子反复出现以拉长文本。" * 80
    chunks = chunk_text(text)
    assert len(chunks) >= 2
    head = chunks[1][:CHUNK_OVERLAP]
    assert head in chunks[0], "相邻 chunk 之间没有 overlap"


# ---------- 结构感知：丢噪音 / 标题并回正文 / 碎块并进邻居 ----------


def test_symbol_only_chunks_are_dropped():
    """实测里有一批块就是一行 `---`：占着索引名额、还可能被检索到，但它不承载任何东西。"""
    assert chunk_text("---") == []
    assert chunk_text("***\n\n---\n\n___") == []
    text = "甲" * 400 + "\n\n---\n\n" + "乙" * 400
    chunks = chunk_text(text)
    assert len(chunks) == 2  # 分隔线丢了，两边各留一块
    assert all(set(c.strip()) - set("-*_#= `~>|+\n") for c in chunks)


def test_a_file_that_is_only_symbols_yields_nothing():
    """空结果会让 index_file 把这个源删掉——比往库里塞一堆分隔线好。"""
    assert chunk_text("---\n\n***\n\n===\n\n___\n\n>>>") == []


def test_a_short_tail_is_absorbed_into_the_previous_chunk():
    """碎尾巴属于上一节（真库里 16% 的块短于 200 字符，大多是这种）。"""
    chunks = chunk_text("甲" * 790 + "\n\n" + "乙" * 100)
    assert len(chunks) == 1
    assert chunks[0].endswith("乙" * 100)


def test_a_middle_fragment_is_absorbed_into_the_previous_chunk():
    chunks = chunk_text("甲" * 790 + "\n\n" + "乙" * 60 + "\n\n" + "丙" * 790)
    assert [len(c) for c in chunks] == [851, 790]


def test_a_short_section_that_opens_with_a_heading_is_kept_separate():
    """短但**以标题开头**的块不并——那是真的一节，并进上一节就把章节边界切错了。"""
    chunks = chunk_text("甲" * 790 + "\n\n## 小节二\n\n" + "乙" * 60)
    assert len(chunks) == 2
    assert chunks[1].startswith("## 小节二")


def test_merged_chunks_stay_within_the_soft_max():
    """合并允许略超 CHUNK_SIZE，但不超过 CHUNK_SIZE + CHUNK_OVERLAP。"""
    text = "甲" * 790 + "\n\n" + "乙" * 100 + "\n\n" + "丙" * 790
    assert all(len(c) <= CHUNK_SOFT_MAX for c in chunk_text(text))
    assert MIN_CHUNK < CHUNK_SOFT_MAX


# ---------- 版本契约（PLAN §10.1 #2 的最小一块） ----------


class _FakeCol:
    def __init__(self, metas):
        self._m = metas

    def count(self):
        return len(self._m)

    def get(self, include=None):
        return {"metadatas": self._m}


def test_stats_counts_chunks_made_by_an_older_chunker(monkeypatch):
    """块带切法版本号；对不上就是「该重建索引了」——切法一变，块边界全变。"""
    from app.core import indexer

    monkeypatch.setattr(
        indexer,
        "get_collection",
        lambda: _FakeCol(
            [
                {"source": "a.md", "chunker": CHUNKER_VERSION},
                {"source": "a.md"},  # 旧块：没有 chunker 字段
                {"source": "b.md", "chunker": 1},
            ]
        ),
    )
    s = indexer.stats()
    assert s["chunks"] == 3 and s["files"] == 2
    assert s["stale"] == 2 and s["chunker"] == CHUNKER_VERSION


def test_stats_on_an_empty_index(monkeypatch):
    from app.core import indexer

    monkeypatch.setattr(indexer, "get_collection", lambda: _FakeCol([]))
    assert indexer.stats() == {"chunks": 0, "files": 0, "chunker": CHUNKER_VERSION, "stale": 0}
