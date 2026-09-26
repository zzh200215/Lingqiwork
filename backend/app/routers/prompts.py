"""Reusable prompt library (Open WebUI-style Prompts) + 提示词对照台（Q1）。

两条线刻意放在同一个路由下，因为它们都叫 "prompt"，但**不是一回事**：

- `/api/prompts`（下面这些 CRUD）= **用户的**片段库（`Prompt` 表，带 `{变量}`，存起来备用）。
  它不驱动系统行为、没有指纹、没有分数。
- `/api/prompts/registry*` = **系统提示词的登记表**（`core/prompts.py::_SPECS` 里登记着的那些）
  + 对照台。这里的每一条都贴着调用逻辑、有 sha 指纹，改它要过证据。

技能卡绑的是后者（前者绑上去，宠物展示的就只是一堆书签）。

> 2026-09-24：前者扩成了工作模块下的**「提示词」模块**（见 `提示词模块方案.md`，参照 AI Gist）——
> 标签 / 分类 / 收藏 / 评分 / 出处 / 版本回溯 / 调用历史 / 导入导出。**后者一行都没动。**
"""
import csv
import io
import json
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel, field_validator
from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_db
from app.models import Prompt, PromptCategory, PromptUsage, PromptVersion, iso_utc

router = APIRouter(prefix="/api/prompts", tags=["prompts"])

# 留痕不能无限长：与 `core/tasks._RUNS_KEEP` 同一条纪律。
_VERSIONS_KEEP = 20
_USAGES_KEEP = 200


def _tags_of(raw: str | list[str]) -> list[str]:
    """逗号分隔 → 去空、去重、保序。

    **全角逗号也认**：中文输入法下打出的是「，」，不认它就是一个标签都分不出来
    （`core/delegate.py` 处理工具白名单时踩过同一个坑，那里也是这么做的）。
    """
    if isinstance(raw, list):
        raw = ",".join(raw)
    out: list[str] = []
    for t in (raw or "").replace("，", ",").split(","):
        t = t.strip()
        if t and t not in out:
            out.append(t)
    return out


def _join_tags(tags: list[str]) -> str:
    return ",".join(_tags_of(tags))[:200]


def _sha(text: str) -> str:
    """内容指纹（12 位）——**用来回答「这次用的是改之前那版还是改之后那版」**。

    与 `core/prompts.py::fingerprint` 同一个算法口径（sha256 前 12 位），但**不是同一套
    登记**：那一边是系统提示词的登记表，这一边只是这条记录的内容指纹，不参与任何验收。
    """
    import hashlib

    return hashlib.sha256((text or "").encode("utf-8")).hexdigest()[:12]


