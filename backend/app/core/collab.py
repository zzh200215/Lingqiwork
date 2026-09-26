"""Agent collaboration: deterministic multi-agent runs (no autonomous
orchestration — the supervisor's dispatch logic is a pure function here, and
that is written in stone; see Agent升级.md §4).

Three shapes:

- pipeline: agents run in sequence, each building on the previous output;
- review:   agents[0] drafts → agents[1] critiques → agents[0] revises;
- fanout:   every agent works the same goal **in parallel**, then agents[0]
            merges the branches into one result (fan-out / fan-in).

**A2（2026-09-20）：每一步从「裸 LLM 调用」换成「可带工具的子代理」**。执行体走 A1 的
`delegate.run` 通道 —— 于是每一步自动继承那五条纪律：独立 messages / 独立上下文、工具白名单、
轮数封顶（父预算减半、上限 3）、agents 表就是登记处、**永远拿不到 `delegate`**。
v1 那句「工具全关，因为协作本来就贵」的顾虑反过来用 A1 的纪律解：**每步只给该步需要的工具 +
轮数封顶**，比「一个 agent 拿全套工具跑 6 轮」更可控，而且每一笔都记在账上（`done.facts`）。

**并行是编排器说了算**：`build_waves` 决定哪些 step 同属一波（互不依赖），模型自己**没有**
并行分派的能力（它的工具清单里没有这种东西，也没有任何字段能让它声明依赖）。
同一波用 `asyncio.gather(return_exceptions=True)` 跑——某一路失败不拖垮其余，汇总步把
失败的那一路**如实**写进提示词（`compose_messages(..., branches=...)`）。

**串行波里的失败仍然中止整轮**（v1 的行为）：下游的输入没了，硬跑下去是编出来的接力。

**roundtable 不在这里，也不给它工具**：圆桌的价值是视角碰撞、不是执行（它自己的注释写着
「圆桌是接话，不是演讲」）。这条有测试钉着（`tests/test_collab.py`）。
"""
import asyncio
import logging

from app.core import usage_ledger

log = logging.getLogger(__name__)

PATTERNS = ("pipeline", "review", "fanout")
PATTERN_LABELS = {"pipeline": "流水线", "review": "评审回路", "fanout": "并行分派"}
MIN_AGENTS = 2
MAX_AGENTS = 4
MAX_GOAL_CHARS = 4000
MAX_STEP_OUT_CHARS = 8000  # per-step output fed to the next step
READ_FEED_CHARS = 2000  # 一份材料的「读」产出喂给「结论」步时的上限（几份拼起来也不撑爆）
MAX_STEP_TOKEN_WORDS = 900  # nudge steps to stay focused
RAG_TOP_K = 5

# 每一步要用的工具（`[]` = 只用只读基线）。**这里是编排器的判定**：v1 的「工具全关」变成
# 「按需给、每步写清」。给的是 `delegate.allowed_tools` 那个「额外工具」的意思。
#
# **第一版一条写工具都不给**（`save_artifact` 也不给）：v1 协作的产物是**对话里的一份纪要**
# （路由把它落成一条消息），不是产出区的成品。给写工具等于顺手改了产品的交付方式——
# 那是另一笔。A2 只把「每步工具白名单」这条机制建起来并让它在账上看得见。
_STEP_TOOLS: dict[str, list[str]] = {
    "work": [],
    # ②（2026-09-20 挂账）：fanout 拆成「读材料 → 合成结论 → 汇总」之后多出来的两种 phase。
    # 它们同样一个写工具都不给（见上面那段理由）。
    "read": [],
    "digest": [],
    "draft": [],
    "review": [],
    "revise": [],
    "merge": [],
}

_STEP_ICONS = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣"]

_DEFAULT_SYSTEM = "你是协作团队中的一名成员，专注完成分配给你的环节。"

_REVIEW_SYSTEM = (
    "你是严格的评审。审阅给出的文稿，指出事实错误、逻辑断层、结构问题和遗漏，"
    "给出编号的、可执行的修改清单；不要重写全文，不要客套。"
)

