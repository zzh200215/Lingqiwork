"""学习闭环的中间两跳：研究（搜 → 读 → 对照你自己的材料）→ 产出（一篇带引用的讲解）。

方向见 PLAN.md 第 7 节的收尾判断：闭环的两头早已存在——「学」是 `core/tutor.py`，
「下次先捞你自己的」是 `tutor._retrieve → indexer.search_auto → format_material` 的
取材块。这里补的是中间两跳，并把产出物落进 `vault/research/` 被索引；回路因此自己
闭上，不需要一行新的检索代码。

显式四步管线，不是自由 agentic loop：可控、可离线测，引用是设计出来的而不是碰运气。

    plan_queries  → 2-4 个互补检索式（一次结构化调用）
    gather        → 你自己的材料（知识库）优先，其次网络（搜索 → 取正文）
    synthesize    → 只依据材料成文，每个论断带 [编号]
    save          → 落 vault/research/ + 进索引

与「产出」（`core/compose.py`）共用 `core/report.py` 的脊梁（结构化 Report → 带 [编号]
的 md → 落 vault + 进索引）；两者的区别只在**取材方向**：研究向外（搜网），产出向内
（你自己的累积）。这里保留研究特有的提示词、检索式规划与取网正文。

护栏（PLAN.md 第 2 节）：拉取式——点它才跑；没有定时、没有队列、没有设置开关。
"""

import asyncio
import logging
import re

from pydantic import BaseModel, Field, field_validator

from app.config import VAULT_DIR
from app.core import report as _report
from app.core.report import (
    Report,
    Section,
    clean_report as _clean_report,
    format_sources as _format_sources,
    public_source as _public_source,
    resolve as _resolve,
    slug as _slug_base,
    to_markdown,
    trim_total,
)

log = logging.getLogger(__name__)

# 沿用旧路径的名字：路由用 `ResearchReport`/`Section`，测试用下面这些下划线开头的内部名。
# 脊梁搬去了 `core/report.py`，这里只是转出来。
__all__ = [
    "QueryPlan",
    "Report",
    "ResearchReport",
    "Section",
    "_clean_report",
    "_format_sources",
    "_public_source",
    "_resolve",
    "_slug",
    "_trim_total",
    "gather",
    "plan_queries",
    "run",
    "save",
    "synthesize",
    "to_markdown",
]


RESEARCH_DIR = VAULT_DIR / "research"

PLAN_MAX_QUERIES = 4  # 检索式条数上限
KB_TOP_K = 5  # 「对照你自己的材料」的检索宽度
FETCH_MAX = 5  # 最多读几篇网页正文
SOURCE_CHARS = 2000  # 单条材料截断
TOTAL_CHARS = 20000  # 喂给成文的总量上限（自己材料优先，见 _trim_total）

_PLAN_PROMPT = """你在为一个学习者规划一次研究。只输出一个 JSON 对象，不要任何解释：

{"queries": ["检索式1", "检索式2", "检索式3"]}

给 2-4 个**互补**的检索式——不是同一句话的改写，而是覆盖这个话题不同侧面的问法
（例如「是什么 / 怎么做 / 有什么坑 / 和相邻方案怎么选」）。每个检索式是一句可以直接
丢进搜索引擎的话，不要写「研究一下」「了解一下」这种没有信息量的开头。"""

_SYNTH_PROMPT = """你在把一批材料整理成一篇给学习者的讲解。只输出一个 JSON 对象，不要任何解释：

{"title": "讲解标题", "sections": [{"heading": "小节标题", "body": "正文"}], "used": [1, 3]}

硬要求：
1. 只依据下面给的材料写。材料里没有的不要写，也不要补充你自己的记忆。
2. 每个论断后面用 [编号] 标出它来自哪条材料，例如「……在异步场景下更常见 [2]」。
3. 材料之间冲突时，把冲突说出来，不要挑一个当事实。
4. `used` 列出你真正引用到的材料编号，升序，去重。
5. 2-4 个小节，每节正文 3-6 句。这是讲解不是百科——写清楚比写全重要。
6. 某条材料明显和话题无关就忽略它，不要为了用上编号而硬扯。"""


