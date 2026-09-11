"""跨源冲突检测「对质」：把你自己的说法和外部来源摆在一起，指出哪两处对不上。

四条已有链路的方位各不同：`research` 向外求真（这件事是什么）、`compose` 向内整合（我攒了
什么）、`recap` 向后看（我最近在干什么）、`decide` 向前（我该怎么选）。这条是**横向**——
不问「是什么」，问「这些材料彼此对不对得上」。PLAN §10.3 把它标成「从仓储升级成顾问的
分界线，市面上基本空白」。

**它凭什么比直接问模型强**：矛盾的其中一侧往往是你自己的记录（上次的结论、当时踩的坑），
通用助手看不到那一侧。所以取材是「你的材料 + 你的记忆 + 外部来源」，判定必须带两侧的 [编号]。

**形状上唯一的新东西是 `finding` 事件**：取材之后、成文之前先跑一次**结构化冲突扫描**。
两个作用：① 把「哪两处对不上」变成确定性的结构（标尺可查）；② **零冲突时直接停**——不必
再烧一次长篇成文去说「没找到」。这和 decide 的 `frame` 是同一个手法：先做一步小调用，再
决定要不要做那步大的。

产物落 `vault/conflicts/`，**手动存**（读错题时不往库里塞废报告）。进索引后教学的取材块与
研究的知识库路都能捞到它——「上次发现这两处对不上」因此会被想起来。

护栏（PLAN.md 第 2 节）：拉取式、话题驱动；没有定时扫描、没有「共 N 处」的常驻计数、没有
未读标记——不积累成欠账。有冲突就报，没有就直说没有。

形状来自共用脊梁 `core/report.py`（第五个消费者）。
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

log = logging.getLogger(__name__)

CONFLICTS_DIR = VAULT_DIR / "conflicts"

QUERIES_MAX = 4  # 检索式条数上限
PAIRS_MAX = 4  # 最多报几处冲突（报太多会稀释，也不该变成一张清单）
KB_TOP_K = 4  # 「你自己怎么说」的检索宽度
FETCH_MAX = 4  # 最多读几篇网页正文
MEMORY_MAX_CHARS = 2500  # 长期记忆合成的单条材料上限
SOURCE_CHARS = 2000  # 单条材料截断
TOTAL_CHARS = 16000  # 喂给成文的总量上限（自己的材料优先，见 trim_total）

# 第一步：把话题读成一次「对质」。只读题，不下结论——结论留给扫描那步，这里只负责
# 把「要比的是什么」摆正（读错题是这类功能第一位的失败模式，所以它要发给前端看）。
_FRAME_PROMPT = """你在帮用户做一次「跨源对质」：把他自己的说法和外部来源摆在一起，看哪两处对不上。
先做一件事：把这个话题读成一次对质。只输出一个 JSON 对象，不要任何解释：

{"subject": "要比的是什么（一句话，落到一个具体的主张上）",
 "queries": ["检索式1", "检索式2"]}

硬要求：
1. `subject`：重述成一个**可以被证真或证伪的具体主张**（例：「协程挂起后由谁恢复执行」）。
   话题太笼统（「聊聊异步」）时，收敛到一个最可能藏着分歧的点上，不要原样抄回来。
2. `queries`：2-4 个互补检索式，用来查两样东西——**他自己对这件事的说法**，以及
   **外部来源对同一件事的说法**。每句都要能直接丢进检索框，不要写「研究一下」这种没有信息量的开头。"""

# 第二步：冲突扫描。这是全库此前没有的那块——「N 条论断两两对质」。判分笔法照
# `engine_eval.judge_grounded`（只问材料内的事实，不问文笔）。**允许返回空**是这里的重点：
# 硬凑出来的「冲突」会把「从仓储升级成顾问」这件事做回成噪音。
_FIND_PROMPT = """你在做跨源对质：给一批带编号的材料，找出其中**真正互相矛盾**的地方。
只输出一个 JSON 对象，不要任何解释：

{"pairs": [{"a_n": 1, "b_n": 3, "basis": "一句话说清哪一点对不上"}]}

硬要求：
1. 只有**不能同时为真**的两条才算冲突。说法不同但可以并存（不同场景、不同版本、一个更细）
   不算；只是用词不同不算；一个说「A 更好」另一个说「B 更好」而没有共同判据，不算。
