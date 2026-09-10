"""结构化输出层：统一「模型输出 JSON」的提取、校验与降级。

9 处调用点（教学提取、记忆抽取、整理员合并、睡眠期反思、cron 解析、图谱
抽取、播客脚本、追问、评测）此前各自写一遍「prompt 要求 JSON → 贪婪正则 →
json.loads → 手工 .get → except 静默」。散落的补丁（去尾逗号、幻觉编号丢弃、
裸字符串兼容）说明这个套路一直在漏。这里把链路收成一条：

    L1 原生结构化（openai json_object / anthropic tool_choice）
      ↓ provider 不支持或校验失败
    L2 清洗提取（去代码块围栏 + 括号配对 + 去尾逗号 + Pydantic 校验）
      ↓ 仍失败
    L3 自纠正重试（把校验错误和原文喂回去一次，默认 1 次）

任何情况下都不抛异常：失败返回 (None, meta)，调用方保留原有的 best-effort 语义。
"""
import json
import logging
import re
from dataclasses import dataclass
from typing import Any

from pydantic import BaseModel

from app.core.llm import ProviderInfo, stream_chat, structured_chat

log = logging.getLogger(__name__)

# provider 不支持原生结构化时记一笔：避免每次都白试一次（本地模型常见）
_native_unsupported: set[str] = set()

_stats: dict[str, int] = {"native": 0, "cleaned": 0, "retried": 0, "failed": 0}

_FENCE_RE = re.compile(r"```(?:json|JSON)?\s*(.*?)```", re.S)
_TRAILING_COMMA_RE = re.compile(r",\s*([\]}])")

_CORRECT_TMPL = (
    "上次输出无法解析：{error}\n"
    "你的原始输出：\n{raw}\n\n"
    "请重新输出，严格遵守：只输出 JSON，不要代码块、不要解释、不要多余文字。"
)


@dataclass
class ExtractMeta:
    strategy: str = "failed"  # native | cleaned | retried | failed
    attempts: int = 0
    schema_ok: bool = False
    error: str = ""


def stats() -> dict:
    """给体检报告用：各策略命中多少次，让「静默失败」变成可见的降级。"""
    total = sum(_stats.values())
    return {
        **_stats,
        "total": total,
        "success_rate": round((total - _stats["failed"]) / total, 3) if total else 1.0,
    }


def _strip_fences(text: str) -> str:
    """去掉 ```json ... ``` 围栏；没有成对围栏时只清首尾零散的 ```。"""
    m = _FENCE_RE.search(text)
    if m:
        return m.group(1).strip()
    cleaned = re.sub(r"^\s*```(?:json|JSON)?\s*", "", text)
    return re.sub(r"\s*```\s*$", "", cleaned).strip()


def _balanced_slice(text: str, open_ch: str, close_ch: str) -> str | None:
    """从第一个 open_ch 起做括号配对，返回第一个完整闭合的片段。

    替代此前的贪婪正则 `\\{.*\\}`——它配 re.S 会一路吃到最后一个 `}`，
    模型带前言、或给了两段 JSON 时就会提取出无法解析的 blob。
    """
    start = text.find(open_ch)
    if start < 0:
        return None
    depth = 0
    in_str = False
    esc = False
    for i in range(start, len(text)):
        c = text[i]
        if in_str:
            if esc:
                esc = False
            elif c == "\\":
                esc = True
            elif c == '"':
                in_str = False
            continue
        if c == '"':
            in_str = True
        elif c == open_ch:
            depth += 1
        elif c == close_ch:
            depth -= 1
            if depth == 0:
                return text[start : i + 1]
    return None


def clean_json(text: str) -> str | None:
    """从模型输出里取出第一个完整 JSON 片段（对象或数组），并修掉尾逗号。"""
    if not text:
        return None
    t = _strip_fences(text)
    obj = _balanced_slice(t, "{", "}")
    arr = _balanced_slice(t, "[", "]")
    if obj and arr:
        cand = obj if t.index(obj) <= t.index(arr) else arr
    else:
        cand = obj or arr
    if not cand:
        return None
    return _TRAILING_COMMA_RE.sub(r"\1", cand)


