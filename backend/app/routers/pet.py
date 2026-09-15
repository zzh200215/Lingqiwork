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


@router.get("/room")
async def pet_room(limit: int = 8):
    """零柒的小屋（P4 · 维度四）：它攒下的东西 + 今天喂了它什么 + 架上那几份成品
    + **它学会的技能**（Q2：跑过对照的那些提示词）。

    「已掌握」的规则只有 `tutor.mastery_events()` 那一份（一场是运气、两场才算），
    这里**把它取来喂给纯函数**，而不是在房间模块里再写一遍 SQL——两处规则迟早分叉。

    `shelf` 单独在这里拼：列产出是 `routers/work.py` 的事（连标题提取在内只此一处），
    核心层不反过来引路由。但**只留成品**（`pet.is_output_path`）——工作页那张清单更宽
    （工作流产物、成文都算），那是另一个问题；混用会让小屋自己打自己的脸。
    """
    from app.core import pet
    from app.core import pet_room as room
    from app.core import prompt_eval
    from app.core import form as form_core
    from app.core import tutor
    from app.routers.work import list_outputs

    cap = max(1, min(int(limit or 8), 50))
    m = await tutor.mastery_events()
    out = room.room(m.get("events") or [])
    rows = (await list_outputs(limit=200))["outputs"]
    out["shelf"] = [o for o in rows if pet.is_output_path(o.get("path", ""))][:cap]
    # 身上挂的那件可能是**刚交出去的那份成品**（门槛是稀疏的，叼回来是每份都发生的）
    out["carried"] = room.carried(out.get("carried"), out["shelf"])
    # 技能卡（Q2）：**只有跑过对照的那些提示词**才进屋。没基线的不是技能，是还没验过的文本。
    out["skills"] = await prompt_eval.cards()
    # 形态（Q3）：**只有长出枝的领域**进屋。三个数里差一样就不算枝，小屋不摆它——
    # 「为什么这根枝还没长出来」在工作页那张诊断表里一次说清，不在这儿念（念出来就是催）。
    out["form"] = [b for b in (await form_core.branches())["domains"] if b["grown"]]
    return out


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


@router.get("/state")
async def pet_state(idle_sec: int | None = None, path: str = ""):
    """零柒**此刻**的状态（P1 · 维度一）：该摆什么姿势、说什么话、还剩多少精神。

    与 `/growth`（累计，只增不减）刻意分开：这一条说的是「现在」。

    `idle_sec` / `path` 都是**瞬时量**：不落库、不写日志。键鼠活动只在浏览器里算，
    服务端因此只知道「该显示无聊了」，不知道你在不在电脑前。
    """
    from app.core import pet_state as state

    return state.snapshot(idle_sec=idle_sec, path=(path or "")[:100])


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


# P3：零柒「会干活」——它手上有工具时，该怎么用。
#
# **单独登记在 `prompts._SPECS` 里**，而不是偷偷拼进 `pet.CHAT_SYSTEM`：
# 后者会改掉那条已注册提示词的指纹，等于绕过登记中心。这与 `chat.py` 的
# `_OUTPUT_RULE` 是同一个做法——新增一条**一等公民**提示词，而不是夹带。
#
# 四条要求都是必需的，少一条它就退化成纯聊天：
# 1. 「你有工具」——不说，模型只会当自己在聊天；
# 2. 「别替用户做他没说的事」——不说，它会积极过头地开始计时、替你记心情；
# 3. 「别复述工具输出」——不说，它会把工具返回的事实原样念一遍；
# 4. 「报错照实说」——不说，工具挂了它会假装成功。
_PET_TOOL_RULE = """你手上有几个工具，可以真的替用户做事，而不只是回话。
- 用户明确提到某件事时（开始专注、喝了水、今天心情如何），**先调用对应工具**，再说话。
- 用户只是闲聊、或在问问题，就不要动工具。**不要替他决定**该专注多久、今天心情几分。
- 工具返回的是事实，不是你该念的台词。用你自己的话说一句就好，别复述工具输出。
- 工具报错了就照实说一句，别假装成功。"""


class PetChatIn(BaseModel):
    message: str
    model_id: str | None = None


