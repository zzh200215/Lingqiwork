"""Spaced-repetition cards: SM-2 scheduling, AI card generation, weak-source rollup.

Three parts, deliberately in this order:

1. `schedule()` — a pure SM-2 variant. No clock, no randomness, no I/O: it takes
   the current state plus a grade and returns the next state as a *seconds
   offset*, so every scheduling rule is unit-testable without mocking time.
2. Card generation — prompt assembly and JSON parsing are pure functions too
   (same discipline as `routers/notes.py:_compose_prompt`); only `generate_iter`
   touches an LLM, and it yields (stage, data) progress like `core/podcast.py`.
3. DB access + the proactive layer (daily reminder, weekly remediation).

Everything heavy (llm / embedder / indexer / ingest / chromadb) is imported
INSIDE functions on purpose: this module is imported at app startup through
`routers/cards.py`, and a module-level failure here would take down all of
FastAPI, not just review. Same pattern as `routers/notes.py:250`, `core/pet.py`.
"""
import json
import logging
import random
import re
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

log = logging.getLogger(__name__)

# ---------- SM-2 ----------

LEARNING_AGAIN_SEC = 600  # 答错 → 10 分钟后重来
GRADUATE_INTERVAL = 1.0  # 天：首次答对
SECOND_INTERVAL = 6.0  # 天：第二次答对
MIN_EASE, MAX_EASE = 1.30, 2.80
EASE_DELTA = {1: -0.20, 2: -0.15, 3: 0.0, 4: +0.10}
GRADE_FACTOR = {2: 0.6, 3: 1.0, 4: 1.3}
MAX_INTERVAL = 365.0
FUZZ_MIN_DAYS = 3.0  # 低于此不加抖动
FUZZ_RATIO = 0.05
LEECH_LAPSES = 8  # 到此自动搁置
SESSION_REQUEUE_SEC = 1200  # due_seconds 小于此 → 前端本节内重排

KINDS = ("concept", "cloze", "scenario", "debug")

# 模型可能用中文或近义词回答 kind，一律归一；认不出的落 concept
_KIND_ALIASES = {
    "概念": "concept", "辨析": "concept", "定义": "concept",
    "填空": "cloze", "代码填空": "cloze", "cloze_deletion": "cloze",
    "情景": "scenario", "场景": "scenario", "情境": "scenario",
    "调试": "debug", "排错": "debug", "debugging": "debug", "bug": "debug",
}


@dataclass(frozen=True)
class Sched:
    """Next scheduling state. `due_seconds` is an offset from "now", not a time.

    Keeping it an offset is what makes `schedule()` clock-free and therefore
    testable with plain integer assertions; the caller adds it to utcnow().
    """

    interval_days: float
    ease: float
    reps: int
    lapses: int
    due_seconds: int
    lapsed: bool  # this answer was a lapse (a graduated card forgotten)


def schedule(interval_days: float, ease: float, reps: int, lapses: int, grade: int) -> Sched:
    """SM-2 variant. grade: 1 重来 | 2 困难 | 3 良好 | 4 简单.

    Pure function. Raises ValueError on an out-of-range grade — a bad grade is a
    caller bug (or a stray keypress), and silently clamping it would corrupt the
    schedule invisibly.
    """
    if grade not in (1, 2, 3, 4):
        raise ValueError(f"grade 必须是 1-4，收到 {grade!r}")

    if grade == 1:
        # forgotten: back to the front of the queue, interval reset.
        # Ease drops ONLY on a real lapse (a graduated card forgotten). A
        # brand-new card fumbled mid-learning is not a lapse, and penalizing
        # its ease would permanently handicap a good card for one rough pass.
        ease = _clamp_ease(ease + EASE_DELTA[1]) if reps > 0 else ease
        return Sched(
            interval_days=0.0,
            ease=ease,
            reps=0,
            lapses=lapses + (1 if reps > 0 else 0),
            due_seconds=LEARNING_AGAIN_SEC,
            lapsed=reps > 0,
        )

    ease = _clamp_ease(ease + EASE_DELTA[grade])
    if reps == 0:
        nxt = GRADUATE_INTERVAL
    elif reps == 1:
        nxt = SECOND_INTERVAL
    else:
        nxt = interval_days * ease * GRADE_FACTOR[grade]
        # strictly increasing: round(1 * 1.2) == 1 would pin a card at one day
        nxt = max(nxt, interval_days + 1.0)
    nxt = min(nxt, MAX_INTERVAL)
    return Sched(
        interval_days=nxt,
        ease=ease,
        reps=reps + 1,
        lapses=lapses,
        due_seconds=int(round(nxt * 86400)),
        lapsed=False,
    )


def _clamp_ease(v: float) -> float:
    return max(MIN_EASE, min(MAX_EASE, v))


