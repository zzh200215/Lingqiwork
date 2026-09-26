"""编码路径的线程安全——这是**修一个真崩**的回归测试，要钉住。

HF 的 fast tokenizer 在**每次调用**里都会改写自己的截断/补齐配置
（`set_truncation_and_padding` → `self._tokenizer.enable_truncation()`），而那是同一个
Rust 对象。两种调用形态交错时会撞出 `RuntimeError: Already borrowed`：

    `_windows`     → `_encode_plus`（设截断）
    `model.encode` → `_batch_encode_plus`（设补齐）

实测单独跑任一种都干净，混着跑（也就是 `embed_one`）3 线程就能必现。而并发检索是这个
应用的常态（评测器 gather、引擎并行取材），所以 `embedder.embed` 里把「分词 + 编码」
串在 `_encode_lock` 下。

**为什么 skip 而不是 mock**：这条测的正是真 tokenizer 的行为，用假 tokenizer 就变成
在测假设。本地没缓存模型时跳过——CI 保持离线，而这台机器上它会真的跑。
"""
import sys
import threading

import pytest

sys.path.insert(0, ".")

from app.core import embedder  # noqa: E402

_TEXT = "并发编码用的中文句子 with English words 混排，长度足够触发真实分词路径。" * 6


def _run_concurrently(work, threads: int = 3):
    """跑 `threads` 条线程，收集异常。返回异常列表。"""
    errors: list[BaseException] = []

    def wrapped():
        try:
            work()
        except BaseException as e:  # noqa: BLE001 - 这里要的就是「有没有炸」
            errors.append(e)

    ts = [threading.Thread(target=wrapped) for _ in range(threads)]
    for t in ts:
        t.start()
    for t in ts:
        t.join()
    return errors


def test_concurrent_embed_one_does_not_trip_the_tokenizer():
    """并发 `embed_one`（= 并发检索时每个查询都要走的那条路）不许炸。"""
    if not embedder._model_cached():
        pytest.skip("本地没有模型缓存；这条测真 tokenizer，CI 保持离线")

    def work():
        for _ in range(30):
            embedder.embed_one(_TEXT)

    errors = _run_concurrently(work)
    assert not errors, f"并发编码炸了：{errors!r}"


def test_concurrent_mixed_window_and_encode_does_not_trip_the_tokenizer():
    """交错两种形态（超窗块走 `_windows`、短块走 `model.encode`）也要串行得住。

    只跑单形态是测不出来的——单独跑都通过，混着跑才是那个 `Already borrowed`。
    """
    if not embedder._model_cached():
        pytest.skip("本地没有模型缓存；这条测真 tokenizer，CI 保持离线")

    def work():
        for _ in range(15):
            embedder.embed([_TEXT, "短句"])

    errors = _run_concurrently(work)
    assert not errors, f"混合形态并发编码炸了：{errors!r}"


def test_embed_still_returns_one_vector_per_text():
    """串行化不该把「一个输入一个向量」这条契约弄丢。"""
    if not embedder._model_cached():
        pytest.skip("本地没有模型缓存；这条测真 tokenizer，CI 保持离线")

    out = embedder.embed([_TEXT, "短句"])
    assert len(out) == 2
    assert all(len(v) == 512 for v in out)
