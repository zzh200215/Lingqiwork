"""RAG evaluation: retrieval metrics + LLM faithfulness judging.

Simplified RAGAS thinking without the framework. Retrieval is scored against a
hand-labelled expected source file (Hit@k / MRR — objective, no model needed);
answer quality is scored 0-5 by the model itself against the retrieved context
(faithfulness — is every claim supported by what was actually retrieved?).

Every run stores the retrieval config it used, so turning rerank on/off or
changing top_k can be compared after the fact.
"""
import asyncio
import json
import logging
import re
import time
from datetime import datetime

from sqlalchemy import select

from app.core.llm import ProviderInfo, stream_chat
from app.core.prefs import load_config
from app.db import SessionLocal
from app.models import EvalItem, EvalRun

log = logging.getLogger(__name__)

_CONCURRENCY = 3  # questions judged in parallel; keep small to respect rate limits
_ANSWER_CAP = 4000  # chars of generated answer kept in detail_json


# ---------- source matching ----------


def _norm(path: str) -> str:
    return (path or "").strip().replace("\\", "/").lstrip("./").lower()


def source_matches(expected: str, source: str | None) -> bool:
    """Expected may be a full vault-relative path or just a file name."""
    e, s = _norm(expected), _norm(source or "")
    if not e or not s:
        return False
    if s == e or s.endswith("/" + e):
        return True
    # bare file name given: match on basename only
    return "/" not in e and s.split("/")[-1] == e


def _rank_of(expected: str, hits: list[dict]) -> int | None:
    """1-based rank of the first hit matching the expected source."""
    for i, h in enumerate(hits, 1):
        if source_matches(expected, h.get("source")):
            return i
    return None


# ---------- LLM faithfulness judging ----------

_JUDGE_SYSTEM = (
    "你是严格的 RAG 评审。给定「问题」「检索到的片段」「候选回答」，判断回答对片段的忠实度。"
    "只看回答的内容是否有片段支撑，不看写得好不好。评分标准：\n"
    "5=每句都有片段支撑；4=主要结论有支撑，细节略有延伸；3=部分有支撑、部分无据；"
    "2=大部分无据；1=几乎全是编造；0=答非所问或与片段矛盾。\n"
    '只输出 JSON，不要解释、不要代码块：{"score": 0-5 整数, "reason": "20 字以内理由"}'
)


async def _complete(info: ProviderInfo, model: str, messages: list[dict]) -> str:
    return "".join([c async for c in stream_chat(info, model, messages)]).strip()


async def _answer_and_judge(
    info: ProviderInfo, model: str, question: str, hits: list[dict]
) -> tuple[str, int | None, str]:
    """Generate a grounded answer, then score its faithfulness to the context."""
    from app.routers.chat import _build_rag_context

    context = _build_rag_context(hits)
    answer = await _complete(
        info,
        model,
        [{"role": "system", "content": context}, {"role": "user", "content": question}],
    )
    if not answer:
        return "", None, "模型返回空回答"

    raw = await _complete(
        info,
        model,
        [
            {"role": "system", "content": _JUDGE_SYSTEM},
            {
                "role": "user",
                "content": f"问题：{question}\n\n检索片段：\n{context}\n\n候选回答：\n{answer}",
            },
        ],
    )
    m = re.search(r"\{.*\}", raw, re.S)
    if not m:
        return answer[:_ANSWER_CAP], None, f"判分未返回 JSON：{raw[:60]}"
    try:
        data = json.loads(m.group(0))
        score = int(round(float(data.get("score"))))
    except (json.JSONDecodeError, TypeError, ValueError):
        return answer[:_ANSWER_CAP], None, f"判分解析失败：{raw[:60]}"
    return answer[:_ANSWER_CAP], max(0, min(5, score)), str(data.get("reason") or "").strip()[:100]


# ---------- batch run ----------


