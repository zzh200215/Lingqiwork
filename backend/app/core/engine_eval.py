"""四个成文引擎的质量标尺：结构判分（确定性、不花钱）+ 接地判分（LLM）。

**为什么需要它。** research / compose / recap / decide 共用 `core/report.py` 一条脊梁，
形状统一了，但输出**好不好没有任何东西在测**。`test_prompts.py` 钉 sha 只保证「提示词
没被改过」——和「提示词好不好」正好是反的：你改了提示词，测试红了，更新 sha，然后就没
有然后了。而四个引擎共用一份提示词，**一次改动同时打穿四个功能**。

**两层判分，分工明确：**

1. **结构判分**（`check_report` / `check_frame`，纯函数）：只断言提示词里**真正承诺过**
   的东西——固定小节的齐/序/非空、引用编号不越界、引用数量下限、复盘不得出现「建议/
   下一步」（它是镜子不是任务清单）、方案必须引到「你自己的材料」。零成本、毫秒级、
   可离线测，能接住绝大多数回归。
2. **接地判分**（LLM judge，0-5）：材料之外的编造。「材料里没有」明说出来的**算有据、
   不扣分**——这条是故意的，因为四个引擎的提示词都要求「宁可说薄也不硬凑」。

**golden set 是 JSON 文件**（`backend/evals/engines/*.json`），不是数据库行：它是跟提示词
同版本演进的可审阅产物，该跟着代码一起走。RAG 那套的 `EvalItem` 在库里是因为问题是用
户手加的；这一套是工程资产。

**与人工反馈共用一把 key**：每条 run 都存 `prompt_sha`（与 `core/prompts.py` /
`artifact_feedback` 同一个算法）。所以「自动分」和「人点出来的满意率」落在一起，
回答得了「这版提示词是变好了还是只是我手滑点了赞」。
"""

import asyncio
import json
import logging
import re
import time

from pydantic import BaseModel, field_validator
from sqlalchemy import select

from app.config import BASE_DIR
from app.core.llm import ProviderInfo
from app.core.structured import extract_json
from app.db import SessionLocal
from app.models import EngineEvalRun
from app.core import usage_ledger

log = logging.getLogger(__name__)

ENGINES = ("research", "compose", "recap", "decide", "conflict")
FIXTURE_DIR = BASE_DIR / "backend" / "evals" / "engines"

_CONCURRENCY = 2  # 每个用例至少一次模型调用，别把并发拉高
_ANSWER_CAP = 3000  # detail_json 里保留的产出长度

# 正文里的引用编号。`(?!\()` 是为了不把 markdown 链接 `[文字](url)` 的数字当成引用。
_CITE = re.compile(r"\[(\d+)\](?!\()")


def _engine_spec(engine: str):
    """engine → (模块, 成文提示词, 读题提示词或 None)。延迟 import：engine_eval 本身要轻。"""
    if engine == "research":
        from app.core import research as m

        return m, m._SYNTH_PROMPT, None
    if engine == "compose":
        from app.core import compose as m

        return m, m._SYNTH_PROMPT, None
    if engine == "recap":
        from app.core import recap as m

        return m, m._SYNTH_PROMPT, None
    if engine == "decide":
        from app.core import decide as m

        return m, m._SYNTH_PROMPT, m._FRAME_PROMPT
    if engine == "conflict":
        from app.core import conflict as m

        # 读题那步（`_FRAME_PROMPT`）不在这里评：它的产物是 `subject`，和 check_frame 要的
        # decision/options/criteria 不是一回事，评它得另写一套判分。对质的结构判分靠
        # `min_cites_per_section`（每处冲突必须两侧都引到）。
        return m, m._SYNTH_PROMPT, None
    raise ValueError(f"unknown engine {engine!r}")


async def _resolve(model_id: str = ""):
    """模型解析缝——测试注入口（同各引擎的 `_resolve`）。"""
    from app.core.report import resolve

    return await resolve(model_id)