# ---------- structured output shapes ----------


class QueryPlan(BaseModel):
    queries: list[str] = Field(default_factory=list)

    @field_validator("queries", mode="before")
    @classmethod
    def _as_list(cls, v):
        if v is None:
            return []
        if isinstance(v, str):
            return re.split(r"[\n；;]+", v) if v.strip() else []
        if isinstance(v, (list, tuple)):
            return [str(x).strip() for x in v if x is not None and str(x).strip()]
        return []


# 报告模型来自共用脊梁（`core/report.py`）；研究这边保留旧名字，路由与测试都用它。
ResearchReport = Report


# ---------- step 1: plan ----------
# ---------- step 1: plan ----------


def _clean_queries(raw, topic: str = "") -> list[str]:
    """模型输出 → 干净的检索式列表（去空白、去重、限长、限条数）。Pure."""
    out: list[str] = []
    seen: set[str] = set()
    for q in raw or []:
        q = re.sub(r"\s+", " ", str(q)).strip()[:80]
        key = q.lower()
        if not q or key in seen:
            continue
        seen.add(key)
        out.append(q)
        if len(out) >= PLAN_MAX_QUERIES:
            break
    return out


async def plan_queries(
    topic: str, model_id: str = "", *, stream_fn=None, native_fn=None
) -> list[str]:
    """一次结构化调用 → 互补检索式（[] 表示不可用，调用方退回只搜 topic）。"""
    topic = (topic or "").strip()
    if not topic:
        return []
    resolved = await _resolve(model_id)
    if resolved is None:
        return []
    info, model = resolved

    from app.core.structured import extract_json

    obj, meta = await extract_json(
        info,
        model,
        [
            {"role": "system", "content": _PLAN_PROMPT},
            {"role": "user", "content": f"话题：{topic}"},
        ],
        QueryPlan,
        stream_fn=stream_fn,
        native_fn=native_fn,
    )
    if obj is None:
        log.info("research plan unavailable: %s", meta.error)
        return []
    return _clean_queries(obj.queries, topic)


# ---------- step 2: gather ----------


async def _default_search(query: str) -> list[dict]:
    from app.core import mcp

    return await mcp.search_web(query)


async def _default_fetch(url: str) -> str:
    from app.core import mcp

    return await mcp._fetch_url({"url": url})


async def _default_kb(query: str, top_k: int) -> list[dict]:
    from app.core import indexer

    return await asyncio.to_thread(indexer.search_auto, query, top_k)


def _trim_total(sources: list[dict]) -> list[dict]:
    """总量封顶（自己的材料优先）。读 `TOTAL_CHARS` 这个模块全局——测试会 patch 它。"""
    return trim_total(sources, TOTAL_CHARS)


async def gather(
    topic: str,
    queries: list[str],
    *,
    search_fn=None,
    fetch_fn=None,
    kb_fn=None,
) -> list[dict]:
    """你自己的材料优先，其次网络 → 带编号的来源 [{n, kind, title, ref, text}]。

    KB 路是「对照你自己的材料」；网络路是搜索去重后取前 FETCH_MAX 篇正文。任何一路
    挂了都只是这条路变薄，不抛异常——没有材料的事实由调用方（`run`）决定怎么处理。
    """
    kb_fn = kb_fn or _default_kb
    search_fn = search_fn or _default_search
    fetch_fn = fetch_fn or _default_fetch

    raw: list[dict] = []

    try:
        for h in await kb_fn(topic, KB_TOP_K):
            text = str(h.get("text") or "").strip()
            if not text:
                continue
            raw.append(
                {
                    "kind": "kb",
                    "title": str(h.get("title") or h.get("source") or "").strip(),
                    "ref": str(h.get("source") or "").strip(),
                    "text": text[:SOURCE_CHARS],
                }
            )
    except Exception:  # noqa: BLE001 - 知识库挂了只是没有自己的材料
        log.warning("research kb gather failed", exc_info=True)

    seen_urls: set[str] = set()
    hits: list[dict] = []
    for q in queries or [topic]:
        try:
            found = await search_fn(q)
        except Exception:  # noqa: BLE001 - 一个检索式失败不影响其余
            log.warning("research web search failed: %s", q, exc_info=True)
            continue
        for h in found or []:
            url = str(h.get("url") or "").strip()
            if not url or url in seen_urls:
                continue
            seen_urls.add(url)
            hits.append(
                {
                    "title": str(h.get("title") or "").strip(),
                    "url": url,
                }
            )

    for h in hits[:FETCH_MAX]:
        try:
            text = str(await fetch_fn(h["url"]) or "").strip()
        except Exception:  # noqa: BLE001 - 一篇打不开就跳过
            log.warning("research fetch failed: %s", h["url"], exc_info=True)
            continue
        if not text or text.startswith("[错误]") or text == "(页面没有可读正文)":
            continue
        raw.append(
            {
                "kind": "web",
                "title": h["title"] or h["url"],
                "ref": h["url"],
                "text": text[:SOURCE_CHARS],
            }
        )

    return [dict(s, n=i) for i, s in enumerate(_trim_total(raw), 1)]