_REVISION_INSTRUCTION = (
    "请参考评审意见输出修订后的完整终稿，直接输出全文，"
    "不要输出修改说明或评审回应。未被评审意见涉及的部分保持原样。"
)

_MERGE_SYSTEM = (
    "你是汇总者。下面是同一件事的几路独立结果，请把它们合成为一份结论："
    "同意的部分合并、冲突的部分**并列说清分歧**、缺失的部分明说缺什么。"
    "不要复述每一路的全文，也不要客套。"
)

# ② 的两段式：先把「读」和「成文」拆开，各自都小到能在 3 轮里做完。
# 实测（A2 三轮回放）：「找文件 + 读 + 提炼 + 成文」挤在一步里，3 轮必然烧光——
# B 轮 `fanout` 四步全交占位符、C 轮 `review` 也烧光。按拍板，这是**任务形状**的问题，
# 不是预算的问题，所以解法是把一步的活拆成两步，而不是把轮数加上去。
_READ_INSTRUCTION = (
    "只读**这一份**材料，把其中的具体事实（数字、结论、判断）逐条列出来，"
    "每条后面用 `（出处：<路径>）` 标一下。不要写成成品、不要发挥、不要客套。"
)
_DIGEST_INSTRUCTION = (
    "上面这些材料**已经有人替你读过了**，事实就在下面。你的活是把它们合成**这一路**的结论："
    "保留具体数字与结论、把彼此矛盾的地方并列说清。"
    "**不要再列目录、也不要重复读一遍材料**——把轮数用在结论上。"
)


def _make_step(agent: dict, title: str, phase: str, group: str, focus=None) -> dict:
    return {
        "agent": agent,
        "title": title,
        "phase": phase,
        "tools": list(_STEP_TOOLS.get(phase, [])),
        "parallel_group": group,
        # fanout 每一路**被分到哪几份材料**（编排器分的，见 `build_waves`）。
        # 这是「supervisor 把活分匀」的落地：一路只知道自己的那几份，汇总步看大家的产出。
        # 空 = 没分（调用方没给材料清单）→ 回到「各自看着办」的老行为。
        "focus": list(focus or []),
    }


def _stem(name: str) -> str:
    """材料路径 → step 标题里那一小截（`notes/2026-09-19-索引练习.md` → `2026-09-19-索引练习`）。

    标题会出现在逐步账、`step_focus`、界面那几行里，所以**夹一下长度**：一份材料的长路径
    能把一行撑到看不见重点。Pure。
    """
    base = str(name or "").replace("\\", "/").split("/")[-1]
    if base.endswith(".md"):
        base = base[:-3]
    return base if len(base) <= 24 else base[:23] + "…"


def split_materials(materials: list[str], parts: int) -> list[list[str]]:
    """把材料**按顺序轮流**分给 N 路（尽量均分）。Pure。

    为什么是轮流而不是「前一半/后一半」：轮流的切片在材料份数不能被路数整除时更均匀
    （6 份分 4 路 → 2/2/1/1，而不是 2/2/1/1 的另一种排法导致某一路全是大文件）。
    顺序稳定（调用方先排好序），所以**同一批材料每次分到的结果一样**——可复现才可对比。
    """
    n = max(1, int(parts))
    out: list[list[str]] = [[] for _ in range(n)]
    for i, name in enumerate(materials or []):
        out[i % n].append(str(name))
    return out