class PromptIn(BaseModel):
    title: str
    content: str
    tags: list[str] = []
    category: str = ""
    favorite: bool = False
    rating: int = 0
    source: str = ""
    note: str = ""

    @field_validator("title")
    @classmethod
    def title_not_blank(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("title cannot be blank")
        return v[:100]

    @field_validator("rating")
    @classmethod
    def rating_in_range(cls, v: int) -> int:
        return max(0, min(5, int(v)))


class PromptPatch(BaseModel):
    title: str | None = None
    content: str | None = None
    tags: list[str] | None = None
    category: str | None = None
    favorite: bool | None = None
    rating: int | None = None
    source: str | None = None
    note: str | None = None


class UseIn(BaseModel):
    """一次「用了它」。`vars` 是这次填进去的变量值——下次复用不必重填。"""

    vars: dict[str, str] = {}


class ImportIn(BaseModel):
    prompts: list[PromptIn]


def _dump(
    p: Prompt,
    *,
    used: int = 0,
    versions: int = 0,
    last_vars: dict | None = None,
    last_used_at: str = "",
) -> dict:
    return {
        "id": p.id,
        "title": p.title,
        "content": p.content,
        # 过 `iso_utc`：这两列是 `utcnow()` 写的，SQLite 往返之后是 naive，
        # 裸 `.isoformat()` 会让浏览器把 UTC 当成本地读（见 `models.iso_utc` 那段注释）。
        "created_at": iso_utc(p.created_at) or "",
        "updated_at": iso_utc(p.updated_at) or "",
        "tags": _tags_of(p.tags),
        "category": p.category or "",
        "favorite": bool(p.favorite),
        "rating": p.rating or 0,
        "source": p.source or "",
        "note": p.note or "",
        "used_count": used,
        "version_count": versions,
        # 最近一次填过的变量值：**下次复用不必重填**。没填过就是空。
        "last_vars": last_vars or {},
        # 最近一次用是什么时候——界面那个「最近使用」按它排，而不是按「用过几次」
        "last_used_at": last_used_at,
    }


async def _counts(
    db: AsyncSession, ids: list[int]
) -> tuple[dict[int, int], dict[int, int], dict[int, dict], dict[int, str]]:
    """一次查完 used_count / version_count / last_vars / last_used_at —— **不在列表里逐条查**
    （N+1 是本仓库栽过的形状：`EnginePulse` 那 8 次 `listTaskRuns` 就是现场）。"""
    if not ids:
        return {}, {}, {}, {}
    used = dict(
        (
            await db.execute(
                select(PromptUsage.prompt_id, func.count())
                .where(PromptUsage.prompt_id.in_(ids))
                .group_by(PromptUsage.prompt_id)
            )
        ).all()
    )
    vers = dict(
        (
            await db.execute(
                select(PromptVersion.prompt_id, func.count())
                .where(PromptVersion.prompt_id.in_(ids))
                .group_by(PromptVersion.prompt_id)
            )
        ).all()
    )
    # 按 id 倒序扫一遍。每条两样都从这一遍里拿：
    #  - `last_used_at`：第一次遇到的那条就是最近一次；
    #  - `last_vars`：第一次遇到的**非空**那组（一条没有变量的提示词，每次记下的都是 `{}`，
    #    若把最新那次直接当答案，「上次填的值」就永远是空的——而这件事恰恰只在有变量的那几次里存在）。
    last: dict[int, dict] = {}
    at: dict[int, str] = {}
    rows = (
        await db.execute(
            select(PromptUsage.prompt_id, PromptUsage.vars_json, PromptUsage.used_at)
            .where(PromptUsage.prompt_id.in_(ids))
            .order_by(PromptUsage.id.desc())
        )
    ).all()
    for pid, blob, when in rows:
        if pid not in at:
            at[pid] = iso_utc(when) or ""
        if pid in last:
            continue
        try:
            parsed = json.loads(blob or "{}")
        except (ValueError, TypeError):
            parsed = {}
        if isinstance(parsed, dict) and parsed:
            last[pid] = parsed
    return used, vers, last, at


async def _one(db: AsyncSession, row: Prompt) -> dict:
    used, vers, last, at = await _counts(db, [row.id])
    return _dump(
        row,
        used=used.get(row.id, 0),
        versions=vers.get(row.id, 0),
        last_vars=last.get(row.id),
        last_used_at=at.get(row.id, ""),
    )


async def _snapshot(db: AsyncSession, row: Prompt) -> None:
    """把**改之前**的那一版存下来，并按 `_VERSIONS_KEEP` 裁掉旧的。

    存「改之前」而不是「改之后」：当前那一版永远在 `prompts.content` 上，
    `prompt_versions` 是**它以前的样子**。两边各存一份就是两个真值。
    """
    db.add(PromptVersion(prompt_id=row.id, title=row.title, content=row.content))
    await db.flush()
    stale = (
        (
            await db.execute(
                select(PromptVersion.id)
                .where(PromptVersion.prompt_id == row.id)
                .order_by(PromptVersion.id.desc())
                .offset(_VERSIONS_KEEP)
            )
        )
        .scalars()
        .all()
    )
    if stale:
        await db.execute(delete(PromptVersion).where(PromptVersion.id.in_(stale)))


# ---------- 库 ----------


@router.get("")
async def list_prompts(
    q: str = "",
    category: str = "",
    favorite: bool = False,
    db: AsyncSession = Depends(get_db),
):
    """整库列出（带用过几次 / 有几个历史版本）。

    **搜索与筛选在 Python 侧做**：这是个**个人级**的库（几十到几百条），而「标题 + 正文 +
    标签」三处一起搜，用 SQL 要把 `LIKE` 拼三遍、还要对标签那列做子串匹配——读起来更差，
    换不来任何东西。真到几千条再挪回 SQL 不迟。
    """
    rows = (await db.execute(select(Prompt).order_by(Prompt.id))).scalars().all()
    used, vers, last, at = await _counts(db, [r.id for r in rows])
    out = [
        _dump(
            r,
            used=used.get(r.id, 0),
            versions=vers.get(r.id, 0),
            last_vars=last.get(r.id),
            last_used_at=at.get(r.id, ""),
        )
        for r in rows
    ]

    needle = q.strip().lower()
    if needle:
        out = [
            p
            for p in out
            if needle in p["title"].lower()
            or needle in p["content"].lower()
            or any(needle in t.lower() for t in p["tags"])
        ]
    if category:
        out = [p for p in out if p["category"] == category]
    if favorite:
        out = [p for p in out if p["favorite"]]
    return out


def _tag_counts(rows) -> list[dict]:
    """标签 + 每条被用了几次。**从库里数出来**——界面上的「翻译 (1)」不是另养的配置。

    顺序按「用得多的在前」，同数按名字——**稳定**比好看重要：每次刷新都换个顺序，
    你会以为东西变了。
    """
    counts: dict[str, int] = {}
    for r in rows:
        for t in _tags_of(r.tags):
            counts[t] = counts.get(t, 0) + 1
    return [
        {"name": name, "count": n}
        for name, n in sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))
    ]


