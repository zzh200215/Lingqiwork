"""分析 / 方案层：把一个「拿不准的事」理成一份可复用的方案。

三条已有链路的差别在这里最清楚：`research` 向外求真（这件事是什么）、`compose` 向内
整合（我攒了什么）、`recap` 向后看（我最近在干什么）。这条是**向前**——给一个不确定的
选择，摆开选项、指出判据、给一个有条件的倾向。

**它凭什么比直接问模型强**：一个通用助手不知道你的约束。而你自己的知识库与长期记忆里
恰好存着那些约束（在跑什么、在意什么、踩过什么坑）。所以取材三路是「你的材料 + 你的
约束 + 外部事实」，判据那一节必须带着 [编号] 引到你自己的记录。

**形状上唯一的新东西是 `frame` 事件**：先把「我理解你要决定的是 X，要比的是 A / B / C」
摆出来给用户看。理错题是这类功能第一位的失败模式，而研究那套管线里 plan 只在内部用；
这里它必须是**给人看的**——看一眼就知道题有没有被读懂。

产物落 `vault/decisions/`，进索引后教学的取材块与研究的知识库路都能自动捞到它——
一次决定因此能在几个月后被回想起来（「上次我是怎么权衡的」）。

护栏：拉取式——点它才跑；没有定时、没有队列、没有设置开关。
和复盘不同，这里的建议是**要的**（用户就是来要方案的），但它必须是**有条件的倾向 +
什么会推翻它**，不是一句「你应该……」。

形状来自共用脊梁 `core/report.py`（第四个消费者）。
"""

import logging
import re

from pydantic import BaseModel, Field, field_validator

from app.config import VAULT_DIR
from app.core import report as _report
from app.core.report import (
    Report,
    Section,
    maybe_await as _maybe,
    public_source as _public_source,
    resolve as _resolve,
    to_markdown,
)
from app.core import usage_ledger

log = logging.getLogger(__name__)

DECISIONS_DIR = VAULT_DIR / "decisions"

QUERIES_MAX = 4  # 检索式条数上限
OPTIONS_MAX = 4  # 最多摆几个选项
CRITERIA_MAX = 5  # 最多几条判据
KB_TOP_K = 4  # 「你自己怎么看」的检索宽度
FETCH_MAX = 4  # 最多读几篇网页正文
MEMORY_MAX_CHARS = 2500  # 长期记忆合成的单条材料上限
SOURCE_CHARS = 2000  # 单条材料截断
TOTAL_CHARS = 16000  # 喂给成文的总量上限（自己材料优先，见 trim_total）

# 第一步：把话题读成一次决策。**选项必须补全**——用户只说了 A，也要把现实中会跟 A 比
# 的 B、C 摆出来，否则「帮你选」就退化成「帮你确认 A 挺好」。判据要求具体到能左右结果，
# 是因为「好不好」这种谁都能说的判据对选型毫无帮助。
_FRAME_PROMPT = """你在帮用户把一个「拿不准的事」理清楚。先做一件事：把这个话题读成一次决策。
只输出一个 JSON 对象，不要任何解释：

{"decision": "他到底要决定什么（一句话）",
 "options": ["选项A", "选项B"],
 "criteria": ["判据1", "判据2"],
 "queries": ["检索式1", "检索式2"]}

硬要求：
1. `decision`：重述成一句「要不要 / 选哪个」。话题本身就是一个问题时，照原样理清即可。
2. `options`：2-4 个**真正的备选**。用户只提到 A 时，也要把现实中会拿来跟 A 比的 B、C
   摆出来——只给一个选项等于没帮他选。每个选项 2-12 个字，是能并列比较的东西。
3. `criteria`：3-5 条**真正会左右结果**的判据（成本、迁移代价、可控性、可逆性、你熟不熟……）。
   不要写「好不好」「适不适合」这种谁都能说的空话。
4. `queries`：2-4 个互补检索式，用来查两样东西——**他自己对这件事的看法与约束**，以及
   **各个选项的事实**。每句都要能直接丢进检索框，不要写「研究一下」这种没有信息量的开头。"""