2. 优先报**用户自己的材料**与**外部来源**之间的矛盾——那是通用助手看不到的一侧，
   也是这次对质最值钱的地方。其次是外部来源之间、以及他自己的记录之间。
3. `a_n` / `b_n` 必须是材料里真实出现过的编号，且 `a_n < b_n`。不要引用不存在的编号。
4. **没有冲突就返回 {"pairs": []}**。这是正常结果，不要为了有东西可写而硬凑。
5. 每处冲突只报一次，不要换个说法重复报。最多报 4 处，按「有多确定」排序。"""

# 第三步：成文。每节 = 一处冲突，固定三件事：两侧原句 + 为什么不能同时为真 + 什么能定案。
_SYNTH_PROMPT = """你在写一份「跨源对质」报告。材料里既有用户自己的记录（知识库、长期记忆），
也有外部来源。只输出一个 JSON 对象，不要任何解释：

{"title": "对质标题", "sections": [{"heading": "谁和谁、在什么上对不上", "body": "正文"}], "used": [1, 3]}

硬要求：
1. 只依据材料写。**每处冲突单独成节**，按下面「已确认对不上的地方」里给的成对编号来写，
   不要自己另找、也不要漏。那一节没提到的地方不必写成小节。
2. 小节正文固定三件事，按这个顺序：
   a) **两侧各自的原句**，各带自己的 [编号]——只写「一边说 X」而不引原句等于没对质；
   b) **为什么不能同时为真**（是哪一条具体主张撞上了哪一条）；
   c) **什么能定案**——一件能做的验证、或一个需要用户确认的事实。材料给不出就说
      「材料里看不出谁对，需要你自己验证」，不要用常识替它裁决。