# ---------- step 3: synthesize ----------


async def synthesize(
    topic: str,
    sources: list[dict],
    model_id: str = "",
    *,
    stream_fn=None,
    native_fn=None,
) -> ResearchReport | None:
    """材料 → 带引用的讲解（None 表示模型不可用或输出解析不了）。

    形状来自共用脊梁（`core/report.py`）；这里只把研究的提示词与模型解析钉进去
    （`resolve_fn=_resolve` 保留研究自己的测试缝）。
    """
    return await _report.synthesize(
        topic,
        sources,
        _SYNTH_PROMPT,
        model_id,
        stream_fn=stream_fn,
        native_fn=native_fn,
        resolve_fn=_resolve,
    )


# ---------- step 4: the deliverable ----------


def _slug(text: str) -> str:
    return _slug_base(text, "research")


async def save(report: ResearchReport, sources: list[dict]) -> dict:
    """落 `vault/research/` 并进索引——「下次先捞你自己的」那一跳靠的就是这里。"""
    return await _report.save(report, sources, RESEARCH_DIR)


# ---------- orchestration ----------


async def run(
    topic: str, *, search_fn=None, fetch_fn=None, kb_fn=None, stream_fn=None, native_fn=None
):
    """Yield (event, data)，事件：plan / gathering / sources / writing / report / error.

    与 `tutor.say` 同一形态，路由只做 SSE 包装。任何一步的失败都变成一条人话的
    `error`，不留半句状态。
    """
    topic = (topic or "").strip()[:200]
    if not topic:
        yield "error", {"message": "话题不能为空"}
        return

    from app.core import providers

    model_id = providers.default_model_id() or ""
    if not model_id:
        yield "error", {"message": "没有已启用的 provider，请先在设置页配置模型"}
        return

    queries = await plan_queries(topic, model_id, stream_fn=stream_fn, native_fn=native_fn)
    if not queries:
        queries = [topic]
    yield "plan", {"queries": queries}

    yield "gathering", {}
    sources = await gather(
        topic, queries, search_fn=search_fn, fetch_fn=fetch_fn, kb_fn=kb_fn
    )
    if not sources:
        yield "error", {"message": "没取到任何材料——知识库没命中，联网也没结果"}
        return
    yield "sources", {
        "sources": [_public_source(s) for s in sources],
        "kb": sum(1 for s in sources if s.get("kind") == "kb"),
    }

    yield "writing", {}
    report = await synthesize(
        topic, sources, model_id, stream_fn=stream_fn, native_fn=native_fn
    )
    if report is None:
        yield "error", {"message": "成文失败——默认模型不可用，或输出无法解析"}
        return
    yield "report", {
        "title": report.title,
        "sections": [{"heading": s.heading, "body": s.body} for s in report.sections],
        "used": report.used,
        "sources": [_public_source(s) for s in sources],
        "model_id": model_id,
        "prompt_sha": _report.prompt_sha(_SYNTH_PROMPT),
    }
