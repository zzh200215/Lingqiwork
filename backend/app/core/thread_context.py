"""「一件事」进 agent 的眼（A4 · `Agent升级.md` §2）。

**它解决什么。** 你说「继续推进 X 那件事」，agent 眼里只有这一句——Thread 里挂的材料 / 笔记 /
成品 / 判断它看不见，只能现查或含糊。`today.next_suggestion` 早就在读 `threads.recent()`，
**chat 的 agent 却没有这条路**——它跟 PLAN4 Z1 修过的病同构（镜子有长期记忆、没有当天）：
agent 有长期记忆（`memory` 注入），没有「手头的事」。

**往 system 里追加什么。** 最近动过、而且真挂了东西的**那一条**事：名字 + 五步摘要计数 +
它的**引用清单**（`threads.brief()`）。摘要计数与 `today` 那条完全同源（`threads.recent()`），
不新造一分任务状态——这是纪律 3（与 PLAN5 R3 互为读写两端）的落地方式。

**同一份真值还有第二个出口**：`materials_for()` 把「这件事挂着的那几份**能读的材料**」
交给协作编排器（A2 挂账②那条边界：`collab.run(materials=...)`）。两个出口共用一个
「能读」的判据（`_readable`）——注入段列出来的与编排器分下去的**永远是同一批文件**。

## 三条纪律

1. **只读引用，不搬内容。** Thread 的规矩原样：挂的是引用，正文在 vault 里、要用工具去读。
   所以这一段里**必须把那把工具的名字写对**（`READ_TOOL`，真名是 `vault_read_file`，不是
   方案原文随手写的「read_file」），并明说「没打开过就别替它编」——只给一串路径却不给这句话，
   等于请模型拿路径编一份摘要。
2. **最多一条。** 只注入最近的那件事，不列清单（列清单就成了待办面板，红线 #1 的邻域）。
   指涉更早的事让模型自己用工具查（`vault_list_files` / `kb_search` 都是现成的）。
3. **只在指涉时才注入**（2026-09-20 用户拍板，不是方案 v1 那句「聊天开启时总是注入」）。
   `refers_to_thread` 是**启发式**，代价写在它自己的注释里：词表漏了就是漏了，那次 agent 仍然
   看不见；换来的是「帮我翻一下这段」这类无关提问里不掺一段不属于它的事。

## 两条与 `pet_context` 同款的实现纪律

- **只追加、绝不替换。** 这里只产出**新增的一段**，由调用方（`routers.chat`）自己 append；
  没有任何人设 / 提示词常量被改写（`prompts._SPECS` 里登记的是这一段的表头，改它要走审阅）。
- **空数据不注入，读不出来也不注入。** 没有事、事上还没挂东西、库读不出来 → **空串**。
  也**绝不写**「你还没有任何事」——那是欠账口吻（PLAN4 §8.7 那条红线的邻域）。
- **上限在这一处。** `MAX_CHARS = 200` 是硬上限（方案验收原文），超了**先丢引用行**、
  再截断：名字与计数最要紧，所以它们最后被丢。
"""

import logging

from app.config import VAULT_DIR
# kind → 给人看的一小格：**这张表归 `threads`**（kind 的定义处），这里只是转出来用——
# 注入段的引用行与 `threads.summary_line` 那一行摘要必须对同一个 kind 说同一个词。
# 与 `threads.STEPS` 的五个**步**标签是两回事：那边是"到哪了"，这边是"挂着的是什么"。
from app.core.threads import KIND_LABELS

log = logging.getLogger(__name__)

__all__ = [
    "KIND_LABELS",
    "MATERIAL_CAP",
    "MAX_CHARS",
    "NAME_CHARS",
    "READ_TOOL",
    "REFS",
    "REFER_WORDS",
    "SUMMARY_CHARS",
    "THREAD_HEAD",
    "block",
    "materials_for",
    "materials_of",
    "pinned_materials",
    "refers_to_thread",
    "recent_block",
]

