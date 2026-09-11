"""复盘层：把散落的记录合成一次「最近」。

三块记录各管一摊——`memory_tidy.reflect` 管记忆域、`digest` 管文件域、
`beliefs.threads` 管信念线、`tutor.profile` / `stuck_blocks` 管教学域——但没有一处
能回答「最近我在关注什么、学到哪、卡在哪」。唯一的跨域综合（`tutor._future_dossier`）
是每轮注入的上下文，从不作为产出出现。这里就让它成为产出。

形状来自共用脊梁 `core/report.py`（research 向外、compose 向内、recap 向后看）。
产物落 `vault/recap/YYYY-MM-DD.md`——**一天一份、重跑即刷新**（同 digest），进索引后
教学的取材块与研究的知识库路都能自动捞到它。

护栏（PLAN 第 2 节）：拉取式——点它才跑；**复盘是镜子，不是任务清单**，所以提示词
明令禁止「建议下一步」。没有定时、没有开关。
"""

import asyncio
import logging
from datetime import datetime

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

RECAP_DIR = VAULT_DIR / "recap"

DAYS = 30  # 「最近」的窗口。不用 14：以稀疏的使用密度，两周窗经常是空的
STUCK_CAP = 8  # 最多带几条卡点
JOURNAL_ITEMS = 10
CHANGE_FILES = 20  # 最近动过的文件最多列几个
SOURCE_CHARS = 2000  # 单条材料截断
TOTAL_CHARS = 12000  # 喂给成文的总量上限

# 三段固定，正好回答计划里那三个问题。**不写建议**——第 2 节：任何机制一旦产生
# 「欠着没做」的感觉就是滑回上一版了；一给建议，这面镜子就变成了任务清单。
_SYNTH_PROMPT = """你在给用户写一篇他自己的「最近」，材料全部来自他自己的记录。只输出一个 JSON 对象，不要任何解释：

{"title": "最近", "sections": [{"heading": "最近在关注什么", "body": "正文"}], "used": [1, 2]}

硬要求：
1. 只依据材料写。材料里没有的不要推测、不要补充常识、不要脑补他的生活。
2. **固定三段，按这个顺序**：`最近在关注什么` / `学到哪` / `卡在哪`。
   某一段的材料不足以写，就直说「这段时间这块没什么记录」——不要为了凑满而泛泛而谈。
3. 每个论断后面用 [编号] 标出它来自哪条材料，例如「……这条线跨了两周 [2]」。
4. **不要写建议、不要写下一步、不要催促、不要评价他做得怎么样。**
   这是给他自己看的一面镜子，不是任务清单，也不是成绩单。
5. 语气平实，像把他自己的记录读给他听。每段 3-6 句。
6. `used` 列出你真正引用到的材料编号，升序，去重。"""

__all__ = [
    "DAYS",
    "RECAP_DIR",
    "Report",
    "Section",
    "gather_recent",
    "run",
    "save",
    "to_markdown",
]


# ---------- 四路取材：取值口（默认真实实现，测试注入假的） ----------


async def _default_profile() -> dict:
    from app.core import tutor

    return await tutor.profile()


async def _default_stuck(days: int) -> list:
    from app.core import tutor

    return await tutor.stuck_blocks(days, STUCK_CAP)


async def _default_beliefs() -> list:
    from app.core import beliefs

    return await beliefs.threads()


def _default_journal(limit: int) -> list:
    from app.core import journal

    return journal.recent(limit)


def _default_changes(days: int) -> list:
    from app.core import digest

    return digest.collect_recent_changes(days)


# ---------- 四路渲染：值 → 给人读的文本（纯函数，好测） ----------


def _short(iso) -> str:
    return str(iso or "")[:10]


def _render_threads(threads) -> str:
    """信念线 → 一行一条（这条主张最先怎么说的 → 最近怎么说的）。Pure."""
    out = []
    for t in threads or []:
        items = "；".join(str(i.get("content") or "").strip() for i in (t.get("items") or []))
        label = str(t.get("label") or "").strip()
        if not label and not items:
            continue
        out.append(f"- {label}（{_short(t.get('first_at'))} → {_short(t.get('last_at'))}）：{items}")
    return "\n".join(out)


def _render_profile(prof) -> str:
    """学习画像 → 说通 / 半懂两行。Pure."""
    prof = prof or {}
    lines = []
    if prof.get("known"):
        lines.append("说通过的：" + "、".join(prof["known"]))
    if prof.get("half"):
        lines.append("还是半懂的：" + "、".join(prof["half"]))
    return "\n".join(lines)