def build_waves(
    pattern: str, agents: list[dict], materials=None, *, split_reads: bool = True
) -> list[list[dict]]:
    """Plan the run as **waves**（同一波内的 step 互不依赖，可以并行）。Pure。

    **「互不依赖」由这个函数判定，不由模型判定**（Agent升级.md §4 的纪律）。
    `pipeline` / `review` 每一波只有一个 step（串行语义与 v1 一字不差）；`fanout` 是
    「第一波各自开工 + 最后一波汇总」，而**第一波是几路取决于有没有材料清单**：
    没材料 → 一路一个 agent（老形状）；有材料 → 先每份材料一个读步、再一路一个结论步。

    `materials`（可选）：材料清单（相对路径）。给了就把它们**分给第一波那几路**
    （见 `split_materials`）——「谁能读什么」是编排器的判定，不该由模型各自去猜；
    2026-09-20 实测里正因为没有分工，三路各自反复 `vault_list_files`，
    把每一步 3 轮的预算全烧在找文件上。

    `split_reads`（默认开）：fanout 有材料时**把「读」拆成单独的 step**（②挂账，
    见下面那段）。关掉就回到单段式（读+成文挤在一步里）——那是给 A/B 用的对照臂，
    产品路径永远用默认值。
    """
    if pattern not in PATTERNS:
        raise ValueError(f"未知协作模式: {pattern}")
    if not (MIN_AGENTS <= len(agents) <= MAX_AGENTS):
        raise ValueError(f"协作需要 {MIN_AGENTS}~{MAX_AGENTS} 个智能体")

    if pattern == "review":
        a, b = agents[0], agents[1]
        return [
            [_make_step(a, f"初稿 · {a['name']}", "draft", "")],
            [_make_step(b, f"评审 · {b['name']}", "review", "")],
            [_make_step(a, f"修订终稿 · {a['name']}", "revise", "")],
        ]
    if pattern == "fanout":
        mats = [str(m) for m in (materials or [])]
        merge = _make_step(agents[0], f"汇总 · {agents[0]['name']}", "merge", "")
        if not mats or not split_reads:
            # 没给材料清单 → 没得分工；`split_reads=False` → 那是对照臂（② 之前的形状）。
            # 两种都回到单段式：读+成文挤在一步里。
            head = [_make_step(a, a["name"], "work", "fanout", []) for a in agents]
            return [head, [merge]]
        # **两段式**（②挂账的落地）：读材料（每份一个 step，各自只读一份）→ 各自把读到的
        # 合成结论 → 汇总。三步的活被摊到三波，每一步的活都小到能在 3 轮里做完。
        slices = split_materials(mats, len(agents))
        reads = [
            _make_step(
                agents[i % len(agents)], f"读材料 · {_stem(name)}", "read", "fanout", [name]
            )
            for i, name in enumerate(mats)
        ]
        digests = [
            _make_step(a, f"结论 · {a['name']}", "digest", "fanout", slices[i])
            for i, a in enumerate(agents)
        ]
        return [reads, digests, [merge]]
    return [[_make_step(a, a["name"], "work", "")] for a in agents]


def build_steps(
    pattern: str, agents: list[dict], materials=None, *, split_reads: bool = True
) -> list[dict]:
    """Plan the run, flattened（一波一步 = 串行）。Pure; raises ValueError on bad config。

    每一步：`{agent, title, phase, tools, focus, parallel_group}` —— phase 决定提示词模板，
    `tools` 是**这一步额外要的工具**（只读基线不用写，`delegate` 永远拿不到），
    `focus` 是这一步负责的材料（只有 fanout 会分）。想按波次跑用 `build_waves`。
    """
    return [s for wave in build_waves(pattern, agents, materials, split_reads=split_reads) for s in wave]


def header_md(pattern: str, agents: list[dict], *, parallel: bool = False) -> str:
    if pattern == "review":
        chain = f"{agents[0]['avatar']} {agents[0]['name']} ⟳ {agents[1]['avatar']} {agents[1]['name']}"
    elif pattern == "fanout":
        chain = " ∥ ".join(f"{a['avatar']} {a['name']}" for a in agents) + " → 🧩 汇总"
    else:
        chain = " → ".join(f"{a['avatar']} {a['name']}" for a in agents)
    mark = " · 并行" if parallel and pattern == "fanout" else ""
    return f"> 👥 **协作 · {PATTERN_LABELS[pattern]}**{mark} — {chain}\n"


def _cap(text: str, limit: int = MAX_STEP_OUT_CHARS) -> str:
    text = text.strip()
    return text if len(text) <= limit else text[:limit] + "\n…（超长截断）"