# 注入段里点名的那把工具。**写成常量是为了让它可被测试钉住**：它是 `mcp.BUILTIN_TOOLS` 里的
# 真名（`tests/test_thread_context.py` 拿 `delegate.READONLY_TOOLS` 与工具表两处对过），
# 也是本模块唯一的对外承诺——写错了模型就会去调一个不存在的工具。
READ_TOOL = "vault_read_file"

MAX_CHARS = 200  # 一整段（含表头）的硬上限，方案验收原文「一行摘要，不超 200 字」
NAME_CHARS = 40  # 事名上限（表里最长 120，注入段里放不下那么多）
SUMMARY_CHARS = 60  # 摘要计数上限（`threads.summary_line` 现在最长约 55，夹住是为了它将来变长也不挤爆）
TITLE_CHARS = 20  # 引用条目的标题上限
REF_CHARS = 40  # 引用路径上限
REFS = 3  # 最多列几条引用（再多就把 200 字的预算吃光了）
# 钉进来的材料最多几份。**每份 = fanout 的一个读步**（一次模型调用），份数直接乘时间：
# A2 那次 6 份材料的三波跑，单条任务从 ~70s 变成 288–447s。所以这个数不是"能放多少"，
# 是"用户钉多了也得有人替他刹车"。
MATERIAL_CAP = 6

# **能列出来的只有 vault 里那三种**：`material` / `note` / `output` 的 `ref` 是 vault 路径，
# agent 拿 `vault_read_file` 就能打开；而 `card` / `session` / `task` / `decision` 的 ref 是
# 数据库主键，agent 手里**没有**读它们的工具——列出来只会诱它去读一个读不了的东西、白烧一轮。
# 那四类的事实在摘要计数里已经有了（「教学 2 · 判断 1」），不必再列一遍。
VAULT_KINDS = ("material", "note", "output")

THREAD_HEAD = (
    "你最近在做的那件事（只给引用；要内容就用 vault_read_file 打开，别凭空说它写了什么）："
)

# 指涉词表。**分族写，每族一行理由**——它是启发式，读的人要知道漏在哪、多在哪。
REFER_WORDS: tuple[str, ...] = (
    # 「那件事」这一族：最直白的指涉
    "这件事",
    "那件事",
    "这个事情",
    "那个事情",
    "这事",
    "那事",
    "此事",
    # 「那个 + 名词」：方案 / 项目 / 题目 / 任务——都是「一件事」在口语里的别名
    "这个方案",
    "那个方案",
    "这个项目",
    "那个项目",
    "这个题目",
    "那个题目",
    "这个任务",
    "那个任务",
    "这个活",
    "那个活",
    "这个课题",
    "那个课题",
    # 「之前 / 刚才 / 上面 + 那个」：回指上文
    "之前那个",
    "之前那件",
    "刚才那个",
    "刚才那件",
    "上次那个",
    "上次那件",
    "上面那个",
    "上面那件",
    "前面那个",
    "前面那件",
    "刚说那个",
    "刚说的那",
    # 「继续 / 接着」：**它们本身就是指涉**——你说「继续」，继续的必然是手头那件事。
    # 这一族最宽（「继续翻译这段」也会命中），是**有意**的：误注入的代价是一段 ≤200 字的
    # 无关上下文（模型可以直接忽略），漏注入的代价是 A4 要治的那个病原样复发。
    "继续",
    "接着",
    # 「到哪了」这一族：问进度就是问那件事的进度
    "到哪了",
    "到哪一步",
    "干到哪",
    "做到哪",
    "进展如何",
    "进展怎么样",
    "进度如何",
    "进度怎么样",
)


def _clip(raw: object, n: int) -> str:
    """压成一行并截到 n 字（截断留个 `…`，别让两段文字无声地粘在一起）。Pure。"""
    s = " ".join(str(raw or "").split())
    return s if len(s) <= n else s[: n - 1].rstrip() + "…"


