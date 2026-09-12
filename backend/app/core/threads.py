"""「一件事」——地基（§4-15）。

材料 / 笔记 / 卡片 / 卡点 / 成品 / 判断都挂到同一个单位上，「这件事我到哪了」「我这个月干了
什么」才答得出来。它是 §4-14（检索命中一键挂到）、§4-16（成本按事记）、§4-17（`today` 装
东西）共同的地基。

**三条设计约束**（来自 PLAN §4-15）：

1. **vault 不搬家。** 这里只有名字与引用（`ThreadItem.kind + ref`）——笔记还是笔记、成品还在
   原位。删掉一件事不会动任何东西，只是少了一层索引。
2. **能完全不手打标签。** 挂接靠**确认派生结果**，不靠打字：拿条目自己的标签（卡片的 `topic`、
   教学的概念、判断的领域、产出的标题…）去比对已有「事」的名字，命中的列出来，点一下即可。
3. **允许「未归类」长期存在。** 不给它计数、不催——它是常态，不是欠账。
"""

import logging
import re
from datetime import datetime, timezone
from pathlib import Path

from sqlalchemy import select

from app.config import VAULT_DIR
from app.db import SessionLocal
from app.models import Card, DecisionLog, ScheduledTask, Thread, ThreadItem, TutorSession

log = logging.getLogger(__name__)

KINDS = ("material", "note", "card", "tutor", "output", "task", "decision")

# 五步 → 哪些 kind 落进这一步。PLAN 写的第五步是「再用」；手里真有数据的第五类是**判断**，
# 所以这里叫「判断」——"再用"（检索命中一键挂进来）是 §4-14 的事，加一个桶即可，表不用动。
STEPS: tuple[tuple[str, str, tuple[str, ...]], ...] = (
    ("in", "进来", ("material",)),
    ("learn", "搞懂", ("tutor", "card")),
    ("keep", "留下", ("note",)),
    ("deliver", "交付", ("output", "task")),
    ("judge", "判断", ("decision",)),
)
_STEP_OF = {k: key for key, _label, kinds in STEPS for k in kinds}

# vault 里哪几个目录算哪一类。`notes/` 要按命名再分：带日期前缀的是**成文**（产出），
# 不带的是用户自己的笔记——`routers/work.py` 也是这么分的。
_VAULT_DIRS = (
    "clippings",
    "notes",
    "research",
    "deliver",
    "decisions",
    "conflicts",
    "recap",
    "tasks",
)
_CATALOG_CAP = 200  # 每类最多列这么多——九百多个仓库分块全列出来只是噪音
_DATE_LEN = 10


# ---------- 小工具 ----------


def _iso(dt: datetime | None) -> str | None:
    return dt.astimezone().isoformat(timespec="seconds") if dt else None


def _norm(s: str) -> str:
    """比对前把空白与常见标点抹掉。Pure."""
    return re.sub(r"[\s·、，,。：:;；\-_/]+", "", (s or "").lower())


def _matches(a: str, b: str) -> bool:
    """两段文字算不算「同一件事」。**子串包含**，不猜语义。Pure.

    中文没有词边界，分词在这里帮不上忙；而子串包含恰好是能解释的——`RAG` ⊂ `RAG 评测的坑`。
    短于 2 字的不参与，否则一个「的」字就全命中了。
    """
    x, y = _norm(a), _norm(b)
    if len(x) < 2 or len(y) < 2:
        return False
    return x in y or y in x


def _looks_dated(stem: str) -> bool:
    """`YYYY-MM-DD-…`——产出与成文的命名都是这个形状。"""
    if len(stem) <= _DATE_LEN or stem[_DATE_LEN] != "-":
        return False
    d = stem[:_DATE_LEN]
    return d[4] == "-" and d[7] == "-" and d.replace("-", "").isdigit()


