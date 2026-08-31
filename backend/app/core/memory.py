"""Persistent user memory (Open WebUI / Khoj automemory style).

Facts live in SQLite `memories` and are injected into every chat as a system
message. V1.4 upgrades:

- relevance recall — with many memories only the top-k most similar to the
  current query are injected (small collections still get everything);
- semantic dedup — near-duplicate facts are refused on save;
- automemory — `auto_extract` lets the model decide after each exchange
  whether something durable was said and save it (opt-in via prefs).
"""
import asyncio
import json
import logging
import math
import re

from sqlalchemy import delete, select

from app.core.llm import ProviderInfo, stream_chat
from app.db import SessionLocal
from app.models import Memory

log = logging.getLogger(__name__)

MAX_MEMORIES = 100
RECALL_THRESHOLD = 8  # ≤ this many memories → inject all, no ranking
RECALL_TOP_K = 5  # above the threshold, inject only the k most relevant
DEDUP_SIMILARITY = 0.92  # cosine above this = near-duplicate, refuse to save
AUTO_FACT_CAP = 2  # max facts saved per automemory pass
AUTO_FACT_CHARS = 120

# id -> (content, normalized vector); avoids re-embedding unchanged memories
_vec_cache: dict[int, tuple[str, list[float]]] = {}


async def list_memories(db=None) -> list[Memory]:
    if db is not None:
        return list((await db.execute(select(Memory).order_by(Memory.id))).scalars().all())
    async with SessionLocal() as s:
        return await list_memories(s)


async def _embed_texts(texts: list[str]) -> list[list[float]]:
    """Embed a batch in a thread (CPU-bound). Test seam: monkeypatch me."""
    from app.core import embedder

    return await asyncio.to_thread(embedder.embed, texts)


def _cosine(a: list[float], b: list[float]) -> float:
    if not a or not b or len(a) != len(b):
        return 0.0
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(x * x for x in b))
    return dot / (na * nb) if na and nb else 0.0


async def _vectors_for(rows: list[Memory]) -> list[list[float] | None]:
    """Vectors for the given memories, embedding only the cache misses."""
    missing = [m for m in rows if m.id not in _vec_cache or _vec_cache[m.id][0] != m.content]
    if missing:
        try:
            vecs = await _embed_texts([m.content for m in missing])
        except Exception:  # noqa: BLE001 - embedding failure must not break chat
            log.warning("memory embedding failed, skipping ranking", exc_info=True)
            return [None] * len(rows)
        for m, v in zip(missing, vecs):
            _vec_cache[m.id] = (m.content, v)
    return [_vec_cache[m.id][1] if m.id in _vec_cache else None for m in rows]


async def format_memories(query: str | None = None) -> str:
    """Render memories as one prompt block ('' when none).

    Small collections are injected whole; larger ones are ranked against the
    current query and only the most relevant make the cut.
    """
    rows = await list_memories()
    if not rows:
        return ""

    header_note = ""
    if query and len(rows) > RECALL_THRESHOLD:
        total = len(rows)
        qvec = (await _embed_texts([query.strip()[:500]]))[0]
        vecs = await _vectors_for(rows)
        if qvec and any(vecs):
            scored = sorted(
                ((m, v) for m, v in zip(rows, vecs) if v is not None),
                key=lambda mv: _cosine(qvec, mv[1]),
                reverse=True,
            )
            kept = [m for m, _ in scored[:RECALL_TOP_K]]
            if len(kept) < total:
                rows = kept
                header_note = f"（已从 {total} 条记忆中按相关性选取 {len(rows)} 条）\n"

    lines = "\n".join(f"- {m.content}" for m in rows)
    return (
        "以下是关于用户的长期记忆（来自过往对话，可能帮助回答）：\n"
        f"{header_note}{lines}\n"
        "如与当前问题无关可忽略；如发现记忆与用户最新说法冲突，以用户当前表述为准。"
    )


async def _similar_existing(content: str, contents: list[str]) -> str | None:
    """Return the first stored fact semantically too close to `content`."""
    try:
        vecs = await _embed_texts([content, *contents])
    except Exception:  # noqa: BLE001 - without embeddings, exact match only
        return None
    cand = vecs[0]
    for stored, v in zip(contents, vecs[1:]):
        if _cosine(cand, v) >= DEDUP_SIMILARITY:
            return stored
    return None