# ---------- golden set ----------


def load_cases(engine: str) -> list[dict]:
    """读某个引擎的 golden set。文件缺失/坏掉 → 空列表（不是异常：标尺可选）。"""
    path = FIXTURE_DIR / f"{engine}.json"
    try:
        blob = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        log.warning("engine eval fixture unreadable: %s", path, exc_info=True)
        return []
    cases = blob.get("cases") or []
    out: list[dict] = []
    for c in cases:
        if not isinstance(c, dict) or not str(c.get("id") or "").strip():
            continue
        out.append(
            {
                "id": str(c["id"]),
                "topic": str(c.get("topic") or ""),
                "sources": [dict(s) for s in (c.get("sources") or []) if isinstance(s, dict)],
                "expect": dict(c.get("expect") or {}),
            }
        )
    return out


def all_case_counts() -> dict:
    """每个引擎有几条用例——给 UI 显示「覆盖了什么」。"""
    return {e: len(load_cases(e)) for e in ENGINES}


# ---------- 结构判分（纯函数，不花钱） ----------


def check_report(report, sources: list[dict], expect: dict) -> list[dict]:
    """结构判分 → findings 列表；空列表 = 全过。

    只断言 `expect` 里声明过的东西——**只查提示词真正承诺过的**。研究/产出的小节名是
    「2-4 个、自己定」，所以它们的 expect 里没有 `sections`，这里也就不查小节名。
    """
    findings: list[dict] = []
    valid = {int(s["n"]) for s in sources if s.get("n") is not None}
    used = {int(n) for n in (report.used or [])}

    # 1) 引用编号不越界（used 与正文里的 [n] 都要查）
    for n in sorted(used - valid):
        findings.append({"code": "unknown_used", "detail": f"used 里的 [{n}] 不在材料里"})
    for sec in report.sections:
        stray = sorted({int(x) for x in _CITE.findall(sec.body)} - valid)
        if stray:
            findings.append(
                {
                    "code": "unknown_citation",
                    "detail": f"「{sec.heading}」引了不存在的 " + "、".join(f"[{n}]" for n in stray),
                }
            )

    # 2) 引用数量下限——一条都不引等于没看材料
    min_used = int(expect.get("min_used") or 0)
    if len(used) < min_used:
        findings.append(
            {"code": "too_few_citations", "detail": f"只引了 {len(used)} 条，要求 ≥{min_used}"}
        )

    # 3) 固定小节：齐、序、非空（只有 expect.sections 声明了才查）
    want = [str(h) for h in (expect.get("sections") or [])]
    got = [s.heading for s in report.sections]
    if want:
        missing = [h for h in want if h not in got]
        if missing:
            findings.append({"code": "sections_missing", "detail": "缺小节：" + "、".join(missing)})
        else:
            idx = [got.index(h) for h in want]
            if idx != sorted(idx):
                findings.append(
                    {"code": "sections_out_of_order", "detail": "小节顺序不对：" + " → ".join(got)}
                )
    # 小节**条数**下限：研究和产出的提示词写的是「2-4 个小节」，名字各自定，所以只能查数量。
    # 只查下限不查上限——写多了是文风问题，写成一个（把该分的东西压成一坨）是真没照做。
    min_sections = int(expect.get("min_sections") or 0)
    if min_sections and len(report.sections) < min_sections:
        findings.append(
            {
                "code": "too_few_sections",
                "detail": f"只写了 {len(report.sections)} 个小节，提示词要求至少 {min_sections} 个",
            }
        )
    for s in report.sections:
        if not s.body.strip():
            findings.append({"code": "empty_section", "detail": f"「{s.heading}」是空的"})

    # 每节至少引几个来源——对质的提示词承诺「两侧都引原句」，而一处冲突本来就是两边的事，
    # 只引一边等于没对质。别的引擎不声明这个键，默认 0 = 不查。
    min_cites = int(expect.get("min_cites_per_section") or 0)
    if min_cites:
        for s in report.sections:
            cites = {int(x) for x in _CITE.findall(s.body)}
            if len(cites) < min_cites:
                findings.append(
                    {
                        "code": "too_few_cites_per_section",
                        "detail": f"「{s.heading}」只引了 {len(cites)} 个来源，"
                        f"要求每节 ≥{min_cites}（一处冲突至少是两边的事）",
                    }
                )

    # 4) 明令禁止的话（复盘禁「建议」——它是镜子，不是任务清单）
    blob = "\n".join(s.body for s in report.sections)
    for phrase in expect.get("forbid") or []:
        phrase = str(phrase)
        if phrase and phrase in blob:
            findings.append({"code": "forbidden_phrase", "detail": f"出现了被禁的「{phrase}」"})

    # 5) 必须引到某一类材料（方案：判断得落在「你自己的材料/约束」上）
    kinds = {str(s.get("kind")) for s in sources if s.get("n") in used}
    for kind in expect.get("require_kinds") or []:
        kind = str(kind)
        if kind and kind not in kinds:
            findings.append(
                {"code": "missing_required_kind", "detail": f"没有引用任何「{kind}」类材料"}
            )

    if not (report.title or "").strip():
        findings.append({"code": "title_missing", "detail": "没有标题"})
    return findings