def _vault_title(p: Path) -> str:
    """第一个一级标题；没有就退回文件名（剥掉日期前缀）。"""
    try:
        with p.open(encoding="utf-8", errors="ignore") as fh:
            for _ in range(40):
                line = fh.readline()
                if not line:
                    break
                s = line.strip()
                if s.startswith("# "):
                    return s[2:].strip() or p.stem
    except OSError:
        pass
    return p.stem[_DATE_LEN + 1 :] if _looks_dated(p.stem) else p.stem


def _clean_ref(ref: str) -> str:
    r = (ref or "").strip().replace("\\", "/").lstrip("/")
    if ".." in r.split("/"):
        raise ValueError("ref 不能越出 vault")
    return r[:300]


def steps_out() -> list[dict]:
    """五步的定义——给界面当唯一真值，前端不硬编码。Pure."""
    return [{"key": k, "label": label, "kinds": list(kinds)} for k, label, kinds in STEPS]


# ---------- 可挂的东西（候选的来源） ----------


def _vault_catalog(limit: int = _CATALOG_CAP) -> list[dict]:
    """vault 里的成品 / 笔记 / 材料。按目录分辨，`notes/` 再按命名分。"""
    out: list[dict] = []
    for dirname in _VAULT_DIRS:
        d = VAULT_DIR / dirname
        if not d.is_dir():
            continue
        files = sorted(
            (p for p in d.glob("*.md") if p.is_file()),
            key=lambda p: p.stat().st_mtime,
            reverse=True,
        )[:limit]
        for p in files:
            if dirname == "clippings":
                kind = "material"
            elif dirname == "notes":
                kind = "output" if _looks_dated(p.stem) else "note"
            else:
                kind = "output"
            title = _vault_title(p)
            out.append(
                {
                    "kind": kind,
                    "ref": p.relative_to(VAULT_DIR).as_posix(),
                    "title": title,
                    "label": title,
                }
            )
    return out


async def _catalog() -> list[dict]:
    """可挂的东西：最近的一些卡片 / 教学 / 判断 / 工作流 + vault 里的成品与笔记。

    不是「全部材料」——仓库分块有九百多个，全列出来只是噪音。
    """
    out: list[dict] = []
    async with SessionLocal() as db:
        for c in (
            await db.execute(select(Card).order_by(Card.id.desc()).limit(_CATALOG_CAP))
        ).scalars():
            out.append(
                {
                    "kind": "card",
                    "ref": str(c.id),
                    "title": (c.front or "")[:80],
                    "label": c.topic or c.front or "",
                }
            )
        for s in (
            await db.execute(select(TutorSession).order_by(TutorSession.id.desc()).limit(_CATALOG_CAP))
        ).scalars():
            out.append(
                {
                    "kind": "tutor",
                    "ref": str(s.id),
                    "title": s.topic or "",
                    "label": s.concept or s.topic or "",
                }
            )
        for d in (
            await db.execute(select(DecisionLog).order_by(DecisionLog.id.desc()).limit(_CATALOG_CAP))
        ).scalars():
            out.append(
                {
                    "kind": "decision",
                    "ref": str(d.id),
                    "title": (d.text or "")[:80],
                    "label": d.topic or d.text or "",
                }
            )
        for t in (await db.execute(select(ScheduledTask).order_by(ScheduledTask.id))).scalars():
            out.append({"kind": "task", "ref": str(t.id), "title": t.name, "label": t.name})
    out.extend(_vault_catalog())
    return out