async def _one_case(
    case: dict, top_k: int, info: ProviderInfo | None, model: str, sem: asyncio.Semaphore
) -> dict:
    from app.core import indexer

    out: dict = {**case, "rank": None, "hits": [], "answer": "", "score": None, "reason": "", "error": ""}
    try:
        hits = await asyncio.to_thread(indexer.search_auto, case["question"], top_k)
    except Exception as e:  # noqa: BLE001 - one bad case must not kill the run
        log.warning("eval retrieval failed for %r", case["question"], exc_info=True)
        out["error"] = f"检索失败: {type(e).__name__}: {e}"
        return out

    out["hits"] = [h.get("source") for h in hits]
    if case["expected_source"]:
        out["rank"] = _rank_of(case["expected_source"], hits)
    if info is None or not hits:
        return out

    async with sem:
        try:
            out["answer"], out["score"], out["reason"] = await _answer_and_judge(
                info, model, case["question"], hits
            )
        except Exception as e:  # noqa: BLE001
            log.warning("eval judging failed for %r", case["question"], exc_info=True)
            out["error"] = f"判分失败: {type(e).__name__}: {e}"
    return out


async def run_eval(top_k: int | None = None, judge: bool = True) -> dict:
    """Run the whole eval set against the current retrieval config. Stores a run row."""
    prefs = load_config()
    k = int(top_k or prefs.get("rag_top_k", 5))

    async with SessionLocal() as db:
        items = (await db.execute(select(EvalItem).order_by(EvalItem.id))).scalars().all()
        cases = [
            {"id": i.id, "question": i.question, "expected_source": i.expected_source}
            for i in items
        ]
    if not cases:
        raise ValueError("评估集为空，先添加至少一个问题")

    info: ProviderInfo | None = None
    model = ""
    judge_model = ""
    if judge:
        from app.core.tasks import _resolve

        try:
            provider, model = await _resolve("")
            info = ProviderInfo(
                kind=provider.kind, base_url=provider.base_url, api_key=provider.api_key
            )
            judge_model = f"{provider.name}/{model}"
        except Exception:  # noqa: BLE001 - no usable provider: retrieval-only run
            log.warning("no provider for judging, retrieval metrics only", exc_info=True)
            info = None

    t0 = time.time()
    sem = asyncio.Semaphore(_CONCURRENCY)
    results = list(
        await asyncio.gather(*(_one_case(c, k, info, model, sem) for c in cases))
    )
    seconds = round(time.time() - t0, 1)

    labelled = [r for r in results if r["expected_source"]]
    n = len(labelled) or 1
    ranks = [r["rank"] for r in labelled]
    scores = [r["score"] for r in results if r["score"] is not None]
    agg = {
        "top_k": k,
        "hybrid": bool(prefs.get("hybrid_search", True)),
        "rerank": bool(prefs.get("rerank_enabled", True)),
        "full_context": bool(prefs.get("full_context", True)),
        "judge_model": judge_model,
        "total": len(results),
        "hit1": round(sum(1 for r in ranks if r == 1) / n, 4),
        "hit3": round(sum(1 for r in ranks if r and r <= 3) / n, 4),
        "hitk": round(sum(1 for r in ranks if r) / n, 4),
        "mrr": round(sum(1 / r for r in ranks if r) / n, 4),
        "faithfulness": round(sum(scores) / len(scores), 2) if scores else None,
        "seconds": seconds,
    }

    async with SessionLocal() as db:
        run = EvalRun(**agg, detail_json=json.dumps(results, ensure_ascii=False))
        db.add(run)
        await db.commit()
        await db.refresh(run)
        run_id, created = run.id, run.created_at

    log.info(
        "eval run %s: hit@1=%s mrr=%s faithfulness=%s (%ss)",
        run_id, agg["hit1"], agg["mrr"], agg["faithfulness"], seconds,
    )
    return {
        "id": run_id,
        "created_at": (created or datetime.now()).astimezone().isoformat(timespec="seconds"),
        **agg,
        "labelled": len(labelled),
        "detail": results,
    }

