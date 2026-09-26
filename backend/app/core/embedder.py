"""Local embedding via sentence-transformers.

Model loaded lazily on first use (download happens on first run, then cached).
Default bge-small-zh-v1.5: good Chinese/English quality, ~100MB, fast on CPU.
If the model is already in the HF cache it is loaded offline — avoids
phone-home checks that can hang behind SSL-filtered networks.

**超窗的块不静默截断。** 512 是 BERT 绝对位置嵌入的硬上限、不是配置项，所以对这个
模型「调大窗口」是死的（换窗口模型是另一笔账，RAG升级.md §1.1）。这里做的是第三件事：
按窗口切开分别编码、再把窗口向量池化成一个——**块的文本一个字不动**，所以词法路
（BM25）、注入量、切分契约全都不受影响，改的只有向量。判据借用「信号在哪」那条
公开结论：信号落在窗口之后的块，只有覆盖到它才检索得到。
"""
import os
import threading
from pathlib import Path

import numpy as np

MODEL_NAME = "BAAI/bge-small-zh-v1.5"
# 建向量的**方法**版本。模型没换时它也会变——只要「同一段文本算出来的向量」变了，
# 旧块和新块就不该在同一个余弦空间里比。块元数据里的 `embed` 戳带的是这个组合值，
# 所以换做法（而不只是换模型）同样会被 `stats().stale_embed` 发现、照样强制重建。
#   w1 = 超窗块从「静默截断」改成「窗口化 + 逐维取最大池化」
METHOD_VERSION = "w1"
VECTOR_TAG = f"{MODEL_NAME}#{METHOD_VERSION}"

# 窗口之间的重叠比例。重叠是为了不让句子正好落在切缝上被劈成两半。
_WINDOW_STRIDE_RATIO = 0.125
# 多窗口合成一个向量的方式：`max`（逐维取最大，不摊薄头窗口）或 `mean`（按 token 加权）。
# 选 `max` 是量出来的——`mean` 两个变体都不如「什么都不做」，见 `_pool` 的注释。
_POOL_MODE = "max"

_lock = threading.Lock()
_model = None
# 编码要串行（**这是修一个真崩**，不是保守）：HF 的 fast tokenizer 在**每次调用**里都会
# 改写自己的截断/补齐配置（transformers 的 `set_truncation_and_padding` →
# `self._tokenizer.enable_truncation()`），而那是同一个 Rust 对象。两种不同的调用形态
# 交错时会撞出 `RuntimeError: Already borrowed`——实测单独都跑得通，混着跑（`_windows`
# 的 `_encode_plus` + `model.encode` 的 `_batch_encode_plus`）3 线程 40 次就必现。
# 检索路径本来就是多个线程并发（评测器 gather、引擎并行取材），所以这里必须串行。
_encode_lock = threading.Lock()


def _model_cached() -> bool:
    hf_home = os.environ.get("HF_HOME") or str(Path.home() / ".cache" / "huggingface")
    return (Path(hf_home) / "hub" / f"models--{MODEL_NAME.replace('/', '--')}").exists()


def _get_model():
    global _model
    if _model is None:
        with _lock:
            if _model is None:
                from sentence_transformers import SentenceTransformer

                _model = SentenceTransformer(
                    MODEL_NAME, local_files_only=_model_cached()
                )
    return _model


def _windows(tk, text: str, window: int) -> list[list[int]]:
    """文本 → 若干「每条都装得进窗口」的 token id 窗口（带重叠）。Pure w.r.t. `tk`。

    装得下就只出一条——调用方据此走「原文直接编码」的常见路径，不做 decode→encode
    往返：那对 92% 的块是纯粹的无谓损失，也会让「改动前后短块向量是否逐位相同」说不清。
    """
    enc = tk(
        text,
        truncation=True,
        max_length=window,
        stride=max(1, int(window * _WINDOW_STRIDE_RATIO)),
        return_overflowing_tokens=True,
        add_special_tokens=True,
    )
    return enc["input_ids"] or [[]]


def _window_texts(tk, text: str, window: int) -> list[str]:
    """窗口的**文本**形式（量窗口数、给尺子看）。装得下就原样一条。"""
    ids = _windows(tk, text, window)
    if len(ids) <= 1:
        return [text]
    return [tk.decode(w, skip_special_tokens=True) for w in ids]


def _pool(vectors, weights=None, mode: str | None = None) -> list[float]:
    """同一段文本的各窗口向量 → 一个向量，再重新归一化。Pure。

    **为什么不是等权平均**（都是量出来的）：等权平均把长块的头窗口稀释成一半，而头
    窗口正是块的主语所在——实测 B 档 hit@1 从 0.6471 掉到 0.5588，比不动还差。
    两种修法都试过：
      - `mean`：按 token 数加权，512 token 的头窗口天然压过几百 token 的尾窗口
        （B 档 hit@1 回到 0.5882，仍低于不动的 0.6471）；
      - `max`：逐维取最大——**头窗口的强项一个都不丢**，尾窗口只是往上加维度。
        平均会摊薄，取最大不会，这是它相对 mean 的全部理由。
    单个向量走同一条路（结果就是它自身），所以池化只有一种实现、没有分叉。
    """
    if len(vectors) == 0:
        return []
    arr = np.asarray(vectors, dtype=np.float32)
    if arr.ndim == 1:
        arr = arr[None, :]
    if (mode or _POOL_MODE) == "max":
        merged = arr.max(axis=0)
    else:
        if weights is None:
            w = np.ones(len(arr), dtype=np.float32)
        else:
            w = np.asarray(weights, dtype=np.float32)
        total = float(w.sum())
        merged = arr.mean(axis=0) if total <= 0 else (arr * (w / total)[:, None]).sum(axis=0)
    norm = float(np.linalg.norm(merged))
    return (merged / norm if norm else merged).tolist()


def embed(texts: list[str]) -> list[list[float]]:
    """Embed a batch of texts. 超窗的块窗口化 + 池化（默认逐维取最大），其余原样。

    整个「分词 + 编码」段在 `_encode_lock` 里串行——见那个锁的注释：不串行会偶发
    `RuntimeError: Already borrowed`，而并发检索是这个应用的常态。
    """
    if not texts:
        return []
    model = _get_model()
    window = int(model.max_seq_length)
    tk = model.tokenizer

    with _encode_lock:
        flat: list[str] = []
        spans: list[int] = []  # 每个原文本在 flat 里占了几条
        weights: list[float] = []  # 每条窗口的权重 = 它的 token 数
        for t in texts:
            ids = _windows(tk, t, window)
            if len(ids) <= 1:
                flat.append(t)
                weights.append(1.0)
            else:
                flat.extend(tk.decode(w, skip_special_tokens=True) for w in ids)
                weights.extend(float(len(w)) for w in ids)
            spans.append(max(1, len(ids)))

        vectors = model.encode(flat, normalize_embeddings=True, show_progress_bar=False)
    if len(flat) == len(texts):  # 没有块超窗：与改动前逐字相同的一条路径
        return [v.tolist() for v in vectors]

    out: list[list[float]] = []
    pos = 0
    for n in spans:
        out.append(_pool(vectors[pos : pos + n], weights[pos : pos + n]))
        pos += n
    return out


def embed_one(text: str) -> list[float]:
    return embed([text])[0]
