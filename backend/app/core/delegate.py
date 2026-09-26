"""子代理委托（A1）：把一件子任务交给「另一个模型 + 另一组工具 + 独立上下文」。

**它补的是哪个缺口（Agent升级.md §1.1/§1.2）。** 2026 年 agent 框架收敛出的四个共识原语里，
项目有三个半：状态图（自研确定性编排）、MCP（双端齐备）、生命周期与可观测（W5 + usage_ledger）
——**缺的是「委托」**。而项目里其实早就凑齐了零件：agents CRUD（人设 + 模型 + 工具开关）、
`run_agentic_chat`（可递归）、工具网关（`mcp.call_tool`）。缺的只是把线接起来。

**五条纪律写死在这个模块里**（方案 §2 A1）：

1. **子代理是隔离的**：独立 messages（只有 task + 可选人设）、独立工具子集（默认**只读 + 检索**，
   写操作要显式给）、独立轮数预算（**父预算减半**，上限 3——委托是让子任务便宜，不是翻倍烧钱）；
2. **深度写死 1 层**：子代理的工具清单里**没有 `delegate`**（递归委托 = 成本与失控的双重滑坡），
   另外还有一道运行时闸门：已经在委托里了就拒绝（两道都留着，因为「工具清单里没有」是**构造**
   出来的事实，而闸门是**当时**的事实）；
3. **委托有账**：子代理跑的就是一次 `run_agentic_chat(trace=...)`，它的 trace 挂回主循环这一轮的
   账本（`turn_traces.sub_traces_json`）——父那一轮花了多少钱、子代理用了几轮几个工具，一起看得见；
4. **agents 表就是子代理登记处**：`agent_name` 查既有记录（人设 / 模型 / 工具开关现成），
   查不到就用裸 task + 默认配置 —— **不发明第二套 agent 定义**；
5. **默认对 chat 开、对无人值守路径关**：这条落在工具清单那一侧（`mcp.tool_specs`
   的 `include_delegate` 默认 False，只有 chat 显式打开），不在这个模块里。

**为什么隔离要在「另一个 Task」里跑**：这一轮的同体裁落盘额度（`mcp._TURN_SAVES`）、产出清单
（`_TURN_ARTIFACTS`）、字数预算、工具副产物（`_TOOL_META`）全是 ContextVar。`ContextVar.set()`
在**子 Task** 的上下文副本里改，漏不回主循环；而 `asyncio.create_task` 正是「拷一份上下文」。
不这么做的话，子代理存一次产出就会吃掉主循环那两次修订额度，甚至覆盖主循环刚写的那份。
"""
from __future__ import annotations

import asyncio
import json
import logging
import time
from contextvars import ContextVar
from dataclasses import dataclass, field

from app.core.llm import MAX_TOOL_ROUNDS, ProviderInfo, run_agentic_chat

log = logging.getLogger(__name__)

DELEGATE_TOOL = "delegate"

# 默认给子代理的工具：**只读 + 检索**。要写东西（落盘 / 写 vault / 记记忆）必须由主循环
# 在 `tools` 参数里**显式点名** —— 这就是方案那条「写操作要显式给」的落地方式。
READONLY_TOOLS: tuple[str, ...] = (
    "vault_read_file",
    "vault_list_files",
    "kb_search",
    "skill_load",
    "memory_list",
)
WRITE_TOOLS: tuple[str, ...] = (
    "save_artifact",
    "vault_write_file",
    "memory_save",
    "memory_delete",
    "image_gen",
)
# 上表里 `memory_delete` **授予不出去**（2026-09-22 起）：它是 `mcp.DESTRUCTIVE_TOOLS` 之一，
# 而 `mcp.tool_specs()` 默认不发这一类——主循环在 `tools` 里点了名也没用，子代理手里不会出现它。
# 与纪律 5「无人值守那条路不拿 delegate」同一条思路：**没有"这一轮"可问的路径，就不给破坏性能力**。
# 名字先留在这张表里，是为了让"写操作有哪些"这一栏仍然完整（读的人才知道它为什么消失）。

MAX_DEPTH = 1  # 深度写死一层（要嵌套就由主循环自己分解、串行两次）
SUB_ROUNDS_CAP = 3  # 子代理轮数上限（父预算减半，再封顶到这里）
TEXT_CAP = 4000  # 交回主循环的结果文本上限：它是**摘要**，不是把子代理的上下文搬过去

