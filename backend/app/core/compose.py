"""产出引擎：从你自己的材料（知识库 + 长期记忆 + 近期日记）整合出一篇文档。

与研究的分工：`core/research.py` **向外**（搜网、抓网页正文），这里**向内**（你自己的
累积）。两者共用 `core/report.py` 的脊梁——结构化 `Report` → 带 `[编号]` 的 md →
落 vault + 进索引；区别只在取材方向与提示词。

产物落 `vault/notes/`：笔记页（`routers/notes.py`，它的 root 就是整个 vault）能直接
打开编辑；watcher 索引后，教学的取材块（`tutor._retrieve → indexer.search_auto`）与
研究的知识库路都能自动捞到它——**回路零新代码**。这是 PLAN.md 北极星的出口那一半：
学是入口，产出是出口。

护栏（PLAN.md 第 2 节）：拉取式——点它才跑；没有定时、没有队列、没有设置开关。
"""

import logging

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

COMPOSE_DIR = VAULT_DIR / "notes"

KB_TOP_K = 6  # 知识库检索宽度
MEMORY_MAX_CHARS = 3000  # 长期记忆合成的单条材料上限
JOURNAL_ITEMS = 8  # 取最近几条日记
SOURCE_CHARS = 2000  # 单条材料截断
TOTAL_CHARS = 16000  # 喂给成文的总量上限（trim_total 按比例截断，无非网络条可丢）

# 研究那条提示词管「少讲网上的、只讲材料里的」；这条管「只讲**你自己**的」，
# 并且明确允许「你的材料里还没有」——产出不是检索失败，薄弱就说薄弱。
_SYNTH_PROMPT = """你在把用户**自己积累的材料**整理成一篇给他看的笔记。只输出一个 JSON 对象，不要任何解释：

{"title": "笔记标题", "sections": [{"heading": "小节标题", "body": "正文"}], "used": [1, 3]}

硬要求：
1. 只依据下面给的材料写——它们来自用户自己的知识库、长期记忆与日记。材料里没有的
   不要写，也不要补充你自己的记忆或网上常识。
2. 每个论断后面用 [编号] 标出它来自哪条材料，例如「……多数情况够用 [2]」。
3. 材料薄弱时别硬凑：直接写一句「你的材料里暂时还没有这部分」。这是诚实的整理，
   不是缺陷，也不要用泛泛而谈把它填满。
4. `used` 列出你真正引用到的材料编号，升序，去重。
5. 2-4 个小节，每节正文 3-6 句。这是给本人看的整理，写清楚比写全重要。
6. 材料之间冲突时，把冲突说出来，不要挑一个当事实。"""

__all__ = [
    "COMPOSE_DIR",
    "Report",
    "Section",
    "gather_inward",
    "run",
    "save",
    "to_markdown",
]


# ---------- gather (inward) ----------


async def _default_kb(query: str, top_k: int) -> list[dict]:
    """引擎的「对照你自己的材料」：把话题多问几遍再检索（PLAN §10.2「检索」）。"""
    from app.core import retriever

    return await retriever.deep_search(query, top_k)


async def _default_memory(query: str) -> str:
    from app.core import memory

    return await memory.format_memories(query)


def _default_journal(limit: int) -> list[dict]:
    from app.core import journal

    return journal.recent(limit)


async def gather_inward(
    topic: str, *, kb_fn=None, memory_fn=None, journal_fn=None
) -> list[dict]:
    """你自己的材料 → 带编号的来源 [{n, kind, title, ref, text}]。

    三路各自 best-effort：任何一路挂了只是这条路变薄，不抛异常——「有没有材料」由
    调用方（`run`）决定怎么处理。顺序即优先级：知识库在前（最像成品），记忆与日记殿后。
    """
    kb_fn = kb_fn or _default_kb
    memory_fn = memory_fn or _default_memory
    journal_fn = journal_fn or _default_journal

    raw: list[dict] = []

    # 1) 知识库：已索引的一切（notes / research / repos / clippings / journal …）
    try:
        for h in await kb_fn(topic, KB_TOP_K) or []:
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
        log.warning("compose kb gather failed", exc_info=True)

    # 2) 长期记忆：合成一条（本就是一段整理过的文字，不必拆行）
    try:
        mem = str(await _maybe(memory_fn(topic)) or "").strip()
        if mem:
            raw.append(
                {
                    "kind": "memory",
                    "title": "长期记忆",
                    "ref": "",
                    "text": mem[:MEMORY_MAX_CHARS],
                }
            )
    except Exception:  # noqa: BLE001 - 记忆挂了只是没有这一路
        log.warning("compose memory gather failed", exc_info=True)

    # 3) 近期日记：按日期时间顺序拼成一整条
    try:
        entries = await _maybe(journal_fn(JOURNAL_ITEMS)) or []
        lines = [
            f"{e.get('date', '')} {e.get('time', '')} {e.get('text', '')}".strip()
            for e in entries
            if isinstance(e, dict)
        ]
        body = "\n".join(x for x in lines if x)
        if body:
            raw.append(
                {
                    "kind": "journal",
                    "title": "近期日记",
                    "ref": "",
                    "text": body[:SOURCE_CHARS],
                }
            )
    except Exception:  # noqa: BLE001 - 日记挂了只是没有这一路
        log.warning("compose journal gather failed", exc_info=True)

    return [dict(s, n=i) for i, s in enumerate(_report.trim_total(raw, TOTAL_CHARS), 1)]


# ---------- save ----------


async def save(rep: Report, sources: list[dict]) -> dict:
    """落 `vault/notes/` 并进索引——产出物因此能被下一次取材捞回来。"""
    return await _report.save(rep, sources, COMPOSE_DIR, "笔记")


# ---------- orchestration ----------


@usage_ledger.traced("compose")
async def run(
    topic: str, *, kb_fn=None, memory_fn=None, journal_fn=None, stream_fn=None, native_fn=None
):
    """Yield (event, data)，事件：gathering / sources / writing / report / error.

    与 `research.run` 同一形态（少一步 `plan`——产出不规划检索式，话题直接取自你），
    路由只做 SSE 包装。任何一步的失败都变成一条人话的 `error`，不留半句状态。
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

    yield "gathering", {}
    sources = await gather_inward(
        topic, kb_fn=kb_fn, memory_fn=memory_fn, journal_fn=journal_fn
    )
    if not sources:
        yield "error", {"message": "你自己的材料里没找到相关内容——先往知识库或日记里放点东西"}
        return
    yield "sources", {
        "sources": [_public_source(s) for s in sources],
        "kb": sum(1 for s in sources if s.get("kind") == "kb"),
    }

    yield "writing", {}
    rep = None
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
    }