# 第二步：成文。四节固定——就是「帮我理清楚再出方案」这句话本身拆开的四问。
_SYNTH_PROMPT = """你在帮用户把一个「拿不准的事」理成一份方案。材料里既有他自己的记录（知识库、
长期记忆、日记），也有外部事实。只输出一个 JSON 对象，不要任何解释：

{"title": "方案标题", "sections": [{"heading": "到底在决定什么", "body": "正文"}], "used": [1, 2]}

硬要求：
1. 只依据材料写。材料里没有的事实不要编；某条判据材料覆盖不到，就直说「这一点材料里没有，
   需要你自己确认」——不要用常识把它填满。
2. **固定四节，按这个顺序**：`到底在决定什么` / `几个选项` / `我的判断` / `什么会推翻它`。
3. 第一节：把要决定的事说清楚，并指出**哪些约束绑住了他**（来自他的记录，带引用）。
4. 第二节：逐个摆开选项——每个选项适合什么、代价是什么。**不要只夸一个**，
   也不要为了中立把三个都夸一遍。
5. 第三节：给出**有条件的倾向**——「如果你更看重 X，选 A；如果 Y 是硬约束，那就 B」。
   允许说不确定，但不许谁也不选。这是给本人看的判断，不是免责声明。
6. 第四节：什么情况下这个判断会翻转、动手之前值得先验证哪一件事。
7. 每个论断用 [编号] 标出来源，例如「你之前更在意可控性 [3]」。
8. `used` 列出你真正引用到的材料编号，升序，去重。"""

__all__ = [
    "CRITERIA_MAX",
    "DECISIONS_DIR",
    "DecisionFrame",
    "OPTIONS_MAX",
    "QUERIES_MAX",
    "Report",
    "Section",
    "frame_decision",
    "gather",
    "run",
    "save",
    "to_markdown",
]


# ---------- structured output shapes ----------


class DecisionFrame(BaseModel):
    """模型的「读题」结果。字段宽松是有意的（同 `report.Report`）：一次抖动不该让整次
    运行失败——`decision` 空就退回话题本身，选项/判据空只是这一节薄一点。"""

    decision: str = ""
    options: list[str] = Field(default_factory=list)
    criteria: list[str] = Field(default_factory=list)
    queries: list[str] = Field(default_factory=list)

    @field_validator("decision", mode="before")
    @classmethod
    def _text(cls, v):
        if v is None or isinstance(v, (list, dict)):
            return ""
        return str(v).strip()

    @field_validator("options", "criteria", "queries", mode="before")
    @classmethod
    def _list(cls, v):
        if v is None:
            return []
        if isinstance(v, str):
            return [x for x in re.split(r"[\n；;]+", v) if x.strip()]
        if isinstance(v, (list, tuple)):
            return [x for x in v if x is not None and str(x).strip()]
        return []


# ---------- 清洗（模型输出的文本 → 干净的列表）。Pure. ----------


def _clean_list(raw, cap: int, width: int = 0) -> list[str]:
    """去空白、去重、限长、限条数的通用清洗。Pure."""
    out: list[str] = []
    seen: set[str] = set()
    for x in raw or []:
        s = re.sub(r"\s+", " ", str(x)).strip()
        if width:
            s = s[:width]
        key = s.lower()
        if not s or key in seen:
            continue
        seen.add(key)
        out.append(s)
        if len(out) >= cap:
            break
    return out


# ---------- step 1: frame ----------


async def frame_decision(
    topic: str, model_id: str = "", *, stream_fn=None, native_fn=None
) -> DecisionFrame | None:
    """一次结构化调用 → 读题结果（None 表示不可用，调用方退回把话题当决策）。"""
    topic = (topic or "").strip()
    if not topic:
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
            {"role": "system", "content": _FRAME_PROMPT},
            {"role": "user", "content": f"话题：{topic}"},
        ],
        DecisionFrame,
        stream_fn=stream_fn,
        native_fn=native_fn,
    )
    if obj is None:
        log.info("decide frame unavailable: %s", meta.error)
        return None
    return DecisionFrame(
        decision=re.sub(r"\s+", " ", obj.decision).strip()[:120],
        options=_clean_list(obj.options, OPTIONS_MAX, 40),
        criteria=_clean_list(obj.criteria, CRITERIA_MAX, 60),
        queries=_clean_list(obj.queries, QUERIES_MAX, 80),
    )


# ---------- step 2: gather ----------


async def _default_kb(query: str, top_k: int) -> list[dict]:
    """引擎的「对照你自己的材料」：把话题多问几遍再检索。"""
    from app.core import retriever

    return await retriever.deep_search(query, top_k)


async def _default_memory(query: str) -> str:
    from app.core import memory

    return await memory.format_memories(query)


async def _default_search(query: str) -> list[dict]:
    from app.core import mcp

    return await mcp.search_web(query)


async def _default_fetch(url: str) -> str:
    from app.core import mcp

    return await mcp._fetch_url({"url": url})


def _trim_total(sources: list[dict]) -> list[dict]:
    """总量封顶（自己的材料优先）。读模块全局 `TOTAL_CHARS`——测试会 patch 它。"""
    return _report.trim_total(sources, TOTAL_CHARS)


