"""Index pipeline: vault files -> chunks -> embeddings -> ChromaDB.

Design: vault markdown/pdf/docx files are the source of truth. ChromaDB holds
vectors; SQLite is not involved in indexing (chunk metadata lives in Chroma's
own metadata). Reindexing is idempotent — a file's chunks are replaced
atomically by upsert with deterministic chunk ids derived from (path, index).
"""
import hashlib
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

# 静默截断是真的（bge-small-zh-v1.5 窗口 512 token，超窗不报错、只丢弃尾部），
# 但**压块不是它的解**——这是量出来的，不是拍的（RAG升级.md §2 P1a / §3）：
#   964 块（vault 50 + repos 914）：token p99=628、max=749、73 块（7.6%）超窗；
#   token/字符 = 0.53（中英混排实测。原先按「中文约 1.3 token/字」估的换算偏高了一倍多。）
# 按语料重切、逐个参数实测（同一份语料、同一批 34 条金标，hybrid=on）：
#   800/120 → 964 块  hit@1=0.6471  MRR=0.7314  注入中位数 2762
#   700/105 → 1105 块 hit@1=0.5882  MRR=0.6985  注入中位数 2387
#   550/90  → 1375 块 hit@1=0.4706  MRR=0.6186  注入中位数 2009
#   500/80  → 1494 块 hit@1=0.4706  MRR=0.6137  注入中位数 1745
# recall 对 CHUNK_SIZE **单调**：越碎越差，一路到 800 都还在涨。而「p99 ≤ 512 token」
# 要求 CHUNK_SIZE ≤ 600（600/100 实测 p99=509）——**没有任何一个值能同时满足窗口与
# recall**（方案 §3 的 P1a 验收要求「三项达标」）。把 top_k 5→8 补注入量（2915 字符，
# 超过基线）也只救回 hit@3（0.8235），hit@1/MRR 仍低于基线。
# 所以本版**不压块**，截断按 §1.1 触发条件 ①（「压块调优救不回来」）挂到换窗口模型
# （Qwen3-Embedding-0.6B / BGE-M3）那一笔上——那才是修截断的正解，也是 CHUNK_SIZE
# 将来能回升到 1200+ 的前提。量法留在 smoke_retrieval.py（块 token 分布）与
# smoke_rag_eval.py（注入总量）里，重开时原样复跑。
CHUNK_SIZE = 800
CHUNK_OVERLAP = 120
MIN_CHUNK = 200  # 低于这个长度的块尽量并进邻居——太碎的块检索价值低
# 合并时允许超出 CHUNK_SIZE，但不超过 CHUNK_SIZE + CHUNK_OVERLAP：那是既有测试
# （`test_chunks_stay_within_budget`）已经认可的上界。
CHUNK_SOFT_MAX = CHUNK_SIZE + CHUNK_OVERLAP
# 切法一变就 +1。块元数据里带着它，对不上就是「这份索引是旧切法切的，该重建了」。
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


def _file_hash(path: Path) -> str:
    """源文件的字节哈希，截断到 16 位十六进制（碰撞概率在这个量级可以忽略）。

    哈希的是**文件字节**而不是解析后的文本：漂移检查要重算它，而重解析一个 PDF
    是这份成本里最贵的部分，读字节不是。代价是「字节变了但文本没变」（改了个
    换行）会被报成漂移——可接受的假阳性。
    """
    h = hashlib.sha1()
    with path.open("rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()[:16]


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
    """结构感知的切分（语义分块）。

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
    # 版本契约的两个戳，每个块都带着：
    #   hash  —— 源文件字节的哈希。`mtime` 是靠不住的信号（cp -p、解压备份、
    #            从快照还原都会保留它），哈希能看见 watcher 看不见的漂移。
    #   embed —— 建这个向量的**模型 + 做法**（`embedder.VECTOR_TAG`）。换了模型、或
    #            同一段文本换了算法（如超窗块从截断改成窗口池化），旧向量和新向量在
    #            同一个余弦空间里都没有可比性，必须能被发现（stats().stale_embed）。
    stamp = {"hash": _file_hash(path), "embed": embedder.VECTOR_TAG}
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
                "chunker": CHUNKER_VERSION,
                **stamp,
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
    """索引现状——版本契约的四个计数器。

    - `stale`：用**旧切法**切出来的块数。切法一变块的边界全变，旧块留在库里既检索
      不准，也让「这次改动有没有用」没法判断。
    - `stale_embed`：用**别的模型或别的建向量做法** embed 的块数（戳的值是
      `embedder.VECTOR_TAG` = 模型名#方法版本）。同一个余弦空间里混两种向量得到的
      相似度没有意义——不为 0 就必须重建。
    - `unhashed`：还没有内容哈希的块数（内容哈希是后加的，改动前写入的块没有）。
      不为 0 只说明「漂移检查覆盖不全」，点一次重建即可，不影响检索结果。
    """
    col = get_collection()
    base = {
        "chunks": 0,
        "files": 0,
        "chunker": CHUNKER_VERSION,
        "stale": 0,
        "embed_model": embedder.MODEL_NAME,
        "stale_embed": 0,
        "unhashed": 0,
    }
    if col.count() == 0:
        return base
    metas = col.get(include=["metadatas"])["metadatas"]
    return {
        **base,
        "chunks": col.count(),
        "files": len({m.get("source") for m in metas}),
        "stale": sum(1 for m in metas if m.get("chunker") != CHUNKER_VERSION),
        # 缺 `embed` 的块是本改动之前写入的。这个索引从头到尾只被 bge-small-zh-v1.5
        # 建过，所以按当前模型认——不是放水，是事实；重建一次就会带上戳。
        "stale_embed": sum(
            1
            for m in metas
            if m.get("embed") is not None and m.get("embed") != embedder.VECTOR_TAG
        ),
        "unhashed": sum(1 for m in metas if not m.get("hash")),
    }


def drifted(root: Path = VAULT_DIR) -> list[str]:
    """磁盘内容变了、索引里还是旧哈希的来源。

    这是 `_prune_missing` 的补集：那个管「文件没了」，这个管「文件还在但不一样了」。
    只查 vault 自己的来源——`repos/` `dirs/` 前缀的归各自的 sync 管。
    没有哈希的来源（改动前写入的）跳过：它们要先重建一次才谈得上比对。
    """
    col = get_collection()
    if not col.count():
        return []
    stored: dict[str, str] = {}
    for m in col.get(include=["metadatas"])["metadatas"]:
        src, digest = m.get("source"), m.get("hash")
        if src and digest:
            stored.setdefault(src, digest)
    out: list[str] = []
    for src, old in stored.items():
        if src.startswith(EXTERNAL_PREFIXES):
            continue
        path = root / src
        if not path.is_file():
            continue  # 消失的文件归 _prune_missing，不在这里重复报
        try:
            if _file_hash(path) != old:
                out.append(src)
        except OSError:
            out.append(src)
    return sorted(out)


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