def check_frame(frame, expect: dict) -> list[dict]:
    """读题判分（只有方案有 frame）。Pure."""
    want = expect.get("frame") or {}
    if not want or frame is None:
        return []
    findings: list[dict] = []
    if not (getattr(frame, "decision", "") or "").strip():
        findings.append({"code": "frame_no_decision", "detail": "没读出「要决定什么」"})
    min_opts = int(want.get("min_options") or 0)
    opts = list(getattr(frame, "options", []) or [])
    if len(opts) < min_opts:
        findings.append(
            {
                "code": "frame_too_few_options",
                "detail": f"只摆了 {len(opts)} 个选项，要求 ≥{min_opts}（只给一个等于没帮你选）",
            }
        )
    min_crit = int(want.get("min_criteria") or 0)
    crit = list(getattr(frame, "criteria", []) or [])
    if len(crit) < min_crit:
        findings.append(
            {"code": "frame_too_few_criteria", "detail": f"只列了 {len(crit)} 条判据，要求 ≥{min_crit}"}
        )
    return findings


# ---------- 接地判分（LLM） ----------

_JUDGE_SYSTEM = (
    "你是严格的评审。给定「任务」「可用材料」「候选产出」，判断产出是否被材料支撑。"
    "只看有没有材料之外的内容（编造 / 脑补 / 拿常识补），不看文笔。评分标准：\n"
    "5=每条论断都能在材料里找到依据；4=主要论断有据、个别衔接处略有延伸；"
    "3=一半有据一半无据；2=大部分无据；1=几乎全是编造；0=与材料矛盾或答非所问。\n"
    "**材料本来就没覆盖的地方，产出若明说了「材料里没有」或「暂时还没这部分」，算有据、不扣分。**\n"
    '只输出 JSON，不要解释、不要代码块：{"score": 0-5 整数, "reason": "20 字以内理由"}'
)


class GroundedVerdict(BaseModel):
    """接地判分。score 越界由调用方钳到 0-5；非数字按 0 记。"""

    score: float = 0.0
    reason: str = ""

    @field_validator("score", mode="before")
    @classmethod
    def _score(cls, v):
        try:
            return float(v)
        except (TypeError, ValueError):
            return 0.0

    @field_validator("reason", mode="before")
    @classmethod
    def _reason(cls, v):
        if v is None or isinstance(v, (list, dict)):
            return ""
        return str(v).strip()