def compose_messages(
    step: dict,
    goal: str,
    prev: str | None,
    prev_title: str,
    rag_block: str,
    *,
    branches: list[dict] | None = None,
) -> list[dict]:
    """Build the chat messages for one step. Pure.

    `branches`（fanout 的汇总步）：`[{title, text, error}]` —— 每一路的产出，**失败的也在里面**
    （不让汇总者以为那一路没跑）。
    """
    agent = step["agent"]
    phase = step["phase"]
    system = (agent.get("system_prompt") or "").strip() or _DEFAULT_SYSTEM
    if phase == "merge":
        system = _MERGE_SYSTEM
    messages: list[dict] = [{"role": "system", "content": system}]
    # 检索片段给「要对着材料说话」的那几步。**`read` / `digest` 也在里面**：裸 LLM 那一臂
    # 一个工具都没有，RAG 是它唯一能看见材料的路——不给的话两臂的差别就不只是「有没有工具」了
    # （那正是配对对比那条纪律要求不能发生的事）。
    if rag_block and phase in ("work", "draft", "read", "digest"):
        messages.append({"role": "system", "content": rag_block})

    if phase == "read":
        focus = [str(x) for x in (step.get("focus") or [])]
        user = f"【目标】\n{goal}"
        if focus:
            # 一份材料一个 step：**既别去列目录、也别顺手把别人的读了**——这一小步的预算
            # 只够读完它自己（这正是 ② 要的「更多更小的 step」）。
            user += (
                "\n\n【你负责的材料】\n"
                + "\n".join(f"- `{name}`" for name in focus)
                + "\n\n只读上面这一份（直接用 `vault_read_file` 打开），"
                "**不用去列目录、也不用读别人的**。\n\n" + _READ_INSTRUCTION
            )
        else:
            user += "\n\n" + _READ_INSTRUCTION
    elif phase == "digest":
        focus = [str(x) for x in (step.get("focus") or [])]
        reads = step.get("reads") or {}
        parts = []
        for name in focus:
            body = _cap(str(reads.get(name) or ""), READ_FEED_CHARS) or "（这一份没有读到内容）"
            parts.append(f"【{name}】\n{body}")
        user = (
            f"【目标】\n{goal}\n\n【你负责的材料（已读，事实如下）】\n"
            + ("\n\n".join(parts) if parts else "（没有分到材料）")
            + "\n\n"
            + _DIGEST_INSTRUCTION
        )
    elif phase == "work":
        user = f"【目标】\n{goal}"
        focus = [str(x) for x in (step.get("focus") or [])]
        if focus:
            # 被分到哪几份就只读哪几份：**别再去列整个目录**——那会把这几轮的预算烧光。
            user += (
                "\n\n【你负责的材料】\n"
                + "\n".join(f"- `{name}`" for name in focus)
                + "\n\n只读上面这几份（直接用 `vault_read_file` 打开），"
                "**不用去列目录、也不用读别人的**；读完后把你的结论写出来。"
            )
        if prev:
            user += f"\n\n【上一步产出（来自 {prev_title}）】\n{_cap(prev)}\n\n请在此基础上完成你负责的环节，不要重复上游内容。"
    elif phase == "draft":
        user = f"【任务】\n{goal}\n\n请写出完整的初稿。控制在 {MAX_STEP_TOKEN_WORDS} 词以内。"
    elif phase == "review":
        user = f"【原始任务】\n{goal}\n\n【待评审文稿（来自 {prev_title}）】\n{_cap(prev)}"
    elif phase == "merge":
        parts = []
        for b in branches or []:
            body = _cap(b.get("text") or "") or "（这一路没有产出）"
            note = f"（**这一路失败**：{b['error']}）" if b.get("error") else ""
            parts.append(f"【{b.get('title') or '一路'}】{note}\n{body}")
        user = (
            f"【原始任务】\n{goal}\n\n下面几路是**独立完成**的，互相没见过对方的结果：\n\n"
            + "\n\n".join(parts)
            + "\n\n请合成一份结论。"
        )
    else:  # revise
        user = (
            f"【原始任务】\n{goal}\n\n【你的初稿（来自 {prev_title}）】\n{_cap(prev)}\n\n"
            f"【评审意见】\n{_cap(step.get('review_notes') or '', 4000)}\n\n{_REVISION_INSTRUCTION}"
        )
    messages.append({"role": "user", "content": user})
    return messages


