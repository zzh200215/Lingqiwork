"""One-shot streaming Q&A for the selection assistant (ROADMAP V4.2).

Not persisted as conversations — quick translate/explain/summarize/custom
prompts over clipboard text, streamed as SSE like /api/notes/ai.
"""
import json

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy import select

from app.db import SessionLocal
from app.models import ProviderConfig
from app.core import usage_ledger

router = APIRouter(prefix="/api/ask", tags=["ask"])

_MAX_TEXT = 20000

_ACTIONS: dict[str, str] = {
    "translate": (
        "把下面的文本翻译成{target}。专有名词和代码保持原样，"
        "只输出译文本身，不要任何解释或前缀。"
    ),
    "explain": (
        "解释下面这段文本的含义。用简体中文，通俗准确，"
        "如果是术语/概念给出定义，如果是代码说明它在做什么。直接输出解释。"
    ),
    "summarize": (
        "把下面的文本浓缩成几句话的摘要，保留关键信息和结论。直接输出摘要。"
    ),
}


class AskRequest(BaseModel):
    text: str
    action: str  # translate | explain | summarize | custom
    prompt: str | None = None  # for action=custom
    target: str | None = None  # for action=translate: "中文" / "English"
    model_id: str | None = None


async def _default_model() -> tuple[ProviderConfig, str]:
    """The default model as a (provider, model) pair.

    Third and last of the old copies of this rule; it now asks
    `core.providers.default_model_id()` so a model with a recent failed probe is
    skipped here too, then resolves the provider row it needs.
    """
    from app.core.providers import default_model_id

    mid = default_model_id()
    if not mid or "/" not in mid:
        raise HTTPException(400, "no enabled provider with models configured")
    pname, model = mid.split("/", 1)
    async with SessionLocal() as db:
        provider = (
            await db.execute(select(ProviderConfig).where(ProviderConfig.name == pname))
        ).scalar_one_or_none()
    if provider is None:
        raise HTTPException(400, f"provider '{pname}' not configured")
    return provider, model


@router.post("")
async def ask(body: AskRequest):
    text = body.text.strip()
    if not text:
        raise HTTPException(400, "text is empty")
    if len(text) > _MAX_TEXT:
        raise HTTPException(400, f"text too long ({len(text)} > {_MAX_TEXT})")

    if body.action == "custom":
        instruction = (body.prompt or "").strip()
        if not instruction:
            raise HTTPException(400, "custom action requires prompt")
    else:
        instruction = _ACTIONS.get(body.action)
        if not instruction:
            raise HTTPException(400, f"unknown action '{body.action}'")

    from app.core.llm import ProviderInfo, stream_chat

    if body.model_id and "/" in body.model_id:
        pname, model = body.model_id.split("/", 1)
        async with SessionLocal() as db:
            provider = (
                await db.execute(select(ProviderConfig).where(ProviderConfig.name == pname))
            ).scalar_one_or_none()
        if not provider or not provider.enabled:
            raise HTTPException(400, f"provider '{pname}' not configured")
    else:
        provider, model = await _default_model()

    user_content = f"{instruction.format(target=body.target or '简体中文')}\n\n---\n\n{text}"

    async def gen():
        msgs = [
            {
                "role": "system",
                "content": "你是用户的划词助手，回答要直接、简洁。当前文本来自用户在任意应用中选中的内容。",
            },
            {"role": "user", "content": user_content},
        ]
        info = ProviderInfo(kind=provider.kind, base_url=provider.base_url, api_key=provider.api_key)

        def sse(event: str, data: dict) -> str:
            return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"

        try:
            async for delta in stream_chat(info, model, msgs):
                yield sse("delta", {"text": delta})
            yield sse("done", {})
        except Exception as e:  # noqa: BLE001
            yield sse("error", {"message": f"{type(e).__name__}: {e}"})

    return StreamingResponse(
        usage_ledger.wrap_stream("ask", body.text, gen()),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
