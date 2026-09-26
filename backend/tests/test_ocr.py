"""Offline tests for screenshot-Q&A OCR (V9): the bundled RapidOCR engine
runs for real on PIL-generated text images (no downloads, no network).

Env must be set before app imports.
"""
import asyncio
import atexit
import io
import shutil
import sys
import tempfile
from pathlib import Path

import pytest

sys.path.insert(0, ".")

# project-local scratch dir (system temp may be sandboxed)
_TMP = Path(tempfile.mkdtemp(prefix="wb-ocr-", dir=Path(".").resolve()))


def _cleanup() -> None:
    shutil.rmtree(_TMP, ignore_errors=True)


atexit.register(_cleanup)


from fastapi import HTTPException  # noqa: E402
from PIL import Image, ImageDraw, ImageFont  # noqa: E402

from app.core import ingest  # noqa: E402
from app.routers import images as images_router  # noqa: E402


def make_png(text: str, font_candidates: list[str], size: int = 96) -> bytes:
    img = Image.new("RGB", (140 + size * len(text), size * 3), "white")
    d = ImageDraw.Draw(img)
    font = None
    for cand in font_candidates:
        try:
            font = ImageFont.truetype(cand, size)
            break
        except OSError:
            continue
    if font is None:  # tiny bitmap fallback — still legible for OCR
        font = ImageFont.load_default()
        img = img.resize((600, 160))
        d = ImageDraw.Draw(img)
    d.text((40, size), text, fill="black", font=font)
    buf = io.BytesIO()
    img.save(buf, "PNG")
    return buf.getvalue()


def latin_png(text: str) -> bytes:
    return make_png(
        text,
        ["C:/Windows/Fonts/arial.ttf", "C:/Windows/Fonts/segoeui.ttf", "DejaVuSans.ttf"],
    )


def cjk_png(text: str) -> bytes:
    return make_png(
        text,
        ["C:/Windows/Fonts/msyh.ttc", "C:/Windows/Fonts/simhei.ttf", "C:/Windows/Fonts/simsun.ttc"],
        size=110,
    )


def test_ocr_reads_latin_text():
    text = ingest.ocr_bytes(latin_png("WORKBENCH-2026"))
    assert "2026" in text, text


def test_ocr_reads_chinese_text():
    text = ingest.ocr_bytes(cjk_png("你好工作台"))
    assert "工作台" in text, text


def test_ocr_garbage_raises():
    with pytest.raises(ValueError):
        ingest.ocr_bytes(b"definitely not an image")


def test_router_ocr_on_saved_upload():
    saved = images_router.images.save_upload(latin_png("2026"), "image/png")
    result = asyncio.run(images_router.ocr_image(images_router.OcrIn(name=saved["name"])))
    assert "2026" in result["text"], result


def test_router_rejects_bad_name():
    with pytest.raises(HTTPException) as ei:
        asyncio.run(images_router.ocr_image(images_router.OcrIn(name="../../secrets.db")))
    assert ei.value.status_code == 400


def test_router_missing_image_404():
    with pytest.raises(HTTPException) as ei:
        asyncio.run(images_router.ocr_image(images_router.OcrIn(name="img-20990101-000000-abc123.png")))
    assert ei.value.status_code == 404
