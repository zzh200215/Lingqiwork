"""学习闭环的中间两跳：研究（搜 → 读 → 对照你自己的材料）→ 产出（一篇带引用的讲解）。

方向的收尾判断：闭环的两头早已存在——「学」是 `core/tutor.py`，
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

护栏：拉取式——点它才跑；没有定时、没有队列、没有设置开关。
"""

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
from app.core import usage_ledger

log = logging.getLogger(__name__)

# 沿用旧路径的名字：路由用 `ResearchReport`/`Section`，测试用下面这些下划线开头的内部名。
# 脊梁搬去了 `core/report.py`，这里只是转出来。
__all__ = [
    "GapPlan",
    "QueryPlan",
    "Report",
    "ResearchReport",
    "Section",
    "_clean_report",
    "_format_sources",
    "_merge_sources",
    "_public_source",
    "_resolve",
    "_slug",
    "_trim_total",
    "assess_gaps",
    "gather",
    "plan_queries",
    "run",
    "save",
    "synthesize",
    "to_markdown",
]


RESEARCH_DIR = VAULT_DIR / "research"

PLAN_MAX_QUERIES = 4  # 首轮检索式条数上限
KB_TOP_K = 5  # 「对照你自己的材料」的检索宽度
FETCH_MAX = 5  # 每轮最多读几篇网页正文
SOURCE_CHARS = 2000  # 单条材料截断
TOTAL_CHARS = 20000  # 喂给成文的总量上限（自己材料优先，见 _trim_total）
MAX_ROUNDS = 3  # 最多搜几轮（含第一轮）。第 4 轮起边际收益几乎为零，只剩账单
GAP_MAX_QUERIES = 3  # 每轮补搜最多给几条新检索式

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

# 第二轮起：先看还缺什么，再决定要不要继续搜。这是「从固定四步变成真 loop」的那一步——
# 没有它，搜索就是一锤子买卖；有了它，「覆盖到哪个面、还缺哪个面」才是能被追问的东西。
_GAP_PROMPT = """你在判断一次研究的材料够不够。只输出一个 JSON 对象，不要任何解释：

{"missing": ["还缺什么"], "queries": ["下一轮检索式"], "enough": false}

硬要求：
1. `missing`：对着话题看材料，**哪几个面还没有材料覆盖**。只列真的缺的，别为了显得勤奋而凑数。
2. `queries`：针对这些缺口的新检索式，**和已经搜过的不能重复**——重复搜不会带回新东西。
   最多 3 条，每条都要能直接丢进检索框。
3. **材料已经覆盖得差不多就 `enough: true` 并把 queries 留空**——继续搜只会烧钱。
4. 话题很窄、该搜的已经搜完时，也 enough：搜不到就是搜不到，不要硬找。"""


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


class GapPlan(BaseModel):
    """还缺什么（第二轮起的判断）。字段宽松是有意的（同 `QueryPlan`）：一次抖动不该让
    整次研究失败——`queries` 空或 `enough` 为真都表示「够了，别再搜」。"""

    missing: list[str] = Field(default_factory=list)
    queries: list[str] = Field(default_factory=list)
    enough: bool = False

    @field_validator("queries", "missing", mode="before")
    @classmethod
    def _as_list(cls, v):
        if v is None:
            return []
        if isinstance(v, str):
            return re.split(r"[\n；;]+", v) if v.strip() else []
        if isinstance(v, (list, tuple)):
            return [str(x).strip() for x in v if x is not None and str(x).strip()]
        return []

    @field_validator("enough", mode="before")
    @classmethod
    def _as_bool(cls, v):
        if isinstance(v, str):
            return v.strip().lower() in ("true", "1", "yes", "是")
        return bool(v)


# ---------- step 1: plan ----------
# ---------- step 1: plan ----------


def _clean_queries(
    raw, topic: str = "", *, cap: int = PLAN_MAX_QUERIES, width: int = 80
) -> list[str]:
    """模型输出 → 干净的检索式/标签列表（去空白、去重、限长、限条数）。Pure."""
    out: list[str] = []
    seen: set[str] = set()
    for q in raw or []:
        q = re.sub(r"\s+", " ", str(q)).strip()[:width]
        key = q.lower()
        if not q or key in seen:
            continue
        seen.add(key)
        out.append(q)
        if len(out) >= cap:
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


def _gap_digest(sources: list[dict]) -> str:
    """给「还缺什么」那一步的材料摘要：只要**标题 + 来源 + 开头一小段**。Pure.

    判断「覆盖了哪几个面、还缺哪个面」看标题就够了。把整篇正文（最多两万字）再喂一遍
    既多花钱，又把判断淹在细节里。
    """
    blocks = []
    for s in sources:
        head = re.sub(r"\s+", " ", str(s.get("text") or "")).strip()[:200]
        kind = _report.kind_label(s.get("kind"))
        blocks.append(f"[{s.get('n')}]（{kind} · {s.get('ref', '')}）{s.get('title', '')}\n{head}")
    return "\n\n".join(blocks)


