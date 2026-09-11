"""Index pipeline: vault files -> chunks -> embeddings -> ChromaDB.

Design: vault markdown/pdf/docx files are the source of truth. ChromaDB holds
vectors; SQLite is not involved in indexing (chunk metadata lives in Chroma's
own metadata). Reindexing is idempotent — a file's chunks are replaced
atomically by upsert with deterministic chunk ids derived from (path, index).
"""
import logging
import re
import threading
import time
from pathlib import Path

import chromadb
from langchain_text_splitters import RecursiveCharacterTextSplitter

from app.config import VAULT_DIR, settings
from app.core import embedder, ingest

log = logging.getLogger(__name__)

# set by retriever (optional import cycle guard); called after index mutations
_on_index_change = None


def notify_index_change() -> None:
    if _on_index_change is not None:
        try:
            _on_index_change()
        except Exception:  # noqa: BLE001
            pass

CHUNK_SIZE = 800
CHUNK_OVERLAP = 120
MIN_CHUNK = 200  # 低于这个长度的块尽量并进邻居——太碎的块检索价值低
# 合并时允许超出 CHUNK_SIZE，但不超过 CHUNK_SIZE + CHUNK_OVERLAP：那是既有测试
# （`test_chunks_stay_within_budget`）已经认可的上界。
CHUNK_SOFT_MAX = CHUNK_SIZE + CHUNK_OVERLAP
# 切法一变就 +1。块元数据里带着它，对不上就是「这份索引是旧切法切的，该重建了」——
# 这是第 10.1 节第 2 条要的版本契约里最小的一块（内容哈希与模型版本戳仍未做）。
CHUNKER_VERSION = 2
COLLECTION = "workbench_kb"
REPO_SOURCE_PREFIX = "repos/"  # sources cloned from git live outside the vault
DIR_SOURCE_PREFIX = "dirs/"  # registered external folders (core/dirs.py)
EXTERNAL_PREFIXES = (REPO_SOURCE_PREFIX, DIR_SOURCE_PREFIX)  # not owned by vault rebuilds

_splitter = RecursiveCharacterTextSplitter(
    chunk_size=CHUNK_SIZE,
    chunk_overlap=CHUNK_OVERLAP,
    # 只切到二级/三级标题（\n## \n###）：vault 笔记的一级标题是「文档标题」而非
    # 「章节」，一个文档只有一个，不需要按它切。刻意不加 \n# —— 加了反而会在
    # 正文接近 chunk_size 时把标题孤立成一个 8 字符的小块（标题+正文 > chunk_size
    # 无法合并），检索价值更低。
    separators=["\n## ", "\n### ", "\n\n", "\n", "。", "！", "？", ".", "!", "?", " ", ""],
)

_client: chromadb.ClientAPI | None = None
_client_lock = threading.Lock()


def get_client() -> chromadb.ClientAPI:
    """Lazy singleton. Double-checked locking: concurrent first calls (parallel
    RAG requests right after startup) would otherwise each construct a client
    and crash on chroma's half-initialized bindings."""
    global _client
    if _client is None:
        with _client_lock:
            if _client is None:
                _client = chromadb.PersistentClient(path=str(settings.chroma_path))
    return _client


def get_collection():
    return get_client().get_or_create_collection(
        COLLECTION,
        # embeddings are provided explicitly; this function is never called by chroma
        configuration={"hnsw": {"space": "cosine"}},
    )


def _chunk_id(rel_path: str, idx: int) -> str:
    return f"{rel_path}::{idx}"


def _is_orphan_heading(chunk: str) -> bool:
    """只有标题、没有正文的孤立小块——切分器用 \\n\\n 把标题从正文剥离开的产物。"""
    return chunk.startswith("#") and len(chunk) < 60


def _is_noise(chunk: str) -> bool:
    """只有分隔线/符号/空白的块。实测 1059 个块里有一批就是一行 `---`：占着索引名额、
    还可能被检索到，但它不承载任何东西。Pure.

    **标题不算噪音**——它交给「并进下一块」那一步（标题必须有正文跟着），否则
    「## 标题」剥掉 `#` 只剩两三个字，会被这一条先丢掉。
    """
    if chunk.lstrip().startswith("#"):
        return False
    return len(re.sub(r"[\s\-_*#=`~>|+]+", "", chunk)) < 8