@router.get("/facets")
async def facets(db: AsyncSession = Depends(get_db)):
    """筛选器要的三样：**分类（带颜色与计数）、标签（带计数）、总数**。

    分类的成员关系从 `prompts.category` 数出来（那是唯一真值），颜色与顺序从
    `prompt_categories` 取（那只是「它长什么样」）。两边合起来才是界面上那一行——
    所以**没挑过颜色的分类照样出现**，不必先建分类才能归类。
    """
    rows = (await db.execute(select(Prompt))).scalars().all()
    counts: dict[str, int] = {}
    uncategorized = 0
    for r in rows:
        c = (r.category or "").strip()
        if c:
            counts[c] = counts.get(c, 0) + 1
        else:
            uncategorized += 1

    styled = {c.name: c for c in (await db.execute(select(PromptCategory))).scalars().all()}
    # 在用的 + 建了还没用的（空分类也是分类，不然「建了它」这件事在界面上就消失了）
    names = list(counts) + [n for n in styled if n not in counts]
    cats = [
        {
            "name": n,
            "color": (styled[n].color if n in styled else "") or "",
            "position": (styled[n].position if n in styled else 0),
            "count": counts.get(n, 0),
        }
        for n in names
    ]
    cats.sort(key=lambda c: (c["position"], c["name"]))
    return {
        "categories": cats,
        "tags": _tag_counts(rows),
        "total": len(rows),
        "uncategorized": uncategorized,
    }


# ---------- 分类管理（改名 / 换色 / 排序 / 删除）----------
#
# 参照 AI Gist 那一屏「分类管理」。**删一个分类绝不删条目**——分类只是个标签，
# 条目才是攒下来的东西；一次误操作不该带走提示词。


