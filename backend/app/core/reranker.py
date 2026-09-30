"""Cross-encoder reranking for retrieval precision (bge-reranker).

The model is loaded lazily on first use (CPU) — it only runs when
rerank_enabled is on and there are candidates to score. Local HF cache is
expected at ~/.cache/huggingface/hub/models--BAAI--bge-reranker-base.

**处置更新（2026-09-28，用户决策）**：不做「30 天用量裁决删留」，**本功能保留**——
转入优化升级路线；设置页已有 `rerank_enabled` 开关，要开它随时可以。

**对照已跑（2026-09-30，`backend/rerank_ab.py`，34 题在库金标）**：rerank 开
hit@1 0.618→0.588、MRR 0.721→0.702（11 题排序变化，6 升 5 降 1 跌出），耗时
4s→512s（≈15s/题的 CPU 重排）。**排序收益为负、延迟成本巨大——保持默认关**；
要翻案先换更小的重排模型或减候选池，再跑同一脚本复测。
（历史：2026-09-27 CTO review #3 曾定「封存观察、零使用则删除裁决」，已被上述决策取代。）
"""
import logging
import os
import threading
from pathlib import Path

log = logging.getLogger(__name__)

MODEL_ID = "BAAI/bge-reranker-base"

_lock = threading.Lock()
_model = None


def _model_cached() -> bool:
    hf_home = os.environ.get("HF_HOME") or str(Path.home() / ".cache" / "huggingface")
    return (Path(hf_home) / "hub" / f"models--{MODEL_ID.replace('/', '--')}").exists()


def _get_model():
    global _model
    with _lock:
        if _model is None:
            from sentence_transformers import CrossEncoder

            log.info("loading reranker %s (cpu)", MODEL_ID)
            # local cache avoids HF phone-home checks that hang on this network
            _model = CrossEncoder(MODEL_ID, device="cpu", local_files_only=_model_cached())
        return _model


def rerank(query: str, hits: list[dict], top_k: int | None = None) -> list[dict]:
    """Re-score hits by cross-encoder relevance. Returns re-sorted copies.

    Hits keep their original fields; `score` becomes the rerank score
    (sigmoid → 0..1) and `channels` gains "rerank". On any failure the
    input order is returned unchanged (rerank must never break retrieval).
    """
    if not hits:
        return []
    pairs = [(query, h["text"]) for h in hits]
    try:
        model = _get_model()
    except Exception as e:  # noqa: BLE001 - model load failure falls back
        log.warning("reranker load failed: %s", e)
        return hits[:top_k] if top_k else hits
    try:
        import numpy as np

        scores = model.predict(pairs, batch_size=16)
        probs = 1.0 / (1.0 + np.exp(-scores))  # sigmoid to [0,1]
    except Exception as e:  # noqa: BLE001
        log.warning("rerank predict failed: %s", e)
        return hits[:top_k] if top_k else hits

    out = []
    for hit, p in sorted(zip(hits, probs), key=lambda t: t[1], reverse=True):
        h = dict(hit)
        h["score"] = round(float(p), 4)
        h["channels"] = sorted(set(h.get("channels", [])) | {"rerank"})
        out.append(h)
    return out[:top_k] if top_k else out
