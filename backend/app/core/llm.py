"""LLM gateway over OpenAI-compatible + Anthropic APIs, with tool calling.

`run_agentic_chat` drives the tool loop:
  model -> (text | tool_calls) -> execute tools -> feed results back -> repeat
until the model answers without tools, or the round budget is exhausted.

OpenAI-compatible protocol covers openai/deepseek/qwen/moonshot/ollama/
openrouter — same client, different base_url.
"""
import json
from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import dataclass

from anthropic import AsyncAnthropic
from openai import AsyncOpenAI

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


def _absorb_usage(usage_out: dict | None, raw) -> None:
    """Merge a provider usage object into the caller's accumulator."""
    if usage_out is None or raw is None:
        return
    try:
        usage_out["input"] = usage_out.get("input", 0) + int(getattr(raw, "input_tokens", 0) or getattr(raw, "prompt_tokens", 0) or 0)
        usage_out["output"] = usage_out.get("output", 0) + int(getattr(raw, "output_tokens", 0) or getattr(raw, "completion_tokens", 0) or 0)
    except (TypeError, ValueError):
        pass


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
    if usage_out is not None:
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

    async for chunk in stream:
        _absorb_usage(usage_out, getattr(chunk, "usage", None))
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
        system="\n\n".join(system_parts) or ...,
        messages=chat,
        tools=tools or None,
    ) as stream:
        text_parts: list[str] = []
        async for part in stream.text_stream:
            text_parts.append(part)
            emit_text(part)
        msg = await stream.get_final_message()

    _absorb_usage(usage_out, getattr(msg, "usage", None))

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

    for round_no in range(1, max_rounds + 1):
        if on_round:
            on_round(round_no)
        round_usage: dict = {}
        try:
            if provider.kind == "anthropic":
                client = AsyncAnthropic(api_key=provider.api_key)
                a_tools = [_flatten_tool_spec(t) for t in tool_param] if tool_param else None
                text, calls = await _anthropic_round(client, model, msgs, a_tools, emit_text, round_usage)
            else:
                client = _openai_client(provider)
                text, calls = await _openai_round(client, model, msgs, tool_param, emit_text, round_usage)
        except Exception:
            if use_tools:
                # provider likely doesn't support tools — retry once, plain
                use_tools = False
                tool_param = None
                continue
            raise
        if usage is not None:
            usage["input"] = usage.get("input", 0) + round_usage.get("input", 0)
            usage["output"] = usage.get("output", 0) + round_usage.get("output", 0)

        if not calls:
            return text or ""

        outputs: list[tuple[ToolCall, str]] = []
        for tc in calls:
            emit_tool(tc.name, tc.arguments)
            try:
                result = await run_tool(tc.name, tc.arguments)
            except Exception as e:  # noqa: BLE001
                result = f"[tool error] {type(e).__name__}: {e}"
            result = str(result)
            if len(result) > 8000:
                result = result[:8000] + "\n...[工具输出过长已截断]"
            outputs.append((tc, result))

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
        async with client.messages.stream(
            model=model,
            max_tokens=8192,
            system="\n\n".join(system_parts) or ...,
            messages=chat,
        ) as stream:
            async for text in stream.text_stream:
                yield text
            _absorb_usage(usage, getattr(await stream.get_final_message(), "usage", None))
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
                _absorb_usage(usage, getattr(chunk, "usage", None))
                delta = chunk.choices[0].delta.content if chunk.choices else None
                if delta:
                    yield delta
        finally:
            await stream.close()