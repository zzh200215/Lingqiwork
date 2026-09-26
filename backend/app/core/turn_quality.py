"""回合质量的两条底线（W2a）：**线上要拦的**，与评测（W1）共用同一份谓词。

**它解决什么。** `upgrade-plan` 缺口三：易错判断全押在提示词上。两条实测到的失守：

1. **长正文 + 没有回执**——模型把整篇成品写在对话里，一件产出都没落盘。用户以为东西在
   产出区，其实 vault 里还是上一轮的旧版本。
2. **回复里报了一个盘上不存在的路径**——实测编过
   `recap/2026-09-14-本周周报-精简版.md`。用户看到的是一个可信、点开即 404 的东西。

**为什么要独立一个模块。** 这两条既要被线上拦（`routers/chat.py`），也要被评测量
（`core/turn_eval.py`）。**同一条规则在两个地方各写一遍，分叉的那天「谎报率」就没人敢信了**
——和 `claims_a_save_without_one` 只留一份是同一个理由（那一条住在 `chat.py`，这里直接调它）。

**只做判定，不做动作。** 「该不该重试」「重试那一轮要带什么话」是两个纯函数
（`should_retry` / `retry_instruction`），所以能离线测；真正的重试由调用方执行并在账本里记数。
"""
from __future__ import annotations

import re
from pathlib import Path

# 正文超过这个长度、却一件产出都没有 → 判定为「该存没存」。
# 与 `turn_trace.LONG_BODY_CHARS` 同一个数：那边是**筛出来给人看**，这边是**当场拦**。
LONG_BODY_CHARS = 400

# vault 里那种「目录/文件名.md」的写法。刻意收窄：只认斜杠分隔的 .md/.txt/.markdown，
# 且至少两段——「注意/这一点」这种中文斜杠不会被当成路径。
_PATH_RE = re.compile(r"[A-Za-z0-9_\u4e00-\u9fff-]+(?:/[A-Za-z0-9_\u4e00-\u9fff.-]+)+\.(?:md|txt|markdown)")

# 「这里就是我存下来的东西」的说法。**路径必须贴着它才算「报了回执」** ——
# 这一条是被真数据打出来的：结构化那一轮（W2b）的回复是
# 「已按 notes/本周进展.md 的四条要点扩写成约 800 字复盘」，它提的是**材料来源**，
# 不是产出落点，而第一版判据把任何 vault 形状的路径都算进去 → 当场一次误报。
# 判据的本意是「报了一个不存在的**回执**路径」（点开即 404），所以只在存/落盘这类字眼
# 附近出现的路径才算数。
_LANDED_MARKERS = (
    "已存入", "已存为", "已另存为", "已更新", "存入产出", "存进产出", "存到", "存在了",
    "保存在", "落盘到", "产出在", "路径是", "写进", "写到了",
    # 实测模型很爱说的几种「存好了」的口吻（它们后面跟的路径就是它声称的落点）
    "已经存好", "存好了", "存下了", "归档到",
)
_MARKER_WINDOW = 14  # 路径往前看这么多字找那个字眼

# **判据与路径必须在同一句里**（2026-09-20 加，A0 第一轮基线抓到的误报）。
# 实测原文：「**已存入产出**。周报**基于** notes/本周进展.md 的四条记录整理…」——
# 产出真的存了（回执在 `deliver/`），它只是顺口提了一句**材料来源**，而「往前 14 字」的
# 窗口把上一句的「已存入产出」捞了进来，于是报了一个不存在的路径。
# 一句话里的落盘字眼管不到下一句的主语，所以跨句不算。
# **换行不算断句**（只认真正的句末标点）：模型常把回执写成
# 「已存入产出：\nrecap/x.md」——那仍然是同一个回执，不能因为换行就漏掉。
_SENTENCE_BREAK = "。！？；!?;"


def _norm(path: str) -> str:
    return (path or "").strip().replace("\\", "/").lstrip("./").lower()


def claimed_a_save_without_one(reply: str, artifacts: list | None) -> bool:
    """声称存了却没有回执。**判定只有 `routers.chat` 里那一份** —— 这里只是转一手。"""
    from app.routers.chat import claims_a_save_without_one as judge

    return judge(reply, artifacts)


def long_body_without_a_receipt(reply: str, artifacts: list | None) -> bool:
    """长正文却一件产出都没落盘（缺口四那条「该存没存」）。Pure。"""
    if artifacts:
        return False
    return len((reply or "").strip()) >= LONG_BODY_CHARS