# 子代理的默认人设。**不是**把主循环的 system 全带过去（那正是委托要省的东西）。
DEFAULT_PERSONA = (
    "你是一个被主助手委托的子代理，只做下面这一件子任务。"
    "做完用一段话把**结果**交回去（说清你查了什么、得到什么结论），不要写客套话，"
    "也不要把整篇成品贴出来——需要落盘就在拿到 save_artifact 时用它。"
)


@dataclass(frozen=True)
class Parent:
    """主循环交给子代理的那点上下文。**不是**整段对话历史（那正是要隔离的）。

    `model_id` 与 `model_name` 是**两个东西**，混起来就是 2026-09-20 A2 抓到的那个 bug：

    - `model_id`：配置里那个人看得懂的名字（`sensenova/sensenova-6.8-flash-lite`）——
      用来判断「这一步要不要重新解析 provider」；
    - `model_name`：**provider 那一侧认的名字**（`sensenova-6.8-flash-lite`）——真正发给
      API 的是它。把 id 当名字发出去，服务端会回 `400 required model`（A1 装了那么久没炸，
      因为那 16 条任务**一次都没委托**；A2 一接上协作，每一步都炸）。
    """

    provider: ProviderInfo | None = None
    model_id: str = ""
    model_name: str = ""
    max_rounds: int = MAX_TOOL_ROUNDS
    usage: dict = field(default_factory=dict)  # 父那一轮的 token 账（子代理花的钱也记在它头上）


_PARENT: ContextVar[Parent | None] = ContextVar("wb_delegate_parent", default=None)
_DEPTH: ContextVar[int] = ContextVar("wb_delegate_depth", default=0)


def set_parent(
    *,
    provider: ProviderInfo | None = None,
    model_id: str = "",
    model_name: str = "",
    max_rounds: int = MAX_TOOL_ROUNDS,
    usage: dict | None = None,
) -> None:
    """主循环开轮时登记「父是谁」（chat 在 `run_one` 里调）。

    `model_name` 要与 `model_id` **成对**给：只给 id 的话，子代理得再解析一次才知道该把
    哪个名字发给 API（多一次查询，但结果正确——见 `run` 里那段）。
    """
    _PARENT.set(
        Parent(
            provider=provider,
            model_id=model_id or "",
            model_name=model_name or "",
            max_rounds=int(max_rounds or MAX_TOOL_ROUNDS),
            usage=usage if usage is not None else {},
        )
    )


def parent() -> Parent | None:
    return _PARENT.get()


def depth() -> int:
    """现在在第几层委托里（主循环 = 0）。"""
    return int(_DEPTH.get() or 0)