def build_rag_block(sources: list[dict]) -> str:
    """Same spirit as chat's RAG context, trimmed for a collaboration step."""
    if not sources:
        return ""
    lines = ["以下是从用户知识库检索到的资料片段，供参考引用："]
    for s in sources[:RAG_TOP_K]:
        text = (s.get("text") or "").strip()
        if text:
            lines.append(f"---\n[{s.get('source', '未知来源')}]\n{text[:1200]}")
    return "\n".join(lines) if len(lines) > 1 else ""


def step_messages(step: dict, goal: str, rag_block: str, state: dict) -> list[dict]:
    """按 step 的 phase 从 `state` 取它要的前文，拼出 messages。Pure。

    `state`：`{draft, draft_title, prev, prev_title, review_notes, branches}`。
    串行语义与 v1 一字不差（**revise 拿的是初稿，不是评审稿**），只是搬进一个函数，
    好让「并行那几步各自拼自己的」成立：同一波里的每一步都拿到**同一份** state。
    """
    if step["phase"] == "revise":
        step = {**step, "review_notes": state.get("review_notes") or ""}
        prev, prev_title = state.get("draft") or "", state.get("draft_title") or ""
    elif step["phase"] == "digest":
        # **只给它自己那几份的读产出**（`reads` 是 `{材料路径: 读出来的事实}`）。
        # 给它全部就等于把那几路的墙拆了——fanout 的价值正在于几路互不影响地成稿。
        step = {**step, "reads": state.get("reads") or {}}
        prev, prev_title = state.get("prev"), state.get("prev_title") or ""
    else:
        prev, prev_title = state.get("prev"), state.get("prev_title") or ""
    return compose_messages(
        step, goal, prev, prev_title, rag_block, branches=state.get("branches")
    )


def _fact(spec: dict, *, error: str = "", **patch) -> dict:
    return {
        "step": 0,
        "title": spec["title"],
        "phase": spec["phase"],
        "agent": str(spec["agent"].get("name") or ""),
        "model_id": "",
        "text": "",
        "rounds": 0,
        "tools": [],
        "artifacts": [],
        "seconds": 0.0,
        "error": error,
        # 轮数烧光：这一步只吐出占位符，**没有答案**（别把它读成「跑成了」）
        "rounds_exhausted": False,
        "parallel": bool(spec.get("parallel_group")),
        **patch,
    }


async def _run_step(
    step: dict,
    goal: str,
    rag_block: str,
    state: dict,
    resolve,
    *,
    step_no: int,
    tools: bool = True,
) -> dict:
    """跑一步，返回一份**事实**（自己不抛；炸了由 `gather` 兜住）。

    执行体是 `delegate.run`——**不是**这里另写一遍循环。这一步很要紧：隔离（自己的 Task、
    自己的落盘额度）、工具交集、轮数封顶、取消传播全在那一处，协作沿用同一套。

    `tools=False`：连只读底盘都不给（**每一步都是裸 LLM 调用**，也就是 v1 的协作行为）。
    只有配对对比的「裸 LLM 那一臂」会用它。
    """
    from app.core import delegate

    agent = step["agent"]
    mid = str(agent.get("model_id") or "")
    resolved = await resolve(mid)
    info, model = (resolved.provider, resolved.model) if hasattr(resolved, "provider") else resolved
    # 用工编排器**刚解析出来的** provider（`_PARENT` 里登记一下就不用再解析一遍）。
    # 这是每个 step 自己的 Task，所以并行那几路各登记各的，不会互相串。
    # **id 与名字都要给**：只给 id 的话子代理会把它当模型名发给服务端（`400 required model`）。
    delegate.set_parent(provider=info, model_id=mid, model_name=str(model or ""))
    got = await delegate.run(
        f"协作 · {step['title']}",
        agent_name=str(agent.get("name") or ""),
        model_id=mid,
        tools=list(step.get("tools") or []),
        # 每一步的人设与提示词由编排器给全（delegate 那边不再去猜）
        persona=(agent.get("system_prompt") or "").strip(),
        messages=step_messages(step, goal, rag_block, state),
        with_readonly=tools,
    )
    # 模型名：子代理自己报了就用它的；没报（比如它压根没跑起来）就用编排器解析到的那个。
    # **别假设 `info` 一定是 ProviderInfo**（测试与别处的 `resolve` 可能给个字符串）——
    # 这里崩一下，整条协作就变成「某一步失败」，而失败原因写着 AttributeError，很难查。
    label = f"{getattr(info, 'kind', '') or info}:{model}"
    return _fact(
        step,
        step=step_no,
        model_id=got.get("model_name") or label,
        text=(got.get("text") or "").strip(),
        rounds=int(got.get("rounds") or 0),
        tools=[str(c.get("name") or "") for c in (got.get("tool_calls") or [])],
        artifacts=[str(a.get("path") or "") for a in (got.get("artifacts") or [])],
        seconds=float(got.get("seconds") or 0.0),
        error=got.get("error") or "",
        rounds_exhausted=bool(got.get("rounds_exhausted")),
    )


