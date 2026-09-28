"""Knowledge base endpoints: stats, reindex, search debug, vial listing, upload."""
import asyncio
import re
import uuid
from datetime import datetime
from pathlib import Path

from fastapi import APIRouter, HTTPException, UploadFile
from pydantic import BaseModel

from app.config import VAULT_DIR
from app.core import indexer, ingest
from app.core.watcher import watcher

router = APIRouter(prefix="/api/kb", tags=["kb"])

_MAX_UPLOAD = 50 * 1024 * 1024  # 50MB per file
_SAFE_NAME = re.compile(r"[^\w.\-]+", re.UNICODE)
# 图片不是 ingest 能解析的文档，但截图是很常见的一种「材料」——它走 OCR 落成文字。
_IMAGE_EXT = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif", ".tif", ".tiff"}

# indexing is CPU-bound (embedding); run in a thread to not block the loop


class ClipIn(BaseModel):
    url: str
    title: str | None = None


@router.get("/stats")
async def kb_stats():
    return {**indexer.stats(), "watcher": watcher.status}


@router.get("/drift")
async def kb_drift():
    """磁盘内容变了、索引里还是旧哈希的来源。按需跑——要读全部文件算哈希。"""
    sources = await asyncio.to_thread(indexer.drifted)
    return {"drifted": sources, "count": len(sources)}


@router.post("/reindex")
async def kb_reindex():
    """全量重建。占 `inflight` 锁：分钟级操作，并发两次是两倍算力；锁也让
    `/reindex/cancel` 有明确目标。合作式取消——逐文件生效，见 `indexer.reindex_all`。"""
    from app.core import inflight

    if not inflight.try_acquire("kb_reindex"):
        raise HTTPException(409, "已经在重建索引了——等它完成，或先点「停止」。")
    try:
        result = await asyncio.to_thread(indexer.reindex_all, cancel_key="kb_reindex")
    finally:
        inflight.release("kb_reindex")
    return result


@router.post("/reindex/cancel")
async def kb_reindex_cancel():
    """请正在跑的重建停下。**合作式**：当前这个文件做完才停——界面上写
    「正在停…」，不写「已停止」。没在跑的如实回 `stopped: false`。"""
    from app.core import inflight

    return {"stopped": inflight.request_cancel("kb_reindex")}


@router.post("/digest/run")
async def kb_digest_run():
    """Manually trigger a vault digest (same code path as the daily schedule)."""
    from app.core import digest

    return await digest.generate_digest()


@router.get("/search")
async def kb_search(q: str, top_k: int = 5):
    if not q.strip():
        raise HTTPException(400, "empty query")
    hits = await asyncio.to_thread(indexer.search_auto, q.strip(), top_k)
    return {"query": q, "hits": hits}


class QueryIn(BaseModel):
    query: str
    top_k: int = 5


@router.post("/search")
async def kb_search_post(body: QueryIn):
    hits = await asyncio.to_thread(indexer.search_auto, body.query.strip(), body.top_k)
    return {"query": body.query, "hits": hits}


@router.get("/files")
async def kb_files():
    """List indexed-source candidates in the vault (with size + mtime for the table UI)."""
    entries: list[dict] = []
    for p in VAULT_DIR.rglob("*"):
        if not p.is_file() or not ingest.is_supported(p):
            continue
        st = p.stat()
        entries.append(
            {
                "path": p.relative_to(VAULT_DIR).as_posix(),
                "size": st.st_size,
                "mtime": int(st.st_mtime),
            }
        )
    entries.sort(key=lambda e: e["path"])
    return {"vault_dir": str(VAULT_DIR), "files": entries}


@router.post("/upload")
async def kb_upload(file: UploadFile):
    """Save an uploaded document into the vault and index it immediately.

    图片是例外：它本身进不了 RAG（embedding 的是文字），所以走 OCR 落成 md。
    """
    original = Path(file.filename or "upload")
    ext = original.suffix.lower()
    if ext not in _IMAGE_EXT and not ingest.is_supported(original):
        raise HTTPException(400, f"unsupported file type: {original.suffix}")

    data = await file.read()
    if len(data) > _MAX_UPLOAD:
        raise HTTPException(413, f"file too large (> {_MAX_UPLOAD // (1024**2)}MB)")

    safe_stem = _SAFE_NAME.sub("_", original.stem).strip("_") or "upload"
    if ext in _IMAGE_EXT:
        return await _ocr_into_vault(data, safe_stem)

    dest = VAULT_DIR / f"{safe_stem}-{uuid.uuid4().hex[:6]}{original.suffix}"
    dest.write_bytes(data)

    # index immediately (watcher will also pick it up, but this gives a sync result)
    chunks = await asyncio.to_thread(indexer.index_file, dest)
    return {
        "filename": dest.relative_to(VAULT_DIR).as_posix(),
        "size": len(data),
        "chunks": chunks,
    }