def fuzz_interval(days: float, rnd: random.Random | None = None) -> float:
    """±5% jitter on intervals >= 3 days so a batch made the same day spreads out.

    Kept out of `schedule()` so that one stays deterministic and pure.
    """
    if days < FUZZ_MIN_DAYS:
        return days
    r = rnd or random
    return round(days * (1.0 + r.uniform(-FUZZ_RATIO, FUZZ_RATIO)), 2)


# ---------- 出卡 ----------

MAX_INPUT_CHARS = 15000  # 与 podcast 输入上限一致
MIN_INPUT_CHARS = 80  # 太短的文本出不了有意义的卡
MAX_CARDS = 20
DEFAULT_CARDS = 8
MAX_FRONT_CHARS = 400
MAX_BACK_CHARS = 1200

_GEN_SYSTEM = (
    "你负责把技术材料改写成间隔复习卡片。目标是「做得出来」而不是「背得出来」："
    "优先考具体判断和动手做法，不要考定义背诵。\n"
    "四种类型，按材料实际内容选，不必凑齐，优先出 scenario 和 debug：\n"
    "- scenario：给现象问原因，或给需求问做法。front 描述具体情境，back 给做法与理由。\n"
    "- debug：给一段有问题的代码/配置/报错，问错在哪、怎么改。"
    "back 必须点明根因，不能只贴改后的代码。\n"
    "- cloze：代码/命令/配置填空。front 用 ____ 标出要填的部分，一张卡只挖一处；"
    "back 给完整正确写法并补一句为什么是它。\n"
    "- concept：概念辨析。问区别、边界、代价。"
    "不要问「X 是什么」这种照抄原文就能答的。\n"
    "硬要求：\n"
    "① 只用材料里出现过的信息，材料没写的一律不编。材料里的实测数字、报错原文、"
    "踩坑结论是最好的素材，优先用它们。\n"
    "② 一张卡只考一件事。答案是一串清单的，拆成多张。\n"
    "③ front 不超过 300 字，back 不超过 500 字；代码用 ``` 围起来。\n"
    "④ front 必须自包含：不能出现「上文提到的」「前面那个方法」这类指代，"
    "因为复习时看不到材料。\n"
    "⑤ topic 给一个简短的中文或英文小写主题词（如 python / sqlite / 检索）。\n"
    "⑥ excerpt 摘 30 字以内的原文片段，说明这张卡的依据。\n"
    '只输出一个 JSON 数组，不要解释、不要用代码块包裹整个数组：\n'
    '[{"kind":"debug","front":"...","back":"...","hint":"","topic":"python","excerpt":"..."}]\n'
    "没有值得出卡的内容就输出 []。"
)


def collect_material(source_path: str = "", text: str = "") -> tuple[str, str, str]:
    """-> (source_rel, source_label, material). Filesystem only, no DB.

    Exactly one of source_path / text must be given. The `text` entry exists so
    material outside the vault can be carded — PLAN.md sits at the repo root and
    would never pass the vault containment check. Raises ValueError.
    """
    has_path, has_text = bool((source_path or "").strip()), bool((text or "").strip())
    if has_path == has_text:
        raise ValueError("source_path 与 text 必须给且只给一个")

    if has_text:
        material = text.strip()[:MAX_INPUT_CHARS]
        if len(material) < MIN_INPUT_CHARS:
            raise ValueError(f"文本太短（至少 {MIN_INPUT_CHARS} 字）")
        return "", "粘贴文本", material

    from app.config import VAULT_DIR
    from app.core import ingest

    root = VAULT_DIR.resolve()
    rel = source_path.strip().lstrip("/\\")
    p = (root / rel).resolve()
    if not p.is_relative_to(root):
        raise ValueError("路径越出 vault 目录")
    if not p.is_file():
        raise ValueError(f"找不到文件：{rel}")
    material = (ingest.parse_file(p) or "").strip()[:MAX_INPUT_CHARS]
    if len(material) < MIN_INPUT_CHARS:
        raise ValueError("这篇内容太短，出不了卡")
    return p.relative_to(root).as_posix(), p.relative_to(root).as_posix(), material


def compose_gen_prompt(
    material: str, label: str, count: int, kinds: list[str] | None = None
) -> tuple[str, str]:
    """-> (system, user). Pure — no I/O, no model — so prompt shape is unit-testable.

    Raises ValueError on an unknown kind or a non-positive count.
    """
    if count <= 0:
        raise ValueError("count 必须为正")
    count = min(count, MAX_CARDS)
    system = _GEN_SYSTEM
    if kinds:
        bad = [k for k in kinds if k not in KINDS]
        if bad:
            raise ValueError(f"未知卡型：{', '.join(bad)}")
        system = f"{system}\n这次只出以下类型：{'、'.join(kinds)}。"
    user = (
        f"材料来源：{label}\n请出 {count} 张卡片。\n\n---\n{material[:MAX_INPUT_CHARS]}"
    )
    return system, user