def chunk_text(text: str) -> list[str]:
    """结构感知的切分（PLAN §10.2「检索」的语义分块）。

    三步：
    1. **丢掉纯符号块**（`---` 这类）——它们不承载内容，只是占名额。
    2. **孤立标题并进下一块**：标题必须和它的正文在一起（切分器用 `\\n\\n` 会把
       「## 标题」从正文剥离开）；文档以标题结尾时并进上一块。
    3. **太碎的块并进上一块**：零碎尾巴属于上一节。**以标题开头的块不并**——那是真的
       一节（哪怕短），并进上一节就把章节边界切错了。
    """
    raw = [c.strip() for c in _splitter.split_text(text) if c.strip()]
    raw = [c for c in raw if not _is_noise(c)]

    merged: list[str] = []
    pending = ""
    for cur in raw:
        if _is_orphan_heading(cur):
            pending = f"{pending}\n{cur}" if pending else cur
            continue
        merged.append(f"{pending}\n{cur}" if pending else cur)
        pending = ""
    if pending:  # 文档以标题结尾
        if merged:
            merged[-1] = f"{merged[-1]}\n{pending}"
        else:
            merged.append(pending)

    out: list[str] = []
    for cur in merged:
        if (
            out
            and len(cur) < MIN_CHUNK
            and not cur.lstrip().startswith("#")
            and len(out[-1]) + len(cur) + 1 <= CHUNK_SOFT_MAX
        ):
            out[-1] = f"{out[-1]}\n{cur}"
        else:
            out.append(cur)
    # 第一块太碎、又没有上一块可并 → 并进下一块
    if len(out) > 1 and len(out[0]) < MIN_CHUNK and len(out[0]) + len(out[1]) + 1 <= CHUNK_SOFT_MAX:
        out = [f"{out[0]}\n{out[1]}", *out[2:]]
    return out


def index_file(path: Path, root: Path = VAULT_DIR, source_prefix: str = "") -> int:
    """(Re)index one file. Returns number of chunks stored.

    `source_prefix` namespaces sources that live outside the vault (cloned
    repos use "repos/<name>"), keeping them distinct from vault-relative paths.
    """
    rel = path.relative_to(root).as_posix()
    if source_prefix:
        rel = f"{source_prefix.rstrip('/')}/{rel}"
    col = get_collection()

    text = ingest.parse_file(path)
    chunks = chunk_text(text)
    if not chunks:
        delete_source(rel)
        return 0

    vectors = embedder.embed(chunks)
    new_ids = [_chunk_id(rel, i) for i in range(len(chunks))]
    # 先 upsert 再清残留：delete 放到 upsert 之后，并发检索看到的中间态是
    # 「新旧并存」而非「整文件缺失」——最多读到旧内容，不会漏掉整个文件。
    col.upsert(
        ids=new_ids,
        documents=chunks,
        metadatas=[
            {
                "source": rel,
                "chunk": i,
                "title": path.stem,
                "mtime": path.stat().st_mtime,
                "chunker": CHUNKER_VERSION,
            }
            for i in range(len(chunks))
        ],
        embeddings=vectors,
    )
    # 文件 chunk 数变少时，确定性 id 覆盖不到多出来的旧 chunk，这里清掉
    try:
        existing = col.get(where={"source": rel}, include=["metadatas"])
        stale = [i for i in (existing.get("ids") or []) if i not in set(new_ids)]
        if stale:
            col.delete(ids=stale)
    except Exception:  # noqa: BLE001 - 清理残留失败不影响本次索引
        log.warning("clean stale chunks failed for %s", rel, exc_info=True)
    log.info("indexed %s -> %d chunks", rel, len(chunks))
    notify_index_change()
    return len(chunks)


def delete_source(rel: str) -> None:
    """Drop all chunks of one indexed source key."""
    try:
        get_collection().delete(where={"source": rel})
        log.info("removed index for %s", rel)
        notify_index_change()
    except Exception:  # noqa: BLE001 - collection may not exist yet
        pass


