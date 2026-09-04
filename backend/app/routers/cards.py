"""Review cards: AI generation (SSE), the daily queue, grading, stats.

Thin HTTP layer — every rule lives in `app/core/cards.py`. Two things about the
shapes here are deliberate:

- All literal paths (`/queue`, `/stats`, ...) are declared BEFORE `/{card_id}`.
  FastAPI matches in declaration order, and `/{card_id}` with an int annotation
  would structurally match `/queue` and then fail validation with a 422 rather
  than falling through.
- `/generate/stream` validates everything it can BEFORE opening the SSE stream:
  once the response has started there is no way to set a status code. Same
  lesson as smoke_podcast_stream.py.
"""
import json
import logging

from fastapi import APIRouter, HTTPException
from fastapi.responses import PlainTextResponse, StreamingResponse
from pydantic import BaseModel, field_validator

from app.core import cards as core

router = APIRouter(prefix="/api/cards", tags=["cards"])
log = logging.getLogger(__name__)

MAX_BATCH = 50


class CardDraft(BaseModel):
    kind: str = "concept"
    front: str
    back: str
    hint: str = ""
    topic: str = ""
    excerpt: str = ""
    origin: str = "ai"  # ai | manual — 手工/划词卡要能在统计里分出来

    @field_validator("origin")
    @classmethod
    def check_origin(cls, v: str) -> str:
        if v not in ("ai", "manual"):
            raise ValueError("origin 只能是 ai 或 manual")
        return v


class ClozeIn(BaseModel):
    text: str
    start: int
    end: int
    topic: str = ""


class GenerateIn(BaseModel):
    source_path: str = ""
    text: str = ""
    count: int = core.DEFAULT_CARDS
    kinds: list[str] = []
    model_id: str = ""


class BatchIn(BaseModel):
    cards: list[CardDraft]
    source: str = ""
    source_label: str = ""
    model_id: str = ""


class ReviewIn(BaseModel):
    grade: int
    seconds: float = 0.0


class CardPatch(BaseModel):
    front: str | None = None
    back: str | None = None
    hint: str | None = None
    topic: str | None = None
    kind: str | None = None
    suspended: bool | None = None