def refers_to_thread(text: str) -> bool:
    """这句话是不是在指涉「手头那件事」。**Pure，坏输入不抛。**

    空白被抹掉后再比一次：「这 件 事」这种夹空格的写法不该漏（中文输入法下并不罕见），
    代价只是一次 `split`。**大小写不敏感**：词表里没有拉丁词，但将来加了也不会栽在这上面。
    """
    s = (text or "").strip().lower()
    if not s:
        return False
    flat = "".join(s.split())
    return any(w in s or w in flat for w in REFER_WORDS)


def _readable(item: object) -> str:
    """这条引用**是不是一份能打开的材料**？是就返回它的路径，否则空串。Pure。

    「能打开」= 三种 vault 类（`VAULT_KINDS`）+ 文件还在。**判据只有这一处**：
    注入段那一行（`_ref_line`）与给编排器的材料清单（`materials_of`）都问它——
    两处各写一遍的话，「哪些引用算能读的」迟早会有两个答案。
    """
    if not isinstance(item, dict):
        return ""
    if str(item.get("kind") or "") not in VAULT_KINDS:
        return ""
    if item.get("exists", True) is False:  # 引用不在了：`_resolve` 标了它，别占预算
        return ""
    return str(item.get("ref") or "").strip()


def materials_of(items: object) -> list[str]:
    """引用清单 → **这一轮该读的那几个路径**（排序、去重）。Pure。

    编排器要的就是这个：A2 实测「不给分工时三路各自反复 `vault_list_files`，把每一步 3 轮的
    预算全烧在找文件上」。所以「这一轮读什么」必须由**确定性的一处**给出，不该让每一步各自猜。
    """
    if not isinstance(items, list):
        return []
    return sorted({ref for ref in (_readable(it) for it in items) if ref})


def pinned_materials(specs: object, *, cap: int = MATERIAL_CAP) -> list[str]:
    """**你钉的那几份** → 这一轮读得动的路径（保序、去重、封顶）。I/O 只在这里。

    这是材料清单的**第二个来源**（2026-09-22 拍板，第一个见 `materials_for`）：那一个是
    「那件事挂着的那几份」，只在题面**指涉**时才给，而且判定是启发式的；这一条是**人指的**，
    所以它既不猜、也不经过 `refers_to_thread`，更不受「手头那件事」那个开关管。

    **保序**（与 `materials_of` 的 `sorted` 不同）：先钉的排在前面，而 fanout 的读步就是
    按这个顺序一路一份生成的——用户排的顺序应当就是他读的顺序。

    两种东西在这里**被跳过**：`repo:` / `dir:` 那类 vault 之外的 spec（`cards.collect_material`
    认它们、交付引擎也读得动，因为正文由它自己解析；而协作的读步手里只有 `vault_read_file`），
    以及 vault 里已经不在了的路径。判定仍然只问 `_readable`——「能不能打开」这件事**只有
    一处**：vault 类 + 文件还在；`repo:` 那种路径在 vault 下天然 `is_file()=False`，于是
    不用另认一遍 spec 形状（多认一遍就多一个会漂的判据）。
    """
    if not isinstance(specs, list):
        return []
    out: list[str] = []
    for spec in specs:
        rel = str(spec or "").strip().lstrip("/\\")
        if not rel:
            continue
        try:
            exists = (VAULT_DIR / rel).is_file()
        except OSError:  # 非法路径（`repo:` 在 Windows 上带冒号）——按"打不开"算
            exists = False
        ref = _readable({"kind": "material", "ref": rel, "exists": exists})
        if not ref or ref in out:
            continue
        out.append(ref)
        if len(out) >= cap:
            break
    return out


def _ref_line(item: object) -> str:
    """一条引用 → 一行。**不是能打开的东西就返回空串**（判据在 `_readable`）。"""
    ref = _clip(_readable(item), REF_CHARS)
    if not ref:
        return ""
    kind = KIND_LABELS.get(str(item.get("kind")), "")
    title = _clip(item.get("title"), TITLE_CHARS)
    head = f"{kind}《{title}》" if title else kind
    return f"- {head} {ref}".rstrip()


