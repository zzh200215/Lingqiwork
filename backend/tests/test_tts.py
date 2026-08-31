"""Offline tests for voice-broadcast TTS (V10): input guards, engine
normalization, the real local Windows SAPI engine, edge→sapi fallback, and
the audio-file cache. No network — edge-tts is monkeypatched.

Env must be set before app imports.
"""
import asyncio
import atexit
import os
import shutil
import sys
import tempfile
from pathlib import Path

import pytest

sys.path.insert(0, ".")

# project-local scratch dir (system temp may be sandboxed)
_TMP = Path(tempfile.mkdtemp(prefix="wb-tts-", dir=Path(".").resolve()))


def _cleanup() -> None:
    shutil.rmtree(_TMP, ignore_errors=True)


atexit.register(_cleanup)

os.environ["WB_DB_PATH"] = str(_TMP / "test.db")
os.environ["WB_CONFIG_PATH"] = str(_TMP / "config.json")
# SAPI fallback writes its text file via tempfile.mkstemp — point it at the
# writable scratch dir (system temp may be sandboxed under pytest)
os.environ["TEMP"] = str(_TMP)
os.environ["TMP"] = str(_TMP)
tempfile.tempdir = str(_TMP)  # bypass gettempdir()'s env cache

from fastapi import HTTPException  # noqa: E402

from app.core import tts  # noqa: E402
from app.routers import tts as tts_router  # noqa: E402


@pytest.fixture(autouse=True)
def _env(monkeypatch):
    monkeypatch.setattr(tts, "TTS_DIR", _TMP / "tts")
    yield


def test_synthesize_guards():
    with pytest.raises(ValueError):
        asyncio.run(tts.synthesize("   "))
    with pytest.raises(ValueError):
        asyncio.run(tts.synthesize("长" * (tts.MAX_CHARS + 1)))


def test_voice_and_engine_normalization():
    seen: dict = {}

    async def fake_edge(text: str, voice: str, out: Path) -> None:
        seen["voice"] = voice
        out.write_bytes(b"mp3")

    monkey_flag = tts._run_edge
    tts._run_edge = fake_edge
    try:
        r = asyncio.run(tts.synthesize("你好", voice="not-a-voice", engine="bogus"))
    finally:
        tts._run_edge = monkey_flag
    assert seen["voice"] == tts.VOICES[0]  # unknown voice → default
    assert r["engine"] == "edge" and r["url"].endswith(".mp3")


def test_sapi_engine_runs_for_real():
    """The fully-local fallback is exercised for real (PowerShell SAPI)."""
    r = asyncio.run(tts.synthesize("你好，工作台语音播报实测。", engine="sapi"))
    path = _TMP / "tts" / Path(r["url"]).name
    assert r["engine"] == "sapi" and r["url"].endswith(".wav")
    assert path.exists() and path.stat().st_size > 5000, path
    assert tts.AUDIO_NAME_RE.match(Path(r["url"]).name)


def test_cache_hit_is_cached():
    asyncio.run(tts.synthesize("缓存这条", engine="sapi"))
    r2 = asyncio.run(tts.synthesize("缓存这条", engine="sapi"))
    assert r2["cached"] is True


def test_edge_failure_falls_back_to_sapi(monkeypatch):
    async def boom(text: str, voice: str, out: Path) -> None:
        raise RuntimeError("network unreachable")

    monkeypatch.setattr(tts, "_run_edge", boom)
    r = asyncio.run(tts.synthesize("回退测试", voice="zh-CN-YunxiNeural"))
    assert r["engine"] == "sapi"
    path = _TMP / "tts" / Path(r["url"]).name
    assert path.exists() and path.stat().st_size > 5000


def test_voice_is_part_of_cache_key(monkeypatch):
    seen: list[str] = []

    async def fake_edge(text: str, voice: str, out: Path) -> None:
        seen.append(voice)
        out.write_bytes(b"mp3")

    monkeypatch.setattr(tts, "_run_edge", fake_edge)
    r1 = asyncio.run(tts.synthesize("同文", voice=tts.VOICES[0]))
    r2 = asyncio.run(tts.synthesize("同文", voice=tts.VOICES[2]))
    assert r1["url"] != r2["url"] and len(seen) == 2  # no false cache hit


async def test_router_speak_validation(monkeypatch):
    with pytest.raises(HTTPException) as ei:
        await tts_router.speak(tts_router.TtsIn(text="  "))
    assert ei.value.status_code == 400

    async def fake(text: str, voice: str = "", engine: str = "edge") -> dict:
        return {"url": "/api/tts/audio/" + "0" * 32 + ".mp3", "cached": False, "engine": "edge"}

    monkeypatch.setattr(tts, "synthesize", fake)
    r = await tts_router.speak(tts_router.TtsIn(text="hi"))
    assert r["engine"] == "edge"


async def test_router_audio_guards():
    with pytest.raises(HTTPException) as ei:
        await tts_router.audio("../evil.wav")
    assert ei.value.status_code == 400
    with pytest.raises(HTTPException) as ei:
        await tts_router.audio("0" * 32 + ".mp3")
    assert ei.value.status_code == 404


def test_prefs_reject_bad_tts_values():
    from pydantic import ValidationError

    from app.routers.settings import PrefsIn

    with pytest.raises(ValidationError):
        PrefsIn(tts_voice="bogus-voice")
    with pytest.raises(ValidationError):
        PrefsIn(tts_engine="kokoro")
    assert PrefsIn(tts_engine="sapi").tts_engine == "sapi"
