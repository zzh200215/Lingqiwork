"""零柒's HTTP surface: feed / status / say / chat (SSE) / chats.

Chat used to be intentionally ephemeral (same stance as the selection
assistant); P5（加深脑子）让它落库（`pet_chats`）——「它记得你」靠前端内存
那 6 轮兜不住，刷新、隔天回来就断。仍然**不是**又一个会话列表：没有标题、
没有管理界面，只有最近几轮，给界面回放、给后端在客户端没带历史时补上下文。
"""
import asyncio
import json

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, field_validator
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
    只正面呈现（没有「还欠 N」）。

    Z4（PLAN4）：称号旁那一行**风味小注**也在这儿给（`pet_tone.flavor()`，同一份喂养
    分布）——不给新端点：成长页与面板读的都是这一个载荷，就不会两处各说一句。
    """
    from app.core import pet
    from app.core import pet_tone

    out = pet.growth()
    out["flavor"] = await pet_tone.flavor()
    return out


@router.get("/room")
async def pet_room(limit: int = 8):
    """零柒的小屋（P4 · 维度四）：它攒下的东西 + 今天喂了它什么 + 架上那几份成品
    + **它学会的技能**（Q2：跑过对照的那些提示词）+ **它记住的概念**（P2：学习地图的镜子）。

    「已掌握」的规则只有 `tutor.mastery_events()` 那一份（一场是运气、两场才算），
    这里**把它取来喂给纯函数**，而不是在房间模块里再写一遍 SQL——两处规则迟早分叉。

    `shelf` 单独在这里拼：列产出是 `routers/work.py` 的事（连标题提取在内只此一处），
    核心层不反过来引路由。但**只留成品**（`pet.is_output_path`）——工作页那张清单更宽
    （工作流产物、成文都算），那是另一个问题；混用会让小屋自己打自己的脸。
    """
    from app.core import pet
    from app.core import pet_room as room
    from app.core import pet_tone
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
    # 它记住的概念（P2 · F13）：学习地图在小屋里的**镜子**。摆的是地图已经分好的三档，
    # **「未触及」那一档一个字都不进屋**——那是「还没做的事」的清单，屋里不摆账。
    out["concepts"] = room.concept_cards(await tutor.learning_map())
    # Z4（PLAN4）：称号旁那一行风味小注。这一页没有称号（等级只在成长页与面板上），
    # 但「喂它什么」正是小屋的题眼——所以这一行摆在小屋顶上，与成长页那一行**同源**
    # （都是 `pet_tone.flavor()` 那一句）。
    out["flavor"] = await pet_tone.flavor()
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

    # snapshot 里的 sqlite3 / 目录扫描是同步的；放线程里跑，别卡事件循环。
    return await asyncio.to_thread(state.snapshot, idle_sec=idle_sec, path=(path or "")[:100])


@router.get("/chats")
async def pet_chats(limit: int = 30):
    """跟零柒最近几轮问答（旧 → 新）。P5 落库之后，这一条给界面回放——
    刷新、隔天回来，面板和陪伴页都从这里把「上一场聊到哪」铺出来。"""
    from app.core import pet

    return {"chats": pet.recent_chats(limit)}


# ---------- 陈述式周报（M4 · PLAN §3 G4）----------------------------------------

@router.get("/weekly-report")
async def pet_weekly_report():
    """这一周**已经发生的事**：几份材料、几个概念说通/半懂、几份成品、「又卡住」的有哪些。

    任何一天都能打开（**拉取式**，与决策日志同一个立场）；周日 21:00 那句问候说的是
    **同一份**（`pet.greeting` 里判 `weekday()`，不新增 cron——同一天 21:00 冒两句
    问候是另一种坏味道）。返回的 `text` 就是它会说的那句，界面不再另写一份文案。

    区间是**本自然周（周一 → 今天）**：周三点开时它是一周的半截，所以 `week` 一起
    给出来，别让「半周的数」看起来像「整周的数」。
    """
    from app.core import weekly

    return await weekly.report()


class WeeklyPodcastIn(BaseModel):
    voice: str = ""

    @field_validator("voice")
    @classmethod
    def _known_voice(cls, v: str) -> str:
        from app.core import tts

        if v and v not in tts.VOICES:
            raise ValueError("音色不在可用列表中")
        return v


@router.post("/weekly-report/podcast")
async def pet_weekly_podcast(body: WeeklyPodcastIn | None = None):
    """周报 → 一段音频（M4 · G4 的「一键转播客」）。

    **单音色念稿、不过模型**：稿子已经是 `weekly.text()` 出来的成品文本，这里要的不是
    编剧只是一张嘴——所以没有 provider 的机器上这一条照样能用。音频与别的播客一起
    登记在 `data/podcasts/index.json`，播放地址是 `/api/podcast/audio/<file>`。
    """
    from app.core import weekly

    result = await weekly.to_podcast(voice=(body.voice if body else ""))
    if not result.get("ok"):
        # 没内容（422）与合成失败（400）分开：前者是「这周还没什么可说的」，
        # 界面上不该显示成一个错误。
        raise HTTPException(422 if result.get("empty") else 400, result.get("error") or "转播客失败")
    return result


# ---------- 事件流（SSE）：有事发生就立刻说 --------------------------------------
#
# **轮询是兜底，不是主路。** 原来零柒靠每 15 秒问一次 `/feed` 与 `/state`：任务跑完、
# 一份成品落盘、有活开始跑，都可能晚 15 秒才被看见，而它恰恰是那个「先开口」的角色。
#
# 这条流只送两样东西：
#   1. `event` —— 新台词，就是 `/feed` 会给的那几行（**同一条路，不是第二份真值**）；
#   2. `work`  —— 此刻在跑什么变了（一个指纹，变了才发），界面据此重算一次状态。
#
# **状态本身不由这条流算**：它取决于你此刻在哪个页面、多久没动键鼠——那是客户端才知道
# 的事（`idle_sec` 从来只活在浏览器里）。所以流只负责说「有新东西了」，算还是 `/state` 算。
PET_STREAM_POLL = 2.0  # 服务端看一眼新台词的间隔（一次按 id 的索引查询）
PET_STREAM_PING = 25.0  # 一直没话说就发个注释帧，别让中间的代理把连接掐了


async def _pet_stream(since_id: int):
    import asyncio

    from app.core import pet
    from app.core import pet_state as state

    last = max(0, int(since_id or 0))
    fingerprint = await asyncio.to_thread(state.work_fingerprint)
    yield _sse("hello", {"since_id": last, "poll": PET_STREAM_POLL})
    idle = 0.0
    while True:
        spoke = False
        rows = pet.feed(limit=20, since_id=last)
        if rows:
            last = max(int(r["id"]) for r in rows)
            # 倒过来：台词按**说出口的顺序**冒出来，不是最新那条先跳出来
            for r in reversed(rows):
                yield _sse("event", r)
            spoke = True
        fresh = await asyncio.to_thread(state.work_fingerprint)
        if fresh != fingerprint:
            fingerprint = fresh
            yield _sse("work", {"fingerprint": fresh})
            spoke = True
        if spoke:
            idle = 0.0
        else:
            idle += PET_STREAM_POLL
            if idle >= PET_STREAM_PING:
                idle = 0.0
                yield ": ping\n\n"  # 注释帧：`sseFrames` 只认 data: 行，会直接跳过
        await asyncio.sleep(PET_STREAM_POLL)


@router.get("/stream")
async def pet_stream(since_id: int = 0):
    """零柒的事件流。客户端断开时 Starlette 会取消这个生成器，不用自己收尾。"""
    return StreamingResponse(_pet_stream(since_id), media_type="text/event-stream")


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
    # Z1（PLAN4）：最近几轮对话，**前端内存里那一份**（仍然不落库）。
    # 刻意用宽松的 `list[object]` 而不是一个严格模型：客户端带了脏数据时该被**忽略**，
    # 不该 422 掉整次聊天——归一化、截断、条数上限都在 `pet_context.history` 一处做。
    history: list[object] | None = None


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


async def _pet_tools(prefs: dict, ask: str = "") -> list[dict]:
    """零柒这一轮手上的工具：插件声明的 + `mcp` 内置的，再按白名单过滤一次。

    内置工具不走插件运行时，所以**两处都要过白名单**——只过滤一边，白名单就是摆设。

    `ask` 是你这一轮说的话：**破坏性工具也要口头授权**（§4.1 ①）——零柒是交互路径，
    所以规则与 chat 一字不差（`turn_quality.asked_to_forget`），只是这里多过一道白名单。
    默认那套 `PET_TOOL_DEFAULT` 本来就不含 `memory_delete`，但白名单是用户可以自己改的，
    所以"能不能删"不能只靠默认值说话。
    """
    from app.core import pet_plugins
    from app.core.mcp import mcp_manager
    from app.core.turn_quality import asked_to_forget

    allow = _allowed_tools(prefs)
    if allow is not None and not allow:
        return []
    out = await pet_plugins.tool_specs(allow=allow)
    for spec in mcp_manager.tool_specs(include_memory=True, allow_destructive=asked_to_forget(ask)):
        name = spec.get("function", {}).get("name", "")
        if allow is not None and name not in allow:
            continue
        out.append(spec)
    return out


@router.post("/chat")
async def pet_chat(body: PetChatIn):
    """Streamed chat with 零柒's persona + memory + **tools**（P3）。

    P5（加深脑子）之后**落库**：一问一答真的成立（它回了话）就写进 `pet_chats`，
    报错与中断的那轮不落。工具是真的会执行——「开始 25 分钟专注」现在会让面板上的
    倒计时真的走起来。
    """
    import asyncio

    from app.core import memory, pet
    from app.core import pet_context, pet_tone
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
    # P2 性格微调：按**读出来的**喂养分布追加一句用词倾向。只追加、不替换——
    # 开关关着、或数不出够分量的领域时原样返回（**人设常量本身一个字都不改**：
    # 它是登记过的一等提示词，改它等于把整条人设换了个版本）。
    system = await pet_tone.apply(system, prefs)
    try:
        if prefs.get("memory_enabled", True):
            mem = await memory.format_memories(msg)
            if mem:
                system += "\n\n你长期记忆中关于用户的信息：\n" + mem
    except Exception:  # noqa: BLE001 - memory is an enhancement, not a requirement
        pass

    # Z1（PLAN4）**镜子走进对话**：让陪伴页的它知道**今天**。
    # 两段：收工那句事实（`pet.day_statement`，与收工**同源**）+ 它最近说过的五句；
    # 历史真的在场时再补一句「你们正在连着聊」（真机 drill 撞出来的：不加这句，
    # flash 级模型会答「我看不见之前的对话」——那是拿假话回用户）。
    # 只追加、不替换（`pet_tone` 同款纪律）；一天还没动静就两段都不加——
    # **不注入「今天你什么都没干」**，那是欠账口吻（PLAN4 §8.7）。
    # 历史由前端带（内存里那一份），上限与截断在 `pet_context.history` 一处夹：
    # **不信任客户端**带多少来。
    turns = pet_context.history(body.history)
    system = pet_context.apply(
        system,
        said=await asyncio.to_thread(pet.day_statement),
        lines=pet_context.recent_lines(),
        has_history=bool(turns),
    )

    tools = await _pet_tools(prefs, ask=msg)
    if tools:
        # 工具真的存在才说这句话——否则是在指使模型去调一个它根本没有的能力
        # （同 `chat.py`：工具关掉时不能注入工具规矩）。
        system += "\n\n" + _PET_TOOL_RULE
    # 最近几轮对话（Z1）：后端每一轮原本都是**全新**的 messages，所以它不记得你上一句
    # ——「那第 2 条呢」这种追问答不上来。
    # P5 落库之后多一层**兜底**：客户端一份历史都没带（刚刷新、隔天回来）时，从
    # `pet_chats` 补——「它记得你」是跨会话的，不能只靠前端那份内存。客户端带了就
    # 照旧用客户端的：它永远最新，连刚说出口的那句都在。
    turns = pet_context.history(body.history)
    if not turns:
        turns = pet_context.history(pet.recent_chats(pet_context.HISTORY_MESSAGES))
    messages = [{"role": "system", "content": system}]
    messages += turns
    messages += [{"role": "user", "content": msg}]

    async def gen():
        p = resolved.provider
        info = ProviderInfo(kind=p.kind, base_url=p.base_url, api_key=p.api_key)
        q: asyncio.Queue = asyncio.Queue()
        usage: dict = {}
        # P5：这一轮的**成品**——正文与工具回执在流式过程中攒着，流正常收尾时一起落库。
        reply: list[str] = []
        receipts: list[dict] = []

        # 回调是同步的（`run_agentic_chat` 在 await 里调它们），没法直接 yield；
        # 所以照 `chat.py` 的老办法：跑工具的任务往队列里塞，这边把队列泵成 SSE。
        def on_delta(t: str) -> None:
            reply.append(t)
            q.put_nowait(("delta", t))

        def on_tool(name: str, args: dict) -> None:
            q.put_nowait(("tool_call", {"name": name, "arguments": args}))

        def on_tool_result(name: str, args: dict, meta: dict) -> None:
            # 工具的副产物 → 界面。与 chat.py 同一条约定：模型仍会用自己的话说结果，
            # 这里给的是**可核对的事实**（面板此刻的样子），不是又一句台词。
            pet_r = (meta or {}).get("pet")
            if pet_r:
                receipts.append(pet_r)
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
                    # P5：这一轮真的成立了（它回了话）才落库。报错那支走的是 error 帧、
                    # 直接 break，到不了这儿——残句不进记忆（`save_chat_turn` 里还有一道
                    # 空串守卫，两处有一处兜住就行）。
                    pet.save_chat_turn(msg, "".join(reply), receipts)
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
