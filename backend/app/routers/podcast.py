"""Notes → two-person podcast endpoints: generate (sync + SSE), list, stream, delete."""
import json

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel, field_validator

from app.core import podcast, tts

router = APIRouter(prefix="/api/podcast", tags=["podcast"])


class PodcastIn(BaseModel):
    paths: list[str]
    host_voice: str = ""
    guest_voice: str = ""
    title: str = ""

    @field_validator("host_voice", "guest_voice")
    @classmethod
    def _known_voice(cls, v: str) -> str:
        if v and v not in tts.VOICES:
            raise ValueError("音色不在可用列表中")
        return v


def _sse(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


@router.get("")
async def listing():
    return {"podcasts": podcast.list_podcasts()}


@router.post("/generate")
async def generate(body: PodcastIn):
    try:
        result = await podcast.generate(body.paths, body.host_voice, body.guest_voice, body.title)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    except Exception as e:  # noqa: BLE001 - LLM/TTS/IO failures
        raise HTTPException(502, f"{type(e).__name__}: {e}") from e
    if not result.get("ok"):
        raise HTTPException(400, result.get("error") or "生成失败")
    return result


class StuckPodcastIn(BaseModel):
    days: int = 90  # 只取最近 N 天的卡点


@router.post("/stuck")
async def stuck_podcast(body: StuckPodcastIn | None = None):
    """卡点 → 双人讨论播客（对话播客 2.0）。

    源材料是教学会话记下的卡点摘要而非对话逐字稿：播客讨论「这个卡点怎么
    想通」比逐字重放有用。拉取式——只有你点它才生成（第 2 节）。"""
    from app.core import tutor as tutor_core

    blocks = await tutor_core.stuck_blocks(days=body.days if body else 90)
    if not blocks:
        raise HTTPException(422, "最近没有卡点记录，先去学点东西")
    from datetime import datetime as _dt

    try:
        result = await podcast.generate_from_blocks(blocks, title=f"卡点讨论 · {_dt.now():%Y-%m-%d}")
    except Exception as e:  # noqa: BLE001 - LLM/TTS/IO failures
        raise HTTPException(502, f"{type(e).__name__}: {e}") from e
    if not result.get("ok"):
        raise HTTPException(400, result.get("error") or "生成失败")
    return result


@router.post("/generate/stream")
async def generate_stream(body: PodcastIn):
    """SSE variant of /generate: stage events for live UI progress."""
    try:
        blocks = podcast._collect_notes(body.paths)  # fail fast, before the stream
    except ValueError as e:
        raise HTTPException(400, str(e)) from e

    async def gen():
        try:
            async for event, data in podcast.generate_from_blocks_iter(
                blocks, body.host_voice, body.guest_voice, body.title
            ):
                yield _sse(event, data)
        except Exception as e:  # noqa: BLE001 - runner failures surface in-stream
            yield _sse("done", {"ok": False, "error": f"{type(e).__name__}: {e}"})

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.get("/audio/{name}")
async def audio(name: str):
    if not podcast.FILE_RE.match(name):
        raise HTTPException(400, "非法文件名")
    path = podcast.PODCAST_DIR / name
    if not path.exists():
        raise HTTPException(404, "音频不存在")
    return FileResponse(path, media_type="audio/wav")


@router.delete("/{pid}")
async def remove(pid: str):
    try:
        podcast.delete(pid)
    except FileNotFoundError:
        raise HTTPException(404, "播客不存在") from None
    return {"ok": True}
