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

# indexing is CPU-bound (embedding); run in a thread to not block the loop


class ClipIn(BaseModel):
    url: str
    title: str | None = None


@router.get("/stats")
async def kb_stats():
    return {**indexer.stats(), "watcher": watcher.status}


@router.post("/reindex")
async def kb_reindex():
    result = await asyncio.to_thread(indexer.reindex_all)
    return result


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
    """Save an uploaded document into the vault and index it immediately."""
    original = Path(file.filename or "upload")
    if not ingest.is_supported(original):
        raise HTTPException(400, f"unsupported file type: {original.suffix}")

    data = await file.read()
    if len(data) > _MAX_UPLOAD:
        raise HTTPException(413, f"file too large (> {_MAX_UPLOAD // (1024**2)}MB)")

    safe_stem = _SAFE_NAME.sub("_", original.stem).strip("_") or "upload"
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