def invented_path_in_reply(reply: str, artifacts: list | None) -> str:
    """回复里报了一个**不在本次回执里**的 vault 路径；没有就返回 ""。Pure。

    这是「编造路径」那条缺陷的确定性版本：模型说「存到 X 了」，而这一轮真正落盘的产出里
    没有 X —— 用户点开就是 404。只报第一个（一条就够触发拦截；全列出来只会把日志淹掉）。

    **三条收窄，都是被真数据逼出来的**：
    - 只认「目录/文件名.md」形状（中文斜杠、裸文件名不算）；
    - 路径必须贴着「已存入 / 存到 / 落盘到 / 产出在」这类字眼（`_LANDED_MARKERS`）——
      否则「照着 notes/本周进展.md 写的」这种**材料来源**会被当成编造的回执（W2b 那一轮实测到了）；
    - 那个字眼必须在**同一句**里（`_SENTENCE_BREAK`，2026-09-20 加）——
      「已存入产出。周报基于 notes/本周进展.md 整理」这一句，落盘字眼管不到下一句的主语（A0 第一轮基线实测到了）。
    """
    text = reply or ""
    known = {_norm(a.get("path")) for a in (artifacts or []) if isinstance(a, dict)}
    known.discard("")
    for m in _PATH_RE.finditer(text):
        p = _norm(m.group(0))
        if not p or p in known:
            continue
        window = text[max(0, m.start() - _MARKER_WINDOW) : m.start()]
        if any(ch in window for ch in _SENTENCE_BREAK):
            continue  # 跨句了：那是上一句在说别的事，不是在报这一处落点
        if any(marker in window for marker in _LANDED_MARKERS):
            return m.group(0)
    return ""


def findings(
    reply: str,
    artifacts: list | None,
    *,
    tool_names: list | None = None,
    ask: str = "",
) -> list[dict]:
    """这一轮的两条底线 → findings（空 = 没问题）。Pure。

    刻意**不**在这里判「聪明不聪明」（文体、长度、有没有问对问题）—— 这里只拦那两条
    「用户会被骗」的：说了没做、指了个不存在的东西。

    `tool_names` / `ask` 是给「嘴上删了」那一条用的（§4.1 ① 的另一半）：要看**这一轮真的
    调没调** `memory_delete`、以及**你这一轮有没有让它删**。老调用方不传就当不知道——
    那一条不判（读不到就别说人家撒谎），其余判据一个字不变。
    """
    out: list[dict] = []
    if claimed_a_save_without_one(reply, artifacts):
        out.append({"code": "claims_a_save_without_one", "detail": "回复里说存了，但这一轮没有任何回执"})
    if claims_a_delete_without_one(reply, tool_names, ask):
        out.append(
            {
                "code": "claims_a_delete_without_one",
                "detail": "回复里说删了/忘了，但这一轮一次 memory_delete 都没调",
            }
        )
    if long_body_without_a_receipt(reply, artifacts):
        out.append(
            {
                "code": "long_body_without_a_receipt",
                "detail": f"正文 {len((reply or '').strip())} 字却没有落盘（成品只活在对话里）",
            }
        )
    invented = invented_path_in_reply(reply, artifacts)
    if invented:
        out.append({"code": "invented_path", "detail": f"回复里报了一个不在回执里的路径：{invented}"})
    return out


def receipt_problem(art, vault_dir=None) -> str:
    """一条回执能不能给用户看：路径得在 vault 里、而且盘上真有这个文件。没毛病就返回空串。

    这是 W2a 的**白名单**那一半，也是它的闸门：回执是服务端在 `save_artifact` 成功之后
    生成的，所以正常情况下必定通过。留它是因为「必定」这种事在这个项目里已经错过好几次
    ——（回执落库的路径、索引的 root 都出过岔子），而它一旦出岔子，用户拿到的是一个
    看起来可信、点开即 404 的链接。宁可在这里多花一次 `is_file()`。
    """
    if not isinstance(art, dict):
        return "回执不是一个对象"
    rel = str(art.get("path") or "").strip().replace("\\", "/")
    if not rel:
        return "回执没有路径"
    if rel.startswith("/") or ":" in rel or ".." in rel.split("/"):
        return f"回执路径不在 vault 里：{rel}"
    root = Path(vault_dir) if vault_dir is not None else Path(_vault_root())
    p = root / rel
    try:
        if not p.resolve().is_relative_to(root.resolve()):
            return f"回执路径跑到 vault 外了：{rel}"
    except (OSError, ValueError):
        return f"回执路径解不开：{rel}"
    if not p.is_file():
        return f"回执指向的文件不在盘上：{rel}"
    return ""


def _vault_root() -> str:
    """当前真正在用的 vault 根。

    **读 `mcp.VAULT_DIR`，不是 `app.config.VAULT_DIR`** —— 落盘走的是前者，而评测会把
    它临时换成一个 scratch 目录（`turn_eval._scratch_vault`）。跟着 config 走就会去校验
    一个根本不是这次落盘发生的地方。
    """
    from app.core import mcp

    return str(mcp.VAULT_DIR)


