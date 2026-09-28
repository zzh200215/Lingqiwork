"""RAG evaluation endpoints: eval set CRUD + batch runs with score history."""
import json

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, field_validator
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import evals as core
from app.core import engine_eval as core_engines
from app.db import get_db
from app.models import EngineEvalRun, EvalItem, EvalRun

router = APIRouter(prefix="/api/evals", tags=["evals"])


class ItemIn(BaseModel):
    question: str
    expected_source: str = ""
    note: str = ""
    domain: str = ""

    @field_validator("question")
    @classmethod
    def _q(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("问题不能为空")
        return v.strip()

    @field_validator("domain")
    @classmethod
    def _d(cls, v: str) -> str:
        return (v or "").strip()[:30]


class ItemPatch(BaseModel):
    question: str | None = None
    expected_source: str | None = None
    note: str | None = None
    domain: str | None = None

    @field_validator("domain")
    @classmethod
    def _d(cls, v: str | None) -> str | None:
        return None if v is None else (v or "").strip()[:30]


class RunIn(BaseModel):
    top_k: int | None = None
    judge: bool = True

    @field_validator("top_k")
    @classmethod
    def _k(cls, v: int | None) -> int | None:
        if v is not None and not 1 <= v <= 50:
            raise ValueError("top_k 需在 1-50 之间")
        return v


def _item_out(i: EvalItem) -> dict:
    return {
        "id": i.id,
        "question": i.question,
        "expected_source": i.expected_source,
        "note": i.note,
        # 领域（Q3 形态）：分组用的标签，空 = 还没归类
        "domain": i.domain,
    }


def _run_out(r: EvalRun, detail: bool = False) -> dict:
    out = {
        "id": r.id,
        "created_at": r.created_at.astimezone().isoformat(timespec="seconds") if r.created_at else None,
        "top_k": r.top_k,
        "hybrid": r.hybrid,
        "rerank": r.rerank,
        "full_context": r.full_context,
        "judge_model": r.judge_model,
        "total": r.total,
        "hit1": r.hit1,
        "hit3": r.hit3,
        "hitk": r.hitk,
        "mrr": r.mrr,
        "faithfulness": r.faithfulness,
        "seconds": r.seconds,
    }
    if detail:
        try:
            out["detail"] = json.loads(r.detail_json or "[]")
        except json.JSONDecodeError:
            out["detail"] = []
    return out


# ---------- eval set ----------


@router.get("")
async def list_items(db: AsyncSession = Depends(get_db)):
    rows = (await db.execute(select(EvalItem).order_by(EvalItem.id))).scalars().all()
    return [_item_out(i) for i in rows]


@router.post("")
async def create_item(body: ItemIn, db: AsyncSession = Depends(get_db)):
    item = EvalItem(
        question=body.question,
        expected_source=body.expected_source.strip(),
        note=body.note.strip(),
        domain=body.domain,
    )
    db.add(item)
    await db.commit()
    await db.refresh(item)
    return _item_out(item)


@router.put("/{item_id}")
async def update_item(item_id: int, body: ItemPatch, db: AsyncSession = Depends(get_db)):
    item = await db.get(EvalItem, item_id)
    if not item:
        raise HTTPException(404, "eval item not found")
    data = body.model_dump(exclude_unset=True)
    if "question" in data:
        if not (data["question"] or "").strip():
            raise HTTPException(422, "问题不能为空")
        item.question = data["question"].strip()
    if "expected_source" in data:
        item.expected_source = (data["expected_source"] or "").strip()
    if "note" in data:
        item.note = (data["note"] or "").strip()
    if "domain" in data:
        item.domain = (data["domain"] or "").strip()[:30]
    await db.commit()
    await db.refresh(item)
    return _item_out(item)


@router.delete("/{item_id}")
async def delete_item(item_id: int, db: AsyncSession = Depends(get_db)):
    item = await db.get(EvalItem, item_id)
    if not item:
        raise HTTPException(404, "eval item not found")
    await db.delete(item)
    await db.commit()
    return {"ok": True}


# ---------- runs ----------


@router.get("/runs")
async def list_runs(limit: int = 20, db: AsyncSession = Depends(get_db)):
    rows = (
        await db.execute(select(EvalRun).order_by(EvalRun.id.desc()).limit(max(1, min(limit, 100))))
    ).scalars().all()
    return [_run_out(r) for r in rows]


@router.get("/runs/{run_id}")
async def get_run(run_id: int, db: AsyncSession = Depends(get_db)):
    run = await db.get(EvalRun, run_id)
    if not run:
        raise HTTPException(404, "eval run not found")
    return _run_out(run, detail=True)


@router.delete("/runs/{run_id}")
async def delete_run(run_id: int, db: AsyncSession = Depends(get_db)):
    run = await db.get(EvalRun, run_id)
    if not run:
        raise HTTPException(404, "eval run not found")
    await db.delete(run)
    await db.commit()
    return {"ok": True}


@router.post("/run")
async def run_eval(body: RunIn | None = None):
    """Evaluate the whole set with the current retrieval config (can take a while).

    占 `inflight` 锁（与 prompt/skill 评测同一条规矩）：分钟级 + 花钱的循环，并发两次
    = 两倍调用而结果只留后写的。锁也让 `/run/cancel` 有明确的目标可停。
    """
    from app.core import inflight

    body = body or RunIn()
    if not inflight.try_acquire("kb_eval"):
        raise HTTPException(
            409,
            "正在跑一次评估——等它完成，或先点「停止」。并发两次 = 两倍的模型调用，"
            "而结果里只会留下后写的那次。",
        )
    try:
        return await core.run_eval(top_k=body.top_k, judge=body.judge, cancel_key="kb_eval")
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    except Exception as e:  # noqa: BLE001
        raise HTTPException(500, f"{type(e).__name__}: {e}") from e
    finally:
        inflight.release("kb_eval")


@router.post("/run/cancel")
async def cancel_run_eval():
    """请正在跑的那次评估停下。

    **合作式**：还没轮到的用例直接跳过，已开跑的那条跑完（检索在信号量外，判分在
    槽内）——界面上写「正在停…」，不写「已停止」。没在跑的如实回 `stopped: false`。
    """
    from app.core import inflight

    return {"stopped": inflight.request_cancel("kb_eval")}


@router.get("/compare")
async def compare_runs(limit: int = 2):
    """对比最近 N 次运行：这次比上次好了还是坏了（只读，不跑模型）。"""
    return await core.compare_history(limit=limit)


@router.get("/health")
async def eval_set_health():
    """评测集健康度：条数、标注覆盖、是否「全满分」测不出回归。"""
    return await core.eval_health()


# ---------- 成文引擎的质量标尺（四个引擎共用一条脊梁，这里给它一根尺） ----------


class EngineRunIn(BaseModel):
    engine: str | None = None  # None = 全部四个
    judge: bool = True

    @field_validator("engine")
    @classmethod
    def _engine(cls, v: str | None) -> str | None:
        if v is not None and v not in core_engines.ENGINES:
            raise ValueError(f"engine 需是 {core_engines.ENGINES} 之一")
        return v


def _engine_run_out(r: EngineEvalRun, detail: bool = False) -> dict:
    out = {
        "id": r.id,
        "engine": r.engine,
        "created_at": r.created_at.astimezone().isoformat(timespec="seconds") if r.created_at else None,
        "prompt_sha": r.prompt_sha,
        "model_id": r.model_id,
        "total": r.total,
        "structural": r.structural,
        "grounded": r.grounded,
        "seconds": r.seconds,
    }
    if detail:
        try:
            out["detail"] = json.loads(r.detail_json or "[]")
        except json.JSONDecodeError:
            out["detail"] = []
    return out


@router.get("/engines")
async def list_engine_runs(engine: str | None = None, limit: int = 40, db: AsyncSession = Depends(get_db)):
    """四个引擎最近的自动得分（只读，不跑模型）。"""
    stmt = select(EngineEvalRun).order_by(EngineEvalRun.id.desc()).limit(max(1, min(limit, 200)))
    if engine:
        stmt = (
            select(EngineEvalRun)
            .where(EngineEvalRun.engine == engine)
            .order_by(EngineEvalRun.id.desc())
            .limit(max(1, min(limit, 200)))
        )
    rows = (await db.execute(stmt)).scalars().all()
    return [_engine_run_out(r) for r in rows]


# 字面量路径必须排在 `/engines/{run_id}` 前面——否则 "history"/"latest" 会被当成 int 解析。
@router.get("/engines/history")
async def engine_history(engine: str | None = None, limit: int = 40):
    """按引擎给出「这次比上次好了还是坏了」，并标明提示词版本有没有换。"""
    return await core_engines.history(engine=engine, limit=limit)


@router.get("/engines/latest")
async def engine_latest():
    """每个引擎最近一次的自动分 + golden set 覆盖条数 + 标尺自身的健康度。"""
    by_engine = await core_engines.latest_by_engine()
    return {
        "by_engine": by_engine,
        "coverage": core_engines.all_case_counts(),
        "warnings": (await core_engines.health(by_engine))["warnings"],
    }


@router.post("/engines/run")
async def run_engine_eval(body: EngineRunIn | None = None):
    """跑 golden set（每个用例至少一次模型调用，可能要几分钟）。"""
    body = body or EngineRunIn()
    try:
        return await core_engines.run(body.engine, judge=body.judge)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    except Exception as e:  # noqa: BLE001
        raise HTTPException(500, f"{type(e).__name__}: {e}") from e


@router.get("/engines/{run_id}")
async def get_engine_run(run_id: int, db: AsyncSession = Depends(get_db)):
    run = await db.get(EngineEvalRun, run_id)
    if not run:
        raise HTTPException(404, "engine eval run not found")
    return _engine_run_out(run, detail=True)