def parse_cards(raw: str) -> tuple[list[dict], int]:
    """Model output -> (valid card dicts, dropped count).

    Accepts a bare array or {"cards": [...]}, fenced or not. Raises ValueError
    when nothing usable comes back — unlike the background jobs, card generation
    is a foreground action the user is waiting on, so a silent empty result would
    just look broken. Individual malformed cards are skipped, not fatal.
    """
    text = (raw or "").strip()
    if not text:
        raise ValueError("模型返回空内容")
    m = re.search(r"[\[{].*[\]}]", text, re.S)
    if not m:
        raise ValueError("模型没有返回 JSON")
    blob = m.group(0)
    try:
        data = json.loads(blob)
    except json.JSONDecodeError:
        # trailing commas are by far the most common single defect in LLM JSON
        try:
            data = json.loads(re.sub(r",\s*([\]}])", r"\1", blob))
        except json.JSONDecodeError as e:
            raise ValueError(f"JSON 解析失败：{e}") from e

    if isinstance(data, dict):
        for key in ("cards", "items", "data"):
            if isinstance(data.get(key), list):
                data = data[key]
                break
    if not isinstance(data, list):
        raise ValueError("模型返回的不是数组")

    out: list[dict] = []
    dropped = 0
    for item in data:
        if not isinstance(item, dict):
            continue
        front = str(item.get("front") or "").strip()
        back = str(item.get("back") or "").strip()
        if not front or not back:
            continue
        # too long is DROPPED, not truncated: a truncated answer is a wrong
        # answer, and a wrong answer in a review queue is worse than no card
        if len(front) > MAX_FRONT_CHARS or len(back) > MAX_BACK_CHARS:
            dropped += 1
            continue
        kind = str(item.get("kind") or "").strip().lower()
        kind = _KIND_ALIASES.get(kind, kind if kind in KINDS else "concept")
        out.append(
            {
                "kind": kind,
                "front": front,
                "back": back,
                "hint": str(item.get("hint") or "").strip()[:300],
                "topic": str(item.get("topic") or "").strip().lower()[:100],
                "excerpt": str(item.get("excerpt") or "").strip()[:300],
            }
        )
        if len(out) >= MAX_CARDS:
            break
    if not out:
        raise ValueError("没有解析出可用的卡片")
    return out, dropped


# ---------- 去重 ----------

DEDUP_SIMILARITY = 0.95  # 比 memory 的 0.92 高：卡片 front 更长更模板化，同源余弦天然偏高
DEDUP_SCAN_CAP = 1500  # 有界扫描（照 kg.SCAN_CAP 的先例）

# card id -> (front, vector); avoids re-embedding unchanged cards
_vec_cache: dict[int, tuple[str, list[float]]] = {}


async def _embed_texts(texts: list[str]) -> list[list[float]]:
    """Embed a batch in a thread (CPU-bound). Test seam: monkeypatch me."""
    import asyncio

    from app.core import embedder

    return await asyncio.to_thread(embedder.embed, texts)


def _cosine(a: list[float], b: list[float]) -> float:
    import math

    if not a or not b or len(a) != len(b):
        return 0.0
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(x * x for x in b))
    return dot / (na * nb) if na and nb else 0.0


async def find_duplicates(
    candidates: list[dict], existing: list[tuple[int, str]]
) -> tuple[list[dict], bool]:
    """Mark near-duplicate candidates in place-ish; returns (candidates, semantic_ok).

    Only `front` is compared: the question is "don't ask me the same thing twice",
    and that lives in the front. Same front + different back is a conflict you
    WANT to see; same back + different front is a good thing (multiple angles).

    Never raises. If embedding is unavailable we fall back to exact string
    matching and report semantic_ok=False so the UI can say so honestly, because
    silently skipping dedup would look identical to dedup finding nothing.
    """
    for c in candidates:
        c.setdefault("duplicate_of", None)
        c.setdefault("similarity", None)

    seen: dict[str, int] = {}
    for cid, front in existing:
        seen.setdefault(front.strip(), cid)
    batch_seen: set[str] = set()
    for c in candidates:  # exact matches first — free and always available
        key = c["front"].strip()
        hit = seen.get(key)
        if hit is not None:
            c["duplicate_of"], c["similarity"] = hit, 1.0
        elif key in batch_seen:
            c["duplicate_of"], c["similarity"] = -1, 1.0  # -1 = 同批内重复
        batch_seen.add(key)

    pool = existing[-DEDUP_SCAN_CAP:]
    try:
        cand_vecs = await _embed_texts([c["front"] for c in candidates])
        miss = [(i, f) for i, f in pool if i not in _vec_cache or _vec_cache[i][0] != f]
        if miss:
            for (i, f), v in zip(miss, await _embed_texts([f for _, f in miss])):
                _vec_cache[i] = (f, v)
    except Exception:  # noqa: BLE001 - dedup must never block card generation
        log.warning("card dedup embedding failed, exact-match only", exc_info=True)
        return candidates, False

    for n, (c, cv) in enumerate(zip(candidates, cand_vecs)):
        if c["duplicate_of"] is not None:
            continue
        best_id, best = None, 0.0
        for i, _f in pool:
            cached = _vec_cache.get(i)
            if not cached:
                continue
            s = _cosine(cv, cached[1])
            if s > best:
                best_id, best = i, s
        # also compare against earlier cards in this same batch
        for prev in range(n):
            s = _cosine(cv, cand_vecs[prev])
            if s > best:
                best_id, best = -1, s
        if best >= DEDUP_SIMILARITY:
            c["duplicate_of"], c["similarity"] = best_id, round(best, 3)
    return candidates, True


