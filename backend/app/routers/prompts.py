"""Reusable prompt library (Open WebUI-style Prompts) + 提示词对照台（Q1）。

两条线刻意放在同一个路由下，因为它们都叫 "prompt"，但**不是一回事**：

- `/api/prompts`（下面这些 CRUD）= **用户的**片段库（`Prompt` 表，带 `{变量}`，存起来备用）。
  它不驱动系统行为、没有指纹、没有分数。
- `/api/prompts/registry*` = **系统提示词的登记表**（`core/prompts.py::_SPECS`，32 条）
  + 对照台。这里的每一条都贴着调用逻辑、有 sha 指纹，改它要过证据。

技能卡绑的是后者（前者绑上去，宠物展示的就只是一堆书签）。
"""
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, field_validator
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_db
from app.models import Prompt

router = APIRouter(prefix="/api/prompts", tags=["prompts"])


class PromptIn(BaseModel):
    title: str
    content: str

    @field_validator("title")
    @classmethod
    def title_not_blank(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("title cannot be blank")
        return v[:100]


class PromptPatch(BaseModel):
    title: str | None = None
    content: str | None = None


def _dump(p: Prompt) -> dict:
    return {"id": p.id, "title": p.title, "content": p.content, "created_at": p.created_at.isoformat()}


@router.get("")
async def list_prompts(db: AsyncSession = Depends(get_db)):
    rows = (await db.execute(select(Prompt).order_by(Prompt.id))).scalars().all()
    return [_dump(p) for p in rows]


@router.post("")
async def create_prompt(body: PromptIn, db: AsyncSession = Depends(get_db)):
    row = Prompt(title=body.title, content=body.content)
    db.add(row)
    await db.commit()
    await db.refresh(row)
    return _dump(row)


@router.put("/{prompt_id}")
async def update_prompt(prompt_id: int, body: PromptPatch, db: AsyncSession = Depends(get_db)):
    row = await db.get(Prompt, prompt_id)
    if not row:
        raise HTTPException(404, "prompt not found")
    if body.title is not None and body.title.strip():
        row.title = body.title.strip()[:100]
    if body.content is not None:
        row.content = body.content
    await db.commit()
    await db.refresh(row)
    return _dump(row)


@router.delete("/{prompt_id}")
async def delete_prompt(prompt_id: int, db: AsyncSession = Depends(get_db)):
    row = await db.get(Prompt, prompt_id)
    if not row:
        raise HTTPException(404, "prompt not found")
    await db.delete(row)
    await db.commit()
    return {"ok": True}


# ---------- 登记表（系统提示词）----------
#
# 只读 + 可跑对照。**没有"改"这个动作**：内容活在源码里（那是它的单一事实来源），
# 这个面上改出来的东西会变成第二个真值。要改就去改代码，改完 sha 变了，
# `test_prompts.py` 会提醒你登记漂移。


@router.get("/registry")
async def registry():
    """32 条登记提示词，每条带上「有没有 golden set / 有没有基线」。"""
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
    """一条提示词的全貌：内容（只读）、golden set、断言清单、跑分历史。"""
    from app.core import prompt_eval

    try:
        entry = prompt_eval._entry(key)  # noqa: SLF001 - 同包内的登记表读取
    except ValueError as e:
        raise HTTPException(404, str(e)) from e
    fx = prompt_eval.cases_for(key) or {}
    return {
        "name": entry.name,
        "module": entry.module,
        "purpose": entry.purpose,
        "kind": entry.kind,
        "sha": entry.sha,
        "content": entry.content,
        "fixture": fx.get("file", ""),
        "note": fx.get("_note", ""),
        "cases": [
            {"id": c.get("id"), "intent": c.get("intent", ""), "user": c.get("user", ""), "checks": c.get("checks") or []}
            for c in (fx.get("cases") or [])
        ],
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


class CheckIn(BaseModel):
    variant: str | None = None
    variant_label: str = ""
    model_id: str | None = None


@router.post("/registry/{key}/check")
async def run_check(key: str, body: CheckIn | None = None):
    """跑一次对照。不带 `variant` = 重放**已登记的内容**（基准/回归）。

    带 `variant` = 拿一段候选内容比一比：它**不进配置、不进登记表**，只留在这次 run 里当证据。
    每次跑 = golden set 条数次模型调用，是要花钱的——报告里给调用次数、耗时与区间。
    """
    from app.core import prompt_eval

    body = body or CheckIn()
    try:
        return await prompt_eval.check(
            key,
            variant=body.variant,
            variant_label=body.variant_label,
            model_id=(body.model_id or ""),
        )
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    except Exception as e:  # noqa: BLE001
        raise HTTPException(500, f"{type(e).__name__}: {e}") from e