_CLIP_DIR = VAULT_DIR / "clippings"
_CLIP_MAX = 200_000  # chars of extracted text


async def _ocr_into_vault(data: bytes, safe_stem: str) -> dict:
    """图片 → 本地 OCR 文本 → `vault/clippings/<名>.md` + 索引。

    截图是常见的一种材料，但图片本身进不了 RAG——所以落的是识别出来的字。
    识别不出内容（或 OCR 依赖缺失）时给 422 一句人话，**不落空文件**：一个空 md
    会一直躺在库里被检索到，比当场报错更烦人。
    """
    try:
        text = (await asyncio.to_thread(ingest.ocr_bytes, data)).strip()
    except Exception as e:  # noqa: BLE001 - 依赖缺失 / 图片坏了，都要变成一句人话
        raise HTTPException(422, f"OCR 失败：{type(e).__name__}: {e}") from e
    if not text:
        raise HTTPException(422, "这张图里没识别出文字")

    _CLIP_DIR.mkdir(parents=True, exist_ok=True)
    dest = _CLIP_DIR / f"{safe_stem}-{uuid.uuid4().hex[:6]}.md"
    dest.write_text(
        f"# {safe_stem}\n\n> 剪藏自图片 · {datetime.now().strftime('%Y-%m-%d %H:%M')}\n\n{text}\n",
        encoding="utf-8",
    )
    chunks = await asyncio.to_thread(indexer.index_file, dest)
    return {
        "filename": dest.relative_to(VAULT_DIR).as_posix(),
        "size": len(data),
        "chars": len(text),
        "chunks": chunks,
    }


@router.post("/clip")
async def kb_clip(body: ClipIn):
    """Fetch a web page, extract readable text, save as md in vault/clippings/, index."""
    from app.core.mcp import mcp_manager

    url = body.url.strip()
    if not re.match(r"^https?://", url, re.I):
        raise HTTPException(400, "url must start with http(s)://")

    # reuse the built-in fetch_url handler for HTML -> text
    text = (await mcp_manager.call_tool("fetch_url", {"url": url})).strip()
    if text.startswith("[tool error]") or text.startswith("[错误]"):
        raise HTTPException(502, f"fetch failed: {text}")
    if len(text) > _CLIP_MAX:
        text = text[:_CLIP_MAX] + "\n\n...[已截断]"
    if not text or text == "(页面没有可读正文)":
        raise HTTPException(422, "页面没有可提取的正文")

    title = (body.title or "").strip() or url.split("//")[-1].split("/")[0]
    safe_title = _SAFE_NAME.sub("_", title).strip("_")[:60] or "clip"
    dest = _CLIP_DIR / f"{safe_title}-{uuid.uuid4().hex[:6]}.md"
    _CLIP_DIR.mkdir(parents=True, exist_ok=True)
    dest.write_text(
        f"# {title}\n\n> 剪藏自 {url} · {datetime.now().strftime('%Y-%m-%d %H:%M')}\n\n{text}\n",
        encoding="utf-8",
    )
    chunks = await asyncio.to_thread(indexer.index_file, dest)
    return {
        "filename": dest.relative_to(VAULT_DIR).as_posix(),
        "title": title,
        "chars": len(text),
        "chunks": chunks,
    }


class TextClipIn(BaseModel):
    text: str
    title: str | None = None


@router.post("/clip_text")
async def kb_clip_text(body: TextClipIn):
    """剪藏一段选中的文本（划词助手「剪藏」动作）。

    与 /clip 的分工：/clip 抓网页正文，这里直接落盘所选文本。剪藏是「保存」
    而不是「提问」——落盘 + 索引即结束，watcher 随后让它进 RAG。"""
    text = body.text.strip()
    if not text:
        raise HTTPException(400, "text 不能为空")
    if len(text) > _CLIP_MAX:
        text = text[:_CLIP_MAX] + "\n\n...[已截断]"
    title = (body.title or "").strip() or text[:40].split("\n")[0]
    safe_title = _SAFE_NAME.sub("_", title).strip("_")[:60] or "clip"
    dest = _CLIP_DIR / f"{safe_title}-{uuid.uuid4().hex[:6]}.md"
    _CLIP_DIR.mkdir(parents=True, exist_ok=True)
    dest.write_text(
        f"# {title}\n\n> 剪藏自划词 · {datetime.now().strftime('%Y-%m-%d %H:%M')}\n\n{text}\n",
        encoding="utf-8",
    )
    chunks = await asyncio.to_thread(indexer.index_file, dest)
    return {
        "filename": dest.relative_to(VAULT_DIR).as_posix(),
        "title": title,
        "chars": len(text),
        "chunks": chunks,
    }
