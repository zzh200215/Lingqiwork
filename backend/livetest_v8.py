"""Real end-to-end check for V8 voice input: Windows SAPI synthesizes a
Chinese sentence to WAV, faster-whisper (tiny, one-time ~75MB download)
transcribes it, and the router-level prefs mapping is exercised.

Run: python livetest_v8.py   (uses the real user cache — model stays for app use)
"""
import io
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, ".")

from fastapi import UploadFile

from app.core import asr  # noqa: E402
from app.core.prefs import save_config  # noqa: E402
from app.routers import asr as asr_router  # noqa: E402

WAV = Path(__file__).parent / ".livetest_v8.wav"
SENTENCE = "你好，帮我记一下明天上午十点开会"


def synth() -> None:
    ps = (
        "Add-Type -AssemblyName System.Speech;"
        "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer;"
        f"$s.SetOutputToWaveFile('{WAV}');"
        f"$s.Speak('{SENTENCE}');"
        "$s.Dispose()"
    )
    subprocess.run(["powershell", "-NoProfile", "-Command", ps], check=True, timeout=60)
    assert WAV.exists() and WAV.stat().st_size > 10_000, "SAPI wav too small"


def main() -> None:
    synth()
    print(f"sapi wav ok ({WAV.stat().st_size} bytes)")

    # core-level: real model (tiny, one-time download)
    t0 = time.time()
    result = asr.transcribe(str(WAV), "tiny", "zh")
    print(f"core transcribe ({time.time() - t0:.1f}s incl. download/load): {result}")
    assert result["text"], "empty transcription"

    # router-level: full request path with the configured prefs
    save_config({"asr_model": "tiny", "asr_language": "zh"})
    wav_bytes = WAV.read_bytes()

    async def through_router() -> dict:
        up = UploadFile(file=io.BytesIO(wav_bytes), filename="sapi.wav")
        return await asr_router.transcribe(up)

    import asyncio

    routed = asyncio.run(through_router())
    print(f"router transcribe: text={routed['text'][:50]}…, duration={routed['duration']}s")
    assert routed["text"], "router returned empty text"

    # language auto-detect path
    auto = asr.transcribe(str(WAV), "tiny", None)
    print(f"auto-detect: language={auto['language']}, text={auto['text'][:40]}")
    assert auto["duration"] > 0

    WAV.unlink(missing_ok=True)
    print("LIVE TEST PASS")


if __name__ == "__main__":
    main()