def _sse(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


# ---------- literal paths (must precede /{card_id}) ----------


@router.post("/generate/stream")
async def generate_stream(body: GenerateIn):
    """AI card generation with live progress. Returns candidates only — no writes."""
    if body.count <= 0:
        raise HTTPException(400, "count 必须为正")
    bad = [k for k in body.kinds if k not in core.KINDS]
    if bad:
        raise HTTPException(422, f"未知卡型：{', '.join(bad)}")
    try:  # fail fast on input BEFORE the stream opens
        core.collect_material(source_path=body.source_path, text=body.text)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e

    async def gen():
        try:
            async for stage, data in core.generate_iter(
                source_path=body.source_path,
                text=body.text,
                count=body.count,
                kinds=body.kinds or None,
                model_id=body.model_id,
            ):
                if stage == "done":
                    yield _sse("done", data)
                else:
                    yield _sse("stage", {"stage": stage, **data})
        except ValueError as e:  # parsing / material problems: report, don't 500
            yield _sse("done", {"ok": False, "error": str(e)})
        except Exception as e:  # noqa: BLE001
            log.exception("card generation failed")
            yield _sse("done", {"ok": False, "error": f"{type(e).__name__}: {e}"})

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.post("/batch")
async def add_cards(body: BatchIn):
    """Insert the candidates the user actually ticked."""
    if not body.cards:
        raise HTTPException(400, "没有要保存的卡片")
    if len(body.cards) > MAX_BATCH:
        raise HTTPException(400, f"一次最多保存 {MAX_BATCH} 张")
    return await core.save_cards(
        [c.model_dump() for c in body.cards],
        source=body.source,
        source_label=body.source_label,
        model_id=body.model_id,
    )


@router.post("/cloze")
async def make_cloze(body: ClozeIn):
    """Turn a selected span into a cloze draft. Pure string work, no model call.

    The rules live on the server rather than in the page because this project has
    224 backend tests and no frontend test runner — logic in Python is logic that
    is actually covered. One localhost round trip is <5ms.
    """
    draft = core.make_cloze(body.text, body.start, body.end)
    if draft is None:
        raise HTTPException(
            400,
            f"这段挖不成填空卡：选中 1-{core.CLOZE_MAX_SELECTION} 字，"
            f"且挖空后要留下至少 {core.CLOZE_MIN_CONTEXT} 字线索",
        )
    if body.topic.strip():
        draft["topic"] = body.topic.strip()[:100]
    return draft


@router.get("/sources")
async def list_sources(q: str = "", limit: int = 200):
    """Everything that can be carded: vault files + indexed repo/dir files.

    Filtering happens here rather than in the page on purpose: a monorepo can
    have 1500 indexed files, and shipping all of them every time the panel opens
    is megabytes. `totals` lets the UI say "showing 200 of 812".
    """
    from app.config import VAULT_DIR
    from app.core import indexer, ingest

    limit = max(1, min(int(limit), 1000))
    needle = q.strip().lower()

    def _cut(items: list[str]) -> tuple[list[str], int]:
        hit = sorted({s for s in items if s and (not needle or needle in s.lower())})
        return hit[:limit], len(hit)

    def _external(prefix: str) -> list[str]:
        try:  # a chroma hiccup must not 500 the picker
            return [core.spec_from_indexer_source(s) for s in indexer.list_sources(prefix)]
        except Exception:  # noqa: BLE001
            log.debug("list_sources(%s) failed", prefix, exc_info=True)
            return []

    vault, vault_n = _cut(
        [
            p.relative_to(VAULT_DIR).as_posix()
            for p in VAULT_DIR.rglob("*")
            if p.is_file() and ingest.is_supported(p)
        ]
    )
    repos, repos_n = _cut(_external(indexer.REPO_SOURCE_PREFIX))
    dirs_, dirs_n = _cut(_external(indexer.DIR_SOURCE_PREFIX))
    return {
        "vault": vault,
        "repos": repos,
        "dirs": dirs_,
        "totals": {"vault": vault_n, "repos": repos_n, "dirs": dirs_n},
        "card_counts": await core.source_card_counts(),
    }


@router.get("/search")
async def search_material(q: str, top_k: int = 6):
    """Retrieval hits, ready to card.

    Wraps the same `indexer.search_auto` the KB page uses, but each hit arrives
    with the `spec` that `collect_material` accepts and with how many cards
    already came from that source — so the panel needs no mapping logic of its
    own and `kb.py` stays untouched.

    First call after a cold start pulls in the embedder and reranker (~6s per
    PLAN.md v0.10), so the caller must show a waiting state.
    """
    import asyncio

    from app.core import indexer

    if not q.strip():
        raise HTTPException(400, "先输入一个问题")
    top_k = max(1, min(int(top_k), 20))
    hits = await asyncio.to_thread(indexer.search_auto, q.strip(), top_k)
    counts = await core.source_card_counts()
    out = []
    for h in hits:
        src = h.get("source") or ""
        spec = core.spec_from_indexer_source(src)
        out.append(
            {
                "source": src,
                "spec": spec,
                "title": h.get("title") or src,
                "chunk": h.get("chunk"),
                "score": h.get("score"),
                "text": h.get("text") or "",
                "cards": counts.get(spec or src, 0),
            }
        )
    return {"query": q.strip(), "hits": out}


@router.get("/material")
async def get_material(source: str):
    """Parsed text of one source, for the manual cloze pane.

    Reads up to PANE_MAX_CHARS rather than the model's 15000-char budget: the pane
    is for reading and selecting, and a real source file is routinely longer than
    a prompt (core/cards.py alone is 45k chars, so the tighter cap made two thirds
    of it unselectable).
    """
    try:
        src, label, text = core.collect_material(
            source_path=source, max_chars=core.PANE_MAX_CHARS
        )
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    return {
        "source": src,
        "source_label": label,
        "text": text,
        # exact length equal to the cap means it almost certainly got cut; a false
        # positive here costs one extra hint line, so the heuristic is fine
        "truncated": len(text) >= core.PANE_MAX_CHARS,
        "gen_limit": core.MAX_INPUT_CHARS,
    }


@router.get("/queue")
async def get_queue():
    return await core.queue()


@router.get("/stats")
async def get_stats():
    return await core.stats()


@router.get("/weak")
async def get_weak(days: int = 30, limit: int = 10):
    return {"days": days, "sources": await core.weak_sources(days=days, limit=limit)}


@router.get("/export", response_class=PlainTextResponse)
async def export_cards():
    """All cards as one markdown document.

    Cards live in SQLite (and therefore in the backup zip), but a plain-text
    export means a hand-reviewed deck survives even a lost database.
    """
    from sqlalchemy import select

    from app.db import SessionLocal
    from app.models import Card

    async with SessionLocal() as db:
        rows = (
            (await db.execute(select(Card).order_by(Card.source, Card.id))).scalars().all()
        )
    lines = [f"# 复习卡片导出（{len(rows)} 张）\n"]
    last = object()
    for c in rows:
        if c.source_label != last:
            last = c.source_label
            lines.append(f"\n## {c.source_label or '手工'}\n")
        lines.append(f"### [{c.kind}] {c.front}\n\n{c.back}\n")
        if c.hint:
            lines.append(f"> 提示：{c.hint}\n")
    return PlainTextResponse(
        "\n".join(lines),
        media_type="text/markdown; charset=utf-8",
        headers={"Content-Disposition": 'attachment; filename="cards.md"'},
    )


@router.get("")
async def list_cards(
    source: str = "", kind: str = "", topic: str = "", limit: int = 100, offset: int = 0
):
    from sqlalchemy import func, select

    from app.db import SessionLocal
    from app.models import Card

    limit = max(1, min(int(limit), 200))
    q = select(Card)
    cnt = select(func.count(Card.id))
    for col, val in ((Card.source, source), (Card.kind, kind), (Card.topic, topic)):
        if val:
            q, cnt = q.where(col == val), cnt.where(col == val)
    async with SessionLocal() as db:
        total = (await db.execute(cnt)).scalar() or 0
        rows = (
            (await db.execute(q.order_by(Card.id.desc()).limit(limit).offset(max(0, offset))))
            .scalars()
            .all()
        )
    return {"total": int(total), "cards": [core.as_dict(c) for c in rows]}


# ---------- per-card paths ----------


@router.post("/{card_id}/review")
async def review_card(card_id: int, body: ReviewIn):
    try:
        return await core.submit_review(card_id, body.grade, body.seconds)
    except LookupError as e:
        raise HTTPException(404, "卡片不存在") from e
    except ValueError as e:
        msg = str(e)
        raise HTTPException(422 if "grade" in msg else 400, msg) from e


@router.post("/{card_id}/undo")
async def undo_card(card_id: int):
    return await core.undo_review(card_id)


@router.get("/{card_id}")
async def get_card(card_id: int):
    from sqlalchemy import select

    from app.db import SessionLocal
    from app.models import Card, CardReview

    async with SessionLocal() as db:
        card = (await db.execute(select(Card).where(Card.id == card_id))).scalar_one_or_none()
        if card is None:
            raise HTTPException(404, "卡片不存在")
        revs = (
            (
                await db.execute(
                    select(CardReview)
                    .where(CardReview.card_id == card_id)
                    .order_by(CardReview.id.desc())
                    .limit(20)
                )
            )
            .scalars()
            .all()
        )
    return {
        "card": core.as_dict(card),
        "reviews": [
            {
                "id": r.id,
                "reviewed_at": r.reviewed_at.isoformat() if r.reviewed_at else None,
                "grade": r.grade,
                "seconds": r.seconds,
                "interval_before": r.interval_before,
                "interval_after": r.interval_after,
                "ease_after": r.ease_after,
            }
            for r in revs
        ],
    }


@router.put("/{card_id}")
async def update_card(card_id: int, body: CardPatch):
    from sqlalchemy import select

    from app.db import SessionLocal
    from app.models import Card

    patch = {k: v for k, v in body.model_dump().items() if v is not None}
    if not patch:
        raise HTTPException(400, "没有要修改的字段")
    if "kind" in patch and patch["kind"] not in core.KINDS:
        raise HTTPException(422, f"kind 只能是 {'/'.join(core.KINDS)}")
    for field, cap in (("front", core.MAX_FRONT_CHARS), ("back", core.MAX_BACK_CHARS)):
        if field in patch:
            if not str(patch[field]).strip():
                raise HTTPException(400, f"{field} 不能为空")
            if len(str(patch[field])) > cap:
                raise HTTPException(400, f"{field} 超过 {cap} 字")
    async with SessionLocal() as db:
        card = (await db.execute(select(Card).where(Card.id == card_id))).scalar_one_or_none()
        if card is None:
            raise HTTPException(404, "卡片不存在")
        for k, v in patch.items():
            setattr(card, k, v)
        await db.commit()
        return core.as_dict(card)


@router.delete("/{card_id}")
async def delete_card(card_id: int):
    """Delete a card and its revlog rows.

    Explicit rather than relying on ON DELETE CASCADE: this project never turns
    on `PRAGMA foreign_keys`, so a declared cascade would be documentation only
    (`TaskRun.task_id` is a plain indexed Integer for the same reason).
    """
    from sqlalchemy import delete, select

    from app.db import SessionLocal
    from app.models import Card, CardReview

    async with SessionLocal() as db:
        card = (await db.execute(select(Card).where(Card.id == card_id))).scalar_one_or_none()
        if card is None:
            raise HTTPException(404, "卡片不存在")
        await db.execute(delete(CardReview).where(CardReview.card_id == card_id))
        await db.delete(card)
        await db.commit()
    core._vec_cache.pop(card_id, None)
    return {"ok": True}