def block(thread: object, items: object = None) -> str:
    """「最近一件事」→ 一段注入文本。**没有事就是空串。Pure。**

    第一行是身份与进度（`- 《名字》｜搞懂 2 · 留下 1`），后面最多 `REFS` 行引用。
    超预算时**从最后一条引用开始丢**（名字与计数最要紧），仍超就硬截——两条路都有测试。
    """
    if not isinstance(thread, dict):
        return ""
    name = _clip(thread.get("name"), NAME_CHARS)
    if not name:
        return ""
    summary = _clip(thread.get("summary"), SUMMARY_CHARS)
    lines = [f"- 《{name}》｜{summary}" if summary else f"- 《{name}》"]
    if isinstance(items, list):
        for it in items:
            if len(lines) > REFS:
                break
            line = _ref_line(it)
            if line:
                lines.append(line)

    # 上限管的是**整段**（含表头）——验收原文是「注入段有上限，一行摘要，不超 200 字」。
    # 第一版这里只夹了正文，测出来 244 > 200：表头本来就占 50 字，不把它算进去，
    # 上限只是「通常成立」。
    head = f"{THREAD_HEAD}\n"
    room = MAX_CHARS - len(head)
    text = "\n".join(lines)
    while len(text) > room and len(lines) > 1:
        lines.pop()
        text = "\n".join(lines)
    out = head + text
    if len(out) > MAX_CHARS:  # 表头 + 第一行就超了（名字被夹到 40 时到不了，留着兜底）
        out = out[: MAX_CHARS - 1].rstrip() + "…"
    return out


async def materials_for(text: str, *, enabled: bool = True) -> list[str]:
    """**这一轮该读哪几份材料**（vault 相对路径，排好序）。指涉「那件事」时 = 它挂着的那几份。

    给编排器用（`collab.run(materials=...)`）：A2 实测「不给分工时三路各自反复
    `vault_list_files`，把每步 3 轮的预算全烧在找文件上」，而②又量到「有分工之后再拆读步，
    烧光从 11/12 步降到 0/30」。所以「这一轮读什么」是**编排器之外那一处确定性判定**的活。

    **与注入的那一段同一份真值**：都走 `threads.brief()`、都只认 `_readable` 那三种 vault 类
    （`card`/`session`/`task`/`decision` 的 ref 是数据库主键，工具打不开，给编排器只会害它白烧）。

    没有事 / 没指涉 / 开关关着 / 事上没挂可读的东西 → **空表**（调用方自己回落到「不分工」）。
    读库失败也不抛：这是增强项，坏了就当没有那件事（`recent_lines` 的同款）。
    """
    if not enabled or not refers_to_thread(text):
        return []
    try:
        from app.core import threads

        brief = await threads.brief()
    except Exception:  # noqa: BLE001 - 增强项，坏了不该挡住协作
        log.debug("thread brief failed", exc_info=True)
        return []
    if not isinstance(brief, dict):
        return []
    return materials_of(brief.get("items"))


async def recent_block(
    text: str, *, enabled: bool = True, can_read: bool = True
) -> str:
    """这一轮该注入的「一件事」那一段。**任何一支不成立都是空串。**

    `can_read=False` 时也返回空串：这一段里写着「用 vault_read_file 打开」，而那个 agent
    的工具白名单里没有它——**不能指使模型去调一个它没有的工具**（同 `chat._OUTPUT_RULE`
    的闸门：工具关掉时那句话也不许出现）。判定由调用方给（它才知道白名单），本模块不认 agent。

    读库失败**不抛**：这是增强项，坏了就当没有那件事（`pet_context.recent_lines` 的同款）。
    """
    if not enabled or not can_read or not refers_to_thread(text):
        return ""
    try:
        from app.core import threads

        brief = await threads.brief()
    except Exception:  # noqa: BLE001 - 增强项，坏了不该挡住聊天
        log.debug("thread brief failed", exc_info=True)
        return ""
    if not isinstance(brief, dict):
        return ""
    return block(brief, brief.get("items"))