def drop_broken_receipts(artifacts: list | None, vault_dir=None) -> tuple[list, list[dict]]:
    """把给不出去的回执挑出来 →（能给的，挑掉的 + 原因）。**带文件系统检查，不纯。**

    挑掉不是「删掉这件事」：省下来的那条会连原因一起写进回合账本，并原样讲给用户听
    （界面不渲染成链接）。静默丢掉一条回执比给一条坏链接更糟 —— 那样用户连「这一轮本该
    有产出」都不知道。
    """
    kept: list = []
    dropped: list[dict] = []
    for a in artifacts or []:
        why = receipt_problem(a, vault_dir)
        if why:
            dropped.append({"path": str((a or {}).get("path") or "") if isinstance(a, dict) else "", "why": why})
        else:
            kept.append(a)
    return kept, dropped


def should_retry(bad: list[dict], ask: str = "", delivery: bool = False) -> bool:
    """该不该再跑一次。Pure。**只重试一次，而且只重试「这一轮自己说它是交付」。**

    「这一轮算不算一份成品」**不是 W2a 的判断** —— 那是 W3 的路由（`core/routing.py`）。
    W2a 只在三种情况下动手，三种都不是它猜的：

    - **用户明说要落盘**（「存进产出」，`asked_to_save`）：话是用户说的。
    - **模型自己声称存了**（`claims_a_save_without_one`）：话是模型说的。实测那 2/22 轮
      谎报就是这么来的 —— 正文摊在对话里，开头写着「已存入产出」。
    - **路由判定了这一轮是交付型**（`delivery`，W3）：判据在 `core/routing.py`，在 64 条
      金标上量过（负例零误判）。这一条补上了 W2a 原来那个缺口 —— 自然说法「帮我写一份
      本周周报」不带「存」字，以前根本不会补跑。

    反过来，一次又长又没落盘、也**没说是交付**的回答（正常的详细解释、空 vault 下
    「我不想凭空编」的正确拒绝）**一次都不补**：误判的代价是把闲聊变成产出，比漏判烦人
    得多（§W3）。

    另外两条「不补」是为了不加害：`invented_path`（救不了那句话，已经说出去了）、
    `claims_a_save_without_one` **单独**出现（正文往往很短，它不是成品，一轮的收益抵不上
    一次调用）。
    """
    codes = {f["code"] for f in bad}
    if "long_body_without_a_receipt" not in codes:
        return False
    return asked_to_save(ask) or bool(delivery) or "claims_a_save_without_one" in codes


# 用户明确说要落盘的说法。**收窄到「说了存」这一件事**，不去猜「这算不算成品」：
# 后者是 W3 的路由，而在这里猜错的代价是把闲聊变成产出。
SAVE_HINTS: tuple[str, ...] = (
    "存进产出", "存到产出", "存入产出", "存成产出", "存为产出",
    "落盘", "存进 vault", "存到 vault", "存进知识库",
    "存一下", "存起来", "存下来", "存档", "保存到产出", "帮我存",
)


def asked_to_save(ask: str) -> bool:
    """用户这一句里有没有**明说要落盘**。Pure。"""
    text = (ask or "").strip().lower()
    return any(h.lower() in text for h in SAVE_HINTS)


# 用户明确说要**忘掉 / 删掉记忆**的说法（§4.1 ① 的落地，2026-09-22）。与 `SAVE_HINTS` 同族的
# **窄词表**，但代价的方向相反：落盘那条认错了只是多存一份，这条认错了是**替你删掉一条你还要的
# 记忆**——所以判据只认两种句子：
#
#   ① **「忘」这个动作**（忘掉 / 忘记 / 别再记着 / 不用记住…）——忘只可能指向记忆，
#      不存在"忘掉一个文件"这种说法；
#   ② **「删 / 清除」+ 句子里同时有「记忆」这个对象**——`删掉这个文件` **不**放行
#      （放行了的话，模型可能顺手把一条提到这个文件的记忆删掉）。
#
# **认不出就是不放行**（fail closed）：模型少一只手，好过它替你删。漏认的补救成本也很低——
# 你换个说法（「忘掉那条记忆」）它就拿到了。
FORGET_WORDS: tuple[str, ...] = (
    "忘掉",
    "忘记",
    "别再记",
    "别记着",
    "不用记着",
    "不用记住",
    "别再记住",
    "不用再记",
    "不要再记",
    "不需要记",
)
DELETE_WORDS: tuple[str, ...] = ("删", "清除", "清掉", "抹掉", "去掉", "移除")
MEMORY_WORDS: tuple[str, ...] = ("记忆", "memory", "remember")


