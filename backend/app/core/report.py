"""带引用的结构化文档产出：研究（向外）与产出（向内）共用的脊梁。

体裁无关——只负责形状：模型输出 → 结构化 `Report` → 带 `[n]` 引用的 markdown →
落 vault + 进索引。**提示词与取材由调用方给**（research 搜网、compose 读你自己的
材料），这里不决定写什么、也不决定材料从哪来。

从 `research.py` 机械搬移而来，行为逐字节不变：`test_research.py` 的 20 例是这次
搬移的安全网。唯一新增的是三个缝：`synthesize` 的 `system_prompt` / `resolve_fn`
入参与 `save` 的 `dest_dir`——正是「两种体裁共用同一套形状」所必需的那点参数化。

成文有两条入口：`synthesize`（一次拿全，含原生结构化）与 `synthesize_streaming`
（**流式优先**，边收边发半截报告给前端；解析不了才退回前者）。报告是整条链里最长
的一段生成，四个引擎共用这条脊梁，所以这一处改动四个都受益。
"""

import asyncio
import hashlib
import inspect
import logging
import re
from datetime import datetime
from pathlib import Path

from pydantic import BaseModel, Field, field_validator

from app.config import VAULT_DIR

log = logging.getLogger(__name__)

_PARTIAL_EVERY = 24  # 每攒够这么多字符才重解一次半截 JSON（整体重解是 O(n)，别每个 chunk 都来）
_DRAIN_TICK = 0.1  # 等下一个 draft 的轮询间隔；生成结束到最后一帧之间最多晚这么久

# 来源种类 → 中文标签（材料块与文末「来源」清单共用）
_KIND_LABELS = {
    "kb": "知识库",
    "web": "网络",
    "memory": "记忆",
    "journal": "日记",
    "belief": "信念线",
    "teach": "学习画像",
    "stuck": "卡点",
    "files": "最近动的文件",
}


def kind_label(kind: str) -> str:
    return _KIND_LABELS.get(str(kind), str(kind) or "材料")


async def maybe_await(value):
    """取值口既可能给同步结果也可能给 awaitable（日记/文件两路默认是同步的）。"""
    return await value if inspect.isawaitable(value) else value


def prompt_sha(text: str) -> str:
    """提示词指纹（sha256 前 12 位）——与 `core/prompts.py` 同一个算法。

    它是质量闭环的 join key：评价按 (kind, prompt_sha, model_id) 聚合，所以提示词
    一改，新旧版本的满意率自然分开统计，不用人工记"这版是哪个"。
    """
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:12]


# ---------- structured output shapes ----------


class Section(BaseModel):
    heading: str = ""
    body: str = ""

    @field_validator("heading", "body", mode="before")
    @classmethod
    def _as_text(cls, v):
        if v is None or isinstance(v, (list, dict)):
            return ""
        return str(v).strip()


class Report(BaseModel):
    """字段宽松是有意的（同 `tutor.TutorExtract`）：一次模型抖动不该丢掉整条记录。

    类型不对一律当空/丢弃，由 `clean_report` 与调用方决定降级——产物是给人看的，
    少一节比整个失败划算。
    """

    title: str = ""
    sections: list[Section] = Field(default_factory=list)
    used: list[int] = Field(default_factory=list)

    @field_validator("title", mode="before")
    @classmethod
    def _title_text(cls, v):
        if v is None or isinstance(v, (list, dict)):
            return ""
        return str(v).strip()

    @field_validator("sections", mode="before")
    @classmethod
    def _sections_list(cls, v):
        # `mode="before"` 收到的是原始输入：既可能是模型给的 dict 列表，也可能是
        # 代码里已经构造好的 `Section` 实例（`clean_report` 就是这么重建的）——
        # 两者都要放行，只丢真正无用的东西（字符串、数字）。
        if v is None:
            return []
        if isinstance(v, (dict, BaseModel)):
            return [v]
        if isinstance(v, (list, tuple)):
            return [x for x in v if isinstance(x, (dict, BaseModel))]
        return []

    @field_validator("used", mode="before")
    @classmethod
    def _used_ints(cls, v):
        if v is None:
            return []
        if not isinstance(v, (list, tuple)):
            v = [v]
        out: list[int] = []
        for x in v:
            try:
                out.append(int(x))
            except (TypeError, ValueError):
                continue
        return out


# ---------- pure helpers ----------


def trim_total(sources: list[dict], budget: int) -> list[dict]:
    """总量封顶：网络条从后往前丢，仍超就按比例截断剩下的（自己的材料优先）。Pure."""
    def total(items: list[dict]) -> int:
        return sum(len(s.get("text") or "") for s in items)

    kept = [dict(s) for s in sources]
    while total(kept) > budget:
        idx = next(
            (i for i in range(len(kept) - 1, -1, -1) if kept[i].get("kind") == "web"), None
        )
        if idx is None:
            break
        kept.pop(idx)
    over = total(kept) - budget
    if over > 0 and kept:
        ratio = budget / total(kept)
        for s in kept:
            text = s.get("text") or ""
            s["text"] = text[: max(1, int(len(text) * ratio))]
    return kept


