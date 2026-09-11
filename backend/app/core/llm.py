"""LLM gateway over OpenAI-compatible + Anthropic APIs, with tool calling.

`run_agentic_chat` drives the tool loop:
  model -> (text | tool_calls) -> execute tools -> feed results back -> repeat
until the model answers without tools, or the round budget is exhausted.

OpenAI-compatible protocol covers openai/deepseek/qwen/moonshot/ollama/
openrouter — same client, different base_url.
"""
import asyncio
import json
import logging
from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import dataclass

from anthropic import AsyncAnthropic
from openai import AsyncOpenAI

log = logging.getLogger(__name__)

MAX_TOOL_ROUNDS = 6


def _flatten_tool_spec(spec: dict) -> dict:
    """OpenAI wrapped spec -> anthropic flat spec."""
    if "function" in spec:
        fn = spec["function"]
        return {
            "name": fn["name"],
            "description": fn.get("description", ""),
            "input_schema": fn.get("parameters") or {"type": "object", "properties": {}},
        }
    return {
        "name": spec["name"],
        "description": spec.get("description", ""),
        "input_schema": spec.get("parameters") or {"type": "object", "properties": {}},
    }


@dataclass
class ProviderInfo:
    kind: str  # "openai" | "anthropic"
    base_url: str
    api_key: str


@dataclass
class ToolCall:
    id: str
    name: str
    arguments: dict


def _openai_client(p: ProviderInfo) -> AsyncOpenAI:
    return AsyncOpenAI(base_url=p.base_url or None, api_key=p.api_key or "sk-noop")


# ---------- one model round (streaming) ----------


def _absorb_usage(usage_out: dict | None, raw, model: str = "") -> None:
    """Merge a provider usage object into the caller's accumulator.

    调用方**没有自己的账本**时（除了聊天与定时任务，其余路径都是这样），用量记进
    `core/usage_ledger` 的当前 span。`note()` 在 span 外是空操作，所以那两条自己有列的
    路径绝不会被重复记一次。
    """
    if raw is None:
        return
    try:
        tin = int(
            getattr(raw, "input_tokens", 0) or getattr(raw, "prompt_tokens", 0) or 0
        )
        tout = int(
            getattr(raw, "output_tokens", 0) or getattr(raw, "completion_tokens", 0) or 0
        )
    except (TypeError, ValueError):
        return
    if usage_out is not None:
        usage_out["input"] = usage_out.get("input", 0) + tin
        usage_out["output"] = usage_out.get("output", 0) + tout
        return
    from app.core import usage_ledger

    usage_ledger.note(model, tin, tout)


async def _openai_round(
    client: AsyncOpenAI,
    model: str,
    messages: list[dict],
    tools: list[dict] | None,
    emit_text: Callable[[str], None],
    usage_out: dict | None = None,
) -> tuple[str, list[ToolCall]]:
    """One model round: stream text via emit_text; return (text, tool_calls)."""
    kwargs: dict = dict(model=model, messages=messages, tools=tools or None, stream=True)
    from app.core import usage_ledger

    # 有账本要填才要 usage：兼容流式响应默认不回 usage 字段
    if usage_out is not None or usage_ledger.active():
        kwargs["stream_options"] = {"include_usage": True}
    try:
        stream = await client.chat.completions.create(**kwargs)
    except Exception:
        if "stream_options" in kwargs:  # provider rejects the param — retry plain
            kwargs.pop("stream_options")
            stream = await client.chat.completions.create(**kwargs)
        else:
            raise
    calls_by_index: dict[int, dict] = {}
    text_parts: list[str] = []
    finish_reason = None

    try:
        async for chunk in stream:
            _absorb_usage(usage_out, getattr(chunk, "usage", None), model)
            if not chunk.choices:
                continue
            choice = chunk.choices[0]
            finish_reason = choice.finish_reason
            delta = choice.delta
            if delta is None:
                continue
            if delta.content:
                text_parts.append(delta.content)
                emit_text(delta.content)
            if delta.tool_calls:
                for tc in delta.tool_calls:
                    if tc.index is None:
                        continue
                    acc = calls_by_index.setdefault(tc.index, {"id": "", "name": "", "args": ""})
                    if tc.id:
                        acc["id"] = tc.id
                    if tc.function and tc.function.name:
                        acc["name"] += tc.function.name
                    if tc.function and tc.function.arguments:
                        acc["args"] += tc.function.arguments
    finally:
        await stream.close()

    calls: list[ToolCall] = []
    if finish_reason == "tool_calls":
        for idx in sorted(calls_by_index):
            tc = calls_by_index[idx]
            if not tc["name"]:
                continue
            try:
                args = json.loads(tc["args"] or "{}")
            except json.JSONDecodeError:
                args = {}
            calls.append(ToolCall(id=tc["id"] or f"call_{idx}", name=tc["name"], arguments=args))
        text_parts = []  # tool turns may carry stray pre-text — drop it
    return "".join(text_parts), calls


