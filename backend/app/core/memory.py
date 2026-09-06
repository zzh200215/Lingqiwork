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
# 证据链上限（DeepTutor 参考项：可检视记忆）。洞察/合并行的依据快照最多留 8 条：
# 链是给人看的，不是数据恢复——超限时丢最旧的，新依据总是更接近现状。
EVIDENCE_CAP = 8


def parse_evidence(raw: str | None) -> list[dict]:
    """evidence_json → [{"id","text"}]，坏 JSON / 形状不对一律返回 []。"""
    if not raw:
        return []
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return []
    if not isinstance(data, list):
        return []
    out = []
    for item in data:
        if not isinstance(item, dict):
            continue
        text = str(item.get("text") or "").strip()
        if not text:
            continue
        try:
            mid = int(item.get("id"))
        except (TypeError, ValueError):
            mid = -1
        out.append({"id": mid, "text": text[:200]})
    return out


def merge_evidence(existing_json: str, extras: list[list[dict]]) -> str:
    """已有证据 + 新依据 → 合并后的 evidence_json。按 id 去重、超限丢最旧。

    extras 里靠前的组是更直接的依据（被吸收的原行），靠后的是间接的
    （被吸收行自己的证据）——同 id 保留先出现的直接版。
    """
    seen: set[int] = set()
    out: list[dict] = []
    for group in extras:
        for item in group:
            mid = int(item.get("id", -1))
            if mid >= 0 and mid in seen:
                continue
            seen.add(mid)
            out.append({"id": mid, "text": str(item.get("text") or "")[:200]})
    for item in parse_evidence(existing_json):
        if item["id"] >= 0 and item["id"] in seen:
            continue
        seen.add(item["id"])
        out.append(item)
    return json.dumps(out[-EVIDENCE_CAP:], ensure_ascii=False)

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

    # 只给非默认类贴标签：事实是大多数，每行都挂【事实】是注入里的噪音
    lines = "\n".join(
        f"- 【{AUTO_KIND_LABELS.get(m.kind, '事实')}】{m.content}"
        if getattr(m, "kind", None) in ("preference", "habit")
        else f"- {m.content}"
        for m in rows
    )
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


async def add_memory(
    content: str, source: str = "manual", kind: str = "fact", evidence: list[dict] | None = None
) -> str:
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
        row = Memory(
            content=content,
            source=source if source in ("manual", "auto") else "manual",
            kind=kind if kind in AUTO_KINDS else "fact",
            evidence_json=json.dumps(
                [e for e in (evidence or []) if str(e.get("text") or "").strip()][-EVIDENCE_CAP:],
                ensure_ascii=False,
            ),
        )
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

# 分类照管家类产品的记忆设计收窄成三类（AI-Sphere-Butler 的偏好/事实/习惯/情感里，
# 去掉了情感——没有明确用途；去掉了状态——时效性信息是流水账的主要来源）。
# 每类各管一种「将来怎么用」：偏好决定口吻和推荐，事实补背景，习惯决定何时别打扰。
# 分类照管家类产品的记忆设计收窄成三类（AI-Sphere-Butler 的偏好/事实/习惯/情感里，
# 去掉了情感——没有明确用途；去掉了状态——时效性信息是流水账的主要来源）。
# 每类各管一种「将来怎么用」：偏好决定口吻和推荐，事实补背景，习惯决定何时别打扰。
# 分类照管家类产品的记忆设计收窄成三类（AI-Sphere-Butler 的偏好/事实/习惯/情感里，
# 去掉了情感——没有明确用途；去掉了状态——时效性信息是流水账的主要来源）。
# 每类各管一种「将来怎么用」：偏好决定口吻和推荐，事实补背景，习惯决定何时别打扰。
# insight（洞察）不是 automemory 抽出来的，是夜间反思（memory_tidy.reflect）合成的
# 更高层观察——放在同一组里只是为了 add_memory 不把它强制成 fact，抽取提示词
# （_AUTO_SYSTEM）仍然只许模型写前三类。
AUTO_KINDS = ("preference", "fact", "habit", "insight")
AUTO_KIND_LABELS = {"preference": "偏好", "fact": "事实", "habit": "习惯", "insight": "洞察"}

_AUTO_SYSTEM = (
    "你负责维护用户的长期记忆库。用户会给你一段刚结束的对话和已有记忆列表。\n"
    "只提取「关于用户本人的持久信息」，分三类：\n"
    "- preference（偏好）：稳定的喜好与厌恶，如技术栈偏好、称呼习惯、界面口味。\n"
    "- fact（事实）：持久背景，如所在城市、项目名称、在学什么。\n"
    "- habit（习惯）：周期性行为，如每周三晚上开会、习惯早上写代码。\n"
    "不要记：普通聊天内容、一次性任务、时效性信息（在赶什么 deadline、这两天在哪）、情绪状态、对话中已有的记忆。\n"
    '只输出 JSON 数组，每条是 {"kind": "preference|fact|habit", "text": "一句完整陈述（不超过 100 字）"}，最多 2 条；没有值得记的就输出 []。\n'
    "不要解释、不要代码块。\n"
    '示例：[{"kind": "preference", "text": "用户主用 Python，偏好 uv 管理依赖"}]'
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
        items = json.loads(m.group(0))
        if not isinstance(items, list):
            return []
        saved: list[str] = []
        for item in items[:AUTO_FACT_CAP]:
            # 旧格式（裸字符串）照单全收为 fact；对象格式校验 kind，乱写的归 fact
            if isinstance(item, str):
                kind, text = "fact", item
            elif isinstance(item, dict):
                kind = str(item.get("kind") or "fact")
                text = str(item.get("text") or "")
            else:
                continue
            text = text.strip()[:AUTO_FACT_CHARS]
            if not text:
                continue
            result = await add_memory(text, source="auto", kind=kind)
            if result.startswith("已记住"):
                saved.append(text)
        return saved
    except Exception:  # noqa: BLE001 - automemory is best-effort by design
        log.warning("automemory extraction failed", exc_info=True)
        return []