# ---------- 生成（带进度） ----------


async def generate_iter(
    source_path: str = "",
    text: str = "",
    count: int = DEFAULT_CARDS,
    kinds: list[str] | None = None,
    model_id: str = "",
):
    """Yield (stage, data) progress, ending on a terminal ("done", {...}).

    Same shape as `core/podcast.generate_from_blocks` so the SSE endpoint stays a
    thin wrapper. Input validation happens BEFORE the caller opens the stream —
    see `routers/cards.py`; once an SSE response starts there is no way to set a
    status code, a lesson already baked into smoke_podcast_stream.py.
    """
    from app.core.llm import ProviderInfo, stream_chat
    from app.core.pet import _default_model_id
    from app.routers.chat import resolve_model

    yield "reading", {}
    source, label, material = collect_material(source_path=source_path, text=text)
    system, user = compose_gen_prompt(material, label, count, kinds)

    mid = (model_id or "").strip() or (_default_model_id() or "")
    if not mid:
        yield "done", {"ok": False, "error": "没有已启用的 provider，请先在设置页配置模型"}
        return

    yield "drafting", {"model_id": mid}
    resolved = await resolve_model(mid)
    p = resolved.provider
    info = ProviderInfo(kind=p.kind, base_url=p.base_url, api_key=p.api_key)
    parts: list[str] = []
    async for delta in stream_chat(
        info,
        resolved.model,
        [{"role": "system", "content": system}, {"role": "user", "content": user}],
    ):
        parts.append(delta)

    cards, dropped = parse_cards("".join(parts))

    yield "dedup", {"total": len(cards)}
    existing = await existing_fronts(source)
    cards, semantic_ok = await find_duplicates(cards, existing)

    yield "done", {
        "ok": True,
        "cards": cards,
        "dropped": dropped,
        "dedup": "ok" if semantic_ok else "skipped",
        "source": source,
        "source_label": label,
        "model_id": mid,
    }


# ---------- DB ----------


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


async def existing_fronts(source: str = "") -> list[tuple[int, str]]:
    """(id, front) of every existing card, same-source ones LAST.

    Ordering matters: `find_duplicates` keeps only the tail of this list, and
    same-source cards are the likely duplicates, so they must not be the ones
    sliced away.
    """
    from sqlalchemy import select

    from app.db import SessionLocal
    from app.models import Card

    async with SessionLocal() as db:
        rows = (await db.execute(select(Card.id, Card.source, Card.front))).all()
    others = [(r[0], r[2] or "") for r in rows if not source or r[1] != source]
    mine = [(r[0], r[2] or "") for r in rows if source and r[1] == source]
    return others + mine


async def save_cards(
    cards: list[dict], source: str = "", source_label: str = "", model_id: str = ""
) -> dict:
    """Insert reviewed candidates as new cards. Skips exact duplicates."""
    from sqlalchemy import select

    from app.db import SessionLocal
    from app.models import Card

    added, skipped, ids = 0, 0, []
    now = utcnow()
    async with SessionLocal() as db:
        known = {
            (f or "").strip()
            for f in (await db.execute(select(Card.front))).scalars().all()
        }
        for c in cards:
            front = str(c.get("front") or "").strip()
            back = str(c.get("back") or "").strip()
            if not front or not back:
                skipped += 1
                continue
            if len(front) > MAX_FRONT_CHARS or len(back) > MAX_BACK_CHARS:
                skipped += 1
                continue
            if front in known:
                skipped += 1
                continue
            kind = str(c.get("kind") or "concept")
            row = Card(
                kind=kind if kind in KINDS else "concept",
                front=front,
                back=back,
                hint=str(c.get("hint") or "")[:300],
                source=source[:500],
                source_label=(source_label or source or "手工")[:200],
                source_excerpt=str(c.get("excerpt") or "")[:2000],
                topic=str(c.get("topic") or "")[:100],
                origin=str(c.get("origin") or "ai"),
                model_id=model_id[:100],
                due=now,
            )
            db.add(row)
            known.add(front)
            added += 1
        await db.commit()
        if added:
            ids = [
                r
                for r in (
                    await db.execute(
                        select(Card.id).order_by(Card.id.desc()).limit(added)
                    )
                ).scalars().all()
            ]
    return {"added": added, "skipped": skipped, "ids": list(reversed(ids))}