async def _resolve(rows: list[ThreadItem]) -> list[dict]:
    """`(kind, ref)` → 给人看的标题与落点。

    **一条解析不了不能带塌整页**：引用本身还在，只是它指的东西没了——标 `exists=False`
    照常列出来，比整页 500 诚实得多。
    """
    ids: dict[str, list[int]] = {}
    for r in rows:
        if r.kind in ("card", "tutor", "decision", "task") and (r.ref or "").isdigit():
            ids.setdefault(r.kind, []).append(int(r.ref))

    found: dict[tuple[str, str], str] = {}
    async with SessionLocal() as db:
        if ids.get("card"):
            for c in (await db.execute(select(Card).where(Card.id.in_(ids["card"])))).scalars():
                found[("card", str(c.id))] = (c.front or "")[:80]
        if ids.get("tutor"):
            for s in (
                await db.execute(select(TutorSession).where(TutorSession.id.in_(ids["tutor"])))
            ).scalars():
                found[("tutor", str(s.id))] = s.topic or ""
        if ids.get("decision"):
            for d in (
                await db.execute(select(DecisionLog).where(DecisionLog.id.in_(ids["decision"])))
            ).scalars():
                found[("decision", str(d.id))] = (d.text or "")[:80]
        if ids.get("task"):
            for t in (
                await db.execute(select(ScheduledTask).where(ScheduledTask.id.in_(ids["task"])))
            ).scalars():
                found[("task", str(t.id))] = t.name

    out: list[dict] = []
    for r in rows:
        key = (r.kind, r.ref)
        if r.kind in ("card", "tutor", "decision", "task"):
            title = found.get(key, "")
            exists = key in found
        else:
            p = VAULT_DIR / r.ref
            exists = p.is_file()
            title = _vault_title(p) if exists else ""
        out.append(
            {
                "kind": r.kind,
                "ref": r.ref,
                "title": title or "（已不存在）",
                "exists": exists,
                "step": _STEP_OF.get(r.kind, "in"),
                "href": _href(r.kind, r.ref) if exists else "",
            }
        )
    return out


def _href(kind: str, ref: str) -> str:
    """点开去哪。卡片没有单卡深链（今日是队列），所以给队列页。"""
    if kind == "card":
        return "/review"
    if kind == "tutor":
        return f"/tutor?session={ref}"
    if kind == "decision":
        return "/dashboard"
    if kind == "task":
        return "/work"
    return f"/notes?path={ref}"


# ---------- 事 ----------


def _out(t: Thread, counts: dict[str, int]) -> dict:
    return {
        "id": t.id,
        "name": t.name,
        "note": t.note or "",
        "archived": bool(t.archived),
        "created_at": _iso(t.created_at),
        "updated_at": _iso(t.updated_at),
        "counts": counts,
        "total": sum(counts.values()),
    }


def _counts(rows) -> dict[str, int]:
    out: dict[str, int] = {}
    for r in rows:
        out[r.kind] = out.get(r.kind, 0) + 1
    return out


async def create(name: str, note: str = "") -> dict:
    name = (name or "").strip()[:120]
    if not name:
        raise ValueError("名字不能为空")
    async with SessionLocal() as db:
        row = Thread(name=name, note=(note or "").strip()[:2000])
        db.add(row)
        await db.commit()
        await db.refresh(row)
    return _out(row, {})


async def update(
    thread_id: int, *, name: str | None = None, note: str | None = None, archived: bool | None = None
) -> dict:
    async with SessionLocal() as db:
        row = await db.get(Thread, thread_id)
        if row is None:
            raise LookupError("thread not found")
        if name is not None:
            n = name.strip()[:120]
            if not n:
                raise ValueError("名字不能为空")
            row.name = n
        if note is not None:
            row.note = note.strip()[:2000]
        if archived is not None:
            row.archived = bool(archived)
        row.updated_at = datetime.now(timezone.utc)
        await db.commit()
        await db.refresh(row)
        counts = _counts(
            (await db.execute(select(ThreadItem).where(ThreadItem.thread_id == thread_id))).scalars().all()
        )
    return _out(row, counts)


async def delete(thread_id: int) -> dict:
    """删一件事只删索引，**不动任何东西**。"""
    from sqlalchemy import delete as sa_delete

    async with SessionLocal() as db:
        row = await db.get(Thread, thread_id)
        if row is None:
            raise LookupError("thread not found")
        await db.execute(sa_delete(ThreadItem).where(ThreadItem.thread_id == thread_id))
        await db.delete(row)
        await db.commit()
    return {"ok": True}


