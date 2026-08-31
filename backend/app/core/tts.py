"""Voice broadcast TTS: Microsoft edge-tts (neural) with a fully local
Windows SAPI fallback.

Why not a local neural model (Kokoro): the same text already crosses the
trust boundary to the cloud LLM that produced it, so edge-tts adds no new
exposure while sounding far better in Chinese; SAPI keeps the feature
working offline with zero model downloads. Synthesized files are cached by
content hash under data/tts/ and served from /api/tts/audio/.
"""
import asyncio
import hashlib
import logging
import re
import subprocess
from pathlib import Path

from app.config import DATA_DIR

log = logging.getLogger(__name__)

TTS_DIR = DATA_DIR / "tts"
MAX_CHARS = 5000
AUDIO_NAME_RE = re.compile(r"^[0-9a-f]{32}\.(mp3|wav)$")

VOICES = [
    "zh-CN-XiaoxiaoNeural",  # 晓晓 · 自然女声
    "zh-CN-XiaoyiNeural",  # 晓伊 · 甜美女声
    "zh-CN-YunxiNeural",  # 云希 · 轻松男声
    "zh-CN-YunyangNeural",  # 云扬 · 新闻男声
    "zh-CN-YunjianNeural",  # 云健 · 磁性男声
    "en-US-AriaNeural",
    "en-US-JennyNeural",
    "en-US-GuyNeural",
    "ja-JP-NanamiNeural",
]
ENGINES = ("edge", "sapi")

_SAPI_PS = (
    "Add-Type -AssemblyName System.Speech;"
    "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer;"
    "try {{ $s.SelectVoice('Microsoft Huihui Desktop') }} catch {{}};"
    "$s.SetOutputToWaveFile('{out}');"
    "$s.Speak((Get-Content -Raw -Encoding UTF8 '{txt}'));"
    "$s.Dispose()"
)


def _cache_key(text: str, voice: str, engine: str) -> Path:
    ext = "wav" if engine == "sapi" else "mp3"
    return TTS_DIR / f"{hashlib.md5(f'{engine}|{voice}|{text}'.encode()).hexdigest()}.{ext}"


def _run_sapi(text: str, out: Path) -> None:
    """Local Windows TTS via PowerShell System.Speech (blocking, offline)."""
    import tempfile

    txt = Path(tempfile.mkstemp(suffix=".txt", prefix="wb-tts-")[1])
    try:
        txt.write_text(text, encoding="utf-8")
        proc = subprocess.run(
            ["powershell", "-NoProfile", "-Command", _SAPI_PS.format(out=str(out), txt=str(txt))],
            capture_output=True,
            timeout=120,
        )
        if proc.returncode != 0 or not out.exists() or out.stat().st_size == 0:
            detail = proc.stderr.decode("utf-8", "ignore")[:200]
            raise RuntimeError(f"本地 SAPI 合成失败: {detail or 'no output'}")
    finally:
        try:
            txt.unlink(missing_ok=True)
        except OSError:
            pass  # Windows may still hold the handle right after PS exits


async def _run_edge(text: str, voice: str, out: Path) -> None:
    import edge_tts

    await edge_tts.Communicate(text, voice).save(str(out))


async def synthesize(text: str, voice: str = "", engine: str = "edge") -> dict:
    """Text → cached audio file. Returns {"url", "cached", "engine"}.

    edge failures fall back to local SAPI automatically; raises RuntimeError
    only when both engines fail. ValueError for empty/oversized input.
    """
    text = (text or "").strip()
    if not text:
        raise ValueError("文本为空")
    if len(text) > MAX_CHARS:
        raise ValueError(f"文本超过 {MAX_CHARS} 字上限")
    voice = voice if voice in VOICES else VOICES[0]
    engine = engine if engine in ENGINES else "edge"

    cache = _cache_key(text, voice, engine)
    if cache.exists() and cache.stat().st_size > 0:
        return {"url": f"/api/tts/audio/{cache.name}", "cached": True, "engine": engine}

    TTS_DIR.mkdir(parents=True, exist_ok=True)
    if engine == "sapi":
        await asyncio.to_thread(_run_sapi, text, cache)
    else:
        tmp = Path(str(cache) + ".part")
        try:
            await _run_edge(text, voice, tmp)
            tmp.replace(cache)
        except Exception as e:
            log.warning("edge-tts failed (%s); falling back to local SAPI", e)
            tmp.unlink(missing_ok=True)
            cache = _cache_key(text, "", "sapi")  # sapi output ignores the voice
            if not (cache.exists() and cache.stat().st_size > 0):
                await asyncio.to_thread(_run_sapi, text, cache)
            engine = "sapi"
    return {"url": f"/api/tts/audio/{cache.name}", "cached": False, "engine": engine}
