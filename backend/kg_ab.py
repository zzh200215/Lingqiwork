"""kg on/off 对照评测（方向 5 前置）：同题同检索命中，答案带不带图谱上下文。

**与 rerank 对照的口径差异**：重排改变的是检索排序（拿 Hit@k/MRR 就够）；kg 是在
RAG 上下文之外**多注入一块图谱材料**（chat.py 的 kg 通道），检索命中本身不变——
所以这组对照比的只能是**答案质量**：同一批命中，答案 A 只吃 RAG 上下文，答案 B
多吃一块 `kg.retrieve + format_context` 的图谱块，各自过同一把忠实度判分（0-5），
比均值。判分复用 `core/evals` 的 `_JUDGE_SYSTEM / JudgeVerdict`——与评估页是同一把
尺子，两处口径分叉的那天数字就没人敢信了。

图谱只在它命中实体的问题上才可能起作用，所以除了总体均值，**必须**分
「kg 命中 / 未命中」两组看：未命中题两组答案吃完全相同的上下文，分数差纯属模型
随机性，恰好可以当这组对照的**噪声基线**读。

跑法（backend 目录下）：

    .venv/Scripts/python.exe kg_ab.py                # 全量评估集（每题 4 次 LLM 调用）
    .venv/Scripts/python.exe kg_ab.py --limit 10     # 先跑 10 题看路（控成本）
    .venv/Scripts/python.exe kg_ab.py --json         # 机读输出

前置三样，缺一样直接退出码 1（一发 LLM 调用都不发）：
  1. Neo4j 在 `kg_uri` 上可达且认证通过（设置页 kg_password）；
  2. 图谱非空（`KgEntity` > 0，空图谱先去知识库「图谱」标签构建）；
  3. 有可用的生成/判分模型（chat 那一路 `_resolve("")` 能解析出 provider）。

注意：脚本直连同一份 SQLite；评测期间别在设置页动 kg/模型配置。本脚本**不改**
`kg_enabled` 开关——绕开偏好直接调 `kg.retrieve/format_context`，跑完设置原样不动。
评估集 = 评估页 `eval_items`（与 rerank_ab 同一份在库金标）。
"""
import argparse
import asyncio
import json
import sys

_CONCURRENCY = 3  # 与 core/evals 同档，尊重限速


def preflight() -> dict:
    """三样前置逐项验证，任何一样不过就带着人话退出（退出码 1）。"""
    from app.core import kg

    v = kg.verify()
    if not v.get("ok"):
        print(
            "前置失败①：Neo4j 连不上或认证不过 —— " + str(v.get("error", ""))[:200]
            + "\n  → 确认 Neo4j 已启动（bolt://localhost:7687），设置页填好 kg_password。",
            file=sys.stderr,
        )
        sys.exit(1)
    with kg.get_driver().session() as s:
        entities = s.run("MATCH (e:KgEntity) RETURN count(e) AS n").single()["n"]
        files = s.run("MATCH (f:KgFile) RETURN count(f) AS n").single()["n"]
    if entities == 0:
        print(
            "前置失败②：图谱是空的（KgEntity=0）——先去知识库「图谱」标签构建一次再评。",
            file=sys.stderr,
        )
        sys.exit(1)
    print(f"[前置] Neo4j OK · 实体 {entities} 条 · 来源文件 {files} 篇")
    return {"entities": entities, "files": files}


async def resolve_judge():
    from app.core.llm import ProviderInfo
    from app.core.tasks import _resolve

    try:
        provider, model = await _resolve("")
    except Exception as e:  # noqa: BLE001 - 没有可用 provider 就没有这组对照
        print(
            f"前置失败②：解析不出可用模型（{type(e).__name__}: {e}）。"
            "\n  → 对照要生成答案并判分，需要至少一个可用 provider。",
            file=sys.stderr,
        )
        sys.exit(1)
    info = ProviderInfo(kind=provider.kind, base_url=provider.base_url, api_key=provider.api_key)
    print(f"[前置] 生成/判分模型：{provider.name}/{model}")
    return info, model


async def _cases(limit: int | None) -> list[dict]:
    from sqlalchemy import select

    from app.db import SessionLocal
    from app.models import EvalItem

    async with SessionLocal() as db:
        items = (await db.execute(select(EvalItem).order_by(EvalItem.id))).scalars().all()
        out = [{"id": i.id, "question": i.question, "expected_source": i.expected_source} for i in items]
    if not out:
        print("前置失败③：评估集为空（eval_items 0 行）。", file=sys.stderr)
        sys.exit(1)
    return out[:limit] if limit else out


def _mean(scores: list) -> float | None:
    scores = [s for s in scores if s is not None]
    return round(sum(scores) / len(scores), 2) if scores else None


def _agg(rows: list[dict], key: str) -> float | None:
    return _mean([r[key] for r in rows])