async def list_threads(include_archived: bool = False) -> dict:
    async with SessionLocal() as db:
        stmt = select(Thread).order_by(Thread.updated_at.desc(), Thread.id.desc())
        if not include_archived:
            stmt = stmt.where(Thread.archived.is_(False))
        rows = (await db.execute(stmt)).scalars().all()
        items = (await db.execute(select(ThreadItem))).scalars().all()
    per: dict[int, dict[str, int]] = {}
    for it in items:
        per.setdefault(it.thread_id, {})
        per[it.thread_id][it.kind] = per[it.thread_id].get(it.kind, 0) + 1
    return {
        "threads": [_out(t, per.get(t.id, {})) for t in rows],
        "steps": steps_out(),
    }


async def _cost(thread_id: int) -> dict:
    """这件事头上记着的账（§4-16）。按模型分开——「这件事用了哪些模型」也是答案的一半。"""
    from app.models import ModelUsage

    async with SessionLocal() as db:
        rows = (
            await db.execute(select(ModelUsage).where(ModelUsage.thread_id == thread_id))
        ).scalars().all()
    by_model: dict[str, dict] = {}
    tin = tout = calls = 0
    for r in rows:
        b = by_model.setdefault(r.model_id or "—", {"in": 0, "out": 0, "calls": 0})
        b["in"] += r.tokens_in or 0
        b["out"] += r.tokens_out or 0
        b["calls"] += r.calls or 0
        tin += r.tokens_in or 0
        tout += r.tokens_out or 0
        calls += r.calls or 0
    return {
        "tokens_in": tin,
        "tokens_out": tout,
        "total": tin + tout,
        "calls": calls,
        "by_model": by_model,
    }


async def deliver_into(thread_id: int, genre: str, audience: str) -> dict:
    """就这件事写一份交付，**这一路的模型用量记在它头上**（§4-16）。

    这是「成本按事记」唯一的入口：不是事后拿 `ref` 去猜归属，而是**在做的当下**就知道
    这笔钱是为谁花的。产出落 `vault/deliver/` 并顺手挂到这件事上。
    """
    from app.core import compose
    from app.core import deliver as deliver_engine
    from app.core import report as _report
    from app.core import usage_ledger

    async with SessionLocal() as db:
        t = await db.get(Thread, thread_id)
        if t is None:
            raise LookupError("thread not found")
        name = t.name
        rows = (
            await db.execute(select(ThreadItem).where(ThreadItem.thread_id == thread_id))
        ).scalars().all()

    # 这件事挂着的材料 / 笔记 / 成品，就是这次产出的材料——「这件事用过哪些材料」的直接复用
    pinned = [r.ref for r in rows if r.kind in ("material", "note", "output")]
    prompt = deliver_engine.synth_prompt(genre, audience)  # 未知体裁/读者 → ValueError
    gathered = await compose.gather_inward(name)
    sources = deliver_engine.merge_pinned(deliver_engine.pinned_sources(pinned), gathered)
    if not sources:
        raise ValueError("这件事上还没有可用的材料——先往里挂点东西")

    async with usage_ledger.span("deliver", name, thread_id=thread_id):
        rep = await _report.synthesize(name, sources, prompt)
    if rep is None:
        raise ValueError("成文失败——默认模型不可用，或输出无法解析")

    saved = await deliver_engine.save(rep, sources)
    await attach(thread_id, "output", saved["filename"])
    return saved


async def detail(thread_id: int, *, suggest: bool = True) -> dict:
    async with SessionLocal() as db:
        t = await db.get(Thread, thread_id)
        if t is None:
            raise LookupError("thread not found")
        rows = (
            await db.execute(
                select(ThreadItem)
                .where(ThreadItem.thread_id == thread_id)
                .order_by(ThreadItem.id.desc())
            )
        ).scalars().all()
        attached = {
            (r.kind, r.ref) for r in (await db.execute(select(ThreadItem))).scalars().all()
        }

    items = await _resolve(rows)
    out = {
        **_out(t, _counts(rows)),
        "items": items,
        "by_step": {key: [it for it in items if it["step"] == key] for key, _l, _k in STEPS},
        "steps": steps_out(),
        "cost": await _cost(thread_id),
    }
    # 「这些可能也属于这件事」——这正是"不手打标签"的另一半：你只确认，不打字
    out["suggestions"] = await _suggest_items(t.name, attached) if suggest else []
    return out