def _caps() -> tuple[int, int]:
    from app.core.prefs import load_config

    cfg = load_config()
    return (
        max(0, int(cfg.get("cards_new_per_day", 20) or 0)),
        max(0, int(cfg.get("cards_review_per_day", 200) or 0)),
    )


async def _today_counts(db) -> tuple[int, int]:
    """(reviews today, new-card reviews today), by LOCAL calendar day.

    `date(col,'localtime')` on the SQL side, not a Python-side local date string
    compared against a UTC column — that combination is an off-by-timezone bug.
    """
    from sqlalchemy import text as sql

    rows = (
        await db.execute(
            sql(
                "SELECT COUNT(*), COALESCE(SUM(CASE WHEN reps_before = 0 THEN 1 ELSE 0 END), 0) "
                "FROM card_reviews "
                "WHERE date(reviewed_at, 'localtime') = date('now', 'localtime')"
            )
        )
    ).first()
    return (int(rows[0] or 0), int(rows[1] or 0)) if rows else (0, 0)


async def queue() -> dict:
    """Today's review queue: due cards + fresh cards, both minus what's done today."""
    from sqlalchemy import func, select

    from app.db import SessionLocal
    from app.models import Card

    new_cap, review_cap = _caps()
    now = utcnow()
    async with SessionLocal() as db:
        done, new_done = await _today_counts(db)
        due_total = (
            await db.execute(
                select(func.count(Card.id)).where(
                    Card.suspended.is_(False), Card.reps > 0, Card.due <= now
                )
            )
        ).scalar() or 0
        due = (
            (
                await db.execute(
                    select(Card)
                    .where(Card.suspended.is_(False), Card.reps > 0, Card.due <= now)
                    .order_by(Card.due)
                    .limit(max(0, review_cap - done))
                )
            )
            .scalars()
            .all()
        )
        fresh = (
            (
                await db.execute(
                    select(Card)
                    .where(Card.suspended.is_(False), Card.reps == 0, Card.due <= now)
                    .order_by(Card.id)
                    .limit(max(0, new_cap - new_done))
                )
            )
            .scalars()
            .all()
        )
    return {
        "due": [as_dict(c) for c in due],
        "fresh": [as_dict(c) for c in fresh],
        "due_total": int(due_total),
        "caps": {"new_per_day": new_cap, "review_per_day": review_cap},
        "today": {"reviewed": done, "new_done": new_done},
    }


def as_dict(c) -> dict:
    return {
        "id": c.id,
        "kind": c.kind,
        "front": c.front,
        "back": c.back,
        "hint": c.hint,
        "topic": c.topic,
        "source": c.source,
        "source_label": c.source_label,
        "source_excerpt": c.source_excerpt,
        "origin": c.origin,
        "suspended": c.suspended,
        "due": c.due.isoformat() if c.due else None,
        "interval_days": c.interval_days,
        "ease": c.ease,
        "reps": c.reps,
        "lapses": c.lapses,
        "last_grade": c.last_grade,
        "last_review": c.last_review.isoformat() if c.last_review else None,
        "created_at": c.created_at.isoformat() if c.created_at else None,
    }


