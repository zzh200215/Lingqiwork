"""Offline tests for local voice input (V8): endpoint validation, temp-file
handling, prefs resolution. The real faster-whisper model is behind the
asr.transcribe seam — never loaded here.

Env must be set before app imports.
"""
import asyncio
import atexit
import io
import os
import shutil
import sys
import tempfile
from pathlib import Path

import pytest
from fastapi import HTTPException, UploadFile

sys.path.insert(0, ".")

# project-local scratch dir (system temp may be sandboxed)
_TMP = Path(tempfile.mkdtemp(prefix="wb-asr-", dir=Path(".").resolve()))


def _cleanup() -> None:
    shutil.rmtree(_TMP, ignore_errors=True)


atexit.register(_cleanup)

# the router writes via tempfile.mkstemp — point it at the writable scratch dir
os.environ["TEMP"] = str(_TMP)
os.environ["TMP"] = str(_TMP)
tempfile.tempdir = str(_TMP)  # bypass gettempdir()'s env cache

from app.core import asr  # noqa: E402
from app.core.prefs import load_config, save_config  # noqa: E402
from app.routers import asr as asr_router  # noqa: E402


def _upload(data: bytes, filename: str = "audio.webm") -> UploadFile:
    return UploadFile(file=io.BytesIO(data), filename=filename)


@pytest.fixture(autouse=True)
def _env():
    save_config({"asr_model": "small", "asr_language": "auto"})
    yield
    save_config({"asr_model": "small", "asr_language": "auto"})


def test_resolve_language():
    assert asr.resolve_language("auto") is None
    assert asr.resolve_language(None) is None
    assert asr.resolve_language("zh") == "zh"
    assert asr.resolve_language("fr") is None  # unknown → detect


async def test_transcribe_rejects_empty():
    with pytest.raises(HTTPException) as ei:
        await asr_router.transcribe(_upload(b""))
    assert ei.value.status_code == 400


async def test_transcribe_rejects_oversize(monkeypatch):
    big = b"x" * (asr_router.MAX_AUDIO_BYTES + 1)
    with pytest.raises(HTTPException) as ei:
        await asr_router.transcribe(_upload(big))
    assert ei.value.status_code == 413


async def test_transcribe_happy_path_and_tmp_cleanup(monkeypatch):
    seen: dict = {}

    def fake_transcribe(path: str, model_size: str, language: str | None) -> dict:
        seen["exists_at_call"] = Path(path).exists()
        seen["model"] = model_size
        seen["language"] = language
        seen["suffix"] = Path(path).suffix
        return {"text": "你好世界", "language": "zh", "duration": 1.5}

    monkeypatch.setattr(asr, "transcribe", fake_transcribe)
    result = await asr_router.transcribe(_upload(b"fake-opus-bytes"))
    assert result["text"] == "你好世界"
    assert seen["exists_at_call"] is True
    assert seen["model"] == "small" and seen["language"] is None
    assert seen["suffix"] == ".webm"
    # the temp audio file must be gone after the request
    assert not list(_TMP.glob("wb-asr-*")), "temp audio not cleaned up"


async def test_transcribe_passes_language_pref(monkeypatch):
    save_config({"asr_language": "zh"})
    seen: dict = {}

    def fake_transcribe(path: str, model_size: str, language: str | None) -> dict:
        seen["language"] = language
        return {"text": "", "language": "zh", "duration": 0.0}

    monkeypatch.setattr(asr, "transcribe", fake_transcribe)
    await asr_router.transcribe(_upload(b"data", "clip.ogg"))
    assert seen["language"] == "zh"


async def test_missing_package_maps_to_503(monkeypatch):
    def no_pkg(path: str, model_size: str, language: str | None) -> dict:
        raise ImportError("No module named 'faster_whisper'")

    monkeypatch.setattr(asr, "transcribe", no_pkg)
    with pytest.raises(HTTPException) as ei:
        await asr_router.transcribe(_upload(b"data"))
    assert ei.value.status_code == 503
    assert "faster-whisper" in ei.value.detail


async def test_model_error_maps_to_502(monkeypatch):
    def boom(path: str, model_size: str, language: str | None) -> dict:
        raise RuntimeError("corrupt model file")

    monkeypatch.setattr(asr, "transcribe", boom)
    with pytest.raises(HTTPException) as ei:
        await asr_router.transcribe(_upload(b"data"))
    assert ei.value.status_code == 502


def test_status_shape():
    status = asyncio.run(asr_router.status())
    assert status["model"] in asr.AVAILABLE_MODELS
    assert status["language"] in ("auto", "zh", "en", "ja")
    assert status["models"] == list(asr.AVAILABLE_MODELS)
    assert isinstance(status["loaded"], bool)


def test_prefs_reject_bad_values():
    from pydantic import ValidationError

    from app.routers.settings import PrefsIn

    with pytest.raises(ValidationError):
        PrefsIn(asr_model="giant")
    with pytest.raises(ValidationError):
        PrefsIn(asr_language="fr")
    assert PrefsIn(asr_model="base", asr_language="zh").asr_model == "base"


def test_defaults_present():
    cfg = load_config()
    assert cfg["asr_model"] == "small" and cfg["asr_language"] == "auto"
