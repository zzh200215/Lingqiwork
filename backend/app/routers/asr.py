"""Local voice input: mic audio → faster-whisper transcription.

Audio is uploaded as webm/opus (MediaRecorder) or any container PyAV can
decode, transcribed on-CPU in a worker thread, and the temp file is deleted.
No network calls after the one-time model download.
"""
import asyncio
import logging
import os
import tempfile
from pathlib import Path

from fastapi import APIRouter, File, HTTPException, UploadFile

from app.core import asr
from app.core.prefs import load_config

log = logging.getLogger(__name__)

router = APIRouter(prefix="/api/asr", tags=["asr"])

MAX_AUDIO_BYTES = 25 * 1024 * 1024  # ≈ several minutes of opus at 32kbps
DEFAULT_MODEL = "small"


def _asr_prefs() -> tuple[str, str | None]:
    cfg = load_config()
    model = cfg.get("asr_model") if cfg.get("asr_model") in asr.AVAILABLE_MODELS else DEFAULT_MODEL
    return model, asr.resolve_language(cfg.get("asr_language"))


@router.get("/status")
async def status():
    model, language = _asr_prefs()
    return {
        "model": model,
        "language": language or "auto",
        "loaded": asr.is_loaded(),
        "models": list(asr.AVAILABLE_MODELS),
    }


@router.post("/transcribe")
async def transcribe(file: UploadFile = File(...)):
    data = await file.read()
    if not data:
        raise HTTPException(400, "空音频文件")
    if len(data) > MAX_AUDIO_BYTES:
        raise HTTPException(413, "音频超过 25MB 上限")

    model_size, language = _asr_prefs()
    suffix = Path(file.filename or "audio.webm").suffix or ".webm"
    fd, tmp_path = tempfile.mkstemp(suffix=suffix, prefix="wb-asr-")
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
        try:
            return await asyncio.to_thread(asr.transcribe, tmp_path, model_size, language)
        except ImportError:
            raise HTTPException(
                503, "未安装 faster-whisper：在 backend 目录执行 uv sync 或 uv pip install faster-whisper"
            ) from None
        except Exception as e:  # noqa: BLE001 - decode/model/download failures
            log.exception("transcription failed")
            raise HTTPException(502, f"{type(e).__name__}: {e}") from e
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