async def attach(thread_id: int, kind: str, ref: str) -> dict:
    kind = (kind or "").strip()
    if kind not in KINDS:
        raise ValueError(f"unknown kind '{kind}'")
    ref = _clean_ref(ref)
    if not ref:
        raise ValueError("ref 不能为空")
    async with SessionLocal() as db:
        t = await db.get(Thread, thread_id)
        if t is None:
            raise LookupError("thread not found")
        existing = (
            await db.execute(
                select(ThreadItem).where(
                    ThreadItem.thread_id == thread_id,
                    ThreadItem.kind == kind,
                    ThreadItem.ref == ref,
                )
            )
        ).scalars().first()
        # 幂等：挂过就不重复插（唯一索引兜底，这里只是让返回值说实话）
        if existing is None:
            db.add(ThreadItem(thread_id=thread_id, kind=kind, ref=ref))
        t.updated_at = datetime.now(timezone.utc)
        await db.commit()
    return {"ok": True, "attached": existing is None}


async def detach(thread_id: int, kind: str, ref: str) -> dict:
    from sqlalchemy import delete as sa_delete

    async with SessionLocal() as db:
        await db.execute(
            sa_delete(ThreadItem).where(
                ThreadItem.thread_id == thread_id,
                ThreadItem.kind == (kind or "").strip(),
                ThreadItem.ref == _clean_ref(ref),
            )
        )
        t = await db.get(Thread, thread_id)
        if t is not None:
            t.updated_at = datetime.now(timezone.utc)
        await db.commit()
    return {"ok": True}


async def _suggest_items(
    name: str, attached: set[tuple[str, str]], *, limit: int = 8
) -> list[dict]:
    """还没挂、但名字撞得上的条目。"""
    out: list[dict] = []
    for c in await _catalog():
        if (c["kind"], c["ref"]) in attached:
            continue
        if _matches(name, c["label"]):
            out.append({**c, "step": _STEP_OF.get(c["kind"], "in")})
            if len(out) >= limit:
                break
    return out


async def suggest_for_item(kind: str, ref: str) -> dict:
    """这个条目该挂到哪件事上？——按它自己的标签比对已有「事」的名字。"""
    label = ""
    for c in await _catalog():
        if c["kind"] == kind and c["ref"] == ref:
            label = c["label"]
            break
    async with SessionLocal() as db:
        rows = (await db.execute(select(Thread).where(Thread.archived.is_(False)))).scalars().all()
    hits = [t for t in rows if _matches(t.name, label)]
    return {"label": label, "threads": [_out(t, {}) for t in hits]}


async def unclassified(limit: int = 60) -> dict:
    """还没挂到任何事的条目。**允许长期存在**——这不是待办清单，不计数、不催。"""
    async with SessionLocal() as db:
        attached = {
            (r.kind, r.ref) for r in (await db.execute(select(ThreadItem))).scalars().all()
        }
    items = [c for c in await _catalog() if (c["kind"], c["ref"]) not in attached]
    return {"items": items[:limit], "total": len(items)}


async def recent(limit: int = 1) -> list[dict]:
    """最近动过、还没归档、且挂了东西的一件事——给 `today` 当「今天从哪开始」（§4-17）。

    只说**它到哪了**，不说"你还欠什么"：前者是状态，后者是债，而这个产品的红线就是不做债。
    所以这里不返回"缺了哪一步"，也不把「未归类」的条数放上来。
    """
    rows = [t for t in (await list_threads())["threads"] if t["total"] > 0]
    out: list[dict] = []
    for t in rows[: max(1, limit)]:
        parts = []
        for _key, label, kinds in STEPS:
            n = sum(t["counts"].get(k, 0) for k in kinds)
            if n:
                parts.append(f"{label} {n}")
        out.append({"id": t["id"], "name": t["name"], "summary": " · ".join(parts)})
    return out