def _render_stuck(blocks) -> str:
    """卡点 → 一行一条（标题：当时卡在哪）。Pure."""
    out = []
    for item in blocks or []:
        try:
            title, text = item
        except (TypeError, ValueError):
            continue
        title, text = str(title or "").strip(), str(text or "").strip()
        if title or text:
            out.append(f"- {title}：{text}")
    return "\n".join(out)


def _render_journal(entries) -> str:
    """日记 → 一行一条（日期 时间 正文）。Pure."""
    out = []
    for e in entries or []:
        if not isinstance(e, dict):
            continue
        text = str(e.get("text") or "").strip()
        if not text:
            continue
        stamp = f"{e.get('date', '')} {e.get('time', '')}".strip()
        out.append(f"- {stamp} {text}".strip())
    return "\n".join(out)


def _render_changes(paths) -> str:
    """最近动过的文件 → 一行一个（只列路径与日期）。Pure.

    刻意不取正文：正文 digest 已经消化过一遍，复盘看的是「最近在动什么」，不是内容。
    """
    out = []
    for p in paths or []:
        try:
            rel = p.relative_to(VAULT_DIR).as_posix()
            stamp = datetime.fromtimestamp(p.stat().st_mtime).strftime("%m-%d")
        except (OSError, ValueError):
            continue
        out.append(f"- {rel}（{stamp}）")
    return "\n".join(out)


# ---------- gather ----------


async def gather_recent(
    *,
    days: int = DAYS,
    profile_fn=None,
    stuck_fn=None,
    beliefs_fn=None,
    journal_fn=None,
    changes_fn=None,
) -> list[dict]:
    """四路记录 → 带编号的来源 [{n, kind, title, ref, text}]。

    每路 best-effort：挂了只是这条路变薄，不抛异常——「有没有记录」由调用方（`run`）
    决定怎么处理。顺序即读起来的顺序：先看关注什么，再看学到哪，最后卡在哪。
    """
    raw: list[dict] = []

    async def leg(kind: str, title: str, fn, render) -> None:
        try:
            text = (render(await _maybe(fn())) or "").strip()
        except Exception:  # noqa: BLE001 - 一路挂了不该毁掉整次复盘
            log.warning("recap leg failed: %s", kind, exc_info=True)
            return
        if text:
            raw.append({"kind": kind, "title": title, "ref": "", "text": text[:SOURCE_CHARS]})

    await leg("belief", "信念线（同一条主张随时间的说法）", beliefs_fn or _default_beliefs, _render_threads)
    await leg("journal", "近期日记", lambda: (journal_fn or _default_journal)(JOURNAL_ITEMS), _render_journal)
    await leg("files", "最近动过的文件", lambda: (changes_fn or _default_changes)(days), _render_changes)
    await leg("teach", "学习画像（说通 / 半懂）", profile_fn or _default_profile, _render_profile)
    await leg("stuck", "最近卡过的点", lambda: (stuck_fn or _default_stuck)(days), _render_stuck)

    return [dict(s, n=i) for i, s in enumerate(_report.trim_total(raw, TOTAL_CHARS), 1)]


# ---------- save ----------


async def save(rep: Report, sources: list[dict]) -> dict:
    """落 `vault/recap/YYYY-MM-DD.md` 并进索引——一天一份，重跑即刷新。"""
    RECAP_DIR.mkdir(parents=True, exist_ok=True)
    dest = RECAP_DIR / f"{datetime.now():%Y-%m-%d}.md"
    dest.write_text(to_markdown(rep, sources, "复盘"), encoding="utf-8")

    from app.core import indexer

    chunks = await asyncio.to_thread(indexer.index_file, dest)
    return {
        "filename": dest.relative_to(VAULT_DIR).as_posix(),
        "title": rep.title,
        "chunks": chunks,
    }


# ---------- orchestration ----------


async def run(*, days: int = DAYS, stream_fn=None, native_fn=None, **gather_kw):
    """Yield (event, data)：gathering / sources / writing / report / saved / error.

    成文后**自己落盘并索引**再发 `saved`——复盘没有「先看再决定存不存」的环节，
    内容就是你自己的记录。
    """
    from app.core import providers

    model_id = providers.default_model_id() or ""
    if not model_id:
        yield "error", {"message": "没有已启用的 provider，请先在设置页配置模型"}
        return

    yield "gathering", {}
    sources = await gather_recent(days=days, **gather_kw)
    if not sources:
        yield "error", {"message": "这段时间没什么记录可复盘——先攒一点（教学、日记、剪藏都算）"}
        return
    yield "sources", {"sources": [_public_source(s) for s in sources], "n": len(sources)}

    yield "writing", {}
    rep = None
    async for _ev, _payload in _report.synthesize_streaming(
        f"最近 {days} 天",
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

    yield "saved", await save(rep, sources)
