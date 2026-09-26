"""提示词模块的三条 AI 能力：**生成 / 调优 / 提取变量**（参照 AI Gist）。

**为什么这三条提示词要登记**：本仓库的纪律是「运行时追加的也算一等提示词」——
它们同样在驱动模型行为，改一句就换产出。所以它们登记进 `core/prompts.py::_SPECS`，
由 `test_prompts.py` 的指纹盯住（改之前先想清楚为什么改）。

**三条都只产出文本，不落库**：写不写进库是人的决定。照 AI Gist 那句话——
「用之前，改一改」。

**纯函数与调用分开**：`_parse_*` 是纯的（不花钱、可直测），`_ask` 才是唯一碰模型的地方，
也是测试的注入缝。这个仓库的尺子都长这样：判据不靠模型跑。
"""
from __future__ import annotations

import json

GENERATE_SYSTEM = (
    "你在帮一个中文用户**起草一条可复用的提示词**。他给你一句粗糙的想法，"
    "你要交回一条能直接存进提示词库、以后反复用的提示词。\n"
    "\n"
    "要求：\n"
    "1. 用中文写，除非他明确要求别的语言；\n"
    "2. 把「每次都会变」的部分挖成 `{变量}`（花括号里放一个短中文名，如 {主题}、{读者}）；"
    "不要用双花括号、不要用 jinja 语法；\n"
    "3. 只出一条，不要给备选、不要加解释；\n"
    "4. title 是给人认的短名（不超过 12 个字），content 是能直接用的那一整段。\n"
    "\n"
    '只输出 JSON：{"title": "...", "content": "..."}'
)

REFINE_SYSTEM = (
    "你在帮一个中文用户**改一条已有的提示词**。他给你原文和一句修改要求。\n"
    "\n"
    "要求：\n"
    "1. **保住他原来的意图和语言**——这是在改他的东西，不是替他另写一条；\n"
    "2. 只按他说的那一句改，不要顺手加他没要的东西；\n"
    "3. 原有的 `{变量}` 要留着；若他要的是「提取变量」，把可挖空处换成 `{短中文名}`；\n"
    "4. 输出改完的**全文**，不要 diff、不要解释改了什么。\n"
    "\n"
    '只输出 JSON：{"content": "..."}'
)

EXTRACT_VARS_SYSTEM = (
    "你在读一条中文提示词，找出里面**每次用都会变**的那几处，把它们变成变量。\n"
    "\n"
    "只输出 JSON：{\"vars\": [\"变量名\", ...]}\n"
    "变量名要短、用中文、放进花括号里能读懂（如 主题 / 读者 / 字数）；"
    "**只列真正会变的**，固定不变的部分不是变量；一处都没有就返回空数组。"
)


# ---------- 纯函数：把模型的话读成结构 ----------


def _blob(text: str) -> object | None:
    """从模型输出里挖出 JSON。模型爱加代码围栏和客套话，先洗干净再读。"""
    from app.core.structured import clean_json

    cleaned = clean_json(text or "")
    if not cleaned:
        return None
    try:
        return json.loads(cleaned)
    except (ValueError, TypeError):
        return None


def parse_generate(text: str) -> dict:
    """`{"title", "content"}`。读不出来就抛——**别拿半截当成品**。"""
    data = _blob(text)
    if not isinstance(data, dict):
        raise ValueError("模型没有交回可用的提示词")
    title = str(data.get("title") or "").strip()[:100]
    content = str(data.get("content") or "").strip()
    if not content:
        raise ValueError("模型交回的提示词是空的")
    return {"title": title or content.strip().splitlines()[0][:100], "content": content}


def parse_refine(text: str) -> dict:
    data = _blob(text)
    if not isinstance(data, dict):
        raise ValueError("模型没有交回可用的提示词")
    content = str(data.get("content") or "").strip()
    if not content:
        raise ValueError("模型交回的提示词是空的")
    return {"content": content}


def parse_vars(text: str) -> list[str]:
    """变量名清单：去空、去重、保序、去掉花括号（模型有时会把括号一起写进来）。"""
    data = _blob(text)
    raw = data.get("vars") if isinstance(data, dict) else None
    if not isinstance(raw, list):
        return []
    out: list[str] = []
    for v in raw:
        name = str(v).strip().strip("{}").strip()
        if name and name not in out:
            out.append(name)
    return out


def vars_in(content: str) -> list[str]:
    """**本地的**变量扫描——与对话页 `/` 唤起用的是同一条正则（`App.tsx::applyPrompt`）。

    它存在的理由是「提取变量」要和「实际会被问到的变量」**对得上**：模型提了一批、
    可正则一个都不认，那用户填的时候根本不会被问到。所以它同时是**对照**也是**兜底**。
    """
    import re

    out: list[str] = []
    for m in re.finditer(r"\{([^{}\n]{1,30})\}", content or ""):
        name = m.group(1).strip()
        if name and name not in out:
            out.append(name)
    return out


# ---------- 调用（唯一碰模型的地方）----------


async def _ask(system: str, user: str) -> str:
    """一次非流式调用。**测试的注入缝就是这里**——monkeypatch 我，别去 mock 网络。"""
    from app.core.digest import _resolve_model_id

    model_id = _resolve_model_id()
    if not model_id:
        raise RuntimeError("还没有启用的模型——先去「设置 · 模型」里加一个")
    from app.routers.chat import resolve_model

    resolved = await resolve_model(model_id)
    p = resolved.provider
    from app.core.llm import ProviderInfo, stream_chat, structured_chat

    info = ProviderInfo(kind=p.kind, base_url=p.base_url, api_key=p.api_key)
    messages = [{"role": "system", "content": system}, {"role": "user", "content": user}]
    # 这三条都要 JSON：原生 JSON mode / tool_choice 优先，不支持再走普通流式
    native = await structured_chat(info, resolved.model, messages)
    if native is not None:
        return native
    return "".join([c async for c in stream_chat(info, resolved.model, messages)])


async def generate(idea: str) -> dict:
    idea = (idea or "").strip()
    if not idea:
        raise ValueError("先写一句你想要什么样的提示词")
    return parse_generate(await _ask(GENERATE_SYSTEM, idea))


async def refine(content: str, instruction: str) -> dict:
    content = (content or "").strip()
    if not content:
        raise ValueError("没有要改的正文")
    ask = (instruction or "").strip() or "让它更具体、更好用"
    return parse_refine(await _ask(REFINE_SYSTEM, f"[原文]\n{content}\n\n[要求]\n{ask}"))


async def extract_vars(content: str) -> list[str]:
    content = (content or "").strip()
    if not content:
        return []
    return parse_vars(await _ask(EXTRACT_VARS_SYSTEM, content))
