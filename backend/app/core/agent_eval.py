"""任务级评测基线（A0）：**「事办成了没有」这把尺子**。

**它补的是哪条缺口（Agent升级.md §1.5）。** W1 量的是**底线**（谎报率、编造路径率——"有没有
做坏事"），没有量**胜任**（"任务办成没有、几轮办成的、工具用对没有"）。而 `turn_traces`
账本里 rounds / tool_calls / artifacts **原料全在**——缺的只是一份金标任务集和一个读法。

**不新增任何埋点**：每个任务的数都从这一轮自己的 `turn_trace` 与产出回执里读。跑一条任务
= 走产品自己那条路（`chat._generate`），所以量的是真东西，不是拼装出来的近似。

**判据一处都不另写**：
  - 「完成」用的是 W1 那两个 code（`not_saved` / `saved_when_asked_nothing`）——任务级
    完成率就是它，`turn_eval.check_turn` **原样复用**；
  - 「底线」无条件跑一遍 `turn_quality.findings`（线上每一轮跑的就是这个函数）；
  - A0 自己只加三条，都是回合级尺子**看不见**的东西：**工具白名单**（用了不该用的）、
    **该用的工具**（没查材料就动笔）、**轮数预算**（花了几轮）。

**红线**：只进脚本与曲线，不进零柒嘴里（#2）；金标不进运行时（#3）——本模块只被
`smoke_agent.py` 与测试导入，检索/路由/聊天任何一条运行路径都不读它。

**为什么完成率不把轮数算进去**：轮数是**成本**，完成是**结果**。混在一起，「慢但办成了」
会被读成「没办成」，而那正是 A1 delegate 要优化的东西（委托省的是轮数与上下文，
不是成功率）。所以报告给三个数：`done`（办成了）、`clean`（还守住了底线与工具规矩）、
`over_budget`（超预算，单独数）。
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import time
from pathlib import Path

log = logging.getLogger(__name__)

BACKEND = Path(__file__).resolve().parents[2]
TASKS_DIR = BACKEND / "evals" / "agent"
DEFAULT_TASKS = TASKS_DIR / "tasks.jsonl"
ANSWER_CAP = 1500  # 报告里留的回复长度（够人审，不至于撑爆）

# 「事办成了没有」= W1 那两个 code + **轮数烧光** + **该接上的那件事没接上**。**不在这里另立
# 一套说法**：前两个是 `turn_eval.check_turn` 给的名字（两处写岔的那天，「完成率」就没人敢信了）；
# `rounds_exhausted` 是 A2 加的第三条，理由见下面 `agent_findings` 里那一段 ——
# **烧光轮数时交回来的是一句占位符，它不是答案**；`missing_marker` 是 A4 加的第四条：
# 一条「问的是手头那件事」的任务，答里连那件事的名字都没有，就是没办成（理由同见那里）。
DONE_CODES = ("not_saved", "saved_when_asked_nothing", "rounds_exhausted", "missing_marker")

# 底线：W2a 那两条 + 编造路径/伪引用。**判定全在 `core/turn_quality.py` 与 `core/citations.py`**，
# 这里只给它们起一个共同的组名，好让报告能说「这一轮底线守住了没有」。
#
# **`long_body_without_a_receipt` 刻意不算在底线里**（2026-09-20 第一轮基线量出来的）：
# 它的原话是「正文很长、却没有任何产出回执」——而对**期望就是不落盘**的那些任务
# （问答 / 正确拒绝），长正文**正是要的结果**。第一轮基线里它响了 3 次，三次全落在
# `must_not_save` 的用例上（684 / 907 / 776 字的两条拒绝 + 一条问答），把它算进
# 「底线失守」等于**把正确答案记成失守**。它仍然逐条数进 `counts`（那一栏看得见），
# 而 `must_save` 却没落盘那种真正的问题由完成判据 `not_saved` 兜着，一条都不会漏。
FLOOR_CODES = (
    "claims_a_save_without_one",
    "invented_path",
    "fake_citation",
)

# A0 自己那四条（回合级尺子看不见的）+ 一条**量不出来就得喊**的。
AGENT_CODES = (
    "tool_not_allowed",
    "tool_not_used",
    "over_budget",
    "wrong_artifact_kind",
    "trace_missing",
    "not_delegated",
    "rounds_exhausted",
    # A4：判据要的那几个「只有注入段里才有」的事实没出现在答里。
    # 它列在这里是为了 `rejudge`：这一条只吃 `reply`，而 `reply` 在报告里留全了（截到
    # ANSWER_CAP，与跑分时**同一个截断**）——所以改判据能免费重判，不必再花一次钱。
    "missing_marker",
)

# **只读基线（2026-09-20 用户拍板）**：所有类别的任务都接受这五个只读工具，任务只额外
# 声明「需要哪些写工具 / 需不需要 delegate」。所以这一栏不再是**每条任务各写一遍**，
# 而是**尺子里的一个常量 + fixture 里的 `tools_extra`**。
#
# 起因是一条假越界：`empty-vault-refuse`（空 vault 下正确拒绝）调了 `memory_list`
# 去确认「真没有」，被记成「工具越界」——而 `memory_list` 是**只读**、且在
# `delegate.READONLY_TOOLS` 里。查一下记忆确认无材料，正是拒绝类任务该做的事。
# 逐条补名字是**对着一次跑分拟合**（上次栽过），所以按类改：任务只说额外的。
#
# 代价写在明处：`tools_allowed: []` 那种「**一个工具都不许调**」的表达**没有了**
# （原来闲聊那条用它）。现在白名单恒为 `BASE_TOOLS ∪ tools_extra`，越界只在
# **写工具与 delegate** 上有效——只读工具不再是可判越界的范围。
BASE_TOOLS: tuple[str, ...] = (
    "vault_read_file",
    "vault_list_files",
    "kb_search",
    "memory_list",
    "skill_load",
)

# `expected` 里**每一栏都必须有人读**（2026-09-20 补，见下面 `validate` 的那段）。
# 前一半是 W1（`turn_eval.check_turn`）消费的，后一半是 A0（`agent_findings`）消费的；
# `receipt_is_one_line` 只喂 LLM 判分（W1 的 `judge_receipt`），A0 不用但它是合法键。
EXPECT_KEYS = frozenset(
    {
        # W1 `check_turn` / W2a / W4 / P3
        "must_save",
        "must_not_save",
        "artifact_kinds",
        "paths_exist",
        "no_invented_path",
        "no_fake_citation",
        "body_not_in_reply",
        "long_body_without_a_receipt",
        "max_per_kind",
        "max_saves",
        "receipt_is_one_line",
        # A0 自己那几条
        "tools_extra",
        "must_call",
        "rounds_budget",
        # A2：这件事**本来适合委托**（几件互不相关的小事 / 边角活），该用上那个能力
        "must_delegate",
        # A4：答里必须出现这些事实（**只有注入段里才有**，见 `validate` 那条防漏规则）
        "answer_contains",
    }
)


def whitelist(expect: dict) -> set[str]:
    """这条任务允许调的工具 = **只读基线 ∪ 任务额外声明的**。Pure。"""
    return set(BASE_TOOLS) | {str(n) for n in (expect.get("tools_extra") or [])}


# ---------- 金标任务集 ----------


def load_tasks(path: Path | str | None = None) -> list[dict]:
    """读金标任务集（jsonl，一行一个任务）。坏行 → 抛错。

    **jsonl 是 source of truth**（对齐 `evals/retrieval/golden.jsonl`）：进 git、可审、
    可回滚；运行记录（报告 JSON）另有去处。坏行当场炸而不是跳过——悄悄少跑一条任务，
    报告会看起来一切正常，那是这个项目最不想再要的那种失败。
    """
    p = Path(path) if path is not None else DEFAULT_TASKS
    if not p.is_file():
        raise FileNotFoundError(f"没有这份金标任务集：{p}")
    out: list[dict] = []
    for i, line in enumerate(p.read_text(encoding="utf-8").splitlines(), 1):
        text = line.strip()
        if not text or text.startswith("//"):
            continue
        try:
            obj = json.loads(text)
        except json.JSONDecodeError as e:
            raise ValueError(f"{p.name} 第 {i} 行不是合法 JSON：{e}") from e
        if not isinstance(obj, dict):
            raise ValueError(f"{p.name} 第 {i} 行不是对象")
        obj["_line"] = i
        out.append(obj)
    return out


def known_tool_names() -> set[str]:
    """内置工具名 + 外部 MCP 的 `{server}__{tool}` 形态。**给白名单查错用。**"""
    try:
        from app.core import mcp

        names = {str(b["name"]) for b in mcp.BUILTIN_TOOLS}
    except Exception:  # noqa: BLE001 - 读不到工具表就不做名字校验，总比拦住整轮强
        log.debug("agent eval: tool inventory unavailable", exc_info=True)
        return set()
    return names


def validate(tasks: list[dict]) -> list[str]:
    """体检金标集 → 问题清单（空 = 合格）。**一个字节都不发给模型**，也是 `--dry` 的全部内容。"""
    problems: list[str] = []
    seen: set[str] = set()
    tools = known_tool_names()
    for t in tasks:
        tid = str(t.get("id") or "").strip()
        where = tid or f"第 {t.get('_line')} 行"
        if not tid:
            problems.append(f"{where}：缺 id")
        elif tid in seen:
            problems.append(f"{where}：id 重复")
        seen.add(tid)
        if not str(t.get("instruction") or "").strip():
            problems.append(f"{where}：缺 instruction")
        if not str(t.get("note") or "").strip():
            # 每条都要写清它对着什么真实来源、为什么是这个期望。**金标要能被复核**——
            # 没有出处的那一条，复核的人只能凭感觉点头，那这个集子就没人敢信了。
            problems.append(f"{where}：缺 note（出处与期望的理由）")
        exp = t.get("expected")
        if not isinstance(exp, dict) or not exp:
            problems.append(f"{where}：缺 expected")
            continue
        # **声明了没人读的期望 = 以为在量、其实没量**（2026-09-20 补）。
        # 起因是量的时候撞出来的：第一版 `artifact_kinds` 写进了 16 条任务，而 W1 的
        # `check_turn` **不查体裁**——于是「落盘体裁不对」这条期望从来没生效过，
        # 而 `--dry`（只查字段齐不齐）照样报绿；等到付费跑分跑到第 6 条才发现，
        # 白杀了一轮。所以 `--dry` 现在也查这一栏：**键不认识就当场红**。
        for key in exp:
            if key not in EXPECT_KEYS:
                problems.append(
                    f"{where}：expected 里的 `{key}` 没有判据消费它（要么拼错了，要么那条判据还没实现）"
                )
        if bool(exp.get("must_save")) == bool(exp.get("must_not_save")):
            # 两者必须**恰好有一个**：两个都不写 = 这条没有完成判据（那它量不了「办成没有」）；
            # 两个都写 = 自相矛盾（那种用例跑出来的结论没法解释）。
            problems.append(f"{where}：must_save / must_not_save 必须恰好有一个")
        vault = t.get("vault")
        if vault is not None and not isinstance(vault, dict):
            problems.append(f"{where}：vault 必须是对象（相对路径 → 正文）")
        for rel in (vault or {}):
            if not isinstance(rel, str) or rel.startswith(("/", "\\")) or ".." in rel.split("/"):
                problems.append(f"{where}：vault 里的路径必须是 vault 内的相对路径：{rel!r}")
        for key in ("tools_extra", "must_call", "artifact_kinds"):
            val = exp.get(key)
            if val is None:
                continue
            if not isinstance(val, list) or any(not isinstance(x, str) or not x for x in val):
                problems.append(f"{where}：{key} 必须是字符串列表")
        if tools:
            for key in ("tools_extra", "must_call"):
                for name in exp.get(key) or []:
                    if "__" in name or name in tools:
                        continue
                    problems.append(f"{where}：{key} 里的工具名不认识：{name}")
            for name in exp.get("must_call") or []:
                if name in BASE_TOOLS:
                    continue
                problems.append(
                    f"{where}：must_call 里的 {name} 不在只读基线里——"
                    "「先看材料」这一栏只该钉只读工具，写工具用 tools_extra 管"
                )
        budget = exp.get("rounds_budget")
        if budget is not None and (not isinstance(budget, int) or budget < 1):
            problems.append(f"{where}：rounds_budget 必须是 ≥1 的整数")
        if "must_delegate" in exp and not isinstance(exp["must_delegate"], bool):
            problems.append(f"{where}：must_delegate 必须是布尔")
        if exp.get("must_delegate") and "delegate" not in whitelist(exp):
            # 「该委托」但白名单里没有 delegate = **这条任务在要求一件做不到的事**
            # （A1 的 fail-closed 默认：无人值守路径拿不到 delegate）。这种自相矛盾的
            # 用例跑出来的结论没法解释，所以 `--dry` 就拦下来。
            problems.append(
                f"{where}：写了 must_delegate，但 tools_extra 里没有 delegate——它做不到"
            )
        kinds = exp.get("artifact_kinds")
        if kinds and not exp.get("must_save"):
            problems.append(f"{where}：写了 artifact_kinds 但没要求 must_save")
        val = exp.get("answer_contains")
        if val is not None and (
            not isinstance(val, list) or any(not isinstance(x, str) or not x for x in val)
        ):
            problems.append(f"{where}：answer_contains 必须是非空字符串列表")
        problems.extend(_validate_thread(t, exp, where, vault))
    if not tasks:
        problems.append("任务集是空的")
    return problems


def _validate_thread(t: dict, exp: dict, where: str, vault) -> list[str]:
    """A4 那半边：种进去的「一件事」与读它的判据。**`--dry` 必须能拦住量不到注入的写法。**

    这一段的全部意义是：**判据里的那些事实，模型只可能从注入段里看到**。所以要拦两件事：

    1. **种的事名/判据泄漏到题面或材料里** —— 那这条任务就变成了「从材料里抄一个词」，
       注入在与不在都答得出，跑出来的绿是假的（A2 那次「`--dry` 只查字段齐不齐，
       于是 16 条任务的 `artifact_kinds` 从来没生效」是同一类失败，白杀过一轮付费）。
    2. **种了一件事却没有任何判据读它**（反向的同一个坑：文件铺进去了、事也挂了，
       却没人看结果，于是这条任务无论答成什么都算办成）。

    另外两条是机械的：条目的 `[kind, ref]` 得是合法 kind、且 `ref` **必须真的在 `vault` 里铺了**
    ——引用指向一份没铺的材料时，`threads._resolve` 会把它标成「已不存在」而从注入段里**安静地
    消失**（盘上没这个文件），注入段于是少一半内容，而报告上看不出任何异常。
    """
    from app.core.threads import KINDS

    spec = t.get("thread")
    markers = [str(m) for m in (exp.get("answer_contains") or []) if isinstance(m, str)]
    out: list[str] = []
    if spec is None:
        return out
    if not isinstance(spec, dict):
        return [f"{where}：thread 必须是对象（name + items）"]
    name = str(spec.get("name") or "").strip()
    items = spec.get("items")
    if not name:
        out.append(f"{where}：thread 缺 name")
    if not isinstance(items, list) or not items:
        out.append(f"{where}：thread 至少要挂一个条目（items）")
        items = []
    for it in items:
        if (
            not isinstance(it, (list, tuple))
            or len(it) != 2
            or str(it[0]) not in KINDS
            or not str(it[1]).strip()
        ):
            out.append(f"{where}：thread.items 每一项都要是 [kind, ref]，kind ∈ {list(KINDS)}")
            continue
        if isinstance(vault, dict) and str(it[1]) not in vault:
            out.append(
                f"{where}：thread 挂的 {it[1]} 没有铺在 vault 里——"
                "解析会把它标成「已不存在」，注入段里那条引用会安静地消失"
            )
    if not markers:
        out.append(f"{where}：种了一件事（thread）却没有任何判据读它（answer_contains）")
    # **防泄漏**：判据与事名都不许出现在模型不靠注入就能看到的地方（题面 + 材料正文 + 文件名）
    visible = str(t.get("instruction") or "") + "\n".join(
        f"{rel}\n{text}" for rel, text in (vault or {}).items()
    )
    for m in ([name] if name else []) + markers:
        if m and m in visible:
            out.append(
                f"{where}：`{m}` 在题面或材料里就能看到——"
                "这条任务的全部意义是「注入才看得见的东西」，这样写它量不到注入"
            )
    return out


def tasks_sha(tasks_or_path=None) -> str:
    """任务集的指纹（与用例 sha 同一个算法）——**任务改了要看得出来**。"""
    if isinstance(tasks_or_path, (str, Path)):
        raw = Path(tasks_or_path).read_text(encoding="utf-8")
    else:
        raw = json.dumps(tasks_or_path or [], ensure_ascii=False, sort_keys=True)
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:12]


# ---------- 判据（纯函数） ----------


def agent_findings(record: dict, expect: dict) -> list[dict]:
    """A0 自己那三条。Pure。

    - `tool_not_allowed`：调了白名单外的工具。白名单 = **只读基线 `BASE_TOOLS` ∪ 任务声明的
      `tools_extra`**（2026-09-20 用户拍板的通则，原因见 `BASE_TOOLS` 上面那段）；
    - `tool_not_used`：该用的工具一个都没调（`must_call` 是 **any-of**：列几个常用的，
      模型用哪个都行——要钉的是「看没看材料」，不是「必须走哪个工具」）；
    - `over_budget`：轮数超了预算。**它不是失败**，是一条成本事实（见模块开头）；
    - `wrong_artifact_kind`：落盘的体裁不在期望里（W1 的 `check_turn` **不查这一栏**——
      它只查「有没有落盘」。不补这一条，`artifact_kinds` 就是写了没人看的一栏，
      而「以为在量、其实没量」正是这个项目最不想要的失败）；
    - `trace_missing`：**这一轮读不到账本**——轮数/工具数/预算全成了 0。它不是任务失败
      （完成判据看的是产物），但它必须是**响的**：一次跑分里有几条读不到账本，那张
      「轮数 中位 0 · 0 工具」的表就没法读，而它看起来和「模型真的没调工具」一模一样。
      （这一条是量的时候撞出来的：真库还停在 v14、`turn_traces` 缺 P3 那两列，写行失败、
      读回来是空 —— 报告照样打了「100% 完成、0 轮 0 工具」。）
    """
    out: list[dict] = []
    if record.get("trace_missing"):
        out.append(
            {
                "code": "trace_missing",
                "detail": "这一轮读不到账本：轮数/工具数/预算都量不出来——**别把它当 0 读**",
            }
        )
    # **轮数烧光 = 没给出答案**（A2 加的）。烧光时 `run_agentic_chat` 返回的是一句占位符
    # （「工具调用轮次过多，未能生成最终回答…」），它**长得像一段正常回答**：
    # 第一版拿它当「答完了」，于是「一步都没产出」在报告里是干净的一条。
    # 它与 `trace_missing` 同族——**其实没有，要响**；而且它**算没办成**（占位符不是交付）。
    if record.get("rounds_exhausted"):
        out.append(
            {
                "code": "rounds_exhausted",
                "detail": "这一轮把轮数烧光了，交回来的是占位符不是答案——**不算办成**",
            }
        )
    kinds = expect.get("artifact_kinds")
    arts = [a for a in (record.get("artifacts") or []) if isinstance(a, dict)]
    if kinds and arts and not any(str(a.get("kind") or "") in kinds for a in arts):
        got = "、".join(sorted({str(a.get("kind") or "(空)") for a in arts}))
        out.append(
            {
                "code": "wrong_artifact_kind",
                "detail": f"落盘体裁是「{got}」，期望的是 {'/'.join(kinds)} 之一",
            }
        )
    used = [str(n) for n in (record.get("tool_names") or [])]
    # 白名单**恒为「只读基线 ∪ 额外声明的」**，不再有「没声明就不查」那条路：
    # 只读工具是所有任务都有的底盘，能不能落盘/能不能委托才是任务之间的差别。
    allowed = whitelist(expect)
    bad = sorted({n for n in used if n not in allowed})
    if bad:
        out.append(
            {
                "code": "tool_not_allowed",
                "detail": "这一轮用了不该用的工具：" + "、".join(bad),
            }
        )
    must = expect.get("must_call")
    if must and not any(n in used for n in must):
        out.append(
            {
                "code": "tool_not_used",
                "detail": "该用的工具一个都没调（" + "、".join(must) + "）——没看材料就动笔",
            }
        )
    # A2：**「该委托而没委托」是一条独立读数，不是完成判据**。完成率仍只看产物
    # （委托省的是轮数与上下文，不是成功率——同 `over_budget` 那条口径）。
    # 它必须响出来的理由：A1 那次量到「16 条任务 0 次委托」，而那是**模型自己选的**；
    # 这几条任务的形状本来就适合委托（几件互不相关的小事），模型还是自己一件件做完 ——
    # 那是一个关于能力有没有被用上的事实，不写下来就没人知道。
    if expect.get("must_delegate") and not (record.get("delegations") or []):
        out.append(
            {
                "code": "not_delegated",
                "detail": "这件事适合委托（几件互不相关的小事），整轮却一次都没委托——能力没用上",
            }
        )
    budget = expect.get("rounds_budget")
    rounds = int(record.get("rounds") or 0)
    if budget and rounds > int(budget):
        out.append(
            {
                "code": "over_budget",
                "detail": f"跑了 {rounds} 轮，预算 {budget} 轮",
            }
        )
    # A4：**该接上的那件事接上了没有**。判据是 `answer_contains` 里那几个事实——而
    # `validate` 保证了它们**在题面与铺的材料里都看不到**，只可能来自「手头那件事」那段注入。
    # 所以这一条绿了是一件有分量的事：它同时证明了「注入真的到了模型手里」（注入没到，
    # 模型再怎么努力也拼不出那个名字）。
    from app.core.turn_eval import has_marker

    reply = str(record.get("reply") or "")
    missing = [str(m) for m in (expect.get("answer_contains") or []) if not has_marker(reply, m)]
    if missing:
        out.append(
            {
                "code": "missing_marker",
                "detail": "答里没有「"
                + "、".join(missing)
                + "」——题面与材料里都没有这个说法，它只能来自那段注入（指代没接上，或注入没到）",
            }
        )
    return out


def check_task(record: dict, expect: dict) -> list[dict]:
    """一条任务的全部 findings（空 = 干净）。Pure。

    三段拼起来，每段都只有一份实现：
      1. `turn_eval.check_turn` —— W1 那套用例判据（完成 / 回执 / 重复路径 / 长文外泄…）；
      2. `turn_quality.findings` —— **线上每一轮跑的那两条底线**（谎报、编造路径），
         在 A0 里**无条件**跑（不靠用例自己声明），因为线上就是无条件拦的；
      3. `agent_findings` —— 工具与预算这三条。
    """
    from app.core import turn_eval, turn_quality

    out = list(turn_eval.check_turn(record, expect))
    out.extend(
        turn_quality.findings(
            record.get("reply") or "",
            record.get("artifacts") or [],
            # 「嘴上删了」那一条要的两件事，A0 的报告里都有：这一轮调了哪些工具（`tool_names`）
            # 与题面（`instruction`）。**A0 那 20 条任务一条都不含「忘掉/删记忆」的说法**，
            # 所以这一条在这里今天是恒不触发的——传进去是为了口径一致（哪天真加了那样的任务，
            # 它自动就被拦，不用再改这里）。
            tool_names=record.get("tool_names") or [],
            ask=record.get("instruction") or "",
        )
    )
    out.extend(agent_findings(record, expect))
    seen: set[str] = set()
    uniq: list[dict] = []
    for f in out:  # 按 code 去重（同一个 code 在两个来源里都出现时留第一条）
        code = str(f.get("code") or "")
        if code and code not in seen:
            seen.add(code)
            uniq.append(f)
    return uniq


def _codes(findings) -> set[str]:
    return {str(f.get("code") or "") for f in findings or []}


def rejudge(rows: list[dict], tasks: list[dict]) -> tuple[list[dict], list[dict]]:
    """**只重算 A0 自己那几条判据**，其余 findings 原样留着。→ (新记录, 差异清单)。Pure。

    **为什么不能整条重算**：`check_task` 里有一条判据要**盘上的正文**（`body_not_in_reply`：
    成品不许同时摊在对话里），而报告里**没有 `bodies`**（跑分时用完就扔，见 `run_tasks`），
    `reply` 也截到 `ANSWER_CAP`。拿报告重算那几条，会得到**看起来一样、其实换了输入**的
    结果——那正是「以为在量、其实没量」。
    **边界写在明处**：`agent_findings` 用的原始事实（`tool_names` / `artifacts` / `rounds` /
    `trace_missing`）报告里**留全了**，所以这几条可以安全重算。

    **它要解决的是「尺子变了，但原始事实没变」**：改判据不必再花一次钱，也不必让模型
    的随机性混进来——改尺子前后差在哪，这份差异清单说得清。
    """
    by_id = {str(t.get("id") or ""): t for t in tasks}
    out: list[dict] = []
    diff: list[dict] = []
    for r in rows:
        tid = str(r.get("id") or "")
        task = by_id.get(tid)
        if task is None:
            raise KeyError(f"报告里的任务 {tid!r} 不在当前金标集里——不猜，当场停")
        expect = task.get("expected") or {}
        fresh = {str(f.get("code") or "") for f in agent_findings(r, expect)}
        kept = [f for f in (r.get("findings") or []) if str(f.get("code") or "") not in AGENT_CODES]
        before = _codes(r.get("findings")) & set(AGENT_CODES)
        new = {**r, "findings": kept + agent_findings(r, expect)}
        out.append(new)
        if before != fresh:
            diff.append(
                {
                    "id": tid,
                    "before": sorted(before),
                    "after": sorted(fresh),
                }
            )
    return out, diff


def is_done(record: dict) -> bool:
    """这条任务**办成了没有**。Pure。

    **出错的那种一律不算办成**（`error` 非空 / `turn_error`）：这一条是量的时候才发现的
    ——`turn_eval.check_turn` 在出错时只给一个 `turn_error`，它不在 `DONE_CODES` 里，
    于是「跑挂了的任务」会被算成完成。评测脚本自己挂掉还把分母算成绿的，正是这个项目
    最不想再要的那种失败（`evals._one_case` 那条「失败被算成 miss」的镜像是它）。
    """
    if record.get("error"):
        return False
    codes = _codes(record.get("findings"))
    if "turn_error" in codes:
        return False
    return not (codes & set(DONE_CODES))


# ---------- 聚合（纯函数） ----------


def _pct(k: int, n: int) -> float:
    return round(k / n, 4) if n else 0.0


def summarize(rows: list[dict], *, model_id: str = "") -> dict:
    """一批任务结果 → 报告。Pure。

    **三个数分开给**：`done`（办成了没有）、`clean`（办成了且一条底线都没失守、
    工具与预算也没越界）、`over_budget`（超预算几条）。理由见模块开头。
    """
    n = len(rows)
    done = [r for r in rows if is_done(r)]
    clean = [r for r in rows if not r.get("findings")]
    floor = [r for r in rows if _codes(r.get("findings")) & set(FLOOR_CODES)]
    rounds = sorted(int(r.get("rounds") or 0) for r in rows)

    def _q(p: float) -> float:
        if not rounds:
            return 0.0
        idx = min(len(rounds) - 1, max(0, round(p * (len(rounds) - 1))))
        return float(rounds[idx])

    counts: dict[str, int] = {}
    for r in rows:
        for code in _codes(r.get("findings")):
            counts[code] = counts.get(code, 0) + 1

    # A1：委托读数。**主循环的轮数不含子代理那几轮**——所以「省了几轮」这件事只有把
    # 两笔分开数才看得出来（子代理的轮数记在它自己的 sub_trace 里）。
    sub = [d for r in rows for d in (r.get("delegations") or [])]
    delegated_turns = sum(1 for r in rows if r.get("delegations"))
    # A2：「该委托」的名额有几个（任务形状本来就适合委托的那几条）。要跟
    # `not_delegated` 一起看：只报「委托了 0 次」看不出是没机会还是没本事用。
    delegate_expected = sum(1 for r in rows if r.get("must_delegate"))

    by_tag: dict[str, dict] = {}
    for r in rows:
        tag = str(r.get("tag") or "?")
        b = by_tag.setdefault(tag, {"tasks": 0, "done": 0})
        b["tasks"] += 1
        if is_done(r):
            b["done"] += 1

    by_model: dict[str, dict] = {}
    for r in rows:
        mid = str(r.get("model_id") or "(未知)")
        b = by_model.setdefault(mid, {"tasks": 0, "done": 0, "clean": 0, "over_budget": 0})
        codes = _codes(r.get("findings"))
        b["tasks"] += 1
        if is_done(r):
            b["done"] += 1
        if not codes:
            b["clean"] += 1
        if "over_budget" in codes:
            b["over_budget"] += 1

    return {
        "model_id": model_id or (rows[0].get("model_id") if rows else "") or "",
        "tasks": n,
        "done": len(done),
        "done_rate": _pct(len(done), n),
        "clean": len(clean),
        "clean_rate": _pct(len(clean), n),
        "errors": sum(1 for r in rows if r.get("error")),
        "floor_failures": len(floor),
        "over_budget": counts.get("over_budget", 0),
        "trace_missing": counts.get("trace_missing", 0),
        "tool_not_allowed": counts.get("tool_not_allowed", 0),
        "tool_not_used": counts.get("tool_not_used", 0),
        # A1：委托了几个回合、一共几次、子代理花了多少轮（成本要从这两笔一起看）
        "delegated_turns": delegated_turns,
        "delegate_calls": len(sub),
        "delegate_rounds": sum(int(d.get("rounds") or 0) for d in sub),
        # A2：几个名额、用掉几个
        "delegate_expected": delegate_expected,
        "delegate_missed": counts.get("not_delegated", 0),
        "counts": counts,
        "rounds": {
            "mean": round(sum(rounds) / n, 2) if n else 0.0,
            "median": _q(0.5),
            "p90": _q(0.9),
            "max": float(rounds[-1]) if rounds else 0.0,
        },
        "by_tag": by_tag,
        "by_model": by_model,
    }


def compare(old: dict, new: dict) -> str:
    """两次报告差在哪 —— **给 A1 的「委托前后 A0 对比」用**。Pure。"""
    if not old or not new:
        return "没有可比的两份报告。"
    bits: list[str] = []
    if old.get("tasks_sha") and new.get("tasks_sha") and old["tasks_sha"] != new["tasks_sha"]:
        bits.append(f"任务集从 {old['tasks_sha']} 变成了 {new['tasks_sha']}（不可比）")
    if old.get("prompt_sha") != new.get("prompt_sha"):
        bits.append(f"输出规矩从 {old.get('prompt_sha') or '—'} 变成了 {new.get('prompt_sha') or '—'}")
    d = round(float(new.get("done_rate") or 0) - float(old.get("done_rate") or 0), 4)
    bits.append(f"完成率 {old.get('done_rate')} → {new.get('done_rate')}（{d:+.2%}）")
    df = int(new.get("floor_failures") or 0) - int(old.get("floor_failures") or 0)
    bits.append(f"底线失守 {old.get('floor_failures')} → {new.get('floor_failures')}（{df:+d}）")
    dm = round(float((new.get("rounds") or {}).get("mean") or 0) - float((old.get("rounds") or {}).get("mean") or 0), 2)
    bits.append(f"平均轮数 {((old.get('rounds') or {}).get('mean'))} → {((new.get('rounds') or {}).get('mean'))}（{dm:+.2f}）")
    return "；".join(bits) + "。"


async def _drop_trace(trace_id) -> None:
    """把这一轮刚写下的账本行删掉（**best-effort**）。见 `run_tasks` 里那段理由。

    只删自己刚写的那一行（按 id），不扫描、不批量——评测脚本没有资格动别人的账。
    """
    if not trace_id:
        return
    try:
        from sqlalchemy import delete

        from app.db import SessionLocal
        from app.models import TurnTrace

        async with SessionLocal() as db:
            await db.execute(delete(TurnTrace).where(TurnTrace.id == int(trace_id)))
            await db.commit()
    except Exception:  # noqa: BLE001 - 收尾失败不该毁掉这一轮（报告里已经留着数）
        log.warning("agent eval: 账本行没删掉 id=%s", trace_id, exc_info=True)


# ---------- 跑一条任务 ----------


def _output_sha() -> str:
    """`_OUTPUT_RULE` 的指纹（与 turn_eval / ArtifactFeedback 同一把 key）。

    **兜底用**：正常情况下 `prompt_sha` 从这一轮的账本行里读（那是**这一轮真正用的**
    那一版），只有一行都没跑成时才回落到"现在登记表里是哪一版"。
    """
    try:
        from app.core import prompts

        for p in prompts.inventory():
            if p.module == "app.routers.chat" and p.name == "_OUTPUT_RULE":
                return p.sha
    except Exception:  # noqa: BLE001
        log.debug("agent eval prompt sha unavailable", exc_info=True)
    return ""


async def _seed_thread(spec: object) -> int:
    """把金标声明的那件事种进库，返回它的 id（没声明就是 0）。**A4 的注入靠它。**

    走**产品自己的** `threads.create` / `threads.attach`，不手写 INSERT：`attach` 顺手更新
    `updated_at`，而那个字段决定 `recent()` 挑中谁——两处各写一遍，同一个决定迟早有两个算法。
    """
    if not isinstance(spec, dict) or not str(spec.get("name") or "").strip():
        return 0
    from app.core import threads

    row = await threads.create(str(spec["name"]))
    for it in spec.get("items") or []:
        await threads.attach(int(row["id"]), str(it[0]), str(it[1]))
    return int(row["id"])


async def _drop_thread(thread_id: int) -> None:
    """收掉一条任务种的那件事。**只删这一个 id**（`threads.delete` 只动索引，不动 vault）。"""
    if not thread_id:
        return
    from app.core import threads

    try:
        await threads.delete(int(thread_id))
    except LookupError:
        pass
    except Exception:  # noqa: BLE001 - 收尾失败不该毁掉整轮，但要说出来
        log.warning("agent eval: 种下的事没删掉 id=%s", thread_id, exc_info=True)


async def _max_thread_id() -> int:
    """跑之前「事」这一栏的最大 id —— 收工时的窗口下界（`docs/testing.md` §6.7：只收自己写的）。"""
    from sqlalchemy import func, select

    from app.db import SessionLocal
    from app.models import Thread

    async with SessionLocal() as db:
        return int((await db.execute(select(func.coalesce(func.max(Thread.id), 0)))).scalar_one())


async def _drop_threads_above(floor: int) -> int:
    """把这一轮评测自己种的事**全**收掉。返回收了几条。

    逐条收之外再加这一层，是因为**这些行写进的是用户自己的库**：任何一处意外（哪怕发生在我
    没预料到的地方）都会在他的「一件事」列表里留下一条他从没建过的记录。`turn_traces`
    那半边没有这层网（`_drop_trace` 只在正常路径上跑），A4 不沿用那个缺口。
    """
    from sqlalchemy import select

    from app.db import SessionLocal
    from app.models import Thread

    async with SessionLocal() as db:
        ids = list((await db.execute(select(Thread.id).where(Thread.id > floor))).scalars())
    for i in ids:
        await _drop_thread(int(i))
    return len(ids)


async def run_tasks(
    tasks: list[dict] | None = None,
    *,
    model_id: str = "",
    only: list[str] | None = None,
    on_task=None,
) -> dict:
    """跑一批金标任务 → 报告。**要花钱**（每条任务 = 一次真实回合）。

    **隔离设施是借 W1 的**（`turn_eval` 的临时 vault / 临时索引）：评测绝不能往用户的
    vault 里写东西、也不能把铺进去的材料留在用户的索引里。这几件事各写一份的话，
    分叉的那天评测就会往真 vault 里写文件——`turn_eval._scratch_vault` 的注释记着
    这个坑为什么值得防。跑的那条路也是 W1 用的同一条：**产品自己的 `chat._generate`**
    （`turn_eval._default_run_turn`），不是另拼一套。
    """
    from app.core import turn_eval

    items = list(tasks or load_tasks())
    if only:
        want = set(only)
        items = [t for t in items if str(t.get("id")) in want] or []
        if not items:
            raise ValueError(f"--only 里没有一个 id 在任务集里：{sorted(want)}")

    if not model_id:
        from app.core import providers

        model_id = providers.default_model_id() or ""

    rows: list[dict] = []
    t0 = time.time()
    thread_floor = await _max_thread_id()  # A4：收工时的窗口下界（只收自己种的事）
    try:
        with turn_eval._scratch_vault() as vault, turn_eval._scratch_index():  # noqa: SLF001
            for task in items:
                rec = await _run_task(task, vault, model_id=model_id)
                rows.append(rec)
                if on_task is not None:
                    on_task(rec)
    finally:
        # 逐条收 + 兜底扫一遍：**这些行写进的是用户自己的库**（见 `_drop_threads_above`）。
        # 收尾自己炸了不许盖住这一轮的结论（跑分的异常比收尾的异常重要得多），所以再兜一层。
        try:
            dropped = await _drop_threads_above(thread_floor)
            if dropped:
                log.info("agent eval: 收掉 %d 条评测自己种的事", dropped)
        except Exception:  # noqa: BLE001 - 收尾失败要喊，但不能顶掉报告
            log.warning("agent eval: 收尾没把种下的事收干净（floor=%s）", thread_floor, exc_info=True)

    report = summarize(rows, model_id=model_id)
    report.update(
        {
            "at": time.strftime("%Y-%m-%d %H:%M:%S"),
            "seconds": round(time.time() - t0, 1),
            "prompt_sha": next(
                (r["prompt_sha"] for r in rows if r.get("prompt_sha")), _output_sha()
            ),
            "tasks_sha": tasks_sha(items),
            "detail": rows,
        }
    )
    return report


async def _run_task(task: dict, vdir, *, model_id: str) -> dict:
    """一条任务 = 一次真实回合 → 一行记录。**跑的是产品自己那条路**（`_default_run_turn`）。

    从 `run_tasks` 里拆出来只为了一件事：让那一层 `try/finally`（收自己种的事）不必把整个
    循环体再缩进一级——缩进那一次改动的风险大于它换来的整齐。
    """
    from app.core import turn_eval

    rec: dict = {
        "id": str(task.get("id")),
        "tag": str(task.get("tag") or ""),
        "instruction": str(task.get("instruction") or ""),
        "model_id": model_id,
        "reply": "",
        "artifacts": [],
        "error": "",
        "rounds": 0,
        "tools": 0,
        "tool_names": [],
        "saves": 0,
        "tokens_out": 0,
        "seconds": 0.0,
        "vault_files": 0,
        "delegations": [],
        # A2：这条任务是不是「形状本来就适合委托」（决定上面那两笔怎么读）
        "must_delegate": bool((task.get("expected") or {}).get("must_delegate")),
        "trace_missing": False,
        "rounds_exhausted": False,
        "findings": [],
    }
    started = time.time()
    thread_id = 0
    try:
        turn_eval._reset_vault(vdir)  # noqa: SLF001
        turn_eval._reset_index()  # noqa: SLF001
        rec["vault_files"] = turn_eval._seed_vault(task, vdir)  # noqa: SLF001
        # 铺进去的材料要真的进索引，否则「有素材」只是盘上有文件（模型靠 kb_search 找它）
        if rec["vault_files"]:
            rec["indexed"] = await asyncio.to_thread(
                turn_eval._index_vault, vdir  # noqa: SLF001
            )
        # A4：**这一轮要问的那件事**。种在助手已经被清干净之后（`_reset_index` 之后、
        # 跑之前），跑完立刻收掉——下一条任务不该看见上一条的事。
        thread_id = await _seed_thread(task.get("thread"))
        got = await turn_eval._default_run_turn(  # noqa: SLF001
            str(task.get("instruction") or ""), model_id
        )
    except Exception as e:  # noqa: BLE001 - 一条任务挂了不该毁掉整轮
        log.warning("agent eval task failed: %s", task.get("id"), exc_info=True)
        got = {"reply": "", "artifacts": [], "error": f"{type(e).__name__}: {e}", "trace": None}
    finally:
        await _drop_thread(thread_id)
    bodies, marked = turn_eval._read_bodies(  # noqa: SLF001
        got.get("artifacts") or [], vdir
    )
    trace = got.get("trace") or {}
    calls = [c for c in (trace.get("tool_calls") or []) if isinstance(c, dict)]
    rec.update(
        {
            # 账本读不到就是读不到：0 轮 0 工具与「真的没调工具」在报告里长得一样，
            # 所以要让 `agent_findings` 把这一条喊出来（见那里的 trace_missing）。
            "trace_missing": not trace,
            # 轮数烧光 → 交回来的那句是占位符（A2：它不是答案，不算办成）
            "rounds_exhausted": bool(trace.get("rounds_exhausted")),
            "reply": (got.get("reply") or "")[:ANSWER_CAP],
            "artifacts": marked,
            "error": got.get("error") or "",
            "rounds": int(trace.get("rounds") or 0),
            "tools": len(calls),
            "tool_names": [str(c.get("name") or "") for c in calls],
            "saves": sum(1 for c in calls if c.get("name") == "save_artifact"),
            "tokens_out": int(trace.get("tokens_out") or 0),
            "seconds": round(time.time() - started, 1),
            # 这一轮用的输出规矩版本 —— 报告要能按它分段（换了提示词就不是同一把尺子）
            "prompt_sha": str(trace.get("prompt_sha") or ""),
            # A1：这一轮委托出去的子代理（谁、几轮、哪些工具）。**「委托前后对比」**
            # 靠它 —— 光看主循环的轮数会把「省下来的那部分」读没了。
            "delegations": list(trace.get("sub_traces") or []),
            # A4：这一轮种的是哪件事（人审时对得上号）；判据吃的是 `reply`，不吃它
            "thread_name": str((task.get("thread") or {}).get("name") or ""),
        }
    )
    # 判据里有一条要**盘上的正文**（`body_not_in_reply`：成品不许同时摊在对话里）
    rec["bodies"] = bodies
    rec["findings"] = check_task(rec, task.get("expected") or {})
    rec.pop("bodies", None)
    # 这一轮的账本行**用完就收**：它属于评测，不属于「用户聊过什么」。不收的话，
    # 每跑一轮 A0 就在设置页那栏「最近回合」里留下 16 条用户没聊过的记录。
    # （W1 的 `turn_eval` 是同一条路但没做这一步——那是它的既有行为，A0 不据此改它。）
    await _drop_trace(trace.get("id"))
    return rec