def _sse(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


# 零柒默认能用的工具。**写操作与慢操作刻意不在里面**：这是角落里的一个陪伴面板，
# 不该让它悄悄改你的笔记，也不该让一次图片生成把你的对话卡住一分钟。
# `prefs.pet_tools` 给了名单就按名单走（空串 = 一个都不给）。
PET_TOOL_DEFAULT = (
    "pet_focus_start",
    "pet_focus_stop",
    "pet_water_drink",
    "pet_mood_set",
    "memory_save",
    "memory_list",
    "kb_search",
)


def _allowed_tools(prefs: dict) -> set[str] | None:
    raw = prefs.get("pet_tools", None)
    if raw is None:
        return set(PET_TOOL_DEFAULT)
    if isinstance(raw, str):
        return {s.strip() for s in raw.split(",") if s.strip()}
    if isinstance(raw, list):
        return {str(s).strip() for s in raw if str(s).strip()}
    return set(PET_TOOL_DEFAULT)


async def _pet_tools(prefs: dict) -> list[dict]:
    """零柒这一轮手上的工具：插件声明的 + `mcp` 内置的，再按白名单过滤一次。

    内置工具不走插件运行时，所以**两处都要过白名单**——只过滤一边，白名单就是摆设。
    """
    from app.core import pet_plugins
    from app.core.mcp import mcp_manager

    allow = _allowed_tools(prefs)
    if allow is not None and not allow:
        return []
    out = await pet_plugins.tool_specs(allow=allow)
    for spec in mcp_manager.tool_specs(include_memory=True):
        name = spec.get("function", {}).get("name", "")
        if allow is not None and name not in allow:
            continue
        out.append(spec)
    return out


@router.post("/chat")
async def pet_chat(body: PetChatIn):
    """Ephemeral streamed chat with 零柒's persona + memory + **tools**（P3）。

    仍然是**不落库**的：这是跟陪伴者的对话，不是又一个会话列表。但工具是真的会执行——
    「开始 25 分钟专注」现在会让面板上的倒计时真的走起来。
    """
    import asyncio

    from app.core import memory, pet
    from app.core.llm import ProviderInfo, run_agentic_chat
    from app.core.mcp import begin_turn, mcp_manager
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

    resolved = await resolve_model(model_id)

    prefs = load_config()
    system = pet.CHAT_SYSTEM
    try:
        if prefs.get("memory_enabled", True):
            mem = await memory.format_memories(msg)
            if mem:
                system += "\n\n你长期记忆中关于用户的信息：\n" + mem
    except Exception:  # noqa: BLE001 - memory is an enhancement, not a requirement
        pass

    tools = await _pet_tools(prefs)
    if tools:
        # 工具真的存在才说这句话——否则是在指使模型去调一个它根本没有的能力
        # （同 `chat.py`：工具关掉时不能注入工具规矩）。
        system += "\n\n" + _PET_TOOL_RULE
    messages = [{"role": "system", "content": system}, {"role": "user", "content": msg}]

    async def gen():
        p = resolved.provider
        info = ProviderInfo(kind=p.kind, base_url=p.base_url, api_key=p.api_key)
        q: asyncio.Queue = asyncio.Queue()
        usage: dict = {}

        # 回调是同步的（`run_agentic_chat` 在 await 里调它们），没法直接 yield；
        # 所以照 `chat.py` 的老办法：跑工具的任务往队列里塞，这边把队列泵成 SSE。
        def on_delta(t: str) -> None:
            q.put_nowait(("delta", t))

        def on_tool(name: str, args: dict) -> None:
            q.put_nowait(("tool_call", {"name": name, "arguments": args}))

        def on_tool_result(name: str, args: dict, meta: dict) -> None:
            # 工具的副产物 → 界面。与 chat.py 同一条约定：模型仍会用自己的话说结果，
            # 这里给的是**可核对的事实**（面板此刻的样子），不是又一句台词。
            q.put_nowait(("tool_result", {"name": name, "meta": meta}))

        async def runner():
            try:
                # 工具副产物记在 contextvar（`mcp._TOOL_META`）里，必须由跑工具的
                # **同一个任务**开一轮；`begin_turn()` 顺带清掉上一轮的残留。
                begin_turn()
                await run_agentic_chat(
                    info,
                    resolved.model,
                    messages,
                    tools,
                    mcp_manager.call_tool,
                    on_delta,
                    on_tool,
                    usage=usage,
                    emit_tool_result=on_tool_result,
                )
            except Exception as e:  # noqa: BLE001
                q.put_nowait(("error", f"{type(e).__name__}: {e}"))
            finally:
                q.put_nowait(("stop", None))

        task = asyncio.create_task(runner())
        try:
            while True:
                kind, a = await q.get()
                if kind == "stop":
                    break
                if kind == "error":
                    yield _sse("error", {"message": a})
                    break
                if kind == "delta":
                    yield _sse("delta", {"text": a})
                elif kind == "tool_call":
                    yield _sse("tool_call", a)
                elif kind == "tool_result":
                    yield _sse("tool_result", a)
            yield _sse("done", {})
        finally:
            if not task.done():
                task.cancel()
            try:
                await task
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass

    return StreamingResponse(usage_ledger.wrap_stream("pet", "", gen()), media_type="text/event-stream")
