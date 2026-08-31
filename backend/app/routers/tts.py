"""Voice broadcast endpoints: text → audio file (cached, streamed back)."""
from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel

from app.core import tts

router = APIRouter(prefix="/api/tts", tags=["tts"])


class TtsIn(BaseModel):
    text: str
    voice: str = ""
    engine: str = "edge"


@router.get("/voices")
async def voices():
    return {"voices": tts.VOICES, "engines": list(tts.ENGINES), "max_chars": tts.MAX_CHARS}


@router.post("")
async def speak(body: TtsIn):
    try:
        return await tts.synthesize(body.text, body.voice, body.engine)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    except Exception as e:  # noqa: BLE001 - synth/network failures
        raise HTTPException(502, f"{type(e).__name__}: {e}") from e


@router.get("/audio/{name}")
async def audio(name: str):
    if not tts.AUDIO_NAME_RE.match(name):
        raise HTTPException(400, "非法文件名")
    path = tts.TTS_DIR / name
    if not path.exists():
        raise HTTPException(404, "音频不存在")
    return FileResponse(path, media_type="audio/wav" if name.endswith(".wav") else "audio/mpeg")