3. **不许下「谁对谁错」的结论**，除非材料本身给了依据（有依据就明说依据在哪条 [编号]）。
4. 每个论断用 [编号] 标出来源，例如「你 8 月的笔记里写的是… [2]」。
5. `used` 列出你真正引用到的材料编号，升序，去重。"""

__all__ = [
    "CONFLICTS_DIR",
    "ConflictFrame",
    "ConflictPair",
    "ConflictScan",
    "PAIRS_MAX",
    "QUERIES_MAX",
    "Report",
    "Section",
    "find_conflicts",
    "frame_confrontation",
    "gather",
    "run",
    "save",
    "to_markdown",
]


# ---------- structured output shapes ----------


class ConflictFrame(BaseModel):
    """读题结果。字段宽松是有意的（同 `report.Report`）：一次抖动不该让整次运行失败——
    `subject` 空就退回话题本身，检索式空就退回话题。"""

    subject: str = ""
    queries: list[str] = Field(default_factory=list)

    @field_validator("subject", mode="before")
    @classmethod
    def _text(cls, v):
        if v is None or isinstance(v, (list, dict)):
            return ""
        return str(v).strip()

    @field_validator("queries", mode="before")
    @classmethod
    def _list(cls, v):
        if v is None:
            return []
        if isinstance(v, str):
            return [x for x in re.split(r"[\n；;]+", v) if x.strip()]
        if isinstance(v, (list, tuple)):
            return [x for x in v if x is not None and str(x).strip()]
        return []


class ConflictPair(BaseModel):
    a_n: int = 0
    b_n: int = 0
    basis: str = ""

    @field_validator("a_n", "b_n", mode="before")
    @classmethod
    def _int(cls, v):
        try:
            return int(v)
        except (TypeError, ValueError):
            return 0

    @field_validator("basis", mode="before")
    @classmethod
    def _text(cls, v):
        if v is None or isinstance(v, (list, dict)):
            return ""
        return str(v).strip()


class ConflictScan(BaseModel):
    """冲突扫描的输出。空列表是**正常结果**（材料里就是没有对不上的）。"""

    pairs: list[ConflictPair] = Field(default_factory=list)

    @field_validator("pairs", mode="before")
    @classmethod
    def _pairs(cls, v):
        if v is None:
            return []
        if isinstance(v, (dict, BaseModel)):
            return [v]
        if isinstance(v, (list, tuple)):
            return [x for x in v if isinstance(x, (dict, BaseModel))]
        return []


# ---------- 清洗（模型输出 → 干净的编号对）。Pure. ----------


def _clean_list(raw, cap: int, width: int = 0) -> list[str]:
    """去空白、去重、限长、限条数。Pure."""
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


def clean_pairs(raw, valid: set[int], cap: int = PAIRS_MAX) -> list[dict]:
    """编号对清洗：两侧都必须在材料里、去自环、a<b 归一、去重、限条数。Pure.

    编号越界的对直接丢掉——引用一个不存在的来源，报告里会变成一句指不到东西的指控。
    """
    out: list[dict] = []
    seen: set[tuple[int, int]] = set()
    for p in raw or []:
        a, b = int(getattr(p, "a_n", 0) or 0), int(getattr(p, "b_n", 0) or 0)
        if a == b or a not in valid or b not in valid:
            continue
        lo, hi = (a, b) if a < b else (b, a)
        if (lo, hi) in seen:
            continue
        seen.add((lo, hi))
        out.append(
            {"a_n": lo, "b_n": hi, "basis": re.sub(r"\s+", " ", str(getattr(p, "basis", ""))).strip()[:120]}
        )
        if len(out) >= cap:
            break
    return out


def _pairs_block(pairs: list[dict], sources: list[dict]) -> str:
    """已确认的冲突对 → 喂给写手的一段（它照着这个逐节写，不再自己找）。Pure."""
    by_n = {s.get("n"): s for s in sources}

    def label(s: dict) -> str:
        kind = _report.kind_label(s.get("kind"))
        return f"[{s.get('n')}]（{kind}·{s.get('ref', '')}）{s.get('title', '')}"

    lines = ["已确认对不上的地方（每一对单独成节，按这里的编号来写）："]
    for p in pairs:
        a, b = by_n.get(p["a_n"], {}), by_n.get(p["b_n"], {})
        lines.append(f"- {label(a)} 与 {label(b)} 对不上：{p['basis']}")
    return "\n".join(lines)


# ---------- step 1: frame ----------


async def frame_confrontation(
    topic: str, model_id: str = "", *, stream_fn=None, native_fn=None
) -> ConflictFrame | None:
    """一次结构化调用 → 读题结果（None 表示不可用，调用方退回把话题当对质主题）。"""
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
        ConflictFrame,
        stream_fn=stream_fn,
        native_fn=native_fn,
    )
    if obj is None:
        log.info("conflict frame unavailable: %s", meta.error)
        return None
    return ConflictFrame(
        subject=re.sub(r"\s+", " ", obj.subject).strip()[:120],
        queries=_clean_list(obj.queries, QUERIES_MAX, 80),
    )


# ---------- step 2: gather ----------


async def _default_kb(query: str, top_k: int) -> list[dict]:
    """引擎的「对照你自己的材料」：把话题多问几遍再检索（PLAN §10.2「检索」）。"""
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
    subject: str,
    queries: list[str],
    *,
    kb_fn=None,
    memory_fn=None,
    search_fn=None,
    fetch_fn=None,
) -> list[dict]:
    """三路 → 带编号的来源 [{n, kind, title, ref, text}]。

    顺序即读起来的顺序，也是 `trim_total` 丢东西的逆序：**你的材料 → 你的记忆 → 外部来源**。
    三路各自 best-effort：哪一路挂了只是这一路变薄，不抛异常——「有没有材料」由调用方
    （`run`）决定怎么处理。
    """
    kb_fn = kb_fn or _default_kb
    memory_fn = memory_fn or _default_memory
    search_fn = search_fn or _default_search
    fetch_fn = fetch_fn or _default_fetch

    raw: list[dict] = []

    # 1) 知识库：你写过/收过的东西——上次的结论、当时踩的坑。对质的一侧常常就在这
    try:
        for h in await kb_fn(subject, KB_TOP_K) or []:
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
        log.warning("conflict kb gather failed", exc_info=True)

    # 2) 长期记忆：你稳定的事实与偏好——和笔记撞上时，那是最该被指出的一种对不上
    try:
        mem = str(await _maybe(memory_fn(subject)) or "").strip()
        if mem:
            raw.append(
                {"kind": "memory", "title": "长期记忆", "ref": "", "text": mem[:MEMORY_MAX_CHARS]}
            )
    except Exception:  # noqa: BLE001 - 记忆挂了只是没有这一路
        log.warning("conflict memory gather failed", exc_info=True)

    # 3) 外部来源：对质的另一侧。没有它，薄库上几乎无话可说（见 PLAN 第 3 节）
    seen_urls: set[str] = set()
    hits: list[dict] = []
    for q in queries or [subject]:
        try:
            found = await search_fn(q)
        except Exception:  # noqa: BLE001 - 一个检索式失败不影响其余
            log.warning("conflict web search failed: %s", q, exc_info=True)
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
            log.warning("conflict fetch failed: %s", h["url"], exc_info=True)
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


# ---------- step 3: find ----------


async def find_conflicts(
    subject: str,
    sources: list[dict],
    model_id: str = "",
    *,
    stream_fn=None,
    native_fn=None,
) -> list[dict] | None:
    """结构化冲突扫描 → [{a_n, b_n, basis}]。

    **返回 `None` 和返回 `[]` 是两件事**：`None` = 扫描没跑成（模型不可用/解析不了），
    调用方应当**继续成文**（不能因为一次判分失败就谎报「没有冲突」）；`[]` = 扫描跑成了、
    材料里确实没有对不上的，调用方据此停下，省掉一次长篇成文。
    """
    if not sources:
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
            {"role": "system", "content": _FIND_PROMPT},
            {"role": "user", "content": f"话题：{subject}\n\n材料：\n{_report.format_sources(sources)}"},
        ],
        ConflictScan,
        stream_fn=stream_fn,
        native_fn=native_fn,
    )
    if obj is None:
        log.info("conflict scan unavailable: %s", meta.error)
        return None
    return clean_pairs(obj.pairs, {s["n"] for s in sources})


# ---------- step 4: save ----------


async def save(rep: Report, sources: list[dict]) -> dict:
    """落 `vault/conflicts/` 并进索引——「上次发现这两处对不上」靠的就是这里。"""
    return await _report.save(rep, sources, CONFLICTS_DIR, "对质")


# ---------- orchestration ----------


def _no_conflict_report(subject: str) -> Report:
    """零冲突时的产物：一句实话，不是一份凑出来的报告。"""
    return Report(
        title=f"没有对不上的：{subject}"[:120],
        sections=[
            Section(
                heading="这批材料里没找到互相矛盾的论断",
                body=(
                    "按你这次给的话题取的这些材料，彼此并不冲突——要更严格地查，"
                    "可以让话题更具体一些（落到一个能被证真或证伪的主张上），或者先把相关材料收进库里。"
                ),
            )
        ],
        used=[],
    )


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
    """Yield (event, data)：framing / frame / gathering / sources / finding / writing / draft / report / error。

    `frame` 和 decide 一样是**发给前端**的：读错题是这类功能第一位的失败模式，所以「我理解
    要比的是什么」必须在取材之前就摆出来看。
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
    frame = await frame_confrontation(topic, model_id, stream_fn=stream_fn, native_fn=native_fn)
    if frame is None or not frame.subject:
        # 读题失败不该毁掉整次运行：退回把话题本身当要比的东西
        frame = ConflictFrame(subject=topic, queries=[topic])
    yield "frame", {"subject": frame.subject, "queries": frame.queries}

    yield "gathering", {}
    sources = await gather(
        frame.subject,
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

    yield "finding", {}
    pairs = await find_conflicts(frame.subject, sources, model_id, stream_fn=stream_fn, native_fn=native_fn)

    # 扫出来了、而且一处都没有 → 直接给结论，不烧那一次长篇成文
    if pairs == []:
        rep = _no_conflict_report(frame.subject)
        yield "report", {
            "title": rep.title,
            "sections": [{"heading": s.heading, "body": s.body} for s in rep.sections],
            "used": [],
            "sources": [_public_source(s) for s in sources],
            "model_id": model_id,
            "prompt_sha": _report.prompt_sha(_FIND_PROMPT),
            "subject": frame.subject,
            "pairs": [],
        }
        return

    # pairs 非空 = 有几处要对质；pairs 是 None = 扫描没跑成，照旧成文（写手自己找）
    yield "writing", {}
    rep = None
    async for _ev, _payload in _report.synthesize_streaming(
        frame.subject,
        sources,
        _SYNTH_PROMPT,
        model_id,
        stream_fn=stream_fn,
        native_fn=native_fn,
        resolve_fn=_resolve,
        extra_user=_pairs_block(pairs, sources) if pairs else "",
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
        "subject": frame.subject,
        "pairs": pairs or [],
    }