def sub_rounds(parent_rounds: int = MAX_TOOL_ROUNDS) -> int:
    """子代理的轮数预算：**父预算减半**，再封顶到 3，至少 1。Pure。

    `0`/`None` 当作「父没给」→ 按默认父预算（6）算，也就是 3 —— 不把「没给」读成「零轮」。
    """
    par = int(parent_rounds or 0) or MAX_TOOL_ROUNDS
    return max(1, min(SUB_ROUNDS_CAP, max(1, par // 2)))


def allowed_tools(extra=None, *, base=READONLY_TOOLS) -> tuple[list[str], list[str]]:
    """（真正给它的工具名，不认识的）。Pure。

    不认识的**不当场失败**：主循环可能是猜的名字（或者那家 MCP 没连上），
    把名字原样告诉它、让它换个办法，比给一个 `[tool error]` 更有用。

    `base`：底盘（默认只读 + 检索那几个）。传空元组 = **一个工具都不给**——A2 的
    「裸 LLM 那一臂」（v1 的协作行为）就是这么表达的，别处不要用。
    """
    from app.core import mcp

    known = {str(b["name"]) for b in mcp.BUILTIN_TOOLS}
    known.discard(DELEGATE_TOOL)  # 纪律 2：子代理永远拿不到 delegate
    known = {n for n in known if not n.startswith("pet_")}  # 零柒那双手不外包
    wanted = [str(x).strip() for x in (extra or []) if str(x).strip()]
    unknown = [n for n in wanted if n not in known]
    names = [*base]
    for n in wanted:
        if n in known and n not in names:
            names.append(n)
    return names, unknown


async def resolve_agent(name: str) -> dict | None:
    """按名字查 agents 表（纪律 4：**不发明第二套 agent 定义**）。查不到返回 None。"""
    key = (name or "").strip()
    if not key:
        return None
    from sqlalchemy import select

    from app.db import SessionLocal
    from app.models import Agent

    try:
        async with SessionLocal() as db:
            row = (
                await db.execute(select(Agent).where(Agent.name == key))
            ).scalar_one_or_none()
    except Exception:  # noqa: BLE001 - 查不到就当没这个名字（裸 task + 默认配置）
        log.warning("delegate: 查 agents 失败 name=%r", key, exc_info=True)
        return None
    if row is None:
        return None
    return {
        "name": row.name,
        "persona": row.system_prompt or "",
        "model_id": row.model_id or "",
        # A2：这栏现在是一份白名单（空 = 不限制，`none` = 一个都不给），不再是布尔
        "tool_whitelist": row.tool_whitelist or "",
    }


def _specs(names: list[str]) -> list[dict]:
    """按名字取工具规格。**从同一个网关取**（`mcp.tool_specs`），不另造一份声明。

    `include_delegate=False` 是纪律 2 的第一道：子代理的清单里根本没有 delegate。
    `include_memory` 跟着用户那个开关走 —— 主循环拿不到的东西，子代理也不该拿到。
    """
    from app.core.mcp import mcp_manager
    from app.core.prefs import load_config

    all_specs = mcp_manager.tool_specs(
        include_memory=bool(load_config().get("memory_enabled", True)),
        include_delegate=False,
    )
    want = set(names)
    return [s for s in all_specs if s.get("function", {}).get("name") in want]


async def run(
    task: str,
    *,
    agent_name: str = "",
    model_id: str = "",
    tools=None,
    persona: str = "",
    messages: list[dict] | None = None,
    with_readonly: bool = True,
) -> dict:
    """跑一次子代理，返回一份**事实**（text / trace / 花了什么），不抛异常。

    调用方是 `handler`（工具网关）与 `collab`（A2 的编排器），但测试可以直接调它
    （把 provider 那段换成假的）。

    两个给编排器用的入口（`persona` / `messages`）：
    - `persona`：**覆盖**从 agents 表查到的人设（空 = 用表里的，查不到用 `DEFAULT_PERSONA`）；
    - `messages`：**整段**已拼好的 messages（collab 的每一步都有自己的模板：目标 + 上一步产出 +
      检索片段）。给了它就原样用，`task` 只进账本、不再拼进提示词。
    这两条都只是**换提示词**，隔离 / 工具交集 / 轮数 / 记账**一条都不变**——编排器不该
    因为「提示词是我拼的」就绕过那些纪律。

    `with_readonly=False`：连只读底盘都不给（**一个工具都没有**）。它存在的唯一理由是
    A2 的配对对比要一个「裸 LLM 那一臂」（v1 的协作行为）。别处别用。
    """
    from app.core import mcp, turn_trace
    from app.core.report import resolve as resolve_model_info

    started = time.time()
    par = parent()
    out: dict = {
        "task": task,
        "agent_name": (agent_name or "").strip(),
        "model_id": "",
        # provider 那一侧的名字（真正发给 API 的那个）。两者**分开记**：
        # id 是人配的、名字是服务端认的，混成一个字段就会有人拿它去发请求（A2 那个 400）。
        "model_name": "",
        "rounds": 0,
        "tool_calls": [],
        "artifacts": [],
        "text": "",
        "error": "",
        "rounds_exhausted": False,
        "unknown_tools": [],
        "seconds": 0.0,
    }

    if depth() >= MAX_DEPTH:
        # 纪律 2 的第二道闸门（第一道是工具清单里没有 delegate）
        out["error"] = f"已经在第 {depth()} 层委托里：委托只允许一层"
        return out

    agent = await resolve_agent(agent_name)
    if agent_name and agent is None:
        out["unknown_tools"] = []  # 没这个名字 → 裸 task + 默认配置（纪律 4）
    persona = (persona or "").strip() or (agent or {}).get("persona") or DEFAULT_PERSONA
    mid = (model_id or "").strip() or (agent or {}).get("model_id") or (par.model_id if par else "")

    provider = par.provider if (par and par.provider is not None and par.model_id == mid and par.model_name) else None
    if provider is None:
        got = await resolve_model_info(mid)
        if got is None:
            out["error"] = f"解析不出模型 {mid or '(默认)'}"
            return out
        provider, api_model = got
    else:
        api_model = par.model_name
    # **发给 API 的是 provider 那一侧的名字**，不是 `p/m` 这种 id（发错了服务端回 400）。
    # 复用的那条路必须拿到父给的 `model_name`，拿不到就老老实实再解析一次——省一次查询
    # 不值得把 id 当名字发出去。

    names, unknown = allowed_tools(tools, base=READONLY_TOOLS if with_readonly else ())
    out["unknown_tools"] = unknown
    specs = _specs(names)
    if agent is not None:
        # A2：给它的工具 = 「这一步需要的」∩「这个 agent 允许用的」。
        # agent 侧是**上限**（`none` = 一个都不给，`vault_*` = 只许碰 vault）、`tools` 是
        # **下限**（这一步需要什么）——两者取交集，谁也不越权。空白名单 = 不限制。
        from app.core.mcp import filter_specs

        kept = {s["function"]["name"] for s in filter_specs(specs, agent.get("tool_whitelist"))}
        specs = [s for s in specs if s["function"]["name"] in kept]
        names = [s["function"]["name"] for s in specs]

    if messages:  # 编排器拼好的整段提示词（A2）：原样用，只补一层人设都不补
        msgs: list[dict] = [dict(m) for m in messages]
    else:
        msgs = []
        if persona:
            msgs.append({"role": "system", "content": persona})
        msgs.append({"role": "user", "content": str(task or "").strip()})

    sub_trace: dict = {"tool_calls": [], "rounds": 0}
    usage: dict = {}
    sink: list[str] = []

    def _note(name: str, args: dict) -> None:
        out["tool_calls"].append({"name": name})

    def _collect(meta: dict) -> None:
        # 子代理落盘时把回执收好（它不进主循环的 `_TOOL_META`，这里自己接）
        art = (meta or {}).get("artifact")
        if isinstance(art, dict):
            out["artifacts"].append(art)

    rounds = sub_rounds(par.max_rounds if par else MAX_TOOL_ROUNDS)

    async def _in_its_own_task() -> str:
        """**隔离**：在自己的 Task（= 上下文的一份拷贝）里开轮与跑循环。

        `mcp.begin_turn(None)` 在这里做：子代理的落盘额度、产出清单、字数预算都是它自己的，
        主循环那一轮的两条修订额度一根手指都不动（这条有测试钉着）。
        """
        mcp.begin_turn(None)
        token = _DEPTH.set(depth() + 1)
        try:
            return await run_agentic_chat(
                provider,
                api_model,
                msgs,
                specs,
                mcp.mcp_manager.call_tool,
                sink.append,
                _note,
                max_rounds=rounds,
                usage=usage,
                # 串行跑子代理的工具：省那点延迟不值得在「一个子代理里」再引并发
                parallel_tools=False,
                emit_tool_result=lambda name, args, meta: _collect(meta),
                trace=sub_trace,
            )
        finally:
            _DEPTH.reset(token)

    child = asyncio.create_task(_in_its_own_task())
    try:
        text = await child
    except asyncio.CancelledError:
        # 主循环被掐断（用户点了「停止」/ 客户端断线）——**子代理也得停**：
        # `await child` 不会把取消自动传下去，不显式 cancel 的话它会继续烧钱，
        # 而用户那边已经什么都看不到了。
        child.cancel()
        raise
    except Exception as e:  # noqa: BLE001 - 子代理炸了不该炸主循环
        log.warning("delegate: 子代理跑挂了 agent=%r model=%r", agent_name, mid, exc_info=True)
        out["error"] = f"{type(e).__name__}: {e}"
        text = ""

    out.update(
        {
            "model_id": mid,
            "model_name": api_model,
            "text": (text or "").strip(),
            "rounds": int(sub_trace.get("rounds") or 0),
            # 轮数烧光 → 上面那段 text 其实是**占位符**，不是答案。这条必须传出去：
            # 不然「子代理没给出答案」在调用方眼里与「答完了」长得一模一样（A2 撞到过）。
            "rounds_exhausted": bool(sub_trace.get("rounds_exhausted")),
            "tool_calls": [
                {"name": str(c.get("name") or "")} for c in (sub_trace.get("tool_calls") or [])
            ]
            or out["tool_calls"],
            "seconds": round(time.time() - started, 1),
        }
    )
    # 父那一轮的 token 账要把它算进去（钱是用户付的）
    if par is not None:
        for key in ("input", "output"):
            par.usage[key] = int(par.usage.get(key) or 0) + int(usage.get(key) or 0)

    # 委托有账（纪律 3）：挂回主循环这一轮的 trace 草稿；账本那一列由 `turn_trace._write` 落库
    draft = turn_trace.current()
    if draft is not None:
        draft.setdefault("sub_traces", []).append(
            {
                "agent": out["agent_name"],
                "model_id": out["model_id"],
                "rounds": out["rounds"],
                # 轮数烧光（子代理只吐出占位符）——**这一列是 JSON，加字段不用迁移**
                "rounds_exhausted": out["rounds_exhausted"],
                "tools": [c["name"] for c in out["tool_calls"]],
                "artifacts": [str(a.get("path") or "") for a in out["artifacts"]],
                "tokens_in": int(usage.get("input") or 0),
                "tokens_out": int(usage.get("output") or 0),
                "seconds": out["seconds"],
                "error": out["error"],
            }
        )
    return out


def render(result: dict) -> str:
    """子代理的结果 → 交回主循环的那段文本。Pure。

    **是摘要，不是搬运**：正文封顶 `TEXT_CAP`，并明说截断过（不然主循环会以为那就是全部）。
    """
    if result.get("error") and not result.get("text"):
        return f"[子代理失败] {result['error']}"
    head = (
        f"[子代理 · {result.get('agent_name') or '默认'} · {result.get('model_id')}"
        f" · {result.get('rounds')} 轮 · {len(result.get('tool_calls') or [])} 次工具]"
    )
    body = (result.get("text") or "").strip() or "（子代理没有给出文字结果）"
    cut = ""
    if len(body) > TEXT_CAP:
        body = body[:TEXT_CAP]
        cut = f"\n…（子代理结果超过 {TEXT_CAP} 字，已截断）"
    notes: list[str] = []
    if result.get("unknown_tools"):
        notes.append("不认识的工具（已忽略）：" + "、".join(result["unknown_tools"]))
    if result.get("artifacts"):
        notes.append(
            "子代理落盘：" + "、".join(str(a.get("path") or "?") for a in result["artifacts"])
        )
    if result.get("error") and result.get("text"):
        notes.append(f"（跑的时候出过错：{result['error']}）")
    tail = ("\n" + "\n".join(notes)) if notes else ""
    return f"{head}\n{body}{cut}{tail}"


async def handler(args: dict) -> str:
    """`delegate` 这个工具的处理器（`mcp.py` 里那一份规格指向它）。

    参数：`task`（必填）、`agent_name?`、`model_id?`、`tools?`（**额外**要给它的工具名，
    默认只有只读 + 检索那几个）。
    """
    args = args or {}
    task = str(args.get("task") or "").strip()
    if not task:
        return "[tool error] delegate 需要 task（要委托的那件事，一句话）"
    tools = args.get("tools")
    if isinstance(tools, str):  # 模型有时写成逗号分隔的字符串
        tools = [x for x in tools.replace("，", ",").split(",") if x.strip()]
    if tools is not None and not isinstance(tools, list):
        tools = []
    result = await run(
        task,
        agent_name=str(args.get("agent_name") or ""),
        model_id=str(args.get("model_id") or ""),
        tools=tools,
    )
    from app.core import mcp

    # 给界面的一条结构化摘要（子代理的产出回执也带走，见 chat 的 tool_result 处理）
    meta = {
        "delegate": {
            "agent": result.get("agent_name") or "",
            "model_id": result.get("model_id") or "",
            "rounds": result.get("rounds") or 0,
            "tools": [c.get("name") for c in (result.get("tool_calls") or [])],
            "seconds": result.get("seconds") or 0.0,
            "error": result.get("error") or "",
        }
    }
    if result.get("artifacts"):
        meta["artifacts"] = result["artifacts"]
    mcp._TOOL_META.set(meta)  # noqa: SLF001 - 这就是那条旁路（`call_tool` 会取走它）
    return render(result)


def sub_trace_summary(draft: dict | None) -> str:
    """账本草稿里的委托记录 → 一句话（给测试与排查用，不参与判定）。"""
    items = (draft or {}).get("sub_traces") or []
    if not items:
        return ""
    return json.dumps(items, ensure_ascii=False)