async def _anthropic_round(
    client: AsyncAnthropic,
    model: str,
    messages: list[dict],
    tools: list[dict] | None,
    emit_text: Callable[[str], None],
    usage_out: dict | None = None,
) -> tuple[str, list[ToolCall]]:
    """One model round via Anthropic; returns (text, tool_calls)."""
    system_parts = [m["content"] for m in messages if m["role"] == "system"]
    chat = [m for m in messages if m["role"] != "system"]

    async with client.messages.stream(
        model=model,
        max_tokens=8192,
        system="\n\n".join(system_parts) or None,
        messages=chat,
        tools=tools or None,
    ) as stream:
        text_parts: list[str] = []
        async for part in stream.text_stream:
            text_parts.append(part)
            emit_text(part)
        msg = await stream.get_final_message()

    _absorb_usage(usage_out, getattr(msg, "usage", None), model)

    calls: list[ToolCall] = []
    if msg.stop_reason == "tool_use":
        for block in msg.content:
            if getattr(block, "type", "") == "tool_use":
                args = getattr(block, "input", None)
                calls.append(
                    ToolCall(
                        id=block.id,
                        name=block.name,
                        arguments=args if isinstance(args, dict) else {},
                    )
                )
        text_parts = []
    return "".join(text_parts), calls


# ---------- message building for tool turns ----------

def _append_tool_round(
    messages: list[dict],
    provider_kind: str,
    text: str,
    outputs: list[tuple[ToolCall, str]],
) -> list[dict]:
    """Append one assistant tool_use message + one tool_result message per call."""
    if provider_kind == "anthropic":
        content: list = []
        if text:
            content.append({"type": "text", "text": text})
        for tc, _ in outputs:
            content.append({"type": "tool_use", "id": tc.id, "name": tc.name, "input": tc.arguments})
        messages.append({"role": "assistant", "content": content})
        for tc, out in outputs:
            messages.append(
                {"role": "user", "content": [{"type": "tool_result", "tool_use_id": tc.id, "content": out}]}
            )
    else:
        messages.append(
            {
                "role": "assistant",
                "content": text or None,
                "tool_calls": [
                    {
                        "id": tc.id,
                        "type": "function",
                        "function": {"name": tc.name, "arguments": json.dumps(tc.arguments, ensure_ascii=False)},
                    }
                    for tc, _ in outputs
                ],
            }
        )
        for tc, out in outputs:
            messages.append({"role": "tool", "tool_call_id": tc.id, "content": out})
    return messages


# ---------- public entry points ----------