async def submit_review(card_id: int, grade: int, seconds: float = 0.0) -> dict:
    """Grade one card: run SM-2, update the card in place, append to the revlog.

    Raises ValueError (bad grade / suspended) or LookupError (no such card) so the
    router can map them to 422 / 400 / 404.
    """
    from sqlalchemy import select

    from app.db import SessionLocal
    from app.models import Card, CardReview

    async with SessionLocal() as db:
        card = (
            await db.execute(select(Card).where(Card.id == card_id))
        ).scalar_one_or_none()
        if card is None:
            raise LookupError(f"card {card_id} not found")
        if card.suspended:
            raise ValueError("这张卡已搁置")

        s = schedule(card.interval_days, card.ease, card.reps, card.lapses, grade)
        interval = fuzz_interval(s.interval_days)
        due_seconds = s.due_seconds if s.interval_days <= 0 else int(round(interval * 86400))
        now = utcnow()

        db.add(
            CardReview(
                card_id=card.id,
                reviewed_at=now,
                grade=grade,
                seconds=max(0.0, min(float(seconds), 600.0)),
                interval_before=card.interval_days,
                interval_after=interval,
                ease_before=card.ease,
                ease_after=s.ease,
                reps_before=card.reps,
                due_before=card.due,
            )
        )
        card.interval_days = interval
        card.ease = s.ease
        card.reps = s.reps
        card.lapses = s.lapses
        card.last_grade = grade
        card.last_review = now
        card.due = now + timedelta(seconds=due_seconds)
        # a card missed 8 times is a broken card or a missing prerequisite,
        # not a memory problem — shelve it instead of grinding on it
        if card.lapses >= LEECH_LAPSES:
            card.suspended = True
        await db.commit()
        out = as_dict(card)
    out["ok"] = True
    out["due_seconds"] = due_seconds
    out["requeue"] = due_seconds < SESSION_REQUEUE_SEC
    return out


async def undo_review(card_id: int) -> dict:
    """Roll the card back to its state before the latest review, exactly."""
    from sqlalchemy import select

    from app.db import SessionLocal
    from app.models import Card, CardReview

    async with SessionLocal() as db:
        rev = (
            await db.execute(
                select(CardReview)
                .where(CardReview.card_id == card_id)
                .order_by(CardReview.id.desc())
                .limit(1)
            )
        ).scalar_one_or_none()
        if rev is None:
            return {"ok": False, "card": None}
        card = (
            await db.execute(select(Card).where(Card.id == card_id))
        ).scalar_one_or_none()
        if card is None:
            return {"ok": False, "card": None}
        card.interval_days = rev.interval_before
        card.ease = rev.ease_before
        card.reps = rev.reps_before
        card.lapses = max(0, card.lapses - (1 if rev.grade == 1 and rev.reps_before > 0 else 0))
        card.due = rev.due_before or utcnow()
        card.suspended = False
        card.last_grade = None
        card.last_review = None
        await db.delete(rev)
        await db.commit()
        return {"ok": True, "card": as_dict(card)}


async def stats() -> dict:
    """Dashboard/review-page numbers. Best-effort: any failure returns zeros."""
    from sqlalchemy import func, select, text as sql

    from app.db import SessionLocal
    from app.models import Card

    out = {
        "total": 0,
        "new": 0,
        "learning": 0,
        "mature": 0,
        "suspended": 0,
        "due_now": 0,
        "today_reviewed": 0,
        "today_new": 0,
        "remaining_today": 0,
        "accuracy_7d": None,
        "daily": [],
        "streak": 0,
        "next_due": None,
    }
    try:
        now = utcnow()
        async with SessionLocal() as db:
            out["total"] = (await db.execute(select(func.count(Card.id)))).scalar() or 0
            out["suspended"] = (
                await db.execute(
                    select(func.count(Card.id)).where(Card.suspended.is_(True))
                )
            ).scalar() or 0
            out["new"] = (
                await db.execute(
                    select(func.count(Card.id)).where(
                        Card.suspended.is_(False), Card.reps == 0
                    )
                )
            ).scalar() or 0
            out["mature"] = (
                await db.execute(
                    select(func.count(Card.id)).where(
                        Card.suspended.is_(False), Card.interval_days >= 21
                    )
                )
            ).scalar() or 0
            out["learning"] = max(
                0, out["total"] - out["new"] - out["mature"] - out["suspended"]
            )
            out["due_now"] = (
                await db.execute(
                    select(func.count(Card.id)).where(
                        Card.suspended.is_(False), Card.due <= now
                    )
                )
            ).scalar() or 0
            nxt = (
                await db.execute(
                    select(Card.due)
                    .where(Card.suspended.is_(False), Card.due > now)
                    .order_by(Card.due)
                    .limit(1)
                )
            ).scalar()
            out["next_due"] = nxt.isoformat() if nxt else None

            done, new_done = await _today_counts(db)
            out["today_reviewed"], out["today_new"] = done, new_done
            new_cap, review_cap = _caps()
            out["remaining_today"] = max(0, min(out["due_now"], review_cap - done))

            acc = (
                await db.execute(
                    sql(
                        "SELECT COUNT(*), SUM(CASE WHEN grade >= 3 THEN 1 ELSE 0 END) "
                        "FROM card_reviews "
                        "WHERE reviewed_at >= datetime('now', '-7 days')"
                    )
                )
            ).first()
            if acc and acc[0]:
                out["accuracy_7d"] = round(float(acc[1] or 0) / float(acc[0]), 3)

            rows = (
                await db.execute(
                    sql(
                        "SELECT date(reviewed_at,'localtime') d, COUNT(*) n FROM card_reviews "
                        "WHERE reviewed_at >= datetime('now','-30 days') GROUP BY d ORDER BY d"
                    )
                )
            ).all()
            by_day = {r[0]: int(r[1]) for r in rows}
            out["daily"] = [{"date": k, "count": v} for k, v in sorted(by_day.items())][-7:]
            out["streak"] = _streak(set(by_day))
    except Exception:  # noqa: BLE001 - stats must never break a page
        log.debug("card stats failed", exc_info=True)
    return out