async def judge_grounded(
    info: ProviderInfo,
    model: str,
    engine: str,
    topic: str,
    sources: list[dict],
    produced: str,
    *,
    stream_fn=None,
    native_fn=None,
) -> tuple[int | None, str]:
    """产出对材料的忠实度 0-5（None = 判分没跑成）。

    判分本身也走 `extract_json` 的三级降级（有的 provider 只吐裸 JSON、有的要原生
    JSON 模式）——和 `evals.py::_answer_and_judge` 同一个路子。
    """
    from app.core.report import format_sources

    obj, meta = await extract_json(
        info,
        model,
        [
            {"role": "system", "content": _JUDGE_SYSTEM},
            {
                "role": "user",
                "content": (
                    f"任务：{engine} 引擎，话题「{topic}」\n\n"
                    f"材料：\n{format_sources(sources)}\n\n"
                    f"候选产出：\n{produced[:_ANSWER_CAP]}"
                ),
            },
        ],
        GroundedVerdict,
        stream_fn=stream_fn,
        native_fn=native_fn,
    )
    if obj is None:
        return None, f"判分未返回 JSON：{meta.error[:60]}"
    return max(0, min(5, int(round(obj.score)))), obj.reason.strip()[:100]


# ---------- run ----------


async def _synthesize_collect(topic, sources, prompt, model_id, stream_fn, native_fn):
    """跑一遍**生产在用的那条路**（流式成文），只取最终产物——评测不需要 draft。

    刻意不走 `report.synthesize`：那会让标尺去测一条已经不在生产路径上的代码，
    等于量错了对象。
    """
    from app.core import report as _report

    rep = None
    async for ev, payload in _report.synthesize_streaming(
        topic,
        sources,
        prompt,
        model_id,
        stream_fn=stream_fn,
        native_fn=native_fn,
        resolve_fn=_resolve,
    ):
        if ev != "draft":
            rep = payload
    return rep


async def _one_case(
    engine: str,
    case: dict,
    model_id: str,
    info: ProviderInfo | None,
    model: str,
    sem: asyncio.Semaphore,
    *,
    judge: bool,
    stream_fn=None,
    native_fn=None,
) -> dict:
    from app.core import report as _report

    sources = case["sources"]
    expect = case["expect"]
    out: dict = {
        "id": case["id"],
        "topic": case["topic"],
        "sources": len(sources),
        "findings": [],
        "frame_findings": [],
        "score": None,
        "reason": "",
        "title": "",
        "error": "",
    }

    # 读题（只有方案有）——先跑，因为它决定了后面成文的话题
    topic = case["topic"]
    if engine == "decide":
        from app.core import decide as _decide

        try:
            async with sem:
                frame = await _decide.frame_decision(
                    topic, model_id, stream_fn=stream_fn, native_fn=native_fn
                )
        except Exception as e:  # noqa: BLE001 - 一条用例挂了不该毁掉整次评测
            out["error"] = f"读题失败: {type(e).__name__}: {e}"
            return out
        out["frame_findings"] = check_frame(frame, expect)
        if frame is not None and (frame.decision or "").strip():
            topic = frame.decision

    _, synth_prompt, _ = _engine_spec(engine)
    try:
        async with sem:
            rep = await _synthesize_collect(
                topic, sources, synth_prompt, model_id, stream_fn, native_fn
            )
    except Exception as e:  # noqa: BLE001
        log.warning("engine eval synthesis failed for %s", case["id"], exc_info=True)
        out["error"] = f"成文失败: {type(e).__name__}: {e}"
        return out
    if rep is None:
        out["error"] = "成文失败（模型不可用或输出解析不了）"
        return out

    out["title"] = rep.title
    out["findings"] = check_report(rep, sources, expect)

    if judge and info is not None:
        async with sem:
            try:
                out["score"], out["reason"] = await judge_grounded(
                    info,
                    model,
                    engine,
                    topic,
                    sources,
                    _report.to_markdown(rep, sources, engine),
                    stream_fn=stream_fn,
                    native_fn=native_fn,
                )
            except Exception as e:  # noqa: BLE001
                log.warning("engine eval judging failed for %s", case["id"], exc_info=True)
                out["error"] = f"判分失败: {type(e).__name__}: {e}"
    return out