@usage_ledger.traced("collab")
async def run(
    goal: str,
    agents: list[dict],
    pattern: str,
    resolve,  # async (model_id: str) -> (ProviderInfo, model)
    retrieve=None,  # async (query: str, top_k: int) -> list[dict] | None
    *,
    tools: bool = True,
    materials=None,
    split_reads: bool = True,
):
    """Execute the collaboration. Async generator of (event, data) tuples.

    Events: meta / sources / delta / step / error / done.

    Deltas carry the full markdown transcript incrementally (header + step sections),
    so the client just appends them to one message. `done` 还带一份 `facts`：
    **每一步的账**（谁跑的、几轮、调了哪些工具、几秒、有没有错）——A2 的验收
    「每步工具白名单生效」与「并行 vs 串行延迟」都从它读。

    `materials`：材料清单（相对路径，调用方排序好）。给了就把它们**分给 fanout 第一波那几路**
    （`split_materials`）——**「谁能读什么」是编排器的判定**，不给的话模型各自去猜，
    实测会把每步的轮数预算烧在找文件上。（生产路径目前不传这份清单，见 §3 的边界记录。）
    """
    goal = (goal or "").strip()
    if not goal:
        raise ValueError("目标为空")
    if len(goal) > MAX_GOAL_CHARS:
        raise ValueError(f"目标超过 {MAX_GOAL_CHARS} 字上限")
    waves = build_waves(pattern, agents, materials, split_reads=split_reads)
    steps = [s for wave in waves for s in wave]
    parallel = any(len(w) > 1 for w in waves)

    yield "meta", {
        "pattern": pattern,
        "parallel": parallel,
        # A2 的配对对比要能看出这一轮是哪一臂（带工具 / 裸 LLM）
        "tools": bool(tools),
        "agents": [
            {"name": a["name"], "avatar": a["avatar"], "model_id": a.get("model_id", "")}
            for a in agents
        ],
        "steps": [s["title"] for s in steps],
        # 每一步被允许用什么工具 —— 界面上看得出「这一步的手绑到哪」
        "step_tools": {s["title"]: list(s.get("tools") or []) for s in steps},
        # 谁负责哪几份材料（编排器分的）；没分就是空表
        "step_focus": {s["title"]: list(s.get("focus") or []) for s in steps},
        # ②：这一轮用的是哪种 fanout 形状（拆读步 / 单段式）——报告与人审都要看得出是哪一臂
        "split_reads": bool(split_reads),
    }

    transcript = [header_md(pattern, agents, parallel=parallel)]
    yield "delta", {"text": transcript[0]}

    rag_block = ""
    if retrieve is not None:
        try:
            sources = await retrieve(goal, RAG_TOP_K)
        except Exception as e:  # noqa: BLE001 - RAG failure must not break the run
            log.warning("collab retrieval failed: %s", e)
            sources = []
        if sources:
            rag_block = build_rag_block(sources)
            yield "sources", {"sources": sources}

    state: dict = {"prev": None, "prev_title": "", "draft": "", "draft_title": "", "review_notes": ""}
    reads: dict[str, str] = {}  # ②：`{材料路径: 那一步读出来的事实}`
    facts: list[dict] = []
    ok = True
    step_no = 0
    parallel_latency = 0.0
    serial_latency = 0.0

    for wave in waves:
        # 同一波内**没有上下游关系**：各自用同一份 state 拼提示词
        # （fanout 第一波就是「同一件事、各写一版」，谁都不看谁）。
        results = await asyncio.gather(
            *(
                _run_step(
                    s, goal, rag_block, dict(state), resolve, step_no=step_no + i + 1, tools=tools
                )
                for i, s in enumerate(wave)
            ),
            return_exceptions=True,
        )
        branch_out: list[dict] = []
        wave_seconds = 0.0
        fatal = False
        for s, res in zip(wave, results):
            step_no += 1
            if isinstance(res, BaseException):
                # gather 兜住的那一路：不能让它毁掉整轮
                log.warning("collab step failed: %s", s["title"], exc_info=res)
                res = _fact(s, step=step_no, error=f"{type(res).__name__}: {res}")
            res["step"] = step_no
            wave_seconds = max(wave_seconds, float(res.get("seconds") or 0.0))
            section = f"\n\n## {_STEP_ICONS[min(step_no - 1, len(_STEP_ICONS) - 1)]} {s['title']}\n\n"
            transcript.append(section)
            yield "delta", {"text": section}
            if res["error"]:
                yield "error", {"message": f"第 {step_no} 步「{s['title']}」失败：{res['error']}"}
                ok = False
                fatal = len(wave) == 1  # 串行波失败：下游的输入没了，别硬接力
            elif not res["text"]:
                yield "error", {"message": f"第 {step_no} 步「{s['title']}」返回空内容"}
                ok = False
                fatal = len(wave) == 1
            if res["text"]:
                transcript.append(res["text"])
                yield "delta", {"text": res["text"]}
            facts.append(res)
            # 每一步跑完就把账流给界面（不必等整轮结束）
            yield "step", {"fact": res}
            branch_out.append({"title": res["title"], "text": res["text"], "error": res["error"]})
            if res["phase"] == "review":
                state["review_notes"] = res["text"]
            elif res["phase"] == "draft":
                state["draft"], state["draft_title"] = res["text"], res["title"]
            elif res["phase"] == "read":
                # ②：把「一份材料读出了什么」记在路径上——下一步（digest）按自己的 focus 取用，
                # **不是**把整波读产出都灌给它（那就等于三路互相看见了）。
                for ref in s.get("focus") or []:
                    reads[str(ref)] = res["text"]
                state["reads"] = reads
            if len(wave) == 1:  # 串行波：这一步就是下一步的上游
                state["prev"], state["prev_title"] = res["text"], res["title"]
        if len(wave) > 1:  # fanout 第一波：几路一起交给汇总步
            state["branches"] = branch_out
            state["prev"] = "\n\n".join(f"【{b['title']}】\n{b['text']}" for b in branch_out)
            state["prev_title"] = "、".join(b["title"] for b in branch_out)
            parallel_latency += wave_seconds
        else:
            serial_latency += wave_seconds
        if fatal:
            break

    yield "done", {
        "ok": ok,
        "steps": len(steps),
        "transcript": "".join(transcript),
        "facts": facts,
        # 并行与串行的**墙钟**分开给：对比串行版延迟就靠这两个数
        # （并行那一波按「最慢的一路」算，正是 fan-out 想要的那个效果）
        "parallel_seconds": round(parallel_latency, 1),
        "serial_seconds": round(serial_latency, 1),
    }


def facts_summary(facts: list[dict]) -> str:
    """每一步的账 → 一行话（给日志与排查用，不参与判定）。Pure。"""
    if not facts:
        return ""
    return " · ".join(
        f"{f.get('title')}:{f.get('rounds')}轮/{len(f.get('tools') or [])}工具/{f.get('seconds') or 0}s"
        for f in facts
    )