async def add_memory(content: str, source: str = "manual") -> str:
    content = content.strip()
    if not content:
        return "[错误] 内容为空"
    if len(content) > 300:
        return "[错误] 单条记忆不超过 300 字"
    async with SessionLocal() as db:
        existing = (
            await db.execute(select(Memory).where(Memory.content == content))
        ).scalar_one_or_none()
        if existing:
            return f"已存在相同记忆：{content}"
        contents = list(
            (await db.execute(select(Memory.content).order_by(Memory.id))).scalars().all()
        )
        similar = await _similar_existing(content, contents)
        if similar:
            return f"已存在相似记忆：{similar}"
        count = len((await db.execute(select(Memory.id))).all())
        if count >= MAX_MEMORIES:
            oldest = (
                await db.execute(select(Memory).order_by(Memory.id).limit(1))
            ).scalar_one()
            await db.delete(oldest)
            _vec_cache.pop(oldest.id, None)
        row = Memory(content=content, source=source if source in ("manual", "auto") else "manual")
        db.add(row)
        await db.commit()
    return f"已记住：{content}"


async def update_memory(memory_id: int, content: str) -> str:
    content = (content or "").strip()
    if not content:
        return "[错误] 内容为空"
    if len(content) > 300:
        return "[错误] 单条记忆不超过 300 字"
    async with SessionLocal() as db:
        row = await db.get(Memory, memory_id)
        if not row:
            return f"[未找到] 记忆 #{memory_id}"
        row.content = content
        await db.commit()
    _vec_cache.pop(memory_id, None)
    return f"已更新记忆 #{memory_id}"


async def remove_memory(memory_id: int | None = None, content: str | None = None) -> str:
    async with SessionLocal() as db:
        if memory_id is not None:
            row = await db.get(Memory, memory_id)
            if not row:
                return f"[未找到] 记忆 #{memory_id}"
            await db.delete(row)
            await db.commit()
            _vec_cache.pop(memory_id, None)
            return f"已删除记忆 #{memory_id}：{row.content}"
        if content:
            result = await db.execute(delete(Memory).where(Memory.content == content.strip()))
            await db.commit()
            _vec_cache.clear()
            return f"已删除 {result.rowcount} 条匹配记忆" if result.rowcount else "[未找到] 无匹配内容"
    return "[错误] 需要 id 或 content 之一"


async def clear_all() -> int:
    async with SessionLocal() as db:
        result = await db.execute(delete(Memory))
        await db.commit()
    _vec_cache.clear()
    return result.rowcount


# ---------- automemory: model decides what was worth remembering ----------

_AUTO_SYSTEM = (
    "你负责维护用户的长期记忆库。用户会给你一段刚结束的对话和已有记忆列表。\n"
    "只提取「关于用户本人的持久事实」（偏好、背景、约定、长期项目），如：常用地名、"
    "技术栈偏好、称呼习惯、项目名称。不要记：普通聊天内容、一次性任务、时效性信息、"
    "对话中已有的记忆。\n"
    '只输出 JSON 数组，每条是一句完整陈述（不超过 100 字），最多 2 条；没有值得记的就输出 []。'
    "不要解释、不要代码块。示例：[\"用户主用 Python，偏好 uv 管理依赖\"]"
)


async def auto_extract(info: ProviderInfo, model: str, user_text: str, answer_text: str) -> list[str]:
    """After one exchange, ask the model which durable facts to keep.

    Returns the list of newly-saved fact strings (dedup-refused ones skipped).
    Never raises on model/parse errors — automemory must not break chat.
    """
    try:
        rows = await list_memories()
        existing = "\n".join(f"- {m.content}" for m in rows) or "（暂无）"
        prompt = (
            f"已有记忆：\n{existing}\n\n"
            f"刚结束的对话：\n【用户】{user_text[:3000]}\n【助手】{answer_text[:3000]}\n\n"
            "请判断有没有值得新增的长期记忆。"
        )
        chunks = [
            c
            async for c in stream_chat(
                info,
                model,
                [
                    {"role": "system", "content": _AUTO_SYSTEM},
                    {"role": "user", "content": prompt},
                ],
            )
        ]
        raw = "".join(chunks).strip()
        m = re.search(r"\[.*\]", raw, re.S)
        if not m:
            return []
        facts = json.loads(m.group(0))
        if not isinstance(facts, list):
            return []
        saved: list[str] = []
        for fact in facts[:AUTO_FACT_CAP]:
            text = str(fact).strip()[:AUTO_FACT_CHARS]
            if not text:
                continue
            result = await add_memory(text, source="auto")
            if result.startswith("已记住"):
                saved.append(text)
        return saved
    except Exception:  # noqa: BLE001 - automemory is best-effort by design
        log.warning("automemory extraction failed", exc_info=True)
        return []