async def _run_one_engine(
    engine: str,
    model_id: str,
    info: ProviderInfo | None,
    model: str,
    *,
    judge: bool,
    stream_fn=None,
    native_fn=None,
) -> dict | None:
    cases = load_cases(engine)
    if not cases:
        return None
    _, synth_prompt, _ = _engine_spec(engine)
    from app.core import report as _report

    t0 = time.time()
    sem = asyncio.Semaphore(_CONCURRENCY)
    # 用例并发跑（同 `evals.py`）。串行的话八个用例要十分把钟，而这是个会被
    # 设置页按钮同步等待的调用——慢到那个程度就成了体验问题，不只是慢。
    results = list(
        await asyncio.gather(
            *(
                _one_case(
                    engine, c, model_id, info, model, sem,
                    judge=judge, stream_fn=stream_fn, native_fn=native_fn,
                )
                for c in cases
            )
        )
    )
    seconds = round(time.time() - t0, 1)

    passed = sum(1 for r in results if not r["findings"] and not r["frame_findings"] and not r["error"])
    scores = [r["score"] for r in results if r["score"] is not None]
    agg = {
        "engine": engine,
        "prompt_sha": _report.prompt_sha(synth_prompt),
        "model_id": model_id,
        "total": len(results),
        "structural": round(passed / len(results), 4),
        "grounded": round(sum(scores) / len(scores), 2) if scores else None,
        "seconds": seconds,
    }

    async with SessionLocal() as db:
        row = EngineEvalRun(**agg, detail_json=json.dumps(results, ensure_ascii=False))
        db.add(row)
        await db.commit()
        await db.refresh(row)
        agg["id"] = row.id
        agg["created_at"] = (
            row.created_at.astimezone().isoformat(timespec="seconds") if row.created_at else None
        )
    log.info(
        "engine eval %s: structural=%s grounded=%s (%ss)",
        engine, agg["structural"], agg["grounded"], seconds,
    )
    return {**agg, "detail": results}


@usage_ledger.traced("eval")
async def run(engine: str | None = None, *, judge: bool = True, stream_fn=None, native_fn=None) -> dict:
    """跑一个引擎（或全部）的 golden set，每个引擎存一行 run。

    模型不可用时只跑结构判分（仍要跑——结构判分不花钱，且它接得住大多数回归）。
    """
    targets = [engine] if engine else list(ENGINES)
    for e in targets:
        if e not in ENGINES:
            raise ValueError(f"unknown engine {e!r}")

    from app.core import providers

    model_id = providers.default_model_id() or ""
    info: ProviderInfo | None = None
    model = ""
    judge_model = ""
    if judge and model_id:
        resolved = await _resolve(model_id)
        if resolved is not None:
            info, model = resolved
            judge_model = model_id
    if info is None:
        # 没有可用模型：判分那半跳过，结构判分照跑
        judge = False

    runs, skipped = [], []
    for e in targets:
        r = await _run_one_engine(
            e, model_id, info, model, judge=judge, stream_fn=stream_fn, native_fn=native_fn
        )
        if r is None:
            skipped.append(e)
        else:
            runs.append(r)

    return {
        "runs": runs,
        "skipped": skipped,
        "judge_model": judge_model,
        "judged": info is not None,
        "coverage": all_case_counts(),
    }


# ---------- history / 回归对比 ----------

_METRICS = ("structural", "grounded")


