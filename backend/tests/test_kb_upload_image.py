"""图片上传走 OCR 的离线测试。

OCR 与索引都换成假的——这里验的是路由逻辑（走哪条路、落哪、出错怎么报），不是
RapidOCR 准不准。真链路由手工 drill 验。
"""
import asyncio
import io
import sys
from pathlib import Path

import pytest
from fastapi import HTTPException
from starlette.datastructures import UploadFile

sys.path.insert(0, ".")

from app.routers import kb  # noqa: E402


@pytest.fixture
def indexed(monkeypatch) -> list[Path]:
    """假 OCR + 假索引；返回被索引的路径列表供断言。"""
    seen: list[Path] = []

    def fake_index(path, **kw):
        seen.append(Path(path))
        return 7

    monkeypatch.setattr(kb.indexer, "index_file", fake_index)
    monkeypatch.setattr(kb.ingest, "ocr_bytes", lambda data: "图里的字")
    return seen


def _upload(name: str, data: bytes = b"\x89PNG\r\n\x1a\n fake") -> UploadFile:
    return UploadFile(file=io.BytesIO(data), filename=name)


def _clippings() -> set[Path]:
    return set(kb._CLIP_DIR.glob("*.md")) if kb._CLIP_DIR.exists() else set()


def test_image_goes_through_ocr_into_clippings(indexed):
    r = asyncio.run(kb.kb_upload(_upload("shot.png")))

    assert r["filename"].startswith("clippings/")
    assert r["chunks"] == 7  # 索引函数的返回值原样带回
    assert r["chars"] == len("图里的字")

    dest = kb.VAULT_DIR / r["filename"]
    assert dest.exists()
    text = dest.read_text(encoding="utf-8")
    assert "图里的字" in text
    assert "剪藏自图片" in text  # 落的是文字，不是图片文件
    assert indexed == [dest]  # 落盘之后确实进了索引


def test_image_suffix_is_case_insensitive(indexed):
    r = asyncio.run(kb.kb_upload(_upload("SHOT.PNG")))
    assert r["filename"].startswith("clippings/")


def test_blank_ocr_is_422_and_leaves_no_file(indexed, monkeypatch):
    monkeypatch.setattr(kb.ingest, "ocr_bytes", lambda data: "   ")
    before = _clippings()

    with pytest.raises(HTTPException) as e:
        asyncio.run(kb.kb_upload(_upload("shot.png")))

    assert e.value.status_code == 422
    assert "没识别出文字" in e.value.detail
    assert _clippings() == before  # 不落空文件：空 md 会一直躺在库里被检索到
    assert indexed == []


def test_ocr_failure_is_422_not_500(indexed, monkeypatch):
    def boom(data):
        raise RuntimeError("onnxruntime 没装")

    monkeypatch.setattr(kb.ingest, "ocr_bytes", boom)
    before = _clippings()

    with pytest.raises(HTTPException) as e:
        asyncio.run(kb.kb_upload(_upload("shot.png")))

    assert e.value.status_code == 422
    assert "OCR 失败" in e.value.detail
    assert _clippings() == before


def test_documents_still_land_in_vault_root(indexed):
    """非图片的行为逐字节不变：原件落 vault 根目录，图片那条路不碰它。"""
    r = asyncio.run(kb.kb_upload(_upload("note.md", b"# hi")))

    assert not r["filename"].startswith("clippings/")
    assert r["filename"].endswith(".md")
    assert (kb.VAULT_DIR / r["filename"]).read_bytes() == b"# hi"


def test_unsupported_type_still_400(indexed):
    with pytest.raises(HTTPException) as e:
        asyncio.run(kb.kb_upload(_upload("evil.exe", b"MZ")))
    assert e.value.status_code == 400
    assert "unsupported" in e.value.detail