def format_sources(sources: list[dict]) -> str:
    """来源 → 给成文调用的材料块。Pure."""
    blocks = []
    for s in sources:
        label = kind_label(s.get("kind"))
        blocks.append(f"[{s['n']}]（{label} · {s.get('ref', '')}）{s.get('title', '')}\n{s.get('text', '')}")
    return "\n\n".join(blocks)


def clean_report(obj: Report) -> Report:
    """按段裁剪、丢弃空段。引用编号的有效性由 synthesize 按 sources 过滤。Pure."""
    sections = [
        Section(heading=s.heading[:80], body=s.body[:4000]) for s in obj.sections if s.body.strip()
    ]
    return Report(title=obj.title[:120].strip(), sections=sections, used=list(obj.used))


def slug(text: str, fallback: str = "report") -> str:
    s = re.sub(r"[^\w一-鿿-]+", "-", text or "")[:24].strip("-")
    return s or fallback


def to_markdown(report: Report, sources: list[dict], fallback_title: str = "研究笔记") -> str:
    """报告 + 来源 → 一篇 md（自己写的格式自己读）。Pure."""
    lines = [f"# {report.title or fallback_title}", ""]
    for sec in report.sections:
        lines.append(f"## {sec.heading}")
        lines.append("")
        lines.append(sec.body)
        lines.append("")
    if sources:
        used = set(report.used)
        lines.append("## 来源")
        lines.append("")
        for s in sources:
            mark = " ✓" if s.get("n") in used else ""
            ref = s.get("ref", "")
            origin = kind_label(s.get("kind"))
            lines.append(f"{s.get('n')}. {s.get('title', '')} — {ref}（{origin}）{mark}")
        lines.append("")
    return "\n".join(lines)


def public_source(s: dict) -> dict:
    """来源 → 发给前端的形状（不带正文，正文只在服务端成文用）。"""
    return {"n": s.get("n"), "kind": s.get("kind"), "title": s.get("title", ""), "ref": s.get("ref", "")}


# ---------- model resolution (same shape as tutor._extract) ----------


async def resolve(model_id: str = ""):
    """默认 provider → (ProviderInfo, model)；解析不了返回 None。

    用单个 provider + `structured.extract_json` 的三级降级。产出是一次拉取式动作，
    模型挂了在开流之前就被路由拦下（PLAN 第 9 节）。
    """
    from app.core import providers
    from app.core.llm import ProviderInfo
    from app.routers.chat import resolve_model

    mid = (model_id or "").strip() or (providers.default_model_id() or "")
    if not mid:
        return None
    try:
        resolved = await resolve_model(mid)
    except Exception:  # noqa: BLE001 - 解析不了就当没有可用模型
        log.warning("report resolve_model failed for %r", mid, exc_info=True)
        return None
    p = resolved.provider
    return ProviderInfo(kind=p.kind, base_url=p.base_url, api_key=p.api_key), resolved.model


# ---------- synthesize / save ----------


async def synthesize(
    topic: str,
    sources: list[dict],
    system_prompt: str,
    model_id: str = "",
    *,
    stream_fn=None,
    native_fn=None,
    resolve_fn=None,
    extra_user: str = "",
) -> Report | None:
    """材料 → 带引用的成文（None 表示模型不可用或输出解析不了）。

    `system_prompt` 决定写什么（研究讲网上的、产出整合你自己的）；调用方可以传
    `resolve_fn` 覆盖模型解析（测试缝，也让两个引擎各自钉住自己的 provider 策略）。
    """
    if not sources:
        return None
    resolve_fn = resolve_fn or resolve
    resolved = await resolve_fn(model_id)
    if resolved is None:
        return None
    info, model = resolved
    obj = await _extract(
        info, model, _messages(topic, sources, system_prompt, extra_user), stream_fn, native_fn
    )
    return _finalize(obj, sources) if obj is not None else None


def _messages(
    topic: str, sources: list[dict], system_prompt: str, extra_user: str = ""
) -> list[dict]:
    user = f"话题：{topic}\n\n材料：\n{format_sources(sources)}"
    # `extra_user` 是给「对质」那种**先跑一步小调用、再把结论喂给写手**的引擎用的
    # （它得知道哪几处已经被判定为冲突）。默认空串，另外四个引擎的字节不变。
    if extra_user:
        user += f"\n\n{extra_user}"
    return [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": user},
    ]


def _finalize(obj: Report, sources: list[dict]) -> Report | None:
    """引用编号过滤 + 空段裁剪——流式与非流式两个入口共用，结果必须一致。"""
    valid = {s["n"] for s in sources}
    report = clean_report(obj)
    report.used = sorted({int(u) for u in report.used if isinstance(u, int) and u in valid})
    return report if report.sections else None