def delete_file(path: Path, root: Path = VAULT_DIR) -> None:
    delete_source(path.relative_to(root).as_posix())


def list_sources(prefix: str = "") -> list[str]:
    """Indexed source keys, optionally filtered by prefix (e.g. 'repos/foo/')."""
    col = get_collection()
    if not col.count():
        return []
    srcs = {m["source"] for m in col.get(include=["metadatas"])["metadatas"]}
    return sorted(s for s in srcs if not prefix or s.startswith(prefix))


def reindex_all(root: Path = VAULT_DIR) -> dict:
    """Full rebuild. Returns stats."""
    t0 = time.time()
    files = [p for p in root.rglob("*") if p.is_file() and ingest.is_supported(p)]
    total_chunks = 0
    errors: list[str] = []
    for p in files:
        try:
            total_chunks += index_file(p, root)
        except Exception as e:  # noqa: BLE001 - keep going, report at end
            errors.append(f"{p.name}: {e}")
            log.exception("index failed for %s", p)
    pruned = _prune_missing({p.relative_to(root).as_posix() for p in files})
    return {
        "files": len(files),
        "chunks": total_chunks,
        "errors": errors,
        "pruned": pruned,
        "seconds": round(time.time() - t0, 1),
    }


def _prune_missing(live_sources: set[str]) -> list[str]:
    """Drop chunks whose source file is gone (deleted while the watcher was down).

    Without this a vanished file keeps competing in retrieval forever, since
    index_file only ever upserts what still exists on disk. Sources outside the
    vault (repos/dirs prefixes) are skipped — they live elsewhere on disk and
    are pruned by their own sync/watch, not by a vault rebuild.
    """
    col = get_collection()
    if not col.count():
        return []
    indexed = {m["source"] for m in col.get(include=["metadatas"])["metadatas"]}
    stale = sorted(
        s for s in indexed - live_sources if not s.startswith(EXTERNAL_PREFIXES)
    )
    for src in stale:
        col.delete(where={"source": src})
        log.info("pruned stale index entry %s", src)
    if stale:
        notify_index_change()
    return stale


def search(query: str, top_k: int = 5) -> list[dict]:
    """Vector search over indexed chunks."""
    col = get_collection()
    if col.count() == 0:
        return []
    vec = embedder.embed_one(query)
    res = col.query(query_embeddings=[vec], n_results=min(top_k, col.count()))
    hits = []
    for i in range(len(res["ids"][0])):
        meta = res["metadatas"][0][i]
        hits.append(
            {
                "id": res["ids"][0][i],
                "text": res["documents"][0][i],
                "source": meta.get("source"),
                "title": meta.get("title"),
                "chunk": meta.get("chunk"),
                # distance -> similarity score in [0, 1]
                "score": round(1.0 - res["distances"][0][i], 4),
            }
        )
    return hits


def stats() -> dict:
    """索引现状。`stale` = 用**旧切法**切出来的块数——不为 0 就说明该重建索引了
    （切法一变，块的边界全变；旧块留在库里既检索不准，也让「这次改动有没有用」
    没法判断）。见 PLAN §10.1 #2。"""
    col = get_collection()
    if col.count() == 0:
        return {"chunks": 0, "files": 0, "chunker": CHUNKER_VERSION, "stale": 0}
    metas = col.get(include=["metadatas"])["metadatas"]
    return {
        "chunks": col.count(),
        "files": len({m.get("source") for m in metas}),
        "chunker": CHUNKER_VERSION,
        "stale": sum(1 for m in metas if m.get("chunker") != CHUNKER_VERSION),
    }


def search_hybrid(query: str, top_k: int = 5) -> list[dict]:
    """Hybrid search via retriever (imported lazily to avoid a cycle)."""
    from app.core import retriever

    return retriever.hybrid_search(query, top_k)


def search_auto(query: str, top_k: int = 5, hybrid: bool | None = None) -> list[dict]:
    """Dispatch to hybrid or vector-only based on config."""
    if hybrid is None:
        from app.core.prefs import load_config

        hybrid = bool(load_config().get("hybrid_search", True))
    if hybrid:
        return search_hybrid(query, top_k)
    return search(query, top_k)