def _streak(days: set[str]) -> int:
    """Consecutive local days with at least one review, counting back from today.

    Yesterday still counts as a live streak: it is only broken once a whole day
    has gone by with nothing done, otherwise the number would read 0 every
    morning before the first card.
    """
    from datetime import date as _date

    today = _date.today()
    if today.isoformat() not in days and (today - timedelta(days=1)).isoformat() not in days:
        return 0
    n, cur = 0, today if today.isoformat() in days else today - timedelta(days=1)
    while cur.isoformat() in days:
        n += 1
        cur -= timedelta(days=1)
    return n


# ---------- 薄弱来源（纯聚合，不建表） ----------

WEAK_MIN_REVIEWS = 5  # 样本不足不下判断
WEAK_AVG_GRADE = 2.6  # 平均分低于此 = 整体不牢
WEAK_AGAIN_RATE = 0.30  # 或「重来」占比 ≥ 此 = 有具体盲点


async def weak_sources(days: int = 30, limit: int = 10) -> list[dict]:
    """Sources whose cards you keep getting wrong. Pure rollup over the revlog."""
    from sqlalchemy import text as sql

    from app.db import SessionLocal

    days = max(1, min(int(days), 90))
    async with SessionLocal() as db:
        rows = (
            await db.execute(
                sql(
                    "SELECT c.source, c.source_label, "
                    "       COUNT(DISTINCT c.id) AS cards, "
                    "       COALESCE(SUM(c.lapses), 0) AS lapses, "
                    "       COUNT(r.id) AS reviews, "
                    "       AVG(r.grade) AS avg_grade, "
                    "       SUM(CASE WHEN r.grade = 1 THEN 1 ELSE 0 END) AS again "
                    "FROM cards c "
                    "JOIN card_reviews r ON r.card_id = c.id "
                    f"  AND r.reviewed_at >= datetime('now', '-{days} days') "
                    "WHERE c.source <> '' "
                    "GROUP BY c.source "
                    "ORDER BY avg_grade ASC, lapses DESC "
                    f"LIMIT {max(1, min(int(limit), 50))}"
                )
            )
        ).all()

    out = []
    for r in rows:
        reviews = int(r[4] or 0)
        avg = float(r[5]) if r[5] is not None else None
        again = int(r[6] or 0)
        again_rate = (again / reviews) if reviews else None
        out.append(
            {
                "source": r[0],
                "source_label": r[1] or r[0],
                "cards": int(r[2] or 0),
                "lapses": int(r[3] or 0),
                "reviews": reviews,
                "avg_grade": round(avg, 2) if avg is not None else None,
                "again_rate": round(again_rate, 3) if again_rate is not None else None,
                "weak": bool(
                    reviews >= WEAK_MIN_REVIEWS
                    and (
                        (avg is not None and avg < WEAK_AVG_GRADE)
                        or (again_rate is not None and again_rate >= WEAK_AGAIN_RATE)
                    )
                ),
            }
        )
    return out


# ---------- 主动层：每日提醒 + 每周补讲 ----------

_REMEDY_SYSTEM = (
    "你是用户的技术学习助手。用户在某篇材料的复习卡上反复答错，"
    "说明这块知识没真正吃透。请针对他答错的那几个点写一篇补充讲解。\n"
    "要求：\n"
    "① 只讲他错的那几个点，不要复述整篇材料。\n"
    "② 每个点讲清三件事：到底发生了什么、为什么会这样、下次怎么判断出来。\n"
    "③ 能给最小可运行示例就给，代码用 ``` 围起来。\n"
    "④ 用 Markdown，二级标题分点，不要写开场白和总结套话。\n"
    "⑤ 只用材料里的信息，不要编造材料里没有的事实。"
)

REMEDY_MAX_SOURCES = 2
REMEDY_MATERIAL_CHARS = 6000
REMEDY_CARDS = 3


def reschedule() -> None:
    """(Re)register the daily reminder and the weekly remediation job."""
    from app.core import scheduler as sched
    from app.core.prefs import load_config

    cfg = load_config()
    sched.set_daily(
        "cards_remind",
        _remind,
        bool(cfg.get("cards_remind_enabled", True)),
        cfg.get("cards_remind_time") or "20:00",
        default_hour=20,
    )
    if bool(cfg.get("cards_remedy_enabled", True)):
        sched.set_cron("cards_remediate", _remediate_run, "0 21 * * 0")  # 周日 21:00
    else:
        sched.prune_jobs("cards_remediate", keep=set())


