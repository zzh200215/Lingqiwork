"""零柒's HTTP surface: feed / status / say / chat (SSE, ephemeral).

Pet chat intentionally does NOT persist a conversation (same stance as the
selection assistant): it is a conversation with the companion, backed by the
memory table, not another chat list.
"""
import json

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from app.core import usage_ledger

router = APIRouter(prefix="/api/pet", tags=["pet"])


@router.get("/feed")
async def pet_feed(limit: int = 30, since_id: int = 0):
    from app.core import pet

    return {"events": pet.feed(limit=limit, since_id=since_id)}


@router.get("/status")
async def pet_status():
    from app.core import pet

    return pet.status()


@router.get("/growth")
async def pet_growth():
    """零柒的成长（B1）：等级 / 称号 / 累计 EXP / 各来源明细。纯派生、只增不减、
    只正面呈现（没有「还欠 N」）。"""
    from app.core import pet

    return pet.growth()


# ---------- 能力插件（B2）----------


@router.get("/plugins")
async def list_plugins():
    """装好的能力插件 + 各自面板数据。首次调用会把内置两个（喝水 / 专注）装上。"""
    from app.core import pet_plugins

    return {"plugins": await pet_plugins.list_plugins()}


class PluginCommandIn(BaseModel):
    command: str
    args: dict | None = None


@router.post("/plugins/{name}/command")
async def plugin_command(name: str, body: PluginCommandIn):
    """跑一个插件命令（drink / start / stop）。"""
    from app.core import pet_plugins

    try:
        return await pet_plugins.command(name, body.command, body.args)
    except LookupError as e:
        raise HTTPException(404, f"没有插件 {name}") from e
    except ValueError as e:
        raise HTTPException(400, str(e)) from e


class PluginPatchIn(BaseModel):
    enabled: bool


@router.put("/plugins/{name}")
async def update_plugin(name: str, body: PluginPatchIn):
    """开 / 关一个插件。"""
    from app.core import pet_plugins

    try:
        return await pet_plugins.set_enabled(name, body.enabled)
    except LookupError as e:
        raise HTTPException(404, f"没有插件 {name}") from e


class SayIn(BaseModel):
    mode: str = "morning"  # morning | evening | free
    prompt: str | None = None
    toast: bool = True


@router.post("/say")
async def pet_say(body: SayIn):
    """Make 零柒 speak: an LLM greeting (morning/evening) or a free line."""
    from app.core import pet

    if body.mode == "free":
        text = (body.prompt or "").strip()
        if not text:
            raise HTTPException(400, "prompt 不能为空")
        kind = "say"
    else:
        if body.mode not in ("morning", "evening"):
            raise HTTPException(400, "mode 只能是 morning/evening/free")
        text = await pet.greeting(body.mode)
        kind = "greeting"
    # 回给调用方的就是零柒真正说出口的那句（过了隐私闸门），不是原文——
    # 不然「台词」和「响应」两处不一致，日后必有人照着响应去查路径。
    spoken = pet.sanitize(text)
    event_id = pet.emit(kind, text=spoken)
    return {"id": event_id, "text": spoken}


class PetChatIn(BaseModel):
    message: str
    model_id: str | None = None


def _sse(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


@router.post("/chat")
async def pet_chat(body: PetChatIn):
    """Ephemeral streamed chat with 零柒's persona + persistent memory injected."""
    from app.core import memory, pet
    from app.core.llm import ProviderInfo, stream_chat
    from app.core.prefs import load_config

    msg = (body.message or "").strip()
    if not msg:
        raise HTTPException(400, "message 不能为空")
    if len(msg) > 20000:
        raise HTTPException(400, "message 过长（上限 20000 字）")

    model_id = body.model_id or pet._default_model_id()
    if not model_id:
        raise HTTPException(400, "没有已启用的 provider")
    from app.routers.chat import resolve_model

    try:
        resolved = await resolve_model(model_id)
    except HTTPException:
        raise

    system = pet.CHAT_SYSTEM
    try:
        if load_config().get("memory_enabled", True):
            mem = await memory.format_memories(msg)
            if mem:
                system += "\n\n你长期记忆中关于用户的信息：\n" + mem
    except Exception:  # noqa: BLE001 - memory is an enhancement, not a requirement
        pass
    messages = [{"role": "system", "content": system}, {"role": "user", "content": msg}]

    async def gen():
        p = resolved.provider
        info = ProviderInfo(kind=p.kind, base_url=p.base_url, api_key=p.api_key)
        try:
            async for delta in stream_chat(info, resolved.model, messages):
                yield _sse("delta", {"text": delta})
            yield _sse("done", {})
        except Exception as e:  # noqa: BLE001
            yield _sse("error", {"message": f"{type(e).__name__}: {e}"})

    return StreamingResponse(usage_ledger.wrap_stream("pet", "", gen()), media_type="text/event-stream")
