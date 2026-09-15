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

    这是「编造路径」那条缺陷的确定性版本：模型在正文里写下一个看起来像产出路径的东西，
    而这一轮真正落盘的产出里没有它 —— 用户点开就是 404。
    只报第一个（一条就够触发拦截；全列出来只会把日志淹掉）。
    """
    known = {_norm(a.get("path")) for a in (artifacts or []) if isinstance(a, dict)}
    known.discard("")
    for m in _PATH_RE.finditer(reply or ""):
        p = _norm(m.group(0))
        if p and p not in known:
            return m.group(0)
    return ""


def findings(reply: str, artifacts: list | None) -> list[dict]:
    """这一轮的两条底线 → findings（空 = 没问题）。Pure。

    刻意**不**在这里判「聪明不聪明」（文体、长度、有没有问对问题）—— 这里只拦那两条
    「用户会被骗」的：说了没做、指了个不存在的东西。
    """
    out: list[dict] = []
    if claimed_a_save_without_one(reply, artifacts):
        out.append({"code": "claims_a_save_without_one", "detail": "回复里说存了，但这一轮没有任何回执"})
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


def should_retry(bad: list[dict], ask: str = "") -> bool:
    """该不该再跑一次。Pure。**只重试一次，而且只重试「这一轮自己说它是交付」。**

    「这一轮算不算一份成品」**不是 W2a 的判断** —— 那是 W3 的路由。W2a 只在两种情况下
    动手，两种都不是它猜的：

    - **用户明说要落盘**（「存进产出」，`asked_to_save`）：话是用户说的。
    - **模型自己声称存了**（`claims_a_save_without_one`）：话是模型说的。实测那 2/22 轮
      谎报就是这么来的 —— 正文摊在对话里，开头写着「已存入产出」。它自己都认定这是一次
      交付了，补跑不涉及「把闲聊变成产出」那个风险。

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
    return asked_to_save(ask) or "claims_a_save_without_one" in codes


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


def retry_instruction(bad: list[dict], ask: str = "") -> str:
    """重试那一轮要额外带上的一句话。Pure。

    明说「上一轮没有落盘」并点名要调哪个工具 —— 这是**结构化的一点**：不指望模型自己
    想起来，而是把上一轮的失守直接摆到它眼前。

    **留一条退路**：模型上一轮可能是在**正确地拒绝**（实测：空 vault 下它回「我不想凭空编
    一份周报——那东西进了产出区反而更难收拾」）。要是补跑那句话只写着「必须存」，就是在逼
    它编。所以结尾明说「不该存就说明理由」—— 补跑问的是「你刚才写的那篇存了吗」，
    不是「无论如何给我存一份」。
    """
    if not should_retry(bad, ask):
        return ""
    return (
        "【系统提示】你上一轮把成品写在对话里了，但一次 `save_artifact` 都没有调用，"
        "所以产出区里什么都没有。请现在**真的调用 `save_artifact`** 把它存下来"
        "（`kind` 自己判断，`title` 一行，`body` 放完整正文）；"
        "存完之后在对话里**只留一句回执**，不要再把正文复述一遍。"
        "如果你判断这一轮**本来就不该落盘**（比如根本没有素材、写出来会是编的），"
        "就直接说明理由，**不要为了落盘而编内容**。"
    )
