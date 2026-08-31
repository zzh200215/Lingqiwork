"""Local embedding via sentence-transformers.

Model loaded lazily on first use (download happens on first run, then cached).
Default bge-small-zh-v1.5: good Chinese/English quality, ~100MB, fast on CPU.
If the model is already in the HF cache it is loaded offline — avoids
phone-home checks that can hang behind SSL-filtered networks.
"""
import os
import threading
from pathlib import Path

MODEL_NAME = "BAAI/bge-small-zh-v1.5"

_lock = threading.Lock()
_model = None


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


def embed(texts: list[str]) -> list[list[float]]:
    """Embed a batch of texts."""
    if not texts:
        return []
    model = _get_model()
    vectors = model.encode(
        texts,
        normalize_embeddings=True,
        show_progress_bar=False,
    )
    return [v.tolist() for v in vectors]


def embed_one(text: str) -> list[float]:
    return embed([text])[0]