async def _extract(info, model, messages, stream_fn, native_fn) -> Report | None:
    """非流式那一路（含 L1 原生结构化）——也是流式失败后的兜底。"""
    from app.core.structured import extract_json

    obj, meta = await extract_json(
        info, model, messages, Report, stream_fn=stream_fn, native_fn=native_fn
    )
    if obj is None:
        log.info("report synthesis unavailable: %s", meta.error)
    return obj


def partial_sections(obj) -> dict:
    """模型的半截对象 → 发前端的 draft 形状（只留 title 与 sections）。Pure."""
    if not isinstance(obj, dict):
        return {"title": "", "sections": []}
    raw = obj.get("sections")
    sections = []
    for s in raw if isinstance(raw, list) else []:
        if isinstance(s, dict):
            sections.append(
                {"heading": str(s.get("heading") or ""), "body": str(s.get("body") or "")}
            )
    return {"title": str(obj.get("title") or ""), "sections": sections}


async def _stream_report(info, model, messages, stream_fn, on_partial) -> Report | None:
    """流式跑一遍：边收边把**半截**报告交出去，收完再按完整解析。

    解析不了就返回 None——调用方会退回 `_extract`（原生结构化那条路），
    所以流式只是让画面早一点动起来，**不承担正确性**。
    """
    from app.core.llm import stream_chat
    from app.core.structured import clean_json, partial_json

    _stream = stream_fn or stream_chat
    buf: list[str] = []
    sent = 0
    try:
        async for chunk in _stream(info, model, messages):
            buf.append(chunk)
            text = "".join(buf)
            if len(text) - sent < _PARTIAL_EVERY:
                continue  # 每来一点点就整体重解一次太浪费；攒够一段再解
            sent = len(text)
            part = partial_json(text)
            if part is not None:
                draft = partial_sections(part)
                # 还没出第一节就别发：只有一个半截标题的帧渲染出来是「闪一下」，没有信息量
                if draft["sections"]:
                    on_partial(draft)
    except Exception:  # noqa: BLE001 - 上游故障 → 交给调用方退回非流式
        log.warning("report stream pass failed, falling back", exc_info=True)
        return None

    blob = clean_json("".join(buf))
    if not blob:
        return None
    try:
        return Report.model_validate_json(blob)
    except Exception:  # noqa: BLE001
        return None


async def synthesize_streaming(
    topic: str,
    sources: list[dict],
    system_prompt: str,
    model_id: str = "",
    *,
    stream_fn=None,
    native_fn=None,
    resolve_fn=None,
    extra_user: str = "",
):
    """`synthesize` 的流式版：先 yield ("draft", {title, sections}) 若干次，最后 ("done", Report|None)。

    为什么要先流一遍：报告是整条链里最长的一段生成，此前「转圈 → 整篇蹦出来」，
    而这四个引擎共用这一条脊梁。**流式那遍不承担正确性**——它解析不了、或上游中途
    抛错，就原样退回 `synthesize` 的老路（含原生结构化），代价只是失败时多一次调用。
    """
    if not sources:
        yield "done", None
        return
    resolve_fn = resolve_fn or resolve
    resolved = await resolve_fn(model_id)
    if resolved is None:
        yield "done", None
        return
    info, model = resolved
    messages = _messages(topic, sources, system_prompt, extra_user)

    # 回调不能 yield，所以走队列：生成在 task 里跑，draft 从这里漏出去。
    queue: asyncio.Queue = asyncio.Queue()
    task = asyncio.create_task(_stream_report(info, model, messages, stream_fn, queue.put_nowait))
    try:
        while not task.done():
            try:
                yield "draft", await asyncio.wait_for(queue.get(), timeout=_DRAIN_TICK)
            except asyncio.TimeoutError:
                continue
        while not queue.empty():
            yield "draft", queue.get_nowait()
        obj = task.result()
    finally:
        # 前端断开时生成器被提前关掉，别把还在跑的模型调用漏在后面
        if not task.done():
            task.cancel()

    if obj is None:
        obj = await _extract(info, model, messages, stream_fn, native_fn)
    yield "done", (_finalize(obj, sources) if obj is not None else None)


async def save(
    report: Report, sources: list[dict], dest_dir: Path, fallback_title: str = "研究笔记"
) -> dict:
    """落 `dest_dir` 并进索引——「下次先捞你自己的」那一跳靠的就是这里。"""
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest = dest_dir / f"{datetime.now():%Y-%m-%d}-{slug(report.title, dest_dir.name)}.md"
    dest.write_text(to_markdown(report, sources, fallback_title), encoding="utf-8")

    from app.core import indexer

    chunks = await asyncio.to_thread(indexer.index_file, dest)
    return {
        "filename": dest.relative_to(VAULT_DIR).as_posix(),
        "title": report.title,
        "chunks": chunks,
    }