def _loads(blob: str) -> Any | None:
    try:
        return json.loads(blob)
    except (ValueError, TypeError):
        return None


def _validate(schema: type[BaseModel], data: Any) -> BaseModel | None:
    """校验。两处宽容：

    1. 任何校验错误都返回 None（不抛），由调用方决定降级还是重试；
    2. 模型常直接给数组 `[{...}]`，而 anthropic 的 tool input_schema 必须是
       object，所以 schema 用 `items` 包一层——这里把数组根包进去再校验一次。
    """
    try:
        return schema.model_validate(data)
    except Exception:  # noqa: BLE001 - ValidationError 及任何意外都按「不可用」处理
        pass
    if isinstance(data, list) and "items" in schema.model_fields:
        try:
            return schema.model_validate({"items": data})
        except Exception:  # noqa: BLE001
            return None
    return None


async def extract_json(
    info: ProviderInfo,
    model: str,
    messages: list[dict],
    schema: type[BaseModel],
    *,
    max_retries: int = 1,
    stream_fn=None,
    native_fn=None,
) -> tuple[BaseModel | None, ExtractMeta]:
    """调模型拿结构化结果。永不抛异常：失败返回 (None, meta)。

    `messages` 沿用现有 {role, content} 结构，调用方不需要改自己的 prompt——
    提示词内容是校准过的，动它可能破坏已验证的抽取质量。

    `stream_fn` / `native_fn` 可注入：调用方把自己的 llm 引用传进来，就能
    保住原有的测试 mock seam（例如 memory.auto_extract 此前被 monkeypatch 的
    是 `memory.stream_chat`，若这里直接用本模块的引用，那些测试会失效）。
    """
    meta = ExtractMeta()
    json_schema = schema.model_json_schema()
    key = f"{info.kind}|{info.base_url}"
    _stream = stream_fn or stream_chat
    # 调用方注入 stream_fn 通常是为了接管模型调用（测试 mock seam）。这时不再
    # 另走原生通道，否则注入会被绕过、测试会打到真实网络。
    _native = native_fn or (structured_chat if stream_fn is None else None)

    raw = ""
    last_err = ""

    # ---- L1 原生结构化 ----
    if _native is not None and key not in _native_unsupported:
        native = await _native(info, model, messages, json_schema=json_schema)
        meta.attempts += 1
        if native is None:
            _native_unsupported.add(key)
            log.info("native structured unavailable for %s, falling back to prompt+clean", key)
        else:
            raw = native
            obj = _validate(schema, _loads(native))
            if obj is not None:
                _stats["native"] += 1
                meta.strategy, meta.schema_ok = "native", True
                return obj, meta
            last_err = "原生输出未通过 schema 校验"

    # ---- L2 清洗提取 / L3 自纠正重试 ----
    for attempt in range(max_retries + 1):
        if not (attempt == 0 and raw):
            # attempt 0 且 L1 已拿到文本时就地清洗，不重复调模型
            msgs = list(messages)
            if attempt > 0:
                msgs.append(
                    {
                        "role": "user",
                        "content": _CORRECT_TMPL.format(error=last_err, raw=raw[:800]),
                    }
                )
            try:
                raw = "".join([c async for c in _stream(info, model, msgs)])
            except Exception as e:  # noqa: BLE001 - 上游故障按失败计，不向上抛
                meta.attempts += 1
                last_err = f"{type(e).__name__}: {e}"
                raw = ""
                continue
            meta.attempts += 1

        blob = clean_json(raw)
        if not blob:
            last_err = "输出里没有找到 JSON"
            continue
        data = _loads(blob)
        if data is None:
            last_err = "JSON 解析失败"
            continue
        obj = _validate(schema, data)
        if obj is None:
            last_err = "schema 校验失败"
            continue

        _stats["retried" if attempt else "cleaned"] += 1
        meta.strategy = "retried" if attempt else "cleaned"
        meta.schema_ok = True
        return obj, meta

    _stats["failed"] += 1
    meta.strategy = "failed"
    meta.error = last_err or "无输出"
    return None, meta