async def _remind() -> None:
    """零柒 mentions today's queue — but only when there is actually something."""
    try:
        q = await queue()
        n = len(q["due"]) + len(q["fresh"])
        if n == 0:
            return  # frugal by contract: nothing to say, say nothing
        st = await stats()
        from app.core import pet

        pet.emit("cards_due", count=n, detail=str(st.get("streak") or 0))
    except Exception:  # noqa: BLE001 - the pet must never break the scheduler
        log.exception("cards remind failed")


async def _remediate_run() -> None:
    try:
        log.info("cards remediation: %s", await remediate())
    except Exception:  # noqa: BLE001
        log.exception("cards remediation failed")


async def remediate(days: int = 14) -> dict:
    """Write a follow-up explainer into the vault for each weak source.

    Deliberately a standalone job rather than a row in the `tasks` table:
    `ScheduledTask.prompt` is static text, so a scheduled task could never know
    which source is weak *this* week, and teaching the agent mode to look it up
    would mean shipping a new model-visible tool for one fixed weekly action.
    Shape follows `core/digest.generate_digest()`: rollup read, one LLM call,
    one file write. The file lands in the vault, so the watcher indexes it and
    it becomes carding material itself — wrong → explained → asked again.
    """
    from sqlalchemy import select

    from app.config import VAULT_DIR
    from app.core import ingest
    from app.core.llm import ProviderInfo, stream_chat
    from app.core.pet import _default_model_id
    from app.db import SessionLocal
    from app.models import Card
    from app.routers.chat import resolve_model

    weak = [w for w in await weak_sources(days=days) if w["weak"]][:REMEDY_MAX_SOURCES]
    if not weak:
        return {"ok": True, "written": 0, "message": "没有薄弱来源，跳过"}

    model_id = _default_model_id()
    if not model_id:
        return {"ok": False, "error": "没有已启用的 provider"}
    resolved = await resolve_model(model_id)
    p = resolved.provider
    info = ProviderInfo(kind=p.kind, base_url=p.base_url, api_key=p.api_key)

    root = VAULT_DIR.resolve()
    out_dir = root / "notes"
    out_dir.mkdir(parents=True, exist_ok=True)
    written: list[str] = []

    for w in weak:
        try:
            src = (root / w["source"]).resolve()
            material = ""
            if src.is_relative_to(root) and src.is_file():
                material = (ingest.parse_file(src) or "")[:REMEDY_MATERIAL_CHARS]
            async with SessionLocal() as db:
                rows = (
                    (
                        await db.execute(
                            select(Card)
                            .where(Card.source == w["source"])
                            .order_by(Card.lapses.desc(), Card.ease)
                            .limit(REMEDY_CARDS)
                        )
                    )
                    .scalars()
                    .all()
                )
            missed = "\n\n".join(
                f"【错题 {i + 1}】\nQ: {c.front}\nA: {c.back}" for i, c in enumerate(rows)
            )
            if not missed:
                continue
            user = (
                f"材料来源：{w['source']}（平均分 {w['avg_grade']}，"
                f"重来 {w['again_rate']}）\n\n{missed}\n\n"
                f"---\n【原材料节选】\n{material or '（读不到原文，仅按错题作答）'}"
            )
            parts: list[str] = []
            async for delta in stream_chat(
                info,
                resolved.model,
                [
                    {"role": "system", "content": _REMEDY_SYSTEM},
                    {"role": "user", "content": user},
                ],
            ):
                parts.append(delta)
            body = "".join(parts).strip()
            if not body:
                continue
            today = datetime.now().strftime("%Y-%m-%d")
            stem = re.sub(r"[\\/:*?\"<>|]", "-", src.stem or w["source"])[:60]
            f = out_dir / f"补讲-{stem}-{today}.md"
            f.write_text(
                f"# 补讲 · {stem}\n\n"
                f"> 自动生成 {today} · 依据近 {days} 天的复习记录"
                f"（平均分 {w['avg_grade']}，{len(rows)} 张错题）\n\n{body}\n",
                encoding="utf-8",
            )
            written.append(f.name)
        except Exception:  # noqa: BLE001 - one bad source must not kill the rest
            log.exception("remediation failed for %s", w.get("source"))

    if written:
        try:
            from app.core import pet

            pet.emit("cards_remedy", name=written[0], count=len(written))
        except Exception:  # noqa: BLE001
            pass
    return {"ok": True, "written": len(written), "files": written}