async def run_agentic_chat(
    provider: ProviderInfo,
    model: str,
    messages: list[dict],
    tools: list[dict],
    run_tool: Callable[[str, dict], Awaitable[str]],
    emit_text: Callable[[str], None],
    emit_tool: Callable[[str, dict], None],
    max_rounds: int = MAX_TOOL_ROUNDS,
    on_round: Callable[[int], None] | None = None,
    usage: dict | None = None,
    parallel_tools: bool = True,
) -> str:
    """Chat with optional tool calling. Returns the final assistant text.

    `tools` is a list of OpenAI-style function specs. `run_tool(name, args) ->
    str` executes a call; `emit_text` receives streamed text deltas;
    `emit_tool(name, args)` fires when a tool is about to run (for the UI).
    `on_round(n)` fires at the start of each model round (1-based), so callers
    can budget or log multi-step agent runs. `usage`, when given a dict,
    accumulates {"input", "output"} token counts across all rounds.

    If the model refuses `tools` (e.g. an Ollama model without tool support),
    the first round is retried once without tools so chat still works.
    """
    msgs = [dict(m) for m in messages]
    use_tools = bool(tools)
    tool_param = tools if use_tools else None

    # 跟踪本轮是否已经吐过字：降级重试只在「第一轮、且一个字没吐」时允许。
    # 已开始输出再报错（网络中断等）不能当成「不支持工具」从零重试——会重复输出。
    emitted_any = False

    def _emit(t: str) -> None:
        nonlocal emitted_any
        if t:
            emitted_any = True
        emit_text(t)

    for round_no in range(1, max_rounds + 1):
        if on_round:
            on_round(round_no)
        round_usage: dict = {}
        client = None
        try:
            if provider.kind == "anthropic":
                client = AsyncAnthropic(api_key=provider.api_key)
                a_tools = [_flatten_tool_spec(t) for t in tool_param] if tool_param else None
                text, calls = await _anthropic_round(client, model, msgs, a_tools, _emit, round_usage)
            else:
                client = _openai_client(provider)
                text, calls = await _openai_round(client, model, msgs, tool_param, _emit, round_usage)
        except Exception:
            if use_tools and round_no == 1 and not emitted_any:
                # provider likely doesn't support tools — retry once, plain
                use_tools = False
                tool_param = None
                continue
            raise
        finally:
            if client is not None:
                await client.close()
        if usage is not None:
            usage["input"] = usage.get("input", 0) + round_usage.get("input", 0)
            usage["output"] = usage.get("output", 0) + round_usage.get("output", 0)

        if not calls:
            return text or ""

        # 先把所有工具调用按顺序发出（UI 顺序稳定），再执行。
        for tc in calls:
            emit_tool(tc.name, tc.arguments)

        async def _run_one(tc: ToolCall) -> tuple[ToolCall, str]:
            try:
                result = await run_tool(tc.name, tc.arguments)
            except Exception as e:  # noqa: BLE001 - 单个工具失败不拖垮整轮
                result = f"[tool error] {type(e).__name__}: {e}"
            result = str(result)
            if len(result) > 8000:
                result = result[:8000] + "\n...[工具输出过长已截断]"
            return (tc, result)

        # 模型一次返回多个 tool_calls 时，语义就是「可并行」，独立工具同时跑省时；
        # gather 保持输入顺序，_append_tool_round 的输出对应关系不变。单工具自然串行。
        if parallel_tools and len(calls) > 1:
            outputs = list(await asyncio.gather(*(_run_one(tc) for tc in calls)))
        else:
            outputs = [await _run_one(tc) for tc in calls]

        msgs = _append_tool_round(msgs, provider.kind, text, outputs)

    return "(工具调用轮次过多，未能生成最终回答。请简化指令或关闭工具后重试。)"


async def stream_chat(
    provider: ProviderInfo,
    model: str,
    messages: list[dict],
    usage: dict | None = None,
) -> AsyncIterator[str]:
    """Plain streaming chat without tools (kept for compatibility/tests).

    `usage`, when given a dict, accumulates {"input", "output"} token counts.
    """
    if provider.kind == "anthropic":
        client = AsyncAnthropic(api_key=provider.api_key)
        system_parts = [m["content"] for m in messages if m["role"] == "system"]
        chat = [m for m in messages if m["role"] != "system"]
        try:
            async with client.messages.stream(
                model=model,
                max_tokens=8192,
                system="\n\n".join(system_parts) or None,
                messages=chat,
            ) as stream:
                async for text in stream.text_stream:
                    yield text
                _absorb_usage(usage, getattr(await stream.get_final_message(), "usage", None), model)
        finally:
            await client.close()
    else:
        client = _openai_client(p=provider)
        kwargs: dict = dict(model=model, messages=messages, stream=True)
        if usage is not None:
            kwargs["stream_options"] = {"include_usage": True}
        try:
            stream = await client.chat.completions.create(**kwargs)
        except Exception:
            if "stream_options" in kwargs:  # provider rejects the param — retry plain
                kwargs.pop("stream_options")
                stream = await client.chat.completions.create(**kwargs)
            else:
                raise
        # 显式关流：调用方（页面 abort / 断连 / 会话切换）取消本生成器时，
        # 没有这一步底层 HTTP 响应要等 GC 兜底才释放，上游会继续烧完整个回复。
        # anthropic 分支的 `async with` 已是确定性关闭，这里补齐对等行为。
        try:
            async for chunk in stream:
                _absorb_usage(usage, getattr(chunk, "usage", None), model)
                if not chunk.choices or chunk.choices[0].delta is None:
                    continue
                delta = chunk.choices[0].delta.content
                if delta:
                    yield delta
        finally:
            await stream.close()
            await client.close()