class CategoryIn(BaseModel):
    name: str
    color: str = ""

    @field_validator("name")
    @classmethod
    def name_not_blank(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("分类名不能空")
        return v[:50]


class CategoryPatch(BaseModel):
    name: str | None = None
    color: str | None = None
    position: int | None = None


def _cat_out(row: PromptCategory, count: int) -> dict:
    return {"id": row.id, "name": row.name, "color": row.color or "", "position": row.position, "count": count}


@router.get("/categories")
async def list_categories(db: AsyncSession = Depends(get_db)):
    """分类表 + 各自有几条。计数从 `prompts.category` 数——**不是**表上的一列。"""
    rows = (await db.execute(select(PromptCategory).order_by(PromptCategory.position, PromptCategory.name))).scalars().all()
    used = (await db.execute(select(Prompt))).scalars().all()
    counts: dict[str, int] = {}
    for r in used:
        c = (r.category or "").strip()
        if c:
            counts[c] = counts.get(c, 0) + 1
    return [_cat_out(r, counts.get(r.name, 0)) for r in rows]


@router.post("/categories")
async def create_category(body: CategoryIn, db: AsyncSession = Depends(get_db)):
    exists = (
        await db.execute(select(PromptCategory).where(PromptCategory.name == body.name))
    ).scalars().first()
    if exists:
        # 幂等：已经有就把它交回去（连着点两次不该报错，也不该长出第二行）
        return _cat_out(exists, 0)
    top = (
        await db.execute(select(func.max(PromptCategory.position)))
    ).scalar()
    row = PromptCategory(name=body.name, color=(body.color or "").strip()[:20], position=int(top or 0) + 1)
    db.add(row)
    await db.commit()
    await db.refresh(row)
    return _cat_out(row, 0)


@router.put("/categories/{category_id}")
async def update_category(
    category_id: int, body: CategoryPatch, db: AsyncSession = Depends(get_db)
):
    """改名 / 换色 / 挪位置。

    **改名要连条目一起搬**：`prompts.category` 存的是名字。只改表不改条目，
    那些提示词会当场变成「未分类」——而它们明明还在那个分类里。
    """
    row = await db.get(PromptCategory, category_id)
    if not row:
        raise HTTPException(404, "category not found")
    old = row.name

    if body.name is not None:
        new = body.name.strip()[:50]
        if not new:
            raise HTTPException(422, "分类名不能空")
        if new != old:
            clash = (
                await db.execute(select(PromptCategory).where(PromptCategory.name == new))
            ).scalars().first()
            if clash:
                raise HTTPException(409, f"已经有叫「{new}」的分类了")
            moved = (await db.execute(select(Prompt).where(Prompt.category == old))).scalars().all()
            for p in moved:
                p.category = new
                p.updated_at = datetime.now(timezone.utc)
            row.name = new

    if body.color is not None:
        row.color = body.color.strip()[:20]
    if body.position is not None:
        row.position = int(body.position)
    await db.commit()
    await db.refresh(row)
    return _cat_out(row, 0)


@router.delete("/categories/{category_id}")
async def delete_category(category_id: int, db: AsyncSession = Depends(get_db)):
    """删分类 = 那些条目**退回「未分类」**，条目本身一条都不动。"""
    row = await db.get(PromptCategory, category_id)
    if not row:
        raise HTTPException(404, "category not found")
    name = row.name
    moved = (await db.execute(select(Prompt).where(Prompt.category == name))).scalars().all()
    for p in moved:
        p.category = ""
        p.updated_at = datetime.now(timezone.utc)
    await db.delete(row)
    await db.commit()
    return {"ok": True, "uncategorized": len(moved)}


@router.post("")
async def create_prompt(body: PromptIn, db: AsyncSession = Depends(get_db)):
    row = Prompt(
        title=body.title,
        content=body.content,
        tags=_join_tags(body.tags),
        category=body.category.strip()[:50],
        favorite=body.favorite,
        rating=body.rating,
        source=body.source.strip()[:300],
        note=body.note.strip()[:500],
    )
    db.add(row)
    await db.commit()
    await db.refresh(row)
    return await _one(db, row)


@router.put("/{prompt_id}")
async def update_prompt(prompt_id: int, body: PromptPatch, db: AsyncSession = Depends(get_db)):
    row = await db.get(Prompt, prompt_id)
    if not row:
        raise HTTPException(404, "prompt not found")

    # **只有正文真的变了才留版本**：改个标签、点个收藏不该在历史里塞一条一模一样的快照。
    if body.content is not None and body.content != row.content:
        await _snapshot(db, row)
        row.content = body.content

    if body.title is not None and body.title.strip():
        row.title = body.title.strip()[:100]
    if body.tags is not None:
        row.tags = _join_tags(body.tags)
    if body.category is not None:
        row.category = body.category.strip()[:50]
    if body.favorite is not None:
        row.favorite = body.favorite
    if body.rating is not None:
        row.rating = max(0, min(5, int(body.rating)))
    if body.source is not None:
        row.source = body.source.strip()[:300]
    if body.note is not None:
        row.note = body.note.strip()[:500]

    row.updated_at = datetime.now(timezone.utc)
    await db.commit()
    await db.refresh(row)
    return await _one(db, row)


@router.delete("/{prompt_id}")
async def delete_prompt(prompt_id: int, db: AsyncSession = Depends(get_db)):
    row = await db.get(Prompt, prompt_id)
    if not row:
        raise HTTPException(404, "prompt not found")
    # 版本与使用记录跟着走：**没有外键，所以删的时候要自己收**（同 `routers/tasks.py`
    # 删任务时手写 `sa_delete(TaskRun)` 那条的理由——TaskRun.task_id 也是裸 indexed Integer）。
    await db.execute(delete(PromptVersion).where(PromptVersion.prompt_id == prompt_id))
    await db.execute(delete(PromptUsage).where(PromptUsage.prompt_id == prompt_id))
    await db.delete(row)
    await db.commit()
    return {"ok": True}


@router.post("/{prompt_id}/use")
async def use_prompt(prompt_id: int, body: UseIn, db: AsyncSession = Depends(get_db)):
    """记一次使用（复制走 / 填完变量发出去时调）。

    `content_sha` 记的是**这一次用的是哪一版**——改了正文之后 sha 会变，
    于是「改过之后是不是更好用」这件事，事后能按 sha 分段看。
    """
    row = await db.get(Prompt, prompt_id)
    if not row:
        raise HTTPException(404, "prompt not found")
    db.add(
        PromptUsage(
            prompt_id=prompt_id,
            content_sha=_sha(row.content),
            vars_json=json.dumps(body.vars or {}, ensure_ascii=False)[:2000],
        )
    )
    await db.flush()
    stale = (
        (
            await db.execute(
                select(PromptUsage.id)
                .where(PromptUsage.prompt_id == prompt_id)
                .order_by(PromptUsage.id.desc())
                .offset(_USAGES_KEEP)
            )
        )
        .scalars()
        .all()
    )
    if stale:
        await db.execute(delete(PromptUsage).where(PromptUsage.id.in_(stale)))
    await db.commit()
    return {"ok": True, "used_count": await _used_count(db, prompt_id)}


async def _used_count(db: AsyncSession, prompt_id: int) -> int:
    return int(
        (
            await db.execute(
                select(func.count()).select_from(PromptUsage).where(PromptUsage.prompt_id == prompt_id)
            )
        ).scalar()
        or 0
    )


# ---------- 版本回溯 ----------


@router.get("/{prompt_id}/versions")
async def list_versions(prompt_id: int, db: AsyncSession = Depends(get_db)):
    rows = (
        (
            await db.execute(
                select(PromptVersion)
                .where(PromptVersion.prompt_id == prompt_id)
                .order_by(PromptVersion.id.desc())
            )
        )
        .scalars()
        .all()
    )
    return [
        {
            "id": r.id,
            "title": r.title,
            "content": r.content,
            "at": iso_utc(r.created_at) or "",
            "sha": _sha(r.content),
        }
        for r in rows
    ]


@router.post("/{prompt_id}/versions/{version_id}/restore")
async def restore_version(
    prompt_id: int, version_id: int, db: AsyncSession = Depends(get_db)
):
    """回到某一版。**当前这一版会先被存成历史**——回滚不该是单向门。"""
    row = await db.get(Prompt, prompt_id)
    if not row:
        raise HTTPException(404, "prompt not found")
    ver = await db.get(PromptVersion, version_id)
    if not ver or ver.prompt_id != prompt_id:
        raise HTTPException(404, "version not found")
    if ver.content == row.content:
        return await _one(db, row)  # 已经就是这一版，不动
    await _snapshot(db, row)
    row.content = ver.content
    row.updated_at = datetime.now(timezone.utc)
    await db.commit()
    await db.refresh(row)
    return await _one(db, row)


# ---------- 使用历史 ----------
#
# 「点击复制即可自动记录使用历史」（AI Gist）——记了就要能看。**只记不读的那份账
# 等于没记**：它换不来任何判断（这条到底用得多不多、最近一次是什么时候）。


@router.get("/{prompt_id}/usages")
async def list_usages(prompt_id: int, limit: int = 50, db: AsyncSession = Depends(get_db)):
    rows = (
        (
            await db.execute(
                select(PromptUsage)
                .where(PromptUsage.prompt_id == prompt_id)
                .order_by(PromptUsage.id.desc())
                .limit(max(1, min(200, limit)))
            )
        )
        .scalars()
        .all()
    )
    out = []
    for r in rows:
        try:
            vars_ = json.loads(r.vars_json or "{}")
        except (ValueError, TypeError):
            vars_ = {}
        out.append(
            {
                "id": r.id,
                "at": iso_utc(r.used_at) or "",
                "sha": r.content_sha or "",
                "vars": vars_ if isinstance(vars_, dict) else {},
            }
        )
    return out


# ---------- 带走（导出 / 导入）----------
#
# 这一条是「用到其他项目」的全部依赖：没有它，这个库就只是本应用里的一个书签夹。


@router.get("/export")
async def export_prompts(format: str = "json", db: AsyncSession = Depends(get_db)):
    rows = (await db.execute(select(Prompt).order_by(Prompt.id))).scalars().all()
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")

    if format == "csv":
        buf = io.StringIO()
        w = csv.writer(buf)
        w.writerow(["title", "content", "tags", "category", "favorite", "rating", "source", "note"])
        for r in rows:
            w.writerow(
                [
                    r.title,
                    r.content,
                    ",".join(_tags_of(r.tags)),
                    r.category or "",
                    int(bool(r.favorite)),
                    r.rating or 0,
                    r.source or "",
                    r.note or "",
                ]
            )
        # BOM：Excel 打开 UTF-8 CSV 不加它就是乱码（这一条是给「拿去别的项目」用的，
        # 对面多半是拿 Excel / 表格工具打开）。
        body = "\ufeff" + buf.getvalue()
        return Response(
            content=body.encode("utf-8"),
            media_type="text/csv; charset=utf-8",
            headers={"Content-Disposition": f'attachment; filename="prompts-{stamp}.csv"'},
        )

    return {
        "version": 1,
        "exported_at": iso_utc(datetime.now(timezone.utc)) or "",
        "count": len(rows),
        "prompts": [
            {
                "title": r.title,
                "content": r.content,
                "tags": _tags_of(r.tags),
                "category": r.category or "",
                "favorite": bool(r.favorite),
                "rating": r.rating or 0,
                "source": r.source or "",
                "note": r.note or "",
            }
            for r in rows
        ],
    }


@router.post("/import")
async def import_prompts(body: ImportIn, db: AsyncSession = Depends(get_db)):
    """导入。**同名默认跳过，不覆盖**——导入是「把东西拿进来」，不是「用别人那份替换我的」。

    要覆盖就先把本地的改名或删掉，这是有意的摩擦：一次误导入不该悄悄冲掉你攒的东西。
    """
    existing = {
        t for (t,) in (await db.execute(select(Prompt.title))).all()
    }
    added: list[str] = []
    skipped: list[str] = []
    for p in body.prompts:
        if p.title in existing:
            skipped.append(p.title)
            continue
        db.add(
            Prompt(
                title=p.title,
                content=p.content,
                tags=_join_tags(p.tags),
                category=p.category.strip()[:50],
                favorite=p.favorite,
                rating=p.rating,
                source=p.source.strip()[:300],
                note=p.note.strip()[:500],
            )
        )
        existing.add(p.title)
        added.append(p.title)
    await db.commit()
    return {"added": added, "skipped": skipped}


# ---------- AI：生成 / 调优 / 提取变量 ----------
#
# 三条都**只产出文本、不落库**：写不写进库是人的决定（照 AI Gist 那句「用之前，改一改」）。
# 提示词本体登记在 `core/prompts.py::_SPECS` 的 `app.core.prompt_ai` 三条上。


class IdeaIn(BaseModel):
    idea: str


class RefineIn(BaseModel):
    content: str
    instruction: str = ""


class VarsIn(BaseModel):
    content: str


def _ai_error(e: Exception) -> HTTPException:
    """没有可用模型 → 503 且带一句人话；模型交回的东西没法用 → 422。

    两条都不该是 500：它们是**可预期的处境**（还没配模型 / 模型乱说），
    500 会让界面只能显示「服务器错误」。
    """
    if isinstance(e, RuntimeError):
        return HTTPException(503, str(e))
    return HTTPException(422, str(e))


@router.post("/ai/generate")
async def ai_generate(body: IdeaIn):
    """一句想法 → 一条可复用的提示词。"""
    from app.core import prompt_ai

    try:
        return await prompt_ai.generate(body.idea)
    except (ValueError, RuntimeError) as e:
        raise _ai_error(e) from e


@router.post("/ai/refine")
async def ai_refine(body: RefineIn):
    """现有提示词 + 一句要求 → 改完的全文。"""
    from app.core import prompt_ai

    try:
        return await prompt_ai.refine(body.content, body.instruction)
    except (ValueError, RuntimeError) as e:
        raise _ai_error(e) from e


@router.post("/ai/vars")
async def ai_vars(body: VarsIn):
    """提取变量。

    **模型提不出来就退回本地正则**，并且**如实说这一次是谁提的**（`via`）——
    退回本身是好事（本地正则就是 `/` 唤起实际会问的那几个），但悄悄退回就等于
    谎报了来源，而这个仓库最不能忍的就是「读不到却说读到了」。
    """
    from app.core import prompt_ai

    try:
        return {"vars": await prompt_ai.extract_vars(body.content), "via": "model"}
    except (ValueError, RuntimeError):
        return {"vars": prompt_ai.vars_in(body.content), "via": "local"}


# ---------- 登记表（系统提示词）----------
#
# 只读 + 可跑对照。**没有"改"这个动作**：内容活在源码里（那是它的单一事实来源），
# 这个面上改出来的东西会变成第二个真值。要改就去改代码，改完 sha 变了，
# `test_prompts.py` 会提醒你登记漂移。


@router.get("/registry")
async def registry():
    """登记表里的每一条提示词，每条带上「有没有 golden set / 有没有基线」。"""
    from app.core import prompt_eval, prompts

    fx = prompt_eval.fixtures()
    out: list[dict] = []
    for p in prompts.inventory():
        fixture = fx.get(p.name)
        base = await prompt_eval.baseline(p.name, prompt_sha=p.sha or "")
        out.append(
            {
                "name": p.name,
                "module": p.module,
                "purpose": p.purpose,
                "kind": p.kind,
                "sha": p.sha,
                "bytes": len(p.content.encode("utf-8")) if p.content is not None else 0,
                "drifted": p.content is None,
                "cases": len((fixture or {}).get("cases") or []),
                "fixture": (fixture or {}).get("file", ""),
                # 领域（Q3 形态）：写在这条提示词的 golden set 里，没标就是 ""
                "domain": (fixture or {}).get("domain", ""),
                "baseline": (
                    {
                        "at": base["at"],
                        "passed": base["passed"],
                        "cases": base["cases"],
                        "rate": base["rate"],
                        "ci_low": base["ci_low"],
                        "ci_high": base["ci_high"],
                        "model_id": base["model_id"],
                        "stale": base["prompt_sha"] != p.sha,
                    }
                    if base
                    else None
                ),
            }
        )
    return {"prompts": out, "inline": [{"module": m, "line": n, "purpose": why} for m, n, why in prompts.inline_notes()]}


@router.get("/registry/{key}")
async def registry_entry(key: str):
    """一条提示词的全貌：内容（只读）、golden set、断言清单、跑分历史。

    **golden set 有两种形状**（`prompt_eval.fixture_kind`）：聊天型是「一句真实输入 +
    断言」，判分型（`JUDGE_SYSTEM`）是「卡三样 + 重讲原文 + 人工档位」。这里按形状把用例
    摊开——判分型的用例没有 `user`/`checks`，硬按聊天那份读会把它显示成一条空用例。
    """
    from app.core import prompt_eval

    try:
        entry = prompt_eval._entry(key)  # noqa: SLF001 - 同包内的登记表读取
    except ValueError as e:
        raise HTTPException(404, str(e)) from e
    fx = prompt_eval.cases_for(key) or {}
    kind = prompt_eval.fixture_kind(key)
    if kind == "grade":
        cases = [
            {
                "id": c.get("id"),
                "intent": c.get("intent", ""),
                "front": c.get("front", ""),
                "back": c.get("back", ""),
                "excerpt": c.get("excerpt", ""),
                "retell": c.get("retell", ""),
                "grade": c.get("grade"),
                "contested": bool(c.get("contested")),
                "why": c.get("why", ""),
            }
            for c in (fx.get("cases") or [])
        ]
    else:
        cases = [
            {"id": c.get("id"), "intent": c.get("intent", ""), "user": c.get("user", ""), "checks": c.get("checks") or []}
            for c in (fx.get("cases") or [])
        ]
    return {
        "name": entry.name,
        "module": entry.module,
        "purpose": entry.purpose,
        "kind": entry.kind,
        "sha": entry.sha,
        "content": entry.content,
        "fixture": fx.get("file", ""),
        "note": fx.get("_note", ""),
        "domain": fx.get("domain", ""),
        # 用例是哪种形状：界面据此换一套说法（断言 vs 人工档位），不是自己猜
        "case_kind": kind,
        "cases": cases,
        "checks": prompt_eval.check_names(),
        "runs": await prompt_eval.history(key, limit=10),
    }


class CaseIn(BaseModel):
    user: str
    intent: str
    checks: list[str]
    id: str = ""


@router.post("/registry/{key}/cases")
async def add_case(key: str, body: CaseIn):
    """喂一条用例进金标集（**写的是 `backend/evals/prompts/*.json`**，不是提示词）。

    这是「一次事故 → 一个用例」那一步：把真实踩到的输入抄进来，写一句"它当时应该怎样"，
    勾上它必须满足的断言。改动落在文件里、进 git 可审——所以界面上会提醒你提交。
    """
    from app.core import prompt_eval

    try:
        return prompt_eval.add_case(
            key, user=body.user, intent=body.intent, checks=body.checks, case_id=body.id
        )
    except ValueError as e:
        raise HTTPException(400, str(e)) from e


@router.delete("/registry/{key}/cases/{case_id}")
async def remove_case(key: str, case_id: str):
    """去掉一条用例（坏用例会污染指标，所以出口和入口一样大）。"""
    from app.core import prompt_eval

    try:
        return prompt_eval.remove_case(key, case_id)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e


class DomainIn(BaseModel):
    domain: str = ""

    @field_validator("domain")
    @classmethod
    def _d(cls, v: str) -> str:
        return (v or "").strip()[:30]


@router.post("/registry/{key}/domain")
async def set_domain(key: str, body: DomainIn):
    """给这套 golden set 标一个领域（Q3 形态的分组键）。

    和喂用例一样**写的是 `backend/evals/prompts/*.json`**——领域是「这套用例在问什么」
    的属性，跟用例该待在一起，也跟着进 git。提示词本身一个字节都不动。
    """
    from app.core import prompt_eval

    try:
        return prompt_eval.set_domain(key, body.domain)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e


class CheckIn(BaseModel):
    variant: str | None = None
    variant_label: str = ""
    model_id: str | None = None


def _eval_key(key: str) -> str:
    """这一趟跑分在 `inflight` 里的 key。

    **取消接口说的是同一个字符串**——两处各拼一次的话，哪天改了前缀，取消就会静默失效
    （点了「停止」什么都不发生，而页面上什么也不报）。所以拼名字只有这一处。
    """
    return f"prompt-eval:{key}"


@router.post("/registry/{key}/check")
async def run_check(key: str, body: CheckIn | None = None):
    """跑一次对照。不带 `variant` = 重放**已登记的内容**（基准/回归）。

    带 `variant` = 拿一段候选内容比一比：它**不进配置、不进登记表**，只留在这次 run 里当证据。
    每次跑 = golden set 条数次模型调用，是要花钱的——报告里给调用次数、耗时与区间。

    **走哪条重放路由这套用例的形状决定，不由调用方挑**：聊天型走 `prompt_eval`（对回复跑
    断言），判分型（`JUDGE_SYSTEM`）走 `judge_eval`（跟人工档位比对）。两个模块共用同一张
    结果表，所以界面上那一条提示词的基线与历史是连着的。

    **占 `inflight` 锁**（2026-09-26 补）：这条是分钟级 + 花钱的循环，两个标签页同时点
    就是两次全套调用，而结果表里只留下后写的那次——正是 `inflight` 存在的理由。
    占了锁之后，`/check/cancel` 才有一个明确的目标可停。
    """
    from app.core import inflight, judge_eval, prompt_eval

    body = body or CheckIn()
    token = _eval_key(key)
    if not inflight.try_acquire(token):
        raise HTTPException(
            409,
            f"「{key}」正在跑一次对照——等它跑完，或者先在页面上点「停止」。"
            "并发两次 = 两倍的模型调用，而结果里只会留下后写的那次。",
        )
    try:
        if prompt_eval.is_grading(key):
            return await judge_eval.check(
                variant=body.variant,
                variant_label=body.variant_label,
                model_id=(body.model_id or ""),
                cancel_key=token,
            )
        return await prompt_eval.check(
            key,
            variant=body.variant,
            variant_label=body.variant_label,
            model_id=(body.model_id or ""),
            cancel_key=token,
        )
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    finally:
        inflight.release(token)


@router.post("/registry/{key}/check/cancel")
async def cancel_check(key: str):
    """请正在跑的那次对照停下。

    **合作式**：在每条用例之间生效，所以当前那条会跑完才停（一次生成动辄几十秒）。
    界面上的说法因此是「正在停…（这一条跑完就停）」，不是「已停止」。

    没有在跑的也如实回 `stopped: false`——不假装停成功。
    """
    from app.core import inflight

    return {"stopped": inflight.request_cancel(_eval_key(key))}