async def assess_gaps(
    topic: str, sources: list[dict], model_id: str = "", *, stream_fn=None, native_fn=None
) -> GapPlan | None:
    """对着已有的材料问「还缺什么」——第二轮起的那一步。

    **None 是「判断没跑成」，调用方据此停下**，不要瞎继续搜：没有判断还多搜一轮，就是拿
    钱换噪音。
    """
    topic = (topic or "").strip()
    if not topic or not sources:
        return None
    resolved = await _resolve(model_id)
    if resolved is None:
        return None
    info, model = resolved

    from app.core.structured import extract_json

    obj, meta = await extract_json(
        info,
        model,
        [
            {"role": "system", "content": _GAP_PROMPT},
            {
                "role": "user",
                "content": f"话题：{topic}\n\n已有的材料：\n{_gap_digest(sources)}",
            },
        ],
        GapPlan,
        stream_fn=stream_fn,
        native_fn=native_fn,
    )
    if obj is None:
        log.info("research gap assessment unavailable: %s", meta.error)
        return None
    return GapPlan(
        missing=_clean_queries(obj.missing, cap=6, width=40),
        queries=_clean_queries(obj.queries, cap=GAP_MAX_QUERIES),
        enough=bool(obj.enough),
    )


# ---------- step 2: gather ----------


async def _default_search(query: str) -> list[dict]:
    from app.core import mcp

    return await mcp.search_web(query)


async def _default_fetch(url: str) -> str:
    from app.core import mcp

    return await mcp._fetch_url({"url": url})


async def _default_kb(query: str, top_k: int) -> list[dict]:
    """引擎的「对照你自己的材料」：把话题多问几遍再检索。

    一次取材只走一次这条路，多一次便宜的改写调用换更全的回收，值得；改写失败会自己退回
    只搜原话。
    """
    from app.core import retriever

    return await retriever.deep_search(query, top_k)


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


async def _no_kb(query: str, top_k: int) -> list[dict]:
    """后几轮不再重复查自己的材料——第一轮已经按话题查过一次，同一话题再查一遍是白跑
    检索 + 重排。补的是外部材料。"""
    return []


def _merge_sources(existing: list[dict], more: list[dict]) -> tuple[list[dict], int]:
    """把新一轮里**没见过**的来源并进来，重新编号 → (合并结果, 真正新增的条数)。Pure.

    `added` 数的是**合并后仍在预算内**的新来源：`trim_total` 会先丢最后的 web 条，如果
    新来的当场就被预算吃掉，那这一轮等于没带回东西——那正是「信息饱和」的信号，不能
    当成有进展。
    """
    seen = {str(s.get("ref") or "") for s in existing}
    fresh = [s for s in more if (r := str(s.get("ref") or "")) and r not in seen]
    if not fresh:
        return existing, 0
    merged = [dict(s, n=i) for i, s in enumerate(_trim_total([*existing, *fresh]), 1)]
    kept = {str(s.get("ref") or "") for s in merged}
    return merged, sum(1 for s in fresh if str(s.get("ref") or "") in kept)


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


@usage_ledger.traced("research")
async def run(
    topic: str, *, search_fn=None, fetch_fn=None, kb_fn=None, stream_fn=None, native_fn=None
):
    """Yield (event, data)，事件：plan / gathering / sources / round / writing / report / error.

    与 `tutor.say` 同一形态，路由只做 SSE 包装。任何一步的失败都变成一条人话的
    `error`，不留半句状态。

    它是**一个 loop 而不是四步**：第一轮取完材料之后，每轮先问「还缺什么」，缺就再搜，
    直到模型说够了、或新一轮在预算内没带回新东西（信息饱和）、或到 `MAX_ROUNDS` 为止。
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
        "round": 1,
    }

    # 多轮补搜：发现缺口 → 再搜 → 直到模型说够了 / 新一轮在预算内没带回新东西 / 到上限。
    # 判断那步返回 None（没跑成）时**停**：没有判断还多搜一轮，就是拿钱换噪音。
    rounds = 1
    while rounds < MAX_ROUNDS:
        gaps = await assess_gaps(
            topic, sources, model_id, stream_fn=stream_fn, native_fn=native_fn
        )
        if gaps is None or gaps.enough or not gaps.queries:
            break
        yield "round", {"round": rounds + 1, "missing": gaps.missing, "queries": gaps.queries}
        more = await gather(
            topic, gaps.queries, search_fn=search_fn, fetch_fn=fetch_fn, kb_fn=_no_kb
        )
        sources, added = _merge_sources(sources, more)
        rounds += 1
        yield "sources", {
            "sources": [_public_source(s) for s in sources],
            "kb": sum(1 for s in sources if s.get("kind") == "kb"),
            "round": rounds,
            "added": added,
        }
        if added == 0:
            break  # 信息饱和：这一轮在预算内没带回新东西

    yield "writing", {}
    report = None
    async for _ev, _payload in _report.synthesize_streaming(
        topic,
        sources,
        _SYNTH_PROMPT,
        model_id,
        stream_fn=stream_fn,
        native_fn=native_fn,
        resolve_fn=_resolve,
    ):
        if _ev == "draft":
            yield "draft", _payload
        else:
            report = _payload
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
        "rounds": rounds,
    }