def _run_dict(r: EngineEvalRun) -> dict:
    return {
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


def _compare(newer: dict, older: dict, eps: float = 1e-6) -> dict:
    deltas: dict[str, float] = {}
    for m in _METRICS:
        a, b = newer.get(m), older.get(m)
        if a is None or b is None:
            continue
        d = round(a - b, 4)
        if abs(d) > eps:
            deltas[m] = d
    return {
        "deltas": deltas,
        "regressions": sorted(m for m, d in deltas.items() if d < 0),
        "improvements": sorted(m for m, d in deltas.items() if d > 0),
        "prompt_changed": (newer.get("prompt_sha") or "") != (older.get("prompt_sha") or ""),
    }


async def history(engine: str | None = None, limit: int = 40) -> dict:
    """最近若干次引擎评测，按引擎给出「这次比上次好了还是坏了」。只读，不跑模型。"""
    n = max(2, min(limit, 200))
    async with SessionLocal() as db:
        stmt = select(EngineEvalRun).order_by(EngineEvalRun.id.desc()).limit(n)
        if engine:
            stmt = (
                select(EngineEvalRun)
                .where(EngineEvalRun.engine == engine)
                .order_by(EngineEvalRun.id.desc())
                .limit(n)
            )
        rows = (await db.execute(stmt)).scalars().all()

    runs = [_run_dict(r) for r in rows]
    by_engine: dict[str, dict] = {}
    for e in ENGINES:
        mine = [r for r in runs if r["engine"] == e]
        if not mine:
            continue
        latest = mine[0]
        prev = mine[1] if len(mine) > 1 else None
        entry: dict = {"latest": latest, "previous": prev, "comparison": None, "conclusion": ""}
        if prev is None:
            entry["conclusion"] = "只跑过一次，还没有可比对象。"
        else:
            cmp = _compare(latest, prev)
            entry["comparison"] = cmp
            bits = []
            if cmp["prompt_changed"]:
                bits.append(f"提示词从 {prev['prompt_sha'] or '—'} 变成了 {latest['prompt_sha'] or '—'}")
            if cmp["regressions"]:
                bits.append("变差：" + "、".join(cmp["regressions"]))
            if cmp["improvements"]:
                bits.append("变好：" + "、".join(cmp["improvements"]))
            entry["conclusion"] = "；".join(bits) + "。" if bits else "与上次相比指标无变化。"
        by_engine[e] = entry

    return {"runs": runs, "by_engine": by_engine, "coverage": all_case_counts()}


async def latest_by_engine() -> dict:
    """每个引擎最近一次的自动分——给设置页把「自动分」摆在「人工满意率」旁边。"""
    out: dict[str, dict] = {}
    async with SessionLocal() as db:
        for e in ENGINES:
            row = (
                await db.execute(
                    select(EngineEvalRun)
                    .where(EngineEvalRun.engine == e)
                    .order_by(EngineEvalRun.id.desc())
                    .limit(1)
                )
            ).scalars().first()
            out[e] = _run_dict(row) if row else None
    return out


async def health(latest: dict | None = None) -> dict:
    """**标尺自己的**健康度——戳破「全顶格」的假象（同 `evals.eval_health` 的用意）。

    结构判分全过是正常的：它只在失守时说话。要警惕的是**接地分被压在顶部**——全在
    4.5 以上说明这套用例区分不出好坏，提示词改坏了它也看不出来。一个永远读「满分」
    的标尺，和没有标尺是一回事。
    """
    latest = latest if latest is not None else await latest_by_engine()
    scored = {e: r for e, r in latest.items() if r}
    grounded = [r["grounded"] for r in scored.values() if r["grounded"] is not None]

    warnings: list[str] = []
    if not scored:
        warnings.append("还没跑过——先点一次「跑一遍」建个基线，之后才有得比")
    if len(grounded) >= 2 and min(grounded) >= 4.5:
        warnings.append(
            f"接地分全在 {min(grounded):.1f} 以上，分档压在顶部、区分度低——"
            "要接得住回归，得补「材料互相冲突」「材料明显不足」「材料里没有答案」这类刁用例"
        )
    thin = [f"{e}（{n} 条）" for e, n in all_case_counts().items() if n < 4]
    if thin and scored:
        warnings.append("用例偏少：" + "、".join(thin) + "——每个引擎补到 4+ 条才有区分度")

    return {"engines": sorted(scored), "grounded": grounded, "warnings": warnings}