async def stream_chat_fallback(
    candidates: list[tuple[ProviderInfo, str, str]],
    messages: list[dict],
    usage: dict | None = None,
    served: dict | None = None,
) -> AsyncIterator[str]:
    """stream_chat over a fallback chain (maple-os 参考项：降级链的迷你版).

    candidates are (info, model, label); the label only feeds bookkeeping.
    Switch to the next candidate **only while nothing has been emitted** — a
    dead URL or bad key fails before the first chunk, and that is the case
    worth surviving. Once text is flowing, errors propagate as before: a
    mid-stream switch would duplicate or garble the answer the caller already
    forwarded. `served`, when given, receives {"label": ...} of the candidate
    that actually produced output, so callers can record the real provider.
    """
    last: Exception | None = None
    for info, model, label in candidates:
        emitted = False
        try:
            async for delta in stream_chat(info, model, messages, usage=usage):
                if not emitted and served is not None:
                    served["label"] = label
                emitted = True
                yield delta
            return
        except Exception as e:  # noqa: BLE001 - switching on failure is the point
            if emitted:
                raise
            last = e
    if last is not None:
        raise last


# ---------- structured output (JSON) ----------

_JSON_HINT = "只输出 JSON，不要解释、不要代码块。"


def _ensure_json_hint(messages: list[dict]) -> list[dict]:
    """部分 OpenAI 兼容实现要求 prompt 里出现 JSON 字样才接受 json_object。"""
    blob = " ".join(str(m.get("content") or "") for m in messages)
    if "json" in blob.lower():
        return messages
    return [*messages, {"role": "system", "content": _JSON_HINT}]


async def _openai_structured(
    provider: ProviderInfo, model: str, messages: list[dict], usage: dict | None
) -> str:
    client = _openai_client(provider)
    try:
        resp = await client.chat.completions.create(
            model=model,
            messages=_ensure_json_hint(messages),
            response_format={"type": "json_object"},
        )
        _absorb_usage(usage, getattr(resp, "usage", None), model)
        return resp.choices[0].message.content or ""
    finally:
        await client.close()


async def _anthropic_structured(
    provider: ProviderInfo,
    model: str,
    messages: list[dict],
    json_schema: dict | None,
    usage: dict | None,
) -> str:
    """Anthropic 没有 JSON mode：用 tool_choice 强制模型填一个工具来拿到结构化结果。"""
    client = AsyncAnthropic(api_key=provider.api_key)
    try:
        system_parts = [m["content"] for m in messages if m["role"] == "system"]
        chat = [m for m in messages if m["role"] != "system"]
        tool = {
            "name": "emit_result",
            "description": "按给定的 schema 输出结构化结果。",
            "input_schema": json_schema or {"type": "object"},
        }
        resp = await client.messages.create(
            model=model,
            max_tokens=8192,
            system="\n\n".join(system_parts) or None,
            messages=chat,
            tools=[tool],
            tool_choice={"type": "tool", "name": "emit_result"},
        )
        _absorb_usage(usage, getattr(resp, "usage", None), model)
        for block in resp.content:
            if getattr(block, "type", "") == "tool_use":
                return json.dumps(block.input, ensure_ascii=False)
        return "".join(
            getattr(b, "text", "") for b in resp.content if getattr(b, "type", "") == "text"
        )
    finally:
        await client.close()


async def structured_chat(
    provider: ProviderInfo,
    model: str,
    messages: list[dict],
    *,
    json_schema: dict | None = None,
    usage: dict | None = None,
) -> str | None:
    """非流式结构化输出：想直接拿到 JSON 文本时用这个。

    与 `stream_chat` 平级并存，不改动现有流式路径。优先用 provider 原生能力：
      - OpenAI 兼容：`response_format={"type": "json_object"}`
      - Anthropic：无 JSON mode，改为 tool_choice 强制调用 `emit_result`
    任一环节不支持（本地模型、部分兼容层的常见情况）都返回 None，由调用方
    降级到「prompt 约束 + 清洗提取」——见 core/structured.py。
    """
    try:
        if provider.kind == "anthropic":
            return await _anthropic_structured(provider, model, messages, json_schema, usage)
        return await _openai_structured(provider, model, messages, usage)
    except Exception as e:  # noqa: BLE001 - 不支持就是不支持，交给调用方降级
        log.info("structured_chat unsupported (%s %s): %s", provider.kind, model, e)
        return None