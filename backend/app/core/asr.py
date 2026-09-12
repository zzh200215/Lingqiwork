"""Local speech-to-text via faster-whisper (CPU, int8).

The model loads lazily on first use and stays warm; audio never leaves the
machine. Model size is a pref so the user trades first-run download against
Chinese accuracy (tiny ≈75MB, base ≈145MB, small ≈480MB).
"""
import logging
import os
import threading
import time

log = logging.getLogger(__name__)

AVAILABLE_MODELS = ("tiny", "base", "small", "medium")
DEFAULT_MODEL = "small"
LANGUAGES = ("auto", "zh", "en", "ja")
# direct huggingface.co is unreachable from CN networks; the mirror serves
# plain HTTP fine but not the Xet CAS backend. Only applied when the user
# hasn't chosen an endpoint themselves (env is read once at hub import).
_MIRROR_ENV = {"HF_ENDPOINT": "https://hf-mirror.com", "HF_HUB_DISABLE_XET": "1"}

# 尽早设置镜像：huggingface_hub 在首次 import 时读取一次 env，而 embedder/reranker
# 也会 import 它——等 ASR 首次转写再设就晚了，国内网络下 Whisper 模型下载会失败。
if not os.environ.get("HF_ENDPOINT"):
    for k, v in _MIRROR_ENV.items():
        os.environ.setdefault(k, v)

_model = None  # WhisperModel, created on first transcribe
_model_name = ""
_lock = threading.Lock()


def is_loaded() -> bool:
    return _model is not None


def _load(model_size: str):
    """Load (or swap) the model; thread-safe, warm across calls."""
    global _model, _model_name
    with _lock:
        if _model is not None and _model_name == model_size:
            return _model
        from faster_whisper import WhisperModel

        t0 = time.time()
        log.info("loading asr model %s (int8, cpu)…", model_size)
        m = WhisperModel(model_size, device="cpu", compute_type="int8")
        _model, _model_name = m, model_size
        log.info("asr model %s ready in %.1fs", model_size, time.time() - t0)
        return m


def resolve_language(pref: str | None) -> str | None:
    """'auto' (and anything unknown) means let whisper detect it."""
    return pref if pref in LANGUAGES and pref != "auto" else None


def prefs() -> tuple[str, str | None]:
    """(model_size, language) 来自用户配置——**引擎与路由共用这一条取值规则**。

    会议闭环的转写步骤（`core/tasks._transcribe`）不进路由，它得和语音输入走同一套设置。
    """
    from app.core.prefs import load_config

    cfg = load_config()
    size = cfg.get("asr_model") if cfg.get("asr_model") in AVAILABLE_MODELS else DEFAULT_MODEL
    return size, resolve_language(cfg.get("asr_language"))


def transcribe(path: str, model_size: str = "small", language: str | None = None) -> dict:
    """One audio file → {text, language, duration}. Blocking; run in a thread.

    Test seam: monkeypatch me to skip the real model.
    """
    model = _load(model_size)
    segments, info = model.transcribe(path, language=language, vad_filter=True)
    text = "".join(s.text for s in segments).strip()
    return {
        "text": text,
        "language": info.language,
        "duration": round(getattr(info, "duration", 0.0) or 0.0, 1),
    }
