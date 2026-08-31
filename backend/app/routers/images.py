"""Generated image store: config, generate on demand, serve, delete.

Files live in data/images/ and are served at /api/images/{name} — the same URL
that gets embedded in chat messages and notes.
"""
import asyncio
import logging

from fastapi import APIRouter, File, HTTPException, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel

from app.core import images

log = logging.getLogger(__name__)

router = APIRouter(prefix="/api/images", tags=["images"])


class GenerateIn(BaseModel):
    prompt: str
    size: str = ""
    model: str = ""
    n: int = 1


class OcrIn(BaseModel):
    name: str


@router.get("")
async def list_images():
    return {"config": images.config(), "images": images.list_images()}


@router.post("/generate")
async def generate(body: GenerateIn):
    try:
        return await images.generate(body.prompt, size=body.size, model=body.model, n=body.n)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    except Exception as e:  # noqa: BLE001 - upstream/network failure
        log.exception("image generation failed")
        raise HTTPException(502, f"{type(e).__name__}: {e}") from e


@router.post("/upload")
async def upload_image(file: UploadFile = File(...)):
    """Store a user-pasted/uploaded image (chat attachments)."""
    data = await file.read()
    try:
        return images.save_upload(data, file.content_type or "")
    except ValueError as e:
        raise HTTPException(400, str(e)) from e


@router.post("/ocr")
async def ocr_image(body: OcrIn):
    """Local OCR (RapidOCR) over a stored image — the no-vision-model path
    for screenshot Q&A."""
    from app.core import ingest

    try:
        path = images.resolve_name(body.name)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    if not path.exists():
        raise HTTPException(404, "图片不存在")
    try:
        text = await asyncio.to_thread(ingest.ocr_bytes, path.read_bytes())
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    return {"text": text}


@router.get("/{name}")
async def get_image(name: str):
    try:
        path = images.resolve_name(name)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    if not path.exists():
        raise HTTPException(404, "图片不存在")
    return FileResponse(path)


@router.delete("/{name}")
async def delete_image(name: str):
    try:
        ok = images.delete_image(name)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    if not ok:
        raise HTTPException(404, "图片不存在")
    return {"ok": True}