def asked_to_forget(ask: str) -> bool:
    """用户这一句里有没有**明说要忘掉 / 删掉记忆**。Pure，坏输入不抛。**认不出就是不放行。**

    这是 `memory_delete` 那一类破坏性工具的**口头授权**判据（`mcp.DESTRUCTIVE_TOOLS`）：
    chat 与零柒组装工具时问它，**问不过就不把那只手给它**。之所以不做确认弹窗，是因为
    那条挂账当初被挂起来的原因就是"加确认框反而打断流"——而"不给它这只手"零打断、可单测、
    且天然 fail-closed（形态照 W2b 那条先例：结构化那一轮只是不给 `save_artifact`）。
    """
    text = (ask or "").strip().lower()
    if not text:
        return False
    if any(w in text for w in FORGET_WORDS):
        return True
    return any(w in text for w in DELETE_WORDS) and any(w in text for w in MEMORY_WORDS)


# 「已经删掉 / 已经忘掉」这类**过去式**的口吻。与 `_LANDED_MARKERS` 同族的窄词表：
# 只认"我把它做完了"的口气，不认"要不要删 / 我删不了 / 建议删"（那是另一回事，见 `_DELETE_HEDGES`）。
_DELETED_MARKERS: tuple[str, ...] = (
    "已删除",
    "已经删除",
    "删除了",
    "已删掉",
    "已经删掉",
    "删掉了",
    "已清空",
    "清空了",
    "已移除",
    "移除了",
    "已忘掉",
    "已经忘掉",
    "忘掉了",
    "已忘记",
    "已经忘记",
    "忘记了",
    "已不再记得",
    "不再记得",
)
# 出现这些就当**没说**：征询（要不要删）、否定（还没删 / 没有删除）、做不到（删不了 / 无法删除）。
# 它们与"已经做完了"是两件事——把这两种混在一起，判据就会去怪一个**说实话**的回合。
_DELETE_HEDGES: tuple[str, ...] = (
    "没删",
    "没有删",
    "还没",
    "尚未",
    "无法",
    "不能",
    "没法",
    "删不了",
    "要不要",
    "需要我",
    "可以删",
    "建议删",
    "是否",
)


def claims_a_delete_without_one(
    reply: str, tool_names: list | None = None, ask: str = ""
) -> bool:
    """嘴上删了、其实一次 `memory_delete` 都没调。Pure。

    **这条是 §4.1 ① 补上的另一半。** 那一条把"真删"堵住了（没授权就不给那只手），
    但工具不在手里时模型**仍可能回一句「已经帮你删掉了」**——对用户来说，「说了没做」
    比「做不到」坏得多（`claims_a_save_without_one` 是同一条道理，只是那一条管落盘）。

    **三条收窄，都是为了让它在真该响的时候才响**：
    1. **只在你这一轮明说要删/忘的时候判**（`asked_to_forget`）——同一个「删掉了」在别处
       完全可能是实话：「我把第三段冗余删掉了」说的是它正在写的那篇稿子，不是你的记忆；
    2. 认的是**过去式口吻**，而且那句话里不能带征询/否定（`_DELETE_HEDGES`）；
    3. 这一轮**真的没调** `memory_delete`（按工具账数，与 W4 数 saves 是同一处口径）。

    `tool_names is None`（读不到工具账）时**不判**：读不到就别说人家撒谎。
    """
    if tool_names is None or not asked_to_forget(ask):
        return False
    if any(str(n) == "memory_delete" for n in tool_names):
        return False
    for sentence in re.split(f"[{re.escape(_SENTENCE_BREAK)}]", reply or ""):
        if any(m in sentence for m in _DELETED_MARKERS) and not any(
            h in sentence for h in _DELETE_HEDGES
        ):
            return True
    return False


def retry_instruction(bad: list[dict], ask: str = "", delivery: bool = False) -> str:
    """重试那一轮要额外带上的一句话。Pure。

    明说「上一轮没有落盘」并点名要调哪个工具 —— 这是**结构化的一点**：不指望模型自己
    想起来，而是把上一轮的失守直接摆到它眼前。

    **留一条退路**：模型上一轮可能是在**正确地拒绝**（实测：空 vault 下它回「我不想凭空编
    一份周报——那东西进了产出区反而更难收拾」）。要是补跑那句话只写着「必须存」，就是在逼
    它编。所以结尾明说「不该存就说明理由」—— 补跑问的是「你刚才写的那篇存了吗」，
    不是「无论如何给我存一份」。
    """
    if not should_retry(bad, ask, delivery):
        return ""
    return (
        "【系统提示】你上一轮把成品写在对话里了，但一次 `save_artifact` 都没有调用，"
        "所以产出区里什么都没有。请现在**真的调用 `save_artifact`** 把它存下来"
        "（`kind` 自己判断，`title` 一行，`body` 放完整正文）；"
        "存完之后在对话里**只留一句回执**，不要再把正文复述一遍。"
        "如果你判断这一轮**本来就不该落盘**（比如根本没有素材、写出来会是编的），"
        "就直接说明理由，**不要为了落盘而编内容**。"
    )