async def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="kg 图谱上下文 on/off 答案对照")
    parser.add_argument("--limit", type=int, default=None, help="只跑前 N 题（试跑控成本）")
    parser.add_argument("--top-k", type=int, default=None, help="覆盖 rag_top_k")
    parser.add_argument("--json", action="store_true", help="机读输出")
    args = parser.parse_args(argv)

    from app.core import kg
    from app.core.evals import _JUDGE_SYSTEM, JudgeVerdict, _rank_of
    from app.core.structured import extract_json

    preflight()
    info, model = await resolve_judge()
    cases = await _cases(args.limit)
    print(f"[跑] {len(cases)} 题 × (仅RAG / RAG+kg) × (生成+判分)，并发 {_CONCURRENCY} …", flush=True)

    from app.core.indexer import search_auto
    from app.core.llm import stream_chat
    from app.core.prefs import load_config
    from app.routers.chat import _build_rag_context

    top_k = args.top_k or int(load_config().get("rag_top_k", 5))
    sem = asyncio.Semaphore(_CONCURRENCY)

    async def complete(messages: list[dict]) -> str:
        return "".join([c async for c in stream_chat(info, model, messages)]).strip()

    async def judge(question: str, context: str, answer: str) -> tuple[int | None, str]:
        if not answer:
            return None, "空回答"
        obj, meta = await extract_json(
            info,
            model,
            [
                {"role": "system", "content": _JUDGE_SYSTEM},
                {"role": "user", "content": f"问题：{question}\n\n检索片段：\n{context}\n\n候选回答：\n{answer}"},
            ],
            JudgeVerdict,
        )
        if obj is None:
            return None, f"判分未返回 JSON：{meta.error[:60]}"
        return max(0, min(5, int(round(obj.score)))), obj.reason.strip()[:100]

    async def one_case(case: dict) -> dict:
        out = {**case, "rank": None, "kg_chars": 0, "score_a": None, "score_b": None, "reason_a": "", "reason_b": "", "error": ""}
        async with sem:
            try:
                hits = await asyncio.to_thread(search_auto, case["question"], top_k)
            except Exception as e:  # noqa: BLE001 - 单题失败不拖垮整跑
                out["error"] = f"检索失败: {type(e).__name__}: {e}"
                return out
            out["hits"] = [h.get("source") for h in hits]
            if case["expected_source"]:
                out["rank"] = _rank_of(case["expected_source"], hits)
            context_a = _build_rag_context(hits)
            try:
                kg_block = kg.format_context(kg.retrieve(case["question"]))
            except Exception as e:  # noqa: BLE001 - 图谱挂了该题按「无 kg」走，如实记账
                out["error"] = f"kg取数失败: {type(e).__name__}: {e}"
                kg_block = ""
            out["kg_chars"] = len(kg_block)
            context_b = context_a + ("\n\n" + kg_block if kg_block else "")
            try:
                answer_a = await complete([{"role": "system", "content": context_a}, {"role": "user", "content": case["question"]}])
                answer_b = await complete([{"role": "system", "content": context_b}, {"role": "user", "content": case["question"]}])
                out["score_a"], out["reason_a"] = await judge(case["question"], context_a, answer_a)
                out["score_b"], out["reason_b"] = await judge(case["question"], context_b, answer_b)
            except Exception as e:  # noqa: BLE001
                out["error"] = f"生成/判分失败: {type(e).__name__}: {e}"
        return out

    results = list(await asyncio.gather(*(one_case(c) for c in cases)))

    hit_rows = [r for r in results if r["kg_chars"] > 0 and not r["error"]]
    miss_rows = [r for r in results if r["kg_chars"] == 0 and not r["error"]]
    summary = {
        "total": len(results),
        "kg_hit": len(hit_rows),
        "kg_miss": len(miss_rows),
        "failed": sum(1 for r in results if r["error"]),
        "top_k": top_k,
        "overall": {"A_rag_only": _agg(results, "score_a"), "B_rag_plus_kg": _agg(results, "score_b")},
        "by_kg_hit": {
            "hit": {"A": _agg(hit_rows, "score_a"), "B": _agg(hit_rows, "score_b")},
            "miss_noisy_baseline": {"A": _agg(miss_rows, "score_a"), "B": _agg(miss_rows, "score_b")},
        },
    }
    if args.json:
        print(json.dumps({**summary, "results": results}, ensure_ascii=False, indent=2, default=str))
        return 0

    print()
    print(f"评估集 {len(results)} 题 · kg 命中 {len(hit_rows)} / 未命中 {len(miss_rows)} · 失败 {summary['failed']}")
    print()
    print("  分组                仅RAG   RAG+kg     Δ")
    for label, rows in (("总体", results), ("kg命中题", hit_rows), ("kg未命题(噪声基线)", miss_rows)):
        if not rows:
            continue
        a, b = _agg(rows, "score_a"), _agg(rows, "score_b")
        delta = f"{b - a:+.2f}" if (a is not None and b is not None) else "—"
        print(f"  {label:<19}{a!s:>7}{b!s:>9}{delta:>8}")
    print()
    print("结论口径：忠实度=「答案是否句句有据」。看「kg命中题」那组；未命中题两组上下文")
    print("完全相同，分数差就是模型随机性的噪声基线——差值小于它，等于没有差别。")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main(sys.argv[1:])))
