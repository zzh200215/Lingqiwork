"""Conversation context compaction (Open WebUI-style /compact, automatic).

When chat history exceeds a character budget, the oldest half is summarized
by the current model into a compact digest. The digest is cached per
conversation keyed by the transcript content, so edits naturally invalidate.
"""
from app.core.llm import ProviderInfo, stream_chat

# ~24k chars of history before we compress (roughly 8-12k tokens for zh/en mix)
HISTORY_CHAR_BUDGET = 24000
_MIN_TAIL_MESSAGES = 4  # always keep at least this many recent messages verbatim

_cache: dict[int, tuple[float, str]] = {}  # conv_id -> (built_at_monotonic, summary)


def needs_compaction(history: list[dict]) -> bool:
    total = sum(len(m.get("content") or "") for m in history)
    return total > HISTORY_CHAR_BUDGET


def _split(history: list[dict]) -> tuple[list[dict], list[dict]]:
    """Oldest half by chars -> [summary_src], rest -> [verbatim tail]."""
    total = sum(len(m.get("content") or "") for m in history)
    acc = 0
    cut = 0
    for i, m in enumerate(history):
        acc += len(m.get("content") or "")
        if acc >= total // 2:
            cut = i + 1
            break
    # never summarize away the most recent messages
    cut = min(cut, len(history) - _MIN_TAIL_MESSAGES)
    if cut <= 0:
        return [], history
    return history[:cut], history[cut:]


async def compact(
    provider: ProviderInfo,
    model: str,
    conversation_id: int,
    history: list[dict],
) -> tuple[str | None, list[dict]]:
    """Return (summary_block_or_None, messages_to_send_verbatim).

    On any failure the original history passes through untouched —
    compaction must never break a chat turn.
    """
    src, tail = _split(history)
    if not src:
        return None, tail

    transcript = "\n".join(
        f"{'用户' if m['role'] == 'user' else '助手'}: {(m.get('content') or '')[:2000]}"
        for m in src
    )
    key = hash(transcript)
    cached = _cache.get(conversation_id)
    if cached is not None and cached[0] == key:
        return cached[1], tail

    prompt = (
        "把以下对话压缩成一份要点摘要，保留：讨论的主题、达成的结论、"
        "用户表达的偏好和决定、未解决的问题。用简洁的条目式中文输出，"
        "不超过 400 字。\n\n---\n\n" + transcript
    )
    try:
        text = ""
        # 方向 4：辅助调用也要进账本。span 里 stream_chat 收到的 usage 会经
        # `_absorb_usage(None, …)` → `usage_ledger.note()` 落成 model_usage 的
        # "compaction" 行；缓存命中不进这里——没有模型调用就不该有行。
        from app.core import usage_ledger

        async with usage_ledger.span("compaction", ref=f"conv:{conversation_id}"):
            async for delta in stream_chat(
                provider,
                model,
                [
                    {"role": "system", "content": "你是对话摘要助手，只输出摘要本身。"},
                    {"role": "user", "content": prompt},
                ],
            ):
                text += delta
        text = text.strip()
        if not text:
            return None, history
    except Exception:  # noqa: BLE001
        return None, history

    _cache[conversation_id] = (key, text)
    return text, tail


def invalidate(conversation_id: int) -> None:
    _cache.pop(conversation_id, None)