async def gather(
    decision: str,
    queries: list[str],
    *,
    kb_fn=None,
    memory_fn=None,
    search_fn=None,
    fetch_fn=None,
) -> list[dict]:
    """三路 → 带编号的来源 [{n, kind, title, ref, text}]。

    顺序即读起来的顺序，也是 `trim_total` 丢东西的逆序：**你的材料 → 你的约束 → 外部事实**。
    三路各自 best-effort：哪一路挂了只是这一路变薄，不抛异常——「有没有材料」由调用方
    （`run`）决定怎么处理。
    """
    kb_fn = kb_fn or _default_kb
    memory_fn = memory_fn or _default_memory
    search_fn = search_fn or _default_search
    fetch_fn = fetch_fn or _default_fetch

    raw: list[dict] = []

    # 1) 知识库：你自己写过/收过的东西——上一版方案、踩过的坑、别人的经验
    try:
        for h in await kb_fn(decision, KB_TOP_K) or []:
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
    except Exception:  # noqa: BLE001 - 知识库挂了只是没有这一路
        log.warning("decide kb gather failed", exc_info=True)

    # 2) 长期记忆：你稳定的事实与偏好——这一条才是「比通用助手强」的地方
    try:
        mem = str(await _maybe(memory_fn(decision)) or "").strip()
        if mem:
            raw.append(
                {"kind": "memory", "title": "长期记忆", "ref": "", "text": mem[:MEMORY_MAX_CHARS]}
            )
    except Exception:  # noqa: BLE001 - 记忆挂了只是没有这一路
        log.warning("decide memory gather failed", exc_info=True)

    # 3) 网络：各选项的事实（你有什么能力、代价多大），材料里不一定有
    seen_urls: set[str] = set()
    hits: list[dict] = []
    for q in queries or [decision]:
        try:
            found = await search_fn(q)
        except Exception:  # noqa: BLE001 - 一个检索式失败不影响其余
            log.warning("decide web search failed: %s", q, exc_info=True)
            continue
        for h in found or []:
            url = str(h.get("url") or "").strip()
            if not url or url in seen_urls:
                continue
            seen_urls.add(url)
            hits.append({"title": str(h.get("title") or "").strip(), "url": url})

    for h in hits[:FETCH_MAX]:
        try:
            text = str(await fetch_fn(h["url"]) or "").strip()
        except Exception:  # noqa: BLE001 - 一篇打不开就跳过
            log.warning("decide fetch failed: %s", h["url"], exc_info=True)
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


# ---------- step 3: save ----------


async def save(rep: Report, sources: list[dict]) -> dict:
    """落 `vault/decisions/` 并进索引——「上次我是怎么权衡的」靠的就是这里。"""
    return await _report.save(rep, sources, DECISIONS_DIR, "方案")


# ---------- orchestration ----------


@usage_ledger.traced("decide")
async def run(
    topic: str,
    *,
    kb_fn=None,
    memory_fn=None,
    search_fn=None,
    fetch_fn=None,
    stream_fn=None,
    native_fn=None,
):
    """Yield (event, data)：framing / frame / gathering / sources / writing / report / error.

    比 research 多一步 `framing` → `frame`，而且 `frame` 是**发给前端的**：读错题是这类
    功能第一位的失败模式，所以「我理解你要决定的是什么」必须在成文之前就摆给用户看。
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

    yield "framing", {}
    frame = await frame_decision(topic, model_id, stream_fn=stream_fn, native_fn=native_fn)
    if frame is None or not frame.decision:
        # 读题失败不该毁掉整次运行：退回把话题本身当决策，检索式退回话题
        frame = DecisionFrame(decision=topic, queries=[topic])
    yield "frame", {
        "decision": frame.decision,
        "options": frame.options,
        "criteria": frame.criteria,
    }

    yield "gathering", {}
    sources = await gather(
        frame.decision,
        frame.queries,
        kb_fn=kb_fn,
        memory_fn=memory_fn,
        search_fn=search_fn,
        fetch_fn=fetch_fn,
    )
    if not sources:
        yield "error", {"message": "没取到任何材料——知识库没命中，联网也没结果"}
        return
    yield "sources", {
        "sources": [_public_source(s) for s in sources],
        "kb": sum(1 for s in sources if s.get("kind") == "kb"),
        "web": sum(1 for s in sources if s.get("kind") == "web"),
    }

    yield "writing", {}
    rep = None
    async for _ev, _payload in _report.synthesize_streaming(
        frame.decision,
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
            rep = _payload
    if rep is None:
        yield "error", {"message": "成文失败——默认模型不可用，或输出无法解析"}
        return
    yield "report", {
        "title": rep.title,
        "sections": [{"heading": s.heading, "body": s.body} for s in rep.sections],
        "used": rep.used,
        "sources": [_public_source(s) for s in sources],
        "model_id": model_id,
        "prompt_sha": _report.prompt_sha(_SYNTH_PROMPT),
        "frame": {
            "decision": frame.decision,
            "options": frame.options,
            "criteria": frame.criteria,
        },
    }
